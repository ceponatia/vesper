import { describe, expect, it } from "vitest";
import { expectUniqueBy } from "@/test/registry-invariants";
import {
  allStageBehaviorProfiles,
  escalationTiers,
  stageBehaviorProfile,
  stageIdsMissingProfiles,
  tierWithinFloor,
} from "./profile";
import { relationshipStages } from "./stages";

describe("stageBehaviorProfile (spec §7.1)", () => {
  it("covers every registry stage exactly once", () => {
    expect(stageIdsMissingProfiles()).toEqual([]);
    const profiles = allStageBehaviorProfiles();
    expectUniqueBy(profiles, (profile) => profile.stageId, "stageBehaviorProfiles");
    expect(profiles.length).toBe(relationshipStages.length);
  });

  it("heals an unknown stage id to the neutral stranger profile", () => {
    expect(stageBehaviorProfile("no-such-stage").stageId).toBe("stranger");
    expect(stageBehaviorProfile("close").stageId).toBe("close");
  });

  it("keeps the escalation floor monotonic non-decreasing across the positive arc", () => {
    // The registry is ordered hostile → smitten; a later (warmer) stage must never
    // entertain LESS than an earlier one — the whole point of stage-gated escalation.
    const order = relationshipStages.map((s) => escalationTiers.indexOf(stageBehaviorProfile(s.id).escalationFloor));
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThanOrEqual(order[i - 1] as number);
    }
  });

  it("gates by floor: hostile entertains nothing, stranger entertains flirtation, close entertains intimacy", () => {
    expect(tierWithinFloor("flirtation", stageBehaviorProfile("hostile").escalationFloor)).toBe(false);
    expect(tierWithinFloor("flirtation", stageBehaviorProfile("stranger").escalationFloor)).toBe(true);
    expect(tierWithinFloor("intimate", stageBehaviorProfile("stranger").escalationFloor)).toBe(false);
    expect(tierWithinFloor("intimate", stageBehaviorProfile("close").escalationFloor)).toBe(true);
  });

  it("every profile carries non-empty prompt phrases", () => {
    for (const p of allStageBehaviorProfiles()) {
      expect(p.initiative.length).toBeGreaterThan(0);
      expect(p.openness.length).toBeGreaterThan(0);
      expect(p.address.length).toBeGreaterThan(0);
      expect(p.deflection.length).toBeGreaterThan(0);
      expect(escalationTiers).toContain(p.escalationFloor);
    }
  });
});
