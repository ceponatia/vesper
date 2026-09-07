import sharp from "sharp";
import { AVATAR_HEIGHT, AVATAR_WIDTH } from "@vesper/image-core";
import { REFERENCE_VIEW_GENERATION_VERSION, type ReferenceView, type ReferenceViewSummary } from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { createImageAsset, failImage, saveImageBuffer, SHARP_DECODE_LIMITS } from "./asset-storage";
import { decodeDataUrl } from "./upload";
import {
  finalizeReferenceView,
  getReferenceViewSummary,
  readAcceptedPortraitSource,
  reserveReferenceView,
} from "./reference-view-store";

/**
 * The owner's own answer for one slot.
 *
 * The build is a probe: an edit model asked to rotate a person may or may not
 * bring the same person back, and where it does not, the honest fallback is the
 * owner supplying the view themselves — a photograph, a render made elsewhere, a
 * drawing. So an upload is not a workaround bolted on beside the render path; it
 * is the second of the two ways a slot is ever filled, and it produces exactly
 * the same row.
 *
 * Two things differ from a rendered view, and both follow from who made it:
 * `method` is `uploaded`, and the row arrives **already reviewed** — an owner
 * who supplies a view has, by supplying it, performed the review the render path
 * asks them for.
 *
 * Synchronous and free: no model runs, so this works in demo mode and offline,
 * and it charges no render budget. The bytes are hidden
 * (`HIDDEN_IMAGE_KINDS`), so they consume no storage quota either.
 */

/** Decoded-size cap, the avatar upload's number for the avatar upload's reason. */
const MAX_DECODED_BYTES = 4 * 1024 * 1024;

export interface UploadReferenceViewInput {
  characterId: string;
  ownerId: string;
  view: ReferenceView;
  /** A `data:image/...;base64,...` URL from the studio's file pick. */
  dataUrl: string;
  sink?: DiagnosticSink;
}

export type UploadReferenceViewResult =
  | { status: "uploaded"; view: ReferenceViewSummary }
  /** Nothing accepted, so nothing to hang the view off — the same precondition the build has. */
  | { status: "not_accepted" }
  | { status: "not_found" }
  | { status: "rejected"; error: string };

/**
 * Store an owner-supplied view for one slot, superseding whatever was current.
 *
 * The decode runs under the SAME guards as the avatar upload — raster mime
 * allow-list (so `image/svg+xml` never reaches librsvg), a decoded-byte cap
 * checked before the buffer is materialized, `SHARP_DECODE_LIMITS`, EXIF
 * rotation, and a cover-fit to the canonical 3:4 portrait. The client is not
 * trusted to have cropped: `cover` guarantees the stored dimensions whatever
 * arrives.
 */
export async function uploadReferenceView(input: UploadReferenceViewInput): Promise<UploadReferenceViewResult> {
  const decoded = decodeDataUrl(input.dataUrl);
  if (!decoded) {
    input.sink?.push(diag("warn", "images.reference_views.bad_data_url", "the uploaded view was not a valid image data URL"));
    return { status: "rejected", error: "that file is not a valid image" };
  }
  if (decoded.buffer.byteLength > MAX_DECODED_BYTES) {
    return { status: "rejected", error: "that image is too large" };
  }

  // A view is a view OF the accepted portrait's person. Without an accepted
  // portrait there is nothing for `source_image_id` to name, and a row with a
  // null source is one the projection would immediately call stale.
  const source = await readAcceptedPortraitSource(input.characterId, input.ownerId);
  if (!source.ok) {
    if (source.reason === "not_found") return { status: "not_found" };
    return { status: "not_accepted" };
  }

  const asset = await createImageAsset({
    ownerId: input.ownerId,
    kind: "reference_view",
    entityKind: "character",
    entityId: input.characterId,
    prompt: "Uploaded reference view",
    sourceImageId: source.imageId,
    meta: {
      source: "upload",
      mime: decoded.mime,
      referenceView: {
        angle: input.view.angle,
        wardrobe: input.view.wardrobe,
        generationVersion: REFERENCE_VIEW_GENERATION_VERSION,
      },
    },
  });

  let buffer: Buffer;
  try {
    buffer = await sharp(decoded.buffer, SHARP_DECODE_LIMITS)
      .rotate() // honor EXIF orientation before fitting
      .resize(AVATAR_WIDTH, AVATAR_HEIGHT, { fit: "cover", position: "centre" })
      .toBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failImage(asset.id, message);
    input.sink?.push(
      diag("warn", "images.reference_views.decode_failed", message.slice(0, 300), { context: { imageId: asset.id } }),
    );
    return { status: "rejected", error: "could not read that image — try a different file" };
  }

  const saved = await saveImageBuffer(asset.id, buffer, input.sink);
  if (saved?.status !== "ready") return { status: "rejected", error: "failed to save that image" };

  // Reserved only once the bytes are on disk: a decode that fails must not leave
  // the slot holding a pending row nothing will ever settle.
  const viewId = await reserveReferenceView({
    characterId: input.characterId,
    view: input.view,
    sourceImageId: source.imageId,
    sourceContentHash: source.contentHash,
  });
  await finalizeReferenceView({
    viewId,
    characterId: input.characterId,
    ownerId: input.ownerId,
    imageId: asset.id,
    method: "uploaded",
    reviewedByUserId: input.ownerId,
  });

  return {
    status: "uploaded",
    view: await getReferenceViewSummary(input.characterId, input.ownerId, input.view, input.sink),
  };
}
