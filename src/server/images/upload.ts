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

/** Permissive cap: the client sends a cropped ~768×1024 image, never a raw photo. */
const MAX_DECODED_BYTES = 12 * 1024 * 1024;

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
    buffer = await sharp(decoded.buffer)
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

interface DecodedImage {
  buffer: Buffer;
  mime: string;
}

/** Parse a `data:<mime>;base64,<payload>` URL with an image mime; null otherwise. */
function decodeDataUrl(dataUrl: string): DecodedImage | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  const mime = match?.[1];
  const payload = match?.[2];
  if (!mime || !payload) return null;
  try {
    const buffer = Buffer.from(payload, "base64");
    if (buffer.byteLength === 0) return null;
    return { buffer, mime: mime.toLowerCase() };
  } catch {
    return null;
  }
}
