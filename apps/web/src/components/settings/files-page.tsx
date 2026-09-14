"use client";

import { useMemo, useRef, useState } from "react";
import { adminFilesApi, meApi, type AdminFileEntry } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface UploadState {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  loaded: number;
  total: number;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Folder";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (unitIndex < units.length - 1 && value >= 1024) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = units[unitIndex] ?? "KB";
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

export function FilesPage() {
  const me = useAsyncData(() => meApi.get(), []);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pathValue, setPathValue] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const directory = useAsyncData(() => adminFilesApi.list(pathValue), [pathValue]);

  const isAdmin = me.data?.role === "admin";
  const entries = directory.data?.entries ?? [];
  const visibleError = actionError ?? directory.error?.message ?? me.error?.message ?? null;

  const breadcrumbs = useMemo(() => {
    const segments = pathValue.split("/").filter(Boolean);
    return segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join("/") }));
  }, [pathValue]);

  const navigate = (target: string) => {
    setActionError(null);
    setPathValue(target);
  };

  const createFolder = async () => {
    const name = window.prompt("New folder name");
    if (name === null) return;
    setBusyPath("__new_folder__");
    setActionError(null);
    try {
      const result = await adminFilesApi.createFolder(pathValue, name);
      if (!result.ok) {
        setActionError(result.error.message);
        return;
      }
      directory.reload();
    } finally {
      setBusyPath(null);
    }
  };

  const renameEntry = async (entry: AdminFileEntry) => {
    const name = window.prompt(`Rename ${entry.name}`, entry.name);
    if (name === null || name === entry.name) return;
    setBusyPath(entry.path);
    setActionError(null);
    try {
      const result = await adminFilesApi.rename(entry.path, name);
      if (!result.ok) {
        setActionError(result.error.message);
        return;
      }
      directory.reload();
    } finally {
      setBusyPath(null);
    }
  };

  const deleteEntry = async (entry: AdminFileEntry) => {
    const label = entry.kind === "folder" ? `folder “${entry.name}”` : `file “${entry.name}”`;
    const warning = entry.kind === "folder" ? " The folder must be empty." : "";
    if (!window.confirm(`Delete ${label}?${warning}`)) return;

    setBusyPath(entry.path);
    setActionError(null);
    try {
      const result = await adminFilesApi.delete(entry.path);
      if (!result.ok) {
        setActionError(result.error.message);
        return;
      }
      directory.reload();
    } finally {
      setBusyPath(null);
    }
  };

  const uploadOne = async (file: File, overwrite: boolean, fileIndex: number, fileCount: number) => {
    return adminFilesApi.upload({
      path: pathValue,
      file,
      overwrite,
      onProgress: ({ loaded, total }) => {
        setUpload({ fileName: file.name, fileIndex, fileCount, loaded, total });
      },
    });
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setActionError(null);

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files.item(index);
        if (!file) continue;
        const fileIndex = index + 1;
        setUpload({ fileName: file.name, fileIndex, fileCount: files.length, loaded: 0, total: file.size });

        let result = await uploadOne(file, false, fileIndex, files.length);
        if (!result.ok && result.error.status === 409 && result.error.code === "already_exists") {
          const replace = window.confirm(`“${file.name}” already exists. Replace the existing file?`);
          if (!replace) continue;
          result = await uploadOne(file, true, fileIndex, files.length);
        }
        if (!result.ok) {
          setActionError(result.error.message);
          break;
        }
      }
      directory.reload();
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
          <button type="button" className="rounded px-2 py-1 text-paper-300 hover:bg-ink-700 hover:text-paper-100" onClick={() => navigate("")}>
            Files
          </button>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.path} className="flex items-center gap-1">
              <span className="text-paper-600">/</span>
              <button
                type="button"
                className="max-w-48 truncate rounded px-2 py-1 text-paper-300 hover:bg-ink-700 hover:text-paper-100"
                onClick={() => navigate(crumb.path)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>

        {pathValue ? (
          <div className="mt-2">
            <Button size="sm" variant="quiet" onClick={() => navigate(parentPathFor(pathValue))}>← Up one folder</Button>
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

        {visibleError ? (
          <div className="mt-4 rounded-md border border-danger-500/40 bg-danger-500/10 px-3 py-2 text-sm text-danger-300" role="alert">
            {visibleError}
          </div>
        ) : null}

        <div className="mt-4 overflow-hidden rounded-card border border-ink-600 bg-ink-800">
          <div className="hidden grid-cols-[minmax(0,1fr)_8rem_12rem_auto] gap-3 border-b border-ink-600 px-4 py-2 text-xs font-medium uppercase tracking-wide text-paper-500 sm:grid">
            <span>Name</span>
            <span>Size</span>
            <span>Modified</span>
            <span className="text-right">Actions</span>
          </div>

          {directory.loading ? (
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
                        onClick={() => navigate(entry.path)}
                      >
                        {entry.name}/
                      </button>
                    ) : (
                      <a
                        className="block truncate text-sm font-medium text-paper-100 hover:text-accent-300"
                        href={adminFilesApi.downloadUrl(entry.path)}
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
                        href={adminFilesApi.downloadUrl(entry.path)}
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
