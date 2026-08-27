import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { affordanceSubjectId, DiagnosticCollector, type RomanticPermissionEvent } from "@/contracts";
import { codes, expectDiagnostic } from "@/test/diagnostics";
import type { GenerateCheckedOptions, GenerateCheckedResult } from "../ai";
import type { AppendChatPermissionEventsInput, ChatPermissionEventRow } from "./chat-permission-events";

/**
 * The NPC romantic-permission decision leg, orchestration-level: the
 * flag/trigger gates, the FRESH reload of
 * committed state, the ONE-call-max classifier, the validator fence, and the
 * exact events handed to the atomic append — with `generateChecked` scripted
 * the same way the scene-decision leg's suite scripts it, and the ledger/append
 * seams mocked so the pure suite needs no Postgres.
 *
 * Degradation tests assert the fallback (zero events) AND the diagnostic code
 * (docs/resilience.md §8).
 */

const classifier = vi.hoisted(() => ({
  output: null as unknown,
  degraded: false,
  timeout: false,
  calls: 0,
}));

const dbState = vi.hoisted(() => ({
  assistant: null as { readonly role: string; readonly content: string } | null,
  chat: null as { readonly clockMinutes: number } | null,
  /** Which fresh reloads actually happened, in order. */
  loads: [] as string[],
  /** Scripts the unexpected-throw path: an IO failure nothing anticipated. */
  assistantThrows: false,
}));

const seams = vi.hoisted(() => ({
  ledgerRows: [] as unknown[],
  appendCalls: [] as unknown[],
  appendResult: { status: "recorded", inserted: 1, endedContactIds: [] as string[] } as unknown,
}));

// Only the leg's classifier call exists in this suite; scripted by the same
// value/degraded switches the scene-decision int suite uses. The timeout mock
// aborts the leg's own controller, so the degraded diagnostic records
// `timedOut: true` exactly as the real watchdog would.
vi.mock("../ai", () => ({
  agentModelId: (): string => "agent-test-model",
  generateChecked: <T,>(options: GenerateCheckedOptions<T>): Promise<GenerateCheckedResult<T>> => {
    if (options.code === "romantic_permission_decision.classify") classifier.calls += 1;
    if (classifier.degraded) return Promise.resolve({ value: null, degraded: true });
    return Promise.resolve({ value: classifier.output as T, degraded: false });
  },
  withGenerateTimeout: <T,>(
    work: Promise<GenerateCheckedResult<T>>,
    controller: AbortController,
  ): Promise<{ value: T | null; degraded: boolean }> => {
    if (classifier.timeout) {
      controller.abort();
      return Promise.resolve({ value: null, degraded: true });
    }
    return work
      .then((result) => ({ value: result.value, degraded: result.degraded }))
      .catch(() => ({ value: null, degraded: true }));
  },
}));

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  const db = () =>
    ({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () => {
              if (table === actual.characterChatMessages) {
                dbState.loads.push("assistant");
                if (dbState.assistantThrows) return Promise.reject(new Error("connection reset"));
                return Promise.resolve(dbState.assistant === null ? [] : [dbState.assistant]);
              }
              if (table === actual.characterChats) {
                dbState.loads.push("chat");
                return Promise.resolve(dbState.chat === null ? [] : [dbState.chat]);
              }
              return Promise.resolve([]);
            },
          }),
        }),
      }),
    }) as unknown as ReturnType<typeof actual.db>;
  return { ...actual, db };
});

vi.mock("./chat-permission-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-permission-events")>();
  return {
    ...actual,
    listChatPermissionEvents: (): Promise<ChatPermissionEventRow[]> => {
      dbState.loads.push("ledger");
      return Promise.resolve(seams.ledgerRows as ChatPermissionEventRow[]);
    },
    appendChatPermissionEventsWithInvalidation: (
      input: AppendChatPermissionEventsInput,
    ): Promise<typeof seams.appendResult> => {
      seams.appendCalls.push(input);
      return Promise.resolve(seams.appendResult);
    },
  };
});

import { CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact-adapter";
import { runChatRomanticPermissionDecision } from "./chat-permission-decision";

const CHAT_ID = "chat-1";
const MESSAGE_ID = "msg-1";
const MARA_ID = "char-mara";
const WREN_ID = "char-wren";

const GRANT_REPLY = 'Mara sets down her cup and studies you.\n"You can touch me," Mara says softly.';
const WITHDRAW_REPLY = '"Do not touch me like that anymore," Mara says, easing away from your hand.';
const DENIAL_REPLY = '"Not now," Mara murmurs, easing your hand away from her waist.';
const NEUTRAL_REPLY = "Mara pours the tea and talks about the morning rush.";

const grantedDecision = {
  kind: "granted",
  permittedActorRef: "player",
  grantingTargetRef: "npc_0",
  evidenceQuote: "You can touch me,",
};

function roster(members: readonly { id: string; name: string }[] = [{ id: MARA_ID, name: "Mara" }]) {
  return members.map((member) => ({ characterId: member.id, name: member.name, aliases: [] }));
}

async function run(reply: string, sink = new DiagnosticCollector()) {
  await runChatRomanticPermissionDecision({
    chatId: CHAT_ID,
    assistantMessageId: MESSAGE_ID,
    reply,
    roster: roster(),
    sink,
  });
  return sink;
}

function appended(): readonly AppendChatPermissionEventsInput[] {
  return seams.appendCalls as AppendChatPermissionEventsInput[];
}

/** A well-formed stored ledger row whose payload folds into a standing player←Mara grant. */
function standingGrantRow(): ChatPermissionEventRow {
  const payload: RomanticPermissionEvent = {
    eventId: "seed-grant",
    branchId: CHAT_ID,
    permittedActorId: CHAT_CONTACT_PLAYER_SUBJECT,
    grantingTargetId: affordanceSubjectId(MARA_ID),
    scope: "romantic_touch",
    kind: "granted",
    sourceKind: "npc_decision",
    storyTime: 1,
    orderInSource: 0,
  };
  return {
    id: "row-1",
    guardMessageId: "msg-0",
    eventRef: "permission-reply:msg-0",
    sequence: 0,
    kind: "granted",
    sourceKind: "npc_decision",
    permittedActorId: payload.permittedActorId,
    grantingTargetId: payload.grantingTargetId,
    scope: "romantic_touch",
    storyMinute: 1,
    payload,
    createdAt: new Date(0),
  };
}

beforeEach(() => {
  process.env.CHAT_CONTACT_ACTIONS = "on";
  process.env.CHAT_ROMANTIC_PERMISSION = "on";
  classifier.output = { version: 1, decisions: [grantedDecision] };
  classifier.degraded = false;
  classifier.timeout = false;
  classifier.calls = 0;
  dbState.assistant = { role: "assistant", content: GRANT_REPLY };
  dbState.chat = { clockMinutes: 42 };
  dbState.loads = [];
  dbState.assistantThrows = false;
  seams.ledgerRows = [];
  seams.appendCalls = [];
  seams.appendResult = { status: "recorded", inserted: 1, endedContactIds: [] };
});

afterAll(() => {
  delete process.env.CHAT_CONTACT_ACTIONS;
  delete process.env.CHAT_ROMANTIC_PERMISSION;
});

describe("runChatRomanticPermissionDecision", () => {
  it("appends exactly the validated events — fresh-loaded state, one classifier call, npc_decision source", async () => {
    const sink = await run(GRANT_REPLY);

    expect(classifier.calls).toBe(1);
    // The committed state was reloaded FRESH — assistant bytes, ledger, clock.
    expect(dbState.loads).toEqual(["assistant", "ledger", "chat"]);

    const calls = appended();
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("no append call");
    expect(call.chatId).toBe(CHAT_ID);
    expect(call.guardMessageId).toBe(MESSAGE_ID);
    expect(call.eventRef).toBe(`permission-reply:${MESSAGE_ID}`);
    expect(call.storyMinute).toBe(42);
    expect(call.events).toEqual([
      {
        eventId: `permission-reply:${MESSAGE_ID}:0`,
        branchId: CHAT_ID,
        permittedActorId: CHAT_CONTACT_PLAYER_SUBJECT,
        grantingTargetId: affordanceSubjectId(MARA_ID),
        scope: "romantic_touch",
        kind: "granted",
        sourceKind: "npc_decision",
        sourceMessageId: MESSAGE_ID,
        storyTime: 42,
        orderInSource: 0,
        evidenceOffset: GRANT_REPLY.indexOf("You can touch me,"),
      },
    ]);
    // This leg can only author NPC decisions — never a developer override.
    for (const event of call.events) expect(event.sourceKind).toBe("npc_decision");
    expectDiagnostic(sink, "romantic_permission_decision.recorded");
  });

  it("binds an attempt denial to this exchange's contact action", async () => {
    dbState.assistant = { role: "assistant", content: DENIAL_REPLY };
    classifier.output = {
      version: 1,
      decisions: [
        {
          kind: "attempt_denied",
          permittedActorRef: "player",
          grantingTargetRef: "npc_0",
          evidenceQuote: "Not now,",
        },
      ],
    };
    const sink = new DiagnosticCollector();
    await runChatRomanticPermissionDecision({
      chatId: CHAT_ID,
      assistantMessageId: MESSAGE_ID,
      reply: DENIAL_REPLY,
      roster: roster(),
      currentAttemptActionId: "contact-attempt-7",
      currentAttemptContactId: "contact-7",
      sink,
    });
    expect(appended()[0]?.events).toEqual([
      expect.objectContaining({
        kind: "attempt_denied",
        attemptActionId: "contact-attempt-7",
        attemptContactId: "contact-7",
      }),
    ]);
    expectDiagnostic(sink, "romantic_permission_decision.recorded");
  });

  it("drops an attempt denial when this exchange had no contact attempt", async () => {
    dbState.assistant = { role: "assistant", content: DENIAL_REPLY };
    classifier.output = {
      version: 1,
      decisions: [
        {
          kind: "attempt_denied",
          permittedActorRef: "player",
          grantingTargetRef: "npc_0",
          evidenceQuote: "Not now,",
        },
      ],
    };
    const sink = await run(DENIAL_REPLY);
    expect(appended()).toEqual([]);
    expectDiagnostic(sink, "romantic_permission_decision.no_current_attempt");
  });

  it("spends nothing on a reply the trigger skips — no IO, no classifier, no events", async () => {
    dbState.assistant = { role: "assistant", content: NEUTRAL_REPLY };
    const sink = await run(NEUTRAL_REPLY);
    expect(classifier.calls).toBe(0);
    expect(dbState.loads).toEqual([]);
    expect(appended()).toHaveLength(0);
    expect(codes(sink)).toEqual([]);
  });

  it("does not exist with the flag off, whatever the reply says", async () => {
    delete process.env.CHAT_ROMANTIC_PERMISSION;
    await run(GRANT_REPLY);
    expect(classifier.calls).toBe(0);
    expect(appended()).toHaveLength(0);
  });

  it("treats developer-command-shaped chat text as ordinary text — the trigger never fires on it", async () => {
    const reply = '"/permission grant player romantic_touch," Mara says with a laugh.';
    dbState.assistant = { role: "assistant", content: reply };
    await run(reply);
    expect(classifier.calls).toBe(0);
    expect(appended()).toHaveLength(0);
  });

  it("refuses stale bytes: a changed or missing assistant row means no classifier and no events", async () => {
    dbState.assistant = { role: "assistant", content: "Different bytes entirely." };
    const sink = await run(GRANT_REPLY);
    expect(classifier.calls).toBe(0);
    expect(appended()).toHaveLength(0);
    expectDiagnostic(sink, "romantic_permission_decision.stale_reply");
  });

  it("a degraded classifier yields zero events AND the degradation diagnostic", async () => {
    classifier.degraded = true;
    const sink = await run(GRANT_REPLY);
    expect(appended()).toHaveLength(0);
    expectDiagnostic(sink, "romantic_permission_decision.degraded");
  });

  it("an UNEXPECTED throw degrades to the sink too, not just the server log", async () => {
    // A leg that fails on every exchange must not look like a lane where nobody
    // ever says anything about permission. The inspector and the degradation
    // tests read the sink, so an unexpected IO failure files the same code the
    // anticipated degradations do, marked `unexpected` to tell them apart.
    dbState.assistantThrows = true;
    const sink = await run(GRANT_REPLY);
    expect(appended()).toHaveLength(0);
    const degraded = sink.items.find((item) => item.code === "romantic_permission_decision.degraded");
    expect(degraded?.context).toMatchObject({ unexpected: true });
  });

  it("a timeout yields zero events and a degraded diagnostic marked timedOut", async () => {
    classifier.timeout = true;
    const sink = await run(GRANT_REPLY);
    expect(appended()).toHaveLength(0);
    const degraded = sink.items.find((item) => item.code === "romantic_permission_decision.degraded");
    expect(degraded?.context).toMatchObject({ timedOut: true });
  });

  it("a malformed output envelope degrades to zero events with the diagnostic", async () => {
    classifier.output = { totally: "wrong" };
    const sink = await run(GRANT_REPLY);
    expect(appended()).toHaveLength(0);
    expectDiagnostic(sink, "romantic_permission_decision.degraded");
  });

  it("an absent decision list is the quiet common answer — no events, no degradation", async () => {
    classifier.output = { version: 1, decisions: [] };
    const sink = await run(GRANT_REPLY);
    expect(classifier.calls).toBe(1);
    expect(appended()).toHaveLength(0);
    expect(codes(sink)).toEqual([]);
  });

  it("a malformed decision item drops with its diagnostic while a valid sibling still lands", async () => {
    classifier.output = {
      version: 1,
      decisions: [{ ...grantedDecision, grantingTargetRef: "npc_9" }, grantedDecision],
    };
    const sink = await run(GRANT_REPLY);
    expectDiagnostic(sink, "romantic_permission_decision.slot_malformed");
    expect(appended()).toHaveLength(1);
    expect(appended()[0]?.events).toHaveLength(1);
  });

  it("the validator fences the append: a player granting-target yields a typed drop and NO append call", async () => {
    classifier.output = {
      version: 1,
      decisions: [{ ...grantedDecision, permittedActorRef: "npc_0", grantingTargetRef: "player" }],
    };
    const sink = await run(GRANT_REPLY);
    expect(appended()).toHaveLength(0);
    expectDiagnostic(sink, "romantic_permission_decision.target_player");
  });

  it("a validated withdrawal reaches the append (standing grant from the FRESH ledger) and reports what it ended", async () => {
    seams.ledgerRows = [standingGrantRow()];
    seams.appendResult = { status: "recorded", inserted: 1, endedContactIds: ["contact-1"] };
    dbState.assistant = { role: "assistant", content: WITHDRAW_REPLY };
    classifier.output = {
      version: 1,
      decisions: [
        {
          kind: "withdrawn",
          permittedActorRef: "player",
          grantingTargetRef: "npc_0",
          evidenceQuote: "Do not touch me like that anymore,",
        },
      ],
    };
    const sink = await run(WITHDRAW_REPLY);
    const calls = appended();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.events.map((event) => event.kind)).toEqual(["withdrawn"]);
    const recorded = sink.items.find((item) => item.code === "romantic_permission_decision.recorded");
    expect(recorded?.context).toMatchObject({ endedContactIds: ["contact-1"] });
  });

  it("without a standing grant the same withdrawal is dropped, not appended", async () => {
    dbState.assistant = { role: "assistant", content: WITHDRAW_REPLY };
    classifier.output = {
      version: 1,
      decisions: [
        {
          kind: "withdrawn",
          permittedActorRef: "player",
          grantingTargetRef: "npc_0",
          evidenceQuote: "Do not touch me like that anymore,",
        },
      ],
    };
    const sink = await run(WITHDRAW_REPLY);
    expect(appended()).toHaveLength(0);
    expectDiagnostic(sink, "romantic_permission_decision.no_standing_grant");
  });

  it("maps an NPC-to-NPC grant to the right subject ids, one direction only", async () => {
    const reply = '"You can hold my hand, Wren," Mara says.';
    dbState.assistant = { role: "assistant", content: reply };
    classifier.output = {
      version: 1,
      decisions: [
        {
          kind: "granted",
          permittedActorRef: "npc_1",
          grantingTargetRef: "npc_0",
          evidenceQuote: "You can hold my hand, Wren,",
        },
      ],
    };
    const sink = new DiagnosticCollector();
    await runChatRomanticPermissionDecision({
      chatId: CHAT_ID,
      assistantMessageId: MESSAGE_ID,
      reply,
      roster: roster([
        { id: MARA_ID, name: "Mara" },
        { id: WREN_ID, name: "Wren" },
      ]),
      sink,
    });
    const calls = appended();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.events).toEqual([
      expect.objectContaining({
        kind: "granted",
        permittedActorId: affordanceSubjectId(WREN_ID),
        grantingTargetId: affordanceSubjectId(MARA_ID),
      }),
    ]);
  });
});
