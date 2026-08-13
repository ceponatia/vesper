import { describe, expect, it } from "vitest";
import { compileNarratorPhysicalGuidance, DiagnosticCollector, GUIDANCE_MAX_TRANSITIONS } from "@/contracts";
import {
  chatPermissionStopTransitions,
  CHAT_CONTACT_DOMAIN_ID,
  CHAT_CONTACT_ENDED_CODE,
  CHAT_PERMISSION_STOP_OVER_BOUND,
  CHAT_PERMISSION_STOP_ROWS_BOUND,
  CHAT_PERMISSION_STOP_TRANSITIONS_BOUND,
  CHAT_PERMISSION_STOP_UNREADABLE,
  type ChatPermissionStopLedgerRow,
  type ChatPermissionStopNewestReply,
} from "./chat-permission-guidance";

/**
 * The revocation stop transition's PURE half
 * (romantic-contact-affordances.spec.permission.md §"Revocation during active
 * contact" step 4): which `policy_withdrawn` endings the next reply must be
 * told about, decided from rows that already exist — no new state.
 *
 * The emission window is the load-bearing subject: an ending no assistant
 * reply has followed emits exactly once, and the moment one lands every branch
 * goes quiet. Because the window is that narrow, COMPLETENESS inside it is the
 * second subject — an ensemble reply can end contact on several pairs at once,
 * and a pair that does not emit here is never told to any reply, so the suite
 * pins the emission count against the shared tier's budget. The degraded
 * direction is the third: an unreadable ending ships a GENERIC stop rather than
 * silence, because a narrator that keeps a hand where the state ended it is the
 * worse failure.
 */

const T0 = new Date("2026-08-04T10:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

const REPLY_REF = "permission-reply:msg_reply_1";
const OVERRIDE_REF = "permission-override:evt_override_1";

function endedPayload(overrides: {
  reason?: string;
  actor?: string;
  target?: string;
  locus?: string;
} = {}): unknown {
  const actor = overrides.actor ?? "player";
  const target = overrides.target ?? "char_wren";
  return {
    kind: "contact_ended",
    contactId: "contact_1",
    eventRef: REPLY_REF,
    reason: overrides.reason ?? "policy_withdrawn",
    storyTime: 120,
    contact: {
      phase: "ended",
      actorId: actor,
      source: { kind: "body", subjectId: actor, locationId: "hands" },
      target: { kind: "body", subjectId: target, locationId: overrides.locus ?? "shoulders" },
    },
  };
}

function row(overrides: Partial<ChatPermissionStopLedgerRow> = {}): ChatPermissionStopLedgerRow {
  return {
    eventRef: REPLY_REF,
    contactId: "contact_1",
    guardMessageId: "msg_reply_1",
    createdAt: at(1_000),
    payload: endedPayload(),
    ...overrides,
  };
}

const build = (
  rows: readonly ChatPermissionStopLedgerRow[],
  newestAssistantReply: ChatPermissionStopNewestReply | null,
  sink?: DiagnosticCollector,
) =>
  chatPermissionStopTransitions({
    rows,
    newestAssistantReply,
    ...(sink === undefined ? {} : { sink }),
  });

describe("the emission window — exactly one reply is told", () => {
  it("emits one stop transition for a policy_withdrawn ending no reply has followed", () => {
    // The NPC-decision case: the ending was written during reply 1's settle,
    // guarded by (and created after) the assistant row it was read from.
    const transitions = build([row()], { id: "msg_reply_1", createdAt: at(500) });
    expect(transitions).toHaveLength(1);
    const transition = transitions[0];
    expect(transition).toMatchObject({
      id: `permission-stop:${REPLY_REF}:player->char_wren`,
      domainId: CHAT_CONTACT_DOMAIN_ID,
      subjectIds: ["player", "char_wren"],
      locusIds: ["shoulders"],
      beforeCodes: ["contact.locus.shoulders"],
      afterCodes: [CHAT_CONTACT_ENDED_CODE],
      relevance: "action",
      disclosure: "positive_detail_allowed",
    });
    // The cause NEVER rides the candidate: the withdrawal is policy-side.
    expect(transition?.causeCodes).toEqual([]);
    // Cooldown identity is ref-stable — a regenerate re-derives the same key.
    expect(transition?.repeatKey).toBe(`permission-stop:${REPLY_REF}:player->char_wren`);
  });

  it("emits nothing once a later assistant reply has followed the ending", () => {
    const transitions = build([row()], { id: "msg_reply_2", createdAt: at(5_000) });
    expect(transitions).toEqual([]);
  });

  it("the guard-is-newest branch emits even on a created-at tie", () => {
    // Same timestamp as the newest reply: the timestamp branch alone cannot
    // order them, and the guard identity is the belt that keeps the settle
    // case emitting.
    const transitions = build([row({ createdAt: at(500) })], { id: "msg_reply_1", createdAt: at(500) });
    expect(transitions).toHaveLength(1);
  });

  it("emits when the chat has no assistant reply at all — the next reply is the first", () => {
    expect(build([row()], null)).toHaveLength(1);
  });

  it("an override ending between exchanges pends by timestamp under its own ref", () => {
    const transitions = build(
      [
        row({
          eventRef: OVERRIDE_REF,
          // An override's guard is the newest MESSAGE, which may be a user line.
          guardMessageId: "msg_user_2",
          createdAt: at(5_000),
        }),
      ],
      { id: "msg_reply_1", createdAt: at(1_000) },
    );
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.repeatKey).toBe(`permission-stop:${OVERRIDE_REF}:player->char_wren`);
  });
});

describe("what is not this feature's to narrate", () => {
  it.each(["withdrawn", "separated", "scene_changed", "state_invalidated"] as const)(
    "a %s ending emits nothing",
    (reason) => {
      expect(build([row({ payload: endedPayload({ reason }) })], null)).toEqual([]);
    },
  );

  it("an ending outside the permission ref namespaces emits nothing", () => {
    expect(build([row({ eventRef: "contact:msg_user_1", guardMessageId: "msg_user_1" })], null)).toEqual([]);
  });
});

describe("degradation — the instruction survives an unreadable payload", () => {
  it("ships one generic stop transition plus a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const transitions = build([row({ payload: { kind: "contact_ended", contact: "garbage" } })], null, sink);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      id: `permission-stop:${REPLY_REF}:unreadable`,
      subjectIds: [],
      locusIds: [],
      beforeCodes: [],
      afterCodes: [CHAT_CONTACT_ENDED_CODE],
      relevance: "action",
      disclosure: "positive_detail_allowed",
    });
    expect(sink.items.map((item) => item.code)).toContain(CHAT_PERMISSION_STOP_UNREADABLE);
  });

  it("many unreadable endings collapse to ONE generic stop, each with its diagnostic", () => {
    const sink = new DiagnosticCollector();
    const transitions = build(
      [
        row({ payload: null }),
        row({ eventRef: OVERRIDE_REF, guardMessageId: "msg_user_2", payload: 42 }),
      ],
      null,
      sink,
    );
    expect(transitions).toHaveLength(1);
    expect(sink.items.filter((item) => item.code === CHAT_PERMISSION_STOP_UNREADABLE)).toHaveLength(2);
  });
});

describe("dedupe and bounds", () => {
  it("two endings of one pair collapse to one transition with merged loci", () => {
    const transitions = build(
      [row(), row({ contactId: "contact_2", payload: endedPayload({ locus: "hair" }) })],
      null,
    );
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.locusIds).toEqual(["shoulders", "hair"]);
  });

  it("every pair a multi-pair revocation ended gets its own stop", () => {
    // The ensemble case the budget used to eat: one reply's decisions end
    // contact on two distinct pairs. Each pair is its own binding instruction,
    // and the emission window closes with the next reply — so a pair that does
    // not emit HERE is never told to anyone.
    const sink = new DiagnosticCollector();
    const transitions = build(
      [
        row(),
        row({ contactId: "contact_2", payload: endedPayload({ actor: "char_mira", target: "char_wren" }) }),
      ],
      null,
      sink,
    );
    expect(transitions.map((transition) => transition.id)).toEqual([
      `permission-stop:${REPLY_REF}:player->char_wren`,
      `permission-stop:${REPLY_REF}:char_mira->char_wren`,
    ]);
    // Nothing was withheld, and nothing complained: both fit the tier.
    expect(sink.items).toEqual([]);
    expect(compileNarratorPhysicalGuidance({ transitions }).transitions).toHaveLength(2);
  });

  it("emits up to what one prompt can carry — the shared tier's own budget", () => {
    // The two numbers agree by construction; a drift between them is the bug
    // that loses a stop, so the equality is asserted rather than assumed.
    expect(CHAT_PERMISSION_STOP_TRANSITIONS_BOUND).toBe(GUIDANCE_MAX_TRANSITIONS);
    const rows = Array.from({ length: CHAT_PERMISSION_STOP_TRANSITIONS_BOUND }, (_, index) =>
      row({ contactId: `contact_${index}`, payload: endedPayload({ target: `char_${index}` }) }),
    );
    const sink = new DiagnosticCollector();
    const transitions = build(rows, null, sink);
    expect(transitions).toHaveLength(CHAT_PERMISSION_STOP_TRANSITIONS_BOUND);
    expect(compileNarratorPhysicalGuidance({ transitions }).transitions).toHaveLength(
      CHAT_PERMISSION_STOP_TRANSITIONS_BOUND,
    );
    expect(sink.items).toEqual([]);
  });

  it("trims past the bound HERE, loudly, keeping the newest pairs", () => {
    // Past what a prompt can carry the loss is real and permanent, so it is a
    // `warn` from the producer that knows that — never a silent downstream drop.
    const sink = new DiagnosticCollector();
    const rows = Array.from({ length: CHAT_PERMISSION_STOP_TRANSITIONS_BOUND + 1 }, (_, index) =>
      row({ contactId: `contact_${index}`, payload: endedPayload({ target: `char_${index}` }) }),
    );
    const transitions = build(rows, null, sink);
    expect(transitions).toHaveLength(CHAT_PERMISSION_STOP_TRANSITIONS_BOUND);
    // Survivors are the leading rows — and the loader hands rows newest-first,
    // so in production that is the newest pairs.
    expect(transitions[0]?.id).toBe(`permission-stop:${REPLY_REF}:player->char_0`);
    const overBound = sink.items.find((item) => item.code === CHAT_PERMISSION_STOP_OVER_BOUND);
    expect(overBound).toMatchObject({
      severity: "warn",
      context: { pending: rows.length, bound: CHAT_PERMISSION_STOP_TRANSITIONS_BOUND },
    });
  });

  it("trims the degraded generic before a named pair", () => {
    const sink = new DiagnosticCollector();
    const rows = [
      ...Array.from({ length: CHAT_PERMISSION_STOP_TRANSITIONS_BOUND }, (_, index) =>
        row({ contactId: `contact_${index}`, payload: endedPayload({ target: `char_${index}` }) }),
      ),
      row({ contactId: "contact_unreadable", payload: { kind: "contact_ended", contact: "garbage" } }),
    ];
    const transitions = build(rows, null, sink);
    expect(transitions).toHaveLength(CHAT_PERMISSION_STOP_TRANSITIONS_BOUND);
    expect(transitions.some((transition) => transition.id.endsWith(":unreadable"))).toBe(false);
    expect(sink.items.map((item) => item.code)).toContain(CHAT_PERMISSION_STOP_OVER_BOUND);
  });

  it("reads at most the newest few rows", () => {
    // Only the row past the bound carries a policy ending: a bounded read must
    // never reach it.
    const rows = [
      ...Array.from({ length: CHAT_PERMISSION_STOP_ROWS_BOUND }, (_, index) =>
        row({ contactId: `contact_${index}`, payload: endedPayload({ reason: "separated" }) }),
      ),
      row({ contactId: "contact_past_bound" }),
    ];
    expect(build(rows, null)).toEqual([]);
  });
});
