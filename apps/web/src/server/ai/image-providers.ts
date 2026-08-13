import {
  classifyImageFailureMessage,
  type ImageFailureReason,
  isBillingFailureMessage,
} from "@vesper/image-core";
import { describeProviderError } from "./errors";

/**
 * The transport half of the image provider seam: turn a THROWN value into the
 * provider-neutral failure vocabulary.
 *
 * The rules themselves — which words mean transient, which mean a content
 * rejection, which mean billing, and what each says about provider health —
 * moved to `@vesper/image-core` (`provider-interface/failures.ts`) along with
 * attempt routing and reference capacity. What stays here is the one thing that
 * genuinely knows a transport: extracting a message from an AI-SDK
 * `APICallError`, whose upstream moderation verdict hides in `responseBody`
 * rather than in `error.message` (see {@link describeProviderError}).
 *
 * Keeping the adapter this thin is the point. A second image transport reuses
 * every classification rule by describing its own errors and calling the same
 * pure functions.
 */

export function classifyImageFailure(err: unknown): ImageFailureReason {
  return classifyImageFailureMessage(describeProviderError(err));
}

/** True when a failure is a Replicate billing problem — worth saying plainly to the owner. */
export function isBillingFailure(err: unknown): boolean {
  return isBillingFailureMessage(describeProviderError(err));
}
