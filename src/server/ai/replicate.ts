import { z } from "zod";
import { fitReferences, type ImageModel } from "@/contracts";

const REPLICATE_BASE = "https://api.replicate.com/v1";
const DEFAULT_PREDICTION_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 1_500;
const REQUEST_TIMEOUT_MS = 75_000;
const OUTPUT_TIMEOUT_MS = 60_000;

export const REPLICATE_DEFAULT_IMAGE_MODEL = "qwen/qwen-image-2512";
export const REPLICATE_DEFAULT_EDIT_MODEL = "qwen/qwen-image-edit-2511";

export function hasReplicate(): boolean {
  return Boolean(process.env.REPLICATE_API_TOKEN);
}

/**
 * Whether generated images bypass the provider's safety checker. Inverted from
 * the env flag so the safe default reads the same way it does everywhere else.
 * Only ever applied to models whose schema HAS the input (see
 * `buildRegistryModelInput`).
 */
function disableSafetyChecker(): boolean {
  return process.env.REPLICATE_SAFE_MODE !== "true";
}

export interface ReplicateImageResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
  predictionId?: string;
}

export interface RegistryModelRequest {
  prompt: string;
  /** Ordered identity/location references; trimmed to what the model accepts. */
  references?: Buffer[];
  /**
   * The shape to request, already negotiated against the model's offerings by
   * `chooseAspect`. Null omits the aspect key entirely, letting the model use
   * its own default.
   */
  aspect?: string | null;
}

/**
 * Build one model's prediction input (PURE — the unit-testable half of the
 * render path). Every difference between the models we run lives here rather
 * than in a per-model branch:
 *
 * - The reference key differs (`image` / `image_input` / `images`) and so does
 *   its arity — both Qwen models call it `image`, one a string and one an array.
 *   The key is OMITTED entirely when there are no references, because a model
 *   whose reference input is optional treats an empty array differently from an
 *   absent one on some backends.
 * - Shape is written to `aspect_ratio` on most models and to `size` on Wan,
 *   which has no aspect input at all. The VALUE is chosen upstream by
 *   `chooseAspect` against what the model offers; null omits the key so the
 *   model falls back to its own default.
 * - `output_format` is omitted where the model has no such input.
 * - `extraInput` carries per-model constants. `disable_safety_checker` is only
 *   ever present when the model's schema actually declares it — Replicate
 *   rejects unknown inputs — so its VALUE is overridden from the env here, but
 *   the key is never introduced.
 */
export function buildRegistryModelInput(
  model: ImageModel,
  prompt: string,
  referenceUrls: readonly string[],
  aspect?: string | null,
): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt };

  if (referenceUrls.length > 0) {
    input[model.referenceField] = model.referenceArity === "single" ? referenceUrls[0] : [...referenceUrls];
  }

  if (aspect) input[model.aspectMode === "size" ? "size" : "aspect_ratio"] = aspect;

  if (model.outputFormat) input.output_format = model.outputFormat;

  for (const [key, value] of Object.entries(model.extraInput)) {
    input[key] = key === "disable_safety_checker" ? disableSafetyChecker() : value;
  }
  return input;
}

/**
 * Run one registry model. Reference buffers are uploaded as private,
 * short-lived Replicate files because Vesper's stored images are not publicly
 * addressable and can exceed the data-URL recommendation; the uploads are
 * deleted best-effort as soon as the prediction settles.
 *
 * References are trimmed through `fitReferences` rather than a fixed cap, so a
 * single-reference model stops being handed three and silently ignoring two.
 */
export async function runRegistryImageModel(
  model: ImageModel,
  request: RegistryModelRequest,
): Promise<ReplicateImageResult> {
  if (!hasReplicate()) return { ok: false, error: "REPLICATE_API_TOKEN not configured" };
  const references = fitReferences(model, request.references ?? []);
  if (references.length === 0 && !model.canGenerate) {
    return { ok: false, error: `${model.slug} requires at least one reference image` };
  }

  const uploads: ReplicateFile[] = [];
  try {
    for (const [index, reference] of references.entries()) {
      const upload = await uploadReplicateFile(reference, `vesper-reference-${index + 1}.webp`);
      if (!upload.ok) return { ok: false, error: upload.error };
      uploads.push(upload.file);
    }
    return await runReplicateImageModel(
      model.slug,
      buildRegistryModelInput(model, request.prompt, uploads.map((file) => file.url), request.aspect),
    );
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
    // A pinned `owner/name:version` posts to the version-agnostic
    // `/predictions` endpoint carrying the version id; a bare `owner/name`
    // posts to the model's own endpoint and takes whatever `latest_version` is.
    const target = replicatePredictionTarget(model);
    const response = await replicateApiFetch(target.path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "wait=60",
        "Cancel-After": cancelAfterHeader(timeoutMs),
      },
      body: JSON.stringify(target.version ? { version: target.version, input } : { input }),
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

/**
 * Resolve a registry slug to the endpoint that runs it. Two forms are accepted:
 * `owner/name` (runs whatever Replicate currently calls `latest_version`) and
 * `owner/name:version` (pinned — posts the version id to `/predictions`, which
 * is the only endpoint that accepts one).
 *
 * Pinning matters more here than it looks: Replicate can change a model's input
 * schema underneath a bare slug, which is exactly the failure the registry's
 * stored capability columns would not notice.
 */
export function replicatePredictionTarget(model: string): { path: string; version?: string } {
  const [path, version, ...rest] = model.split(":");
  if (rest.length > 0) throw new Error(`invalid Replicate model id: ${model}`);
  const [owner, name, extra] = (path ?? "").split("/");
  if (!owner || !name || extra) throw new Error(`invalid Replicate model id: ${model}`);
  if (version) return { path: "/predictions", version };
  return { path: `/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/predictions` };
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
