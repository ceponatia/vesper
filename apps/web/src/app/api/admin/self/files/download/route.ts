import { Readable } from "node:stream";
import { jsonError, withOwnerAdmin } from "@/server/api";
import { AdminFilesError, getAdminFileDownload } from "@/server/admin-files";

export const runtime = "nodejs";

function expectedError(error: unknown): Response {
  if (error instanceof AdminFilesError) return jsonError(error.code, error.message, error.status);
  throw error;
}

function dispositionFilename(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_") || "download";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export const GET = withOwnerAdmin(async (_user, req) => {
  const relativePath = req.nextUrl.searchParams.get("path") ?? "";
  let file: Awaited<ReturnType<typeof getAdminFileDownload>> | null = null;
  try {
    // getAdminFileDownload opens first and stats that descriptor. The stream is
    // created from the same handle, so a concurrent delete/replace after this
    // point cannot make Content-Length describe one inode while bytes come from
    // another. FileHandle.createReadStream owns/closes the handle on completion.
    file = await getAdminFileDownload(relativePath);
    const stream = Readable.toWeb(file.handle.createReadStream()) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": dispositionFilename(file.name),
        "Content-Length": String(file.size),
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (file !== null) await file.handle.close().catch(() => undefined);
    return expectedError(error);
  }
});
