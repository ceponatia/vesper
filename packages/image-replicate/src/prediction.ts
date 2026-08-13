import { z } from "zod";
import { POLL_INTERVAL_MS, predictionTimeoutMs, REQUEST_TIMEOUT_MS, type ReplicateConfig } from "./config";
import { errorText, type ReplicateHttp, responseError, sleep } from "./http";
import { downloadReplicateOutput, outputUrl } from "./outputs";

/**
 * The prediction shell: create, poll, cancel, and read the answer. Every render
 * and every preprocessor run in Vesper goes through this one function, which is
 * why there is exactly one place that talks to `api.replicate.com/v1/predictions`.
 */

export interface ReplicateImageResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
  /**
   * The provider's prediction id, present on EVERY outcome from the moment one
   * exists — success, provider failure, timeout, poll error alike — because it
   * is the only handle that ties a stored render back to the provider's own
   * record of it. Absent only when the POST itself never produced a prediction
   * (transport failure, a non-2xx create), where there is genuinely no id and
   * inventing one would be worse than admitting none.
   */
  predictionId?: string;
  /**
   * The version Replicate says it ACTUALLY ran, echoed off the prediction body.
   *
   * A pinned request states what should run; only this states what did. The two
   * can differ — a bare `owner/name` slug resolves `latest_version` server-side,
   * and a pinned id can be re-pointed by the provider — and a controlled
   * comparison that cannot tell those apart is grading whatever Replicate
   * shipped that hour under a pin's name. Absent when the response carries no
   * `version` field, which is the honest answer rather than echoing the request
   * back as if it were confirmation.
   */
  executedVersionId?: string;
}

const predictionSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  /**
   * The version Replicate resolved for this prediction. Optional because the
   * model-endpoint form (`/models/owner/name/predictions`) has been observed
   * without it, and a missing echo must degrade to "unconfirmed" rather than
   * failing the parse of an otherwise perfectly good prediction.
   */
  version: z.string().optional(),
  output: z.unknown().optional().nullable(),
  error: z.unknown().optional().nullable(),
});

type ReplicatePrediction = z.infer<typeof predictionSchema>;

/**
 * The run-shaping fields the prediction shell owns — never the payload, which
 * its callers have already built and merged.
 *
 * A structural interface rather than a `Pick<RegistryModelRequest, …>` because
 * two different callers share the shell: a registry render, whose request
 * happens to carry these fields among many others, and the preprocessor, which
 * has no prompt, no references and no aspect to speak of. `outputField` exists
 * for the second: a preprocessor may answer with an OBJECT of several maps
 * (Depth Anything v2 returns `grey_depth` and `color_depth`), and the caller is
 * the only party that knows which of them it asked for.
 */
export interface PredictionRunOptions {
  timeoutMs?: number;
  versionId?: string;
  /** Read the image URL off THIS field when the output is an object. */
  outputField?: string;
}

/**
 * Resolve a registry slug to the endpoint that runs it. Three forms are
 * accepted: `owner/name` (runs whatever Replicate currently calls
 * `latest_version`), `owner/name:version` (pinned in the slug), and either of
 * those plus an EXPLICIT `versionId` from the caller.
 *
 * Pinning matters more here than it looks: Replicate can change a model's input
 * schema underneath a bare slug, which is exactly the failure the registry's
 * stored capability columns would not notice. `/predictions` is the only
 * endpoint that accepts a version, so any pin routes there.
 *
 * An explicit `versionId` WINS over a slug pin. It is the caller stating what it
 * verified and hashed — the identity trial refuses to plan a cell at all when
 * the probed and slug-pinned versions disagree (`pinnedImageModelVersion`), so
 * a conflict cannot reach here from that path, and any other caller passing one
 * is asserting the same thing.
 */
export function replicatePredictionTarget(model: string, versionId?: string): { path: string; version?: string } {
  const [path, version, ...rest] = model.split(":");
  if (rest.length > 0) throw new Error(`invalid Replicate model id: ${model}`);
  const [owner, name, extra] = (path ?? "").split("/");
  if (!owner || !name || extra) throw new Error(`invalid Replicate model id: ${model}`);
  if (versionId) return { path: "/predictions", version: versionId };
  if (version) return { path: "/predictions", version };
  return { path: `/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/predictions` };
}

/**
 * Run one prediction to completion. `input` is already built and merged by the
 * caller, so nothing here can change WHAT is sent — only where, for how long,
 * and which part of the answer is the image.
 */
export async function runPrediction(
  http: ReplicateHttp,
  config: ReplicateConfig,
  model: string,
  input: Record<string, unknown>,
  request: PredictionRunOptions,
): Promise<ReplicateImageResult> {
  // One binding of the caller's output shape, used by every read below: the
  // poll loop, the terminal check and the download must all agree on what
  // counts as "an image arrived", or a settled prediction whose map sits under
  // a named field reads as an empty output.
  const pickOutput = (output: unknown): string | null => outputUrl(output, request.outputField);
  // One resolution for both deadlines: the provider-side `Cancel-After` and this
  // client's poll cutoff must agree, or raising the budget only lengthens the
  // polling while Replicate still kills the prediction at the old bound.
  const timeoutMs = predictionTimeoutMs(config, request.timeoutMs);
  let prediction: ReplicatePrediction;
  try {
    // An explicit `versionId` pins the run outright. Otherwise a pinned
    // `owner/name:version` posts to the version-agnostic `/predictions`
    // endpoint carrying the version id, and a bare `owner/name` posts to the
    // model's own endpoint and takes whatever `latest_version` is.
    const target = replicatePredictionTarget(model, request.versionId);
    const response = await http.apiFetch(target.path, {
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
    prediction = predictionSchema.parse(await response.json());
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }

  const deadline = Date.now() + timeoutMs;
  while (!isTerminal(prediction.status) && pickOutput(prediction.output) === null) {
    if (Date.now() >= deadline) {
      await cancelPrediction(http, prediction.id);
      return { ok: false, predictionId: prediction.id, error: `replicate prediction ${prediction.id} timed out` };
    }
    await sleep(POLL_INTERVAL_MS);
    try {
      const response = await http.apiFetch(`/predictions/${encodeURIComponent(prediction.id)}`, {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, predictionId: prediction.id, error: await responseError(response) };
      prediction = predictionSchema.parse(await response.json());
    } catch (err) {
      return { ok: false, predictionId: prediction.id, error: errorText(err) };
    }
  }

  // The provenance the SETTLED prediction carries. Spread rather than assigned
  // so a response without a `version` echo reports no field at all instead of an
  // explicit undefined — absent means "the provider did not say", which is a
  // different fact from "it ran an empty version".
  const provenance = {
    predictionId: prediction.id,
    ...(prediction.version ? { executedVersionId: prediction.version } : {}),
  };

  if (prediction.status !== "succeeded" && pickOutput(prediction.output) === null) {
    return { ok: false, ...provenance, error: `replicate ${prediction.status}: ${predictionError(prediction.error)}` };
  }

  const url = pickOutput(prediction.output);
  if (!url) return { ok: false, ...provenance, error: "replicate returned no image" };
  try {
    return { ok: true, ...provenance, image: await downloadReplicateOutput(http, url) };
  } catch (err) {
    return { ok: false, ...provenance, error: errorText(err) };
  }
}

async function cancelPrediction(http: ReplicateHttp, predictionId: string): Promise<void> {
  if (!http.configured) return;
  await http
    .apiFetch(`/predictions/${encodeURIComponent(predictionId)}/cancel`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    .catch(() => undefined);
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled" || status === "aborted";
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

/**
 * Replicate's prediction deadline header: an integer of seconds (or a
 * unit-suffixed duration), valid from 5s to 24h. `predictionTimeoutMs()` is
 * already clamped to 30s–30m, so the derived value is always in range.
 */
function cancelAfterHeader(timeoutMs: number): string {
  return `${Math.round(timeoutMs / 1_000)}s`;
}
