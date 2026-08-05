import { z } from "zod";

const REPLICATE_BASE = "https://api.replicate.com/v1";
const DEFAULT_PREDICTION_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 1_500;
const REQUEST_TIMEOUT_MS = 75_000;
const OUTPUT_TIMEOUT_MS = 60_000;
const MAX_REFERENCES = 3;

export const REPLICATE_DEFAULT_IMAGE_MODEL = "qwen/qwen-image-2512";
export const REPLICATE_DEFAULT_EDIT_MODEL = "qwen/qwen-image-edit-2511";

export function replicateImageModelId(): string {
  return process.env.REPLICATE_IMAGE_MODEL || REPLICATE_DEFAULT_IMAGE_MODEL;
}

export function replicateEditModelId(): string {
  return process.env.REPLICATE_IMAGE_EDIT_MODEL || REPLICATE_DEFAULT_EDIT_MODEL;
}

export function hasReplicate(): boolean {
  return Boolean(process.env.REPLICATE_API_TOKEN);
}

export interface ReplicateImageResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
  predictionId?: string;
}

export interface ReplicateGenerateRequest {
  prompt: string;
  aspectRatio?: string;
}

/** Qwen Image 2512 text-to-image through Replicate's official model endpoint. */
export async function replicateGenerateImage(request: ReplicateGenerateRequest): Promise<ReplicateImageResult> {
  if (!hasReplicate()) return { ok: false, error: "REPLICATE_API_TOKEN not configured" };
  return runReplicateImageModel(replicateImageModelId(), {
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio ?? "3:4",
    output_format: "webp",
    output_quality: 95,
    go_fast: true,
    disable_safety_checker: process.env.REPLICATE_SAFE_MODE !== "true",
  });
}

export interface ReplicateEditRequest {
  prompt: string;
  /** One to three ordered identity/location references. */
  references: Buffer[];
  aspectRatio?: string;
}

/**
 * Qwen Image Edit 2511 through Replicate. Reference buffers are uploaded as
 * private, short-lived Replicate files because Vesper's stored images are not
 * publicly addressable and can exceed the data-URL recommendation. The uploads
 * are deleted best-effort as soon as the prediction settles.
 */
export async function replicateEditImage(request: ReplicateEditRequest): Promise<ReplicateImageResult> {
  if (!hasReplicate()) return { ok: false, error: "REPLICATE_API_TOKEN not configured" };
  const references = request.references.slice(0, MAX_REFERENCES);
  if (references.length === 0) return { ok: false, error: "replicate edit requires at least one reference image" };

  const uploads: ReplicateFile[] = [];
  try {
    for (const [index, reference] of references.entries()) {
      const upload = await uploadReplicateFile(reference, `vesper-reference-${index + 1}.webp`);
      if (!upload.ok) return { ok: false, error: upload.error };
      uploads.push(upload.file);
    }

    return await runReplicateImageModel(replicateEditModelId(), {
      prompt: request.prompt,
      image: uploads.map((file) => file.url),
      aspect_ratio: request.aspectRatio ?? "3:4",
      output_format: "webp",
      output_quality: 95,
      go_fast: true,
      disable_safety_checker: process.env.REPLICATE_SAFE_MODE !== "true",
    });
  } finally {
    await Promise.allSettled(uploads.map((file) => deleteReplicateFile(file.id)));
  }
}

export function unwrapReplicateImage(result: ReplicateImageResult, fallback: string): Buffer {
  if (!result.ok || !result.image) throw new Error(result.error || fallback);
  return result.image;
}

const predictionSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  output: z.unknown().optional().nullable(),
  error: z.unknown().optional().nullable(),
});

type ReplicatePrediction = z.infer<typeof predictionSchema>;

const fileSchema = z.object({
  id: z.string().min(1),
  urls: z.object({ get: z.string().url() }),
});

interface ReplicateFile {
  id: string;
  url: string;
}

type UploadResult = { ok: true; file: ReplicateFile } | { ok: false; error: string };

async function runReplicateImageModel(model: string, input: Record<string, unknown>): Promise<ReplicateImageResult> {
  // One parse for both deadlines: the provider-side `Cancel-After` and this
  // client's poll cutoff must agree, or raising the env var only lengthens the
  // polling while Replicate still kills the prediction at the old bound.
  const timeoutMs = predictionTimeoutMs();
  let prediction: ReplicatePrediction;
  try {
    const response = await replicateApiFetch(modelPredictionPath(model), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "wait=60",
        "Cancel-After": cancelAfterHeader(timeoutMs),
      },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, error: await responseError(response) };
    prediction = parsePrediction(await response.json());
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }

  const deadline = Date.now() + timeoutMs;
  while (!isTerminal(prediction.status) && outputUrl(prediction.output) === null) {
    if (Date.now() >= deadline) {
      await cancelPrediction(prediction.id);
      return { ok: false, predictionId: prediction.id, error: `replicate prediction ${prediction.id} timed out` };
    }
    await sleep(POLL_INTERVAL_MS);
    try {
      const response = await replicateApiFetch(`/predictions/${encodeURIComponent(prediction.id)}`, {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, predictionId: prediction.id, error: await responseError(response) };
      prediction = parsePrediction(await response.json());
    } catch (err) {
      return { ok: false, predictionId: prediction.id, error: errorText(err) };
    }
  }

  if (prediction.status !== "succeeded" && outputUrl(prediction.output) === null) {
    return {
      ok: false,
      predictionId: prediction.id,
      error: `replicate ${prediction.status}: ${predictionError(prediction.error)}`,
    };
  }

  const url = outputUrl(prediction.output);
  if (!url) return { ok: false, predictionId: prediction.id, error: "replicate returned no image" };
  try {
    return { ok: true, predictionId: prediction.id, image: await downloadReplicateOutput(url) };
  } catch (err) {
    return { ok: false, predictionId: prediction.id, error: errorText(err) };
  }
}

async function uploadReplicateFile(buffer: Buffer, filename: string): Promise<UploadResult> {
  try {
    const form = new FormData();
    form.append("content", new Blob([new Uint8Array(buffer)], { type: "image/webp" }), filename);
    const response = await replicateApiFetch("/files", {
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

async function deleteReplicateFile(fileId: string): Promise<void> {
  if (!hasReplicate()) return;
  await replicateApiFetch(`/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
}

async function cancelPrediction(predictionId: string): Promise<void> {
  if (!hasReplicate()) return;
  await replicateApiFetch(`/predictions/${encodeURIComponent(predictionId)}/cancel`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
}

async function downloadReplicateOutput(value: string): Promise<Buffer> {
  if (value.startsWith("data:image/")) {
    const comma = value.indexOf(",");
    if (comma === -1) throw new Error("replicate returned an invalid image data URL");
    return Buffer.from(value.slice(comma + 1), "base64");
  }

  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedOutputHost(url.hostname)) {
    throw new Error(`replicate returned an untrusted output URL: ${url.hostname}`);
  }
  const headers = url.hostname === "api.replicate.com" ? authHeaders() : undefined;
  const response = await fetch(url, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(OUTPUT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(await responseError(response));
  return Buffer.from(await response.arrayBuffer());
}

function allowedOutputHost(hostname: string): boolean {
  return hostname === "replicate.delivery" || hostname.endsWith(".replicate.delivery") || hostname === "api.replicate.com";
}

function modelPredictionPath(model: string): string {
  const [owner, name, extra] = model.split("/");
  if (!owner || !name || extra) throw new Error(`invalid Replicate model id: ${model}`);
  return `/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/predictions`;
}

function parsePrediction(raw: unknown): ReplicatePrediction {
  return predictionSchema.parse(raw);
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled" || status === "aborted";
}

function outputUrl(output: unknown): string | null {
  if (typeof output === "string" && output.trim()) return output;
  if (Array.isArray(output)) {
    const first = output.find((value): value is string => typeof value === "string" && value.trim().length > 0);
    return first ?? null;
  }
  return null;
}

function predictionError(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.slice(0, 500);
  if (error === null || error === undefined) return "prediction failed";
  try {
    return JSON.stringify(error).slice(0, 500);
  } catch {
    return String(error).slice(0, 500);
  }
}

function predictionTimeoutMs(): number {
  const parsed = Number(process.env.REPLICATE_PREDICTION_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 30_000 ? Math.min(parsed, 30 * 60_000) : DEFAULT_PREDICTION_TIMEOUT_MS;
}

/**
 * Replicate's prediction deadline header: an integer of seconds (or a
 * unit-suffixed duration), valid from 5s to 24h. `predictionTimeoutMs()` is
 * already clamped to 30s–30m, so the derived value is always in range.
 */
function cancelAfterHeader(timeoutMs: number): string {
  return `${Math.round(timeoutMs / 1_000)}s`;
}

async function replicateApiFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${REPLICATE_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN ?? ""}` };
}

async function responseError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `replicate ${response.status}: ${body.slice(0, 500) || response.statusText}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
