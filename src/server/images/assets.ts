import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { and, eq, gt, inArray, notInArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { characters, db, images, items, jobs, locations, reclaimOrphanedJobs } from "../db";
import { describeProviderError } from "../ai";
import { newId } from "@/lib/ids";
import { log } from "@/server/log";
import { parseOr } from "@/lib/parse";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  absoluteImagePath,
  containedAbsoluteImagePath,
  dataRoot,
  imageRelativePath,
  imagesDirectoryPath,
  type StoredImagePath,
} from "./paths";

export { absoluteImagePath, dataRoot, imageRelativePath } from "./paths";

export type ImageRow = typeof images.$inferSelect;
export type ImageKind = ImageRow["kind"];
export type ImageEntityKind = NonNullable<ImageRow["entityKind"]>;

export interface ImageFileRef {
  id: string;
  ownerId: string;
  path: string;
}

/**
 * A stored row's file bytes, or null when the file is lost. Every image read is
 * degradable by design (docs/images.md): the row is written before the file, and
 * image_sweep reconciles a row whose file vanished — so a reader falls back to
 * another reference or skips the read rather than failing the turn.
 */
export async function readImageBytes(row: StoredImagePath): Promise<Buffer | null> {
  try {
    return await fs.readFile(absoluteImagePath(row));
  } catch {
    return null;
  }
}

export interface CreateImageAssetOptions {
  ownerId: string;
  kind: ImageKind;
  entityKind?: ImageEntityKind;
  entityId?: string;
  /** Chat scoping for conversation scenes (slice 9) — the images row's SET-NULL FK. */
  chatId?: string;
  /** The assistant message the scene illustrates (inline-transcript anchor, no FK). */
  anchorMessageId?: string;
  prompt?: string;
  sourceImageId?: string;
  meta?: Record<string, unknown>;
}

/** Row-before-file: every asset starts as a pending row (docs/images.md). */
export async function createImageAsset(opts: CreateImageAssetOptions): Promise<ImageRow> {
  const id = newId();
  const [row] = await db()
    .insert(images)
    .values({
      id,
      ownerId: opts.ownerId,
      kind: opts.kind,
      entityKind: opts.entityKind,
      entityId: opts.entityId,
      chatId: opts.chatId,
      anchorMessageId: opts.anchorMessageId,
      path: imageRelativePath(opts.ownerId, id),
      prompt: opts.prompt ?? "",
      sourceImageId: opts.sourceImageId,
      status: "pending",
      meta: opts.meta ?? {},
    })
    .returning();
  if (!row) throw new Error("images insert returned no row");
  return row;
}

export interface WrittenImageInfo {
  width: number;
  height: number;
  bytes: number;
}

const WEBP_QUALITY = 90;

/**
 * Decode guards for the one sharp call every saved buffer passes through: cap
 * the pixel count (a ~1 MB decompression bomb expands to 100+ MP; 40 MP ≈
 * 6300×6300 dwarfs any legitimate avatar/scene image), fail on any decode
 * error, and never expand animation frames. This rasterizes every stored
 * buffer, so it protects all decode paths regardless of their own input checks.
 *
 * Exported so the identity-pack derivation's own `sharp` calls (extract, resize,
 * raw decode) run under the SAME limits as storage rather than a second copy of
 * the numbers that could drift — it re-decodes an already-stored portrait, which
 * is trusted only to the extent this guard makes it so.
 */
export const SHARP_DECODE_LIMITS = { limitInputPixels: 40_000_000, failOn: "error", animated: false } as const;

/**
 * Atomic write protocol: convert to webp, write `<name>.pending.webp`, fsync,
 * rename to the final path. Both the final and temporary paths are revalidated
 * beneath canonical DATA_ROOT, and O_NOFOLLOW prevents a pre-planted temp-file
 * symlink from redirecting the write.
 */
export async function writeWebpAtomic(absolutePath: string, buffer: Buffer): Promise<WrittenImageInfo> {
  let targetPath = containedAbsoluteImagePath(absolutePath);
  const { data, info } = await sharp(buffer, SHARP_DECODE_LIMITS)
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  // Directory creation may have exposed a pre-existing symlink component.
  targetPath = containedAbsoluteImagePath(targetPath);
  const pendingPath = containedAbsoluteImagePath(pendingPathFor(targetPath));
  const flags = constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW;
  const handle = await fs.open(pendingPath, flags, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(pendingPath, containedAbsoluteImagePath(targetPath));
  return { width: info.width, height: info.height, bytes: info.size };
}

function pendingPathFor(absolutePath: string): string {
  return absolutePath.endsWith(".webp")
    ? `${absolutePath.slice(0, -".webp".length)}.pending.webp`
    : `${absolutePath}.pending`;
}

const metaSchema = z.record(z.string(), z.unknown());

/**
 * The write-path merge: the stored jsonb re-parsed at the trust boundary, plus
 * the fields this update contributes. Deliberately NOT built on `imageMeta` —
 * `parseOr` additionally JSON-decodes a string column value and drops a
 * `__proto__` key, and the write path is where that hardening belongs.
 */
function mergeMeta(raw: unknown, extra: Record<string, unknown>): Record<string, unknown> {
  return { ...parseOr(metaSchema, raw, {}), ...extra };
}

/**
 * An images row's jsonb `meta` as a plain record for READING one stored field
 * (`lookKey`, `source`, `error`) — `{}` for null, an array, or any non-object,
 * so a caller's field lookup simply misses instead of throwing.
 */
export function imageMeta(meta: unknown): Record<string, unknown> {
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

/**
 * Completes the row-before-file protocol for a generated buffer. Conversion
 * or write failure marks the row failed instead of throwing; the returned row
 * carries the final status.
 */
export async function saveImageBuffer(imageId: string, buffer: Buffer, sink?: DiagnosticSink): Promise<ImageRow | null> {
  const [row] = await db().select().from(images).where(eq(images.id, imageId)).limit(1);
  if (!row) {
    sink?.push(diag("error", "images.save_missing_row", `no images row for ${imageId}`));
    return null;
  }
  try {
    const info = await writeWebpAtomic(absoluteImagePath(row), buffer);
    const [updated] = await db()
      .update(images)
      // `bytes` is also the storage-quota column (rate-limits.plan.md slice 4);
      // it is written here, at the one place a file actually lands on disk, so
      // the quota measures reality rather than intent.
      .set({ status: "ready", bytes: info.bytes, meta: mergeMeta(row.meta, { ...info }) })
      .where(eq(images.id, imageId))
      .returning();
    return updated ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink?.push(diag("error", "images.save_failed", message.slice(0, 300), { context: { imageId } }));
    return failImage(imageId, message);
  }
}

/** What a lane's generate step hands back: bytes to save, or the text a failed row records. */
export type ImageProduceResult = { ok: true; image: Buffer } | { ok: false; error: string };

/** `ready` ⇒ the file landed and the row says so; `failed` ⇒ the row carries the reason. */
export type ImagePipelineStatus = "ready" | "failed";

export interface ImagePipelineOutcome {
  imageId: string;
  status: ImagePipelineStatus;
  /** When generation started (after the reserve) — the lanes' `durationMs` baseline. */
  startedMs: number;
}

export interface ImagePipelineThrown {
  imageId: string;
  /** `describeProviderError`'s text — already written to the row. */
  message: string;
  startedMs: number;
}

export interface ImagePipelineOptions {
  /** The row reserved before anything is generated. */
  asset: CreateImageAssetOptions;
  /** Non-null ⇒ fail the reserved row with this text and stop: no generation, no hooks. */
  failedPrecondition?: string | null;
  /** Runs once the row exists, before the generation clock starts. */
  afterReserve?: (asset: ImageRow) => Promise<void>;
  /** The generation step, handed its own reserved row. Anything it throws is caught here. */
  produce: (asset: ImageRow) => Promise<ImageProduceResult>;
  /** Runs only when the file landed and the row reads `ready`. */
  onReady?: (asset: ImageRow) => Promise<void>;
  /** Produce returned (saved or failed) — the lane's event log. */
  onSettled?: (outcome: ImagePipelineOutcome) => void;
  /** Produce threw — the row is already failed with `message`. */
  onThrown?: (outcome: ImagePipelineThrown) => void;
  /** Warn diagnostic recorded when produce throws; `imageId` joins any context supplied. */
  failureDiagnostic?: { code: string; context?: Record<string, unknown> };
  sink?: DiagnosticSink;
}

export interface ImagePipelineResult {
  imageId: string;
  status: ImagePipelineStatus;
}

/**
 * The one reserve → generate → save-or-fail → log sequence every image lane runs
 * (audit C1, image-pipeline-consolidation.plan.md slice 4). Six copies of it had
 * already drifted in ways nobody decided — one lane recorded a failure
 * diagnostic and its neighbour didn't — so the ordering, and with it the
 * row-before-file invariant (docs/images.md), lives here and nowhere else:
 *
 *   reserve → afterReserve → precondition → produce → save-or-fail → onReady → log
 *
 * The shell owns execution, never the answer: each lane keeps its own return
 * type, event payload and diagnostics, and every hook below exists because a
 * lane needs it.
 *
 * - **`failedPrecondition`** — the "row exists, nothing was attempted" shape.
 *   avatar/entity/variants reserve the row BEFORE they know the character or
 *   entity is missing, then fail it with no event log and no diagnostic. Lanes
 *   whose precondition is cheaper than a row (the chat look/place anchors: demo
 *   mode, no provider key) return before calling in at all — the shell supports
 *   both orderings because it never moves the reserve relative to a lane's own
 *   checks.
 * - **`afterReserve`** — work that belongs to the row rather than to the
 *   generation, and so must not be on the clock: the scene lane's
 *   `image_references` rows.
 * - **`produce`** — the provider call. Bytes, or a structured failure for a
 *   provider that reports one instead of throwing (the scene chain exhausting
 *   every rung; a reference edit returning `ok: false`). Whatever it throws is
 *   caught here and `describeProviderError` writes the row's failure text, so no
 *   lane repeats that.
 * - **`onReady`** — the pointer writes that are only correct once the file
 *   exists: `characters.avatar_image_id`, an entity's `image_id` + reclaim, the
 *   look anchor's keep-latest purge.
 * - **`onSettled` / `onThrown`** — the per-lane event log, injected by the
 *   caller (ruled: the event log stays per-lane, and a lane without one gains
 *   none). Two hooks rather than one because avatar and entity log a DIFFERENT
 *   payload when the provider threw (`error`, no `demo`/`durationMs`) than when
 *   it settled, while variants and scene log the same line either way.
 * - **`failureDiagnostic`** — the warn diagnostic for a THROWN generation
 *   failure; the failing row's `imageId` joins whatever context is supplied, and
 *   supplying none leaves the diagnostic context-free (the chat look/place
 *   shape). A lane whose generation failure is a RETURNED failure pushes its own
 *   diagnostic at that branch, because only the lane can tell a precondition it
 *   cannot satisfy (variants with no reference avatar — diagnostic-free, exactly
 *   like entity's not-found) from a generation that actually failed.
 *
 * **Lane differences preserved, not normalized:** avatar/entity/variants/scene
 * return the asset id even when the row failed, while the chat anchors return
 * null; variants stamps `durationMs` on its failure event and avatar/entity do
 * not; the chat anchors log no event at all; only the scene lane keeps a
 * diagnostic COLLECTOR (its provider chain's fallback record), and it drains
 * that itself around this call, as its `finally` always did.
 *
 * **The one ruled normalization** (plan §Review rulings 2026-07-30 — a
 * deliberate resilience improvement, not behaviour-neutral cleanup): a
 * generation failure now records a warn diagnostic in every lane.
 * `images.avatar.generate_failed` and `images.variant.generate_failed` joined
 * the entity lane's long-standing `images.entity.generate_failed`.
 */
export async function runImagePipeline(opts: ImagePipelineOptions): Promise<ImagePipelineResult> {
  // Periodic maintenance rides the work it maintains (see §Scheduling the sweep):
  // fire-and-forget, throttled to one pass per SWEEP_INTERVAL_MS, and deliberately
  // BEFORE the generation — a render that dies mid-flight is precisely the row a
  // later sweep has to reclaim, so the kick must not depend on reaching the end.
  kickImageSweep();
  const asset = await createImageAsset(opts.asset);
  await opts.afterReserve?.(asset);

  const precondition = opts.failedPrecondition ?? null;
  if (precondition !== null) {
    await failImage(asset.id, precondition);
    return { imageId: asset.id, status: "failed" };
  }

  const startedMs = Date.now();
  try {
    const produced = await opts.produce(asset);
    if (!produced.ok) {
      await failImage(asset.id, produced.error);
      opts.onSettled?.({ imageId: asset.id, status: "failed", startedMs });
      return { imageId: asset.id, status: "failed" };
    }
    const saved = await saveImageBuffer(asset.id, produced.image, opts.sink);
    const status: ImagePipelineStatus = saved?.status === "ready" ? "ready" : "failed";
    if (status === "ready") await opts.onReady?.(asset);
    opts.onSettled?.({ imageId: asset.id, status, startedMs });
    return { imageId: asset.id, status };
  } catch (err) {
    const message = describeProviderError(err);
    await failImage(asset.id, message);
    const failure = opts.failureDiagnostic;
    if (failure) {
      opts.sink?.push(
        diag(
          "warn",
          failure.code,
          message.slice(0, 300),
          failure.context ? { context: { ...failure.context, imageId: asset.id } } : undefined,
        ),
      );
    }
    opts.onThrown?.({ imageId: asset.id, message, startedMs });
    return { imageId: asset.id, status: "failed" };
  }
}

/**
 * Delete every images row matching `where` and unlink their files best-effort
 * (image_sweep reconciles stragglers). The CALLER owns the predicate — build it
 * with the same owner/kind/chat guards the call site needs; this helper adds
 * nothing and so can never widen one. Returns how many rows were removed.
 *
 * An `undefined` predicate would match the whole table, so it is refused: a
 * caller whose guards all collapsed to `undefined` deletes nothing rather than
 * everything.
 *
 * **Derived state is retired BEFORE the delete, never after.**
 * `image_identity_packs.source_image_id` is a `set null` foreign key, so the
 * moment these rows go the pack that named one of them can no longer be FOUND by
 * source id — an invalidation sequenced after the delete matches nothing and
 * leaves a `current`, `ready` pack with a null source
 * (image-identity-packs.spec.lifecycle.md §"Source deletion"). Ordering is the
 * fix; it is deliberately not a transaction, because the hook is a registry call
 * into a module this one must not know about and threading a transaction handle
 * through that seam would re-couple them. The FK, and the read seam's refusal to
 * report a null-source pack as ready, cover the window between the two
 * statements.
 */
export async function purgeImagesWhere(where: SQL | undefined): Promise<number> {
  if (where === undefined) {
    log.warn("images", "purgeImagesWhere refused an unguarded predicate");
    return 0;
  }
  const rows = await db()
    .select({ id: images.id, ownerId: images.ownerId, path: images.path, kind: images.kind })
    .from(images)
    .where(where);
  if (rows.length === 0) return 0;
  // Hidden kinds are derived state themselves, never a pack's source — skipping
  // them spares the pack service's own crop reclamation a guaranteed-no-op
  // invalidation round trip on every cleanup pass.
  const sources = rows.filter((row) => !HIDDEN_IMAGE_KINDS.some((kind) => kind === row.kind));
  if (sources.length > 0) await invalidateDerivedState(sources.map((row) => row.id));
  await db().delete(images).where(where);
  await Promise.all(rows.map((row) => unlinkImageFile(row)));
  return rows.length;
}

/** Best-effort file removal for a purged row — never throws; image_sweep reconciles stragglers. */
async function unlinkImageFile(row: ImageFileRef): Promise<void> {
  try {
    await fs.unlink(absoluteImagePath(row));
  } catch {
    // already gone, or a path that no longer resolves — the sweep reconciles
  }
}

/**
 * Hard-delete one owned image — the row first, then its file best-effort
 * (image_sweep reconciles a straggler). Owner-scoped, with an optional `kind`
 * guard so a route can't delete the wrong class of asset through it. Returns
 * false when no matching row exists (already gone, not owned, wrong kind). The
 * single-asset counterpart to the bulk deleteEntityImages.
 */
export async function deleteOwnedImage(
  imageId: string,
  ownerId: string,
  opts: { kind?: ImageKind; kinds?: readonly ImageKind[] } = {},
): Promise<boolean> {
  const removed = await purgeImagesWhere(and(eq(images.id, imageId), eq(images.ownerId, ownerId), kindGuard(opts)));
  return removed > 0;
}

/** The optional single/multi kind guard shared by the owned-delete helpers. */
function kindGuard(opts: { kind?: ImageKind; kinds?: readonly ImageKind[] }) {
  if (opts.kinds) return inArray(images.kind, [...opts.kinds]);
  return opts.kind ? eq(images.kind, opts.kind) : undefined;
}

/** The asset classes the Gallery hub may act on (list / favorite / delete). */
export const GALLERY_IMAGE_KINDS = ["scene", "portrait_variant", "entity"] as const satisfies readonly ImageKind[];

/**
 * Kinds that are INTERNAL render inputs, never user-visible assets
 * (image-identity-packs.spec.data.md §Hidden image asset). Their owner may read
 * one — the crop editor has to display it — but they must be absent from every
 * listing, copy and cross-owner read:
 *
 * - the character read's portrait strip (`api/characters/[id]/route.ts` GET);
 * - `cloneEntityImages` — a copied or published character DERIVES its own pack
 *   rather than inheriting the origin's hidden bytes (spec.lifecycle.md §Copy);
 * - the public file-serving widening in `api/images/[id]/file/route.ts`, so a
 *   hidden crop of a PUBLIC character still stops at its owner.
 *
 * Surfaces that filter by a POSITIVE kind list — the Gallery tabs, the chat asset
 * queries, and the portrait studio's `PORTRAIT_STUDIO_KINDS` (which backs the
 * studio's GET/DELETE/promote) — exclude these by construction and need nothing
 * from here. A new surface subtracts them with this list rather than repeating
 * the literal.
 */
export const HIDDEN_IMAGE_KINDS = ["identity_face_crop"] as const satisfies readonly ImageKind[];

/**
 * The identity-pack lifecycle's call-back into this module
 * (image-identity-packs.spec.lifecycle.md §"Image sweep integration").
 *
 * A registry rather than an import because the dependency only runs one way:
 * `identity-packs.ts` imports this module for `createImageAsset`,
 * `saveImageBuffer` and `purgeImagesWhere`, so an import back would close a
 * cycle and fail `pnpm lint:cycles`. A dynamic `await import()` would not help —
 * madge counts async imports as edges too. So the pack service registers itself
 * on load (it is imported by `avatar.ts`, `variants.ts` and the barrel, i.e. by
 * everything that can reach a sweep), and the two call sites below stay
 * pack-agnostic.
 *
 * Both hooks must contain their own failures: pointer clearing and the
 * scheduled sweep are maintenance, and neither may fail the delete or the render
 * that triggered them. `sweep` returns plain counters that join the sweep job
 * row's payload, which is why this module needs to know nothing about what they
 * mean.
 */
export interface IdentityPackMaintenanceHooks {
  /**
   * Images whose derived state is no longer valid, at the two moments that can
   * be observed from here: rows `purgeImagesWhere` is ABOUT to delete (the last
   * instant a pack can still be matched by its source id — see that function),
   * and ids whose entity pointers were just nulled while the row itself
   * survived (a kind-guarded delete skipped it).
   */
  invalidateForImages(imageIds: readonly string[]): Promise<void>;
  /** Consistency findings + bounded revision cleanup, run inside the scheduled sweep. */
  sweep(now: Date): Promise<Record<string, number>>;
}

let identityPackMaintenance: IdentityPackMaintenanceHooks | null = null;

/** Called once, at `identity-packs.ts` module load. `null` restores the no-op (tests). */
export function registerIdentityPackMaintenance(hooks: IdentityPackMaintenanceHooks | null): void {
  identityPackMaintenance = hooks;
}

/**
 * The invalidation call, contained here as well as inside the hook. The
 * registered implementation already swallows its own failures, but the delete
 * now runs DOWNSTREAM of this call rather than before it, so "maintenance never
 * fails the delete that triggered it" stops being a property of one
 * implementation and becomes a property of the sequence.
 */
async function invalidateDerivedState(imageIds: readonly string[]): Promise<void> {
  try {
    await identityPackMaintenance?.invalidateForImages(imageIds);
  } catch (err) {
    log.warn("images", "identity pack invalidation before an image delete failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Null out the soft pointers entity rows keep at deleted image ids — a
 * gallery-deleted portrait leaves its character avatar-less (the portrait
 * studio's own rule), a deleted entity render leaves its location/item
 * imageless — never dangling. No-op for scene ids (nothing points at scenes).
 *
 * Clearing a canonical portrait pointer also invalidates whatever was derived
 * FROM it: an identity pack whose source pointer just went away must not keep
 * serving its crop (spec.lifecycle.md §"Source deletion"). Read-time hash
 * verification is still the backstop — this is the belt to its braces, for the
 * paths that bypass the assignment triggers.
 *
 * The delete paths retire the pack in `purgeImagesWhere`, before the row goes,
 * so for a deleted id this pass usually matches nothing. It stays because the
 * ids a caller hands over are not always the ids that were deleted: the Gallery's
 * bulk route passes every REQUESTED id, and one the kind guard skipped still owns
 * its image row — so its pack is still reachable by source id and must go with
 * the pointer.
 */
export async function clearEntityImagePointers(imageIds: readonly string[]): Promise<void> {
  if (imageIds.length === 0) return;
  const ids = [...imageIds];
  await Promise.all([
    db().update(characters).set({ avatarImageId: null }).where(inArray(characters.avatarImageId, ids)),
    db().update(locations).set({ imageId: null }).where(inArray(locations.imageId, ids)),
    db().update(items).set({ imageId: null }).where(inArray(items.imageId, ids)),
  ]);
  await identityPackMaintenance?.invalidateForImages(ids);
}

/**
 * Hard-delete many owned images by id in one statement — the bulk counterpart to
 * deleteOwnedImage, used by the Gallery's "Delete all" (delete every scene the
 * active world/character filter shows). Owner-scoped with the same optional
 * `kind` guard, so ids not owned / of the wrong kind / already gone are silently
 * skipped — a caller can never reach another owner's or another class of asset.
 * Files are unlinked best-effort (image_sweep reconciles stragglers). Returns
 * the count actually removed.
 */
export async function deleteOwnedImages(
  imageIds: string[],
  ownerId: string,
  opts: { kind?: ImageKind; kinds?: readonly ImageKind[] } = {},
): Promise<number> {
  if (imageIds.length === 0) return 0;
  return purgeImagesWhere(and(inArray(images.id, imageIds), eq(images.ownerId, ownerId), kindGuard(opts)));
}

/**
 * Hard-delete a chat's player-attached photos (chat-image-input.plan.md):
 * `kind: "chat_upload"` rows are player content, deleted WITH their message /
 * conversation — never Gallery survivors like scenes. With `anchorMessageIds`
 * only the attachments of those messages go (a snip / rerun successor sweep);
 * without, every upload in the chat goes — including never-sent orphans whose
 * `anchor_message_id` was never stamped (Clear Chat, deleteChat). Files unlink
 * best-effort (image_sweep reconciles stragglers). Returns the count removed.
 */
export async function deleteChatUploads(chatId: string, anchorMessageIds?: readonly string[]): Promise<number> {
  if (anchorMessageIds !== undefined && anchorMessageIds.length === 0) return 0;
  return purgeImagesWhere(
    anchorMessageIds
      ? and(eq(images.chatId, chatId), eq(images.kind, "chat_upload"), inArray(images.anchorMessageId, [...anchorMessageIds]))
      : and(eq(images.chatId, chatId), eq(images.kind, "chat_upload")),
  );
}

/**
 * Hard-delete a conversation's chat-private assets by kind (uploads, look/place
 * references — everything that must NOT survive the chat the way scenes do).
 * Files unlink best-effort; the sweep reconciles stragglers.
 */
export async function deleteChatAssets(chatId: string, kinds: readonly ImageKind[]): Promise<number> {
  if (kinds.length === 0) return 0;
  return purgeImagesWhere(and(eq(images.chatId, chatId), inArray(images.kind, [...kinds])));
}

/**
 * Validate + claim a message's attachments at send time (chat-image-input.plan.md):
 * keep only ids that are THIS chat's ready `chat_upload` rows (order preserved,
 * unknown/foreign ids dropped), and stamp `anchor_message_id` so the message's
 * delete paths can find them. Returns the surviving ids with their file paths
 * (the vision read wants both).
 */
export async function claimChatAttachments(
  chatId: string,
  messageId: string,
  imageIds: readonly string[],
): Promise<ImageFileRef[]> {
  if (imageIds.length === 0) return [];
  const rows = await db()
    .select({ id: images.id, ownerId: images.ownerId, path: images.path })
    .from(images)
    .where(
      and(
        inArray(images.id, [...imageIds]),
        eq(images.chatId, chatId),
        eq(images.kind, "chat_upload"),
        eq(images.status, "ready"),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const kept = imageIds.map((id) => byId.get(id)).filter((row): row is ImageFileRef => row !== undefined);
  if (kept.length) {
    await db()
      .update(images)
      .set({ anchorMessageId: messageId })
      .where(inArray(images.id, kept.map((row) => row.id)));
  }
  return kept;
}

/** The file paths for a message's already-claimed attachments (regenerate/rerun re-reads). */
export async function chatAttachmentPaths(chatId: string, imageIds: readonly string[]): Promise<ImageFileRef[]> {
  if (imageIds.length === 0) return [];
  const rows = await db()
    .select({ id: images.id, ownerId: images.ownerId, path: images.path })
    .from(images)
    .where(and(inArray(images.id, [...imageIds]), eq(images.chatId, chatId), eq(images.kind, "chat_upload"), eq(images.status, "ready")));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return imageIds.map((id) => byId.get(id)).filter((row): row is ImageFileRef => row !== undefined);
}

/**
 * Duplicate a shareable entity's ready images into a new owner's storage for a
 * clone (auth.plan.md / world-instances image policy). Each source image gets a
 * fresh row owned by `dstOwnerId`, pointed at `dstEntityId`, with the file
 * **copied** (not shared) so the clone is fully self-contained — deleting the
 * source can never strip the copy's art. `sourceImageId` records provenance.
 * Returns old→new image-id map so callers can remap avatar/cover references.
 * An image that fails to copy is skipped (degraded, never throws).
 *
 * `HIDDEN_IMAGE_KINDS` never travels: an identity face crop is derived state, and
 * the destination character derives its OWN pack from its own copied portrait
 * once that row is ready (image-identity-packs.spec.lifecycle.md §Copy and
 * publish). Cloning one would hand the destination a crop whose pack row — the
 * only authority for whether it may be used at all — did not come with it.
 */
export async function cloneEntityImages(
  entityKind: ImageEntityKind,
  srcEntityId: string,
  srcOwnerId: string,
  dstEntityId: string,
  dstOwnerId: string,
): Promise<Map<string, string>> {
  const rows = await db()
    .select()
    .from(images)
    .where(
      and(
        eq(images.ownerId, srcOwnerId),
        eq(images.entityKind, entityKind),
        eq(images.entityId, srcEntityId),
        eq(images.status, "ready"),
        notInArray(images.kind, [...HIDDEN_IMAGE_KINDS]),
      ),
    );
  const idMap = new Map<string, string>();
  for (const src of rows) {
    const newImageId = newId();
    const relative = imageRelativePath(dstOwnerId, newImageId);
    try {
      const absoluteDst = absoluteImagePath({ id: newImageId, ownerId: dstOwnerId, path: relative });
      await fs.mkdir(path.dirname(absoluteDst), { recursive: true });
      await fs.copyFile(absoluteImagePath(src), containedAbsoluteImagePath(absoluteDst));
    } catch (err) {
      log.warn("images", "clone image copy failed; skipping", {
        imageId: src.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const [inserted] = await db()
      .insert(images)
      .values({
        id: newImageId,
        ownerId: dstOwnerId,
        kind: src.kind,
        entityKind,
        entityId: dstEntityId,
        path: relative,
        prompt: src.prompt,
        sourceImageId: src.id,
        status: "ready",
        meta: src.meta,
      })
      .returning({ id: images.id });
    if (inserted) idMap.set(src.id, inserted.id);
  }
  return idMap;
}

export async function failImage(imageId: string, error: string): Promise<ImageRow | null> {
  const [row] = await db().select({ meta: images.meta }).from(images).where(eq(images.id, imageId)).limit(1);
  const [updated] = await db()
    .update(images)
    .set({ status: "failed", meta: mergeMeta(row?.meta, { error: error.slice(0, 500) }) })
    .where(eq(images.id, imageId))
    .returning();
  return updated ?? null;
}

export interface SweepResult {
  filesScanned: number;
  rowsScanned: number;
  orphanFilesRemoved: number;
  stalePendingFilesRemoved: number;
  rowsMarkedFailed: number;
  errors: string[];
}

export interface SweepOptions {
  /** Restrict the sweep to one owner's rows + directory (tests, per-user maintenance). */
  ownerId?: string;
  now?: Date;
}

/** Files/rows younger than this are left alone — they may be mid-protocol. */
const SWEEP_GRACE_MS = 10 * 60_000;

/**
 * Idempotent rows↔files reconciliation (docs/images.md). Both directions:
 * ready rows whose file vanished are marked failed; files without a row (and
 * crash-leftover `.pending.webp` temps) older than the grace period are
 * removed. Never throws, and every scanned or row-derived path passes through
 * the same DATA_ROOT containment and symlink checks as ordinary asset access.
 */
export async function sweepOrphans(opts: SweepOptions = {}): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const result: SweepResult = {
    filesScanned: 0,
    rowsScanned: 0,
    orphanFilesRemoved: 0,
    stalePendingFilesRemoved: 0,
    rowsMarkedFailed: 0,
    errors: [],
  };
  try {
    const baseQuery = db()
      .select({ id: images.id, ownerId: images.ownerId, path: images.path, status: images.status, createdAt: images.createdAt })
      .from(images);
    const rows = opts.ownerId ? await baseQuery.where(eq(images.ownerId, opts.ownerId)) : await baseQuery;
    result.rowsScanned = rows.length;
    const rowPaths = new Set(rows.map((row) => row.path));

    const root = dataRoot();
    const imagesDir = imagesDirectoryPath(opts.ownerId);
    let entries: Array<{ parentPath: string; name: string; isFile(): boolean }> = [];
    try {
      entries = await fs.readdir(imagesDir, { recursive: true, withFileTypes: true });
    } catch {
      // no data directory yet — nothing on the files side
    }

    // Safety rail, now that this actually runs on a schedule: NO rows at all with
    // files on disk means the database and the volume disagree — a fresh or branched
    // database, a mis-set DATABASE_URL — not that every file is an orphan. Wiping the
    // volume on that reading is unrecoverable, so the file side is skipped entirely
    // and the disagreement is logged. (Row-side reconciliation is a no-op anyway with
    // no rows, so nothing else is lost.)
    const filesPresent = entries.some((entry) => entry.isFile());
    if (rows.length === 0 && filesPresent) {
      log.warn("images", "sweep skipped the file side: image rows are empty but files exist", {
        dir: path.relative(root, imagesDir).split(path.sep).join("/"),
      });
      return result;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      result.filesScanned += 1;
      const absolute = containedAbsoluteImagePath(path.join(entry.parentPath, entry.name));
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const isPendingTemp = entry.name.endsWith(".pending.webp");
      if (!isPendingTemp && rowPaths.has(relative)) continue;
      try {
        const stat = await fs.stat(absolute);
        if (now.getTime() - stat.mtimeMs < SWEEP_GRACE_MS) continue;
        await fs.unlink(absolute);
        if (isPendingTemp) {
          result.stalePendingFilesRemoved += 1;
          log.warn("images", "swept stale pending temp file", { path: relative });
        } else {
          result.orphanFilesRemoved += 1;
          log.warn("images", "swept orphan file without a row", { path: relative });
        }
      } catch (err) {
        result.errors.push(`file ${relative}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const row of rows) {
      try {
        if (row.status === "ready") {
          const exists = await fileExists(absoluteImagePath(row));
          if (exists) continue;
          await db().update(images).set({ status: "failed" }).where(eq(images.id, row.id));
          result.rowsMarkedFailed += 1;
          log.warn("images", "ready row lost its file; marked failed", { imageId: row.id, path: row.path });
        } else if (row.status === "pending" && now.getTime() - row.createdAt.getTime() >= SWEEP_GRACE_MS) {
          await failImage(row.id, "stale pending row reclaimed by image_sweep");
          result.rowsMarkedFailed += 1;
          log.warn("images", "stale pending row marked failed", { imageId: row.id });
        }
      } catch (err) {
        result.errors.push(`row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    log.warn("images", "sweepOrphans degraded", { error: result.errors.at(-1) ?? "unknown" });
  }
  return result;
}

async function fileExists(absolute: string): Promise<boolean> {
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scheduling the sweep
// ---------------------------------------------------------------------------

/**
 * `sweepOrphans` had no caller — it was written, tested, and documented as
 * "on-demand + periodic", but nothing ever ran it, so a row whose render died
 * (a deploy replacing the machine mid-generation) stayed `pending` forever and
 * painted a tile that never resolved (owner report 2026-08-02).
 *
 * Scheduling shape: **request-driven, not a timer** — the same pattern the durable
 * time-jobs use ("the boot/next-request sweep", `engine/sim-time-jobs.ts`). A
 * `setInterval` inside a Next server has no owner, no visibility, and silently
 * doubles under a second instance; a kick off work the app is already doing needs
 * no infrastructure and is self-limiting. The kick sits on `runImagePipeline`, so
 * maintenance runs while the app is doing image work — exactly when orphans are
 * created, and exactly when a stale tile is about to be looked at.
 *
 * Lives here rather than in its own module because the scheduler and the sweep it
 * schedules would otherwise import each other (a real cycle, and `pnpm lint:cycles`
 * is right to refuse it).
 */

/** How often the reconciliation actually runs. Orphans are rare and never urgent. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

/** In-process throttle: a burst of renders costs one durable check, not one per render. */
let lastSweepAttemptMs = 0;

/** Guards a second kick starting while one pass is still running in this process. */
let sweepRunning = false;

/** Whether an `image_sweep` row exists inside the interval — the durable "already swept". */
async function sweptRecently(now: Date): Promise<boolean> {
  const [recent] = await db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.type, "image_sweep"), gt(jobs.createdAt, new Date(now.getTime() - SWEEP_INTERVAL_MS))))
    .limit(1);
  return recent !== undefined;
}

/**
 * One reconciliation pass, recorded as an `image_sweep` job row — the row IS the
 * "last swept" marker the durable guard reads. Also reclaims job rows orphaned the
 * same way the image rows were (`reclaimOrphanedJobs`): one periodic tick, both
 * kinds of leftovers.
 */
async function runScheduledSweep(now: Date): Promise<void> {
  const [row] = await db()
    .insert(jobs)
    .values({ type: "image_sweep", status: "running", payload: {}, attempts: 1, startedAt: now })
    .returning({ id: jobs.id });
  if (!row) return;
  try {
    const result = await sweepOrphans();
    const jobsReclaimed = await reclaimOrphanedJobs();
    // Derived-asset maintenance rides the same tick: identity-pack consistency
    // findings (flagged, never silently repaired) and the bounded retention
    // cleanup for superseded crops. It runs AFTER `sweepOrphans` so a crop whose
    // file vanished is already marked failed when the findings look at it.
    const identity = (await identityPackMaintenance?.sweep(now)) ?? {};
    const summary = { ...result, jobsReclaimed, ...identity };
    const identityTotal = Object.values(identity).reduce((total, value) => total + value, 0);
    if (
      result.orphanFilesRemoved + result.stalePendingFilesRemoved + result.rowsMarkedFailed + jobsReclaimed + identityTotal >
      0
    ) {
      log.warn("images", "sweep reconciled orphaned rows/files", summary);
    }
    await db().update(jobs).set({ status: "done", payload: summary, finishedAt: new Date() }).where(eq(jobs.id, row.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("images", "scheduled image sweep failed", { error: message });
    try {
      await db()
        .update(jobs)
        .set({ status: "failed", error: message.slice(0, 500), finishedAt: new Date() })
        .where(eq(jobs.id, row.id));
    } catch {
      // the marker row is bookkeeping; failing to close it just means the next kick re-sweeps
    }
  }
}

/**
 * Fire-and-forget maintenance kick. Returns immediately and never throws, so the
 * render that triggered it is never blocked, delayed, or failed by maintenance.
 * Safe to call on every image generation. A double sweep would be harmless anyway
 * (`sweepOrphans` is idempotent) — the guards are about cost, not correctness.
 */
export function kickImageSweep(): void {
  const now = new Date();
  if (sweepRunning || now.getTime() - lastSweepAttemptMs < SWEEP_INTERVAL_MS) return;
  lastSweepAttemptMs = now.getTime();
  sweepRunning = true;
  void (async () => {
    try {
      if (!(await sweptRecently(now))) await runScheduledSweep(now);
    } catch (err) {
      log.warn("images", "image sweep kick failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      sweepRunning = false;
    }
  })();
}
