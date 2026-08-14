import type { ImageReferenceTransport } from "@vesper/image-core";
import { z } from "zod";
import { REQUEST_TIMEOUT_MS } from "./config";
import { errorText, type ReplicateHttp, responseError } from "./http";

/**
 * How reference bytes reach the provider: as private, short-lived Replicate
 * files, or inlined as data URIs.
 */

/**
 * Reference bytes plus the transport facts the application's preparation step
 * resolved: the media type an upload or data URI must carry, and the filename
 * extension the provider sees. This package never derives either — sharp work
 * is application infrastructure (`reference-preparation.ts`) — it writes what
 * it was told. Not every stored Vesper asset stays webp forever, and masks or
 * external control images may arrive as something else entirely.
 */
export interface PreparedReferenceBytes {
  bytes: Buffer;
  /** e.g. `image/webp`. */
  mediaType: string;
  /** Filename extension without the dot, e.g. `webp`. */
  extension: string;
  /**
   * The caller's name for what this image is — a reference role or a control
   * field. Diagnostics only; it never reaches the provider.
   */
  role?: string;
}

const fileSchema = z.object({
  id: z.string().min(1),
  urls: z.object({ get: z.string().url() }),
});

export interface ReplicateFile {
  id: string;
  url: string;
}

export type UploadResult = { ok: true; file: ReplicateFile } | { ok: false; error: string };

export async function uploadReplicateFile(
  http: ReplicateHttp,
  buffer: Buffer,
  filename: string,
  mediaType: string,
): Promise<UploadResult> {
  try {
    const form = new FormData();
    form.append("content", new Blob([new Uint8Array(buffer)], { type: mediaType }), filename);
    const response = await http.apiFetch("/files", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, error: await responseError(response) };
    const parsed = fileSchema.parse(await response.json());
    return { ok: true, file: { id: parsed.id, url: parsed.urls.get } };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

export async function deleteReplicateFile(http: ReplicateHttp, fileId: string): Promise<void> {
  if (!http.configured) return;
  await http
    .apiFetch(`/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    .catch(() => undefined);
}

/** Bytes-to-URI conversion for the `data_url` transport, carrying the prepared media type. */
export function referenceDataUrl(buffer: Buffer, mediaType: string): string {
  return `data:${mediaType};base64,${buffer.toString("base64")}`;
}

/** How many reference uploads may be in flight at once (see {@link transportReplicateReferences}). */
export const REFERENCE_UPLOAD_CONCURRENCY = 3;

/** The provider-visible URIs, one per input in INPUT order, and the uploads behind them. */
export interface TransportedReferences {
  uris: string[];
  /** Short-lived uploads to delete once the prediction settles; empty for `data_url`. */
  files: ReplicateFile[];
}

export type TransportReferencesResult = ({ ok: true } & TransportedReferences) | { ok: false; error: string };

/**
 * Move prepared reference bytes onto the wire for one transport.
 *
 * `data_url` is pure conversion: every image becomes a data URI carrying its own
 * media type, and there is nothing to clean up. Any byte budget was applied by
 * the caller BEFORE this — the budget is a selection decision, not a transport
 * mechanic.
 *
 * `file` uploads with bounded concurrency ({@link REFERENCE_UPLOAD_CONCURRENCY}
 * by default) rather than serially or all at once: a render's references are a
 * handful of sub-megabyte images, and three in flight hides the per-request
 * latency without turning one render into a burst the files API might throttle.
 * The returned URIs are in INPUT order regardless of completion order — the
 * caller splits them back positionally, so a reordering here would silently
 * swap a pose map for a face. Each upload is named by its input slot
 * (`vesper-reference-N.<ext>`), so the numbering callers rely on survives too.
 *
 * On any single failure, every upload that DID succeed is deleted best-effort
 * before the failure is returned: the render is not happening, so the only
 * thing those files could do is outlive their purpose on the provider's
 * storage. In-flight uploads are allowed to settle first (they must be, to be
 * deletable); unstarted ones are never begun.
 */
export async function transportReplicateReferences(
  http: ReplicateHttp,
  prepared: readonly PreparedReferenceBytes[],
  transport: ImageReferenceTransport,
  concurrency: number = REFERENCE_UPLOAD_CONCURRENCY,
): Promise<TransportReferencesResult> {
  if (transport === "data_url") {
    return { ok: true, uris: prepared.map((reference) => referenceDataUrl(reference.bytes, reference.mediaType)), files: [] };
  }

  const slots: (ReplicateFile | null)[] = prepared.map(() => null);
  let failure: string | null = null;
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, prepared.length)) }, async () => {
    // Claiming `next` synchronously (no await between read and increment) is
    // what makes the pool race-free on one event loop.
    while (failure === null && next < prepared.length) {
      const index = next;
      next += 1;
      const reference = prepared[index];
      if (!reference) continue;
      const upload = await uploadReplicateFile(
        http,
        reference.bytes,
        `vesper-reference-${index + 1}.${reference.extension}`,
        reference.mediaType,
      );
      if (upload.ok) slots[index] = upload.file;
      else failure = failure ?? upload.error;
    }
  });
  await Promise.all(workers);

  const files = slots.flatMap((file) => (file ? [file] : []));
  if (failure !== null) {
    await Promise.allSettled(files.map((file) => deleteReplicateFile(http, file.id)));
    return { ok: false, error: failure };
  }
  return { ok: true, uris: files.map((file) => file.url), files };
}

/**
 * Total raw reference bytes allowed to travel inline. Base64 inflates by ~4/3,
 * so 6 MB of buffers is an ~8 MB request body — comfortably above the largest
 * render Vesper makes (3 references of ~200 KB) and far below anything an API
 * gateway would refuse. References past the budget are dropped rather than
 * failing the render: fewer references costs fidelity, a rejected request costs
 * the image (docs/resilience.md §2).
 */
export const DATA_URL_BUDGET_BYTES = 6 * 1024 * 1024;

/**
 * The leading references that fit {@link DATA_URL_BUDGET_BYTES}; order is
 * preserved.
 *
 * `reservedBytes` is payload already spoken for — the bound control images,
 * which are inlined whole. They are charged FIRST because they are not
 * negotiable: a control was bound to a field the version declared, and an
 * unconstrained render that silently lost its pose map looks like a success. An
 * optional trailing style reference is exactly the thing a byte budget should
 * give up instead.
 */
export function withinDataUrlBudget<T extends PreparedReferenceBytes>(
  references: readonly T[],
  reservedBytes = 0,
): T[] {
  const kept: T[] = [];
  let total = reservedBytes;
  for (const reference of references) {
    total += reference.bytes.byteLength;
    if (total > DATA_URL_BUDGET_BYTES) break;
    kept.push(reference);
  }
  // The anchor reference is the identity one; sending none would render a
  // stranger. Keep it even if it alone blows the budget and let the provider
  // be the one to refuse.
  return kept.length === 0 && references[0] ? [references[0]] : kept;
}
