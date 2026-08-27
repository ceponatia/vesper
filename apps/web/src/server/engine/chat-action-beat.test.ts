import { describe, expect, it } from "vitest";
import { CHAT_ACTIONS } from "@/contracts";
import { buildActionBeatCue } from "./chat-action-beat";

const base = { characterName: "Mara", playerName: "Theo" };

describe("buildActionBeatCue", () => {
  it("wraps every chip as a one-beat, don't-narrate-the-player stage direction naming the player", () => {
    for (const { id } of CHAT_ACTIONS) {
      const cue = buildActionBeatCue({ ...base, chipId: id, apart: false });
      expect(cue.startsWith("(")).toBe(true);
      expect(cue.endsWith(")")).toBe(true);
      expect(cue).toContain("One beat only");
      expect(cue).toContain("Do not narrate Theo");
      expect(cue).toContain("do not leap the scene forward");
      expect(cue.startsWith("(Theo ")).toBe(true); // the player's gesture opens it
    }
  });

  it("snapshots each chip's distinct gesture + reflected shift", () => {
    const cue = (id: (typeof CHAT_ACTIONS)[number]["id"]) => buildActionBeatCue({ ...base, chipId: id, apart: false });

    expect(cue("drink")).toContain("Theo offers you a drink, and you take it.");
    expect(cue("drink")).toContain("Play one small beat as you have some and let it loosen you a touch.");

    expect(cue("freshen")).toContain("Theo gives you a moment to freshen up.");
    expect(cue("freshen")).toContain("Play one small beat as you tidy yourself");

    expect(cue("rest")).toContain("Theo suggests the two of you take a breather.");
    expect(cue("rest")).toContain("Play one small beat as you ease off, let the tension go, and catch your breath.");

    expect(cue("fluster")).toContain("Theo heats things up between you.");
    expect(cue("fluster")).toContain("Play one small beat as the warmth of it catches you");
  });

  it("flips the register between co-present and apart, leaving the rest of the cue identical", () => {
    const together = buildActionBeatCue({ ...base, chipId: "drink", apart: false });
    const apart = buildActionBeatCue({ ...base, chipId: "drink", apart: true });

    expect(together).toContain("You are together in the scene — play it there, in the moment.");
    expect(together).not.toContain("apart right now");

    expect(apart).toContain("You and Theo are apart right now — answer as a text on its own line: *Mara: your words*.");
    expect(apart).not.toContain("together in the scene");

    // Only the register sentence differs — the gesture, shift, and restraint are shared.
    expect(together.replace("You are together in the scene — play it there, in the moment.", "<REG>")).toBe(
      apart.replace("You and Theo are apart right now — answer as a text on its own line: *Mara: your words*.", "<REG>"),
    );
  });
});
