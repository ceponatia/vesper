"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { meApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "folder";
  size: number | null;
  modifiedAt: string;
}

interface ListResponse {
  path: string;
  entries: FileEntry[];
}

interface ApiErrorEnvelope {
  error?: { code?: string; message?: string };
}

interface UploadState {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  loaded: number;
  total: number;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => ({}))) as T & ApiErrorEnvelope;
  if (!response.ok) throw new Error(payload.error?.message || `Request failed (${response.status})`);
  return payload;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Folder";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i]!;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function parentPathFor(pathValue: string): string {
  const segments = pathValue.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

function downloadUrl(pathValue: string): string {
  return `/api/admin/self/files/download?${new URLSearchParams({ path: pathValue }).toString()}`;
}

function parseXhrError(xhr: XMLHttpRequest): { code: string; message: string } {
  try {
    const body = JSON.parse(xhr.responseText) as ApiErrorEnvelope;
    return {
      code: body.error?.code ?? "upload_failed",
      message: body.error?.message ?? `Upload failed (${xhr.status})`,
    };
  } catch {
    return { code: "upload_failed", message: `Upload failed (${xhr.status})` };
  }
}

export function FilesPage() {
  const me = useAsyncData(() => meApi.get(), []);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pathValue, setPathValue] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);

  const isAdmin = me.data?.role === "admin";

  const loadDirectory = useCallback(async (target: string) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ path: target });
      const result = await requestJson<ListResponse>(`/api/admin/self/files?${query.toString()}`);
      setEntries(result.entries);
    } catch (loadError) {
      setEntries([]);
      setError(loadError instanceof Error ? loadError.message : "Could not load files");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void loadDirectory(pathValue);
  }, [isAdmin, loadDirectory, pathValue]);

  const breadcrumbs = useMemo(() => {
    const segments = pathValue.split("/").filter(Boolean);
    return segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join("/") }));
  }, [pathValue]);

  const mutate = useCallback(async (body: unknown) => {
    return requestJson<{ entry?: FileEntry; ok?: boolean }>("/api/admin/self/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }, []);

  const createFolder = async () => {
    const name = window.prompt("New folder name");
    if (name === null) return;
    setBusyPath("__new_folder__");
    setError(null);
    try {
      await mutate({ action: "create_folder", path: pathValue, name });
      await loadDirectory(pathValue);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not create folder");
    } finally {
      setBusyPath(null);
    }
  };

  const renameEntry = async (entry: FileEntry) => {
    const name = window.prompt(`Rename ${entry.name}`, entry.name);
    if (name === null || name === entry.name) return;
    setBusyPath(entry.path);
    setError(null);
    try {
      await mutate({ action: "rename", path: entry.path, name });
      await loadDirectory(pathValue);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not rename item");
    } finally {
      setBusyPath(null);
    }
  };

  const deleteEntry = async (entry: FileEntry) => {
    const label = entry.kind === "folder" ? `folder “${entry.name}”` : `file “${entry.name}”`;
    if (!window.confirm(`Delete ${label}?${entry.kind === "folder" ? " The folder must be empty." : ""}`)) return;
    setBusyPath(entry.path);
    setError(null);
    try {
      await mutate({ action: "delete", path: entry.path });
      await loadDirectory(pathValue);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not delete item");
    } finally {
      setBusyPath(null);
    }
  };

  const uploadOne = useCallback(
    (file: File, overwrite: boolean, fileIndex: number, fileCount: number): Promise<"ok" | "conflict"> =>
      new Promise((resolve, reject) => {
        const query = new URLSearchParams({ path: pathValue, name: file.name });
        if (overwrite) query.set("overwrite", "1");
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", `/api/admin/self/files/upload?${query.toString()}`);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = (event) => {
          setUpload({
            fileName: file.name,
            fileIndex,
            fileCount,
            loaded: event.loaded,
            total: event.lengthComputable ? event.total : file.size,
          });
        };
        xhr.onerror = () => reject(new Error("Upload failed before Vesper returned a response"));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve("ok");
            return;
          }
          const parsed = parseXhrError(xhr);
          if (xhr.status === 409 && parsed.code === "already_exists" && !overwrite) {
            resolve("conflict");
            return;
          }
          reject(new Error(parsed.message));
        };
        xhr.send(file);
      }),
    [pathValue],
  );

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files.item(index);
        if (!file) continue;
        setUpload({ fileName: file.name, fileIndex: index + 1, fileCount: files.length, loaded: 0, total: file.size });
        const first = await uploadOne(file, false, index + 1, files.length);
        if (first === "conflict") {
          const replace = window.confirm(`“${file.name}” already exists. Replace the existing file?`);
          if (replace) await uploadOne(file, true, index + 1, files.length);
        }
      }
      await loadDirectory(pathValue);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
    } finally {
      setUpload(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  if (me.loading && !me.data) {
    return (
      <PageContainer>
        <Skeleton className="h-8 w-40" />
      </PageContainer>
    );
  }

  if (!isAdmin) {
    return (
      <PageContainer>
        <h1 className="prose-display text-2xl">Files</h1>
        <p className="mt-2 text-sm text-paper-400">This page is only available to administrators.</p>
      </PageContainer>
    );
  }

  const uploadPercent = upload && upload.total > 0 ? Math.min(100, Math.round((upload.loaded / upload.total) * 100)) : 0;

  return (
    <PageContainer>
      <div className="mx-auto w-full max-w-5xl py-6 sm:py-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="prose-display text-2xl text-paper-100">Files</h1>
            <p className="mt-1 max-w-2xl text-sm text-paper-400">
              Temporary owner-admin file sharing. Files live on Vesper&apos;s persistent Fly volume and are not part of the game data model.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={createFolder} busy={busyPath === "__new_folder__"}>New folder</Button>
            <Button variant="primary" onClick={() => inputRef.current?.click()} disabled={upload !== null}>
              Upload files
            </Button>
            <input
              ref={inputRef}
              className="hidden"
              type="file"
              multiple
              onChange={(event) => void uploadFiles(event.currentTarget.files)}
            />
          </div>
        </div>

        <div className="mt-6 flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-ink-600 bg-ink-800 px-2 py-1 text-sm">
          <button type="button" className="rounded px-2 py-1 text-paper-300 hover:bg-ink-700 hover:text-paper-100" onClick={() => setPathValue("")}>
            Files
          </button>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.path} className="flex items-center gap-1">
              <span className="text-paper-600">/</span>
              <button
                type="button"
                className="max-w-48 truncate rounded px-2 py-1 text-paper-300 hover:bg-ink-700 hover:text-paper-100"
                onClick={() => setPathValue(crumb.path)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>

        {pathValue ? (
          <div className="mt-2">
            <Button size="sm" variant="quiet" onClick={() => setPathValue(parentPathFor(pathValue))}>← Up one folder</Button>
          </div>
        ) : null}

        {upload ? (
          <div className="mt-4 rounded-md border border-ink-600 bg-ink-800 p-3 text-sm text-paper-300" aria-live="polite">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">Uploading {upload.fileIndex} of {upload.fileCount}: {upload.fileName}</span>
              <span className="shrink-0 tabular-nums">{uploadPercent}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-600">
              <div className="h-full bg-accent-500 transition-[width]" style={{ width: `${uploadPercent}%` }} />
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="mt-4 rounded-md border border-danger-500/40 bg-danger-500/10 px-3 py-2 text-sm text-danger-300" role="alert">
            {error}
          </div>
        ) : null}

        <div className="mt-4 overflow-hidden rounded-card border border-ink-600 bg-ink-800">
          <div className="hidden grid-cols-[minmax(0,1fr)_8rem_12rem_auto] gap-3 border-b border-ink-600 px-4 py-2 text-xs font-medium uppercase tracking-wide text-paper-500 sm:grid">
            <span>Name</span>
            <span>Size</span>
            <span>Modified</span>
            <span className="text-right">Actions</span>
          </div>

          {loading ? (
            <div className="p-4"><Skeleton className="h-10 w-full" /></div>
          ) : entries.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-paper-500">This folder is empty.</div>
          ) : (
            entries.map((entry) => {
              const busy = busyPath === entry.path;
              return (
                <div
                  key={entry.path}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-ink-700 px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_8rem_12rem_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    {entry.kind === "folder" ? (
                      <button
                        type="button"
                        className="max-w-full truncate text-left text-sm font-medium text-paper-100 hover:text-accent-300"
                        onClick={() => setPathValue(entry.path)}
                      >
                        {entry.name}/
                      </button>
                    ) : (
                      <a
                        className="block truncate text-sm font-medium text-paper-100 hover:text-accent-300"
                        href={downloadUrl(entry.path)}
                      >
                        {entry.name}
                      </a>
                    )}
                    <div className="mt-1 text-xs text-paper-500 sm:hidden">
                      {formatBytes(entry.size)} · {formatDate(entry.modifiedAt)}
                    </div>
                  </div>
                  <div className="hidden text-xs text-paper-400 sm:block">{formatBytes(entry.size)}</div>
                  <div className="hidden text-xs text-paper-400 sm:block">{formatDate(entry.modifiedAt)}</div>
                  <div className="flex items-center justify-end gap-1">
                    {entry.kind === "file" ? (
                      <a
                        className="touch-target inline-flex h-7 items-center rounded-md px-2.5 text-xs text-paper-400 transition-colors hover:bg-ink-700 hover:text-paper-100"
                        href={downloadUrl(entry.path)}
                      >
                        Download
                      </a>
                    ) : null}
                    <Button size="sm" variant="quiet" onClick={() => void renameEntry(entry)} disabled={busy}>Rename</Button>
                    <Button size="sm" variant="danger" onClick={() => void deleteEntry(entry)} busy={busy}>Delete</Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </PageContainer>
  );
}
