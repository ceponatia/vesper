import { describe, expect, it } from "vitest";
import { meterById, meterBaselineOf } from "../meters/registry";
import {
  affinityDecayRetention,
  AFFINITY_DECAY_RETENTION_MAX,
  AFFINITY_GAIN_SCALE_MAX,
  DISINHIBITION_TRAITS,
  personalizeMeters,
  scaleAffinityGain,
  socialTraitScale,
  regardDispositionOverlays,
  REGARD_OVERLAY_MAX_BAND_STEPS,
  stateDispositionOverlays,
  TRAIT_SCALE_MAX,
} from "./modulation";
import type { SocialReaction } from "./reactions";
import { bandIndexForValue } from "./traits/registry";
import { traitRegistry } from "./traits";
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

describe("personalizeMeters", () => {
  const defs = [meterById("mood")!, meterById("arousal")!, meterById("stress")!, meterById("hygiene")!];
  const find = (out: ReturnType<typeof personalizeMeters>, id: string) => out.find((m) => m.id === id)!;

  it("no traits ⇒ defs unchanged (exactly today's drift)", () => {
    expect(personalizeMeters(defs, [])).toEqual([...defs]);
  });

  it("optimism lifts the mood baseline; pessimism lowers it", () => {
    expect(meterBaselineOf(find(personalizeMeters(defs, [trait("temperament.optimism", 100)]), "mood"))).toBeCloseTo(0.75, 5);
    expect(meterBaselineOf(find(personalizeMeters(defs, [trait("temperament.optimism", -100)]), "mood"))).toBeCloseTo(0.25, 5);
  });

  it("libido raises the arousal resting point and slows its recovery", () => {
    const hi = find(personalizeMeters(defs, [trait("intimate.libido", 100)]), "arousal");
    expect(hi.baseline).toBeCloseTo(0.2, 5);
    expect(hi.recoveryPerHour!).toBeLessThan(Math.abs(meterById("arousal")!.perHour)); // slower decay
    // low/negative libido rests at 0 and decays faster
    const lo = find(personalizeMeters(defs, [trait("intimate.libido", -100)]), "arousal");
    expect(lo.baseline).toBe(0);
    expect(lo.recoveryPerHour!).toBeGreaterThan(Math.abs(meterById("arousal")!.perHour));
  });

  it("composure speeds stress recovery; volatility slows it", () => {
    const base = Math.abs(meterById("stress")!.perHour);
    expect(find(personalizeMeters(defs, [trait("temperament.composure", 100)]), "stress").recoveryPerHour!).toBeGreaterThan(base);
    expect(find(personalizeMeters(defs, [trait("temperament.composure", -100)]), "stress").recoveryPerHour!).toBeLessThan(base);
  });

  it("leaves untouched meters (hygiene) alone", () => {
    expect(find(personalizeMeters(defs, [trait("temperament.optimism", 100)]), "hygiene")).toEqual(meterById("hygiene"));
  });
});

describe("scaleAffinityGain", () => {
  it("no traits / zero delta ⇒ delta unchanged (exactly today's behavior)", () => {
    expect(scaleAffinityGain(4, [])).toBe(4);
    expect(scaleAffinityGain(-4, [])).toBe(-4);
    expect(scaleAffinityGain(0, [trait("temperament.warmth", 100)])).toBe(0);
  });

  it("warmth and agreeableness amplify gains; coldness/contrariness damp them", () => {
    expect(scaleAffinityGain(4, [trait("temperament.warmth", 100)])).toBeGreaterThan(4);
    expect(scaleAffinityGain(4, [trait("social.agreeableness", 100)])).toBeGreaterThan(4);
    expect(scaleAffinityGain(4, [trait("temperament.warmth", -100)])).toBeLessThan(4);
  });

  it("guardedness damps gains; openness amplifies them", () => {
    expect(scaleAffinityGain(4, [trait("social.guardedness", 100)])).toBeLessThan(4);
    expect(scaleAffinityGain(4, [trait("social.guardedness", -100)])).toBeGreaterThan(4);
  });

  it("composure damps losses; volatility sharpens them — and gains ignore composure", () => {
    // A loss is a negative delta; damping ⇒ closer to 0 (smaller magnitude).
    expect(scaleAffinityGain(-4, [trait("temperament.composure", 100)])).toBeGreaterThan(-4);
    expect(scaleAffinityGain(-4, [trait("temperament.composure", -100)])).toBeLessThan(-4);
    // The loss-side traits don't touch gains (and vice-versa).
    expect(scaleAffinityGain(4, [trait("temperament.composure", 100)])).toBe(4);
    expect(scaleAffinityGain(-4, [trait("temperament.warmth", 100)])).toBe(-4);
  });

  it("never flips the sign and stays within the scale bounds", () => {
    const scaled = scaleAffinityGain(4, [
      trait("temperament.warmth", 100),
      trait("social.agreeableness", 100),
      trait("social.guardedness", -100),
    ]);
    expect(scaled).toBeGreaterThan(0);
    expect(scaled).toBeLessThanOrEqual(4 * AFFINITY_GAIN_SCALE_MAX);
  });
});

describe("affinityDecayRetention", () => {
  it("no traits / cold-volatile ⇒ 0 (baseline decay to the stage boundary)", () => {
    expect(affinityDecayRetention([])).toBe(0);
    expect(affinityDecayRetention([trait("temperament.warmth", -100), trait("temperament.composure", -100)])).toBe(0);
  });

  it("warmth and composure each raise retention; both together raise it more", () => {
    const warm = affinityDecayRetention([trait("temperament.warmth", 100)]);
    const composed = affinityDecayRetention([trait("temperament.composure", 100)]);
    const both = affinityDecayRetention([trait("temperament.warmth", 100), trait("temperament.composure", 100)]);
    expect(warm).toBeGreaterThan(0);
    expect(composed).toBeGreaterThan(0);
    expect(both).toBeGreaterThan(warm);
    expect(both).toBeGreaterThan(composed);
  });

  it("caps retention so even the most constant character still drifts", () => {
    expect(affinityDecayRetention([trait("temperament.warmth", 100), trait("temperament.composure", 100)])).toBeLessThanOrEqual(
      AFFINITY_DECAY_RETENTION_MAX,
    );
  });
});

describe("stateDispositionOverlays", () => {
  const traits: TraitValue[] = [
    trait("intimate.inhibition", 60),
    trait("social.guardedness", 40),
    trait("temperament.composure", 50),
    trait("temperament.warmth", 30),
  ];

  it("no shift below the floor (sober)", () => {
    expect(stateDispositionOverlays(traits, { intoxication: 0.1 })).toEqual([]);
    expect(stateDispositionOverlays(traits, {})).toEqual([]);
  });

  it("lowers all three disinhibition traits when drunk, source condition", () => {
    const out = stateDispositionOverlays(traits, { intoxication: 0.8 });
    expect(out.map((o) => o.id).sort()).toEqual([...DISINHIBITION_TRAITS].sort());
    for (const o of out) {
      expect(o.source).toBe("condition");
      const before = traits.find((t) => t.id === o.id)?.value ?? 0;
      expect(o.value).toBeLessThan(before);
    }
  });

  it("never fabricates a disposition the character did not author", () => {
    const out = stateDispositionOverlays([trait("intimate.inhibition", 50)], { intoxication: 0.9 });
    expect(out.map((o) => o.id)).toEqual(["intimate.inhibition"]); // guardedness/composure absent ⇒ not added
  });

  it("does not push a trait below -100", () => {
    const out = stateDispositionOverlays([trait("social.guardedness", -90)], { intoxication: 1 });
    expect(out[0]?.value).toBeGreaterThanOrEqual(-100);
  });

  it("empty traits ⇒ no overlays (today's behavior)", () => {
    expect(stateDispositionOverlays([], { intoxication: 1 })).toEqual([]);
  });
});

describe("regardDispositionOverlays (§7.1 soft coloring, re-keyed to regard bands)", () => {
  const traits: TraitValue[] = [
    trait("temperament.warmth", 10),
    trait("social.guardedness", 40),
    trait("intimate.inhibition", 60),
  ];

  it("stranger (and unknown ids) shift nothing — the neutral default renders authored bands", () => {
    expect(regardDispositionOverlays("neutral", traits)).toEqual([]);
    expect(regardDispositionOverlays("no-such-band", traits)).toEqual([]);
  });

  it("a warm stage warms and un-guards; a hostile one cools and guards — source condition", () => {
    const close = regardDispositionOverlays("close", traits);
    expect(close.find((o) => o.id === "temperament.warmth")?.value).toBe(30); // 10 + 20
    expect(close.find((o) => o.id === "social.guardedness")?.value).toBe(15); // 40 - 25
    for (const o of close) expect(o.source).toBe("condition");
    const hostile = regardDispositionOverlays("hostile", traits);
    expect(hostile.find((o) => o.id === "temperament.warmth")?.value).toBe(-20); // 10 - 30
    expect(hostile.find((o) => o.id === "social.guardedness")?.value).toBe(70); // 40 + 30
  });

  it("never fabricates a disposition the character did not author, and clamps to ±100", () => {
    const only = regardDispositionOverlays("smitten", [trait("temperament.warmth", 90)]);
    expect(only.map((o) => o.id)).toEqual(["temperament.warmth"]);
    expect(only[0]?.value).toBe(100); // 90 + 35, clamped
    expect(regardDispositionOverlays("smitten", [])).toEqual([]);
  });

  it("caps the coloring at one band step from the authored value (slice 3 — no homogenization)", () => {
    expect(REGARD_OVERLAY_MAX_BAND_STEPS).toBe(1);
    const ids = ["temperament.warmth", "social.guardedness", "intimate.inhibition"] as const;
    for (const bandId of ["hostile", "wary", "cool", "friendly", "warm", "close", "cherished", "devoted", "smitten"]) {
      for (let authored = -100; authored <= 100; authored += 10) {
        const overlays = regardDispositionOverlays(
          bandId,
          ids.map((id) => trait(id, authored)),
        );
        for (const overlay of overlays) {
          const def = traitRegistry.byId(overlay.id);
          if (!def) continue;
          const authoredBand = bandIndexForValue(def, authored);
          const overlaidBand = bandIndexForValue(def, overlay.value);
          expect(Math.abs(overlaidBand - authoredBand)).toBeLessThanOrEqual(REGARD_OVERLAY_MAX_BAND_STEPS);
        }
      }
    }
  });
});
