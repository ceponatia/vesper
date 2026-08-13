import { describe, expect, it } from "vitest";
import { activeRomanticPermissionGrants, DiagnosticCollector, type RomanticPermissionEvent } from "@/contracts";
// The permission probe builders are deliberately out of the barrel (a probe
// grant that reached production would be a permission nobody gave).
import { probePermissionEvent } from "@/contracts/affordances/permission/test-support";
import {
  chatPermissionEventRowsFor,
  chatPermissionEventsFromRows,
  chatPermissionLedgerMismatches,
  chatPermissionOverrideEventRef,
  chatPermissionReplyEventRef,
  chatPermissionRowMatches,
  foldChatPermissionProjection,
  type ChatPermissionEventInsert,
  type ChatPermissionEventRow,
  type ChatPermissionEventStoredRow,
} from "./chat-permission-events";

/**
 * The permission ledger's PURE half — the event-to-row mapping (the idempotency
 * identity), the conflict judgment (what stops an acknowledgment being built
 * over somebody else's record), and the fold wrapper's trust boundary (a
 * malformed payload is dropped and can never fold into a grant). Fixtures come
 * from the real permission contracts rather than hand-built literals, so a
 * shape change upstream fails here rather than passing against a stale copy.
 *
 * The database half — atomicity of rows + invalidation + scene, idempotent
 * retry, verified conflict — is `chat-permission.int.test.ts`'s.
 */

const CHAT_ID = "chat_probe";
const GUARD_MESSAGE_ID = "msg_probe_guard";
const EVENT_REF = chatPermissionReplyEventRef("msg_probe_assistant");

const grant = probePermissionEvent({ eventId: "evt_grant", branchId: CHAT_ID, storyTime: 100 });
const withdrawal = probePermissionEvent({
  eventId: "evt_withdraw",
  branchId: CHAT_ID,
  kind: "withdrawn",
  storyTime: 120,
  orderInSource: 1,
});

function rowsFor(events: readonly RomanticPermissionEvent[]): ChatPermissionEventInsert[] {
  return chatPermissionEventRowsFor({
    chatId: CHAT_ID,
    guardMessageId: GUARD_MESSAGE_ID,
    eventRef: EVENT_REF,
    events,
  });
}

// The flag's composition matrix lives with the flag, in
// `prompts/constants.test.ts` — one owner, so a change to what
// `CHAT_ROMANTIC_PERMISSION` composes over cannot leave a second copy of the
// rule asserting the old answer somewhere else.

describe("the event-ref namespaces", () => {
  it("keeps the two producers' refs disjoint from each other and from the contact ledger's", () => {
    expect(chatPermissionReplyEventRef("m1")).toBe("permission-reply:m1");
    expect(chatPermissionOverrideEventRef("e1")).toBe("permission-override:e1");
    // The contact ledger writes under `contact:`/`contact-reply:`; a shared
    // prefix would let one ledger's retry collide with the other's record.
    expect(chatPermissionReplyEventRef("m1").startsWith("contact")).toBe(false);
    expect(chatPermissionOverrideEventRef("e1").startsWith("contact")).toBe(false);
  });
});

describe("chatPermissionEventRowsFor (the durable permission ledger's row mapping)", () => {
  it("stamps one row per event with the guard, ref, sequence, and the queryable copies", () => {
    const rows = rowsFor([grant, withdrawal]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      chatId: CHAT_ID,
      guardMessageId: GUARD_MESSAGE_ID,
      eventRef: EVENT_REF,
      sequence: 0,
      kind: "granted",
      sourceKind: "npc_decision",
      permittedActorId: grant.permittedActorId,
      grantingTargetId: grant.grantingTargetId,
      scope: "romantic_touch",
    });
    expect(rows[1]).toMatchObject({ sequence: 1, kind: "withdrawn" });
  });

  it("carries the event verbatim as the payload — this store never interprets one", () => {
    const rows = rowsFor([grant]);
    expect(rows[0]?.payload).toBe(grant);
  });

  it("copies the EVENT's own story minute, so the column cannot disagree with the payload", () => {
    const rows = rowsFor([grant, withdrawal]);
    expect(rows.map((row) => row.storyMinute)).toEqual([100, 120]);
  });

  it("carries a null guard for the pre-message developer-override case", () => {
    const rows = chatPermissionEventRowsFor({
      chatId: CHAT_ID,
      guardMessageId: null,
      eventRef: chatPermissionOverrideEventRef("evt_grant"),
      events: [grant],
    });
    expect(rows[0]?.guardMessageId).toBeNull();
  });

  it("re-derives identical keys for a replayed call (what makes the write idempotent)", () => {
    const first = rowsFor([grant, withdrawal]);
    const second = rowsFor([grant, withdrawal]);
    expect(second.map((row) => [row.eventRef, row.sequence])).toEqual(
      first.map((row) => [row.eventRef, row.sequence]),
    );
  });
});

/**
 * Postgres `jsonb` keeps its OWN key order, not the writer's, so a row read
 * back is never byte-comparable with the event that produced it. Reversing
 * every object's keys holds the comparison to that standard.
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
  row: ChatPermissionEventInsert,
  overrides: Partial<ChatPermissionEventStoredRow> = {},
): ChatPermissionEventStoredRow {
  return {
    sequence: row.sequence,
    kind: row.kind,
    sourceKind: row.sourceKind,
    permittedActorId: row.permittedActorId,
    grantingTargetId: row.grantingTargetId,
    scope: row.scope,
    storyMinute: row.storyMinute,
    payload: reorderKeys(JSON.parse(JSON.stringify(row.payload))),
    ...overrides,
  };
}

const attemptedRows = rowsFor([grant, withdrawal]);
const attempted = attemptedRows[0];
if (attempted === undefined) throw new Error("fixture produced no rows to compare");

describe("chatPermissionRowMatches (is the row under this key the row we meant to write?)", () => {
  it("accepts the same record read back through jsonb, key order and all", () => {
    expect(chatPermissionRowMatches(attempted, storedFrom(attempted))).toBe(true);
  });

  it("rejects a row recorded under this key for another direction, kind, scope, or minute", () => {
    expect(chatPermissionRowMatches(attempted, storedFrom(attempted, { kind: "withdrawn" }))).toBe(false);
    expect(chatPermissionRowMatches(attempted, storedFrom(attempted, { sourceKind: "developer_override" }))).toBe(false);
    expect(chatPermissionRowMatches(attempted, storedFrom(attempted, { permittedActorId: "somebody_else" }))).toBe(false);
    expect(chatPermissionRowMatches(attempted, storedFrom(attempted, { grantingTargetId: "somebody_else" }))).toBe(false);
    expect(chatPermissionRowMatches(attempted, storedFrom(attempted, { scope: "intimate_touch" }))).toBe(false);
    expect(chatPermissionRowMatches(attempted, storedFrom(attempted, { storyMinute: 999 }))).toBe(false);
  });

  it("rejects a row whose payload disagrees, however deep the disagreement", () => {
    const drifted: unknown = {
      ...(JSON.parse(JSON.stringify(attempted.payload)) as Record<string, unknown>),
      kind: "withdrawn",
    };
    expect(chatPermissionRowMatches(attempted, storedFrom(attempted, { payload: drifted }))).toBe(false);
    expect(chatPermissionRowMatches(attempted, storedFrom(attempted, { payload: null }))).toBe(false);
  });
});

describe("chatPermissionLedgerMismatches (which conflicting keys hold somebody else's record)", () => {
  it("finds nothing when every conflicting row is this write, already landed", () => {
    expect(
      chatPermissionLedgerMismatches(attemptedRows, attemptedRows.map((row) => storedFrom(row))),
    ).toEqual([]);
  });

  it("names the diverging keys, in sequence order", () => {
    const stored = attemptedRows.map((row, index) =>
      index === 0 ? storedFrom(row, { kind: "attempt_denied" }) : storedFrom(row),
    );
    expect(chatPermissionLedgerMismatches(attemptedRows, stored)).toEqual([
      { eventRef: EVENT_REF, sequence: 0 },
    ]);
  });

  it("treats a key with no stored row as nothing to disagree with", () => {
    expect(chatPermissionLedgerMismatches(attemptedRows, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The fold wrapper's trust boundary
// ---------------------------------------------------------------------------

/** A read-side row, as `listChatPermissionEvents` would hand it back. */
function readRow(payload: unknown, sequence: number): ChatPermissionEventRow {
  return {
    id: `row_${sequence}`,
    guardMessageId: GUARD_MESSAGE_ID,
    eventRef: EVENT_REF,
    sequence,
    kind: "granted",
    sourceKind: "npc_decision",
    permittedActorId: "alex",
    grantingTargetId: "mara",
    scope: "romantic_touch",
    storyMinute: 100,
    payload,
    createdAt: new Date(0),
  };
}

describe("foldChatPermissionProjection (rows → the active projection)", () => {
  it("folds well-formed payloads into the standing grants", () => {
    const sink = new DiagnosticCollector();
    const projection = foldChatPermissionProjection([readRow(grant, 0)], sink);
    expect(activeRomanticPermissionGrants(projection)).toHaveLength(1);
    expect(sink.items).toEqual([]);
  });

  it("applies a withdrawal after its grant, in row order", () => {
    const projection = foldChatPermissionProjection([readRow(grant, 0), readRow(withdrawal, 1)]);
    expect(activeRomanticPermissionGrants(projection)).toEqual([]);
    expect(projection.entries.map((entry) => entry.standing)).toEqual(["withdrawn"]);
  });

  it("drops a malformed payload with the boundary diagnostic — never repaired into a grant", () => {
    const sink = new DiagnosticCollector();
    const corrupt: Record<string, unknown> = {
      ...(JSON.parse(JSON.stringify(grant)) as Record<string, unknown>),
      kind: "blessed",
    };
    const projection = foldChatPermissionProjection([readRow(corrupt, 0)], sink);
    expect(projection.entries).toEqual([]);
    expect(sink.items.map((item) => item.code)).toEqual(["parse.boundary_failed"]);
  });

  it("recovers the typed events from the rows it can read, in order", () => {
    const events = chatPermissionEventsFromRows([readRow(grant, 0), readRow(withdrawal, 1)]);
    expect(events.map((event) => event.eventId)).toEqual(["evt_grant", "evt_withdraw"]);
  });
});
