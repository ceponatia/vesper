import { describe, expect, it } from "vitest";
import { emptyIntentBrief } from "@/contracts/turns/intent-brief";
import { intakeEnabled, intentBriefFromSceneIntent, runIntake, sceneIntentFromBrief } from "./intake";
import type { SceneIntent } from "./intent";

// Tests run with AI_FAKE=1 (src/test/setup.ts): demo mode short-circuits the
// LLM, so runIntake exercises the regex fallback path (which is the point —
// "intake off" must equal the engine's prior behavior).

describe("intake adapters", () => {
  it("sceneIntentFromBrief copies the five sense/target fields and nothing else", () => {
    const brief = emptyIntentBrief();
    brief.lookTarget = "Maya";
    brief.touchTarget = "Rhett";
    brief.smellTarget = "Maya";
    brief.examineItem = "lantern";
    brief.enterLocation = "Garden";
    brief.movement = { kind: "co_travel_request", destination: "Garden", coTravelTargets: ["Maya"] };
    expect(sceneIntentFromBrief(brief)).toEqual({
      lookTarget: "Maya",
      touchTarget: "Rhett",
      smellTarget: "Maya",
      examineItem: "lantern",
      enterLocation: "Garden",
    });
  });

  it("round-trips a SceneIntent losslessly (the five fields survive both directions)", () => {
    const intent: SceneIntent = { lookTarget: "Maya", touchTarget: "Rhett", enterLocation: "Garden" };
    expect(sceneIntentFromBrief(intentBriefFromSceneIntent(intent))).toEqual(intent);
  });

  it("the regex fallback brief leaves the classification seams at default", () => {
    const brief = intentBriefFromSceneIntent({ enterLocation: "Garden" });
    expect(brief.enterLocation).toBe("Garden");
    expect(brief.actionType).toBe("other");
    expect(brief.movement).toEqual({ kind: "none", coTravelTargets: [] });
    expect(brief.appointment).toBeUndefined();
  });
});

describe("runIntake (demo / disabled → regex fallback)", () => {
  it("intake is disabled in demo mode", () => {
    expect(intakeEnabled()).toBe(false);
  });

  it("resolves a look target from the regex fallback", async () => {
    const brief = await runIntake({
      playerInput: "I look at Maya and smile",
      presentNpcNames: ["Maya"],
      otherNpcNames: [],
      itemNames: [],
      currentLocationName: "Kitchen",
      locationNames: ["Kitchen", "Garden"],
    });
    expect(brief.lookTarget).toBe("Maya");
    expect(brief.actionType).toBe("other"); // the regex doesn't classify type
  });

  it("resolves an enter location from the regex fallback", async () => {
    const brief = await runIntake({
      playerInput: "I head into the garden",
      presentNpcNames: [],
      otherNpcNames: [],
      itemNames: [],
      currentLocationName: "Kitchen",
      locationNames: ["Kitchen", "Garden"],
    });
    expect(brief.enterLocation).toBe("garden");
  });

  it("returns an empty brief for plain dialogue", async () => {
    const brief = await runIntake({
      playerInput: "Good morning, how did you sleep?",
      presentNpcNames: ["Maya"],
      otherNpcNames: [],
      itemNames: [],
      currentLocationName: "Kitchen",
      locationNames: ["Kitchen"],
    });
    expect(brief).toEqual(emptyIntentBrief());
  });
});
