import { describe, expect, it } from "vitest";
import type { TraitValue } from "../personality/traits/value";
import { atmosphereMoodBaselineShift, isTouchConcept, resolveTouchWelcomeness, touchMoodDeltas } from "./events";

const trait = (id: string, value: number): TraitValue => ({ id, value, source: "creation" });

describe("isTouchConcept", () => {
  it("recognizes physical_affection, not arbitrary concepts", () => {
    expect(isTouchConcept("physical_affection")).toBe(true);
    expect(isTouchConcept("compliment")).toBe(false);
  });
});

describe("resolveTouchWelcomeness", () => {
  it("affinity stage decides by default", () => {
    expect(resolveTouchWelcomeness({ affinityStage: "warm" })).toBe("welcome");
    expect(resolveTouchWelcomeness({ affinityStage: "smitten" })).toBe("welcome");
    expect(resolveTouchWelcomeness({ affinityStage: "cool" })).toBe("unwelcome");
    expect(resolveTouchWelcomeness({ affinityStage: "hostile" })).toBe("unwelcome");
    expect(resolveTouchWelcomeness({ affinityStage: "friendly" })).toBe("neutral");
    expect(resolveTouchWelcomeness({ affinityStage: "stranger" })).toBe("neutral");
  });

  it("a preference overrides the stage default", () => {
    expect(resolveTouchWelcomeness({ affinityStage: "hostile", preference: "like" })).toBe("welcome");
    expect(resolveTouchWelcomeness({ affinityStage: "smitten", preference: "dislike" })).toBe("unwelcome");
  });
});

describe("touchMoodDeltas", () => {
  it("welcome lifts mood and eases stress", () => {
    const d = touchMoodDeltas("welcome", { intimate: false, traits: [] });
    expect(d.mood).toBeGreaterThan(0);
    expect(d.stress).toBeLessThan(0);
  });

  it("unwelcome drops mood and spikes stress", () => {
    const d = touchMoodDeltas("unwelcome", { intimate: false, traits: [] });
    expect(d.mood).toBeLessThan(0);
    expect(d.stress).toBeGreaterThan(0);
  });

  it("neutral is a faint nudge, no stress", () => {
    const d = touchMoodDeltas("neutral", { intimate: false, traits: [] });
    expect(d.mood).toBeGreaterThan(0);
    expect(d.stress).toBe(0);
  });

  it("composure steadies an unwelcome touch; volatility sharpens it", () => {
    const calm = touchMoodDeltas("unwelcome", { intimate: false, traits: [trait("temperament.composure", 100)] });
    const plain = touchMoodDeltas("unwelcome", { intimate: false, traits: [] });
    const volatile = touchMoodDeltas("unwelcome", { intimate: false, traits: [trait("temperament.composure", -100)] });
    expect(Math.abs(calm.mood)).toBeLessThan(Math.abs(plain.mood));
    expect(Math.abs(volatile.mood)).toBeGreaterThan(Math.abs(plain.mood));
  });

  it("an intimate touch amplifies the swing", () => {
    const plain = touchMoodDeltas("welcome", { intimate: false, traits: [] });
    const intimate = touchMoodDeltas("welcome", { intimate: true, traits: [] });
    expect(intimate.mood).toBeGreaterThan(plain.mood);
  });
});

describe("atmosphereMoodBaselineShift", () => {
  it("warm tones lift, dark tones drop, calm is neutral", () => {
    expect(atmosphereMoodBaselineShift("romantic", [])).toBeGreaterThan(0);
    expect(atmosphereMoodBaselineShift("ominous", [])).toBeLessThan(0);
    expect(atmosphereMoodBaselineShift("calm", [])).toBe(0);
  });

  it("composure damps how far the room moves her", () => {
    const composed = atmosphereMoodBaselineShift("tense", [trait("temperament.composure", 100)]);
    const plain = atmosphereMoodBaselineShift("tense", []);
    expect(Math.abs(composed)).toBeLessThan(Math.abs(plain));
  });
});
