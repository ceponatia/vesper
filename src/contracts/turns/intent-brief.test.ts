import { describe, expect, it } from "vitest";
import { emptyIntentBrief, intentBriefSchema } from "./intent-brief";

describe("intentBriefSchema", () => {
  it("parses the empty object to the degraded default (== no intent detected)", () => {
    const brief = emptyIntentBrief();
    expect(brief.actionType).toBe("other");
    expect(brief.lookTarget).toBeUndefined();
    expect(brief.addressedNpcs).toEqual([]);
    expect(brief.movement).toEqual({ kind: "none", coTravelTargets: [] });
    expect(brief.appointment).toBeUndefined();
    expect(brief.socialActs).toEqual([]);
    expect(brief.narratedNpcBehaviors).toEqual([]);
    expect(brief.notes).toBe("");
  });

  it("catches a bad actionType / movement.kind instead of rejecting the object", () => {
    const parsed = intentBriefSchema.parse({
      actionType: "teleport", // not in the enum
      lookTarget: "Maya",
      movement: { kind: "warp" }, // not in the enum
    });
    expect(parsed.actionType).toBe("other");
    expect(parsed.lookTarget).toBe("Maya");
    expect(parsed.movement.kind).toBe("none");
    expect(parsed.movement.coTravelTargets).toEqual([]);
  });

  it("caps over-long model-output arrays (slice, not reject) so a flood can't drive unbounded work", () => {
    // 200 entries each — well over the 30 cap. A rejecting .max() would drop the
    // whole brief to emptyIntentBrief(); the graceful slice keeps the first N and
    // preserves the rest of the brief (docs/resilience.md §3).
    const flood = Array.from({ length: 200 }, (_, i) => `NPC${i}`);
    const parsed = intentBriefSchema.parse({
      actionType: "converse",
      addressedNpcs: flood,
      socialActs: Array.from({ length: 200 }, (_, i) => ({ concept: "compliment", target: `T${i}` })),
      narratedNpcBehaviors: Array.from({ length: 200 }, (_, i) => ({ npc: `N${i}` })),
      movement: { kind: "co_travel_request", coTravelTargets: flood },
      check: { relevantAttributeIds: flood, stakes: "low" },
    });
    // Sliced to the cap (30), keeping the first N in order.
    expect(parsed.addressedNpcs).toHaveLength(30);
    expect(parsed.addressedNpcs[0]).toBe("NPC0");
    expect(parsed.socialActs).toHaveLength(30);
    expect(parsed.narratedNpcBehaviors).toHaveLength(30);
    expect(parsed.movement.coTravelTargets).toHaveLength(30);
    expect(parsed.check?.relevantAttributeIds).toHaveLength(30);
    // Graceful: the rest of the brief survives — the cap did NOT degrade to empty.
    expect(parsed.actionType).toBe("converse");
  });

  it("round-trips the sense/target fields and the persisted seams", () => {
    const parsed = intentBriefSchema.parse({
      actionType: "move",
      enterLocation: "Anchor Cafe",
      addressedNpcs: ["Eleanor"],
      movement: { kind: "co_travel_request", destination: "Anchor Cafe", coTravelTargets: ["Eleanor"] },
      appointment: { withNpc: "Eleanor", location: "Brian's Apartment", timePhrase: "5:30", reason: "a date" },
      check: { relevantAttributeIds: ["charisma"], stakes: "high" },
      narratedNpcBehaviors: [{ npc: "Eleanor", concept: "physical_affection", summary: "hugs Brian" }],
    });
    expect(parsed.actionType).toBe("move");
    expect(parsed.enterLocation).toBe("Anchor Cafe");
    expect(parsed.narratedNpcBehaviors).toEqual([{ npc: "Eleanor", concept: "physical_affection", summary: "hugs Brian" }]);
    expect(parsed.movement).toEqual({
      kind: "co_travel_request",
      destination: "Anchor Cafe",
      coTravelTargets: ["Eleanor"],
    });
    expect(parsed.appointment?.timePhrase).toBe("5:30");
    expect(parsed.check?.stakes).toBe("high");
  });
});
