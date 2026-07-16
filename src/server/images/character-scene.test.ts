import { describe, expect, it } from "vitest";
import { visualStateNote } from "./character-scene";

describe("visualStateNote", () => {
  it("graders intoxication into tipsy vs drunk wording", () => {
    expect(visualStateNote({ intoxication: 0.5 })).toContain("loose and warm from a drink");
    expect(visualStateNote({ intoxication: 0.8 })).toContain("unsteady");
  });

  it("reflects low hygiene as visible dishevelment", () => {
    expect(visualStateNote({ hygiene: 0.2 })).toContain("unwashed");
    expect(visualStateNote({ hygiene: 0.5 })).toContain("disheveled");
  });

  it("reflects exhaustion and arousal", () => {
    expect(visualStateNote({ energy: 0.1 })).toContain("exhausted");
    expect(visualStateNote({ arousal: 0.7 })).toContain("breath shallow");
  });

  it("is empty for a rested, presentable character", () => {
    expect(visualStateNote({ intoxication: 0, hygiene: 0.9, energy: 0.9, arousal: 0 })).toBe("");
    expect(visualStateNote({})).toBe("");
  });

  // scene-pov-embodiment.plan.md slice 0 (owner report): skin-colour words render as
  // stage blusher. Every meter that used to reach for "flushed" must state physiology
  // instead — this asserts the invariant across the whole grid, not just the three
  // phrases that happened to carry the word.
  it("never states skin colour at any meter level (renders as clown makeup)", () => {
    const levels = [0, 0.2, 0.36, 0.5, 0.56, 0.71, 0.9, 1];
    for (const level of levels) {
      for (const meter of ["intoxication", "hygiene", "energy", "arousal"] as const) {
        expect(visualStateNote({ [meter]: level })).not.toMatch(/blush|flush|rosy|ruddy|red-faced/i);
      }
    }
    expect(visualStateNote({ intoxication: 0.8, hygiene: 0.2, energy: 0.1, arousal: 0.9 })).not.toMatch(
      /blush|flush|rosy|ruddy|red-faced/i,
    );
  });

  it("still carries arousal and drink as visible physiology", () => {
    const aroused = visualStateNote({ arousal: 0.7 });
    expect(aroused).toMatch(/eyes|lips|breath|sweat/);
    const drunk = visualStateNote({ intoxication: 0.8 });
    expect(drunk).toMatch(/eyes|posture|unsteady/);
  });
});
