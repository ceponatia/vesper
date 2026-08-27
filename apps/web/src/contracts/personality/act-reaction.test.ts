import { describe, expect, it } from "vitest";
import { evaluateActReaction } from "./act-reaction";
import type { Preference } from "./preference";

const NEUTRAL_MOOD_METER = 0.5;

function input(overrides: Partial<Parameters<typeof evaluateActReaction>[0]> = {}) {
  return {
    act: { concept: "compliment", target: "Mara" },
    disposition: { tags: [], preferences: [] as Preference[], cards: [] },
    affinity: 0,
    moodMeter: NEUTRAL_MOOD_METER,
    traits: [],
    deltaClamp: 5,
    ...overrides,
  };
}

describe("evaluateActReaction (the shared reaction sequence — both lanes)", () => {
  it("a matched preference runs the curve into a signed, clamped delta + mood nudge", () => {
    const prefs: Preference[] = [{ target: "compliment", valence: "like", intensity: 6 }];
    const out = evaluateActReaction(input({ disposition: { tags: [], preferences: prefs, cards: [] } }));
    expect(out.kind).toBe("reaction");
    if (out.kind !== "reaction") return;
    expect(out.conceptId).toBe("compliment");
    expect(out.affinityDelta).toBeGreaterThan(0);
    expect(out.affinityDelta).toBeLessThanOrEqual(5);
    expect(out.moodDelta).toBeGreaterThan(0);
    expect(out.evaluated.valence).toBe("like");
  });

  it("a dislike signs the delta negative and honors the caller's clamp", () => {
    const prefs: Preference[] = [{ target: "insult", valence: "dislike", intensity: 10 }];
    const out = evaluateActReaction(
      input({
        act: { concept: "insult", target: "Mara" },
        disposition: { tags: [], preferences: prefs, cards: [] },
        affinity: -80, // thin ice amplifies — guaranteed to exceed a small clamp
        deltaClamp: 3,
      }),
    );
    expect(out.kind).toBe("reaction");
    if (out.kind !== "reaction") return;
    expect(out.affinityDelta).toBe(-3);
    expect(out.moodDelta).toBeLessThan(0);
  });

  it("an unmatched touch concept falls back to affinity-stage welcome-ness", () => {
    const warm = evaluateActReaction(input({ act: { concept: "physical_affection", target: "Mara" }, affinity: 60 }));
    expect(warm.kind).toBe("touch");
    if (warm.kind !== "touch") return;
    expect(warm.moodDelta).toBeGreaterThan(0);

    const cold = evaluateActReaction(input({ act: { concept: "physical_affection", target: "Mara" }, affinity: -60 }));
    expect(cold.kind).toBe("touch");
    if (cold.kind !== "touch") return;
    expect(cold.moodDelta).toBeLessThan(0);
    expect(cold.stressDelta).toBeGreaterThan(0);
  });

  it("a preference-matched touch takes the curve, not the welcome-ness fallback", () => {
    const prefs: Preference[] = [{ target: "physical_affection", valence: "like", intensity: 6 }];
    const out = evaluateActReaction(
      input({
        act: { concept: "physical_affection", target: "Mara" },
        disposition: { tags: [], preferences: prefs, cards: [] },
      }),
    );
    expect(out.kind).toBe("reaction");
  });

  it("anything else unmatched is no reaction", () => {
    expect(evaluateActReaction(input()).kind).toBe("none");
  });
});
