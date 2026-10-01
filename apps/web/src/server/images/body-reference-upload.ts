import sharp from "sharp";
import { AVATAR_HEIGHT, AVATAR_WIDTH } from "@vesper/image-core";
import type { BodyReferenceSlot, BodyReferenceTag } from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { log } from "@/server/log";
import { createImageAsset, saveImageBuffer, SHARP_DECODE_LIMITS } from "./asset-storage";
import { deleteOwnedImage } from "./asset-deletion";
import { decodeDataUrl } from "./upload";
import { readBodyReferenceEligibility } from "./body-reference-store";
import { installBodyReference, type BodyReferenceWriteResult } from "./body-reference-writes";
import { referenceViewBuildLive } from "./reference-view-store";

/**
 * An owner-supplied full-body image for one body-reference slot (#671).
 *
 * The reference-view upload's path, for its reasons (`reference-view-upload.ts`):
 * the same decode guards, the same 3:4 cover-fit the studio's crop dialog
 * previews, row-before-file, and an install that rechecks the slot under the
 * character lock after the bytes are processed, so a refused install removes
 * only its own unclaimed asset. Synchronous and free — no model runs, nothing
 * is charged, and the bytes are a hidden kind outside the storage quota.
 *
 * Setting an image is not an approval step: an installed image is in use, the
 * reference views read stale against it, and nothing rebuilds until the owner
 * asks.
 */

/** Decoded-size cap, the avatar upload's number for the avatar upload's reason. */
const MAX_DECODED_BYTES = 4 * 1024 * 1024;

export interface UploadBodyReferenceInput {
  characterId: string;
  ownerId: string;
  slot: BodyReferenceSlot;
  tag: BodyReferenceTag;
  /** The image the owner saw in the slot, or null for an empty one. */
  expectedImageId: string | null;
  /** A `data:image/...;base64,...` URL from the crop dialog. */
  dataUrl: string;
  sink?: DiagnosticSink;
}

export type UploadBodyReferenceResult = BodyReferenceWriteResult | { status: "rejected"; error: string };

export async function uploadBodyReference(input: UploadBodyReferenceInput): Promise<UploadBodyReferenceResult> {
  const decoded = decodeDataUrl(input.dataUrl);
  if (!decoded) {
    input.sink?.push(diag("warn", "images.body_references.bad_data_url", "the uploaded body image was not a valid image data URL"));
    return { status: "rejected", error: "that file is not a valid image" };
  }
  if (decoded.buffer.byteLength > MAX_DECODED_BYTES) return { status: "rejected", error: "that image is too large" };

  // Cheap refusals before any bytes are processed. The install repeats all
  // three under the character lock; these only spare a decode nobody can use.
  const eligibility = await readBodyReferenceEligibility(input.characterId, input.ownerId, input.sink);
  if (eligibility === undefined) return { status: "not_found" };
  if (await referenceViewBuildLive(input.characterId, input.ownerId)) return { status: "busy" };
  if (input.tag === "unclothed" && !eligibility.unclothedAllowed) return { status: "ineligible" };

  const asset = await createImageAsset({
    ownerId: input.ownerId,
    kind: "body_reference",
    entityKind: "character",
    entityId: input.characterId,
    prompt: "Uploaded body reference",
    meta: { source: "upload", mime: decoded.mime },
  });

  let buffer: Buffer;
  try {
    buffer = await sharp(decoded.buffer, SHARP_DECODE_LIMITS)
      .rotate() // honor EXIF orientation before fitting
      .resize(AVATAR_WIDTH, AVATAR_HEIGHT, { fit: "cover", position: "centre" })
      .toBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.sink?.push(diag("warn", "images.body_references.decode_failed", message.slice(0, 300), { context: { imageId: asset.id } }));
    await discard(asset.id, input.ownerId);
    return { status: "rejected", error: "could not read that image — try a different file" };
  }

  const saved = await saveImageBuffer(asset.id, buffer, input.sink);
  if (saved?.status !== "ready") {
    await discard(asset.id, input.ownerId);
    return { status: "rejected", error: "failed to save that image" };
  }

  let installed = false;
  try {
    const result = await installBodyReference({
      characterId: input.characterId,
      ownerId: input.ownerId,
      slot: input.slot,
      imageId: asset.id,
      tag: input.tag,
      expectedImageId: input.expectedImageId,
    });
    installed = result.status === "written";
    return result;
  } finally {
    // A refused install retired nothing; only this upload's unclaimed asset goes.
    if (!installed) await discard(asset.id, input.ownerId);
  }
}

async function discard(imageId: string, ownerId: string): Promise<void> {
  try {
    await deleteOwnedImage(imageId, ownerId, { kind: "body_reference" });
  } catch (error) {
    log.warn("images", "unused body reference upload cleanup failed", { imageId, error: String(error).slice(0, 300) });
  }
}
