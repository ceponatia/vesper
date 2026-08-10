import { referenceCapacity, type ImageModel, type SceneReferenceMode, type SceneVisualReference } from "@/contracts";
import { describeProviderError } from "./errors";

/**
 * Provider-capability seam for image rendering (scene-images.spec.md §4,
 * re-based on the registry 2026-08-05).
 *
 * Before the registry this module carried a hardcoded matrix of provider ids
 * (`venice_edit`, `replicate_multi_edit`, …) whose capabilities were constants.
 * Capabilities now live on the model row, so the ids that remain describe **how
 * many references an attempt uses**, not which vendor serves it. One model runs
 * the whole chain; the chain is its degradation ladder.
 *
 * `demo` survives because it is not a model at all — it is the monogram path
 * that runs with no provider configured.
 */
export const sceneAttemptIds = ["demo", "multi_edit", "edit", "generate"] as const;
export type SceneAttemptId = (typeof sceneAttemptIds)[number];

export interface SceneRenderRequest {
  references: SceneVisualReference[];
  demo: boolean;
  mode?: SceneReferenceMode;
  /** The resolved registry model; absent in demo mode or when none is registered. */
  model?: ImageModel | null;
}

/**
 * Order the attempts one render may make, best first.
 *
 * A selected model never falls across to a DIFFERENT model: a failure stays
 * visible and retryable rather than producing an image that looks nothing like
 * the character (owner ruling 2026-07-29). What it may do is use fewer
 * references — dropping the location reference costs fidelity, where refusing
 * costs the image entirely.
 *
 * The `generate` rung is only reachable for a model that can run bare, and only
 * when no usable reference exists. An edit-only model with no reference yields
 * an empty chain, which the caller reports as a refusal.
 */
export function routeSceneAttempts(request: SceneRenderRequest): SceneAttemptId[] {
  if (request.demo) return ["demo"];
  if (!request.model) return [];

  const available = request.references.filter((reference) => Boolean(reference.imageId)).length;
  const { max } = referenceCapacity(request.model);
  const usable = Math.min(available, max);

  const chain: SceneAttemptId[] = [];
  if (usable >= 2 && request.mode === "multi") chain.push("multi_edit");
  if (usable >= 1) chain.push("edit");
  if (chain.length === 0 && request.model.canGenerate) chain.push("generate");
  return chain;
}

/** How many reference buffers an attempt consumes. */
export function attemptReferenceCount(attempt: SceneAttemptId, model: ImageModel | null | undefined): number {
  if (!model || attempt === "demo" || attempt === "generate") return 0;
  const { max } = referenceCapacity(model);
  return attempt === "multi_edit" ? max : 1;
}

// --- Failure classification ----------------------------------------------

export type ImageFailureReason = "transient" | "content_rejection" | "other";

export interface ImageProviderFailure {
  reason: ImageFailureReason;
  message: string;
}

export interface ProviderRenderResult {
  ok: boolean;
  image?: Buffer;
  failure?: ImageProviderFailure;
}

const CONTENT_REJECTION = /moderation|sexual content|nsfw|safe[_ ]?mode|content policy|flagged|disallowed|prohibited|violation/;
const TRANSIENT =
  /timeout|timed out|abort|econn|etimedout|enotfound|socket hang up|network|fetch failed|rate limit|too many requests|\b(429|500|502|503|504)\b|temporarily/;
/**
 * Billing failures are neither transient nor a content problem: retrying cannot
 * fix them and the prompt is not at fault. Checked FIRST because "payment
 * required" would otherwise match the transient pattern's status-code alternation
 * and earn a pointless retry — which is what happened on 2026-08-05 when the
 * Replicate balance ran out mid-test.
 */
const BILLING = /insufficient credit|payment required|\b402\b|billing/;

export function classifyImageFailure(err: unknown): ImageFailureReason {
  const message = describeProviderError(err).toLowerCase();
  if (BILLING.test(message)) return "other";
  if (CONTENT_REJECTION.test(message)) return "content_rejection";
  if (TRANSIENT.test(message)) return "transient";
  return "other";
}

/** True when a failure is a Replicate billing problem — worth saying plainly to the owner. */
export function isBillingFailure(err: unknown): boolean {
  return BILLING.test(describeProviderError(err).toLowerCase());
}

/**
 * What one classified failure says about the PROVIDER's own health, in the
 * circuit breaker's vocabulary (`recordProviderOutcome`, `@/server/api`):
 * `false` when the failure is evidence the upstream is failing, `null` when it
 * is evidence about something else and the breaker should hear nothing at all.
 *
 * Only `transient` counts, which is the reading the scene chain already takes:
 * a render whose every rung failed transiently is logged as
 * `images.scene_render.service_outage` ("possible image service outage"), while
 * a `content_rejection` is the provider ANSWERING — about this request, not
 * about its health — and gets a sanitized retry rather than a fallback, and
 * `other` covers billing and configuration failures that shedding cannot fix.
 * Counting either as a lane failure would shed every caller's work over one
 * prompt, or over an empty Replicate balance no cooldown will refill.
 *
 * Deliberately no `true` case: a failure is never evidence of health, so the
 * caller supplies that reading itself when a call actually succeeded.
 */
export function imageFailureHealthOutcome(reason: ImageFailureReason): false | null {
  return reason === "transient" ? false : null;
}
