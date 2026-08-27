import { describe, expect, it } from "vitest";
import {
  appendMilestones,
  appendRelationshipSample,
  deriveExchangeMilestones,
  MILESTONES_CAP,
  RELATIONSHIP_HISTORY_CAP,
  STRONG_REACTION_DELTA,
  unseenMilestoneReason,
  type Milestone,
  type RelationshipSample,
} from "./history";

const sample = (regard: number, i = 0): RelationshipSample => ({
  at: `2026-07-02T12:00:0${i}Z`,
  clockMinutes: i,
  regard,
  band: "neutral",
  familiarity: 0,

});

describe("appendRelationshipSample / appendMilestones (capped rings)", () => {
  it("appends and keeps the newest RELATIONSHIP_HISTORY_CAP samples", () => {
    const full = Array.from({ length: RELATIONSHIP_HISTORY_CAP }, (_, i) => sample(i));
    const next = appendRelationshipSample(full, sample(999, 9));
    expect(next).toHaveLength(RELATIONSHIP_HISTORY_CAP);
    expect(next.at(-1)?.regard).toBe(999);
    expect(next[0]?.regard).toBe(1); // the oldest fell off
  });

  it("caps milestones the same way and no-ops on an empty add", () => {
    const m = (i: number): Milestone => ({ at: `${i}`, kind: "player_marked", label: `m${i}` });
    const full = Array.from({ length: MILESTONES_CAP }, (_, i) => m(i));
    expect(appendMilestones(full, [])).toHaveLength(MILESTONES_CAP);
    const next = appendMilestones(full, [m(999)]);
    expect(next).toHaveLength(MILESTONES_CAP);
    expect(next.at(-1)?.label).toBe("m999");
  });
});

describe("unseenMilestoneReason (v2 seen-cursor)", () => {
  const seenAt = new Date("2026-07-12T12:00:00Z");
  const m = (at: string, kind: Milestone["kind"], label: string): Milestone => ({ at, kind, label });

  it("returns the NEWEST milestone landed after the cursor; seen ones stay quiet", () => {
    const ring = [
      m("2026-07-12T11:00:00Z", "stage_up", "Neutral → Warm"),
      m("2026-07-12T13:00:00Z", "familiarity_up", "She let you in"),
      m("2026-07-12T14:00:00Z", "secret_shared", "Mara shared a secret"),
    ];
    expect(unseenMilestoneReason(ring, seenAt)).toBe("Mara shared a secret");
    expect(unseenMilestoneReason(ring, new Date("2026-07-12T15:00:00Z"))).toBeNull();
  });

  it("first_exchange never fires the marker, and bad timestamps are treated as seen", () => {
    expect(unseenMilestoneReason([m("2026-07-12T13:00:00Z", "first_exchange", "First words")], seenAt)).toBeNull();
    expect(unseenMilestoneReason([m("", "stage_up", "Neutral → Warm")], seenAt)).toBeNull();
    expect(unseenMilestoneReason([], seenAt)).toBeNull();
  });
});

describe("deriveExchangeMilestones", () => {
  const base = {
    at: "2026-07-02T12:00:00Z",
    messageId: "msg1",
    characterName: "Mara",
    firstExchange: false,
    preRegard: 0,
    postRegard: 0,
    regardDelta: 0,
    concept: null,
  };

  it("records the first exchange", () => {
    const out = deriveExchangeMilestones({ ...base, firstExchange: true });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("first_exchange");
    expect(out[0]?.label).toContain("Mara");
  });

  it("records stage crossings in both directions (D-ruling: down too)", () => {
    const up = deriveExchangeMilestones({ ...base, preRegard: 14, postRegard: 15 });
    expect(up.map((m) => m.kind)).toEqual(["stage_up"]);
    expect(up[0]?.label).toBe("Neutral → Friendly");
    const down = deriveExchangeMilestones({ ...base, preRegard: 15, postRegard: 14 });
    expect(down.map((m) => m.kind)).toEqual(["stage_down"]);
  });

  it("records a strong card-driven reaction at |delta| ≥ STRONG_REACTION_DELTA, labeled by concept", () => {
    const warm = deriveExchangeMilestones({
      ...base,
      preRegard: 10,
      postRegard: 10 + STRONG_REACTION_DELTA,
      regardDelta: STRONG_REACTION_DELTA,
      concept: "physical_affection",
    });
    expect(warm.map((m) => m.kind)).toEqual(["strong_reaction"]);
    expect(warm[0]?.label).toBe("Moved by physical affection");
    const stung = deriveExchangeMilestones({ ...base, regardDelta: -STRONG_REACTION_DELTA, concept: "insult" });
    expect(stung[0]?.label).toBe("Stung by insult");
  });

  it("an ordinary exchange derives nothing", () => {
    expect(deriveExchangeMilestones({ ...base, preRegard: 10, postRegard: 11, regardDelta: 1 })).toEqual([]);
  });

  it("one charged, stage-crossing first exchange stacks all three", () => {
    const out = deriveExchangeMilestones({
      ...base,
      firstExchange: true,
      preRegard: 12,
      postRegard: 17,
      regardDelta: 5,
      concept: "gift",
    });
    expect(out.map((m) => m.kind)).toEqual(["first_exchange", "stage_up", "strong_reaction"]);
  });
});
