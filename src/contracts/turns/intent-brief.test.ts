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

  it("round-trips the sense/target fields and the persisted seams", () => {
    const parsed = intentBriefSchema.parse({
      actionType: "move",
      enterLocation: "Anchor Cafe",
      addressedNpcs: ["Eleanor"],
      movement: { kind: "co_travel_request", destination: "Anchor Cafe", coTravelTargets: ["Eleanor"] },
      appointment: { withNpc: "Eleanor", location: "Brian's Apartment", timePhrase: "5:30", reason: "a date" },
      check: { relevantAttributeIds: ["charisma"], stakes: "high" },
    });
    expect(parsed.actionType).toBe("move");
    expect(parsed.enterLocation).toBe("Anchor Cafe");
    expect(parsed.movement).toEqual({
      kind: "co_travel_request",
      destination: "Anchor Cafe",
      coTravelTargets: ["Eleanor"],
    });
    expect(parsed.appointment?.timePhrase).toBe("5:30");
    expect(parsed.check?.stakes).toBe("high");
  });
});
