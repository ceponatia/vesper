import { describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { makeProfile } from "@/server/test-support";
import type { AgentLegTrace } from "../chat-memory";
import { seedChatScenario, seedChatState } from "./seed";

/**
 * `runFinalizationAgents` builds no telemetry of its own — it hands the SAME
 * `{ chatId, messageId }` trace object `assistantMessageId` already takes to
 * both fan-out legs (`runChatPulse` ‖ `runChatExtraction`). #637 adds
 * `traceId` onto that object; this suite proves both legs actually receive
 * it (and that it stays absent when the caller has none), with both legs
 * mocked out so the test needs neither a database nor a model call.
 */

const seen = vi.hoisted(() => ({
  pulseTrace: undefined as AgentLegTrace | undefined,
  extractionTrace: undefined as AgentLegTrace | undefined,
}));

vi.mock("./pulse-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pulse-agent")>();
  return {
    ...actual,
    runChatPulse: (input: { state: unknown; trace?: AgentLegTrace }) => {
      seen.pulseTrace = input.trace;
      return Promise.resolve({ state: input.state, degraded: false });
    },
  };
});

vi.mock("../chat-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat-memory")>();
  return {
    ...actual,
    runChatExtraction: (input: { trace?: AgentLegTrace }) => {
      seen.extractionTrace = input.trace;
      return Promise.resolve({ value: null, degraded: true, legs: { memory: true, continuity: true, character: true } });
    },
  };
});

import { runFinalizationAgents } from "./finalize-agents";

function baseInput(overrides: { traceId?: string } = {}) {
  const profile = makeProfile();
  return {
    profile,
    driftedState: seedChatState(profile),
    characterName: "Mara",
    scenario: seedChatScenario(profile),
    playerName: "Theo",
    characterId: "char-mara",
    skipPulse: false,
    exchange: { player: "hi", assistant: "[Mara] \"hi\"" },
    chatId: "chat-1",
    assistantMessageId: "msg-1",
    sink: new DiagnosticCollector(),
    ...overrides,
  };
}

describe("runFinalizationAgents threads the caller's traceId into both fan-out legs (#637)", () => {
  it("hands the SAME traceId to the pulse and the extraction", async () => {
    seen.pulseTrace = undefined;
    seen.extractionTrace = undefined;
    await runFinalizationAgents(baseInput({ traceId: "trace-finalize-1" }));
    expect(seen.pulseTrace).toMatchObject({ chatId: "chat-1", messageId: "msg-1", traceId: "trace-finalize-1" });
    expect(seen.extractionTrace).toMatchObject({ chatId: "chat-1", messageId: "msg-1", traceId: "trace-finalize-1" });
  });

  it("leaves traceId absent on both legs when the caller has none", async () => {
    seen.pulseTrace = undefined;
    seen.extractionTrace = undefined;
    await runFinalizationAgents(baseInput());
    expect(seen.pulseTrace?.traceId).toBeUndefined();
    expect(seen.extractionTrace?.traceId).toBeUndefined();
  });
});
