import { describe, expect, it } from "vitest";
import {
  adapterSupported,
  commitContactResolution,
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
import { chatContactEventRowsFor, type AppendChatContactEventsInput } from "./chat-contact-events";

/**
 * The ledger's PURE half (`chatContactEventRowsFor`) — the commit-to-row mapping
 * and the two rules the idempotency key rests on. Fixtures come from the real
 * contact core rather than hand-built literals, so a shape change upstream fails
 * here rather than passing against a stale copy of it.
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
});
