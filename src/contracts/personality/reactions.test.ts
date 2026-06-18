import { describe, expect, it } from "vitest";
import type { Preference } from "./preference";
import {
  evaluateSocialReaction,
  LIKE_CAP,
  resolveSocialReaction,
  type DispositionSources,
  type SocialReaction,
} from "./reactions";

function sources(preferences: Preference[]): DispositionSources {
  return { tags: [], preferences, cards: [] };
}

describe("resolveSocialReaction", () => {
  it("matches a bespoke preference on the exact concept", () => {
    const prefs: Preference[] = [{ target: "compliment", valence: "dislike", intensity: 7, hint: "finds flattery cloying" }];
    const r = resolveSocialReaction({ concept: "compliment", target: "Sabrina" }, sources(prefs));
    expect(r).toEqual({ conceptId: "compliment", valence: "dislike", intensity: 7, hint: "finds flattery cloying", source: "preference" });
  });

  it("matches a family-targeted preference when there is no direct one", () => {
    const prefs: Preference[] = [{ target: "affection_display", valence: "dislike", intensity: 5 }];
    const r = resolveSocialReaction({ concept: "compliment", target: "Sabrina" }, sources(prefs));
    expect(r?.valence).toBe("dislike");
    expect(r?.intensity).toBe(5);
    expect(r?.hint).toBe(""); // no pref hint, concept defaultHint is ""
  });

  it("a direct concept preference beats a family one", () => {
    const prefs: Preference[] = [
      { target: "affection_display", valence: "dislike", intensity: 8 },
      { target: "compliment", valence: "like", intensity: 3 },
    ];
    const r = resolveSocialReaction({ concept: "compliment", target: "Sabrina" }, sources(prefs));
    expect(r?.valence).toBe("like");
    expect(r?.intensity).toBe(3);
  });

  it("returns null when nothing matches (narrator plays it straight)", () => {
    const prefs: Preference[] = [{ target: "insult", valence: "dislike", intensity: 5 }];
    expect(resolveSocialReaction({ concept: "compliment", target: "Sabrina" }, sources(prefs))).toBeNull();
    expect(resolveSocialReaction({ concept: "compliment", target: "Sabrina" }, sources([]))).toBeNull();
  });
});

function dislike(intensity: number): SocialReaction {
  return { conceptId: "x", valence: "dislike", intensity, hint: "", source: "preference" };
}
function like(intensity: number): SocialReaction {
  return { conceptId: "x", valence: "like", intensity, hint: "", source: "preference" };
}

describe("evaluateSocialReaction — affinity-aware curve", () => {
  it("goodwill deadband: a minor slight against a beloved nets zero", () => {
    const e = evaluateSocialReaction(dislike(4), 100); // tolerance 0.04*100 = 4
    expect(e.magnitude).toBe(0);
    expect(e.band).toBe("lets it slide");
  });

  it("thin ice amplifies: the same slight stings more when hostile", () => {
    const neutral = evaluateSocialReaction(dislike(5), 0);
    const hostile = evaluateSocialReaction(dislike(5), -100);
    expect(neutral.magnitude).toBeCloseTo(5);
    expect(hostile.magnitude).toBeCloseTo(10); // hostility doubles
    expect(hostile.magnitude).toBeGreaterThan(neutral.magnitude);
  });

  it("likes have diminishing returns near the top and are capped", () => {
    const adored = evaluateSocialReaction(like(10), 100); // damped 10*0.4 = 4
    expect(adored.magnitude).toBeCloseTo(4);
    const hostileStrong = evaluateSocialReaction(like(5), -100); // 5 + 1.5 surprise = 6.5 → capped
    expect(hostileStrong.magnitude).toBe(LIKE_CAP);
  });

  it("bands track valence × magnitude", () => {
    expect(evaluateSocialReaction(dislike(3), 50).band).toBe("is mildly put off"); // raw 1
    expect(evaluateSocialReaction(dislike(5), 0).band).toBe("is stung");
    expect(evaluateSocialReaction(like(1), 0).band).toBe("is mildly pleased");
  });
});

describe("evaluateSocialReaction — mood & trait stubs", () => {
  it("neutral mood and unit traitScale are no-ops (v1 defaults)", () => {
    const e = evaluateSocialReaction(dislike(5), 0);
    expect(e.magnitude).toBeCloseTo(5);
  });

  it("a bad mood sharpens a dislike and damps a like", () => {
    expect(evaluateSocialReaction(dislike(5), 0, -1).magnitude).toBeCloseTo(6.5); // ×1.3
    expect(evaluateSocialReaction(like(3), 0, -1).magnitude).toBeCloseTo(2.1); // ×0.7
  });

  it("traitScale multiplies the magnitude", () => {
    expect(evaluateSocialReaction(dislike(4), 0, 0, 0.5).magnitude).toBeCloseTo(2);
  });
});
