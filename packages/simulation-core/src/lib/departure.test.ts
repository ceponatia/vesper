import { describe, expect, it } from "vitest";
import { buildSoloDepartureLine, planDepartureChoreography, type SoloDeparture } from "./departure";

/**
 * Pure departure-choreography tests. No IO — the decision is
 * scene-stands × admitted-kind → choreography steps, and the arc line
 * is asserted from a fixture departure. The choreography's side effects (end
 * scene / move / drain) are integration-shaped and covered on Fly.
 */

describe("planDepartureChoreography", () => {
  it("a MOVE while a scene stands: end the scene as a choice, a parting beat, a farewell", () => {
    expect(planDepartureChoreography({ admittedKind: "move", sceneStands: true })).toEqual({
      choreograph: true,
      endSceneFirst: true,
      parted: true,
      farewell: true,
    });
  });

  it("a MOVE while already solo: walk there, but no end / parting / farewell", () => {
    expect(planDepartureChoreography({ admittedKind: "move", sceneStands: false })).toEqual({
      choreograph: true,
      endSceneFirst: false,
      parted: false,
      farewell: false,
    });
  });

  it("give / rest / nothing never choreograph, scene-stands either way", () => {
    for (const admittedKind of ["give_item", "start_activity", null] as const) {
      for (const sceneStands of [true, false]) {
        expect(planDepartureChoreography({ admittedKind, sceneStands })).toEqual({
          choreograph: false,
          endSceneFirst: false,
          parted: false,
          farewell: false,
        });
      }
    }
  });
});

describe("buildSoloDepartureLine", () => {
  it("a farewell names whom the player left, where, and the whole arc", () => {
    const departure: SoloDeparture = { farewellFrom: "Nora", fromLabel: "home", toLabel: "town square" };
    const line = buildSoloDepartureLine({ departure, playerName: "Bri" });
    expect(line).toBe(
      "This turn began with Bri taking their leave of Nora at home and setting out for the town square, " +
        "where they now are. Narrate the goodbye, the walk, and the arrival as one continuous moment — not a jump-cut.",
    );
  });

  it("a solo departure (no farewell) narrates only the walk and arrival", () => {
    const departure: SoloDeparture = { fromLabel: "town square", toLabel: "home" };
    const line = buildSoloDepartureLine({ departure, playerName: "Bri" });
    expect(line).toBe(
      "This turn, Bri set out from the town square for home, where they now are. " +
        "Narrate the walk and the arrival as one continuous moment.",
    );
    expect(line).not.toContain("goodbye");
  });
});
