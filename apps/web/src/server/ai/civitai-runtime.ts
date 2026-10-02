import { randomUUID } from "node:crypto";
import { declaresNonAutomaticRetry, type ImageModel } from "@vesper/image-core";
import { CIVITAI_FLUX2_KLEIN4B_SLUG } from "@vesper/image-models";
import type { RegistryModelRequest, ReplicateImageResult } from "@vesper/image-replicate";
import { log } from "@/server/log";
import { civitaiApiToken } from "../images/lora-credentials";
import { CivitaiError, civitaiAsyncFailure, civitaiGetRetryDelay, civitaiHttpFailure, civitaiInsufficientBuzzFailure, civitaiOutputFailure, civitaiOutputUndeliveredFailure, civitaiReasonCodes, civitaiRetryableStatus, civitaiSubmitUnconfirmedFailure, civitaiTransportFailure, civitaiValidationPaths, civitaiValidationReason } from "./civitai-errors";

/** A documented variant selector, not an immutable numeric checkpoint revision. */
export const CIVITAI_KLEIN_4B_VERSION_ID = "4b";
export const CIVITAI_LORA_VERSION_FIELD = "civitai_lora_version";
export const CIVITAI_LORA_STRENGTH_FIELD = "civitai_lora_strength";
export const CIVITAI_CFG_SCALE_FIELD = "cfgScale";
export const CIVITAI_STEPS_FIELD = "steps";

/**
 * The provider spells its negative prompt in camelCase, and DROPS any other
 * spelling without complaint.
 *
 * Migration 0145 declared `negative_prompt` for the retired website graph. A
 * 2026-09-16 probe sent both spellings to the v2 workflow endpoint: only
 * `negativePrompt` came back in the preflight echo, while `negative_prompt` was
 * discarded exactly as an invented field name was. A snake_case binding here
 * would therefore not error — it would render without the negative prompt the
 * operator configured, and the echo would look correct because the field simply
 * would not appear on either side.
 */
export const CIVITAI_NEGATIVE_PROMPT_FIELD = "negativePrompt";
const WORKFLOWS_URL = "https://orchestration.civitai.com/v2/consumer/workflows";
const BLOBS_URL = "https://orchestration.civitai.com/v2/consumer/blobs";
const MODEL_VERSIONS_URL = "https://civitai.com/api/v1/model-versions";
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * The per-attempt budget shared by both workflow POSTs — the what-if
 * preflight (including its one automatic retry, #672) and the paid submit
 * (#673) — SCALED to how many reference images are actually in the body
 * being sent: {@link CIVITAI_WORKFLOW_POST_BASE_TIMEOUT_MS} plus
 * {@link CIVITAI_WORKFLOW_POST_PER_REFERENCE_TIMEOUT_MS} per reference,
 * capped at {@link CIVITAI_WORKFLOW_POST_MAX_TIMEOUT_MS}
 * ({@link civitaiWorkflowPostTimeoutMs}). Every other stage keeps the 30 s
 * {@link REQUEST_TIMEOUT_MS} budget.
 *
 * #672 fixed this at a flat 120 s after all 8 reference-view preflights in
 * one production batch failed together at 30.4-30.9 s against the previous
 * 30 s budget, before any paid submit. That flat rule then failed on its own
 * reference-heavy requests: a 2026-10-01 zero-Buzz what-if probe sent the
 * Qwen Image 2.1 lane's exact `editImage` body and measured latency scaling
 * with reference count, independent of bytes — 1 reference 18.8 s, 3
 * references 62.0, 67.0 and 62.4 s, about 20 s per reference — see
 * eval-images/civitai-qwen-2-1/whatif-669-reference-count-2026-10-01.txt
 * (#680). Production has measured slower than local probes (#672), so the
 * per-reference allowance below is twice that measured cost. The base keeps
 * #672's 120 s for a request with no references, and the 480 s ceiling binds
 * only at 10 references — Qwen 2.1's `MAX_REFERENCES`
 * (civitai-qwen21-runtime.ts); Klein's own 2-reference cap never reaches it.
 *
 * The paid submit shares the identical budget rather than its own, smaller
 * one: it carries the same references the preflight just ingested, in the
 * same body shape, so whatever makes a preflight run long can equally make
 * the submit run long. A submit that times out at this budget is handled by
 * the lost-answer lookup below, never by repeating the POST.
 */
const CIVITAI_WORKFLOW_POST_BASE_TIMEOUT_MS = 120_000;
/** Twice the ~20 s/reference measured cost — see {@link CIVITAI_WORKFLOW_POST_BASE_TIMEOUT_MS} — since production has measured slower than the local probe that found it. */
const CIVITAI_WORKFLOW_POST_PER_REFERENCE_TIMEOUT_MS = 40_000;
/** Binds only at 10 references, Qwen 2.1's own maximum — see {@link CIVITAI_WORKFLOW_POST_BASE_TIMEOUT_MS}. */
const CIVITAI_WORKFLOW_POST_MAX_TIMEOUT_MS = 480_000;

/**
 * The per-attempt POST budget for a workflow body carrying `referenceCount`
 * reference images (#680) — see {@link CIVITAI_WORKFLOW_POST_BASE_TIMEOUT_MS}
 * for the rule and its measurement. A negative or non-integer count is
 * floored and clamped to zero rather than refused: a caller's own bug in
 * counting references should not ALSO crash the timeout computation.
 */
export function civitaiWorkflowPostTimeoutMs(referenceCount: number): number {
  const count = Number.isFinite(referenceCount) ? Math.max(0, Math.floor(referenceCount)) : 0;
  return Math.min(
    CIVITAI_WORKFLOW_POST_BASE_TIMEOUT_MS + count * CIVITAI_WORKFLOW_POST_PER_REFERENCE_TIMEOUT_MS,
    CIVITAI_WORKFLOW_POST_MAX_TIMEOUT_MS,
  );
}

/**
 * The lost-submit-answer lookup (#673): how many read-only rounds Vesper
 * searches the workflow list for a paid submit whose own answer it could not
 * read, before giving up and naming the loss rather than repeating the POST.
 *
 * Two rounds, not one: the live-evidence comment on #673 measured the
 * workflow list answering in 0.3-0.4 s and a workflow appearing in it
 * immediately after a normal submit, but a submit whose OWN answer was lost
 * (timeout, 5xx, a malformed body) is exactly the case where Civitai's own
 * processing may still be catching up. A single immediate check would read
 * "not there yet" as "never happened." Two rounds, spaced out, trade a little
 * latency against that false negative without searching indefinitely.
 */
const CIVITAI_SUBMIT_LOOKUP_ROUNDS = 2;
/** Round 1 waits this long first, so a workflow the provider only just accepted has time to settle into the list. */
const CIVITAI_SUBMIT_LOOKUP_SETTLE_DELAY_MS = 5_000;
/** Round 2 (and any later round) waits this long after the previous one. */
const CIVITAI_SUBMIT_LOOKUP_ROUND_INTERVAL_MS = 30_000;
/** Page size for each workflow-list read; the live-evidence comment confirms the provider accepts up to 100. */
const CIVITAI_SUBMIT_LOOKUP_PAGE_TAKE = 100;
/** Bound on `next`-cursor pages followed within one round, so a pathological or looping cursor cannot turn one round into an unbounded scan. */
const CIVITAI_SUBMIT_LOOKUP_MAX_PAGES = 3;
/**
 * `fromDate` is anchored this far before the submit actually started, to
 * absorb clock skew between this process and the provider rather than risk
 * excluding the very workflow being searched for.
 */
const CIVITAI_SUBMIT_LOOKUP_CLOCK_SKEW_MS = 5 * 60 * 1000;

const MAX_REFERENCES = 2;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const ALLOWED_CONTROLS = new Set([
  "seed", CIVITAI_LORA_VERSION_FIELD, CIVITAI_LORA_STRENGTH_FIELD,
  CIVITAI_CFG_SCALE_FIELD, CIVITAI_STEPS_FIELD, CIVITAI_NEGATIVE_PROMPT_FIELD,
]);

/**
 * The band each sampling control may be set to, refused rather than clamped.
 *
 * The ceilings are cost rails as much as quality rails: Civitai prices this
 * workflow off both knobs, and a 2026-09-16 measurement put an 832x1248 create
 * at 2 Buzz for 4 steps, 3 for 8, 6 for 20, and 12 for 20 steps at CFG 5 —
 * guidance above 1 runs a second unconditional pass and doubles the bill. A
 * typo'd 200 steps is a configuration mistake, and spending forty times the
 * intended Buzz on it is worse than refusing the render.
 */
const CIVITAI_CFG_SCALE_RANGE = { minimum: 1, maximum: 8 } as const;
const CIVITAI_STEPS_RANGE = { minimum: 1, maximum: 40 } as const;
/**
 * The shared control contract's ceiling, restated rather than re-invented.
 *
 * `imageRenderControlsSchema.negativePrompt` is `z.string().max(2000)` and the
 * Generator's textarea sets `maxLength={2000}`, so a stricter transport bound
 * would refuse a value the UI and the shared request contract both call valid —
 * a pre-provider failure on input the operator was invited to type.
 *
 * This is NOT a provider limit. A 2026-09-16 probe sent 1000, 2000 and 4000
 * characters and the endpoint echoed each back unchanged and untruncated, so the
 * binding constraint is Vesper's own contract. An earlier 1000 here was copied
 * from the positive-prompt cap without provider evidence.
 */
export const CIVITAI_MAX_NEGATIVE_PROMPT_CHARS = 2000;

/**
 * The sampling recipe the DISTILLED Klein 4B checkpoint was trained to expect.
 *
 * Klein 4B is a distilled model: it carries no `guidance_embeds` and reaches its
 * target distribution in a handful of steps. Black Forest Labs' own reference
 * usage for `Flux2KleinPipeline` is `guidance_scale=1.0, num_inference_steps=4`.
 *
 * Vesper originally sent a conventional non-distilled recipe (CFG 5 / 20 steps).
 * That over-drives a distilled model, and a 2026-09-16 controlled comparison —
 * identical seed, prompt, aspect and LoRA, varying only these two values —
 * produced visibly over-cooked output with a stippled, beaded skin texture that
 * was present with AND without the LoRA. The values below removed it.
 *
 * They are also what the provider prices against: Civitai billed the 20-step
 * render at 12 Buzz and the 4-step render at 2.
 *
 * DEFAULTS, not fixed policy. The same comparison found no single recipe that
 * suits every render — 8 steps resolves multi-subject anatomy that 4 mangles,
 * and a negative prompt does nothing below guidance 2 — so an operator overrides
 * these through the `guidance` and `steps` controls migration 0148 binds. What
 * stays fixed is that {@link validateCivitaiPreflightEcho} demands back exactly
 * what {@link resolveCivitaiKleinSampling} resolved, default or override, so the
 * preflight still refuses a silent provider substitution.
 */
const CIVITAI_KLEIN_CFG_SCALE = 1;
const CIVITAI_KLEIN_STEPS = 4;

/**
 * How long a submitted workflow is waited on before Vesper gives up.
 *
 * This budget is spent on QUEUE time, not just render time. Civitai schedules
 * submits from the shared `low` priority pool Vesper does not pay to leave, and
 * measured waits on 2026-09-16 ranged from 3 s to 348 s for identical requests —
 * the render itself was 36-43 s. Abandoning the poll does not cancel or refund
 * the workflow, so a deadline shorter than the queue throws away an image the
 * account has already been billed for; one observed run succeeded at 390 s,
 * ninety seconds after the previous 300 s default had already reported a
 * `civitai_async_timeout`.
 *
 * Raised to outlast the provider's own lifecycle rather than race it. A caller
 * with a tighter budget still passes `timeoutMs` explicitly.
 */
const CIVITAI_DEFAULT_TIMEOUT_MS = 900_000;
const PENDING_STATUSES = new Set(["unassigned", "preparing", "scheduled", "processing"]);
const FAILED_STATUSES = new Set(["failed", "expired", "canceled"]);

type JsonRecord = Record<string, unknown>;

/** The request facts a lane validates and builds from; references travel separately. */
export type CivitaiLaneRequest = Pick<RegistryModelRequest, "prompt" | "aspect" | "controlInput" | "versionId">;
type KleinRequest = CivitaiLaneRequest;

/**
 * One Civitai orchestration workflow: the fixed payment and mature-content
 * policy around exactly one `imageGen` step. Every lane sends this envelope;
 * only the step input differs between engines.
 */
export interface CivitaiWorkflow {
  externalId: string;
  allowMatureContent: true;
  currencies: readonly ["yellow"];
  upgradeMode: "manual";
  tags: readonly ["vesper", "image-generator"];
  steps: readonly [{ $type: "imageGen"; input: JsonRecord }];
}
export type CivitaiKleinWorkflow = CivitaiWorkflow;

/**
 * The curated-LoRA family a lane accepts, judged against Civitai's own
 * model-version metadata before any preflight or spend.
 *
 * Civitai's orchestrator does NOT enforce this itself: a Qwen-Image 20B LoRA
 * submitted to the Qwen Image 2.1 lane was accepted and priced (measured
 * 2026-09-30). A mis-curated library row would therefore render a LoRA trained
 * for different weights under a record naming it, and this gate is the only
 * thing that stops it.
 */
export interface CivitaiLoraFamily {
  /** The exact `baseModel` the LoRA's `/api/v1/model-versions/{id}` metadata must report. */
  readonly baseModel: string;
  /** The AIR ecosystem segment: `urn:air:<airEcosystem>:lora:civitai:<modelId>@<versionId>`. */
  readonly airEcosystem: string;
  /** Operator-facing descriptions of sibling families a mis-curated row is likely to carry. */
  readonly siblings?: Readonly<Record<string, string>>;
}

/**
 * What one Civitai engine lane contributes beside the transport every lane
 * shares — submit, what-if preflight, the workflow-policy echo, polling, blob
 * download and diagnostics.
 */
export interface CivitaiLane {
  /** Operator-facing name, used in every refusal the lane raises. */
  readonly name: string;
  readonly maxReferences: number;
  readonly loraFamily: CivitaiLoraFamily;
  /** Refuses (throws) a request this lane cannot send; never clamps. */
  validate(model: Pick<ImageModel, "slug">, request: CivitaiLaneRequest): void;
  /** The workflow this request becomes, references as data URLs and LoRAs as an AIR map. */
  workflow(
    model: Pick<ImageModel, "slug">,
    request: CivitaiLaneRequest,
    references: readonly string[],
    loras?: Readonly<Record<string, number>>,
  ): CivitaiWorkflow;
  /**
   * The lane-specific half of the preflight echo check: the engine identity and
   * every sampling/shape field the lane sends. The shared half — seed, negative
   * prompt, reference count and LoRA map — runs after it for every lane.
   */
  stepEcho(echoed: JsonRecord | null, wanted: JsonRecord): string | null;
  /** The version the provider's echo confirms ran; absent when the echo cannot confirm one. */
  readonly executedVersionId?: string;
}

/** Wrap one step input in the fixed workflow policy, with a fresh external id. */
export function civitaiWorkflowEnvelope(input: JsonRecord): CivitaiWorkflow {
  return {
    externalId: randomUUID(),
    allowMatureContent: true,
    currencies: ["yellow"],
    upgradeMode: "manual",
    tags: ["vesper", "image-generator"],
    steps: [{ $type: "imageGen", input }],
  };
}

export interface CivitaiWorkflowResult {
  id: string;
  status: string;
  errors: string[];
  blocked: boolean;
  insufficient: boolean | null;
  mature: boolean | null;
  currencies: string[] | null;
  upgradeMode: string | null;
  input: JsonRecord | null;
  images: { id: string | null; available: boolean; hidden: boolean; blocked: string | null }[];
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isCivitaiHost(host: string): boolean {
  return host === "civitai.com" || host.endsWith(".civitai.com");
}

export function civitaiKleinDimensions(aspect: string | null | undefined): { width: number; height: number } {
  switch (aspect ?? "1:1") {
    case "1:1": return { width: 1024, height: 1024 };
    case "2:3": return { width: 832, height: 1248 };
    case "3:2": return { width: 1248, height: 832 };
    default: throw new Error("Civitai Klein supports only aspect ratios 1:1, 2:3, and 3:2");
  }
}

function loraVersionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^[1-9]\d*$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || !isCivitaiHost(url.hostname) || url.username || url.password) return null;
    const version = url.pathname.match(/^\/api\/download\/models\/([1-9]\d*)\/?$/)?.[1];
    return version && Number.isSafeInteger(Number(version)) ? version : null;
  } catch {
    return null;
  }
}

/** The curated LoRA a request selected, as its model-version id and strength; null when none. */
export function civitaiSelectedLora(controls: CivitaiLaneRequest["controlInput"]): { version: string; strength: number } | null {
  const locator = controls?.[CIVITAI_LORA_VERSION_FIELD];
  const strength = controls?.[CIVITAI_LORA_STRENGTH_FIELD];
  if (locator === undefined && strength === undefined) return null;
  const version = loraVersionId(locator);
  if (!version) throw new Error("Civitai LoRA selection did not resolve to a model-version id");
  if (typeof strength !== "number" || !Number.isFinite(strength)) {
    throw new Error("Civitai LoRA selection requires a finite numeric strength");
  }
  return { version, strength };
}

/**
 * The sampling settings this render will actually use: the operator's controls
 * where present, the distilled defaults where absent.
 *
 * Resolved in ONE place because three callers must agree on the answer — the
 * workflow builder, the preview, and {@link validateCivitaiPreflightEcho}, which
 * refuses a provider substitution by comparing the echo field by field. A
 * builder that defaulted independently of the echo check could send one recipe
 * and demand another.
 */
export interface CivitaiKleinSampling {
  cfgScale: number;
  steps: number;
  negativePrompt: string | null;
}

export function resolveCivitaiKleinSampling(controls: KleinRequest["controlInput"]): CivitaiKleinSampling {
  const cfgScale = controls?.[CIVITAI_CFG_SCALE_FIELD] ?? CIVITAI_KLEIN_CFG_SCALE;
  const steps = controls?.[CIVITAI_STEPS_FIELD] ?? CIVITAI_KLEIN_STEPS;
  const negativePrompt = controls?.[CIVITAI_NEGATIVE_PROMPT_FIELD];

  if (typeof cfgScale !== "number" || !Number.isFinite(cfgScale) ||
      cfgScale < CIVITAI_CFG_SCALE_RANGE.minimum || cfgScale > CIVITAI_CFG_SCALE_RANGE.maximum) {
    throw new Error(`Civitai Klein cfgScale must be a number between ${String(CIVITAI_CFG_SCALE_RANGE.minimum)} and ${String(CIVITAI_CFG_SCALE_RANGE.maximum)}`);
  }
  if (typeof steps !== "number" || !Number.isSafeInteger(steps) ||
      steps < CIVITAI_STEPS_RANGE.minimum || steps > CIVITAI_STEPS_RANGE.maximum) {
    throw new Error(`Civitai Klein steps must be an integer between ${String(CIVITAI_STEPS_RANGE.minimum)} and ${String(CIVITAI_STEPS_RANGE.maximum)}`);
  }
  if (negativePrompt !== undefined) {
    if (typeof negativePrompt !== "string") throw new Error("Civitai Klein negative prompt must be a string");
    if (negativePrompt.length > CIVITAI_MAX_NEGATIVE_PROMPT_CHARS) {
      throw new Error(`Civitai Klein negative prompts are limited to ${String(CIVITAI_MAX_NEGATIVE_PROMPT_CHARS)} characters`);
    }
  }

  // A negative prompt is INERT at guidance 1: with no unconditional branch there
  // is nothing to steer away from. Measured on 2026-09-16 — the same seed with
  // and without a negative prompt at cfgScale 1 produced pixel-identical output
  // while the provider echoed the field back both times. Accepting it here would
  // bill for a setting that demonstrably does nothing and report success, so the
  // combination is refused and names the fix.
  const trimmedNegative = typeof negativePrompt === "string" && negativePrompt.trim() !== "" ? negativePrompt : null;
  if (trimmedNegative !== null && cfgScale <= 1) {
    throw new Error("Civitai Klein ignores a negative prompt at cfgScale 1; raise cfgScale above 1 or clear the negative prompt");
  }

  return { cfgScale, steps, negativePrompt: trimmedNegative };
}

export function validateCivitaiKleinRequest(model: Pick<ImageModel, "slug">, request: KleinRequest): void {
  if (model.slug !== CIVITAI_FLUX2_KLEIN4B_SLUG) throw new Error("Unsupported Civitai image model");
  if (request.versionId !== undefined && request.versionId !== CIVITAI_KLEIN_4B_VERSION_ID) {
    throw new Error("Civitai Klein uses the documented 4b variant; the requested version does not match");
  }
  if (request.prompt.length > 1000) throw new Error("Civitai Klein prompts are limited to 1000 characters");
  for (const key of Object.keys(request.controlInput ?? {})) {
    if (!ALLOWED_CONTROLS.has(key)) throw new Error("Civitai Klein received an unsupported control");
  }
  const seed = request.controlInput?.seed;
  if (seed !== undefined && (typeof seed !== "number" || !Number.isSafeInteger(seed))) {
    throw new Error("Civitai Klein seed must be a safe integer");
  }
  civitaiSelectedLora(request.controlInput);
  resolveCivitaiKleinSampling(request.controlInput);
  civitaiKleinDimensions(request.aspect);
}

export function civitaiKleinWorkflow(
  model: Pick<ImageModel, "slug">,
  request: KleinRequest,
  references: readonly string[] = [],
  loras?: Readonly<Record<string, number>>,
): CivitaiKleinWorkflow {
  validateCivitaiKleinRequest(model, request);
  if (references.length > MAX_REFERENCES) throw new Error("Civitai Klein accepts at most 2 reference images");
  const seed = request.controlInput?.seed;
  const sampling = resolveCivitaiKleinSampling(request.controlInput);
  return civitaiWorkflowEnvelope({
    engine: "flux2",
    model: "klein",
    modelVersion: CIVITAI_KLEIN_4B_VERSION_ID,
    operation: references.length > 0 ? "editImage" : "createImage",
    prompt: request.prompt,
    ...civitaiKleinDimensions(request.aspect),
    quantity: 1,
    cfgScale: sampling.cfgScale,
    steps: sampling.steps,
    sampleMethod: "euler",
    schedule: "simple",
    outputFormat: "jpeg",
    enablePromptExpansion: false,
    loras: loras ?? {},
    ...(sampling.negativePrompt === null ? {} : { [CIVITAI_NEGATIVE_PROMPT_FIELD]: sampling.negativePrompt }),
    ...(seed === undefined ? {} : { seed }),
    ...(references.length === 0 ? {} : { images: references }),
  });
}

/** Metadata lookup happens only at send; previews identify that unresolved AIR dependency. */
export function previewCivitaiKleinRequest(
  model: Pick<ImageModel, "slug">,
  request: KleinRequest,
  referenceCount = 0,
): JsonRecord {
  validateCivitaiKleinRequest(model, request);
  if (!Number.isInteger(referenceCount) || referenceCount < 0 || referenceCount > MAX_REFERENCES) {
    throw new Error("Civitai Klein accepts zero, one, or two reference images");
  }
  const selected = civitaiSelectedLora(request.controlInput);
  const references = Array.from({ length: referenceCount }, (_unused, index) =>
    `https://placeholder.invalid/reference-${String(index + 1)}`);
  return {
    ...civitaiKleinWorkflow(model, request, references),
    externalId: "generated-for-each-request",
    ...(selected ? { loraAirResolution: { modelVersionId: selected.version, strength: selected.strength } } : {}),
  };
}

export function hasCivitai(): boolean {
  return civitaiApiToken() !== null;
}

/** Retain only documented provider tokens, never echoed prompts or signed URLs. */
function errorCodes(value: unknown): string[] {
  return civitaiReasonCodes(value);
}

const MAX_GET_RETRIES = 2;
/**
 * How many times the what-if preflight is POSTed again after a transport
 * failure or an HTTP 429/5xx (`civitaiRetryableStatus`) — exactly once, per
 * #672. A plain 4xx (including the 400 `resource_not_enabled`), a 200 OK
 * whose body is not JSON, or any failure surfaced only after a 200 OK
 * (insufficient Buzz, a failed/blocked workflow status, an echo refusal)
 * never reaches this retry: each of those throws before or without
 * consulting it. A non-2xx with an unparseable body (an HTML gateway page
 * from a 502/503, say) is NOT in that list — it falls through to `value =
 * null` and is judged, and retried, by status alone like any other response.
 */
const MAX_PREFLIGHT_RETRIES = 1;

async function waitForCivitaiRetry(attempt: number, deadline?: number): Promise<boolean> {
  const delay = deadline === undefined ? civitaiGetRetryDelay(attempt) : Math.min(civitaiGetRetryDelay(attempt), deadline - Date.now());
  if (delay <= 0) return false;
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
  return deadline === undefined || Date.now() < deadline;
}

async function requestJson(
  url: string,
  init: RequestInit,
  token: string,
  stage: "lora_metadata" | "preflight" | "submit" | "submit_lookup" | "workflow_status" | "output_recovery",
  deadline?: number,
  // #680: only a preflight/submit POST ever reads this — every GET stage
  // falls through to REQUEST_TIMEOUT_MS below regardless of what is passed
  // here. `sendWorkflow` is the only caller that passes a real value,
  // computed from the reference count in the body it is actually sending;
  // the default is the zero-reference base rate for any other caller.
  postTimeoutMs: number = CIVITAI_WORKFLOW_POST_BASE_TIMEOUT_MS,
): Promise<unknown> {
  const method = init.method ?? "GET";
  // GET reads (lora metadata, the lost-submit-answer lookup, workflow-status
  // polls) get the shared bounded retry; the what-if preflight gets its own
  // single automatic repeat (#672); every other POST (the paid submit) gets
  // none — #673 keeps that rule: the submit's own transport/HTTP failures are
  // never reposted here, only looked up read-only, in `runCivitaiLane`.
  const maxRetries = method === "GET" ? MAX_GET_RETRIES : stage === "preflight" ? MAX_PREFLIGHT_RETRIES : 0;
  // #680: the preflight and the paid submit share one budget, scaled to the
  // body's own reference count by the caller (`sendWorkflow`) — see
  // CIVITAI_WORKFLOW_POST_BASE_TIMEOUT_MS. The preflight's automatic retry
  // below reuses this SAME `timeoutMs` on every attempt, so a retry can never
  // silently fall back to a smaller budget than the attempt it repeats.
  const timeoutMs = stage === "preflight" || stage === "submit" ? postTimeoutMs : REQUEST_TIMEOUT_MS;
  for (let attempt = 0; ; attempt += 1) {
    if (deadline !== undefined && Date.now() >= deadline) throw civitaiAsyncFailure("expired", ["timeout"]);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(deadline === undefined ? timeoutMs : Math.max(1, Math.min(timeoutMs, deadline - Date.now()))),
      });
      text = await response.text();
    } catch {
      const retriesLeft = attempt < maxRetries;
      const failure = civitaiTransportFailure(stage, method === "GET", !retriesLeft, stage === "preflight" && attempt > 0);
      if (retriesLeft) {
        if (await waitForCivitaiRetry(attempt, deadline)) continue;
        throw civitaiAsyncFailure("expired", ["timeout"]);
      }
      throw failure;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) throw new CivitaiError({ code: "civitai_malformed_response", retry: "never", stage });
      value = null;
    }
    if (!response.ok) {
      const retriesLeft = civitaiRetryableStatus(response.status) && attempt < maxRetries;
      const failure = civitaiHttpFailure(
        response.status, stage, method === "GET", civitaiValidationPaths(value), !retriesLeft,
        response.status === 400 ? civitaiValidationReason(value) : undefined,
        stage === "preflight" && attempt > 0,
      );
      if (retriesLeft) {
        if (await waitForCivitaiRetry(attempt, deadline)) continue;
        throw civitaiAsyncFailure("expired", ["timeout"]);
      }
      throw failure;
    }
    return value;
  }
}

export function parseCivitaiWorkflow(value: unknown, context = "Civitai workflow"): CivitaiWorkflowResult {
  const body = asRecord(value);
  const status = asString(body?.status);
  const id = asString(body?.id);
  if (!body || !id || !status || (!PENDING_STATUSES.has(status) && !FAILED_STATUSES.has(status) && status !== "succeeded")) {
    throw new Error(`${context} returned an invalid workflow identity or status`);
  }
  const steps = asArray(body.steps);
  const step = asRecord(steps[0]);
  if (!step || steps.length !== 1 || step.$type !== "imageGen") throw new Error(`${context} returned an unexpected workflow step`);
  const output = asRecord(step.output);
  const jobs = asArray(step.jobs).map(asRecord);
  const transactions = asRecord(body.transactions);
  const currencies = body.currencies;
  return {
    id,
    status,
    errors: [...new Set([
      ...errorCodes(body.errors), ...errorCodes(step.errors), ...errorCodes(step.error),
      ...errorCodes(step.reason), ...errorCodes(output?.errors),
      ...jobs.flatMap((job) => [
        ...errorCodes(job?.reason), ...errorCodes(job?.blockedReason), ...errorCodes(job?.errors),
      ]),
    ])],
    blocked: jobs.some((job) => job?.reason === "blocked" || (typeof job?.blockedReason === "string" && job.blockedReason.trim() !== "")),
    insufficient: typeof transactions?.insufficientBuzz === "boolean" ? transactions.insufficientBuzz : null,
    mature: typeof body.allowMatureContent === "boolean" ? body.allowMatureContent : null,
    currencies: Array.isArray(currencies) && currencies.every((currency): currency is string => typeof currency === "string")
      ? currencies : null,
    upgradeMode: asString(body.upgradeMode),
    input: asRecord(step.input),
    images: asArray(output?.images).map((value) => {
      const image = asRecord(value);
      return {
        id: asString(image?.id),
        available: image?.available === true,
        hidden: image?.hidden === true,
        blocked: typeof image?.blockedReason === "string" ? errorCodes(image.blockedReason).join(", ") : null,
      };
    }),
  };
}

/**
 * Klein's half of the echo check: the variant identity and every sampling and
 * shape field the Klein builder sends.
 */
function kleinStepEcho(echoed: JsonRecord | null, wanted: JsonRecord): string | null {
  if (!echoed || (echoed.modelVariant ?? echoed.model) !== "klein") {
    return "Civitai preflight did not echo the requested Klein variant";
  }
  // `prompt` is compared verbatim: a normalized, truncated or dropped prompt in
  // the zero-Buzz answer must refuse the paid submit, not pass through it.
  for (const key of ["engine", "modelVersion", "operation", "prompt", "width", "height", "quantity", "cfgScale", "steps", "sampleMethod", "schedule", "outputFormat", "enablePromptExpansion"] as const) {
    if (echoed[key] !== wanted[key]) return `Civitai preflight changed or omitted requested field ${key}`;
  }
  return null;
}

/** The Klein 4B lane: `engine: "flux2"`, `model: "klein"`, `modelVersion: "4b"`. */
const CIVITAI_KLEIN_LANE: CivitaiLane = {
  name: "Civitai Klein",
  maxReferences: MAX_REFERENCES,
  loraFamily: { baseModel: "Flux.2 Klein 4B", airEcosystem: "flux2" },
  validate: validateCivitaiKleinRequest,
  workflow: civitaiKleinWorkflow,
  stepEcho: kleinStepEcho,
  executedVersionId: CIVITAI_KLEIN_4B_VERSION_ID,
};

/**
 * Whether a zero-Buzz what-if answer admits the paid submit of exactly the
 * workflow that was asked for: sufficient yellow Buzz, the fixed workflow
 * policy echoed back, then the lane's own step fields, then the fields every
 * lane shares. Any difference refuses before spend.
 *
 * `lane` defaults to Klein so the Klein-only callers that predate the lane seam
 * keep their meaning.
 */
export function validateCivitaiPreflightEcho(
  actual: CivitaiWorkflowResult,
  expected: CivitaiWorkflow,
  lane: Pick<CivitaiLane, "stepEcho"> = CIVITAI_KLEIN_LANE,
): string | null {
  if (actual.insufficient === true) return "Civitai billing: insufficient yellow Buzz; generation was not submitted";
  if (actual.insufficient === null) return "Civitai preflight did not confirm sufficient yellow Buzz; generation was not submitted";
  if (FAILED_STATUSES.has(actual.status) || actual.errors.length > 0) {
    return `Civitai preflight refused the workflow: ${actual.errors.join(", ") || actual.status}`;
  }
  if (actual.mature !== true || actual.currencies?.length !== 1 || actual.currencies[0] !== "yellow" || actual.upgradeMode !== "manual") {
    return "Civitai preflight did not confirm explicit mature-content permission, yellow-only payment, and manual upgrade policy";
  }
  const wanted = expected.steps[0].input;
  const echoed = actual.input;
  const laneRefusal = lane.stepEcho(echoed, wanted);
  if (laneRefusal) return laneRefusal;
  if (!echoed) return "Civitai preflight did not echo the requested workflow input";
  if (wanted.seed !== undefined && echoed.seed !== wanted.seed) return "Civitai preflight changed the requested seed";
  // Checked by presence as well as value: the provider discards a negative
  // prompt it does not recognize instead of rejecting it, so an omission here is
  // the failure mode this guard exists for.
  if (echoed[CIVITAI_NEGATIVE_PROMPT_FIELD] !== wanted[CIVITAI_NEGATIVE_PROMPT_FIELD]) {
    return "Civitai preflight dropped or changed the requested negative prompt";
  }
  if (asArray(echoed.images).length !== asArray(wanted.images).length) return "Civitai preflight did not preserve the reference-image count";
  const expectedLoras = asRecord(wanted.loras) ?? {};
  const actualLoras = asRecord(echoed.loras);
  if (!actualLoras || Object.keys(actualLoras).length !== Object.keys(expectedLoras).length ||
      Object.entries(expectedLoras).some(([key, strength]) => actualLoras[key] !== strength)) {
    return "Civitai preflight did not echo the requested LoRA AIR map";
  }
  return null;
}

/**
 * A short metadata token fit to name in a refusal, or null.
 *
 * Civitai's `baseModel` and `model.type` are catalog vocabulary ("Qwen 2.1",
 * "LORA"), but they arrive from a provider response, so anything that is not
 * plainly such a token is described rather than echoed.
 */
function civitaiMetadataToken(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,47}$/.test(value) ? value : null;
}

/**
 * The selected curated LoRA as this lane's AIR map entry, after proving from
 * Civitai's own model-version metadata that it is a LoRA of the lane's family.
 *
 * Runs at send time only, before the what-if preflight: a refusal here costs
 * one metadata read and no Buzz. The refusal names the family the metadata
 * actually reports, because "wrong LoRA" is only actionable when the operator
 * can see which family the curated row really points at.
 */
async function resolveLoras(
  request: CivitaiLaneRequest,
  token: string,
  lane: Pick<CivitaiLane, "name" | "loraFamily">,
): Promise<Record<string, number> | undefined> {
  const selected = civitaiSelectedLora(request.controlInput);
  if (!selected) return undefined;
  const family = lane.loraFamily;
  const value = await requestJson(`${MODEL_VERSIONS_URL}/${selected.version}`, { method: "GET" }, token, "lora_metadata");
  const metadata = asRecord(value);
  if (!metadata || metadata.id !== Number(selected.version)) {
    throw new Error(`Civitai metadata did not describe LoRA model version ${selected.version}; refusing before spend`);
  }
  const type = asRecord(metadata.model)?.type;
  if (type !== "LORA") {
    const named = civitaiMetadataToken(type);
    throw new Error(`Civitai model version ${selected.version} is ${named === null ? "not" : `a \`${named}\` resource, not`} a LoRA; refusing before spend`);
  }
  if (metadata.baseModel !== family.baseModel) {
    const base = civitaiMetadataToken(metadata.baseModel);
    const sibling = base === null ? undefined : family.siblings?.[base];
    const actual = base === null ? "a LoRA for an unrecognized base model" : `a \`${base}\`${sibling === undefined ? "" : ` (${sibling})`} LoRA`;
    throw new Error(`Civitai LoRA ${selected.version} is ${actual}; the ${lane.name} lane needs baseModel "${family.baseModel}"; refusing before spend`);
  }
  const modelId = metadata.modelId;
  if (typeof modelId !== "number" || !Number.isSafeInteger(modelId) || modelId < 1) {
    throw new Error(`Civitai metadata for LoRA ${selected.version} carried no usable model id; refusing before spend`);
  }
  return { [`urn:air:${family.airEcosystem}:lora:civitai:${String(modelId)}@${selected.version}`]: selected.strength };
}

async function sendWorkflow(body: CivitaiWorkflow, token: string, whatif: boolean): Promise<unknown> {
  // #680: scaled to how many references are ACTUALLY in this body, never a
  // caller's claim — a lane that trimmed or never attached references cannot
  // be charged a budget for a count it did not send.
  const referenceCount = asArray(body.steps[0].input.images).length;
  return requestJson(`${WORKFLOWS_URL}?whatif=${String(whatif)}&wait=0`, {
    method: "POST",
    body: JSON.stringify(body),
  }, token, whatif ? "preflight" : "submit", undefined, civitaiWorkflowPostTimeoutMs(referenceCount));
}

/**
 * Whether a submit failure already PROVES Civitai did not accept the
 * workflow — a plain 4xx, including 429 — so no lookup is warranted (#673).
 * Everything else (a transport failure, any 5xx, a malformed or
 * not-a-workflow 2xx body) is an UNKNOWN outcome: the provider may have
 * accepted the workflow despite Vesper's own read of the answer failing, so
 * {@link lookupUnconfirmedSubmit} gets a chance to find it before the render
 * is declared failed.
 */
function isDefinitelyRejectedSubmit(error: unknown): boolean {
  return error instanceof CivitaiError && typeof error.httpStatus === "number"
    && error.httpStatus >= 400 && error.httpStatus < 500;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** What one page-bounded pass over the workflow list found. */
interface LookupPageResult {
  /** The matching raw item, unparsed, or null when this pass carried no match. */
  match: JsonRecord | null;
  /**
   * True when every page up to {@link CIVITAI_SUBMIT_LOOKUP_MAX_PAGES} carried
   * no match AND the last one still offered a `next` cursor — the list may
   * hold more than this pass looked at. False when the list ended naturally
   * (`next` null or empty) before the cap, with or without a match.
   */
  pageCapHit: boolean;
}

/**
 * One page-bounded pass over the workflow list, searching for an item whose
 * `externalId` ends with `-${the submit's own externalId}` — the shape the
 * provider stores it in, `"<civitaiUserId>-<the client value Vesper sent>"`
 * (#673 live-evidence comment). A v4 UUID client value makes a suffix match
 * unambiguous. Throws if a page could not be read at all (after
 * `requestJson`'s own bounded retry), so the caller can tell "absent" apart
 * from "unreadable".
 */
async function lookupSubmitPage(
  token: string,
  externalIdSuffix: string,
  fromDateIso: string,
): Promise<LookupPageResult> {
  let cursor: string | undefined;
  for (let page = 0; page < CIVITAI_SUBMIT_LOOKUP_MAX_PAGES; page += 1) {
    // `hideMatureContent=false` is explicit, not relied on as a default
    // (second correction round, #673): the provider OpenAPI defaults
    // `hideMatureContent=true` on this LIST endpoint specifically. A live
    // probe (zero Buzz) found a mature workflow's `available` flag and id
    // still true/present under that default, with only its signed `url`
    // withheld — Vesper never reads that `url` (#630) — so adoption was not
    // actually broken; this removes the dependency on that default rather
    // than on having verified its current behavior is harmless forever.
    const url = `${WORKFLOWS_URL}?tags=vesper&fromDate=${encodeURIComponent(fromDateIso)}&take=${String(CIVITAI_SUBMIT_LOOKUP_PAGE_TAKE)}&hideMatureContent=false${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const body = asRecord(await requestJson(url, { method: "GET" }, token, "submit_lookup"));
    // A malformed envelope is UNREADABLE, never a clean "searched, not
    // found" (third correction round, #673 / Codex on PR #684): coercing a
    // non-object body or a non-array `items` to `[]` would misreport a page
    // this process could not actually interpret as one that simply carried
    // no match.
    const items: unknown = body?.items;
    if (!body || !Array.isArray(items)) {
      throw new Error("Civitai workflow list returned a malformed envelope");
    }
    for (const item of items) {
      const record = asRecord(item);
      const externalId = asString(record?.externalId);
      if (externalId?.endsWith(externalIdSuffix)) return { match: record, pageCapHit: false };
    }
    // The provider's OpenAPI marks `next` required, but a live probe
    // (2026-10-01, zero Buzz) found the LAST page omits the key entirely —
    // so absent, `null`, and `""` all mean the natural end of the list,
    // never a malformed response. Any other type is neither a cursor this
    // process understands nor one of those documented end-of-list shapes,
    // so it is unreadable rather than silently treated as either.
    const next: unknown = body.next;
    if (next === undefined || next === null || next === "") return { match: null, pageCapHit: false };
    if (typeof next !== "string") {
      throw new Error("Civitai workflow list returned a malformed `next` cursor");
    }
    cursor = next;
  }
  // Every page up to the cap carried no match, and the last one still had a
  // `next` cursor this pass declined to follow further.
  return { match: null, pageCapHit: true };
}

/** What the lost-submit-answer lookup concluded. */
interface SubmitLookupOutcome {
  /**
   * The matching RAW list item, unparsed, or null when no round found one.
   * Deliberately not parsed here (#673 correction): parsing is the caller's
   * job, specifically so a shape failure on a workflow that WAS found
   * surfaces as that parse error — with the found id already attached as
   * `predictionId` — rather than being swallowed by this function's own
   * read-failure handling and misreported as "no workflow carries this
   * key", which is false when one does.
   */
  match: JsonRecord | null;
  /**
   * How many rounds' own reads actually SUCCEEDED (regardless of finding a
   * match) — never just the configured round count, which would overstate
   * the search when a round's read itself failed (second correction round,
   * #673). 0 means every round's read failed outright.
   */
  roundsSearched: number;
  /** True when some round that did read hit its page cap without a match, so the search did not necessarily cover the whole list. */
  pageCapHit: boolean;
}

/**
 * Searches the workflow list, read-only, for a submit whose own answer
 * Vesper could not read — across {@link CIVITAI_SUBMIT_LOOKUP_ROUNDS} bounded,
 * spaced rounds (#673). Sends no POST at any point, only the bounded GET the
 * workflow list already supports. Returns the found item's raw record
 * unparsed (see {@link SubmitLookupOutcome.match}); the caller resumes the
 * ordinary poll/terminal/download path on it after parsing.
 */
async function lookupUnconfirmedSubmit(
  token: string,
  submitExternalId: string,
  submitStartedAt: number,
): Promise<SubmitLookupOutcome> {
  const fromDateIso = new Date(submitStartedAt - CIVITAI_SUBMIT_LOOKUP_CLOCK_SKEW_MS).toISOString();
  const suffix = `-${submitExternalId}`;
  let roundsSearched = 0;
  let pageCapHit = false;
  for (let round = 0; round < CIVITAI_SUBMIT_LOOKUP_ROUNDS; round += 1) {
    await delay(round === 0 ? CIVITAI_SUBMIT_LOOKUP_SETTLE_DELAY_MS : CIVITAI_SUBMIT_LOOKUP_ROUND_INTERVAL_MS);
    let page: LookupPageResult;
    try {
      page = await lookupSubmitPage(token, suffix, fromDateIso);
    } catch {
      // This round's read itself failed (transport failure, or every bounded
      // GET retry inside requestJson exhausted). `roundsSearched` stays
      // whatever earlier rounds already proved; the next round gets its own
      // chance. Unchanged by the first correction: a FOUND item's parse
      // failure never reaches this catch, because parsing no longer happens
      // in this loop.
      continue;
    }
    roundsSearched += 1;
    if (page.pageCapHit) pageCapHit = true;
    if (page.match) {
      log.warn("ai.civitai", "found a workflow by externalId lookup after the submit's own answer was lost", {
        workflowId: asString(page.match.id), externalId: submitExternalId,
      });
      return { match: page.match, roundsSearched, pageCapHit };
    }
  }
  return { match: null, roundsSearched, pageCapHit };
}
/**
 * One output location this download is allowed to visit, or a refusal.
 *
 * Applied to the provider's own URL and again to every redirect target, because
 * a hop is a fetch of a new address and inherits no trust from the one that
 * named it. `base` resolves a relative `Location` against the URL that sent it.
 */
function civitaiOutputLocation(value: string, base?: URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(value, base);
  } catch {
    throw civitaiOutputFailure("civitai_output_invalid", "never");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !isCivitaiHost(parsed.hostname)) {
    throw civitaiOutputFailure("civitai_output_invalid", "never");
  }
  return parsed;
}

/**
 * How many redirects one output download may follow.
 *
 * The blob endpoint needs exactly one: `GET {BLOBS_URL}/{id}` answers `301`
 * with a relative `Location` to a signed content path on the same host
 * (measured 2026-09-17, #630). The workflow's signed `url` redirected the same
 * way, and `redirect: "error"` threw `unexpected redirect` there (2026-09-16,
 * #628), which failed every download of a workflow the account had already
 * paid for. Two more are headroom for a storage-host change, not an
 * invitation to chase a chain.
 */
const MAX_OUTPUT_REDIRECTS = 3;

/**
 * How long ONE output-download ATTEMPT is given — covering every redirect
 * hop and the whole body stream, the same one-deadline-for-everything rule
 * {@link fetchOutput} already applied, now scoped per attempt
 * ({@link downloadOutput}) rather than to the whole download.
 *
 * #682: a prod `side_right/clothed` download failed
 * `civitai_output_transport_failure` on 2026-10-01 at 22:48:59Z while
 * Civitai showed the workflow had succeeded with its output available.
 * Three read-only downloads of other outputs right after took 1.9, 6.8 and
 * 11.2 s, almost all of it body streaming (164 KB in about 9 s) — well
 * inside this budget but over the 30 s {@link REQUEST_TIMEOUT_MS} the
 * download used to share with every other GET. From Fly the failing
 * download exceeded 30 s.
 */
const CIVITAI_OUTPUT_ATTEMPT_TIMEOUT_MS = 120_000;

/**
 * How many output-download ATTEMPTS {@link downloadOutput} makes in total
 * before giving up and reporting the output as RECOVERABLE
 * (`civitai_output_undelivered`, #682) rather than losing it — the first
 * attempt plus three retries.
 */
const CIVITAI_OUTPUT_DOWNLOAD_ATTEMPTS = 4;

/**
 * Backoff before each output-download retry (indexed by `attempt - 1`): a
 * short, bounded, fixed schedule rather than exponential, since
 * {@link CIVITAI_OUTPUT_DOWNLOAD_ATTEMPTS} is already a small, known total.
 */
const CIVITAI_OUTPUT_DOWNLOAD_BACKOFF_MS = [2_000, 4_000, 8_000] as const;

/**
 * The response carrying the output bytes, after requesting the provider's
 * authenticated blob endpoint and following its own redirect by hand.
 *
 * The workflow's own signed `url` is not fetched here or anywhere else: some
 * mature outputs (measured 2026-09-17, #630 — three reference-image edits
 * using a mature LoRA) have that url's redirect answer `403` from a `blocked`
 * path with or without the bearer token, even though the blob is
 * `available: true` with no `blockedReason` and the workflow carried
 * `allowMatureContent: true` and `currencies: ["yellow"]`; which blobs get
 * blocked this way is not simply the reported `nsfwLevel`. The signed `url` is
 * also not durable — one saved at render time 401ed roughly 45 minutes later
 * — while the blob id is. `GET {BLOBS_URL}/{id}` served every blob probed, so
 * the runtime downloads through it and never retains the signed `url`.
 *
 * The bearer belongs on that first request alone. The blob endpoint 401s
 * without it, but the `301` it returns points at a signed content path that
 * serves the bytes with NO Authorization header at all — sending the token
 * to a redirected hop would carry a credential to an address the provider
 * named, not one Vesper requested (measured 2026-09-17, #630).
 *
 * `manual` rather than either runtime default: `follow` would fetch whatever
 * host the provider names, and `error` — what a prior version of this
 * function did (#628) — refuses the provider's own signed content path and
 * failed every download of a workflow the account had already paid for. Each
 * hop is revalidated against the same policy, so the stance is enforced by
 * checking the destination rather than by refusing to move. One deadline is
 * shared across every hop and the eventual body stream alike — a chain must
 * not multiply the timeout — and {@link downloadOutput} now hands this a
 * FRESH deadline on each retried attempt (#682) rather than one budget for
 * the whole download.
 */
async function fetchOutput(blobId: string, token: string, deadline: number): Promise<Response> {
  let target = civitaiOutputLocation(`${BLOBS_URL}/${encodeURIComponent(blobId)}`);
  for (let hop = 0; ; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw civitaiOutputFailure("civitai_output_transport_failure", "deliberate");
    let response: Response;
    try {
      response = await fetch(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
        // The bearer travels on the first request alone: every later hop is a
        // location the PROVIDER named, not one Vesper composed (2026-09-17, #630).
        ...(hop === 0 ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
    } catch {
      throw civitaiOutputFailure("civitai_output_transport_failure", "deliberate");
    }
    // A redirect is followed only on POSITIVE evidence of one. Phrased the other
    // way round — "not clearly a normal response" — anything that fails to state
    // a comparable status falls into redirect chasing instead of the ordinary
    // path, where an unusable status already has an answer (`civitai_output_http_*`).
    const redirected = response.status >= 300 && response.status < 400;
    if (!redirected) return response;
    const location = response.headers.get("location");
    try {
      // The redirect's own body is never read; releasing it frees the socket
      // instead of leaving it open for the request timeout to reap.
      await response.body?.cancel();
    } catch {
      // Best effort, and deliberately silent: a body that cannot be released is
      // not this render's failure, and its message — which may be the runtime's
      // or the provider's — must not escape the codes this module promises.
    }
    // A redirect Vesper cannot follow is a location it was never allowed to
    // reach, not a transport hiccup: refusing under the same code as a
    // malformed URL keeps a repeat of the identical request from being retried.
    if (location === null || hop >= MAX_OUTPUT_REDIRECTS) {
      throw civitaiOutputFailure("civitai_output_invalid", "never");
    }
    target = civitaiOutputLocation(location, target);
  }
}

/**
 * ONE output-download attempt: authenticating only the first request
 * `fetchOutput` makes for it, under its own fresh `deadline`.
 *
 * A hop that answers `403` — what the signed `url`'s `blocked` path does
 * (measured 2026-09-17, #630) — surfaces here as an ordinary non-2xx status
 * and is reported as `civitai_output_http_403` like any other refused status,
 * with no separate "blocked output" code: the failure is the transport answer
 * the provider actually gave. The HTTP failure carries the status as
 * `httpStatus` too, so {@link isRetryableOutputFailure} can judge it by the
 * SAME {@link civitaiRetryableStatus} gate the preflight's own retry uses,
 * without re-parsing it back out of the code string.
 */
async function downloadOutputAttempt(blobId: string, token: string, deadline: number): Promise<Buffer> {
  const response = await fetchOutput(blobId, token, deadline);
  if (!response.ok) {
    const code = `civitai_output_http_${String(response.status)}` as `civitai_output_http_${number}`;
    throw civitaiOutputFailure(code, "deliberate", response.status);
  }
  try {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_OUTPUT_BYTES) {
      throw civitaiOutputFailure("civitai_output_too_large", "never");
    }
    if (!response.body) throw civitaiOutputFailure("civitai_output_empty", "deliberate");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_OUTPUT_BYTES) throw civitaiOutputFailure("civitai_output_too_large", "never");
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (size === 0) throw civitaiOutputFailure("civitai_output_empty", "deliberate");
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof CivitaiError) throw error;
    throw civitaiOutputFailure("civitai_output_transport_failure", "deliberate");
  }
}

/**
 * Whether a failed download attempt is worth repeating from hop 0 (#682):
 * ONLY a transport failure or an HTTP status {@link civitaiRetryableStatus}
 * already calls retryable (429 or 5xx) — the same gate the preflight's own
 * automatic retry uses, applied here to the output codes. Every other output
 * failure — `civitai_output_invalid` (an off-host or credentialed redirect,
 * or a chain past {@link MAX_OUTPUT_REDIRECTS}), `_too_large`, `_empty`, or
 * any other non-retryable HTTP status (401/403/404/410 included) — already
 * proves something about THIS output rather than a passing transport hiccup,
 * so it keeps throwing on first occurrence, exactly as before this retry
 * existed.
 */
function isRetryableOutputFailure(error: unknown): boolean {
  if (!(error instanceof CivitaiError)) return false;
  if (error.code === "civitai_output_transport_failure") return true;
  return error.httpStatus !== undefined && civitaiRetryableStatus(error.httpStatus);
}

/**
 * Downloads the blob `blobId` names, retrying a transport failure or a
 * retryable HTTP status up to {@link CIVITAI_OUTPUT_DOWNLOAD_ATTEMPTS} times
 * in total (#682), each a FRESH attempt restarted at the authenticated blob
 * endpoint — never continued from a prior attempt's redirect target, because
 * the signed content path a redirect names expires (#630) and a stale one
 * would just fail again. Each attempt gets its own
 * {@link CIVITAI_OUTPUT_ATTEMPT_TIMEOUT_MS} budget, with a short backoff
 * ({@link CIVITAI_OUTPUT_DOWNLOAD_BACKOFF_MS}) between attempts.
 *
 * Exhausting every attempt reports the output as RECOVERABLE
 * (`civitai_output_undelivered`) rather than losing it: the workflow already
 * succeeded and was paid for, so `recoverCivitaiOutput` can fetch the same
 * blob again later without a new render. Every other output failure
 * ({@link isRetryableOutputFailure} false) throws on its first occurrence,
 * unchanged from before this retry existed.
 */
async function downloadOutput(blobId: string, token: string): Promise<Buffer> {
  for (let attempt = 0; attempt < CIVITAI_OUTPUT_DOWNLOAD_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const backoff = CIVITAI_OUTPUT_DOWNLOAD_BACKOFF_MS[attempt - 1];
      if (backoff !== undefined) await delay(backoff);
    }
    try {
      return await downloadOutputAttempt(blobId, token, Date.now() + CIVITAI_OUTPUT_ATTEMPT_TIMEOUT_MS);
    } catch (error) {
      if (!isRetryableOutputFailure(error)) throw error;
    }
  }
  throw civitaiOutputUndeliveredFailure(blobId, CIVITAI_OUTPUT_DOWNLOAD_ATTEMPTS);
}

export async function runCivitaiKleinImageModel(model: ImageModel, request: RegistryModelRequest): Promise<ReplicateImageResult> {
  return runCivitaiLane(CIVITAI_KLEIN_LANE, model, request);
}

/**
 * One render through one lane: refuse what the lane cannot send, gate the
 * curated LoRA's family, preflight at zero Buzz, refuse any echo that differs
 * from the request, then submit the identical workflow under a fresh external
 * id, poll it inside the budget, and download the first usable blob.
 */
export async function runCivitaiLane(
  lane: CivitaiLane,
  model: ImageModel,
  request: RegistryModelRequest,
): Promise<ReplicateImageResult> {
  const token = civitaiApiToken();
  if (!token) return { ok: false, error: "CIVITAI_API_TOKEN not configured" };
  let predictionId: string | undefined;
  try {
    lane.validate(model, request);
    if ((request.controlReferences?.length ?? 0) > 0) throw new Error(`${lane.name} does not expose dedicated structural image inputs`);
    if ((request.references?.length ?? 0) > lane.maxReferences) {
      throw new Error(`${lane.name} accepts at most ${String(lane.maxReferences)} reference images`);
    }
    const references = (request.references ?? []).map((reference) =>
      `data:${reference.mediaType};base64,${reference.bytes.toString("base64")}`);
    const loras = await resolveLoras(request, token, lane);
    const preflightRequest = lane.workflow(model, request, references, loras);
    const preflight = parseCivitaiWorkflow(await sendWorkflow(preflightRequest, token, true), "Civitai generation preflight");
    if (preflight.insufficient === true) throw civitaiInsufficientBuzzFailure();
    if (FAILED_STATUSES.has(preflight.status) || preflight.errors.length > 0) {
      throw civitaiAsyncFailure(preflight.status, preflight.errors, preflight.blocked);
    }
    const refusal = validateCivitaiPreflightEcho(preflight, preflightRequest, lane);
    if (refusal) return { ok: false, error: refusal };

    // Only the externalId changes here: generation inputs and the payment
    // policy stay identical to the preflight. A fresh id rather than the
    // preflight's own — measured 2026-10-01, a what-if does not claim its
    // key, so reuse would not retrieve an unexecuted estimate either way; see
    // docs/image-models/models/civitai-flux-2-klein-4b.md §Execution and
    // diagnostics — but a submit needs its OWN identity for the lost-answer
    // lookup below to search for.
    const submitWorkflow = { ...preflightRequest, externalId: randomUUID() };
    const submitStartedAt = Date.now();
    let result: CivitaiWorkflowResult;
    try {
      const submitted = await sendWorkflow(submitWorkflow, token, false);
      // Recorded BEFORE parsing (second correction round, #673), restoring
      // the pre-#673 contract (see `ReplicateImageResult.predictionId`,
      // packages/image-replicate/src/prediction.ts): a 2xx body that carries
      // an id but fails to parse must keep that id even though `result` is
      // never assigned here — including if the lookup below then cannot
      // read the list and the render ends as civitai_submit_unconfirmed.
      predictionId = asString(asRecord(submitted)?.id) ?? undefined;
      result = parseCivitaiWorkflow(submitted, "Civitai generation submit");
      predictionId = result.id;
    } catch (submitError) {
      // #673: a plain 4xx (429 included) already proves Civitai rejected the
      // workflow, so it fails exactly as before, with no lookup. Everything
      // else here — a transport failure, any 5xx, or a 2xx body this process
      // could not read as a usable workflow — is an UNKNOWN outcome: Civitai
      // may have accepted and even billed the workflow despite Vesper's own
      // read of the answer failing, so it is looked up read-only, by this
      // submit's own externalId, before the render is declared failed. The
      // paid POST above is never resent on any path through this catch.
      if (isDefinitelyRejectedSubmit(submitError)) throw submitError;
      const originalCode = submitError instanceof CivitaiError ? submitError.code : "civitai_submit_response_invalid";
      const outcome = await lookupUnconfirmedSubmit(token, submitWorkflow.externalId, submitStartedAt);
      if (!outcome.match) {
        throw civitaiSubmitUnconfirmedFailure(
          originalCode, submitWorkflow.externalId, outcome.roundsSearched, CIVITAI_SUBMIT_LOOKUP_ROUNDS, outcome.pageCapHit,
        );
      }
      // The id is recorded BEFORE parsing (first correction round, #673): a
      // found item whose shape then fails `parseCivitaiWorkflow` must
      // surface as that parse failure, with this id attached, never as
      // civitai_submit_unconfirmed — the workflow WAS found, so "no workflow
      // carries this key" would be false.
      predictionId = asString(outcome.match.id) ?? undefined;
      result = parseCivitaiWorkflow(outcome.match, "Civitai workflow lookup");
      predictionId = result.id;
    }
    const deadline = Date.now() + Math.max(30_000, request.timeoutMs ?? CIVITAI_DEFAULT_TIMEOUT_MS);
    while (PENDING_STATUSES.has(result.status)) {
      if (result.insufficient === true) throw civitaiInsufficientBuzzFailure();
      if (result.errors.length > 0) throw civitaiAsyncFailure(result.status, result.errors, result.blocked);
      if (Date.now() >= deadline) throw civitaiAsyncFailure("expired", ["timeout"]);
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2000, Math.max(1, deadline - Date.now()))));
      result = parseCivitaiWorkflow(await requestJson(`${WORKFLOWS_URL}/${encodeURIComponent(predictionId)}`,
        { method: "GET" }, token, "workflow_status", deadline));
      if (result.id !== predictionId) throw new Error("Civitai returned a different workflow while polling");
    }
    if (result.insufficient === true) throw civitaiInsufficientBuzzFailure();
    if (result.mature !== true || result.currencies?.length !== 1 || result.currencies[0] !== "yellow") {
      throw new Error("Civitai workflow did not retain mature-content permission and yellow-only payment");
    }
    if (result.status !== "succeeded" || result.errors.length > 0) {
      throw civitaiAsyncFailure(result.status, result.errors, result.blocked);
    }
    const image = result.images.find((candidate) => candidate.available && !candidate.hidden && !candidate.blocked && candidate.id);
    if (!image?.id) {
      const blocked = result.images.find((candidate) => candidate.blocked)?.blocked;
      throw blocked
        ? civitaiAsyncFailure(result.status, [blocked], true)
        : new CivitaiError({ code: "civitai_output_unavailable", retry: "deliberate", stage: "workflow_terminal" });
    }
    return {
      ok: true,
      image: await downloadOutput(image.id, token),
      predictionId,
      ...(lane.executedVersionId === undefined ? {} : { executedVersionId: lane.executedVersionId }),
      sentReferenceCount: references.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Civitai generation failed";
    // #673 (second Codex round on PR #684): every failure that can surface
    // once a workflow id exists must declare a non-automatic disposition,
    // so the selfie retry's own guard (`declaresNonAutomaticRetry`) never
    // mistakes it for an ordinary automatic-retry-eligible failure and
    // reposts a SECOND paid submit. A CivitaiError thrown post-submit
    // already declares one (civitai_submit_unconfirmed; an exhausted
    // workflow_status read's reconcile override; an async failure's own
    // deliberate/never) and is left exactly as it is — appending twice
    // would be redundant, not safer. This only appends the sentence when
    // `predictionId` is set AND the message carries no disposition at
    // all: a found-but-unparseable lookup match, a 2xx submit body that
    // carried an id but failed to parse, "returned a different workflow
    // while polling", a parse failure mid-poll, the mature/yellow
    // retention check, or anything else non-Civitai thrown after a
    // workflow id already exists. A pre-submit failure (no `predictionId`)
    // is unchanged.
    const final = predictionId && !declaresNonAutomaticRetry(message)
      ? `${message} Civitai workflow ${predictionId} was already submitted (retry=reconcile). Refresh workflow status before deciding whether to replace it.`
      : message;
    // #682: a workflow that succeeded and was paid for, but whose output
    // could not be downloaded after every retried attempt, carries the blob
    // id beside the workflow id — `civitai_output_undelivered` already
    // declares `retry=reconcile` on its own, so `final` above never
    // double-appends the generic "was already submitted" sentence onto it.
    const undeliveredOutputId = error instanceof CivitaiError && error.code === "civitai_output_undelivered"
      ? error.outputId
      : undefined;
    return {
      ok: false,
      ...(predictionId ? { predictionId } : {}),
      ...(undeliveredOutputId ? { undeliveredOutputId } : {}),
      error: final,
    };
  }
}

/**
 * What a read-only recovery of one Civitai output attempted: the bytes, or a
 * refusal distinguishing PERMANENT ("never recoverable this way, do not try
 * again") from everything else ("try again later").
 */
export type CivitaiOutputRecovery =
  | { ok: true; image: Buffer }
  | { ok: false; permanent: boolean; error: string };

/**
 * Recovers the output of a Civitai workflow that already succeeded and was
 * already paid for, but whose download could not complete
 * (`civitai_output_undelivered`, #682) — WITHOUT rendering again. Read-only
 * end to end: one GET to re-read the workflow, then the same retried
 * download `runCivitaiLane` uses. It never POSTs anything, never creates a
 * workflow, and never charges.
 *
 * `permanent: true` is returned ONLY on positive evidence that the output
 * can never be fetched this way — the workflow read answers 404; the
 * workflow's status is not `succeeded`, or its id differs from the one
 * asked for; the workflow does not list `blobId`, or lists it as
 * unavailable, hidden, or blocked; or the download's own final failure is
 * `civitai_output_invalid`, `_too_large`, a 404, or a 410, each of which
 * already proves the same thing for the ordinary render path. Every other
 * outcome — a transport failure, 429/5xx, 401/403, another
 * `civitai_output_undelivered`, `civitai_output_empty`, or a workflow body
 * that parsed as JSON but not into a usable workflow shape — is
 * `permanent: false`: a wrong "permanent" withdraws the owner's one free
 * recovery for good, while a wrong "transient" only costs them trying again.
 *
 * The error text is always the redacted `CivitaiError` message (or, for a
 * malformed workflow shape, `parseCivitaiWorkflow`'s own plain message) —
 * never raw provider prose.
 */
export async function recoverCivitaiOutput(input: { workflowId: string; blobId: string }): Promise<CivitaiOutputRecovery> {
  const token = civitaiApiToken();
  if (!token) return { ok: false, permanent: false, error: "CIVITAI_API_TOKEN not configured" };
  try {
    const value = await requestJson(`${WORKFLOWS_URL}/${encodeURIComponent(input.workflowId)}`, { method: "GET" }, token, "output_recovery");
    const workflow = parseCivitaiWorkflow(value, "Civitai workflow recovery read");
    if (workflow.id !== input.workflowId) {
      return {
        ok: false, permanent: true,
        error: `Civitai workflow recovery returned a different workflow id than ${input.workflowId}; its output cannot be recovered under that id`,
      };
    }
    if (workflow.status !== "succeeded") {
      return {
        ok: false, permanent: true,
        error: `Civitai workflow ${input.workflowId} is ${workflow.status}, not succeeded; its output cannot be recovered`,
      };
    }
    const image = workflow.images.find((candidate) => candidate.id === input.blobId);
    if (!image || !image.available || image.hidden || image.blocked) {
      return {
        ok: false, permanent: true,
        error: `Civitai workflow ${input.workflowId} does not list blob ${input.blobId} as an available, unblocked output`,
      };
    }
    return { ok: true, image: await downloadOutput(input.blobId, token) };
  } catch (error) {
    if (error instanceof CivitaiError) {
      // Positive evidence the output can never be fetched: a 404 on the
      // workflow read itself, or a download failure that already proves the
      // SAME thing for the ordinary render path (never a transport hiccup,
      // a retryable status, an auth hiccup, or the lane's own undelivered
      // code — all of those stay recoverable).
      const permanent =
        (error.stage === "output_recovery" && error.httpStatus === 404) ||
        (error.stage === "output_download" && (
          error.code === "civitai_output_invalid" ||
          error.code === "civitai_output_too_large" ||
          error.code === "civitai_output_http_404" ||
          error.code === "civitai_output_http_410"
        ));
      return { ok: false, permanent, error: error.message };
    }
    // A workflow body that parsed as JSON but not into a usable workflow
    // shape (`parseCivitaiWorkflow`'s own plain Error) is not positive
    // evidence the output is gone — it could be a transient read-side
    // hiccup, so this stays recoverable rather than withdrawn for good.
    return { ok: false, permanent: false, error: error instanceof Error ? error.message : "Civitai workflow recovery failed" };
  }
}
