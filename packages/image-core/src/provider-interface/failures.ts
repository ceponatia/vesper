/**
 * Failure classification and provider-health semantics — the half of the
 * provider seam that reads a failure MESSAGE and says what kind of failure it
 * was.
 *
 * Everything here takes a plain string, never an error object. Turning a
 * provider's thrown value into a message is transport work: the AI SDK's
 * `APICallError` buries an upstream moderation verdict in `responseBody`, and
 * digging it out belongs to the adapter that knows that SDK
 * (`describeProviderError`, `src/server/ai/errors.ts`). Keeping the split here
 * is what lets the vocabulary — transient / content_rejection / other — stay
 * provider-neutral: a second transport can reuse every rule below by handing it
 * its own already-described message.
 */

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
/**
 * A message that already states its own retry disposition as `deliberate`,
 * `never`, or `reconcile` is never `transient`, no matter which other words
 * it also contains (#673). This is the provider-neutral half of closing the
 * double-spend path an exhausted Civitai workflow-status poll opened: that
 * message said `retry=automatic` and "temporarily unavailable" even once a
 * paid workflow already existed, and `executeSceneChain` reruns a `transient`
 * rung, which is a second paid submit while the first — already billed — may
 * still finish untracked. A describer that is explicit about its own retry
 * semantics is authoritative over this classifier's keyword guessing, so an
 * `automatic` disposition (the only one this never excludes) is the one case
 * left for the keyword rules below to confirm or override.
 *
 * Checked AFTER billing and content-rejection, never before: a provider
 * answering about payment or about the prompt itself is a more specific and
 * more useful reading than a generic non-transient retry disposition would
 * be, so those two keep deciding first exactly as they did before this rule
 * existed.
 */
const NON_TRANSIENT_DISPOSITION = /retry=(?:deliberate|never|reconcile)/;

/**
 * Whether a failure message already declares a non-automatic retry
 * disposition (`retry=deliberate`, `retry=never`, or `retry=reconcile`) —
 * the exact signal {@link classifyImageFailureMessage} uses to keep such a
 * message out of `transient`, built on the SAME regex and exposed on its
 * own (#673) so a caller weighing a SEPARATE, independent retry — not the
 * scene chain's own same-rung retry, which `classifyImageFailureMessage`
 * already guards — can honor the same disposition before repeating a paid
 * request through that other path. A provider-neutral predicate, like the
 * classifier itself: it takes only an already-described message, never a
 * provider-specific error object.
 */
export function declaresNonAutomaticRetry(message: string): boolean {
  return NON_TRANSIENT_DISPOSITION.test(message.toLowerCase());
}

/** Classify an already-described provider failure message. */
export function classifyImageFailureMessage(message: string): ImageFailureReason {
  const text = message.toLowerCase();
  if (BILLING.test(text)) return "other";
  if (CONTENT_REJECTION.test(text)) return "content_rejection";
  if (NON_TRANSIENT_DISPOSITION.test(text)) return "other";
  if (TRANSIENT.test(text)) return "transient";
  return "other";
}

/** True when the message describes a provider billing problem — worth saying plainly to the owner. */
export function isBillingFailureMessage(message: string): boolean {
  return BILLING.test(message.toLowerCase());
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
