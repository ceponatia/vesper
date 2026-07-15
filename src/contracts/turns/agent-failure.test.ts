import { describe, expect, it } from "vitest";
import {
  AGENT_LARGE_PROMPT_CHARS,
  agentFailureExplanation,
  agentFailureSchema,
  agentLegLabel,
  agentRunSchema,
  classifyAgentFailure,
  tallyAgentFailures,
  tallyAgentRuns,
  type AgentFailure,
  type AgentRun,
} from "./agent-failure";

const failure = (overrides: Partial<AgentFailure> = {}): AgentFailure =>
  agentFailureSchema.parse({ legId: "chat_continuity", kind: "timeout", cause: "model_slow", ...overrides });

describe("classifyAgentFailure", () => {
  it("a provider error is not a guess — the provider's own class passes through", () => {
    expect(classifyAgentFailure({ kind: "api_error", providerCode: "rate_limited" })).toBe("rate_limited");
    expect(classifyAgentFailure({ kind: "api_error", providerCode: "no_credits" })).toBe("no_credits");
    expect(classifyAgentFailure({ kind: "api_error", providerCode: "moderation_blocked" })).toBe("moderation_blocked");
  });

  it("a provider code outside our vocabulary degrades to a plain provider error", () => {
    // e.g. the narrator-only "empty_reply", or a class added upstream later.
    expect(classifyAgentFailure({ kind: "api_error", providerCode: "empty_reply" })).toBe("provider_error");
    expect(classifyAgentFailure({ kind: "api_error" })).toBe("provider_error");
  });

  it("a TRUNCATED body is diagnosed as an output cap that is too low, not as a stupid model", () => {
    // This is the whole point of the parse-failure arm: "the model can't do JSON" and "we
    // didn't let it finish" look identical in the logs and have completely different fixes.
    expect(
      classifyAgentFailure({ kind: "parse_failed", detail: "SyntaxError: Unexpected end of JSON input" }),
    ).toBe("output_cap_too_low");
    expect(classifyAgentFailure({ kind: "parse_failed", detail: "Unterminated string in JSON at position 812" })).toBe(
      "output_cap_too_low",
    );
  });

  it("a body that was wrong from the start is malformed output", () => {
    expect(classifyAgentFailure({ kind: "parse_failed", detail: "invalid_type: expected object, received string" })).toBe(
      "malformed_output",
    );
  });

  it("a timeout blames the prompt only when the prompt is actually large", () => {
    expect(classifyAgentFailure({ kind: "timeout", promptChars: AGENT_LARGE_PROMPT_CHARS })).toBe("prompt_too_large");
    expect(classifyAgentFailure({ kind: "timeout", promptChars: AGENT_LARGE_PROMPT_CHARS - 1 })).toBe("model_slow");
    // No signal at all ⇒ the honest default, not an invented cause.
    expect(classifyAgentFailure({ kind: "timeout" })).toBe("model_slow");
  });

  it("every cause has a plain-language explanation", () => {
    for (const cause of ["prompt_too_large", "output_cap_too_low", "rate_limited", "unknown"] as const) {
      expect(agentFailureExplanation(cause).length).toBeGreaterThan(20);
    }
  });
});

describe("agentFailureSchema (a bad row must never break the debug page)", () => {
  it("parses a garbage payload into a readable record instead of throwing", () => {
    const parsed = agentFailureSchema.parse({ legId: 42, kind: "nonsense", cause: "nonsense", promptChars: "big" });
    expect(parsed.legId).toBe("unknown");
    expect(parsed.kind).toBe("timeout");
    expect(parsed.cause).toBe("unknown");
    expect(parsed.promptChars).toBe(0);
  });
});

describe("agentLegLabel", () => {
  it("names the legs we know and passes through the ones we don't", () => {
    expect(agentLegLabel("chat_memory_scribe")).toBe("Memory scribe");
    expect(agentLegLabel("chat_state.pulse")).toBe("Reaction pulse");
    expect(agentLegLabel("some_future_leg")).toBe("some_future_leg");
  });
});

describe("tallyAgentFailures", () => {
  it("counts by leg and by cause, most-frequent first", () => {
    const tally = tallyAgentFailures([
      failure({ legId: "chat_continuity", cause: "model_slow" }),
      failure({ legId: "chat_continuity", cause: "model_slow" }),
      failure({ legId: "chat_state.pulse", cause: "rate_limited" }),
    ]);
    expect(tally.total).toBe(3);
    expect(tally.byLeg).toEqual([
      { key: "chat_continuity", count: 2 },
      { key: "chat_state.pulse", count: 1 },
    ]);
    expect(tally.byCause).toEqual([
      { key: "model_slow", count: 2 },
      { key: "rate_limited", count: 1 },
    ]);
  });

  it("an empty window tallies to zero, not to nothing", () => {
    expect(tallyAgentFailures([])).toEqual({ total: 0, byLeg: [], byCause: [] });
  });
});

const run = (overrides: Partial<AgentRun> = {}): AgentRun => agentRunSchema.parse({ legId: "chat_memory_scribe", ...overrides });

describe("tallyAgentRuns", () => {
  it("tallies per-leg count + median/max latency (the how-slow view)", () => {
    const tally = tallyAgentRuns([
      run({ legId: "chat_memory_scribe", latencyMs: 12000 }),
      run({ legId: "chat_memory_scribe", latencyMs: 40000 }),
      run({ legId: "chat_memory_scribe", latencyMs: 20000 }),
      run({ legId: "chat_state.pulse", latencyMs: 3000 }),
    ]);
    expect(tally.total).toBe(4);
    // scribe: median of [12000,20000,40000] = 20000, max 40000, count 3 — sorted most-frequent first.
    expect(tally.byLeg).toEqual([
      { key: "chat_memory_scribe", count: 3, medianMs: 20000, maxMs: 40000 },
      { key: "chat_state.pulse", count: 1, medianMs: 3000, maxMs: 3000 },
    ]);
  });

  it("even-length latency lists take the rounded midpoint mean", () => {
    const tally = tallyAgentRuns([run({ latencyMs: 10000 }), run({ latencyMs: 20000 })]);
    expect(tally.byLeg[0]?.medianMs).toBe(15000);
  });

  it("an empty window tallies to zero", () => {
    expect(tallyAgentRuns([])).toEqual({ total: 0, byLeg: [] });
  });
});
