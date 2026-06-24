import { describe, expect, it } from "vitest";
import type { ActiveCondition } from "../conditions/condition";
import type { EvaluatedReaction } from "../personality/reactions";
import { activationOf, deriveEmotionLabel, type EmotionInputs } from "./projection";

const base: EmotionInputs = {
  mood: 0.5,
  arousal: 0,
  stress: 0.15,
  energy: 0.9,
  affinityStage: "stranger",
  conditions: [],
  intimateContext: false,
};

const cond = (id: string): ActiveCondition => ({ id, label: id, startedAtMinutes: 0, attributeEffects: [] });
const reaction = (valence: "like" | "dislike", magnitude: number): EvaluatedReaction => ({
  valence,
  magnitude,
  band: "",
  hint: "",
});

describe("activationOf", () => {
  it("blends energy/stress/arousal into 0..1", () => {
    expect(activationOf({ energy: 0, stress: 0, arousal: 0 })).toBe(0);
    expect(activationOf({ energy: 1, stress: 1, arousal: 1 })).toBeCloseTo(1);
    expect(activationOf({ energy: 1, stress: 0, arousal: 0 })).toBeCloseTo(0.4);
  });
});

describe("deriveEmotionLabel — baseline", () => {
  it("even keel, calm ⇒ neutral", () => {
    expect(deriveEmotionLabel({ ...base, energy: 0.3 }).emotion).toBe("neutral");
  });

  it("high valence, low affinity ⇒ happy", () => {
    expect(deriveEmotionLabel({ ...base, mood: 0.8, energy: 0.3 }).emotion).toBe("happy");
  });

  it("high valence, energized, low affinity ⇒ playful", () => {
    expect(deriveEmotionLabel({ ...base, mood: 0.8, energy: 1, arousal: 0.6, stress: 0.2 }).emotion).toBe("playful");
  });

  it("high valence, close+ affinity, low stress ⇒ affectionate", () => {
    expect(deriveEmotionLabel({ ...base, mood: 0.8, stress: 0.1, affinityStage: "close" }).emotion).toBe("affectionate");
  });

  it("low valence, calm ⇒ sad", () => {
    expect(deriveEmotionLabel({ ...base, mood: 0.2, stress: 0.1, energy: 0.3 }).emotion).toBe("sad");
  });

  it("low valence, high stress, high arousal ⇒ afraid", () => {
    expect(deriveEmotionLabel({ ...base, mood: 0.2, stress: 0.8, arousal: 0.7 }).emotion).toBe("afraid");
  });

  it("low valence, high stress, low arousal ⇒ concerned", () => {
    expect(deriveEmotionLabel({ ...base, mood: 0.2, stress: 0.8, arousal: 0.1 }).emotion).toBe("concerned");
  });

  it("low valence + high dominance ⇒ angry over sad", () => {
    expect(deriveEmotionLabel({ ...base, mood: 0.2, stress: 0.2, dominance: 80 }).emotion).toBe("angry");
  });

  it("mid valence, high stress ⇒ concerned", () => {
    expect(deriveEmotionLabel({ ...base, mood: 0.5, stress: 0.75 }).emotion).toBe("concerned");
  });
});

describe("deriveEmotionLabel — aroused gate", () => {
  it("intimate frame + high arousal ⇒ aroused", () => {
    expect(deriveEmotionLabel({ ...base, mood: 0.6, arousal: 0.8, intimateContext: true }).emotion).toBe("aroused");
  });

  it("high arousal WITHOUT intimate frame ⇒ not aroused", () => {
    expect(deriveEmotionLabel({ ...base, mood: 0.6, arousal: 0.8, intimateContext: false }).emotion).not.toBe("aroused");
  });
});

describe("deriveEmotionLabel — condition tints", () => {
  it("flustered condition ⇒ flustered", () => {
    expect(deriveEmotionLabel({ ...base, conditions: [cond("flustered")] }).emotion).toBe("flustered");
  });

  it("tipsy + not-low mood ⇒ playful (loosened)", () => {
    expect(deriveEmotionLabel({ ...base, mood: 0.55, conditions: [cond("tipsy")] }).emotion).toBe("playful");
  });
});

describe("deriveEmotionLabel — transient beat", () => {
  it("strong boundary act ⇒ surprised", () => {
    const r = { ...base, reaction: reaction("dislike", 3), reactionConcept: "boundary_push" };
    expect(deriveEmotionLabel(r).emotion).toBe("surprised");
  });

  it("flirt at low affinity ⇒ flustered", () => {
    const r = { ...base, reaction: reaction("like", 2), reactionConcept: "flirt", affinityStage: "acquaintance" };
    expect(deriveEmotionLabel(r).emotion).toBe("flustered");
  });

  it("strong like at close affinity ⇒ affectionate spike", () => {
    const r = { ...base, reaction: reaction("like", 3), reactionConcept: "gift", affinityStage: "close" };
    expect(deriveEmotionLabel(r).emotion).toBe("affectionate");
  });

  it("dislike, low dominance ⇒ sad; high dominance ⇒ angry", () => {
    expect(deriveEmotionLabel({ ...base, reaction: reaction("dislike", 2) }).emotion).toBe("sad");
    expect(deriveEmotionLabel({ ...base, reaction: reaction("dislike", 2), dominance: 80 }).emotion).toBe("angry");
  });

  it("a weak reaction below the floor falls through to baseline", () => {
    const r = { ...base, mood: 0.8, energy: 0.3, reaction: reaction("like", 0.1) };
    expect(deriveEmotionLabel(r).emotion).toBe("happy");
  });

  it("intensity rises with reaction magnitude", () => {
    const weak = deriveEmotionLabel({ ...base, reaction: reaction("dislike", 0.5) }).intensity;
    const strong = deriveEmotionLabel({ ...base, reaction: reaction("dislike", 4) }).intensity;
    expect(strong).toBeGreaterThan(weak);
  });
});

describe("deriveEmotionLabel — totality", () => {
  it("returns a label even for NaN/garbage inputs", () => {
    const r = deriveEmotionLabel({ ...base, mood: Number.NaN, arousal: Number.NaN, stress: Number.NaN, energy: Number.NaN });
    expect(typeof r.emotion).toBe("string");
    expect(r.intensity).toBeGreaterThanOrEqual(0);
    expect(r.intensity).toBeLessThanOrEqual(1);
  });
});
