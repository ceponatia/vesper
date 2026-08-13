import { describe, expect, it } from "vitest";
import {
  adapterSupported,
  commitContactResolution,
  contactCommitEvents,
  contactEventRef,
  emptyContactLifecycleState,
  endAllContacts,
  resolveContactAttempt,
  type CommittableContactResolution,
  type CommittedContactOutcome,
  type ContactLifecycleCommit,
  type ContactLifecycleState,
  type ContactMaterialLayerRead,
} from "@/contracts";
// The contact core's probe builders are deliberately out of the barrel (a probe
// default that reached production would become a physical claim nobody made).
import { probeAttempt, probeLayer } from "@/contracts/affordances/contact/test-support";
import {
  chatContactEventRowsFor,
  chatContactLedgerMismatches,
  chatContactRowMatches,
  type AppendChatContactEventsInput,
  type ChatContactEventInsert,
  type ChatContactEventStoredRow,
} from "./chat-contact-events";

/**
 * The ledger's PURE half — the commit-to-row mapping (`chatContactEventRowsFor`,
 * and the two rules the idempotency key rests on) and the conflict judgment
 * (`chatContactRowMatches` / `chatContactLedgerMismatches`, which is what stops
 * an acknowledgment being built over somebody else's record). Fixtures come from
 * the real contact core rather than hand-built literals, so a shape change
 * upstream fails here rather than passing against a stale copy of it.
 *
 * The database half — that the insert and the projection settle in one
 * transaction, and that a mismatch leaves neither behind — is the integration
 * suite's.
 */

const CHAT_ID = "chat_probe";
const GUARD_MESSAGE_ID = "msg_probe_guard";
const EVENT = contactEventRef("chat_msg_probe_guard");
const STORY_MINUTE = 100;

function committable(layers: readonly ContactMaterialLayerRead[] = []): CommittableContactResolution {
  const attempt = probeAttempt({ context: { material: adapterSupported({ layers, evidence: [] }) } });
  const resolution = resolveContactAttempt(attempt);
  if (resolution.status !== "committable") throw new Error(`fixture did not commit: ${resolution.status}`);
  return resolution;
}

function mustCommit(
  state: ContactLifecycleState,
  resolution: CommittableContactResolution,
): CommittedContactOutcome {
  const outcome = commitContactResolution({ state, resolution, eventRef: EVENT });
  if (outcome.status !== "committed") throw new Error(`fixture was refused: ${outcome.reason}`);
  return outcome;
}

function appendInput(commits: readonly ContactLifecycleCommit[]): AppendChatContactEventsInput {
  return {
    chatId: CHAT_ID,
    guardMessageId: GUARD_MESSAGE_ID,
    eventRef: EVENT,
    storyMinute: STORY_MINUTE,
    commits,
  };
}

const started = mustCommit(emptyContactLifecycleState(), committable());
/** The same assertion again, unchanged: the core answers `contact_continued`. */
const held = mustCommit(started.state, committable());
/** A layer appeared between the surfaces — a real change, so `contact_updated`. */
const updated = mustCommit(started.state, committable([probeLayer("sock")]));
const ends = endAllContacts({
  state: started.state,
  reason: "separated",
  storyTime: STORY_MINUTE,
  eventRef: EVENT,
}).commits;

describe("chatContactEventRowsFor (the durable contact ledger's row mapping)", () => {
  it("stamps one row per commit with the exchange's guard, event ref and story minute", () => {
    const rows = chatContactEventRowsFor(appendInput([started.commit]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chatId: CHAT_ID,
      guardMessageId: GUARD_MESSAGE_ID,
      eventRef: EVENT,
      sequence: 0,
      kind: "contact_started",
      contactId: started.contact.contactId,
      storyMinute: STORY_MINUTE,
    });
  });

  it("carries the commit verbatim as the payload — this store never interprets one", () => {
    const rows = chatContactEventRowsFor(appendInput([started.commit]));
    expect(rows[0]?.payload).toBe(started.commit);
  });

  it("lifts the contact id off an update and an end, not just a start", () => {
    const rows = chatContactEventRowsFor(appendInput([updated.commit, ...ends]));
    expect(rows.map((row) => row.kind)).toEqual(["contact_updated", "contact_ended"]);
    expect(new Set(rows.map((row) => row.contactId))).toEqual(new Set([started.contact.contactId]));
  });

  it("gives every commit of ONE event the same ref and a distinct sequence", () => {
    // The shape `contactCommitEvents` produces: the ends that freed the pair
    // ahead of the start that claimed it, all stamped with one event ref — which
    // is precisely why the event ref alone cannot be the idempotency key.
    const rows = chatContactEventRowsFor(appendInput([...ends, started.commit]));
    expect(rows).toHaveLength(ends.length + 1);
    expect(rows.every((row) => row.eventRef === EVENT)).toBe(true);
    expect(rows.map((row) => row.sequence)).toEqual([...rows.keys()]);
  });

  it("does not persist contact_continued, and leaves its sequence as a gap", () => {
    const rows = chatContactEventRowsFor(appendInput([held.commit, started.commit]));
    // An unchanged held contact across ten exchanges is ONE start, not ten rows.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("contact_started");
    // Sequence 1, not 0: the index is into the WHOLE commit list, so a retry that
    // re-derives it lands on the same key instead of colliding with another row.
    expect(rows[0]?.sequence).toBe(1);
  });

  it("maps an all-continued event to nothing at all", () => {
    expect(chatContactEventRowsFor(appendInput([held.commit]))).toEqual([]);
    expect(chatContactEventRowsFor(appendInput([]))).toEqual([]);
  });

  it("re-derives identical keys for a replayed event (what makes the write idempotent)", () => {
    const commits = [...ends, started.commit];
    const first = chatContactEventRowsFor(appendInput(commits));
    const second = chatContactEventRowsFor(appendInput(commits));
    expect(second.map((row) => [row.eventRef, row.sequence])).toEqual(
      first.map((row) => [row.eventRef, row.sequence]),
    );
  });

  it("numbers ONE combined exchange list — hook ends, a held contact, then the touch", () => {
    // The shape the leg hands the store: the ends its hooks asserted (a time skip,
    // a room change), whatever the plan folded, then `contactCommitEvents` for the
    // touch — all in ONE call, because the sequence indexes the whole list and a
    // second append would restart it on top of these keys.
    const combined = [...ends, held.commit, ...contactCommitEvents(started)];
    const rows = chatContactEventRowsFor(appendInput(combined));
    expect(rows.map((row) => row.kind)).toEqual([...ends.map(() => "contact_ended"), "contact_started"]);
    expect(new Set(rows.map((row) => row.eventRef))).toEqual(new Set([EVENT]));
    // The last commit's sequence is its index in the WHOLE list — strictly past its
    // place among the surviving rows, because the held contact in the middle wrote
    // nothing and left its index behind.
    expect(rows.at(-1)?.sequence).toBe(combined.length - 1);
    expect(rows.at(-1)?.sequence).toBeGreaterThan(rows.length - 1);
  });
});

/**
 * Postgres `jsonb` keeps its OWN key order, not the writer's, so a row read back
 * is never byte-comparable with the commit that produced it. Reversing every
 * object's keys is the cheapest way to hold the comparison to that standard.
 */
function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    const entries: readonly unknown[] = value;
    return entries.map((entry) => reorderKeys(entry));
  }
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const reordered: Record<string, unknown> = {};
  for (const key of Object.keys(record).reverse()) reordered[key] = reorderKeys(record[key]);
  return reordered;
}

/** The row as the store reads it back: through JSON, in the column's own key order. */
function storedFrom(
  row: ChatContactEventInsert,
  overrides: Partial<ChatContactEventStoredRow> = {},
): ChatContactEventStoredRow {
  return {
    sequence: row.sequence,
    kind: row.kind,
    contactId: row.contactId,
    storyMinute: row.storyMinute,
    payload: reorderKeys(JSON.parse(JSON.stringify(row.payload))),
    ...overrides,
  };
}

const attemptedRows = chatContactEventRowsFor(appendInput([...ends, started.commit]));
const attempted = attemptedRows.at(-1);
if (attempted === undefined) throw new Error("fixture produced no rows to compare");

describe("chatContactRowMatches (is the row under this key the row we meant to write?)", () => {
  it("accepts the same record read back through jsonb, key order and all", () => {
    // The idempotent retry — the ONLY reading of `inserted: 0` that may be
    // acknowledged, and it must survive the column's own key ordering.
    expect(chatContactRowMatches(attempted, storedFrom(attempted))).toBe(true);
  });

  it("rejects a row recorded under this key for another contact, kind, or minute", () => {
    expect(chatContactRowMatches(attempted, storedFrom(attempted, { contactId: "contact_other" }))).toBe(false);
    expect(chatContactRowMatches(attempted, storedFrom(attempted, { kind: "contact_updated" }))).toBe(false);
    expect(chatContactRowMatches(attempted, storedFrom(attempted, { storyMinute: STORY_MINUTE + 1 }))).toBe(false);
  });

  it("rejects a row whose payload disagrees, however deep the disagreement", () => {
    const drifted: unknown = {
      ...(JSON.parse(JSON.stringify(attempted.payload)) as Record<string, unknown>),
      kind: "contact_ended",
    };
    expect(chatContactRowMatches(attempted, storedFrom(attempted, { payload: drifted }))).toBe(false);
    expect(chatContactRowMatches(attempted, storedFrom(attempted, { payload: null }))).toBe(false);
  });
});

describe("chatContactLedgerMismatches (which conflicting keys hold somebody else's record)", () => {
  it("finds nothing when every conflicting row is this write, already landed", () => {
    expect(chatContactLedgerMismatches(attemptedRows, attemptedRows.map((row) => storedFrom(row)))).toEqual([]);
  });

  it("names the diverging keys, in sequence order", () => {
    const stored = attemptedRows.map((row, index) =>
      index === 0 ? storedFrom(row, { contactId: "contact_stale" }) : storedFrom(row),
    );
    // A stale take's row under a key this exchange means to write is exactly what
    // an on→off→on flag sequence can leave behind — and acknowledging it would
    // report that take's record as this turn's commit.
    expect(chatContactLedgerMismatches(attemptedRows, stored)).toEqual([{ eventRef: EVENT, sequence: 0 }]);
  });

  it("treats a key with no stored row as nothing to disagree with", () => {
    expect(chatContactLedgerMismatches(attemptedRows, [])).toEqual([]);
  });
});
