import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, images } from "../db";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
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
 *
 * `extraMeta` is the producer's contribution to the row's meta (the render
 * provenance under `render`), merged in the SAME update as the file facts so
 * the row never says "ready" without it. The file facts win a key collision —
 * width/height/bytes describe the file that actually landed.
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
      .set({ status: "ready", bytes: info.bytes, meta: mergeMeta(row.meta, { ...(extraMeta ?? {}), ...info }) })
      .where(eq(images.id, imageId))
      .returning();
    return updated ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink?.push(diag("error", "images.save_failed", message.slice(0, 300), { context: { imageId } }));
    return failImage(imageId, message, extraMeta);
  }
}

/** The asset classes the Gallery hub may act on (list / favorite / delete). */
export const GALLERY_IMAGE_KINDS = ["scene", "portrait_variant", "entity"] as const satisfies readonly ImageKind[];

/**
 * Kinds that are INTERNAL operational assets, never user-visible ones: the
 * identity face crop, the identity-trial render output, the
 * Advanced Image Lab's control fixtures and experiment renders, the Image
 * Generator's run outputs, and a character's reference views.
 * Their owner may read one — the crop editor, the trial review UI, the lab's
 * fixtures panel and the studio's reference-view grid have to display them — but
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
] as const satisfies readonly ImageKind[];

/**
 * `extraMeta` rides the same update as the error text; the error wins a collision.
 *
 * `failedAt` is stamped here because `created_at` is when the row was RESERVED,
 * not when it failed — a row that was `ready` for a month before its file
 * vanished fails today. Retention reads this stamp
 * (`planFailedImageRetirement` in asset-maintenance.ts), so writing it at the one choke point every
 * failure passes through is what keeps that clock honest.
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
      meta: mergeMeta(row?.meta, {
        ...(extraMeta ?? {}),
        error: error.slice(0, 500),
        failedAt: new Date().toISOString(),
      }),
    })
    .where(eq(images.id, imageId))
    .returning();
  return updated ?? null;
}
