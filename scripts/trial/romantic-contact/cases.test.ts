import { describe, expect, it } from "vitest";
import type { ChatContactTurnRecord } from "@/server/engine";
import { deriveCaseState, refusalRecorded, TRIAL_CASES } from "./cases";

/**
 * The derivation that decides what the rollout oracle is shown.
 *
 * It matters more than it looks. The oracle is only as honest as the state it
 * grades against, and the tempting shortcut — deriving that state from the
 * case's stated expectation — would make the whole rerun self-confirming: a case
 * labelled "should refuse" that silently committed would be graded against the
 * refusal it was supposed to produce, and the instrument would report a pass for
 * the exact defect it exists to find.
 */

const record = (over: Partial<ChatContactTurnRecord> = {}): ChatContactTurnRecord => ({
  resultCodes: [],
  committed: false,
  ended: [],
  guidanceLines: [],
  ...over,
});

const NO_CONTACTS = { liveContactIds: [] as readonly string[] };

describe("which outcomes record a refusal the prose may portray", () => {
  it("a rejection does — that is somebody actually declining", () => {
    expect(refusalRecorded(record({ status: "rejected", reason: "permission_denied" }))).toBe(true);
  });

  /**
   * The rule the whole permission design rests on, and the one this rerun
   * re-tests: unknown is not denied. An unanswered owner licenses no refusal,
   * so a reply that writes one is inventing it.
   */
  it.each([
    ["permission_unresolved"],
    ["geometry_unavailable"],
    ["material_unavailable"],
  ])("an unresolved outcome does not — %s decided nothing", (reason) => {
    expect(refusalRecorded(record({ status: "unresolved", reason }))).toBe(false);
  });

  it("a required transition does not — 'the distance would have to be closed' is nobody declining", () => {
    expect(refusalRecorded(record({ status: "explicit_transition_required" }))).toBe(false);
  });
});

describe("deriving the graded state from what actually happened", () => {
  it("reads the recorded material fact, not the case's intent", () => {
    const state = deriveCaseState({
      record: record({ status: "committable", committed: true, directSkinContact: false }),
      before: NO_CONTACTS,
      after: { liveContactIds: ["contact_1"] },
    });
    expect(state).toEqual({
      committed: true,
      layer: "through_layer",
      refusalRecorded: false,
      endedLiveContact: false,
      contactLiveAfter: true,
    });
  });

  it("states no layer at all when nothing committed — there is no fact to contradict", () => {
    const state = deriveCaseState({
      record: record({ status: "unresolved", reason: "permission_unresolved" }),
      before: NO_CONTACTS,
      after: NO_CONTACTS,
    });
    expect(state.layer).toBeUndefined();
    expect(state.committed).toBe(false);
  });

  /**
   * The withdrawal case's whole claim, and it is deliberately read from the
   * projection either side rather than from the turn's own `ended` list: the
   * question is whether the contact is GONE, not whether the exchange said it
   * ended one.
   */
  it("sees a live contact disappear across the exchange", () => {
    const state = deriveCaseState({
      record: record({ status: "rejected", reason: "permission_withdrawn" }),
      before: { liveContactIds: ["contact_1"] },
      after: NO_CONTACTS,
    });
    expect(state.endedLiveContact).toBe(true);
    expect(state.contactLiveAfter).toBe(false);
  });

  it("does not call it ended when the same contact is still there", () => {
    const state = deriveCaseState({
      record: record({ status: "committable", committed: true, directSkinContact: true }),
      before: { liveContactIds: ["contact_1"] },
      after: { liveContactIds: ["contact_1"] },
    });
    expect(state.endedLiveContact).toBe(false);
  });
});

describe("the case list", () => {
  it("covers the six the owner named, and no case leaks its expectation into the graded state", () => {
    expect(TRIAL_CASES.map((entry) => entry.id)).toEqual([
      "no_grant",
      "explicit_denial",
      "natural_named",
      "commit",
      "withdrawal",
      "retake",
    ]);
  });
});
