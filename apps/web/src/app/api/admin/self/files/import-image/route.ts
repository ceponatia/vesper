import path from "node:path";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { AdminFilesError, getAdminFileDownload } from "@/server/admin-files";
import { IMAGE_REFERENCE_MAX_SOURCE_BYTES, importAdminFilesImageReference } from "@/server/images";

export const runtime = "nodejs";

const importRequestSchema = z.object({
  path: z.string().min(1).max(4096),
});

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);

function expectedError(error: unknown): Response {
  if (error instanceof AdminFilesError) return jsonError(error.code, error.message, error.status);
  throw error;
}

/**
 * Import one owner-admin Files raster into the ordinary owner-scoped image
 * registry. The Files path is a source locator for this one operation only:
 * Generator/Lab requests receive the returned image id and never learn how the
 * bytes were originally stored.
 */
export const POST = withOwnerAdmin(async (user, req) => {
  const body = await readBody(req, importRequestSchema);
  if (!body.ok) return body.response;

  let file: Awaited<ReturnType<typeof getAdminFileDownload>> | null = null;
  try {
    file = await getAdminFileDownload(body.value.path);
    if (!SUPPORTED_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
      return jsonError("unsupported_image", "Choose a PNG, JPEG, WebP, or AVIF image from Files.", 400);
    }
    if (file.size > IMAGE_REFERENCE_MAX_SOURCE_BYTES) {
      return jsonError("image_too_large", "That image is too large to use as a reference.", 400);
    }

    const buffer = await file.handle.readFile();
    const result = await importAdminFilesImageReference({
      userId: user.id,
      buffer,
      fileName: file.name,
      adminFilePath: body.value.path,
    });
    if (!result.ok) return jsonError("bad_request", result.error, 400);
    return jsonOk({ imageId: result.imageId }, 201);
  } catch (error) {
    return expectedError(error);
  } finally {
    await file?.handle.close().catch(() => undefined);
  }
});
