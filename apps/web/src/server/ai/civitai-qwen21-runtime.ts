import type { ImageModel } from "@vesper/image-core";
import { CIVITAI_QWEN_IMAGE_21_SLUG } from "@vesper/image-models";
import type { RegistryModelRequest, ReplicateImageResult } from "@vesper/image-replicate";
import {
  CIVITAI_CFG_SCALE_FIELD,
  CIVITAI_LORA_STRENGTH_FIELD,
  CIVITAI_LORA_VERSION_FIELD,
  CIVITAI_MAX_NEGATIVE_PROMPT_CHARS,
  CIVITAI_NEGATIVE_PROMPT_FIELD,
  CIVITAI_STEPS_FIELD,
  type CivitaiLane,
  type CivitaiLaneRequest,
  type CivitaiWorkflow,
  type CivitaiWorkflowResult,
  civitaiSelectedLora,
  civitaiWorkflowEnvelope,
  runCivitaiLane,
  validateCivitaiPreflightEcho,
} from "./civitai-runtime";

/**
 * Civitai's Qwen Image 2.1 lane: `engine: "comfy"`, `ecosystem: "qwen"`,
 * `model: "2.1"`.
 *
 * This is NOT the Qwen-Image 20B `sdcpp` lane (`model: "20b"` with a `version`)
 * and not Klein's `flux2` engine. It has no `version`, `modelVersion`,
 * `sampleMethod`/`schedule` or prompt-expansion field; it samples through
 * Comfy's own `sampler`/`scheduler` names. One checkpoint both generates and
 * edits: zero references send `createImage` with an explicit `width`/`height`,
 * and one to ten send `editImage` with `images` and a `resolution` pixel
 * budget — on edit the provider derives the output shape from the reference,
 * so an explicit width/height pair is ignored there and none is sent. A chosen
 * output shape on an edit is refused rather than recorded and not applied.
 *
 * The workflow omits `diffusionModel`, as Civitai's own generator does for the
 * hosted default checkpoint (Civitai model 2954443, version 3352534). That
 * version id is the catalog row's identity for provenance and LoRA
 * compatibility; the preflight echo does not report a checkpoint, so this lane
 * never claims one as executed.
 */


/** The hosted checkpoint's Civitai model-version id — the catalog row's `probed_version_id`. */
export const CIVITAI_QWEN_IMAGE_21_VERSION_ID = "3352534";

export const CIVITAI_QWEN21_SAMPLER_FIELD = "sampler";
export const CIVITAI_QWEN21_SCHEDULER_FIELD = "scheduler";
/** The normalized `resolution` tier control's field: `1K` or `2K`, never a pixel count. */
export const CIVITAI_QWEN21_RESOLUTION_FIELD = "resolution";

/** Comfy's sampler enum, as the lane's OpenAPI (`ComfySampler`) declares it. */
export const CIVITAI_QWEN21_SAMPLERS = [
  "euler", "euler_ancestral", "euler_cfg_pp", "euler_ancestral_cfg_pp", "heun", "heunpp2",
  "dpm_2", "dpm_2_ancestral", "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral",
  "dpmpp_2s_ancestral_cfg_pp", "dpmpp_sde", "dpmpp_sde_gpu", "dpmpp_2m", "dpmpp_2m_cfg_pp",
  "dpmpp_2m_sde", "dpmpp_2m_sde_gpu", "dpmpp_3m_sde", "dpmpp_3m_sde_gpu", "ddpm", "lcm",
  "ipndm", "ipndm_v", "deis", "ddim", "uni_pc", "uni_pc_bh2", "res_multistep", "er_sde",
] as const;
export type CivitaiQwen21Sampler = (typeof CIVITAI_QWEN21_SAMPLERS)[number];

/** Comfy's scheduler enum, as the lane's OpenAPI (`ComfyScheduler`) declares it. */
export const CIVITAI_QWEN21_SCHEDULERS = [
  "normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta",
] as const;
export type CivitaiQwen21Scheduler = (typeof CIVITAI_QWEN21_SCHEDULERS)[number];

/** The seven official aspect ratios the catalog row offers. */
export const CIVITAI_QWEN21_ASPECTS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"] as const;
export type CivitaiQwen21Aspect = (typeof CIVITAI_QWEN21_ASPECTS)[number];

export const CIVITAI_QWEN21_RESOLUTION_TIERS = ["1K", "2K"] as const;
export type CivitaiQwen21ResolutionTier = (typeof CIVITAI_QWEN21_RESOLUTION_TIERS)[number];

/**
 * What Vesper sends when a control is left blank: the official Qwen Image 2.1
 * sampling recipe (owner ruling 2026-09-30).
 *
 * The diffusers `QwenImage21Pipeline` defaults to 40 inference steps and a true
 * CFG of 1 — the model "is meant to be sampled without guidance" — and samples
 * with flow-matching Euler, which is Comfy's `euler` sampler on the `simple`
 * scheduler. The provider's own `steps` default is 25, so a blank field is
 * resolved here rather than left to it. 1K is the default size tier.
 */
export const CIVITAI_QWEN21_DEFAULTS = {
  cfgScale: 1,
  steps: 40,
  sampler: "euler",
  scheduler: "simple",
  resolution: "1K",
} as const satisfies {
  cfgScale: number;
  steps: number;
  sampler: CivitaiQwen21Sampler;
  scheduler: CivitaiQwen21Scheduler;
  resolution: CivitaiQwen21ResolutionTier;
};

/**
 * The bands each numeric control may be set to, refused rather than clamped.
 *
 * `cfgScale` is the provider's own 0–30. `steps` stops at 60 although the
 * provider takes 150: cost scales linearly with steps (create at 1024² costs 8
 * yellow Buzz at 25 steps and 13 at 40, measured 2026-09-30), so 60 is a cost
 * rail that still leaves room above the official 40. The LoRA strength band is
 * the provider's 0–4.
 */
export const CIVITAI_QWEN21_BANDS = {
  cfgScale: { minimum: 0, maximum: 30 },
  steps: { minimum: 1, maximum: 60 },
  loraStrength: { minimum: 0, maximum: 4 },
} as const;

const MAX_PROMPT_CHARS = 10_000;
const MAX_REFERENCES = 10;
const LANE_NAME = "Civitai Qwen Image 2.1";

/**
 * `aspect_ratio` × tier → create `width`/`height`: multiples of 32, never above
 * the lane's 2048 cap, and EXACTLY the advertised ratio. Exactness is load-
 * bearing: the catalog offers these as exact ratio options, so the render path
 * plans no crop for them (`chooseDimensions`) and returns the provider output
 * as-is — a near-miss size (1216×832 is 1.46:1, not 3:2) would be recorded as
 * `3:2` while the image was not. Non-square 2K sizes are therefore the largest
 * exact-ratio sizes on a 64-pixel grid inside the cap (1920×1280 for 3:2),
 * which sit below the checkpoint's native non-square 2K.
 */
const CREATE_SIZES: Record<CivitaiQwen21ResolutionTier, Record<CivitaiQwen21Aspect, { width: number; height: number }>> = {
  "1K": {
    "1:1": { width: 1024, height: 1024 },
    "4:3": { width: 1024, height: 768 },
    "3:4": { width: 768, height: 1024 },
    "3:2": { width: 1152, height: 768 },
    "2:3": { width: 768, height: 1152 },
    "16:9": { width: 1024, height: 576 },
    "9:16": { width: 576, height: 1024 },
  },
  "2K": {
    "1:1": { width: 2048, height: 2048 },
    "4:3": { width: 2048, height: 1536 },
    "3:4": { width: 1536, height: 2048 },
    "3:2": { width: 1920, height: 1280 },
    "2:3": { width: 1280, height: 1920 },
    "16:9": { width: 2048, height: 1152 },
    "9:16": { width: 1152, height: 2048 },
  },
};

/** Tier → edit `resolution`, the output pixel budget; the reference sets the aspect. */
const EDIT_RESOLUTION: Record<CivitaiQwen21ResolutionTier, number> = { "1K": 1024, "2K": 2048 };

const ALLOWED_CONTROLS = new Set<string>([
  "seed",
  CIVITAI_NEGATIVE_PROMPT_FIELD,
  CIVITAI_CFG_SCALE_FIELD,
  CIVITAI_STEPS_FIELD,
  CIVITAI_QWEN21_SAMPLER_FIELD,
  CIVITAI_QWEN21_SCHEDULER_FIELD,
  CIVITAI_QWEN21_RESOLUTION_FIELD,
  CIVITAI_LORA_VERSION_FIELD,
  CIVITAI_LORA_STRENGTH_FIELD,
]);

/**
 * The fields the preflight must echo back unchanged, per operation.
 *
 * `prompt` is compared verbatim on both: a provider that normalized, truncated
 * or dropped the prompt in its zero-Buzz answer would otherwise pass this gate
 * and reach the paid submit with text nobody authored.
 * `width`/`height` are compared on create only: on edit they are read-only and
 * inferred from the reference's aspect, so the echo carries values nobody sent.
 * `resolution` is compared on edit only, the one operation that sends it.
 */
const CREATE_ECHO_FIELDS = [
  "engine", "ecosystem", "model", "operation", "prompt", "width", "height", "quantity",
  "cfgScale", "steps", "sampler", "scheduler", "outputFormat",
] as const;
const EDIT_ECHO_FIELDS = [
  "engine", "ecosystem", "model", "operation", "prompt", "resolution", "quantity",
  "cfgScale", "steps", "sampler", "scheduler", "outputFormat",
] as const;

function isMember<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/**
 * The sampling settings this render will actually use: the operator's controls
 * where present, the official recipe where blank.
 *
 * Resolved in ONE place because three callers must agree on the answer — the
 * workflow builder, the preview, and the preflight echo check. A builder that
 * defaulted independently of the echo check could send one recipe and demand
 * another.
 */
export interface CivitaiQwen21Sampling {
  cfgScale: number;
  steps: number;
  sampler: CivitaiQwen21Sampler;
  scheduler: CivitaiQwen21Scheduler;
  resolution: CivitaiQwen21ResolutionTier;
  negativePrompt: string | null;
}

/** The size tier a request asked for, `1K` when blank; any other value is refused. */
export function civitaiQwen21ResolutionTier(controls: CivitaiLaneRequest["controlInput"]): CivitaiQwen21ResolutionTier {
  const resolution = controls?.[CIVITAI_QWEN21_RESOLUTION_FIELD] ?? CIVITAI_QWEN21_DEFAULTS.resolution;
  if (!isMember(CIVITAI_QWEN21_RESOLUTION_TIERS, resolution)) {
    throw new Error(`${LANE_NAME} resolution must be one of: ${CIVITAI_QWEN21_RESOLUTION_TIERS.join(", ")}`);
  }
  return resolution;
}

export function resolveCivitaiQwen21Sampling(controls: CivitaiLaneRequest["controlInput"]): CivitaiQwen21Sampling {
  const cfgScale = controls?.[CIVITAI_CFG_SCALE_FIELD] ?? CIVITAI_QWEN21_DEFAULTS.cfgScale;
  const steps = controls?.[CIVITAI_STEPS_FIELD] ?? CIVITAI_QWEN21_DEFAULTS.steps;
  const sampler = controls?.[CIVITAI_QWEN21_SAMPLER_FIELD] ?? CIVITAI_QWEN21_DEFAULTS.sampler;
  const scheduler = controls?.[CIVITAI_QWEN21_SCHEDULER_FIELD] ?? CIVITAI_QWEN21_DEFAULTS.scheduler;
  const resolution = civitaiQwen21ResolutionTier(controls);
  const negativePrompt = controls?.[CIVITAI_NEGATIVE_PROMPT_FIELD];
  const { cfgScale: cfgBand, steps: stepsBand } = CIVITAI_QWEN21_BANDS;

  if (typeof cfgScale !== "number" || !Number.isFinite(cfgScale) ||
      cfgScale < cfgBand.minimum || cfgScale > cfgBand.maximum) {
    throw new Error(`${LANE_NAME} cfgScale must be a number between ${String(cfgBand.minimum)} and ${String(cfgBand.maximum)}`);
  }
  if (typeof steps !== "number" || !Number.isSafeInteger(steps) ||
      steps < stepsBand.minimum || steps > stepsBand.maximum) {
    throw new Error(`${LANE_NAME} steps must be an integer between ${String(stepsBand.minimum)} and ${String(stepsBand.maximum)}`);
  }
  if (!isMember(CIVITAI_QWEN21_SAMPLERS, sampler)) {
    throw new Error(`${LANE_NAME} sampler must be one of Comfy's samplers (${CIVITAI_QWEN21_SAMPLERS.join(", ")})`);
  }
  if (!isMember(CIVITAI_QWEN21_SCHEDULERS, scheduler)) {
    throw new Error(`${LANE_NAME} scheduler must be one of: ${CIVITAI_QWEN21_SCHEDULERS.join(", ")}`);
  }
  if (negativePrompt !== undefined) {
    if (typeof negativePrompt !== "string") throw new Error(`${LANE_NAME} negative prompt must be a string`);
    if (negativePrompt.length > CIVITAI_MAX_NEGATIVE_PROMPT_CHARS) {
      throw new Error(`${LANE_NAME} negative prompts are limited to ${String(CIVITAI_MAX_NEGATIVE_PROMPT_CHARS)} characters`);
    }
  }

  // Inert by construction: Qwen Image 2.1 applies a negative prompt only under
  // true CFG, and the official pipeline ignores `negative_prompt` unless
  // `true_cfg_scale > 1`. Sending one at 1 or below bills a setting that does
  // nothing, so the pair is refused and the refusal names the fix.
  const trimmedNegative = typeof negativePrompt === "string" && negativePrompt.trim() !== "" ? negativePrompt : null;
  if (trimmedNegative !== null && cfgScale <= 1) {
    throw new Error(`${LANE_NAME} ignores a negative prompt at cfgScale 1 or below; raise cfgScale above 1 or clear the negative prompt`);
  }

  return { cfgScale, steps, sampler, scheduler, resolution, negativePrompt: trimmedNegative };
}

/** The create size for an aspect and tier; a blank aspect is the row's 1:1 default. */
export function civitaiQwen21Dimensions(
  aspect: string | null | undefined,
  tier: CivitaiQwen21ResolutionTier = CIVITAI_QWEN21_DEFAULTS.resolution,
): { width: number; height: number } {
  const ratio = aspect ?? "1:1";
  if (!isMember(CIVITAI_QWEN21_ASPECTS, ratio)) {
    throw new Error(`${LANE_NAME} supports only aspect ratios ${CIVITAI_QWEN21_ASPECTS.join(", ")}`);
  }
  return CREATE_SIZES[tier][ratio];
}

/** The edit pixel budget for a tier. */
export function civitaiQwen21EditResolution(tier: CivitaiQwen21ResolutionTier): number {
  return EDIT_RESOLUTION[tier];
}

export function validateCivitaiQwen21Request(model: Pick<ImageModel, "slug">, request: CivitaiLaneRequest): void {
  if (model.slug !== CIVITAI_QWEN_IMAGE_21_SLUG) throw new Error("Unsupported Civitai image model");
  if (request.versionId !== undefined && request.versionId !== CIVITAI_QWEN_IMAGE_21_VERSION_ID) {
    throw new Error(`${LANE_NAME} runs the hosted ${CIVITAI_QWEN_IMAGE_21_VERSION_ID} checkpoint; the requested version does not match`);
  }
  if (request.prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`${LANE_NAME} prompts are limited to ${String(MAX_PROMPT_CHARS)} characters`);
  }
  for (const key of Object.keys(request.controlInput ?? {})) {
    if (!ALLOWED_CONTROLS.has(key)) {
      const named = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ? ` ${key}` : "";
      throw new Error(`${LANE_NAME} received an unsupported control${named}`);
    }
  }
  const seed = request.controlInput?.seed;
  if (seed !== undefined && (typeof seed !== "number" || !Number.isSafeInteger(seed))) {
    throw new Error(`${LANE_NAME} seed must be a safe integer`);
  }
  const lora = civitaiSelectedLora(request.controlInput);
  const strengthBand = CIVITAI_QWEN21_BANDS.loraStrength;
  if (lora && (lora.strength < strengthBand.minimum || lora.strength > strengthBand.maximum)) {
    throw new Error(`${LANE_NAME} LoRA strength must be between ${String(strengthBand.minimum)} and ${String(strengthBand.maximum)}`);
  }
  const sampling = resolveCivitaiQwen21Sampling(request.controlInput);
  // Membership is judged on every request. Whether a chosen aspect may be sent
  // at all depends on the reference count, which only the builder knows.
  civitaiQwen21Dimensions(request.aspect, sampling.resolution);
}

export function civitaiQwen21Workflow(
  model: Pick<ImageModel, "slug">,
  request: CivitaiLaneRequest,
  references: readonly string[] = [],
  loras?: Readonly<Record<string, number>>,
): CivitaiWorkflow {
  validateCivitaiQwen21Request(model, request);
  if (references.length > MAX_REFERENCES) {
    throw new Error(`${LANE_NAME} accepts at most ${String(MAX_REFERENCES)} reference images`);
  }
  // Transport defense-in-depth, not the render path's own guard against this
  // (#663/#664). An edit sends no size — the provider sizes it from the
  // reference and ignores an explicit width/height — so a chosen shape here
  // would be neither sent nor applied while the run record still claimed it.
  // `chooseDimensions` (`@vesper/image-core`, `imageModelEditSizesFromReference`)
  // now asks for no shape at all on this lane's edit whenever a render names a
  // non-null target ratio, and `renderWithModel` crops the RETURNED pixels
  // toward that target instead of expecting the provider to honor a shape it
  // cannot accept — so a production or Generator render should never reach
  // this branch with a non-null `request.aspect` on an edit any more. It stays
  // as the one place that still refuses rather than silently drops one, in
  // case a future caller builds a workflow directly and skips that seam.
  if (references.length > 0 && request.aspect !== null && request.aspect !== undefined) {
    throw new Error(`${LANE_NAME} sizes an edit from its reference; clear the output shape or remove the references`);
  }
  const seed = request.controlInput?.seed;
  const sampling = resolveCivitaiQwen21Sampling(request.controlInput);
  const editing = references.length > 0;
  return civitaiWorkflowEnvelope({
    engine: "comfy",
    ecosystem: "qwen",
    model: "2.1",
    operation: editing ? "editImage" : "createImage",
    prompt: request.prompt,
    ...(editing
      ? { resolution: civitaiQwen21EditResolution(sampling.resolution), images: [...references] }
      : civitaiQwen21Dimensions(request.aspect, sampling.resolution)),
    quantity: 1,
    cfgScale: sampling.cfgScale,
    steps: sampling.steps,
    sampler: sampling.sampler,
    scheduler: sampling.scheduler,
    outputFormat: "jpeg",
    loras: loras ?? {},
    ...(sampling.negativePrompt === null ? {} : { [CIVITAI_NEGATIVE_PROMPT_FIELD]: sampling.negativePrompt }),
    ...(seed === undefined ? {} : { seed }),
  });
}

/**
 * The lane half of the preflight echo check: engine identity, operation, shape
 * and every sampling field, compared field by field. The shared half (seed,
 * negative prompt by presence and value, reference count, LoRA map) follows it.
 */
function qwen21StepEcho(echoed: Record<string, unknown> | null, wanted: Record<string, unknown>): string | null {
  if (!echoed) return `Civitai preflight did not echo the requested ${LANE_NAME} input`;
  const fields = wanted.operation === "editImage" ? EDIT_ECHO_FIELDS : CREATE_ECHO_FIELDS;
  for (const key of fields) {
    if (echoed[key] !== wanted[key]) return `Civitai preflight changed or omitted requested field ${key}`;
  }
  return null;
}

const CIVITAI_QWEN21_LANE: CivitaiLane = {
  name: LANE_NAME,
  maxReferences: MAX_REFERENCES,
  loraFamily: {
    baseModel: "Qwen 2.1",
    airEcosystem: "qwen21",
    // The Qwen-Image 20B family (2509/2511/2512) reports plain "Qwen"; its
    // LoRAs are the likeliest mis-curation, and the provider accepts them here.
    siblings: { Qwen: "20B-family" },
  },
  validate: validateCivitaiQwen21Request,
  workflow: civitaiQwen21Workflow,
  stepEcho: qwen21StepEcho,
};

/** The Qwen Image 2.1 echo check: workflow policy, this lane's fields, then the shared ones. */
export function validateCivitaiQwen21PreflightEcho(actual: CivitaiWorkflowResult, expected: CivitaiWorkflow): string | null {
  return validateCivitaiPreflightEcho(actual, expected, CIVITAI_QWEN21_LANE);
}

/** Metadata lookup happens only at send; previews identify that unresolved AIR dependency. */
export function previewCivitaiQwen21Request(
  model: Pick<ImageModel, "slug">,
  request: CivitaiLaneRequest,
  referenceCount = 0,
): Record<string, unknown> {
  validateCivitaiQwen21Request(model, request);
  if (!Number.isInteger(referenceCount) || referenceCount < 0 || referenceCount > MAX_REFERENCES) {
    throw new Error(`${LANE_NAME} accepts zero to ${String(MAX_REFERENCES)} reference images`);
  }
  const selected = civitaiSelectedLora(request.controlInput);
  const references = Array.from({ length: referenceCount }, (_unused, index) =>
    `https://placeholder.invalid/reference-${String(index + 1)}`);
  return {
    ...civitaiQwen21Workflow(model, request, references),
    externalId: "generated-for-each-request",
    ...(selected ? { loraAirResolution: { modelVersionId: selected.version, strength: selected.strength } } : {}),
  };
}

/**
 * The provider field/value pair this lane writes for image shape: the create
 * size, or the edit pixel budget — the reference, not the request, sets an
 * edit's aspect.
 */
export function civitaiQwen21SentShape(input: {
  aspect: string | null;
  controlInput?: Readonly<Record<string, unknown>>;
  referenceCount: number;
}): { field: string; value: unknown } {
  const resolution = civitaiQwen21ResolutionTier(input.controlInput);
  if (input.referenceCount > 0) {
    return { field: CIVITAI_QWEN21_RESOLUTION_FIELD, value: civitaiQwen21EditResolution(resolution) };
  }
  const { width, height } = civitaiQwen21Dimensions(input.aspect, resolution);
  return { field: "width,height", value: `${String(width)}x${String(height)}` };
}

export async function runCivitaiQwen21ImageModel(model: ImageModel, request: RegistryModelRequest): Promise<ReplicateImageResult> {
  return runCivitaiLane(CIVITAI_QWEN21_LANE, model, request);
}
