import type { NextRequest } from "next/server";
import { z } from "zod";
import { imageLabUploadControlRequestSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, uploadRejection, withOwnerAdmin } from "@/server/api";
import { decodeDataUrl, listImageLabControls, uploadImageLabControl } from "@/server/images";

/**
 * The Advanced Image Lab's control fixtures — the pose skeletons, depth maps and
 * edge maps experiments are run against.
 *
 * The upload body is the contract's own request schema plus the transport field
 * it deliberately does not carry: bytes are not contract material, so
 * `imageLabUploadControlRequestSchema` describes the metadata beside a drawing
 * and this route adds the drawing. The 3 MB string cap matches the avatar
 * upload's — the decoded byte cap is enforced independently inside
 * `decodeDataUrl`, which also refuses any mime off the raster allow-list so no
 * vector renderer is ever reached.
 */
const uploadBodySchema = imageLabUploadControlRequestSchema.extend({
  dataUrl: z
    .string()
    .min(1)
    .max(3_000_000)
    .refine((value) => value.startsWith("data:image/"), "dataUrl must be an image data URL"),
});

/** Every fixture this admin owns, newest first — ids and metadata, no bytes. */
export const GET = withOwnerAdmin(async (user) => jsonOk({ controls: await listImageLabControls(user.id) }));

/**
 * Store a hand-drawn fixture.
 *
 * Synchronous: no model runs, so the stored fixture comes back in the response
 * and the panel refetches immediately. The generator is always `hand_authored`
 * — the request cannot name its own provenance, because provenance is exactly
 * what a disputed probe verdict is re-examined against.
 */
export const POST = withOwnerAdmin(async (user, req: NextRequest) => {
  const body = await readBody(req, uploadBodySchema);
  if (!body.ok) return body.response;

  const blocked = await uploadRejection(user, req, body.value.dataUrl);
  if (blocked) return blocked;

  const decoded = decodeDataUrl(body.value.dataUrl);
  if (!decoded) return jsonError("bad_request", "that file is not a valid image", 400);

  const result = await uploadImageLabControl({
    ownerId: user.id,
    controlKind: body.value.controlKind,
    buffer: decoded.buffer,
    ...(body.value.sourceImageId ? { sourceImageId: body.value.sourceImageId } : {}),
    ...(body.value.note ? { note: body.value.note } : {}),
  });
  if (!result.ok) return jsonError("bad_request", result.error, 400);
  return jsonOk({ control: result.control }, 201);
});
