import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { characters, db } from "../db";
import { logEvent } from "../events";
import { AVATAR_HEIGHT, AVATAR_WIDTH } from "@/lib/images/crop";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { createImageAsset, failImage, saveImageBuffer } from "./assets";
import { promoteVariant } from "./variants";

export interface UploadAvatarInput {
  characterId: string;
  userId: string;
  /** A `data:image/...;base64,...` URL produced by the crop dialog's canvas. */
  dataUrl: string;
  sink?: DiagnosticSink;
}

export type UploadAvatarResult = { ok: true; avatarImageId: string } | { ok: false; error: string };

/**
 * Decoded-size cap: legit cropped avatar JPEGs are <1 MB; 4 MB is generous
 * headroom while still rejecting decompression bombs before they materialize.
 * (The route-level data-URL string cap is lower still, set independently.)
 */
const MAX_DECODED_BYTES = 4 * 1024 * 1024;

/**
 * Raster formats sharp can safely rasterize without invoking a vector renderer.
 * Anything else (notably `image/svg+xml`, which reaches librsvg) is rejected at
 * decode so it never touches sharp.
 */
const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);

/**
 * Decode guards passed to every sharp call on untrusted input: cap the pixel
 * count (a ~1 MB bomb expands to 100+ MP; 40 MP ≈ 6300×6300 dwarfs any real
 * avatar), fail on any decode error, and never expand animation frames.
 */
const SHARP_DECODE_LIMITS = { limitInputPixels: 40_000_000, failOn: "error", animated: false } as const;

/**
 * User-supplied avatar (docs/images.md): decode the cropped data URL, re-fit it
 * to the canonical 3:4 portrait (defense in depth — the client already cropped,
 * but `cover` guarantees the stored dimensions and `rotate()` honors EXIF),
 * save through the normal row-before-file path, then promote to the character's
 * canonical avatar. No model runs, so this works in demo mode and offline.
 */
export async function uploadAvatar(input: UploadAvatarInput): Promise<UploadAvatarResult> {
  const decoded = decodeDataUrl(input.dataUrl);
  if (!decoded) {
    input.sink?.push(diag("warn", "images.upload.bad_data_url", "uploaded image was not a valid image data URL"));
    return { ok: false, error: "uploaded file is not a valid image" };
  }
  if (decoded.buffer.byteLength > MAX_DECODED_BYTES) {
    return { ok: false, error: "uploaded image is too large" };
  }

  // Ownership is checked by the route; this guards a deleted/renamed row mid-flight.
  const [character] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, input.characterId), eq(characters.ownerId, input.userId)))
    .limit(1);
  if (!character) return { ok: false, error: "character not found" };

  const asset = await createImageAsset({
    ownerId: input.userId,
    kind: "avatar",
    entityKind: "character",
    entityId: input.characterId,
    prompt: "Uploaded image",
    meta: { source: "upload", mime: decoded.mime },
  });

  const started = Date.now();
  let buffer: Buffer;
  try {
    buffer = await sharp(decoded.buffer, SHARP_DECODE_LIMITS)
      .rotate() // honor EXIF orientation before cropping
      .resize(AVATAR_WIDTH, AVATAR_HEIGHT, { fit: "cover", position: "centre" })
      .toBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failImage(asset.id, message);
    input.sink?.push(diag("warn", "images.upload.decode_failed", message.slice(0, 300), { context: { imageId: asset.id } }));
    return { ok: false, error: "could not read that image — try a different file" };
  }

  const saved = await saveImageBuffer(asset.id, buffer, input.sink);
  void logEvent(null, "image.avatar", {
    imageId: asset.id,
    characterId: input.characterId,
    status: saved?.status ?? "failed",
    source: "upload",
    durationMs: Date.now() - started,
  });
  if (saved?.status !== "ready") return { ok: false, error: "failed to save the uploaded image" };

  const promoted = await promoteVariant(input.characterId, asset.id);
  if (!promoted.ok) return { ok: false, error: promoted.error ?? "failed to set the avatar" };
  return { ok: true, avatarImageId: asset.id };
}

export interface UploadChatAttachmentInput {
  chatId: string;
  userId: string;
  /** A `data:image/...;base64,...` URL from the composer's file pick. */
  dataUrl: string;
  sink?: DiagnosticSink;
}

export type UploadChatAttachmentResult = { ok: true; imageId: string } | { ok: false; error: string };

/** Longest-side cap for stored chat attachments — plenty for a vision read + a transcript thumb. */
const CHAT_ATTACHMENT_MAX_DIM = 1280;

/**
 * Player-attached chat photo (chat-image-input.plan.md): decode with the same
 * bomb guards as the avatar upload, fit INSIDE a bounded box (aspect kept —
 * this is a photo to look at, not a portrait crop), honor EXIF, and save
 * through the normal row-before-file path as `kind: "chat_upload"`, chat-keyed.
 * `anchor_message_id` is stamped later, when the message that carries it sends.
 * No model runs here — the vision read happens at exchange time.
 */
export async function uploadChatAttachment(input: UploadChatAttachmentInput): Promise<UploadChatAttachmentResult> {
  const decoded = decodeDataUrl(input.dataUrl);
  if (!decoded) {
    input.sink?.push(diag("warn", "images.upload.bad_data_url", "attached image was not a valid image data URL"));
    return { ok: false, error: "attached file is not a valid image" };
  }
  if (decoded.buffer.byteLength > MAX_DECODED_BYTES) {
    return { ok: false, error: "attached image is too large" };
  }

  const asset = await createImageAsset({
    ownerId: input.userId,
    kind: "chat_upload",
    chatId: input.chatId,
    prompt: "Player-attached chat photo",
    meta: { source: "upload", mime: decoded.mime },
  });

  let buffer: Buffer;
  try {
    buffer = await sharp(decoded.buffer, SHARP_DECODE_LIMITS)
      .rotate() // honor EXIF orientation
      .resize(CHAT_ATTACHMENT_MAX_DIM, CHAT_ATTACHMENT_MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .toBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failImage(asset.id, message);
    input.sink?.push(diag("warn", "images.upload.decode_failed", message.slice(0, 300), { context: { imageId: asset.id } }));
    return { ok: false, error: "could not read that image — try a different file" };
  }

  const saved = await saveImageBuffer(asset.id, buffer, input.sink);
  if (saved?.status !== "ready") return { ok: false, error: "failed to save the attached image" };
  return { ok: true, imageId: asset.id };
}

interface DecodedImage {
  buffer: Buffer;
  mime: string;
}

/**
 * Parse a `data:<mime>;base64,<payload>` URL; null otherwise. The mime must be
 * on the raster allow-list (no SVG → no librsvg), and the decoded size is
 * estimated from the base64 length and rejected over the cap *before* the
 * buffer is materialized, so a bomb is never allocated. The post-decode
 * `byteLength` check on the caller is kept as defense in depth.
 */
export function decodeDataUrl(dataUrl: string): DecodedImage | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  const rawMime = match?.[1];
  const payload = match?.[2];
  if (!rawMime || !payload) return null;
  const mime = rawMime.toLowerCase();
  if (!ALLOWED_MIMES.has(mime)) return null;
  if (estimatedBase64Bytes(payload) > MAX_DECODED_BYTES) return null;
  try {
    const buffer = Buffer.from(payload, "base64");
    if (buffer.byteLength === 0) return null;
    return { buffer, mime };
  } catch {
    return null;
  }
}

/**
 * Decoded byte count of a base64 payload without allocating it: 3 bytes per
 * 4 chars, minus one per `=` pad. Whitespace is stripped first (the regex
 * permits it inside the payload).
 */
function estimatedBase64Bytes(payload: string): number {
  const compact = payload.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}
