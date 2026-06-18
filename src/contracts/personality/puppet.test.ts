import { describe, expect, it } from "vitest";
import type { Preference } from "./preference";
import { checkPuppetContradiction } from "./puppet";

const tags = (...ids: string[]) => ({ tags: ids, preferences: [] as Preference[] });
const prefs = (...preferences: Preference[]) => ({ tags: [] as string[], preferences });

describe("checkPuppetContradiction", () => {
  it("honours when there is no concept to judge (plain dialogue)", () => {
    expect(checkPuppetContradiction({ npc: "Sabrina" }, tags("bratty")).contradiction).toBe(false);
    expect(checkPuppetContradiction({ npc: "Sabrina", concept: "not-a-concept" }, tags("bratty")).contradiction).toBe(false);
  });

  it("honours when disposition gives no signal", () => {
    expect(checkPuppetContradiction({ npc: "Sabrina", concept: "physical_affection" }, tags()).contradiction).toBe(false);
    // free-form tag carries no machine affect in v1
    expect(checkPuppetContradiction({ npc: "Sabrina", concept: "physical_affection" }, tags("made-up-tag")).contradiction).toBe(false);
  });

  it("flags a warm act puppeted onto a cold-leaning character", () => {
    // gloomy is cold with no wontInitiate ⇒ the warmth lean alone catches it.
    const verdict = checkPuppetContradiction({ npc: "Sabrina", concept: "compliment" }, tags("gloomy"));
    expect(verdict.contradiction).toBe(true);
  });

  it("flags a wontInitiate family even when warmth would not (bratty hugs)", () => {
    const verdict = checkPuppetContradiction({ npc: "Sabrina", concept: "physical_affection" }, tags("bratty"));
    expect(verdict.contradiction).toBe(true);
    expect(verdict.reason).toContain("affection_display");
  });

  it("flags a hostile act puppeted onto a warm character", () => {
    const verdict = checkPuppetContradiction({ npc: "Sabrina", concept: "insult" }, tags("sunny"));
    expect(verdict.contradiction).toBe(true);
  });

  it("honours a warm act onto a warm character", () => {
    expect(checkPuppetContradiction({ npc: "Sabrina", concept: "physical_affection" }, tags("flirtatious")).contradiction).toBe(false);
  });

  it("honours a neutral-polarity act regardless of warmth", () => {
    // tease is neutral ⇒ no warmth clash, and no tag forbids the teasing family.
    expect(checkPuppetContradiction({ npc: "Sabrina", concept: "tease" }, tags("gloomy")).contradiction).toBe(false);
  });

  it("a bespoke dislike contradicts a puppeted act of that kind", () => {
    const verdict = checkPuppetContradiction(
      { npc: "Sabrina", concept: "compliment" },
      prefs({ target: "compliment", valence: "dislike", intensity: 6 }),
    );
    expect(verdict.contradiction).toBe(true);
    expect(verdict.reason).toContain("compliment");
  });

  it("a family-level dislike contradicts a puppeted concept in that family", () => {
    const verdict = checkPuppetContradiction(
      { npc: "Sabrina", concept: "gift" },
      prefs({ target: "affection_display", valence: "dislike", intensity: 5 }),
    );
    expect(verdict.contradiction).toBe(true);
  });

  it("preference precedence: an authored like overrides a contradicting tag (consent to puppet)", () => {
    const verdict = checkPuppetContradiction(
      { npc: "Sabrina", concept: "physical_affection" },
      { tags: ["bratty"], preferences: [{ target: "physical_affection", valence: "like", intensity: 6 }] },
    );
    expect(verdict.contradiction).toBe(false);
  });
});
