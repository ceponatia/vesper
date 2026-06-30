import { describe, expect, it } from "vitest";
import { visualStateNote } from "./character-scene";

describe("visualStateNote", () => {
  it("graders intoxication into tipsy vs drunk wording", () => {
    expect(visualStateNote({ intoxication: 0.5 })).toContain("lightly flushed");
    expect(visualStateNote({ intoxication: 0.8 })).toContain("unsteady");
  });

  it("reflects low hygiene as visible dishevelment", () => {
    expect(visualStateNote({ hygiene: 0.2 })).toContain("unwashed");
    expect(visualStateNote({ hygiene: 0.5 })).toContain("disheveled");
  });

  it("reflects exhaustion and arousal", () => {
    expect(visualStateNote({ energy: 0.1 })).toContain("exhausted");
    expect(visualStateNote({ arousal: 0.7 })).toContain("flushed");
  });

  it("is empty for a rested, presentable character", () => {
    expect(visualStateNote({ intoxication: 0, hygiene: 0.9, energy: 0.9, arousal: 0 })).toBe("");
    expect(visualStateNote({})).toBe("");
  });
});
