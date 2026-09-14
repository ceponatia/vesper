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
const adminFileDeleteSchema = z.object({ ok: z.boolean() });

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
  delete: (path: string) =>
    apiPost(adminFileDeleteSchema, "/api/admin/self/files", {
      action: "delete",
      path,
    }),
  upload: uploadAdminFile,
  downloadUrl: (path: string) => withQuery("/api/admin/self/files/download", { path }),
};
