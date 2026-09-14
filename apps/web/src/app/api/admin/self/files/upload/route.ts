import { jsonError, jsonOk, withOwnerAdmin } from "@/server/api";
import { AdminFilesError, uploadAdminFile } from "@/server/admin-files";

export const runtime = "nodejs";

function expectedError(error: unknown): Response {
  if (error instanceof AdminFilesError) return jsonError(error.code, error.message, error.status);
  throw error;
}

export const PUT = withOwnerAdmin(async (_user, req) => {
  const directory = req.nextUrl.searchParams.get("path") ?? "";
  const name = req.nextUrl.searchParams.get("name") ?? "";
  const overwrite = req.nextUrl.searchParams.get("overwrite") === "1";

  const contentEncoding = req.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    return jsonError(
      "unsupported_content_encoding",
      "compressed uploads are not supported because Files preserves the uploaded bytes exactly",
      415,
    );
  }

  try {
    // Deliberately pass the request stream through untouched. Unlike readBody(),
    // this route never buffers the whole upload and has no Vesper-defined size
    // cap; the practical ceiling is the browser/proxy/volume infrastructure.
    const entry = await uploadAdminFile(directory, name, req.body, overwrite);
    return jsonOk({ entry }, 201);
  } catch (error) {
    return expectedError(error);
  }
});
