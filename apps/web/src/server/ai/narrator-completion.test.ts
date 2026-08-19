import { describe, expect, it } from "vitest";
import {
  classifyEmptyNarratorCompletion,
  narratorCompletionLogFields,
  narratorEmptyRetryWorthwhile,
  narratorEmptyWasSilentStop,
  type NarratorCompletion,
} from "./narrator-completion";

/**
 * The zero-visible-text classifier — the fix for a reply failure that used to assert
 * "the model finished without saying anything" whenever the pipeline had no evidence
 * either way. Every case below is a distinct true story about the same observable
 * symptom, and the whole point is that they no longer share one message.
 */

const base: NarratorCompletion = {
  provider: "featherless",
  modelId: "DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-MTP",
  finishReason: "stop",
  rawTextLength: 0,
  visibleTextLength: 0,
  visibleTextChars: 0,
  attempts: 1,
};

const empty = (over: Partial<NarratorCompletion>): NarratorCompletion => ({ ...base, ...over });

describe("classifyEmptyNarratorCompletion", () => {
  it("calls a clean zero-token stop a genuine empty reply", () => {
    const result = classifyEmptyNarratorCompletion(empty({ finishReason: "stop" }));
    expect(result.code).toBe("empty_reply");
    expect(result.cause).toBe("model_silent");
    // What is absent is PROSE. The detail used to say "without generating any
    // tokens", which is the right story here and a false one a few lines under
    // the hidden-output floor — so the wording claims only the prose either way,
    // and the count rides along when the provider reported one.
    expect(result.detail).toContain("without producing any prose");
    expect(result.detail).not.toContain("output tokens");
  });

  // A couple of billed output tokens on a silent completion is an end-of-turn token,
  // not a hidden reply — relabelling those would break the true-empty case.
  it("still calls a stop with a token or two of overhead a genuine empty", () => {
    expect(classifyEmptyNarratorCompletion(empty({ outputTokens: 2 })).cause).toBe("model_silent");
  });

  // The reproduced failure: `finish_reason "length"`, 298 completion tokens, zero
  // characters of content — on a Featherless model asked with `enable_thinking:
  // false`, which reports no reasoning split at all. It is a length cap and nothing
  // more, and neither the cause nor the detail may reach for a reasoning story the
  // provider never told.
  it("calls a length finish with no reasoning split a length cap, and says only that", () => {
    const result = classifyEmptyNarratorCompletion(empty({ finishReason: "length", outputTokens: 298 }));
    expect(result.code).toBe("empty_reply");
    expect(result.cause).toBe("length_capped");
    expect(result.detail).toContain("298 output tokens");
    expect(result.detail).not.toContain("reasoning");
  });

  /**
   * Falsified against a detail built as "reached its output limit after
   * ${describeOutput}" over a fallback that read "its output budget" — a
   * provider reporting a length finish with no usage block then persisted
   * "reached its output limit after its output budget", which is the sentence an
   * owner reads when investigating a narrator. Both branches of the count must
   * compose after a preposition.
   */
  it("still reads as a sentence when the provider reports a length finish and no token count", () => {
    const result = classifyEmptyNarratorCompletion(empty({ finishReason: "length" }));
    expect(result.cause).toBe("length_capped");
    expect(result.detail).toContain("an unreported number of output tokens");
    expect(result.detail).not.toContain("its output budget");
  });

  /**
   * The hidden-output floor sits at eight because a stop sequence or an
   * end-of-turn marker can bill one or two on a genuinely silent completion.
   * Underneath it the cause is right and the old detail was measurably wrong:
   * it claimed no tokens were generated while the provider had billed some.
   */
  it("does not claim zero tokens on a silent stop the provider billed for", () => {
    const result = classifyEmptyNarratorCompletion(empty({ finishReason: "stop", outputTokens: 3 }));
    expect(result.cause).toBe("model_silent");
    expect(result.detail).not.toContain("without generating any tokens");
    expect(result.detail).toContain("3 output tokens");
  });

  it("names reasoning only when the provider splits the tokens out", () => {
    const result = classifyEmptyNarratorCompletion(
      empty({ finishReason: "stop", outputTokens: 1_284, reasoningTokens: 1_284, textTokens: 0 }),
    );
    expect(result.cause).toBe("reasoning_spent");
    expect(result.detail).toContain("1284 reasoning tokens");
  });

  // Reasoning outranks the cap when both are present: a model that reported a
  // reasoning chain AND ran out of room spent its budget reasoning, and that is the
  // half the reader can act on. Checking `length` first would bury it.
  it("prefers the measured reasoning story over the length cap", () => {
    const result = classifyEmptyNarratorCompletion(
      empty({ finishReason: "length", outputTokens: 900, reasoningTokens: 900 }),
    );
    expect(result.cause).toBe("reasoning_spent");
  });

  it("records billed-but-unseen output from a provider that reports no split", () => {
    const result = classifyEmptyNarratorCompletion(empty({ finishReason: "stop", outputTokens: 300 }));
    expect(result.cause).toBe("hidden_output");
    expect(result.detail).not.toContain("reasoning");
  });

  it("routes a content-filter finish to the existing moderation class", () => {
    const result = classifyEmptyNarratorCompletion(empty({ finishReason: "content-filter" }));
    expect(result.code).toBe("moderation_blocked");
    expect(result.cause).toBeUndefined();
  });

  it("routes an error finish to the existing provider-error class", () => {
    const result = classifyEmptyNarratorCompletion(empty({ finishReason: "error" }));
    expect(result.code).toBe("provider_error");
    expect(result.cause).toBeUndefined();
  });

  // The Featherless cold start, and the reason this whole classifier exists. `streamText`
  // does not throw for it: the stream ends clean with zero deltas and an error finish,
  // which used to be recorded as "no error, just an empty reply".
  it("keeps a stream-reported provider failure's own class and words", () => {
    const result = classifyEmptyNarratorCompletion(
      empty({
        finishReason: "error",
        providerError: {
          code: "provider_error",
          detail: "DavidAU/Qwen3.6-… is temporarily at capacity. Please try again shortly.",
        },
      }),
    );
    expect(result.code).toBe("provider_error");
    expect(result.detail).toContain("temporarily at capacity");
  });

  it("lets a stream-reported failure carry a more specific class than provider_error", () => {
    const result = classifyEmptyNarratorCompletion(
      empty({ finishReason: "error", providerError: { code: "no_credits", detail: "Payment required" } }),
    );
    expect(result.code).toBe("no_credits");
    expect(result.detail).toBe("Payment required");
  });

  // Vesper's own bug, and the record must name it: pointing this at the model would
  // send every future investigation to the wrong system.
  it("names Vesper's normalizers when they erased a real reply", () => {
    const result = classifyEmptyNarratorCompletion(empty({ finishReason: "stop", rawTextLength: 412 }));
    expect(result.code).toBe("empty_reply");
    expect(result.cause).toBe("normalizer_erased");
    expect(result.detail).toContain("412 characters");
    expect(result.detail).toContain("normalizers");
  });

  it("prefers the normalizer story over the length story when both are true", () => {
    const result = classifyEmptyNarratorCompletion(
      empty({ finishReason: "length", rawTextLength: 412, outputTokens: 2_000 }),
    );
    expect(result.cause).toBe("normalizer_erased");
  });

  it("keeps an unrefined empty_reply when the provider offered no evidence at all", () => {
    const result = classifyEmptyNarratorCompletion(empty({ finishReason: "unknown" }));
    expect(result.code).toBe("empty_reply");
    expect(result.cause).toBeUndefined();
    expect(result.detail).toBe("");
  });

  it("quotes the provider's own finish word when it differs from the unified one", () => {
    const result = classifyEmptyNarratorCompletion(empty({ finishReason: "length", rawFinishReason: "max_tokens" }));
    expect(result.detail).toContain("length (max_tokens)");
  });
});

describe("narratorEmptyRetryWorthwhile", () => {
  it("is worth a retry for a silent stop, a length burn, and a normalizer erasure", () => {
    expect(narratorEmptyRetryWorthwhile(empty({ finishReason: "stop" }))).toBe(true);
    expect(narratorEmptyRetryWorthwhile(empty({ finishReason: "length" }))).toBe(true);
    expect(narratorEmptyRetryWorthwhile(empty({ rawTextLength: 412 }))).toBe(true);
  });

  it("is not worth a retry for moderation or a failed generation", () => {
    expect(narratorEmptyRetryWorthwhile(empty({ finishReason: "content-filter" }))).toBe(false);
    expect(narratorEmptyRetryWorthwhile(empty({ finishReason: "error" }))).toBe(false);
  });
});

describe("narratorEmptyWasSilentStop", () => {
  it("is true only for a clean stop that generated nothing", () => {
    expect(narratorEmptyWasSilentStop(empty({ finishReason: "stop" }))).toBe(true);
    expect(narratorEmptyWasSilentStop(empty({ finishReason: "stop", outputTokens: 2 }))).toBe(true);
  });

  it("is false once anything was generated, hidden or visible", () => {
    expect(narratorEmptyWasSilentStop(empty({ finishReason: "length" }))).toBe(false);
    expect(narratorEmptyWasSilentStop(empty({ finishReason: "stop", outputTokens: 300 }))).toBe(false);
    expect(narratorEmptyWasSilentStop(empty({ finishReason: "stop", reasoningTokens: 40 }))).toBe(false);
    expect(narratorEmptyWasSilentStop(empty({ finishReason: "stop", rawTextLength: 412 }))).toBe(false);
  });
});

describe("narratorCompletionLogFields", () => {
  it("carries counts and finish state and nothing else", () => {
    const fields = narratorCompletionLogFields(
      empty({ finishReason: "length", rawFinishReason: "max_tokens", inputTokens: 17_000, outputTokens: 298 }),
    );
    expect(fields).toEqual({
      provider: "featherless",
      modelId: base.modelId,
      finishReason: "length",
      rawFinishReason: "max_tokens",
      inputTokens: 17_000,
      outputTokens: 298,
      rawTextLength: 0,
      visibleTextLength: 0,
      visibleTextChars: 0,
      attempts: 1,
    });
  });

  // Unknown is not zero: a missing count logged as 0 would later be read as measured.
  it("omits every count the provider did not report", () => {
    const fields = narratorCompletionLogFields(empty({}));
    expect(fields).not.toHaveProperty("inputTokens");
    expect(fields).not.toHaveProperty("outputTokens");
    expect(fields).not.toHaveProperty("textTokens");
    expect(fields).not.toHaveProperty("reasoningTokens");
    expect(fields).not.toHaveProperty("rawFinishReason");
  });
});
