import { z } from "zod";
import { fitReferences, type ImageModel } from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";

const REPLICATE_BASE = "https://api.replicate.com/v1";
const DEFAULT_PREDICTION_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 1_500;

/**
 * The per-HTTP-call deadline every Replicate request carries, and the separate
 * one the output download gets.
 *
 * Both are EXPORTED because they are the only honest way to size how long one
 * render may legitimately take end to end. The identity trial's stale-claim
 * window has to exceed a whole render — prediction budget plus the reference
 * uploads, the settling poll, and the output fetch around it — and a window
 * derived from a hand-copied "about a minute" would silently stop covering the
 * real thing the first time either number moved.
 */
export const REQUEST_TIMEOUT_MS = 75_000;
export const OUTPUT_TIMEOUT_MS = 60_000;

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
 *
 * Exported because the value is ENV-OWNED and resolved at send time, which means
 * a stored `extraInput.disable_safety_checker` is a placeholder rather than a
 * fact. Anything that fingerprints what a render sends has to ask this function
 * the same question the payload builder asks — otherwise the fingerprint
 * describes the stored placeholder while the provider receives the env's answer,
 * and an operator flipping `REPLICATE_SAFE_MODE` between two arms of a
 * comparison changes provider enforcement with nothing to show for it.
 */
export function disableSafetyChecker(): boolean {
  return process.env.REPLICATE_SAFE_MODE !== "true";
}

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
  /**
   * Already-mapped provider fields — the caller's resolved controls and
   * validated overrides, keyed by this version's real input names
   * (`mapImageRenderControls` / `validateProviderOverrides`). Merged LAST, per
   * the capabilities spec's merge order, so a profile's guidance beats the
   * model row's `extraInput` constant.
   *
   * It is deliberately opaque here: this module does not know a control from a
   * constant, and adding a second place that reasons about control names is how
   * the two would drift. What it DOES enforce is that the overlay cannot touch
   * the fields the render path owns ({@link reservedImageInputFields}).
   */
  controlInput?: Record<string, unknown>;
  /**
   * This run's prediction budget, overriding the env/default for BOTH the poll
   * deadline and Replicate's `Cancel-After`. A profile's `timeoutMs` arrives
   * here; anything out of the sane 30s–30m band is clamped rather than honored,
   * because a caller asking for a 12-hour prediction is a bug, not a budget.
   */
  timeoutMs?: number;
  /**
   * Execute EXACTLY this provider version, whatever the slug says. A controlled
   * comparison cannot run against a floating `latest_version`, so the identity
   * trial pins the probed version id here and the prediction goes to
   * `/predictions` carrying it even for a bare `owner/name` slug.
   */
  versionId?: string;
}

/**
 * The input fields the render path owns, which nothing merged later may write.
 *
 * This is the one spelling of that set, shared by the `controlInput` overlay
 * below and by the images layer's `providerOverrides` validation — two copies
 * would be two answers to "may a profile redirect the prompt?", and the copy
 * nobody edits is the one that eventually says yes.
 *
 * `prompt`, the reference field and the aspect key are structural: they are
 * what {@link buildRegistryModelInput} writes, and an override reaching one of
 * them would send the render somewhere the caller did not compile. `version` is
 * never an input key at all, but naming it here keeps a stored profile from
 * looking like it can repin the model. `disable_safety_checker` is the safety
 * enforcement the env owns; a database row must not be able to flip it.
 */
export function reservedImageInputFields(model: ImageModel): string[] {
  const fields = new Set<string>([
    "prompt",
    model.referenceField,
    model.aspectMode === "size" ? "size" : "aspect_ratio",
    "version",
    "disable_safety_checker",
  ]);
  const probedPromptField = model.advancedCapabilities.prompt?.field;
  if (probedPromptField) fields.add(probedPromptField);
  return [...fields];
}

/**
 * Merge already-mapped provider fields onto a built payload, skipping anything
 * reserved.
 *
 * Build-then-overlay rather than overlay-then-build: the reserved keys must be
 * the ones the BUILDER produced, so a collision is detectable. A collision is
 * reported rather than swallowed — an operator who wrote `prompt` into a
 * profile's overrides needs told that it did nothing, not left to wonder why
 * their prompt text never appeared.
 */
export function overlayControlInput(
  built: Record<string, unknown>,
  controlInput: Record<string, unknown> | undefined,
  model: ImageModel,
  sink?: DiagnosticSink,
): Record<string, unknown> {
  if (!controlInput) return built;
  const reserved = new Set(reservedImageInputFields(model));
  const merged = { ...built };
  const refused: string[] = [];
  for (const [field, value] of Object.entries(controlInput)) {
    if (reserved.has(field)) {
      refused.push(field);
      continue;
    }
    merged[field] = value;
  }
  if (refused.length > 0) {
    sink?.push(
      diag("warn", "image_model.reserved_field_ignored", "control input tried to write a render-path field", {
        path: "image_models",
        context: { slug: model.slug, fields: refused.sort() },
      }),
    );
  }
  return merged;
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
const DATA_URL_BUDGET_BYTES = 6 * 1024 * 1024;

/**
 * Run one registry model.
 *
 * Reference bytes travel one of two ways, per the model's stored
 * `referenceTransport`:
 *
 * - `file` (default) uploads them as private, short-lived Replicate files,
 *   because Vesper's stored images are not publicly addressable and can exceed
 *   the data-URL recommendation; the uploads are deleted best-effort as soon as
 *   the prediction settles.
 * - `data_url` inlines them. Wan 2.7 rejects the uploaded-file URL outright
 *   (`Invalid image format ''` — see `imageReferenceTransports`), so for that
 *   model "smaller payload" is not a trade worth having.
 *
 * References are trimmed through `fitReferences` rather than a fixed cap, so a
 * single-reference model stops being handed three and silently ignoring two.
 *
 * The payload is BUILT and then overlaid: `buildRegistryModelInput` owns the
 * prompt, references, aspect and per-model constants, and `request.controlInput`
 * merges over the result minus the reserved fields
 * ({@link reservedImageInputFields}). That order is the capabilities spec's — a
 * later layer wins — while keeping the render path's own fields unreachable
 * from a stored profile row.
 */
export async function runRegistryImageModel(
  model: ImageModel,
  request: RegistryModelRequest,
  sink?: DiagnosticSink,
): Promise<ReplicateImageResult> {
  if (!hasReplicate()) return { ok: false, error: "REPLICATE_API_TOKEN not configured" };
  const references = fitReferences(model, request.references ?? []);
  if (references.length === 0 && !model.canGenerate) {
    return { ok: false, error: `${model.slug} requires at least one reference image` };
  }

  if (model.referenceTransport === "data_url") {
    const inlined = withinDataUrlBudget(references);
    if (inlined.length < references.length) {
      sink?.push(
        diag("warn", "image_model.references_trimmed", "dropped references that did not fit the inline byte budget", {
          path: "image_models",
          context: { slug: model.slug, sent: inlined.length, requested: references.length },
        }),
      );
    }
    return await runReplicateImageModel(
      model.slug,
      overlayControlInput(
        buildRegistryModelInput(model, request.prompt, inlined.map(referenceDataUrl), request.aspect),
        request.controlInput,
        model,
        sink,
      ),
      request,
    );
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
      overlayControlInput(
        buildRegistryModelInput(model, request.prompt, uploads.map((file) => file.url), request.aspect),
        request.controlInput,
        model,
        sink,
      ),
      request,
    );
  } finally {
    await Promise.allSettled(uploads.map((file) => deleteReplicateFile(file.id)));
  }
}

/** The leading references that fit {@link DATA_URL_BUDGET_BYTES}; order is preserved. */
export function withinDataUrlBudget(references: readonly Buffer[]): Buffer[] {
  const kept: Buffer[] = [];
  let total = 0;
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

export function unwrapReplicateImage(result: ReplicateImageResult, fallback: string): Buffer {
  if (!result.ok || !result.image) throw new Error(result.error || fallback);
  return result.image;
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

const fileSchema = z.object({
  id: z.string().min(1),
  urls: z.object({ get: z.string().url() }),
});

interface ReplicateFile {
  id: string;
  url: string;
}

type UploadResult = { ok: true; file: ReplicateFile } | { ok: false; error: string };

/**
 * The prediction shell. `request` supplies only the two run-shaping fields it
 * owns (`timeoutMs`, `versionId`) — the payload is already built and merged by
 * the caller, so nothing here can change WHAT is sent, only where and for how
 * long.
 */
async function runReplicateImageModel(
  model: string,
  input: Record<string, unknown>,
  request: Pick<RegistryModelRequest, "timeoutMs" | "versionId">,
): Promise<ReplicateImageResult> {
  // One resolution for both deadlines: the provider-side `Cancel-After` and this
  // client's poll cutoff must agree, or raising the budget only lengthens the
  // polling while Replicate still kills the prediction at the old bound.
  const timeoutMs = predictionTimeoutMs(request.timeoutMs);
  let prediction: ReplicatePrediction;
  try {
    // An explicit `versionId` pins the run outright. Otherwise a pinned
    // `owner/name:version` posts to the version-agnostic `/predictions`
    // endpoint carrying the version id, and a bare `owner/name` posts to the
    // model's own endpoint and takes whatever `latest_version` is.
    const target = replicatePredictionTarget(model, request.versionId);
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

  // The provenance the SETTLED prediction carries. Spread rather than assigned
  // so a response without a `version` echo reports no field at all instead of an
  // explicit undefined — absent means "the provider did not say", which is a
  // different fact from "it ran an empty version".
  const provenance = {
    predictionId: prediction.id,
    ...(prediction.version ? { executedVersionId: prediction.version } : {}),
  };

  if (prediction.status !== "succeeded" && outputUrl(prediction.output) === null) {
    return { ok: false, ...provenance, error: `replicate ${prediction.status}: ${predictionError(prediction.error)}` };
  }

  const url = outputUrl(prediction.output);
  if (!url) return { ok: false, ...provenance, error: "replicate returned no image" };
  try {
    return { ok: true, ...provenance, image: await downloadReplicateOutput(url) };
  } catch (err) {
    return { ok: false, ...provenance, error: errorText(err) };
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

/**
 * The prediction budget, in the capabilities spec's order: the request's own
 * value (a profile's `timeoutMs`), then `REPLICATE_PREDICTION_TIMEOUT_MS`, then
 * the five-minute default.
 *
 * A requested value is CLAMPED into the sane band rather than rejected — the
 * caller asked for a budget and deserves the nearest one it may have — while an
 * env value below the floor still falls through to the default, which is the
 * behavior operators have today and the one the existing tests pin.
 */
function predictionTimeoutMs(requested?: number): number {
  if (requested !== undefined && Number.isFinite(requested)) {
    return Math.min(Math.max(requested, 30_000), 30 * 60_000);
  }
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
