import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, images } from "../db";
import { newId } from "@/lib/ids";
import { log } from "@/server/log";
import { parseOr } from "@/lib/parse";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";

export type ImageRow = typeof images.$inferSelect;
export type ImageKind = ImageRow["kind"];
export type ImageEntityKind = NonNullable<ImageRow["entityKind"]>;

/** Runtime asset root. Overridable via DATA_ROOT for tests. */
export function dataRoot(): string {
  return process.env.DATA_ROOT ?? path.join(process.cwd(), "data");
}

/** Canonical relative path stored on the row (docs/images.md). */
export function imageRelativePath(ownerId: string, imageId: string): string {
  return `images/${ownerId}/${imageId}.webp`;
}

export function absoluteImagePath(image: Pick<ImageRow, "path">): string {
  return path.join(dataRoot(), image.path);
}

export interface CreateImageAssetOptions {
  ownerId: string;
  kind: ImageKind;
  entityKind?: ImageEntityKind;
  entityId?: string;
  sessionId?: string;
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
      sessionId: opts.sessionId,
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
 */
const SHARP_DECODE_LIMITS = { limitInputPixels: 40_000_000, failOn: "error", animated: false } as const;

/**
 * Atomic write protocol: convert to webp, write `<name>.pending.webp`, fsync,
 * rename to the final path. A crash leaves only a pending temp file that
 * sweepOrphans reclaims — never a half-written final file.
 */
export async function writeWebpAtomic(absolutePath: string, buffer: Buffer): Promise<WrittenImageInfo> {
  const { data, info } = await sharp(buffer, SHARP_DECODE_LIMITS)
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  const pendingPath = pendingPathFor(absolutePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const handle = await fs.open(pendingPath, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(pendingPath, absolutePath);
  return { width: info.width, height: info.height, bytes: info.size };
}

function pendingPathFor(absolutePath: string): string {
  return absolutePath.endsWith(".webp")
    ? `${absolutePath.slice(0, -".webp".length)}.pending.webp`
    : `${absolutePath}.pending`;
}

const metaSchema = z.record(z.string(), z.unknown());

function mergeMeta(raw: unknown, extra: Record<string, unknown>): Record<string, unknown> {
  return { ...parseOr(metaSchema, raw, {}), ...extra };
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
      .set({ status: "ready", meta: mergeMeta(row.meta, { ...info }) })
      .where(eq(images.id, imageId))
      .returning();
    return updated ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink?.push(diag("error", "images.save_failed", message.slice(0, 300), { context: { imageId } }));
    return failImage(imageId, message);
  }
}

/**
 * Hard-delete one owned image — the row first, then its file best-effort
 * (image_sweep reconciles a straggler). Owner-scoped, with an optional `kind`
 * guard so a route can't delete the wrong class of asset through it. Returns
 * false when no matching row exists (already gone, not owned, wrong kind). The
 * single-asset counterpart to the bulk deleteSessionImages/deleteEntityImages.
 */
export async function deleteOwnedImage(
  imageId: string,
  ownerId: string,
  opts: { kind?: ImageKind } = {},
): Promise<boolean> {
  const where = opts.kind
    ? and(eq(images.id, imageId), eq(images.ownerId, ownerId), eq(images.kind, opts.kind))
    : and(eq(images.id, imageId), eq(images.ownerId, ownerId));
  const [row] = await db().select({ path: images.path }).from(images).where(where).limit(1);
  if (!row) return false;
  await db().delete(images).where(eq(images.id, imageId));
  await fs.unlink(absoluteImagePath(row)).catch(() => undefined); // sweep reconciles stragglers
  return true;
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
  opts: { kind?: ImageKind } = {},
): Promise<number> {
  if (imageIds.length === 0) return 0;
  const where = opts.kind
    ? and(inArray(images.id, imageIds), eq(images.ownerId, ownerId), eq(images.kind, opts.kind))
    : and(inArray(images.id, imageIds), eq(images.ownerId, ownerId));
  const rows = await db().select({ path: images.path }).from(images).where(where);
  if (rows.length === 0) return 0;
  await db().delete(images).where(where);
  await Promise.all(rows.map((row) => fs.unlink(absoluteImagePath(row)).catch(() => undefined)));
  return rows.length;
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
  const where = anchorMessageIds
    ? and(eq(images.chatId, chatId), eq(images.kind, "chat_upload"), inArray(images.anchorMessageId, [...anchorMessageIds]))
    : and(eq(images.chatId, chatId), eq(images.kind, "chat_upload"));
  const rows = await db().select({ path: images.path }).from(images).where(where);
  if (rows.length === 0) return 0;
  await db().delete(images).where(where);
  await Promise.all(rows.map((row) => fs.unlink(absoluteImagePath(row)).catch(() => undefined)));
  return rows.length;
}

/**
 * Hard-delete a conversation's chat-private assets by kind (uploads, look/place
 * references — everything that must NOT survive the chat the way scenes do).
 * Files unlink best-effort; the sweep reconciles stragglers.
 */
export async function deleteChatAssets(chatId: string, kinds: readonly ImageKind[]): Promise<number> {
  if (kinds.length === 0) return 0;
  const where = and(eq(images.chatId, chatId), inArray(images.kind, [...kinds]));
  const rows = await db().select({ path: images.path }).from(images).where(where);
  if (rows.length === 0) return 0;
  await db().delete(images).where(where);
  await Promise.all(rows.map((row) => fs.unlink(absoluteImagePath(row)).catch(() => undefined)));
  return rows.length;
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
): Promise<{ id: string; path: string }[]> {
  if (imageIds.length === 0) return [];
  const rows = await db()
    .select({ id: images.id, path: images.path })
    .from(images)
    .where(
      and(
        inArray(images.id, [...imageIds]),
        eq(images.chatId, chatId),
        eq(images.kind, "chat_upload"),
        eq(images.status, "ready"),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kept = imageIds.map((id) => byId.get(id)).filter((r): r is { id: string; path: string } => r !== undefined);
  if (kept.length) {
    await db()
      .update(images)
      .set({ anchorMessageId: messageId })
      .where(inArray(images.id, kept.map((r) => r.id)));
  }
  return kept;
}

/** The file paths for a message's already-claimed attachments (regenerate/rerun re-reads). */
export async function chatAttachmentPaths(chatId: string, imageIds: readonly string[]): Promise<{ id: string; path: string }[]> {
  if (imageIds.length === 0) return [];
  const rows = await db()
    .select({ id: images.id, path: images.path })
    .from(images)
    .where(and(inArray(images.id, [...imageIds]), eq(images.chatId, chatId), eq(images.kind, "chat_upload"), eq(images.status, "ready")));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return imageIds.map((id) => byId.get(id)).filter((r): r is { id: string; path: string } => r !== undefined);
}

/**
 * Duplicate a shareable entity's ready images into a new owner's storage for a
 * clone (auth.plan.md / world-instances image policy). Each source image gets a
 * fresh row owned by `dstOwnerId`, pointed at `dstEntityId`, with the file
 * **copied** (not shared) so the clone is fully self-contained — deleting the
 * source can never strip the copy's art. `sourceImageId` records provenance.
 * Returns old→new image-id map so callers can remap avatar/cover references.
 * An image that fails to copy is skipped (degraded, never throws).
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
      ),
    );
  const idMap = new Map<string, string>();
  for (const src of rows) {
    const newImageId = newId();
    const relative = imageRelativePath(dstOwnerId, newImageId);
    try {
      const absoluteDst = path.join(dataRoot(), relative);
      await fs.mkdir(path.dirname(absoluteDst), { recursive: true });
      await fs.copyFile(absoluteImagePath(src), absoluteDst);
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
 * removed. Never throws.
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
      .select({ id: images.id, path: images.path, status: images.status, createdAt: images.createdAt })
      .from(images);
    const rows = opts.ownerId ? await baseQuery.where(eq(images.ownerId, opts.ownerId)) : await baseQuery;
    result.rowsScanned = rows.length;
    const rowPaths = new Set(rows.map((r) => r.path));

    const root = dataRoot();
    const imagesDir = opts.ownerId ? path.join(root, "images", opts.ownerId) : path.join(root, "images");
    let entries: Array<{ parentPath: string; name: string; isFile(): boolean }> = [];
    try {
      entries = await fs.readdir(imagesDir, { recursive: true, withFileTypes: true });
    } catch {
      // no data directory yet — nothing on the files side
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      result.filesScanned += 1;
      const absolute = path.join(entry.parentPath, entry.name);
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
          const exists = await fileExists(path.join(root, row.path));
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
