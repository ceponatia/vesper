import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, images, JOB_STALE_MS } from "../db";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { log } from "@/server/log";
import { absoluteImagePath, containedAbsoluteImagePath, imageRelativePath, type StoredImagePath } from "./paths";

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
 * degradable by design (docs/images/asset-registry.md): the row is written before the file, and
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

/** Row-before-file: every asset starts as a pending row (docs/images/asset-registry.md). */
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

/** Storage encode quality. Exported so reference preparation encodes at the
 * SAME fidelity — preparation must not cost more than storage does, and one
 * constant cannot drift into two answers. */
export const WEBP_QUALITY = 90;

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
 * The render lease (docs/images/asset-registry.md §The sweep): epoch
 * milliseconds of the last heartbeat `runImagePipeline` wrote on its own
 * reserved row. Only a `pending` row carries one — saving and failing retire it
 * — and the sweep reads it to tell a render that is still running from one
 * whose process died.
 */
export const RENDER_LEASE_META_KEY = "renderLeaseAtMs";

/** What a `ready` row never carries: a failure it no longer has, and a lease nobody holds. */
export const READY_RETIRED_META_KEYS = ["error", "failedAt", RENDER_LEASE_META_KEY] as const;

/**
 * The write-path merge: the stored jsonb re-parsed at the trust boundary, minus
 * the keys this transition retires, plus the fields this update contributes.
 * Deliberately NOT built on `imageMeta` — `parseOr` additionally JSON-decodes a
 * string column value and drops a `__proto__` key, and the write path is where
 * that hardening belongs.
 */
function mergeMeta(
  raw: unknown,
  extra: Record<string, unknown>,
  retire: readonly string[] = [],
): Record<string, unknown> {
  const kept = Object.entries(parseOr(metaSchema, raw, {})).filter(([key]) => !retire.includes(key));
  return { ...Object.fromEntries(kept), ...extra };
}

/**
 * The SQL-side form of {@link mergeMeta}: the row's own `meta` (anything but an
 * object reads as `{}`), minus `retire`, plus `patch` — evaluated by Postgres
 * against the version of the row the UPDATE actually writes. A write that must
 * not lose a concurrent one (the lease heartbeat, the sweep's guarded reclaim)
 * merges here instead of reading `meta` into JS and writing it back.
 */
export function mergeMetaSql(patch: Record<string, unknown>, retire: readonly string[] = []): SQL {
  let base: SQL = sql`(case when jsonb_typeof(${images.meta}) = 'object' then ${images.meta} else '{}'::jsonb end)`;
  for (const key of retire) base = sql`(${base} - ${key}::text)`;
  return sql`${base} || ${JSON.stringify(patch)}::jsonb`;
}

/**
 * The failure record a failed row carries: the error text, and `failedAt` —
 * retention's clock (`planFailedImageRetirement` in asset-maintenance.ts),
 * stamped at the failure because `created_at` is when the row was RESERVED. One
 * shape for both writers of a failure: {@link failImage} and the sweep's guarded
 * reclaim.
 */
export function failureStamp(error: string, at: Date = new Date()): { error: string; failedAt: string } {
  return { error: error.slice(0, 500), failedAt: at.toISOString() };
}

/**
 * One render-lease heartbeat: stamp `atMs` on the row while, and only while, it
 * is still `pending`. The merge runs in SQL, so it writes the lease key and
 * nothing else, and a row a save or a failure has already settled is left
 * exactly as that write left it. True when the pending row took the stamp.
 */
export async function refreshRenderLease(imageId: string, atMs: number): Promise<boolean> {
  const touched = await db()
    .update(images)
    .set({ meta: mergeMetaSql({ [RENDER_LEASE_META_KEY]: atMs }) })
    .where(and(eq(images.id, imageId), eq(images.status, "pending")))
    .returning({ id: images.id });
  return touched.length > 0;
}

/**
 * The ids a paid output is fetched again by, as a render's row records them
 * under `meta.render` — the keys `renderAttemptMeta` writes for an undelivered
 * output when the render settles.
 */
export interface PaidRenderOutputRecord {
  predictionId: string;
  undeliveredOutputId: string;
  modelSlug: string;
}

/**
 * The SQL-side merge of `patch` into the row's `meta.render` object — the
 * nested counterpart of {@link mergeMetaSql}, which merges top-level keys only.
 * Anything but an object at `meta` or at `meta.render` reads as `{}`, and every
 * other key of both survives.
 */
function mergeRenderMetaSql(patch: Record<string, unknown>): SQL {
  const base: SQL = sql`(case when jsonb_typeof(${images.meta}) = 'object' then ${images.meta} else '{}'::jsonb end)`;
  const render: SQL = sql`(case when jsonb_typeof(${base} -> 'render') = 'object' then ${base} -> 'render' else '{}'::jsonb end)`;
  return sql`jsonb_set(${base}, '{render}', ${render} || ${JSON.stringify(patch)}::jsonb)`;
}

/**
 * Record a paid output's ids on its render's row BEFORE the output downloads
 * (docs/images/asset-registry.md §The sweep): the workflow, the output, and the
 * model, merged into `meta.render` in SQL while, and only while, the row is
 * still `pending` — the render-lease heartbeat's guard, so a row a save or a
 * failure has already settled is left exactly as that write left it, and a
 * concurrent heartbeat is never lost. True when the pending row took the ids.
 *
 * A settle that carries the attempt's provenance replaces `meta.render` whole,
 * so these ids outlive the render only where nothing replaced them: a process
 * that died mid-download (the sweep's reclaim keeps `meta.render`), or a
 * produce that threw. Either way the row then offers the output for recovery
 * (`paidOutputOffer`).
 */
export async function recordPendingRenderOutput(imageId: string, output: PaidRenderOutputRecord): Promise<boolean> {
  const touched = await db()
    .update(images)
    .set({
      meta: mergeRenderMetaSql({
        predictionId: output.predictionId,
        undeliveredOutputId: output.undeliveredOutputId,
        modelSlug: output.modelSlug,
      }),
    })
    .where(and(eq(images.id, imageId), eq(images.status, "pending")))
    .returning({ id: images.id });
  return touched.length > 0;
}

type ImageRowTransaction = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

/** A connection or a transaction, for a write that must ride the caller's lock. */
export type ImageRowExecutor = ReturnType<typeof db> | ImageRowTransaction;

/**
 * Fail the `pending` rows among `imageIds` whose render is known to be
 * abandoned — the caller has positive evidence its owner died, such as the
 * reference-view build lease that ran it expiring — unless a row still holds a
 * live render lease (beaten within `JOB_STALE_MS` of `now`), which says the
 * render itself is still running and is left alone.
 *
 * The sweep's guarded reclaim shape (`reclaimStalePendingRows`): one UPDATE
 * whose own WHERE re-checks `status = 'pending'` and the lease against the row
 * it writes, the failure stamp merged in SQL, the lease retired, and every
 * other key — `meta.render` with a paid output's ids included — kept. A lease
 * that is not a JSON number reads as no lease. Returns the rows it failed, as
 * they now read.
 */
export async function reclaimAbandonedRenderRows(
  executor: ImageRowExecutor,
  imageIds: readonly string[],
  error: string,
  now: Date,
): Promise<Array<Pick<ImageRow, "id" | "status" | "meta">>> {
  if (imageIds.length === 0) return [];
  const lease = sql`${images.meta} -> ${RENDER_LEASE_META_KEY}::text`;
  const leaseAtMs = sql`(${images.meta} ->> ${RENDER_LEASE_META_KEY}::text)::numeric`;
  const abandoned = sql`case
    when jsonb_typeof(${lease}) = 'number' then ${leaseAtMs} < ${now.getTime() - JOB_STALE_MS}::numeric
    else true
  end`;
  const reclaimed = await executor
    .update(images)
    .set({ status: "failed", meta: mergeMetaSql(failureStamp(error, now), [RENDER_LEASE_META_KEY]) })
    .where(and(inArray(images.id, [...imageIds]), eq(images.status, "pending"), abandoned))
    .returning({ id: images.id, status: images.status, meta: images.meta });
  return reclaimed;
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
 *
 * `extraMeta` is the producer's contribution to the row's meta (the render
 * provenance under `render`), merged in the SAME update as the file facts so
 * the row never says "ready" without it. The file facts win a key collision —
 * width/height/bytes describe the file that actually landed.
 *
 * A `ready` row carries no `error`, `failedAt` or render lease. A render can
 * land on a row that is already `failed` — the sweep reclaimed it while the
 * render was still running — and the image is real and paid for, so the row
 * becomes `ready` anyway, cleanly, with an `images.save_late_landing` warning.
 *
 * The warning reads the status this save SELECTed, without a lock, so it is
 * missed when the sweep's reclaim commits between that read and the UPDATE
 * below. The row still ends `ready` and clean — the UPDATE writes the status
 * and the whole of `meta` from the pre-reclaim read, so the reclaim's `error`
 * and `failedAt` do not survive it — and the gap is reachable only once the
 * row's lease has already been silent for 15 minutes (`JOB_STALE_MS`), or an
 * unleased row is already 2 hours old, while this process is mid-save.
 */
export async function saveImageBuffer(
  imageId: string,
  buffer: Buffer,
  sink?: DiagnosticSink,
  extraMeta?: Record<string, unknown>,
): Promise<ImageRow | null> {
  const [row] = await db().select().from(images).where(eq(images.id, imageId)).limit(1);
  if (!row) {
    sink?.push(diag("error", "images.save_missing_row", `no images row for ${imageId}`));
    return null;
  }
  try {
    const info = await writeWebpAtomic(absoluteImagePath(row), buffer);
    const [updated] = await db()
      .update(images)
      // `bytes` is also the storage-quota column; it is written here, at the
      // one place a file actually lands on disk, so
      // the quota measures reality rather than intent.
      .set({
        status: "ready",
        bytes: info.bytes,
        meta: mergeMeta(row.meta, { ...(extraMeta ?? {}), ...info }, READY_RETIRED_META_KEYS),
      })
      .where(eq(images.id, imageId))
      .returning();
    if (updated && row.status === "failed") reportLateLanding(row, sink);
    return updated ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink?.push(diag("error", "images.save_failed", message.slice(0, 300), { context: { imageId } }));
    return failImage(imageId, message, extraMeta);
  }
}

/**
 * A render landed on a row that was already `failed`, and the save made it
 * `ready`. The diagnostic makes the resurrection deliberate and visible: the
 * log line pairs with the sweep's own "stale pending row marked failed".
 */
function reportLateLanding(row: ImageRow, sink: DiagnosticSink | undefined): void {
  const previous = imageMeta(row.meta);
  const context = {
    imageId: row.id,
    ...(typeof previous.error === "string" ? { clearedError: previous.error.slice(0, 300) } : {}),
    ...(typeof previous.failedAt === "string" ? { failedAt: previous.failedAt } : {}),
  };
  sink?.push(
    diag("warn", "images.save_late_landing", "a render landed on a row already marked failed; the row is ready", {
      context,
    }),
  );
  log.warn("images", "late render landed on a failed row; marked ready", context);
}

/** The asset classes the Gallery hub may act on (list / favorite / delete). */
export const GALLERY_IMAGE_KINDS = ["scene", "portrait_variant", "entity"] as const satisfies readonly ImageKind[];

/**
 * Kinds that are INTERNAL operational assets, never user-visible ones: the
 * identity face crop, the identity-trial render output, the
 * Advanced Image Lab's control fixtures and experiment renders, the Image
 * Generator's run outputs, a character's reference views, and the full-body
 * images those views are built from.
 * Their owner may read one — the crop editor, the trial review UI, the lab's
 * fixtures panel, the studio's reference-view grid and its body-image area have
 * to display them — but
 * they must be absent from every listing, copy, cross-owner read and quota sum:
 *
 * - the character read's portrait strip (`api/characters/[id]/route.ts` GET);
 * - `cloneEntityImages` — a copied or published character DERIVES its own pack
 *   rather than inheriting the origin's hidden bytes;
 * - the public file-serving widening in `api/images/[id]/file/route.ts`, so a
 *   hidden crop of a PUBLIC character still stops at its owner;
 * - the per-owner storage quota (`checkStorageQuota` in `@/server/api`) — these
 *   bytes are the system's bookkeeping, not the user's stored images, so they
 *   do not count toward the ceiling; admission agrees (`imageRenderRejection`'s
 *   `outputKind` skips the storage reservation for these kinds).
 *
 * Surfaces that filter by a POSITIVE kind list — the Gallery tabs, the chat asset
 * queries, and the portrait studio's `PORTRAIT_STUDIO_KINDS` (which backs the
 * studio's GET/DELETE/promote) — exclude these by construction and need nothing
 * from here. A new surface subtracts them with this list rather than repeating
 * the literal.
 */
export const HIDDEN_IMAGE_KINDS = [
  "identity_face_crop",
  "identity_trial_output",
  "lab_control",
  "lab_output",
  "generator_output",
  "reference_view",
  "body_reference",
] as const satisfies readonly ImageKind[];

/**
 * `extraMeta` rides the same update as the error text; the error wins a collision.
 *
 * `failedAt` is stamped here because `created_at` is when the row was RESERVED,
 * not when it failed — a row that was `ready` for a month before its file
 * vanished fails today. Retention reads this stamp
 * (`planFailedImageRetirement` in asset-maintenance.ts), so writing it wherever a
 * failure is recorded — here, and in the sweep's guarded reclaim through the same
 * {@link failureStamp} — is what keeps that clock honest. A failed row holds no
 * render lease.
 */
export async function failImage(
  imageId: string,
  error: string,
  extraMeta?: Record<string, unknown>,
): Promise<ImageRow | null> {
  const [row] = await db().select({ meta: images.meta }).from(images).where(eq(images.id, imageId)).limit(1);
  const [updated] = await db()
    .update(images)
    .set({
      status: "failed",
      meta: mergeMeta(row?.meta, { ...(extraMeta ?? {}), ...failureStamp(error) }, [RENDER_LEASE_META_KEY]),
    })
    .where(eq(images.id, imageId))
    .returning();
  return updated ?? null;
}
