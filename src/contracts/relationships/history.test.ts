import { describe, expect, it } from "vitest";
import {
  appendMilestones,
  appendRelationshipSample,
  deriveExchangeMilestones,
  MILESTONES_CAP,
  RELATIONSHIP_HISTORY_CAP,
  STRONG_REACTION_DELTA,
  type Milestone,
  type RelationshipSample,
} from "./history";

const sample = (affinity: number, i = 0): RelationshipSample => ({
  at: `2026-07-02T12:00:0${i}Z`,
  clockMinutes: i,
  affinity,
  stage: "stranger",
});

describe("appendRelationshipSample / appendMilestones (capped rings, spec §7.2)", () => {
  it("appends and keeps the newest RELATIONSHIP_HISTORY_CAP samples", () => {
    const full = Array.from({ length: RELATIONSHIP_HISTORY_CAP }, (_, i) => sample(i));
    const next = appendRelationshipSample(full, sample(999, 9));
    expect(next).toHaveLength(RELATIONSHIP_HISTORY_CAP);
    expect(next.at(-1)?.affinity).toBe(999);
    expect(next[0]?.affinity).toBe(1); // the oldest fell off
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

describe("deriveExchangeMilestones (spec §7.2)", () => {
  const base = {
    at: "2026-07-02T12:00:00Z",
    messageId: "msg1",
    characterName: "Mara",
    firstExchange: false,
    preAffinity: 0,
    postAffinity: 0,
    affinityDelta: 0,
    concept: null,
  };

  it("records the first exchange", () => {
    const out = deriveExchangeMilestones({ ...base, firstExchange: true });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("first_exchange");
    expect(out[0]?.label).toContain("Mara");
  });

  it("records stage crossings in both directions (D-ruling: down too)", () => {
    const up = deriveExchangeMilestones({ ...base, preAffinity: 14, postAffinity: 15 });
    expect(up.map((m) => m.kind)).toEqual(["stage_up"]);
    expect(up[0]?.label).toBe("Stranger → Acquaintance");
    const down = deriveExchangeMilestones({ ...base, preAffinity: 15, postAffinity: 14 });
    expect(down.map((m) => m.kind)).toEqual(["stage_down"]);
  });

  it("records a strong card-driven reaction at |delta| ≥ STRONG_REACTION_DELTA, labeled by concept", () => {
    const warm = deriveExchangeMilestones({
      ...base,
      preAffinity: 10,
      postAffinity: 10 + STRONG_REACTION_DELTA,
      affinityDelta: STRONG_REACTION_DELTA,
      concept: "physical_affection",
    });
    expect(warm.map((m) => m.kind)).toEqual(["strong_reaction"]);
    expect(warm[0]?.label).toBe("Moved by physical affection");
    const stung = deriveExchangeMilestones({ ...base, affinityDelta: -STRONG_REACTION_DELTA, concept: "insult" });
    expect(stung[0]?.label).toBe("Stung by insult");
  });

  it("an ordinary exchange derives nothing", () => {
    expect(deriveExchangeMilestones({ ...base, preAffinity: 10, postAffinity: 11, affinityDelta: 1 })).toEqual([]);
  });

  it("one charged, stage-crossing first exchange stacks all three", () => {
    const out = deriveExchangeMilestones({
      ...base,
      firstExchange: true,
      preAffinity: 12,
      postAffinity: 17,
      affinityDelta: 5,
      concept: "gift",
    });
    expect(out.map((m) => m.kind)).toEqual(["first_exchange", "stage_up", "strong_reaction"]);
  });
});
