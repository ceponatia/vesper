import { describe, expect, it } from "vitest";
import {
  hairArrangementClaimCode,
  hairCauseClaimCode,
  hairClaim,
  hairClaimAreas,
  hairClaimLexicon,
  hairClaimMappings,
  hairClaimMatches,
  hairWetnessClaimCode,
  hairWetnessClaimScale,
  HAIR_CLAIM_ARRANGEMENT_BRAID,
  HAIR_CLAIM_ARRANGEMENT_LOOSE,
  HAIR_CLAIM_CAUSE_IMMERSION,
  HAIR_CLAIM_CAUSE_RAIN,
  HAIR_CLAIM_CAUSE_SPLASH,
  HAIR_CLAIM_COVERAGE_UNCOVERED,
  HAIR_CLAIM_MOTION_FREE_FLOW,
  HAIR_CLAIM_WETNESS_SOAKED,
  HAIR_CLAIM_WETNESS_WET,
} from "./claims";
import { hairArrangements } from "./mechanics";
import { hairWetnessBands, HAIR_BOUND, HAIR_COVERED, HAIR_PINNED, HAIR_WATER_LOADED } from "./phenomena/bands";
import { hairWettingEventKinds } from "./frame";

/**
 * The claim lexicon (narrator-physical-guidance slice 2).
 *
 * Two classes of property matter here and they fail differently. The INVARIANTS
 * (every code speakable, every phrase unique, every constraint mapped) fail loudly
 * as soon as someone extends the table carelessly — a phrase owned by two codes
 * would make one fence silently shadow another. The MATCHER properties are about
 * conservatism: the detector above it can only ever be as careful as this is, so
 * "longest phrase within an area wins" and "a word boundary is required" are pinned
 * with the cases that would otherwise misfire.
 */

describe("lexicon invariants", () => {
  it("every claim is speakable, displayable, and in a known area", () => {
    expect(hairClaimLexicon.length).toBeGreaterThan(0);
    for (const claim of hairClaimLexicon) {
      expect(claim.phrases.length, claim.code).toBeGreaterThan(0);
      expect(claim.display.trim(), claim.code).not.toBe("");
      expect(hairClaimAreas, claim.code).toContain(claim.area);
      expect(hairClaim(claim.code)).toBe(claim);
    }
  });

  it("covers every area", () => {
    for (const area of hairClaimAreas) {
      expect(hairClaimLexicon.some((claim) => claim.area === area), area).toBe(true);
    }
  });

  it("phrases are lowercase, trimmed, and non-empty", () => {
    for (const claim of hairClaimLexicon) {
      for (const phrase of claim.phrases) {
        expect(phrase, `${claim.code}: "${phrase}"`).toBe(phrase.toLowerCase().trim());
        expect(phrase.length, `${claim.code}: "${phrase}"`).toBeGreaterThan(0);
      }
    }
  });

  it("no phrase is owned by two codes — a shared phrase would shadow a fence", () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const claim of hairClaimLexicon) {
      for (const phrase of claim.phrases) {
        const existing = owner.get(phrase);
        if (existing !== undefined) collisions.push(`"${phrase}" — ${existing} and ${claim.code}`);
        owner.set(phrase, claim.code);
      }
    }
    expect(collisions).toEqual([]);
  });

  it("codes are unique", () => {
    const codes = hairClaimLexicon.map((claim) => claim.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("every committed value that HAS a code resolves to one in the lexicon", () => {
    for (const band of hairWetnessBands) expect(hairClaim(hairWetnessClaimCode(band)), band).toBeDefined();
    for (const kind of hairWettingEventKinds) expect(hairClaim(hairCauseClaimCode(kind)), kind).toBeDefined();
    for (const arrangement of hairArrangements) {
      const code = hairArrangementClaimCode(arrangement);
      // `other` is deliberately unmapped: an unidentified style supports no claim.
      if (arrangement === "other") expect(code).toBeNull();
      else expect(hairClaim(code ?? ""), arrangement).toBeDefined();
    }
  });

  it("the degree scale is the ordered band scale, as codes", () => {
    expect(hairWetnessClaimScale).toEqual(hairWetnessBands.map(hairWetnessClaimCode));
    expect(hairWetnessClaimScale).toHaveLength(hairWetnessBands.length);
  });
});

describe("constraint → claim mappings", () => {
  const mappings = (arrangement: Parameters<typeof hairClaimMappings>[0]["arrangement"] = "braid") =>
    hairClaimMappings({ arrangement, wetnessBand: "soaked" });

  it("maps exactly the four bulk-restraint codes, all scoped to the hair location", () => {
    expect(mappings().map((mapping) => mapping.constraintCode)).toEqual([
      HAIR_PINNED,
      HAIR_BOUND,
      HAIR_COVERED,
      HAIR_WATER_LOADED,
    ]);
    for (const mapping of mappings()) expect(mapping.locationId).toBe("hair");
  });

  it("every mapping says something — a mapping with nothing to say would be dropped", () => {
    for (const mapping of mappings()) {
      expect(mapping.prohibitedClaimCodes.length, mapping.constraintCode).toBeGreaterThan(0);
    }
  });

  it("a captured style forbids both loose and free motion, and licenses its own truth", () => {
    const bound = mappings().find((mapping) => mapping.constraintCode === HAIR_BOUND);
    expect(bound?.prohibitedClaimCodes).toEqual([HAIR_CLAIM_ARRANGEMENT_LOOSE, HAIR_CLAIM_MOTION_FREE_FLOW]);
    expect(bound?.truthClaimCodes).toEqual([HAIR_CLAIM_ARRANGEMENT_BRAID]);
    expect(bound?.priority).toBe("high");
  });

  it("coverage forbids the uncovered claim and licenses nothing positive", () => {
    const covered = mappings().find((mapping) => mapping.constraintCode === HAIR_COVERED);
    expect(covered?.prohibitedClaimCodes).toEqual([HAIR_CLAIM_COVERAGE_UNCOVERED, HAIR_CLAIM_MOTION_FREE_FLOW]);
    expect(covered?.truthClaimCodes).toEqual([]);
  });

  it("water load forbids only motion — it says nothing about how the hair is worn", () => {
    const loaded = mappings().find((mapping) => mapping.constraintCode === HAIR_WATER_LOADED);
    expect(loaded?.prohibitedClaimCodes).toEqual([HAIR_CLAIM_MOTION_FREE_FLOW]);
    expect(loaded?.truthClaimCodes).toEqual([HAIR_CLAIM_WETNESS_SOAKED]);
  });

  it("unknown live state yields the fence with NO truth codes, never a guessed style", () => {
    const unknown = hairClaimMappings({ arrangement: null, wetnessBand: null });
    for (const mapping of unknown) {
      expect(mapping.truthClaimCodes, mapping.constraintCode).toEqual([]);
      expect(mapping.prohibitedClaimCodes.length, mapping.constraintCode).toBeGreaterThan(0);
    }
    // An unidentified style is the same story: it is not a licence to say "loose".
    expect(mappings("other").find((mapping) => mapping.constraintCode === HAIR_BOUND)?.truthClaimCodes).toEqual([]);
  });
});

describe("phrase matching", () => {
  const codes = (sentence: string) => hairClaimMatches(sentence).map((match) => match.code);

  it("finds nothing in a sentence that asserts nothing", () => {
    expect(codes("you look well today")).toEqual([]);
  });

  it("matches a claim per area, in lexicon order", () => {
    expect(codes("the storm left your braided hair soaked")).toEqual([
      HAIR_CLAIM_WETNESS_SOAKED,
      HAIR_CLAIM_CAUSE_RAIN,
      HAIR_CLAIM_ARRANGEMENT_BRAID,
    ]);
  });

  it("prefers the longest phrase within an area", () => {
    expect(codes("your hair is dripping wet")).toEqual([HAIR_CLAIM_WETNESS_SOAKED]);
    expect(codes("your hair is slightly wet")).not.toContain(HAIR_CLAIM_WETNESS_WET);
    expect(codes("your hair is wet")).toEqual([HAIR_CLAIM_WETNESS_WET]);
  });

  it("requires a word boundary — no stemming, no substring hits", () => {
    // "wetsuit"/"drying" contain a phrase; neither asserts one.
    expect(codes("your hair is under a wetsuit hood")).toEqual([]);
    expect(codes("your hair is drying")).toEqual([]);
    // …and an inflection only matches when the lexicon enumerates it.
    expect(codes("water splashed over your hair")).toEqual([HAIR_CLAIM_CAUSE_SPLASH]);
  });

  it("reads a bath as immersion and never as weather", () => {
    expect(codes("your hair is wet from the bath")).toEqual([HAIR_CLAIM_WETNESS_WET, HAIR_CLAIM_CAUSE_IMMERSION]);
    expect(codes("your hair is wet from the bath")).not.toContain(HAIR_CLAIM_CAUSE_RAIN);
  });

  it("reports where the phrase sits, so a caller can see what precedes it", () => {
    const sentence = "your hair is not loose";
    const match = hairClaimMatches(sentence).find((entry) => entry.area === "arrangement");
    expect(match?.phrase).toBe("loose");
    expect(match?.index).toBe(sentence.indexOf("loose"));
  });

  it("is case-insensitive and unaffected by surrounding punctuation", () => {
    expect(codes('"Your hair — STREAMING in the wind!"')).toEqual([HAIR_CLAIM_MOTION_FREE_FLOW]);
  });
});
