import { describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { makeProfile } from "@/server/test-support";
import type { AgentLegTrace } from "./chat-memory";
import { seedChatScenario, seedChatState } from "./chat-state/seed";
import type { ChatTurnMember } from "./chat-turn-types";
import type { FinalizeChatStateResult } from "./chat-state/finalize-types";

/**
 * `settleChatTurnMembers` hands each present/referenced ensemble member's own
 * pulse and personal-note pass the SAME `{ chatId, messageId }` trace object
 * the primary's own fan-out uses (`finalize-agents.ts`). #637 adds `traceId`
 * onto it; this suite proves both member-scoped legs actually receive it (and
 * that it stays absent when the caller has none), with the legs — and the
 * member's state/snapshot writes, which this function performs unconditionally
 * — mocked out so the test needs neither a database nor a model call.
 */

const seen = vi.hoisted(() => ({
  pulseTrace: undefined as AgentLegTrace | undefined,
  personalTrace: undefined as AgentLegTrace | undefined,
}));

vi.mock("./chat-state/pulse-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-state/pulse-agent")>();
  return {
    ...actual,
    runChatPulse: (input: { state: unknown; trace?: AgentLegTrace }) => {
      seen.pulseTrace = input.trace;
      return Promise.resolve({ state: input.state, degraded: false });
    },
  };
});

vi.mock("./chat-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-memory")>();
  return {
    ...actual,
    runChatPersonalNotes: (input: { trace?: AgentLegTrace }) => {
      seen.personalTrace = input.trace;
      return Promise.resolve({ value: null, degraded: false });
    },
  };
});

vi.mock("./chat-state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-state/store")>();
  return { ...actual, saveChatState: () => Promise.resolve() };
});

vi.mock("./chat-state/snapshots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-state/snapshots")>();
  return { ...actual, savePreExchangeSnapshot: () => Promise.resolve() };
});

import { settleChatTurnMembers } from "./chat-turn-settle";

function member(): ChatTurnMember {
  const profile = makeProfile();
  return {
    characterId: "char-wren",
    memoryGroupId: "group-wren",
    name: "Wren",
    profile,
    preExchangeState: null,
    state: { ...seedChatState(profile), presence: "present" },
  };
}

function emptyFinalized(): FinalizeChatStateResult {
  return {
    bigMoment: false,
    selfieSend: false,
    presenceChanges: [],
    wardrobeChanged: { character: false, player: false },
    ensembleWardrobe: { lane: "none", enumeratedCharacterIds: [], wornItemIds: {} },
  };
}

function baseArgs(overrides: { traceId?: string } = {}) {
  const primaryProfile = makeProfile();
  const wren = member();
  return {
    chatId: "chat-1",
    characterName: "Mara",
    sink: new DiagnosticCollector(),
    driftedState: seedChatState(primaryProfile),
    scenario: seedChatScenario(primaryProfile),
    others: [wren],
    input: {},
    promptMessageId: "prompt-1",
    playerContent: "hi there",
    assistantMessageId: "msg-1",
    effectiveKind: "send" as const,
    narratorInput: false,
    now: new Date("2026-07-12T12:00:00Z"),
    player: { id: null, name: "Theo" },
    agentPlayerContent: "hi there",
    full: "[Wren] \"hi back\"",
    selfieTargetOther: undefined,
    referencedOthers: [wren],
    finalized: emptyFinalized(),
    ...overrides,
  };
}

describe("settleChatTurnMembers threads the caller's traceId into both member legs (#637)", () => {
  it("hands the SAME traceId to the member's pulse and personal-notes pass", async () => {
    seen.pulseTrace = undefined;
    seen.personalTrace = undefined;
    await settleChatTurnMembers(baseArgs({ traceId: "trace-settle-1" }));
    expect(seen.pulseTrace).toMatchObject({ chatId: "chat-1", messageId: "msg-1", traceId: "trace-settle-1" });
    expect(seen.personalTrace).toMatchObject({ chatId: "chat-1", messageId: "msg-1", traceId: "trace-settle-1" });
  });

  it("leaves traceId absent on both legs when the caller has none", async () => {
    seen.pulseTrace = undefined;
    seen.personalTrace = undefined;
    await settleChatTurnMembers(baseArgs());
    expect(seen.pulseTrace?.traceId).toBeUndefined();
    expect(seen.personalTrace?.traceId).toBeUndefined();
  });
});
