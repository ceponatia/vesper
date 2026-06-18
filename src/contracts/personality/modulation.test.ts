import { describe, expect, it } from "vitest";
import { socialTraitScale, TRAIT_SCALE_MAX } from "./modulation";
import type { SocialReaction } from "./reactions";
import type { TraitValue } from "./traits/value";

const dislike = (conceptId = "criticize"): SocialReaction => ({ conceptId, valence: "dislike", intensity: 5, hint: "", source: "preference" });
const like = (conceptId = "compliment"): SocialReaction => ({ conceptId, valence: "like", intensity: 5, hint: "", source: "preference" });
const trait = (id: string, value: number): TraitValue => ({ id, value, source: "creation" });

describe("socialTraitScale", () => {
  it("no traits ⇒ 1 (exactly Slice 1 behavior)", () => {
    expect(socialTraitScale(dislike(), [])).toBe(1);
  });

  it("agreeableness damps a dislike; contrariness sharpens it", () => {
    expect(socialTraitScale(dislike(), [trait("social.agreeableness", 100)])).toBeLessThan(1);
    expect(socialTraitScale(dislike(), [trait("social.agreeableness", -100)])).toBeGreaterThan(1);
  });

  it("composure damps a dislike", () => {
    expect(socialTraitScale(dislike(), [trait("temperament.composure", 100)])).toBeLessThan(1);
  });

  it("does not scale likes in v1", () => {
    expect(socialTraitScale(like(), [trait("social.agreeableness", 100)])).toBe(1);
    expect(socialTraitScale(like(), [trait("temperament.composure", -100)])).toBe(1);
  });

  it("possessiveness amplifies a jealousy trigger specifically, not other dislikes", () => {
    expect(socialTraitScale(dislike("jealousy_trigger"), [trait("intimate.possessiveness", 100)])).toBeGreaterThan(1);
    expect(socialTraitScale(dislike("criticize"), [trait("intimate.possessiveness", 100)])).toBe(1);
  });

  it("uses the highest-precedence value when an id has overlapping sources", () => {
    const scale = socialTraitScale(dislike(), [
      { id: "social.agreeableness", value: -100, source: "creation" },
      { id: "social.agreeableness", value: 100, source: "manual" }, // editor wins
    ]);
    expect(scale).toBeLessThan(1); // resolved to +100 ⇒ damped
  });

  it("clamps a runaway stack to the max", () => {
    const scale = socialTraitScale(dislike("jealousy_trigger"), [
      trait("intimate.possessiveness", 100),
      trait("social.agreeableness", -100),
      trait("temperament.composure", -100),
    ]);
    expect(scale).toBeLessThanOrEqual(TRAIT_SCALE_MAX);
  });
});
