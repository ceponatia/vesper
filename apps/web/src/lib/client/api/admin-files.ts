import { z } from "zod";
import { apiGet, apiPost, toApiError, withQuery, type ApiResult } from "./http";

export const adminFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "folder"]),
  size: z.number().nullable(),
  modifiedAt: z.string(),
});
export type AdminFileEntry = z.infer<typeof adminFileEntrySchema>;

const adminFileListSchema = z.object({
  path: z.string(),
  entries: z.array(adminFileEntrySchema),
});
export type AdminFileList = z.infer<typeof adminFileListSchema>;

const adminFileEntryEnvelopeSchema = z.object({ entry: adminFileEntrySchema });
const adminFileImageImportSchema = z.object({ imageId: z.string().min(1) });

/** One path a partial-success batch operation could not act on. */
export const adminFileFailureSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});
export type AdminFileFailure = z.infer<typeof adminFileFailureSchema>;

const adminFileDeleteManySchema = z.object({
  deleted: z.number().catch(0),
  failures: z.array(adminFileFailureSchema).catch([]),
});

const adminFileDeletePreviewSchema = z.object({
  files: z.number().catch(0),
  folders: z.number().catch(0),
  bytes: z.number().catch(0),
  truncated: z.boolean().catch(false),
});

const adminFileMoveSchema = z.object({
  moved: z.number().catch(0),
  entries: z.array(adminFileEntrySchema).catch([]),
  failures: z.array(adminFileFailureSchema).catch([]),
});

export interface AdminFileUploadProgress {
  loaded: number;
  total: number;
}

interface UploadOptions {
  path: string;
  file: File;
  overwrite?: boolean;
  onProgress?: (progress: AdminFileUploadProgress) => void;
}

function uploadAdminFile(options: UploadOptions): Promise<ApiResult<{ entry: AdminFileEntry }>> {
  const url = withQuery("/api/admin/self/files/upload", {
    path: options.path,
    name: options.file.name,
    overwrite: options.overwrite ? 1 : undefined,
  });

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      options.onProgress?.({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : options.file.size,
      });
    };
    xhr.onerror = () => {
      resolve({
        ok: false,
        error: {
          status: 0,
          code: "network_error",
          message: "Upload failed before Vesper returned a response",
        },
      });
    };
    xhr.onload = () => {
      let raw: unknown = null;
      try {
        raw = JSON.parse(xhr.responseText) as unknown;
      } catch {
        raw = null;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        resolve({ ok: false, error: { ...toApiError(xhr.status, raw), body: raw } });
        return;
      }

      const parsed = adminFileEntryEnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        resolve({
          ok: false,
          error: {
            status: xhr.status,
            code: "client.response_shape",
            message: "Unexpected upload response shape",
          },
        });
        return;
      }
      resolve({ ok: true, data: parsed.data });
    };
    xhr.send(options.file);
  });
}

/**
 * The server's own per-request ceiling — `pathsSchema` in
 * apps/web/src/app/api/admin/self/files/route.ts is
 * `z.array(pathSchema).min(1).max(500)`, since every path in a batch request
 * is walked while the whole request holds the mutation lock.
 *
 * Directory listing itself is unpaginated, so a folder with 501+ entries lets
 * select-all build a selection past this ceiling — every bulk call then
 * refused the whole request with `invalid_body`. Chunking the requests below
 * (never capping the selection, which would silently act on only part of
 * what the owner picked) is the fix.
 */
const ADMIN_FILES_BATCH_LIMIT = 500;

/**
 * Turns the remainder of a chunked batch into failure rows.
 *
 * A chunk that fails at the transport layer cannot un-delete the chunks before
 * it. Returning the bare error there reported `deleted: 0` for a selection that
 * was already five hundred smaller — the same disagreement between the count
 * and the filesystem that the server goes to lengths to avoid. The paths that
 * did not happen are reported as what they are, and the count stays truthful.
 */
function unattemptedFailures(
  paths: readonly string[],
  from: number,
  error: { code: string; message: string },
): AdminFileFailure[] {
  return paths.slice(from).map((path) => ({ path, code: error.code, message: error.message }));
}

export function chunkPaths<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export const adminFilesApi = {
  list: (path: string) => apiGet(adminFileListSchema, withQuery("/api/admin/self/files", { path })),
  createFolder: (path: string, name: string) =>
    apiPost(adminFileEntryEnvelopeSchema, "/api/admin/self/files", {
      action: "create_folder",
      path,
      name,
    }),
  rename: (path: string, name: string) =>
    apiPost(adminFileEntryEnvelopeSchema, "/api/admin/self/files", {
      action: "rename",
      path,
      name,
    }),
  /** Import one Files raster into the ordinary owner-scoped image registry. */
  importImage: (path: string) =>
    apiPost(adminFileImageImportSchema, "/api/admin/self/files/import-image", { path }),
  /**
   * Hard-deletes one or more entries in a single confirmed action. `recursive`
   * must be sent explicitly — never implicitly — when the selection contains
   * a folder; the server's non-empty-folder refusal only lifts then. Route a
   * single-row delete through this with one path too, so that door cannot
   * drift from the multi-row one (the `image-generator-run-list.tsx` convention).
   *
   * Sent as successive batches of at most `ADMIN_FILES_BATCH_LIMIT` paths
   * when the selection is larger than that — see `chunkPaths` above.
   * `deleted` sums across batches and `failures` concatenates, so one
   * oversized selection still reads as the single action the owner took.
   */
  deleteMany: async (paths: string[], recursive?: boolean): Promise<ApiResult<{ deleted: number; failures: AdminFileFailure[] }>> => {
    let deleted = 0;
    let attempted = 0;
    const failures: AdminFileFailure[] = [];
    for (const batch of chunkPaths(paths, ADMIN_FILES_BATCH_LIMIT)) {
      const result = await apiPost(adminFileDeleteManySchema, "/api/admin/self/files", {
        action: "delete_many",
        paths: batch,
        recursive,
      });
      if (!result.ok) {
        return { ok: true, data: { deleted, failures: [...failures, ...unattemptedFailures(paths, attempted, result.error)] } };
      }
      deleted += result.data.deleted;
      attempted += batch.length;
      failures.push(...result.data.failures);
    }
    return { ok: true, data: { deleted, failures } };
  },
  /**
   * Counts what a `deleteMany` of these paths would remove, for the
   * confirmation's title. Chunked and combined the same way as `deleteMany`
   * (see there): the counts sum across batches, and `truncated` is true if
   * any one batch's was.
   */
  deletePreview: async (
    paths: string[],
  ): Promise<ApiResult<{ files: number; folders: number; bytes: number; truncated: boolean }>> => {
    let files = 0;
    let folders = 0;
    let bytes = 0;
    let truncated = false;
    for (const batch of chunkPaths(paths, ADMIN_FILES_BATCH_LIMIT)) {
      const result = await apiPost(adminFileDeletePreviewSchema, "/api/admin/self/files", {
        action: "delete_preview",
        paths: batch,
      });
      if (!result.ok) return result;
      files += result.data.files;
      folders += result.data.folders;
      bytes += result.data.bytes;
      truncated = truncated || result.data.truncated;
    }
    return { ok: true, data: { files, folders, bytes, truncated } };
  },
  /**
   * Moves every path into one destination (`""` = the Files root) in one call;
   * partial success is reported per path in `failures`. Chunked and combined
   * the same way as `deleteMany` (see there); `entries` concatenates across
   * batches along with `failures`.
   */
  move: async (
    paths: string[],
    destination: string,
  ): Promise<ApiResult<{ moved: number; entries: AdminFileEntry[]; failures: AdminFileFailure[] }>> => {
    let moved = 0;
    let attempted = 0;
    const entries: AdminFileEntry[] = [];
    const failures: AdminFileFailure[] = [];
    for (const batch of chunkPaths(paths, ADMIN_FILES_BATCH_LIMIT)) {
      const result = await apiPost(adminFileMoveSchema, "/api/admin/self/files", {
        action: "move",
        paths: batch,
        destination,
      });
      if (!result.ok) {
        return {
          ok: true,
          data: { moved, entries, failures: [...failures, ...unattemptedFailures(paths, attempted, result.error)] },
        };
      }
      moved += result.data.moved;
      attempted += batch.length;
      failures.push(...result.data.failures);
      entries.push(...result.data.entries);
    }
    return { ok: true, data: { moved, entries, failures } };
  },
  upload: uploadAdminFile,
  downloadUrl: (path: string) => withQuery("/api/admin/self/files/download", { path }),
  /** Same `path` semantics as `downloadUrl`, for the inline preview route (#595) — never a `blob:`/`data:` URL, which the app's CSP blocks. */
  previewUrl: (path: string) => withQuery("/api/admin/self/files/preview", { path }),
};
