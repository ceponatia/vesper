import type { ChatReplyFailureCode, ChatReplyFailureCause } from "@/contracts";
import type { NarrativeModelProvider } from "@/lib/narrative-models";

/**
 * How a narrator generation actually finished — the evidence the chat pipeline
 * needs to tell a truthful story about a reply that never arrived.
 *
 * Before this existed the pipeline knew exactly one thing: whether any
 * post-normalizer text reached it. "Zero text and no exception" was therefore
 * reported to the player as "the model finished without saying anything", which
 * is a guess dressed as a fact — it cannot distinguish a model that emitted
 * nothing from one that spent its whole output budget on a reasoning chain, was
 * cut off at the length cap, was refused by a content filter, or whose prose
 * Vesper's own output normalizers then discarded.
 *
 * **Counts and finish state only.** No prompt, no player text, no prose, no
 * reasoning content, no system prompt, no private character state travels in
 * this record: it is written to the chat row and to the server log, and a
 * diagnostic that carried content would turn both into transcripts.
 *
 * Every token field is optional because the providers disagree about what they
 * report. Featherless returns `completion_tokens` with no
 * `completion_tokens_details`, so the text/reasoning split is simply absent
 * there; OpenRouter reports the split for models that reason. Unknown is not
 * zero, and the classifier below never treats a missing count as evidence.
 */
export interface NarratorCompletion {
  /** Which upstream served the generation (the narrator list's routing field). */
  provider: NarrativeModelProvider;
  /** The resolved model id the generation actually ran, post-curation and post-key-gate. */
  modelId: string;
  /** The AI SDK's unified finish reason ("stop" | "length" | "content-filter" | "error" | …). */
  finishReason: string;
  /** The provider's own finish string, when it reported one. */
  rawFinishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Output tokens the provider attributed to visible text, when it splits them out. */
  textTokens?: number;
  /** Output tokens the provider attributed to a reasoning chain, when it splits them out. */
  reasoningTokens?: number;
  /** Characters the AI SDK's `textStream` carried — BEFORE Vesper's output normalizers. */
  rawTextLength: number;
  /** Characters that survived the normalizers and were streamed to the player. */
  visibleTextLength: number;
  /**
   * Non-whitespace characters among the visible ones. The pipeline's own
   * "was there a reply" test is `full.trim()`, so an all-whitespace stream is an
   * empty reply there; this count is what lets the stream reach the same verdict
   * without keeping a second copy of the reply in memory.
   */
  visibleTextChars: number;
  /** Model attempts spent on this exchange, including any exact-model hidden retry. */
  attempts: number;
  /**
   * The classified provider failure behind an `error` finish, when the generation
   * reported one.
   *
   * This exists because `streamText` does NOT throw for every provider failure. A
   * Featherless cold start is the case that matters: an idle model answers `503`
   * `capacity_exhausted` while its weights load, and the AI SDK surfaces that as an
   * error stream part — so `textStream` ends cleanly with zero deltas and
   * `finishReason: "error"`, and no exception ever reaches the pipeline's catch. That
   * is precisely the shape the old code read as "no error, just an empty reply", which
   * is how a sleeping model came to be reported to the player as a silent one.
   *
   * Carrying the classification (not the raw error) keeps this record a flat,
   * serializable diagnostic while still letting the failure surface under its real
   * class — `no_credits` for a 402, `rate_limited` for a 429, `provider_error` with
   * the vendor's own wording for a 503.
   */
  providerError?: { code: ChatReplyFailureCode; detail: string };
}

/**
 * Output tokens that must be billed, with zero text arriving, before "the provider
 * generated something we never saw" counts as evidence rather than noise.
 *
 * A stop sequence or a lone end-of-turn token can be billed as one or two output
 * tokens on a genuinely silent completion, so a bare `outputTokens > 0` test would
 * relabel true-empty replies. Eight is comfortably above that floor and far below
 * anything that could be called a reply.
 */
const HIDDEN_GENERATION_MIN_OUTPUT_TOKENS = 8;

/**
 * The provider explicitly attributed output tokens to a reasoning chain. This is
 * the ONLY evidence that justifies telling the player a thinking chain ate the
 * reply — a provider that reports no split (Featherless returns
 * `completion_tokens` alone) can never satisfy it, which is correct: those
 * narrators are asked with `enable_thinking: false`.
 */
function measuredReasoning(completion: NarratorCompletion): boolean {
  return (completion.reasoningTokens ?? 0) > 0;
}

/** The provider billed output tokens, and none of them reached us as text. */
function billedUnseenOutput(completion: NarratorCompletion): boolean {
  return (
    completion.rawTextLength === 0 &&
    (completion.outputTokens ?? 0) >= HIDDEN_GENERATION_MIN_OUTPUT_TOKENS
  );
}

/** True when the provider's counts say it generated substantially more than reached us. */
function generatedHiddenTokens(completion: NarratorCompletion): boolean {
  return measuredReasoning(completion) || billedUnseenOutput(completion);
}

/**
 * Classify a zero-visible-text completion from the generation's own metadata
 * (PURE). Callers must only reach here for an exchange that produced no visible
 * reply and no thrown provider error — a partial reply is a visible reply, and a
 * thrown error is already classified by `classifyProviderError`.
 *
 * The returned `code` stays inside the existing closed failure vocabulary
 * (contracts/turns/chat-reply-failure.ts); the `cause` refines the `empty_reply`
 * class so the popup can stop asserting the model said nothing when the server
 * knows better. Two of the outcomes below are not empty replies at all, and route
 * to the classes that already describe them:
 *
 * | Evidence                                   | Recorded as                         |
 * | ------------------------------------------ | ----------------------------------- |
 * | `content-filter` finish                    | `moderation_blocked`                |
 * | `error` finish                             | `provider_error`                    |
 * | raw text > 0, nothing survived normalizing | `empty_reply` / `normalizer_erased` |
 * | reasoning tokens reported, no prose        | `empty_reply` / `reasoning_spent`   |
 * | `length` finish, no reasoning reported     | `empty_reply` / `length_capped`     |
 * | billed output tokens that never arrived    | `empty_reply` / `hidden_output`     |
 * | `stop` finish with no such evidence        | `empty_reply` / `model_silent`      |
 * | none of the above                          | `empty_reply`, no cause             |
 *
 * The normalizer check comes FIRST among the empty causes on purpose. If the model
 * produced prose and Vesper deleted it, that is this repo's bug and the honest
 * record must name it — reporting a normalizer erasure as a model failure would
 * point every future investigation at the wrong system.
 *
 * Reasoning comes first among the remaining three for the mirror-image reason:
 * naming a mechanism is only honest when the metadata measured it. A `length`
 * finish and a pile of unattributed output tokens are each compatible with a
 * thinking chain, but neither is evidence of one, so each gets a cause that
 * claims only what is known.
 */
export function classifyEmptyNarratorCompletion(completion: NarratorCompletion): {
  code: ChatReplyFailureCode;
  detail: string;
  cause?: ChatReplyFailureCause;
} {
  const finish = completion.finishReason;
  if (finish === "content-filter") {
    return {
      code: "moderation_blocked",
      detail: `the model stopped on a content filter without writing anything (finish: ${describeFinish(completion)})`,
    };
  }
  if (finish === "error") {
    // A generation error keeps whatever class the provider's own words earn — a cold
    // start, a rate limit and an exhausted balance are three different things to do
    // about it, and only the vendor's message can tell them apart.
    return (
      completion.providerError ?? {
        code: "provider_error",
        detail: `the generation ended in a provider error (finish: ${describeFinish(completion)})`,
      }
    );
  }
  if (completion.rawTextLength > 0) {
    return {
      code: "empty_reply",
      cause: "normalizer_erased",
      detail:
        `the model wrote ${completion.rawTextLength} characters and Vesper's output normalizers ` +
        `discarded all of them (finish: ${describeFinish(completion)})`,
    };
  }
  if (measuredReasoning(completion)) {
    return {
      code: "empty_reply",
      cause: "reasoning_spent",
      detail:
        `the model spent ${completion.reasoningTokens} reasoning tokens without producing any prose ` +
        `(finish: ${describeFinish(completion)})`,
    };
  }
  if (finish === "length") {
    return {
      code: "empty_reply",
      cause: "length_capped",
      detail:
        `the model reached its output limit after ${describeOutput(completion)} without producing any prose ` +
        `(finish: ${describeFinish(completion)})`,
    };
  }
  if (billedUnseenOutput(completion)) {
    return {
      code: "empty_reply",
      cause: "hidden_output",
      detail:
        `the provider billed ${describeOutput(completion)} but no text reached the server ` +
        `(finish: ${describeFinish(completion)})`,
    };
  }
  if (finish === "stop") {
    return {
      code: "empty_reply",
      cause: "model_silent",
      detail: `the model ended its turn without generating any tokens (finish: ${describeFinish(completion)})`,
    };
  }
  // The provider offered no usable evidence — keep the honest unrefined class.
  return { code: "empty_reply", detail: "" };
}

/**
 * Whether a zero-visible-text completion is worth ONE hidden retry (PURE, and
 * exact-model gated by its caller — `narratorHiddenRetryModel` in `./provider`).
 *
 * Everything the caller already knows about — a player abort, a watchdog trip, a
 * thrown auth/credit/context/network/provider exception — never reaches here,
 * because those paths never produce a completion record at all: an exception
 * escapes the stream and an abort abandons it. What is left to rule out is the
 * finish state that says a second identical ask cannot help.
 *
 * A content-filter finish is excluded because the same prompt will be refused
 * again, and a spent retry only delays a truthful answer. An `error` finish is
 * the provider telling us the generation itself failed, which the provider-error
 * path already handles and reports.
 *
 * A normalizer erasure IS retried. It is a zero-visible-text completion by
 * definition — the player saw nothing, so nothing can be duplicated — and a fresh
 * sample usually lands outside whatever the collapse/strip rules matched.
 */
export function narratorEmptyRetryWorthwhile(completion: NarratorCompletion): boolean {
  return completion.finishReason !== "content-filter" && completion.finishReason !== "error";
}

/**
 * Whether this empty completion is the "true immediate empty stop" the retry may
 * put a minimum-generation floor under: a clean stop with nothing generated at
 * all. An empty that burned tokens must NOT get the floor — the model already
 * generated plenty, just not prose, and forcing more tokens would treat a
 * configuration failure as a length problem.
 */
export function narratorEmptyWasSilentStop(completion: NarratorCompletion): boolean {
  return (
    completion.finishReason === "stop" &&
    completion.rawTextLength === 0 &&
    !generatedHiddenTokens(completion)
  );
}

/** `"stop"` / `"length (eos)"` — the unified reason, with the provider's own word when it differs. */
function describeFinish(completion: NarratorCompletion): string {
  const raw = completion.rawFinishReason;
  return raw && raw !== completion.finishReason ? `${completion.finishReason} (${raw})` : completion.finishReason;
}

/**
 * How much the generation was billed for, without claiming what it went on. The
 * reasoning cause names reasoning itself; the two causes that reach here have no
 * reasoning count behind them, so neither may imply one.
 */
function describeOutput(completion: NarratorCompletion): string {
  if (typeof completion.outputTokens === "number") return `${completion.outputTokens} output tokens`;
  return "its output budget";
}

/**
 * The completion as a flat log payload — the structured server diagnostic behind
 * every zero-visible-text exchange. Counts and finish state only, and nothing
 * undefined: a field the provider did not report is simply absent from the line
 * rather than logged as a zero somebody would later read as measured.
 */
export function narratorCompletionLogFields(completion: NarratorCompletion): Record<string, string | number> {
  const fields: Record<string, string | number> = {
    provider: completion.provider,
    modelId: completion.modelId,
    finishReason: completion.finishReason,
    rawTextLength: completion.rawTextLength,
    visibleTextLength: completion.visibleTextLength,
    visibleTextChars: completion.visibleTextChars,
    attempts: completion.attempts,
  };
  if (completion.rawFinishReason !== undefined) fields.rawFinishReason = completion.rawFinishReason;
  if (completion.providerError !== undefined) {
    fields.providerErrorCode = completion.providerError.code;
    fields.providerErrorDetail = completion.providerError.detail.slice(0, 200);
  }
  if (completion.inputTokens !== undefined) fields.inputTokens = completion.inputTokens;
  if (completion.outputTokens !== undefined) fields.outputTokens = completion.outputTokens;
  if (completion.textTokens !== undefined) fields.textTokens = completion.textTokens;
  if (completion.reasoningTokens !== undefined) fields.reasoningTokens = completion.reasoningTokens;
  return fields;
}
