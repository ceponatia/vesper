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

/** Classify an already-described provider failure message. */
export function classifyImageFailureMessage(message: string): ImageFailureReason {
  const text = message.toLowerCase();
  if (BILLING.test(text)) return "other";
  if (CONTENT_REJECTION.test(text)) return "content_rejection";
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
