import { describe, expect, it } from "vitest";
import type { Gate0CaseDefinition } from "./cases";
import {
  evaluateGate0Quality,
  percentile,
  summarizeGate0Rows,
  type Gate0ResultRow,
} from "./report";

const definition: Gate0CaseDefinition = {
  id: "test",
  deterministicStateBefore: {},
  deterministicStateAfter: {},
  checks: {
    contradictionRe: /inside the office/i,
    perspectiveLeakRe: /private-token/i,
    hardEffectRepairRe: /take her hand/i,
    requiredCueRe: /\*Sabrina:/i,
    notes: [],
  },
};

function row(overrides: Partial<Gate0ResultRow> = {}): Gate0ResultRow {
  return {
    caseId: "test",
    title: "test",
    lane: "chat",
    seed: 0,
    authoredSetup: { expectation: "", knownNames: [], authoredReaction: null },
    inputMessages: [],
    deterministicStateBefore: {},
    deterministicStateAfter: {},
    prompt: { system: "", messages: [], sha256: "" },
    transcript: "*Sabrina: no.*",
    legs: [
      {
        id: "narrator",
        model: "test",
        attemptedCalls: 1,
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        tokenSource: "provider",
        ttftMs: 10,
        totalMs: 50,
        provider: "test",
        degraded: false,
      },
    ],
    automatedQuality: {
      contradiction: false,
      perspectiveLeak: false,
      hardEffectRepair: false,
      requiredCueMiss: false,
    },
    manualReview: {
      contradiction: null,
      perspectiveLeak: null,
      hardEffectRepair: null,
      note: "",
    },
    ...overrides,
  };
}

describe("Gate 0 baseline report", () => {
  it("counts only explicit checks and inverts required cues into misses", () => {
    expect(evaluateGate0Quality(definition, "You step inside the office and take her hand. private-token")).toEqual({
      contradiction: true,
      perspectiveLeak: true,
      hardEffectRepair: true,
      requiredCueMiss: true,
    });
    expect(evaluateGate0Quality(definition, "*Sabrina: The locked door stops you.*")).toEqual({
      contradiction: false,
      perspectiveLeak: false,
      hardEffectRepair: false,
      requiredCueMiss: false,
    });
  });

  it("uses stable nearest-rank percentiles", () => {
    expect(percentile([50, 10, 100, 20], 50)).toBe(20);
    expect(percentile([50, 10, 100, 20], 95)).toBe(100);
    expect(percentile([], 95)).toBe(0);
  });

  it("aggregates calls, tokens, degradation, latency and quality", () => {
    const degraded = row({
      seed: 1,
      transcript: "",
      legs: [
        {
          ...row().legs[0],
          attemptedCalls: 2,
          promptTokens: 40,
          completionTokens: 0,
          totalTokens: 40,
          totalMs: 500,
          degraded: true,
        },
      ],
      automatedQuality: {
        contradiction: true,
        perspectiveLeak: true,
        hardEffectRepair: true,
        requiredCueMiss: true,
      },
    });
    const summary = summarizeGate0Rows([row(), degraded]);
    expect(summary).toMatchObject({
      rows: 2,
      successfulRows: 1,
      attemptedModelCalls: 3,
      degradedLegs: 1,
      promptTokens: 140,
      completionTokens: 20,
      latencyMs: { p50: 50, p95: 50 },
      automatedQuality: {
        contradiction: { hits: 0, checked: 1 },
        perspectiveLeak: { hits: 0, checked: 1 },
        hardEffectRepair: { hits: 0, checked: 1 },
        requiredCueMiss: { hits: 0, checked: 1 },
      },
      manualReview: { pending: 6 },
    });
  });
});
