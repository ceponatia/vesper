import type { ChatReplyFailure, ChatReplyFailureCause, ChatReplyFailureCode } from "@/contracts";
import { NARRATIVE_MODELS, narrativeModelProvider } from "@/lib/narrative-models";

/**
 * Cause-specific popup copy for a reply that never arrived (reply-failure
 * surfacing — docs/character-chat/pipeline.md §Reply failures). The server
 * classifies the failure into the closed ChatReplyFailureCode vocabulary and
 * persists it on the chat row; the post-exchange transcript refetch hands the
 * record here. A missing or stale record falls back to honest we-don't-know
 * copy — never a guessed cause.
 */

/** Ignore records older than this — a leftover verdict from an earlier visit must not explain THIS empty reply. */
const REPLY_FAILURE_FRESH_MS = 10 * 60 * 1000;

/** Cap on the provider's own words quoted in the popup's fine print. */
const DETAIL_MAX = 160;

const FALLBACK =
  "The narrator model returned nothing and the server recorded no cause. Try again, or pick a different narrator model from the menu.";

const DESCRIPTIONS: Record<ChatReplyFailureCode, string> = {
  timeout:
    "The narrator model timed out — it never started answering and the server cut it off. Try again; if it keeps happening the model may be overloaded, so pick another from the narrator menu.",
  rate_limited: "The model provider is rate-limiting requests right now. Give it a moment, then try again.",
  // The narrator list is multi-provider (Featherless rows alongside OpenRouter), so
  // these two name the vendor only when the record's model id actually identifies one
  // — see `providerName`. Naming the wrong provider in a credential error sends the
  // owner to check the wrong secret.
  no_credits: "is out of credits, so the narrator can't run. Top up, then try again.",
  auth_failed: "rejected the server's API key, so the narrator can't run. Check the provider's API key secret.",
  moderation_blocked:
    "The model provider refused to write this reply (content moderation). Another take sometimes passes, but a different narrator model is the reliable fix.",
  context_too_long:
    "The conversation no longer fits this model's context window. Pick a narrator model with a longer context from the menu.",
  provider_error: "The model provider failed upstream. This is usually transient — try again.",
  network: "The server couldn't reach the model provider (network error). Try again.",
  empty_reply:
    "The narrator model finished without saying anything — no error, just an empty reply. Another take usually fixes it.",
  unknown: FALLBACK,
};

/**
 * Copy for an `empty_reply` the server could explain (`ChatReplyFailureCause`). Only
 * `model_silent` is the plain "said nothing" story; the other two are cases where the
 * old blanket copy was actively false — the model DID generate, it just produced no
 * prose, or produced prose that Vesper then discarded.
 */
const EMPTY_CAUSES: Record<ChatReplyFailureCause, string> = {
  model_silent:
    "The narrator model finished without generating anything — no error, just silence. Another take usually fixes it.",
  reasoning_or_length:
    "The narrator model used up its whole response on internal reasoning and never wrote the reply. Another take usually fixes it; if this model keeps doing it, pick a different narrator from the menu.",
  normalizer_erased:
    "The narrator model did write a reply, but it was all discarded as repetition or stray formatting before it reached you. Another take usually fixes it.",
};

/** Failure classes where the provider's own words add signal beyond the class copy. */
const QUOTE_DETAIL: ReadonlySet<ChatReplyFailureCode> = new Set([
  "moderation_blocked",
  "context_too_long",
  "provider_error",
  "network",
  "unknown",
]);

/**
 * Which upstream the failed model came from, for the two classes whose copy names a
 * vendor. Reads the recorded model id through the narrator list's own routing field.
 *
 * A vendor is named only when the id is actually ON that list. `narrativeModelProvider`
 * answers "openrouter" for an unknown id — the right default for routing, but the wrong
 * one for a credential message, which would then send the owner to check a secret that
 * has nothing to do with the failure. An unlisted or blank id gets the neutral wording.
 */
function providerName(model: string): string {
  const id = model.trim();
  if (!id || !NARRATIVE_MODELS.some((option) => option.id === id)) return "The model provider";
  return narrativeModelProvider(id) === "featherless" ? "Featherless" : "OpenRouter";
}

/**
 * Build the "didn't reply" toast from the persisted failure record. `who` is the
 * character's display name; `now` is injectable for tests.
 */
export function replyFailureToast(
  who: string,
  failure: ChatReplyFailure | null | undefined,
  now = Date.now(),
): { title: string; description: string } {
  const title = `${who} didn't reply`;
  if (!failure || isStale(failure, now)) return { title, description: FALLBACK };
  let description = DESCRIPTIONS[failure.code];
  if (failure.code === "no_credits" || failure.code === "auth_failed") {
    description = `${providerName(failure.model)} ${description}`;
  }
  if (failure.code === "empty_reply" && failure.cause) {
    description = EMPTY_CAUSES[failure.cause];
  }
  if (failure.detail && QUOTE_DETAIL.has(failure.code)) {
    const detail = failure.detail.length > DETAIL_MAX ? `${failure.detail.slice(0, DETAIL_MAX)}…` : failure.detail;
    description = `${description} (Provider said: “${detail}”)`;
  }
  return { title, description };
}

function isStale(failure: ChatReplyFailure, now: number): boolean {
  if (!failure.at) return false; // degraded record with no stamp — it was just fetched, trust it
  const age = now - Date.parse(failure.at);
  return !Number.isFinite(age) || age > REPLY_FAILURE_FRESH_MS;
}
