import type { NextRequest } from "next/server";
import { imageGeneratorUploadRequestSchema } from "@/contracts/images/image-generator-upload";
import { jsonError, jsonOk, readBody, uploadRejection, withOwnerAdmin } from "@/server/api";
import { listImageGeneratorUploads, uploadImageGeneratorReference } from "@/server/images";

/**
 * Every reference/control image this admin uploaded directly to the bench —
 * never a run's own output (#635). Ids and metadata only, no bytes; the panel
 * reads pixels through the ordinary owner-scoped file route.
 */
export const GET = withOwnerAdmin(async (user) => jsonOk({ uploads: await listImageGeneratorUploads(user.id) }));

/**
 * Store one owner-supplied raster for use as an Image Generator reference or
 * dedicated structural input. Synchronous: no provider work is started, so the
 * image id comes back ready for the form to select immediately.
 */
export const POST = withOwnerAdmin(async (user, req: NextRequest) => {
  const body = await readBody(req, imageGeneratorUploadRequestSchema);
  if (!body.ok) return body.response;

  const blocked = await uploadRejection(user, req, body.value.dataUrl);
  if (blocked) return blocked;

  const result = await uploadImageGeneratorReference({
    userId: user.id,
    dataUrl: body.value.dataUrl,
    ...(body.value.fileName ? { fileName: body.value.fileName } : {}),
  });
  if (!result.ok) return jsonError("bad_request", result.error, 400);
  return jsonOk({ imageId: result.imageId }, 201);
});
