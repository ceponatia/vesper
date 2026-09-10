import { imageSubjectPronounSets } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { attributeRegistry, type AttributeValue } from "../attributes";
import { FULLY_COVERED } from "../items/visibility";
import {
  visualStateKindDefinitions,
  VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID,
  VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID,
  VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID,
  VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID,
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
} from "../visual-state";
import {
  imageCharacterKindPromptDecisions,
  imageCharacterPromptValue,
  imageSubjectPronouns,
  IMAGE_CHARACTER_GENDER_ATTRIBUTE_ID,
  IMAGE_CHARACTER_NOT_IMAGE_ELIGIBLE,
  type CharacterPromptSibling,
  type CharacterPromptValueInput,
} from "./character-adapter";

/**
 * The character adapter's per-kind prompt renderers (#544 F1/F2).
 *
 * `promptReadyValue` used to end in a structural fallback: any record with no
 * renderer had its id-shaped keys stripped, the rest sorted alphabetically and
 * the leaves joined, which is how a chat scene shipped "Katelyn Nacon is
 * surface, ground, legs, borne by." and "Katelyn Nacon is out, tuck." These
 * cases pin the replacement — an explicit decision per visual-state kind,
 * derived from the kind registry so a new kind cannot inherit the old nonsense.
 *
 * Deliberately NOT here: how a claim reaches a subject slice or a suppression
 * record (`subject-digest.test.ts` owns the projection), and how a dialect wraps
 * a value into a sentence (`@vesper/image-core` owns that). This file owns the
 * WORDS one structured value compiles to.
 */

const GARMENT_ID = "g_top";
const SUBJECT_ID = "sbj_1";

/** The worn top every part-scoped case names its clause against. */
function wornTop(semanticTags: readonly string[] = ["worn", "top"]): CharacterPromptSibling {
  return {
    kindId: VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
    locus: { kind: "item", itemInstanceId: GARMENT_ID },
    value: { name: "cotton shirt", locus: { kind: "worn", actorId: "c:1" } },
    semanticTags,
  };
}

function postureSibling(posture: string): CharacterPromptSibling {
  return {
    kindId: VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
    locus: { kind: "subject", subjectId: SUBJECT_ID },
    value: { posture },
    semanticTags: [],
  };
}

function rendered(input: CharacterPromptValueInput): string | null {
  return imageCharacterPromptValue(input);
}

function presentation(channel: string, band: string, siblings: readonly CharacterPromptSibling[]): string | null {
  return rendered({
    kindId: VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID,
    locus: { kind: "garment_part", garmentInstanceId: GARMENT_ID, partId: "hem" },
    value: { channel, band },
    siblings,
  });
}

function support(relations: unknown, siblings: readonly CharacterPromptSibling[] = []): string | null {
  return rendered({
    kindId: VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID,
    locus: { kind: "subject", subjectId: SUBJECT_ID },
    value: { relations },
    siblings,
  });
}

// ---------------------------------------------------------------------------

describe("the visual-state kind census", () => {
  /**
   * The build-stopping half of F1, derived from the registry rather than from a
   * copied list: a kind added to `visual-state/kinds.ts` with no decision here
   * would have been silently flattened by the old fallback, so it must fail
   * loudly instead. Falsified against the fallback itself, which needed no
   * entries at all.
   */
  it("gives every registered kind an explicit decision", () => {
    const undecided = visualStateKindDefinitions
      .map((definition) => definition.id)
      .filter((id) => imageCharacterKindPromptDecisions[id] === undefined);
    expect(undecided).toEqual([]);
  });

  /** The other direction: a decision for a kind nobody registers is dead vocabulary. */
  it("names no kind the registry does not hold", () => {
    const registered = new Set(visualStateKindDefinitions.map((definition) => definition.id));
    expect(Object.keys(imageCharacterKindPromptDecisions).filter((id) => !registered.has(id))).toEqual([]);
  });

  /**
   * The `not_image_eligible` marker is a claim ABOUT the registry, not an
   * opinion: it says the kind cannot reach a subject claim at all. Flipping
   * `imageEligible` on such a kind is a deliberate enable, and this is where it
   * stops — so the enable ships with a clause instead of with silence.
   */
  it("keeps the not-image-eligible decisions agreeing with the registry flag", () => {
    const rows = visualStateKindDefinitions.map((definition) => ({
      id: definition.id,
      imageEligible: definition.imageEligible,
      markedIneligible:
        imageCharacterKindPromptDecisions[definition.id] === IMAGE_CHARACTER_NOT_IMAGE_ELIGIBLE,
    }));
    expect(rows.filter((row) => row.imageEligible === row.markedIneligible)).toEqual([]);
  });
});

describe("body language", () => {
  /**
   * D1's first shipped defect, exactly as reported: a support value
   * `{ relations: [{ role: "borne_by", anchor: { kind: "surface", surfaceKind:
   * "ground" }, loadZones: ["legs"] }] }` compiled to "surface, ground, legs,
   * borne by" — the record's surviving keys, sorted and joined.
   */
  it("words a support anchor instead of flattening its relation record", () => {
    const value = support([
      { role: "borne_by", anchor: { kind: "surface", supportId: "sup_1", surfaceKind: "ground" }, loadZones: ["legs"] },
    ]);
    expect(value).toBe("standing on the floor");
    expect(value).not.toContain("borne");
    expect(value).not.toContain("surface");
    expect(value).not.toContain("legs");
  });

  /**
   * Support defers to posture: both are whole-body facts about the same
   * configuration, and stating each once each is the duplication D10 records
   * ("Katelyn Nacon is surface… Katelyn Nacon is standing.").
   */
  it("says nothing when the same subject already states a posture", () => {
    const relations = [
      { role: "borne_by", anchor: { kind: "surface", supportId: "sup_1", surfaceKind: "bed" }, loadZones: ["pelvis"] },
    ];
    expect(support(relations)).toBe("seated on the bed");
    expect(support(relations, [postureSibling("sitting")])).toBeNull();
  });

  /**
   * Two silences with different reasons, both deliberate: another person
   * carrying the weight is scene staging's geometry, and an anchor with no
   * resolved `surfaceKind` is a support id, which is not a surface anybody can
   * draw.
   */
  it("says nothing for a participant anchor or an unresolved surface", () => {
    expect(
      support([{ role: "held_by", anchor: { kind: "participant", subjectId: "sbj_2" }, loadZones: ["torso"] }]),
    ).toBeNull();
    expect(
      support([{ role: "borne_by", anchor: { kind: "surface", supportId: "sup_9" }, loadZones: ["legs"] }]),
    ).toBeNull();
  });

  /** The posture word, and nothing around it. */
  it("states a posture as its own word", () => {
    expect(
      rendered({
        kindId: VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
        locus: { kind: "subject", subjectId: SUBJECT_ID },
        value: { posture: "kneeling" },
      }),
    ).toBe("kneeling");
  });

  /**
   * A facing value survives its schema and still says nothing: `towardSubjectId`
   * is a handle, and the old fallback stripped it and shipped the bare direction
   * ("Katelyn Nacon is toward.") — a claim with no counterpart in the picture.
   */
  it("withholds a facing relation rather than shipping its direction alone", () => {
    expect(
      rendered({
        kindId: VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID,
        locus: { kind: "relation", relationId: "rel_1" },
        value: { facing: "toward", towardSubjectId: "sbj_2" },
      }),
    ).toBeNull();
  });
});

describe("garment presentation", () => {
  /**
   * D1's second shipped defect: `{ channel: "tuck", band: "out" }` compiled to
   * "out, tuck". `out` is the default look for a picture and now says nothing;
   * the readings a render can get wrong are worded against the garment they
   * belong to, resolved from the subject's own wardrobe facts.
   */
  it("says nothing for an untucked hem and binds the other readings to the garment", () => {
    const siblings = [wornTop()];
    expect(presentation("tuck", "out", siblings)).toBeNull();
    expect(presentation("tuck", "in", siblings)).toBe("with the cotton shirt tucked in");
    expect(presentation("tuck", "partial", siblings)).toBe("with the cotton shirt half-tucked");
    for (const band of ["out", "in", "partial"]) {
      expect(presentation("tuck", band, siblings) ?? "").not.toContain("tuck,");
    }
  });

  it("words closure, roll and displacement against the same garment", () => {
    const siblings = [wornTop()];
    expect(presentation("closure", "partly_open", siblings)).toBe("with the cotton shirt unbuttoned");
    expect(presentation("closure", "open", siblings)).toBe("with the cotton shirt open");
    expect(presentation("roll", "rolled", siblings)).toBe("with the cotton shirt sleeves rolled up");
    expect(presentation("displacement", "off_shoulder", siblings)).toBe(
      "with the cotton shirt slipped off one shoulder",
    );
    expect(presentation("displacement", "lifted", siblings)).toBe("with the cotton shirt lifted");
  });

  /**
   * A clause the prompt cannot attach to anything is worse than no clause. Two
   * cases: the subject states no wardrobe fact for that instance, and the
   * garment is one the concealment suppression (F6) withheld — wording "with the
   * bra unbuttoned" would restate exactly what was withheld.
   */
  it("suppresses a presentation clause it cannot name a garment for", () => {
    expect(presentation("tuck", "in", [])).toBeNull();
    expect(presentation("tuck", "in", [wornTop(["worn", "wardrobe.concealed"])])).toBeNull();
  });
});

describe("presentation and current state", () => {
  it("words a hairstyle as an arrangement of the hair, never a bare vocabulary token", () => {
    expect(
      rendered({
        kindId: VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID,
        locus: { kind: "body", locus: { bodyLocationId: "hair" } },
        value: { arrangement: "ponytail" },
      }),
    ).toBe("with the hair in a ponytail");
    expect(
      rendered({
        kindId: VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID,
        locus: { kind: "body", locus: { bodyLocationId: "hair" } },
        value: { arrangement: "loose", disturbance: "tousled" },
      }),
    ).toBe("with the hair worn loose and tousled");
  });

  /** The band comes from the value, the part from the fact's own locus. */
  it("places body-surface wetness at the part carrying it", () => {
    expect(
      rendered({
        kindId: VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID,
        locus: { kind: "body", locus: { bodyLocationId: "hair" } },
        value: { band: "damp" },
      }),
    ).toBe("damp at the hair");
  });

  /** A value that fails its own kind's schema is silence, never a partial guess. */
  it("says nothing for a value its kind's schema refuses", () => {
    expect(
      rendered({
        kindId: VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID,
        locus: { kind: "body", locus: { bodyLocationId: "hair" } },
        value: { arrangement: "shaved_into_a_mohawk" },
      }),
    ).toBeNull();
    expect(
      rendered({
        kindId: VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
        locus: { kind: "subject", subjectId: SUBJECT_ID },
        value: {},
      }),
    ).toBeNull();
  });
});

describe("subject pronouns", () => {
  const pronounsFor = (gender: string): string | undefined => {
    const attribute: AttributeValue = { id: IMAGE_CHARACTER_GENDER_ATTRIBUTE_ID, value: gender, source: "creation" };
    return imageSubjectPronouns({ attributes: [attribute], exposure: FULLY_COVERED });
  };

  /**
   * Registry-derived: every member `identity.gender` allows must map to a set a
   * dialect knows, so adding a seventh member fails here instead of silently
   * losing that character their pronouns (and re-naming them in every sentence
   * again, #544 D2).
   */
  it("maps every gender the registry allows to a known pronoun set", () => {
    const allowed = attributeRegistry.byId(IMAGE_CHARACTER_GENDER_ATTRIBUTE_ID)?.allowedValues ?? [];
    expect(allowed.length).toBeGreaterThan(0);
    for (const gender of allowed) {
      expect({ gender, set: pronounsFor(gender) }).toEqual({
        gender,
        set: expect.stringMatching(new RegExp(`^(?:${imageSubjectPronounSets.join("|")})$`)),
      });
    }
  });

  /**
   * The owner's mapping: the `…_born_…` split exists so a render gets the right
   * underlying BUILD, and says nothing about what to call somebody — every
   * androgynous and nonbinary presentation takes the neutral set.
   */
  it("takes the neutral set for every androgynous and nonbinary presentation", () => {
    expect(pronounsFor("female")).toBe("she_her");
    expect(pronounsFor("male")).toBe("he_him");
    expect(pronounsFor("androgynous_born_female")).toBe("they_them");
    expect(pronounsFor("androgynous_born_male")).toBe("they_them");
    expect(pronounsFor("nonbinary_born_female")).toBe("they_them");
    expect(pronounsFor("nonbinary_born_male")).toBe("they_them");
  });

  /**
   * No value, and no guess: a subject with no set is named by their label or by
   * the reference that shows them. A wrong pronoun is a wrong person, so an
   * absent or unrecognized gender must produce no field at all rather than a
   * default.
   */
  it("yields no set for an absent or unrecognized gender", () => {
    expect(imageSubjectPronouns(undefined)).toBeUndefined();
    expect(imageSubjectPronouns({ exposure: FULLY_COVERED })).toBeUndefined();
    expect(pronounsFor("agender")).toBeUndefined();
  });
});
