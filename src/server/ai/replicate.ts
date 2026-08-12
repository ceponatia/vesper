import { z } from "zod";
import { fitReferences, type ImageModel } from "@vesper/image-core";
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

/**
 * One structural control image and the provider input it was bound to.
 *
 * The field is resolved upstream from the version's `additionalImageInputs`
 * (`planImageRender`); this module never derives it. That is the same division
 * `controlInput` follows — alias discovery happens once, in the probe, and the
 * transport writes what it was told.
 */
export interface RenderControlReference {
  field: string;
  /** `single` writes one URI; `array` writes a list, matching the declared schema. */
  arity: "single" | "array";
  buffers: Buffer[];
}

export interface RegistryModelRequest {
  prompt: string;
  /** Ordered identity/location references; trimmed to what the model accepts. */
  references?: Buffer[];
  /**
   * Structural controls that have their own provider input, already bound to a
   * field name.
   *
   * They travel the same transport as `references` — uploaded as short-lived
   * files, or inlined for a `data_url` model — but they are NOT subject to
   * `fitReferences`, because the primary field's capacity says nothing about how
   * many images a separate `pose_image` input takes. Their own arity, resolved
   * from the schema that declared them, is the limit, and it was applied before
   * this call.
   */
  controlReferences?: RenderControlReference[];
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
export const DATA_URL_BUDGET_BYTES = 6 * 1024 * 1024;

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
  const controls = request.controlReferences ?? [];
  // A bound control image is an input image: an edit-only model handed nothing
  // but a pose map has something to work from, and refusing it here would make
  // the dedicated-input path unusable on exactly the models it exists for.
  if (references.length === 0 && controls.length === 0 && !model.canGenerate) {
    return { ok: false, error: `${model.slug} requires at least one reference image` };
  }
  const controlBuffers = controls.flatMap((control) => control.buffers);

  if (model.referenceTransport === "data_url") {
    const reserved = controlBuffers.reduce((total, buffer) => total + buffer.byteLength, 0);
    const inlined = withinDataUrlBudget(references, reserved);
    if (inlined.length < references.length) {
      sink?.push(
        diag("warn", "image_model.references_trimmed", "dropped references that did not fit the inline byte budget", {
          path: "image_models",
          context: { slug: model.slug, sent: inlined.length, requested: references.length, reservedBytes: reserved },
        }),
      );
    }
    return await runReplicateImageModel(
      model.slug,
      buildPayload(model, request, inlined.map(referenceDataUrl), controlUris(controls, controlBuffers.map(referenceDataUrl)), sink),
      request,
    );
  }

  const uploads: ReplicateFile[] = [];
  try {
    // One numbering across both lists so a Replicate file name is unique within
    // the run; the control images upload last so a reference's name stays what it
    // was before controls existed.
    for (const [index, buffer] of [...references, ...controlBuffers].entries()) {
      const upload = await uploadReplicateFile(buffer, `vesper-reference-${index + 1}.webp`);
      if (!upload.ok) return { ok: false, error: upload.error };
      uploads.push(upload.file);
    }
    // Split back POSITIONALLY, on the same order they were uploaded in. Keying a
    // lookup by buffer would collapse two identical control images onto one URL.
    const urls = uploads.map((file) => file.url);
    return await runReplicateImageModel(
      model.slug,
      buildPayload(model, request, urls.slice(0, references.length), controlUris(controls, urls.slice(references.length)), sink),
      request,
    );
  } finally {
    await Promise.allSettled(uploads.map((file) => deleteReplicateFile(file.id)));
  }
}

/**
 * Build the prediction input for one transport: the ordinary payload, the bound
 * control fields written over it, then the caller's control overlay.
 *
 * Shared by both transports so the field-writing rules have one home. The ORDER
 * matters and is the capabilities spec's: controls are structural inputs the
 * render path owns, so they are written before `controlInput`, whose overlay
 * refuses reserved fields but is otherwise a later layer that wins.
 */
function buildPayload(
  model: ImageModel,
  request: RegistryModelRequest,
  referenceUris: readonly string[],
  controls: readonly { field: string; value: string | string[] }[],
  sink?: DiagnosticSink,
): Record<string, unknown> {
  const built = buildRegistryModelInput(model, request.prompt, referenceUris, request.aspect);
  const reserved = new Set(reservedImageInputFields(model));
  const refused: string[] = [];
  for (const control of controls) {
    // The same rule the override overlay follows, for the same reason: a probe
    // that recorded an image input named `prompt` (or the aspect key) would
    // otherwise have the control image overwrite what the render path itself
    // wrote. The binding step already rules out the primary reference field.
    if (reserved.has(control.field)) {
      refused.push(control.field);
      continue;
    }
    built[control.field] = control.value;
  }
  if (refused.length > 0) {
    sink?.push(
      diag("warn", "image_model.control_field_reserved", "a bound control image named a render-path field", {
        path: "image_models",
        context: { slug: model.slug, fields: refused.sort() },
      }),
    );
  }
  return overlayControlInput(built, request.controlInput, model, sink);
}

/**
 * Each bound control's field and the URI(s) its declared arity calls for.
 *
 * `uris` is the control images' URIs in the SAME order the controls list their
 * buffers — the order they were inlined or uploaded in — and is walked with a
 * cursor rather than matched by buffer, so two byte-identical control images
 * stay two images.
 */
function controlUris(
  controls: readonly RenderControlReference[],
  uris: readonly string[],
): { field: string; value: string | string[] }[] {
  let cursor = 0;
  return controls.flatMap((control) => {
    const taken = uris.slice(cursor, cursor + control.buffers.length);
    cursor += control.buffers.length;
    if (taken.length === 0) return [];
    // An `array` field takes the list even at one image — the schema declared a
    // list, and a bare string where a list is expected is a validation failure,
    // not a convenience. A `single` field takes the first and only image the
    // binding step allowed through.
    const value: string | string[] = control.arity === "array" ? [...taken] : (taken[0] ?? "");
    return [{ field: control.field, value }];
  });
}

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

export function unwrapReplicateImage(result: ReplicateImageResult, fallback: string): Buffer {
  if (!result.ok || !result.image) throw new Error(result.error || fallback);
  return result.image;
}

/**
 * One image-in, image-out PREPROCESSOR run — a pose skeleton renderer, a depth
 * estimator (qwen-advanced-image-subsystem.spec.md §"Control extraction").
 *
 * It is a separate entry point rather than a registry model with a profile
 * because a preprocessor is a LAB TOOL, not something a player can be rendered
 * with: it has no prompt, no aspect, no reference arity, no quality overlay and
 * no picker, and registering one would put a skeleton renderer in every image
 * model list in the app. What it shares with a render — the prediction shell,
 * the poll regime, the output-host allow-list, the file upload and its
 * best-effort delete — it shares by using the same code, so there is exactly one
 * place in Vesper that talks to `api.replicate.com`.
 *
 * The version pin is REQUIRED and has no floating fallback, unlike a production
 * render. A control fixture is evidence: a skeleton extracted by whatever the
 * provider called `latest_version` that hour cannot be compared against one
 * extracted last week, and the probe verdict it feeds would be about an unknown
 * extractor as much as about the model under test.
 *
 * There is NO retry loop, exactly as the render path has none: a preprocessor
 * that failed once has spent provider money, and spending it again
 * automatically is a decision for the admin looking at the failure, not for
 * this function.
 */
export interface ReplicatePreprocessorRequest {
  /** `owner/name` of the pinned preprocessor — recorded, and shape-checked here. */
  slug: string;
  /** The EXACT provider version to execute. Never optional (see above). */
  versionId: string;
  /** The single source image, as stored (webp). */
  image: Buffer;
  /** The provider's own key for that image — `image` on both Stage 0 pins. */
  imageField: string;
  /**
   * Literal extra inputs this version needs, e.g. the thirteen switches that
   * turn every preprocessor but one OFF on a multi-preprocessor cog. Written
   * BEFORE the image field, so a stray key can never displace the source.
   */
  input?: Record<string, unknown>;
  /** Which member of an object output carries the produced map. */
  outputField?: string;
  /**
   * How the bytes travel. `file` (the default, and the house default for every
   * reference) uploads a private, short-lived Replicate file and deletes it as
   * soon as the prediction settles; `data_url` inlines them for a cog that
   * refuses uploaded-file URLs.
   */
  transport?: "file" | "data_url";
  /** This run's prediction budget; absent leaves it to the env/default. */
  timeoutMs?: number;
}

export async function runReplicatePreprocessor(request: ReplicatePreprocessorRequest): Promise<ReplicateImageResult> {
  if (!hasReplicate()) return { ok: false, error: "REPLICATE_API_TOKEN not configured" };

  const run = (imageUrl: string): Promise<ReplicateImageResult> =>
    runReplicateImageModel(
      request.slug,
      { ...request.input, [request.imageField]: imageUrl },
      {
        versionId: request.versionId,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.outputField !== undefined ? { outputField: request.outputField } : {}),
      },
    );

  if (request.transport === "data_url") return run(referenceDataUrl(request.image));

  const upload = await uploadReplicateFile(request.image, "vesper-preprocessor-source.webp");
  if (!upload.ok) return { ok: false, error: upload.error };
  try {
    return await run(upload.file.url);
  } finally {
    await deleteReplicateFile(upload.file.id).catch(() => undefined);
  }
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
 * The run-shaping fields the prediction shell owns — never the payload, which
 * its callers have already built and merged.
 *
 * A structural interface rather than a `Pick<RegistryModelRequest, …>` because
 * two different callers now share the shell: a registry render, whose request
 * happens to carry these fields among many others, and
 * {@link runReplicatePreprocessor}, which has no prompt, no references and no
 * aspect to speak of. `outputField` exists for the second: a preprocessor may
 * answer with an OBJECT of several maps (Depth Anything v2 returns
 * `grey_depth` and `color_depth`), and the caller is the only party that knows
 * which of them it asked for.
 */
interface PredictionRunOptions {
  timeoutMs?: number;
  versionId?: string;
  /** Read the image URL off THIS field when the output is an object. */
  outputField?: string;
}

/**
 * The prediction shell. `request` supplies only the run-shaping fields it owns
 * — the payload is already built and merged by the caller, so nothing here can
 * change WHAT is sent, only where, for how long, and which part of the answer
 * is the image.
 */
async function runReplicateImageModel(
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
  while (!isTerminal(prediction.status) && pickOutput(prediction.output) === null) {
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

  if (prediction.status !== "succeeded" && pickOutput(prediction.output) === null) {
    return { ok: false, ...provenance, error: `replicate ${prediction.status}: ${predictionError(prediction.error)}` };
  }

  const url = pickOutput(prediction.output);
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

/**
 * The image URL in a prediction's output.
 *
 * `field` names a member of an OBJECT output, which is how the multi-map
 * preprocessors answer (`{ grey_depth, color_depth }`). It is applied ONLY to
 * an object: a caller that named a field and got a bare string or an array
 * still gets that image rather than null, because "the model answered in the
 * ordinary shape" is a better outcome than refusing an image that is plainly
 * there. A field naming a member that does not exist reads as no output, which
 * is the honest answer — the caller asked for a map this version does not
 * produce.
 */
function outputUrl(output: unknown, field?: string): string | null {
  if (field !== undefined && typeof output === "object" && output !== null && !Array.isArray(output)) {
    return outputUrl((output as Record<string, unknown>)[field]);
  }
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
