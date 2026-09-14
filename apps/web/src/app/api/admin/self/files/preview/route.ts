import { Readable } from "node:stream";
import { mediaPreviewType } from "@/lib/media-preview";
import { jsonError, withOwnerAdmin } from "@/server/api";
import {
  AdminFilesError,
  getAdminFileDownload,
  inlineDispositionHeader,
  parseMediaRange,
  type AdminFileDownload,
} from "@/server/admin-files";

export const runtime = "nodejs";

function expectedError(error: unknown): Response {
  if (error instanceof AdminFilesError) return jsonError(error.code, error.message, error.status);
  throw error;
}

/**
 * A refusal still carries `nosniff`. It is what makes the extension allowlist
 * sufficient rather than hopeful, so it is a property of the route rather than
 * of its success path — a response that omitted it would be the one place a
 * body could be reinterpreted as a document.
 */
function refusal(code: string, message: string, status: number): Response {
  const response = jsonError(code, message, status);
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

/** Only a streamed response owns the descriptor; every refusal hands it back. */
async function release(file: AdminFileDownload): Promise<void> {
  await file.handle.close().catch(() => undefined);
}

function previewHeaders(file: AdminFileDownload, contentType: string, length: number): Headers {
  return new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": inlineDispositionHeader(file.name),
    "Content-Length": String(length),
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
}

function streamed(stream: Readable, status: number, headers: Headers): Response {
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers });
}

/**
 * Serve one managed file inline, with the real content type its extension
 * allows, so an image can fill the lightbox and a video or audio file can play
 * in place. `/api/admin/self/files/download` is untouched and stays the only
 * door for everything else: it keeps answering `application/octet-stream` as an
 * attachment, including for every file this route refuses.
 *
 * The file is opened through `getAdminFileDownload`, the same function the
 * download route uses, so this route inherits path containment, the `O_NOFOLLOW`
 * symlink refusal, and the open-then-stat-the-descriptor discipline. That last
 * one is what makes the range arithmetic trustworthy: the size the window is
 * computed against and the bytes the stream reads come from one descriptor, so
 * a concurrent replace cannot make `Content-Range` describe one inode while the
 * body comes from another, and no offset can address anything outside it.
 *
 * The allowlist is consulted on the name the server resolved rather than on the
 * query string, so the type served and the file opened can never be decided
 * from two different readings of a path. It lives in `@/lib/media-preview`
 * rather than here because the Files page asks the same question to decide
 * whether a row opens in the lightbox, and one list cannot drift from itself.
 */
export const GET = withOwnerAdmin(async (_user, req) => {
  const relativePath = req.nextUrl.searchParams.get("path") ?? "";
  let file: AdminFileDownload | null = null;
  try {
    file = await getAdminFileDownload(relativePath);

    const media = mediaPreviewType(file.name);
    if (media === null) {
      await release(file);
      file = null;
      return refusal("unsupported_media_type", "this file type cannot be previewed; download it instead", 415);
    }

    const range = parseMediaRange(req.headers.get("range"), file.size);
    if (range.kind === "unsatisfiable") {
      const { size } = file;
      await release(file);
      file = null;
      const response = refusal("range_not_satisfiable", "the requested range lies outside this file", 416);
      response.headers.set("Accept-Ranges", "bytes");
      response.headers.set("Content-Range", `bytes */${size}`);
      return response;
    }

    // FileHandle.createReadStream owns the handle from here and closes it when
    // the stream ends, errors, or is destroyed — which includes the client
    // abort a seeking player performs constantly, since cancelling the web
    // stream destroys the readable beneath it.
    if (range.kind === "bounded") {
      const headers = previewHeaders(file, media.contentType, range.end - range.start + 1);
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
      return streamed(file.handle.createReadStream({ start: range.start, end: range.end }), 206, headers);
    }
    return streamed(file.handle.createReadStream(), 200, previewHeaders(file, media.contentType, file.size));
  } catch (error) {
    if (file !== null) await release(file);
    return expectedError(error);
  }
});
