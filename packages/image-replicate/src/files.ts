import { z } from "zod";
import { REQUEST_TIMEOUT_MS } from "./config";
import { errorText, type ReplicateHttp, responseError } from "./http";

/**
 * How reference bytes reach the provider: as private, short-lived Replicate
 * files, or inlined as data URIs.
 */

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
): Promise<UploadResult> {
  try {
    const form = new FormData();
    form.append("content", new Blob([new Uint8Array(buffer)], { type: "image/webp" }), filename);
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

/**
 * Bytes-to-URI conversion for the `data_url` transport. Every stored Vesper
 * image is webp (`writeWebpAtomic`), so the media type is a constant rather
 * than something to sniff.
 */
export function referenceDataUrl(buffer: Buffer): string {
  return `data:image/webp;base64,${buffer.toString("base64")}`;
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
export function withinDataUrlBudget(references: readonly Buffer[], reservedBytes = 0): Buffer[] {
  const kept: Buffer[] = [];
  let total = reservedBytes;
  for (const reference of references) {
    total += reference.byteLength;
    if (total > DATA_URL_BUDGET_BYTES) break;
    kept.push(reference);
  }
  // The anchor reference is the identity one; sending none would render a
  // stranger. Keep it even if it alone blows the budget and let the provider
  // be the one to refuse.
  return kept.length === 0 && references[0] ? [references[0]] : kept;
}
