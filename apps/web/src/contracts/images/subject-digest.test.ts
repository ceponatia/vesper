import {
  buildImageWorldDigest,
  imageAppearancePhrase,
  imageConcept,
  imageMorphologyProtectionOf,
  qwenImage2512Dialect,
  selectImagePositiveClaims,
  type ImageWorldFact,
} from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { affordancePerceptionView, toUnitInterval } from "../affordances/core";
import { visualAttentionContextFixture, visualAttentionSnapshotFixture } from "../affordances/recognition";
import { crookedNoseAttributes, freckleClusterFact, missingFingerState, projectFixture } from "../appearance-features";
import type { AttributeValue } from "../attributes";
import { FULLY_COVERED, type RegionExposure } from "../items/visibility";
import {
  adaptProjectedAppearanceTruth,
  projectSpeciesFeatureGroups,
  projectWardrobeFeatures,
  visualStateFeatureFixture,
  visualStateGarmentFixture,
  visualStateNonHumanBody,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID,
  VISUAL_STATE_FIXTURE_ACTOR,
  type VisualStateFeature,
} from "../visual-state";
import { IMAGE_CHARACTER_HAIR_CONCEALED } from "./hair-concealment";
import {
  characterSemanticValueResolver,
  projectCharacterWorldSlices,
  IMAGE_CHARACTER_AGE_OMITTED,
  IMAGE_CHARACTER_AGE_UNRESOLVED,
  IMAGE_CHARACTER_AGE_WITHHELD,
  IMAGE_CHARACTER_ATTRIBUTE_OWNER,
  IMAGE_CHARACTER_COVERAGE_OWNER,
  IMAGE_CHARACTER_COVERAGE_UNRESOLVED,
  IMAGE_CHARACTER_VALUE_UNREADABLE,
  IMAGE_CHARACTER_WARDROBE_CONCEALED,
  type CharacterSubjectSources,
} from "./character-adapter";
import {
  imageSubjectFactNeedsSemanticValue,
  projectSubjectDigests,
  projectCameraFacts,
  standaloneCharacterReadToken,
  IMAGE_SUBJECT_PROJECTION_OWNER,
  IMAGE_SUBJECT_VALUE_UNRESOLVED,
} from "./subject-digest";
import {
  buildVisualImageDigest,
  VISUAL_IMAGE_AGE_ATTRIBUTE_ID,
  type VisualImageDigest,
  type VisualImageFact,
} from "./visual-digest";

/**
 * The character slice of the world digest.
 *
 * This adapter is not bound to any production lane, and these cases are what has
 * to be true before one binds to it. They protect the seam's three jobs and
 * nothing else: the visual digest's classification survives translation, a
 * fingerprint standing in for a value never becomes prompt text, and a lost
 * mandatory anchor is reported rather than skipped.
 *
 * What is deliberately NOT here: which segment kind a feature belongs to
 * (`visual-digest.test.ts` owns that classification), how a claim is worded
 * (`@vesper/image-core`'s dialect owns that), and whether a negative block fires
 * (the package's collision table owns that). Asserting any of them here would be
 * two layers proving one claim. The one deliberate exception is the
 * exposure-fragment composition case, which asserts the JOIN between the
 * adapter's values and the dialect's subject wrapping — a property neither
 * layer can prove alone, because the package cannot see the app's wording table.
 */

// ---------------------------------------------------------------------------
// One realistic character, built through the real owners
// ---------------------------------------------------------------------------

/**
 * The spec's worked body, through the appearance projection and the
 * COMPATIBILITY adapter rather than by hand.
 *
 * That routing is the point. `ProjectedFeatureTruth` carries a fingerprint and no
 * semantic value, so `visual-state/compat.ts` files the fingerprint as the
 * feature's value — and building these facts any other way would let the fixture
 * disagree with the exact condition this adapter exists to refuse.
 */
function appearanceFeatures(): readonly VisualStateFeature[] {
  return adaptProjectedAppearanceTruth(
    projectFixture({
      attributes: crookedNoseAttributes(),
      locatedFacts: [freckleClusterFact()],
      anatomy: [missingFingerState()],
    }),
  );
}

const SUBJECT = appearanceFeatures()[0]?.subjectId ?? "";

/** A winged body: the non-baseline morphology the anatomy exclusions must not forbid. */
function wingsFeatures(): readonly VisualStateFeature[] {
  return projectSpeciesFeatureGroups({ subjectId: SUBJECT, realizedBody: visualStateNonHumanBody(["wings"]) });
}

/** A worn top and a coat left over a chair — the wardrobe/scenery split. */
function garmentFeatures(): readonly VisualStateFeature[] {
  return projectWardrobeFeatures({
    garments: [
      visualStateGarmentFixture({ id: "g_worn", categoryId: "top" }),
      visualStateGarmentFixture({
        id: "g_left",
        categoryId: "outerwear",
        locus: { kind: "scene", placeName: "the study", anchor: "over the desk chair" },
      }),
    ],
    subjectsByActor: new Map([[VISUAL_STATE_FIXTURE_ACTOR, SUBJECT]]),
    sceneSubjectId: SUBJECT,
  });
}

function postureFeature(): VisualStateFeature {
  return visualStateFeatureFixture({
    subjectId: SUBJECT,
    kindId: VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
    layer: "body_language",
    stability: "instantaneous",
    aspect: "body_language.posture",
    locus: { kind: "subject", subjectId: SUBJECT },
    sourceRef: { kind: "scene_relation", relationId: "rel_fixture" },
    value: { posture: "kneeling" },
  });
}

function hairstyleFeature(): VisualStateFeature {
  return visualStateFeatureFixture({
    subjectId: SUBJECT,
    kindId: "presentation.hairstyle",
    layer: "presentation",
    stability: "presentation",
    aspect: "presentation.hairstyle",
    locus: { kind: "body", locus: { bodyLocationId: "hair" } },
    sourceRef: { kind: "presentation", presentationId: "pres_hair" },
    value: { arrangement: "loose" },
  });
}

function groomingFeature(): VisualStateFeature {
  return visualStateFeatureFixture({
    subjectId: SUBJECT,
    kindId: "presentation.grooming",
    layer: "presentation",
    stability: "presentation",
    aspect: "presentation.grooming:brows",
    locus: { kind: "body", locus: { bodyLocationId: "face" } },
    sourceRef: { kind: "presentation", presentationId: "pres_grooming" },
    value: { area: "brows", state: "shaped" },
  });
}

/**
 * A mandatory apparent-age anchor, carrying only a fingerprint.
 *
 * Synthetic because no appearance catalog entry projects `identity.apparent_age`
 * yet — that gap is the reason a character lane cannot claim prompt parity. The
 * fact still has to exist here, because `age` is a segment kind the package
 * promotes to MANDATORY, so a hash reaching it would be the worst possible place
 * for one.
 */
function ageAnchorFeature(): VisualStateFeature {
  const fingerprint = '"late twenties"';
  return visualStateFeatureFixture({
    subjectId: SUBJECT,
    key: `${SUBJECT}/face/apparent_age`,
    locus: { kind: "body", locus: { bodyLocationId: "face" } },
    sourceRef: { kind: "appearance", ref: { kind: "attribute", attributeId: VISUAL_IMAGE_AGE_ATTRIBUTE_ID } },
    value: fingerprint,
    truthFingerprint: fingerprint,
    priors: {
      baseUniqueness: toUnitInterval(6_000),
      baseImportance: toUnitInterval(6_000),
      minimumDetailTier: 2,
      mandatoryForIdentity: true,
    },
  });
}

function characterDigest(extra: readonly VisualStateFeature[] = []): VisualImageDigest {
  return buildVisualImageDigest({
    snapshot: visualAttentionSnapshotFixture([
      ...appearanceFeatures(),
      ...wingsFeatures(),
      ...garmentFeatures(),
      postureFeature(),
      hairstyleFeature(),
      ...extra,
    ]),
    context: visualAttentionContextFixture("image", { framing: { status: "known", value: "full_figure" } }),
  });
}

/** Every selected fact of the one fixture subject, by key. */
function selectedByKey(digest: VisualImageDigest): ReadonlyMap<string, VisualImageFact> {
  return new Map([...digest.mandatoryFacts, ...digest.optionalFacts].map((fact) => [fact.key, fact]));
}

/** A resolver that answers every opaque fact, so nothing is suppressed for want of one. */
const RESOLVE_ALL = (): unknown => "a resolved semantic value";

function factsOf(digest: VisualImageDigest, semanticValue = RESOLVE_ALL): readonly ImageWorldFact[] {
  return projectSubjectDigests({ digest, semanticValue }).subjects.flatMap((subject) => subject.facts);
}

function conceptFor(facts: readonly ImageWorldFact[], key: string): string {
  return facts.find((fact) => fact.key === key)?.concept ?? "";
}

// ---------------------------------------------------------------------------

describe("classification survives the translation", () => {
  /**
   * The invariant, stated once over whatever the digest actually selected rather
   * than as a hand-written table: a fact's segment kind decides where its prose
   * goes and whether fitting may drop it, so a concept that declares a DIFFERENT
   * kind silently re-files somebody's posture or wardrobe further down the
   * prompt.
   *
   * Falsified against `subject.body_language` sitting in `current_state`, which
   * is what it did before this suite existed — a posture classified `pose` by
   * visual state emitted a segment later than the classification asked for, and
   * nothing anywhere could have noticed.
   */
  it("gives every fact a concept whose segment kind is the one visual state assigned", () => {
    const digest = characterDigest();
    const source = selectedByKey(digest);
    const facts = factsOf(digest);
    expect(facts.length).toBe(source.size);
    for (const fact of facts) {
      expect({ key: fact.key, kind: imageConcept(fact.concept)?.segmentKind }).toEqual({
        key: fact.key,
        kind: source.get(fact.key)?.segmentKind,
      });
    }
  });

  /**
   * The four mappings the plan names, pinned by concept ID rather than only by
   * kind. `location.contents` for a coat over a chair is the load-bearing one: it
   * is a product decision (a discarded garment is scenery, not an outfit) AND it
   * takes the background-clutter exclusion off the table, which a `subject.*`
   * concept would not.
   */
  it("maps wardrobe, body language, presentation and left-behind clothing to their own concepts", () => {
    const digest = characterDigest();
    const facts = factsOf(digest);
    expect(conceptFor(facts, `${SUBJECT}/item:g_worn/wardrobe.garment`)).toBe("subject.wardrobe");
    expect(conceptFor(facts, `${SUBJECT}/item:g_left/wardrobe.garment`)).toBe("location.contents");
    expect(conceptFor(facts, `${SUBJECT}/hair/presentation.hairstyle`)).toBe("subject.current_state");
    expect(conceptFor(facts, `${SUBJECT}/subject:${SUBJECT}/body_language.posture`)).toBe("subject.body_language");
  });

  /**
   * The mandatory lane is the whole reason visual state separates two lanes: a
   * budget squeeze may eat a hairstyle and may never eat the wings. Derived from
   * the digest's own lanes so a fixture change cannot quietly weaken it.
   */
  it("keeps the mandatory lane required and camera-visible detail droppable", () => {
    const digest = characterDigest();
    const subject = digest.subjects[0];
    const facts = factsOf(digest);
    const required = facts.filter((fact) => fact.disposition === "required_visual").map((fact) => fact.key);
    const optional = facts.filter((fact) => fact.disposition === "optional_visual").map((fact) => fact.key);
    expect(required).toEqual(subject?.required.map((fact) => fact.key));
    expect(optional).toEqual(subject?.optional.map((fact) => fact.key));
  });
});

describe("morphology protection", () => {
  /**
   * The species handshake: a tagged appendage takes `extra_appendages` and
   * `extra_limbs` off the negative channel's table, and ordinary anatomy takes
   * nothing off it — because ordinary anatomy is exactly what the duplication
   * exclusions defend.
   *
   * Falsified against a projection that tagged every morphology fact, which
   * would switch the anatomy block off for every character in the game.
   */
  it("tags a species appendage and leaves ordinary anatomy unprotected", () => {
    const digest = characterDigest();
    const facts = factsOf(digest);
    const protections = (key: string): readonly (string | null)[] =>
      (facts.find((fact) => fact.key === key)?.semanticTags ?? []).map(imageMorphologyProtectionOf).filter(Boolean);

    expect(protections(`${SUBJECT}/wings/species.feature_group`)).toEqual(["extra_appendages", "extra_limbs"]);
    expect(protections(`${SUBJECT}/fingers:left:ring_finger/presence`)).toEqual([]);
  });

  /**
   * The morphology subset is the negative anatomy block's guard input, so a fact
   * that is not in `facts` must not be in it either — otherwise a claim the
   * prompt never makes would still be switching an exclusion off.
   */
  it("draws the morphology subset from the emitted facts", () => {
    const digest = characterDigest();
    const projected = projectSubjectDigests({ digest, semanticValue: RESOLVE_ALL }).subjects[0];
    for (const fact of projected?.morphology ?? []) {
      expect(projected?.facts).toContain(fact);
    }
    expect(projected?.morphology.map((fact) => fact.key)).toEqual(
      digest.subjects[0]?.morphology.map((fact) => fact.key),
    );

    // With no resolver the opaque anatomy fact never becomes a claim, so it
    // leaves the guard set with it.
    const unresolved = projectSubjectDigests({ digest }).subjects[0];
    expect(unresolved?.morphology.map((fact) => fact.key)).toEqual([`${SUBJECT}/wings/species.feature_group`]);
  });
});

describe("truth fingerprints are provenance, not prompt semantics", () => {
  /**
   * The tripwire on the condition everything below assumes. If the compat adapter
   * ever stops filing the fingerprint as the value, this fails first and somebody
   * revisits the suppression rule instead of finding out from a render.
   */
  it("recognizes the compatibility adapter's fingerprint-as-value features", () => {
    const adapted = appearanceFeatures();
    expect(adapted.length).toBeGreaterThan(0);
    for (const feature of adapted) {
      expect(imageSubjectFactNeedsSemanticValue(feature)).toBe(true);
    }
    // And a fact that carries real structured truth is not mistaken for one.
    expect(imageSubjectFactNeedsSemanticValue(postureFeature())).toBe(false);
  });

  /**
   * The defect this kills: a compiled prompt reading `The subject has "crooked".`
   * — a canonical-JSON change-detection token presented to a provider as an
   * appearance. It is plausible precisely because the fingerprint LOOKS readable,
   * which is why the rule is "never pass it through" rather than "clean it up".
   */
  it("suppresses a fact whose only value is its fingerprint rather than sending it", () => {
    const digest = characterDigest();
    const projected = projectSubjectDigests({ digest });
    const emitted = projected.subjects.flatMap((subject) => subject.facts);

    expect(emitted.every((fact) => fact.value !== fact.truthFingerprint)).toBe(true);
    expect(emitted.map((fact) => fact.key)).not.toContain(`${SUBJECT}/nose/shape`);
    expect(projected.suppressions).toContainEqual({
      key: `${SUBJECT}/nose/shape`,
      owner: "character.visual_state",
      reason: IMAGE_SUBJECT_VALUE_UNRESOLVED,
    });
    // The fingerprint still travels — as provenance, which is what it is, and
    // byte-identical so a retry can still recognize the same visual moment.
    const resolved = factsOf(digest);
    const nose = resolved.find((fact) => fact.key === `${SUBJECT}/nose/shape`);
    expect(nose?.truthFingerprint).toBe(selectedByKey(digest).get(`${SUBJECT}/nose/shape`)?.truthFingerprint);
    expect(nose?.value).toBe("a resolved semantic value");
  });

  /**
   * The apparent-age gap, made fail-closed rather than merely documented. `age`
   * is a segment kind the package promotes to mandatory, so an unresolved anchor
   * has to reach `missingRequired` — that is what lets a character lane compiled
   * with `refuseOnMissingRequired` refuse before provider spend instead of
   * rendering somebody of no stated age.
   */
  it("reports an unresolved mandatory anchor as missing rather than dropping it quietly", () => {
    const digest = characterDigest([ageAnchorFeature()]);
    const subject = projectSubjectDigests({ digest }).subjects[0];
    expect(subject?.missingRequired).toContain(`${SUBJECT}/face/apparent_age`);
    expect(subject?.missingRequired).toContain(`${SUBJECT}/fingers:left:ring_finger/presence`);

    const resolved = projectSubjectDigests({ digest, semanticValue: () => "late twenties" }).subjects[0];
    expect(resolved?.missingRequired).toEqual([]);
    expect(resolved?.facts.find((fact) => fact.key === `${SUBJECT}/face/apparent_age`)).toMatchObject({
      concept: "subject.apparent_age",
      value: "late twenties",
    });
  });

  /**
   * `missingMandatory` is visual state's own answer to "the snapshot required
   * this and the digest lost it", and it has to survive the translation on its
   * own terms — a caller that only saw the facts would think the render was
   * complete.
   */
  it("carries the digest's own missing-mandatory keys through", () => {
    const digest = characterDigest();
    const withLoss: VisualImageDigest = {
      ...digest,
      subjects: digest.subjects.map((subject) => ({ ...subject, missingMandatory: ["lost.identity.anchor"] })),
    };
    expect(projectSubjectDigests({ digest: withLoss, semanticValue: RESOLVE_ALL }).subjects[0]?.missingRequired).toEqual([
      "lost.identity.anchor",
    ]);
  });
});

describe("nothing internal reaches a provider-facing value", () => {
  /**
   * `ref` and `entityId` are handles for relations and provenance; `label` is the
   * one field a compiled sentence may name somebody by. An unlabelled subject
   * therefore falls back to a neutral noun — a projection that reached for the id
   * would put `subject.chr_7f2a` into a payload that renders a person.
   */
  it("never names a subject by its id", () => {
    const digest = characterDigest();
    const anonymous = projectSubjectDigests({ digest }).subjects[0];
    expect(anonymous?.label).toBe("the subject");
    expect(anonymous?.entityId).toBe(SUBJECT);
    expect(anonymous?.ref).toBe(`subject.${SUBJECT}`);

    // A blank or whitespace-only name is the same absence, not a blank prompt.
    expect(projectSubjectDigests({ digest, labels: { [SUBJECT]: "   " } }).subjects[0]?.label).toBe("the subject");
    expect(projectSubjectDigests({ digest, labels: { [SUBJECT]: " Mira " } }).subjects[0]?.label).toBe("Mira");
  });
});

describe("camera facts", () => {
  /**
   * The band vocabularies are member-for-member copies, so this adapter looks
   * like a cast — and the thing worth pinning is that it stays one: every read
   * the digest asserts arrives with its component and band intact, none is
   * invented, and two calls agree.
   *
   * Derived from the digest's own facts rather than a written list, so adding a
   * sixth camera component fails here (the switch stops compiling) rather than
   * silently emitting five.
   */
  it("carries every asserted read across unchanged and deterministically", () => {
    const digest = characterDigest();
    const facts = projectCameraFacts(digest);
    expect(facts.map((fact) => `${fact.component}:${fact.band}`)).toEqual(
      digest.cameraFacts.map((fact) => `${fact.component}:${fact.band}`),
    );
    expect(facts).toHaveLength(5);
    expect(JSON.stringify(projectCameraFacts(digest))).toBe(JSON.stringify(facts));
    expect(facts.every((fact) => fact.source.owner === "character.visual_state")).toBe(true);
  });

  /**
   * An unknown read has already failed the optional lane closed upstream, so it
   * has nothing honest to assert here either. Falsified against an adapter that
   * emitted a placeholder band for a component the camera could not resolve.
   */
  it("asserts nothing for a read the camera could not resolve", () => {
    const digest = buildVisualImageDigest({
      snapshot: visualAttentionSnapshotFixture([...appearanceFeatures()]),
      context: visualAttentionContextFixture("image", { motion: { status: "unknown" } }),
    });
    expect(projectCameraFacts(digest).map((fact) => fact.component)).not.toContain("motion");
  });
});

// ---------------------------------------------------------------------------
// The character image adapter — the join with the canonical owners
// ---------------------------------------------------------------------------

const ADULT_AGE_VALUE: AttributeValue = { id: "identity.apparent_age", value: "late_twenties", source: "creation" };
const MINOR_AGE_VALUE: AttributeValue = { id: "identity.apparent_age", value: "teen", source: "creation" };
/**
 * The prose the registry words for the fixture's own values (#547), positions
 * included: a colour is the adjective English seats against its noun, so both
 * declare `order: 1`.
 */
const PLATINUM_HAIR = {
  text: "platinum hair",
  phrase: { group: "hair", role: "adjective", fragment: "platinum", order: 1 },
};
const BLUE_EYES = { text: "blue eyes", phrase: { group: "eyes", role: "adjective", fragment: "blue", order: 1 } };

const REQUIRED_APPEARANCE_VALUES: readonly AttributeValue[] = [
  { id: "identity.gender", value: "female", source: "creation" },
  { id: "skin.tone", value: "light", source: "creation" },
  { id: "hair.color", value: "platinum", source: "creation" },
  { id: "hair.length", value: "shoulder_length", source: "creation" },
  { id: "eyes.color", value: "blue", source: "creation" },
  { id: "face.shape", value: "oval", source: "creation" },
  { id: "build.frame", value: "slight", source: "creation" },
  { id: "build.weight_presentation", value: "average", source: "creation" },
];

function completeFixtureAttributes(attributes: readonly AttributeValue[]): readonly AttributeValue[] {
  return [...REQUIRED_APPEARANCE_VALUES, ...attributes];
}

/** The fixture subject's canonical owners — the values the resolver joins in. */
function fixtureSources(overrides: Partial<CharacterSubjectSources> = {}): CharacterSubjectSources {
  const { attributes, ...rest } = overrides;
  return {
    attributes: attributes ?? completeFixtureAttributes([...crookedNoseAttributes(), ADULT_AGE_VALUE]),
    locatedFacts: [freckleClusterFact()],
    anatomy: [missingFingerState()],
    exposure: FULLY_COVERED,
    ...rest,
  };
}

function adapterSlices(digest: VisualImageDigest, overrides: Partial<CharacterSubjectSources> = {}) {
  return projectCharacterWorldSlices({ digest, sources: { [SUBJECT]: fixtureSources(overrides) } });
}

describe("projectCharacterWorldSlices", () => {
  it("creates a complete source-backed subject when visual selection contains no facts", () => {
    const digest = buildVisualImageDigest({
      snapshot: visualAttentionSnapshotFixture([]),
      context: visualAttentionContextFixture("image", { framing: { status: "known", value: "waist_up" } }),
    });
    expect(digest.subjects).toEqual([]);

    const complete = adapterSlices(digest);
    expect(complete.subjects).toHaveLength(1);
    expect(complete.subjects[0]).toMatchObject({
      ref: `subject.${SUBJECT}`,
      entityId: SUBJECT,
      label: "the subject",
      missingRequired: [],
    });
    expect(complete.subjects[0]?.facts.find((fact) => fact.source.key === "hair.color")?.value).toEqual(
      PLATINUM_HAIR,
    );
    expect(complete.subjects[0]?.facts.find((fact) => fact.source.key === "eyes.color")?.value).toEqual(
      BLUE_EYES,
    );

    const withoutHair = adapterSlices(digest, {
      attributes: completeFixtureAttributes([
        ...crookedNoseAttributes(),
        ADULT_AGE_VALUE,
      ]).filter((attribute) => attribute.id !== "hair.color"),
    });
    expect(withoutHair.subjects[0]?.missingRequired).toContain(
      `subject.${SUBJECT}.appearance.hair.color`,
    );
  });

  it("adds canonical appearance facts once and protects required reference-free identity", () => {
    const slices = adapterSlices(characterDigest([ageAnchorFeature()]));
    const subject = slices.subjects[0];
    const appearance = (subject?.facts ?? []).filter((fact) => fact.concept === "subject.appearance");
    expect(appearance.find((fact) => fact.source.key === "hair.color")).toMatchObject({
      value: PLATINUM_HAIR,
      disposition: "required_visual",
    });
    expect(appearance.find((fact) => fact.source.key === "eyes.color")).toMatchObject({
      value: BLUE_EYES,
      disposition: "required_visual",
    });
    expect(new Set(appearance.map((fact) => fact.source.key)).size).toBe(appearance.length);
    expect(subject?.missingRequired).toEqual([]);
  });

  it("reports a missing reference-free core value but lets an actual planned identity reference carry it", () => {
    const attributes = REQUIRED_APPEARANCE_VALUES.filter((value) => value.id !== "hair.color");
    const digest = characterDigest([ageAnchorFeature()]);
    const unanchored = projectCharacterWorldSlices({
      digest,
      sources: { [SUBJECT]: fixtureSources({ attributes: [...attributes, ADULT_AGE_VALUE] }) },
    });
    const missing = `subject.${SUBJECT}.appearance.hair.color`;
    expect(unanchored.subjects[0]?.missingRequired).toContain(missing);

    const anchored = projectCharacterWorldSlices({
      digest,
      sources: { [SUBJECT]: fixtureSources({ attributes: [...attributes, ADULT_AGE_VALUE] }) },
      identityReferenceSubjects: new Set([`subject.${SUBJECT}`]),
    });
    expect(anchored.subjects[0]?.missingRequired).not.toContain(missing);
    expect(anchored.subjects[0]?.facts.find((fact) => fact.source.key === "eyes.color")?.value).toEqual(
      BLUE_EYES,
    );
  });

  it("states the canonical non-human species exactly once beside its feature-group morphology", () => {
    const subject = adapterSlices(characterDigest([ageAnchorFeature()]), {
      realizedBody: visualStateNonHumanBody(["wings"]),
    }).subjects[0];
    expect(subject?.facts.filter((fact) => fact.key === `subject.${SUBJECT}.species`)).toEqual([
      expect.objectContaining({ value: "Succubus", disposition: "required_visual" }),
    ]);
    expect(subject?.morphology.filter((fact) => fact.key === `${SUBJECT}/wings/species.feature_group`)).toHaveLength(1);
  });

  it("keeps close detail in a close-up and omits it from a wide frame", () => {
    const atFraming = (framing: "close_up" | "wide"): VisualImageDigest =>
      buildVisualImageDigest({
        snapshot: visualAttentionSnapshotFixture([...appearanceFeatures()]),
        context: visualAttentionContextFixture("image", { framing: { status: "known", value: framing } }),
      });
    const attributes = completeFixtureAttributes([
      ...crookedNoseAttributes(),
      ADULT_AGE_VALUE,
      { id: "nose.piercings", value: "septum", source: "manual" },
    ]);
    const hasPiercing = (digest: VisualImageDigest): boolean =>
      adapterSlices(digest, { attributes }).subjects[0]?.facts.some(
        (fact) => fact.source.key === "nose.piercings",
      ) ?? false;

    expect(hasPiercing(atFraming("close_up"))).toBe(true);
    expect(hasPiercing(atFraming("wide"))).toBe(false);
  });

  it("lets an emitted live hairstyle replace both sheet hair fallbacks", () => {
    const attributes = completeFixtureAttributes([
      ...crookedNoseAttributes(),
      ADULT_AGE_VALUE,
      { id: "hair.arrangement", value: "ponytail", source: "manual" },
      { id: "hair.style", value: "sheet curls", source: "manual" },
    ]);
    const digest = buildVisualImageDigest({
      snapshot: visualAttentionSnapshotFixture([hairstyleFeature(), ageAnchorFeature()]),
      context: visualAttentionContextFixture("image", { framing: { status: "known", value: "portrait" } }),
    });
    expect(digest.optionalFacts.map((fact) => fact.kindId)).toContain("presentation.hairstyle");
    const subject = adapterSlices(digest, {
      attributes,
    }).subjects[0];
    const sourceKeys = (subject?.facts ?? []).map((fact) => fact.source.key);
    expect(sourceKeys).not.toContain("hair.arrangement");
    expect(sourceKeys).not.toContain("hair.style");
    // The replacement is worded as the hair TRAILER it replaces, so it composes
    // where the sheet's own arrangement would have (#547).
    expect(subject?.facts.find((fact) => fact.key === `${SUBJECT}/hair/presentation.hairstyle`)?.value).toEqual({
      text: "with the hair worn loose",
      phrase: { group: "hair", role: "trailer", fragment: "worn loose", order: 0 },
    });
  });

  it("lets an emitted live grooming fact replace the sheet grooming fallback", () => {
    const faceVisible = affordancePerceptionView({
      exposure: { face: "visible" },
      channels: { sight: "available" },
    });
    const digest = buildVisualImageDigest({
      snapshot: visualAttentionSnapshotFixture([groomingFeature(), ageAnchorFeature()]),
      context: visualAttentionContextFixture("image", {
        perception: faceVisible,
        framing: { status: "known", value: "portrait" },
      }),
    });
    expect(digest.optionalFacts.map((fact) => fact.kindId)).toContain("presentation.grooming");
    const subject = adapterSlices(digest, {
      attributes: completeFixtureAttributes([
        ...crookedNoseAttributes(),
        ADULT_AGE_VALUE,
        { id: "presentation.grooming", value: "neat", source: "manual" },
      ]),
    }).subjects[0];
    expect(subject?.facts.some((fact) => fact.source.key === "presentation.grooming")).toBe(false);
    expect(subject?.facts.find((fact) => fact.key.includes("presentation.grooming:brows"))?.value).toContain("shaped");
  });

  it("keeps a sheet fallback when the selected current fact is unreadable", () => {
    const unreadableGrooming = { ...groomingFeature(), value: {} };
    const digest = buildVisualImageDigest({
      snapshot: visualAttentionSnapshotFixture([unreadableGrooming, ageAnchorFeature()]),
      context: visualAttentionContextFixture("image", {
        perception: affordancePerceptionView({
          exposure: { face: "visible" },
          channels: { sight: "available" },
        }),
        framing: { status: "known", value: "portrait" },
      }),
    });
    expect(digest.optionalFacts.map((fact) => fact.kindId)).toContain("presentation.grooming");
    const subject = adapterSlices(digest, {
      attributes: completeFixtureAttributes([
        ...crookedNoseAttributes(),
        ADULT_AGE_VALUE,
        { id: "presentation.grooming", value: "neat", source: "manual" },
      ]),
    }).subjects[0];
    expect(subject?.facts.find((fact) => fact.source.key === "presentation.grooming")?.value).toBe(
      "Grooming: neat",
    );
  });

  it("hides chest hair under an opaque torso and states it when the torso is bare", () => {
    const digest = buildVisualImageDigest({
      snapshot: visualAttentionSnapshotFixture([...appearanceFeatures()]),
      context: visualAttentionContextFixture("image", { framing: { status: "known", value: "waist_up" } }),
    });
    const attributes = completeFixtureAttributes([
      ...crookedNoseAttributes(),
      ADULT_AGE_VALUE,
      { id: "chest.hair", value: "thick", source: "manual" },
    ]);
    const chestHair = (exposure: RegionExposure): ImageWorldFact | undefined =>
      adapterSlices(digest, { attributes, exposure }).subjects[0]?.facts.find(
        (fact) => fact.source.key === "chest.hair",
      );

    expect(chestHair(FULLY_COVERED)).toBeUndefined();
    expect(chestHair({ ...FULLY_COVERED, torso: "bare" })).toMatchObject({
      concept: "subject.appearance",
      value: "Chest hair: thick",
    });
  });

  /**
   * The issue's completion criterion, stated as one case: with every canonical
   * owner joined, the fixture subject binds — no required anchor is suppressed,
   * nothing lands in `missingRequired`, and every emitted value is readable
   * prompt material rather than a fingerprint or a record. The per-owner
   * assertions pin the value each canonical owner is expected to speak in.
   */
  it("completes the fixtures: every required anchor valued, none suppressed", () => {
    const digest = characterDigest([ageAnchorFeature()]);
    const subject = adapterSlices(digest).subjects[0];
    expect(subject?.missingRequired).toEqual([]);
    for (const fact of subject?.facts ?? []) {
      expect(typeof fact.value).toBe("string");
      expect(fact.value).not.toBe(fact.truthFingerprint);
    }
    const byKey = new Map((subject?.facts ?? []).map((fact) => [fact.key, fact]));
    expect(byKey.get(`${SUBJECT}/nose/shape`)?.value).toBe("Nose shape: crooked");
    expect(byKey.get(`${SUBJECT}/fingers:left:ring_finger/presence`)?.value).toBe("left ring finger: absent");
    expect(byKey.get(`${SUBJECT}/face/apparent_age`)?.value).toBe("in the late twenties");
    expect(byKey.get(`${SUBJECT}/item:g_worn/wardrobe.garment`)?.value).toBe("top");
  });

  /**
   * Gap 3: the absence handshake. An anatomy fact whose canonical state says
   * "absent" becomes `subject.absence` — the concept that takes the missing-part
   * exclusions off the negative channel's table — while staying in the
   * morphology guard subset and in the same segment kind visual state assigned.
   * A prosthetic additionally claims the synthetic-surface protection; wings
   * stay ordinary morphology.
   */
  it("re-files an authored absence as subject.absence without leaving the morphology guard", () => {
    const digest = characterDigest();
    const subject = adapterSlices(digest).subjects[0];
    const fingerKey = `${SUBJECT}/fingers:left:ring_finger/presence`;
    expect(subject?.facts.find((fact) => fact.key === fingerKey)?.concept).toBe("subject.absence");
    expect(subject?.morphology.map((fact) => fact.key)).toContain(fingerKey);
    expect(imageConcept("subject.absence")?.segmentKind).toBe(imageConcept("subject.morphology")?.segmentKind);
    expect(subject?.facts.find((fact) => fact.key === `${SUBJECT}/wings/species.feature_group`)?.concept).toBe(
      "subject.morphology",
    );

    const prosthetic = adapterSlices(digest, {
      anatomy: [{ ...missingFingerState(), state: "prosthetic" }],
    }).subjects[0]?.facts.find((fact) => fact.key === fingerKey);
    expect(prosthetic?.concept).toBe("subject.absence");
    expect(prosthetic?.semanticTags).toContain("morphology.synthetic_surface");
    expect(prosthetic?.value).toBe("left ring finger: prosthetic");
  });

  /**
   * Gap 2: exposure is the adapter's own authoritative claim over the coverage
   * readout — required, worded by the one canonical table in its
   * predicate-fragment inflection (the value a dialect wraps as "<subject> is
   * …"), silent where covered, and honoring the readout's
   * bare-legs-under-a-bare-pelvis contract.
   */
  it("states the coverage readout as authoritative exposure claims", () => {
    const digest = characterDigest();
    const bare: RegionExposure = { torso: "bare", pelvis: "covered", legs: "sheer", feet: "covered" };
    const stated = adapterSlices(digest, { exposure: bare }).subjects[0]?.facts.filter(
      (fact) => fact.concept === "subject.exposure",
    );
    expect(stated?.map((fact) => [fact.key, fact.value])).toEqual([
      [`subject.${SUBJECT}.exposure.torso`, "bare at the torso"],
      [`subject.${SUBJECT}.exposure.legs`, "in sheer fabric that shows the legs"],
    ]);
    expect(stated?.every((fact) => fact.disposition === "required_visual")).toBe(true);

    // Fully covered = silence: wardrobe authority says what covers the body.
    expect(adapterSlices(digest).subjects[0]?.facts.some((fact) => fact.concept === "subject.exposure")).toBe(false);

    const bareBelow = adapterSlices(digest, {
      exposure: { torso: "covered", pelvis: "bare", legs: "bare", feet: "covered" },
    }).subjects[0]?.facts.filter((fact) => fact.concept === "subject.exposure");
    expect(bareBelow?.map((fact) => fact.key)).toEqual([`subject.${SUBJECT}.exposure.pelvis`]);
  });

  /**
   * The frame gates which regions may be stated at all: a portrait shows no
   * pelvis, so a portrait-framed digest says nothing about it even when the
   * readout reads bare — stating out-of-frame skin would be the prompt arguing
   * with the shot.
   */
  it("gates exposure regions by the digest's framing", () => {
    const digest = buildVisualImageDigest({
      snapshot: visualAttentionSnapshotFixture([...appearanceFeatures()]),
      context: visualAttentionContextFixture("image", { framing: { status: "known", value: "portrait" } }),
    });
    const subject = adapterSlices(digest, {
      exposure: { torso: "covered", pelvis: "bare", legs: "bare", feet: "bare" },
    }).subjects[0];
    expect(subject?.facts.some((fact) => fact.concept === "subject.exposure")).toBe(false);
  });

  /**
   * A subject `sources` never joined fails CLOSED: coverage is the one owner
   * whose absence is otherwise silent, so the unresolved key must land in
   * `missingRequired` — not only in the suppression record — or a lane compiled
   * with `refuseOnMissingRequired` would render with no wardrobe-coverage
   * authority at all. Falsified against the diagnostic-only version, which
   * recorded the suppression and let the subject bind anyway.
   */
  it("fails a subject with no joined coverage source closed", () => {
    const digest = characterDigest();
    const slices = projectCharacterWorldSlices({ digest, sources: {} });
    const exposureKey = `subject.${SUBJECT}.exposure`;
    expect(slices.subjects[0]?.facts.some((fact) => fact.concept === "subject.exposure")).toBe(false);
    expect(slices.subjects[0]?.missingRequired).toContain(exposureKey);
    expect(slices.suppressions).toContainEqual({
      key: exposureKey,
      owner: IMAGE_CHARACTER_COVERAGE_OWNER,
      reason: IMAGE_CHARACTER_COVERAGE_UNRESOLVED,
    });
  });

  /**
   * The seam with the dialect layer: a `subject.exposure` value is a PREDICATE
   * fragment, because every dialect wraps it as "<subject> is <value>" — the
   * defect this kills compiled "Mira is the torso is bare" from the segment
   * path's standalone clause. Composed through the real Qwen dialect over every
   * region/state cell of the canonical table (the two readouts together reach
   * all eight), asserting the JOIN property rather than re-pinning the
   * dialect's wording table: the compiled sentence names the subject once and
   * the value contributes no second subject–verb clause.
   */
  it("shapes exposure values so the dialect's subject wrapping composes grammatically", () => {
    const digest = characterDigest();
    const readouts: readonly RegionExposure[] = [
      { torso: "bare", pelvis: "bare", legs: "sheer", feet: "bare" },
      { torso: "sheer", pelvis: "sheer", legs: "bare", feet: "sheer" },
    ];
    const sentences = readouts.flatMap((exposure) => {
      const slices = projectCharacterWorldSlices({
        digest,
        labels: { [SUBJECT]: "Mira" },
        sources: { [SUBJECT]: fixtureSources({ exposure }) },
      });
      const world = buildImageWorldDigest({
        read: { kind: "transactional_projection", token: "read-exposure" },
        operation: {
          kind: "generate",
          task: "portrait",
          strategy: "text_to_image_description",
          subjectCount: 1,
          style: { medium: "photographic", descriptors: [] },
          literalText: [],
        },
        subjects: slices.subjects,
      }).digest;
      const claims = selectImagePositiveClaims(world).filter((claim) => claim.concept === "subject.exposure");
      const compiled = qwenImage2512Dialect.compilePositive({
        claims,
        operation: world.operation,
        references: [],
        entityLabels: { [`subject.${SUBJECT}`]: "Mira" },
        budget: {},
      });
      expect(compiled.droppedClaimIds).toEqual([]);
      return compiled.segments.map((segment) => segment.text);
    });

    expect(sentences).toHaveLength(8);
    expect(sentences).toContain("Mira is bare at the torso.");
    for (const sentence of sentences) {
      const predicate = sentence.replace(/^Mira is /, "");
      expect(predicate).not.toBe(sentence); // the dialect's wrapping actually applied
      expect(predicate).not.toMatch(/^the\b/); // no article-led noun phrase after "is"
      expect(predicate).not.toMatch(/\b(?:is|are)\b/); // no second finite verb — one clause, one subject
    }
  });

  /**
   * #547: an appearance attribute the registry words as PROSE reaches the
   * digest as the phrase record, and one it does not keeps its label form.
   *
   * Both paths into a subject's appearance facts are exercised at once, because
   * they are the two ways the same attribute can arrive and they used to be
   * able to disagree: `nose.shape` comes through the visual-state resolver
   * (`attributeSemanticValue`), `hair.color` and `hair.length` through the
   * registry projection this adapter runs itself.
   *
   * The record has to survive two seams to be useful — the renderer table, which
   * previously suppressed any record at `appearance.attribute` as unreadable,
   * and the dialect, which words a record through its `text` member. So the
   * second half compiles the real 2512 dialect over the emitted claims: a
   * dialect that does not compose phrases still gets a sentence, and it is
   * prose rather than "Mira has hair color: platinum".
   */
  it("emits the registry's phrase for a worded attribute and the label form for an unworded one", () => {
    const digest = characterDigest();
    const slices = projectCharacterWorldSlices({
      digest,
      labels: { [SUBJECT]: "Mira" },
      sources: { [SUBJECT]: fixtureSources() },
    });
    const facts = slices.subjects[0]?.facts ?? [];
    const valueOf = (key: string): unknown => facts.find((fact) => fact.source.key === key)?.value;

    // The registry projection's own path.
    expect(imageAppearancePhrase(valueOf("hair.color"))).toEqual(PLATINUM_HAIR);
    expect(imageAppearancePhrase(valueOf("hair.length"))).toEqual({
      text: "hair to the shoulders",
      // A length trails the arrangement, so it declares the higher position.
      phrase: { group: "hair", role: "trailer", fragment: "to the shoulders", order: 1 },
    });
    // The visual-state resolver's path, over the fixture's selected nose fact —
    // found by fact key, because a resolver-answered fact carries the visual
    // state's own source key rather than the bare attribute id.
    const nose = facts.find((fact) => fact.key === `${SUBJECT}/nose/shape`);
    expect(imageAppearancePhrase(nose?.value)).toEqual({
      text: "a crooked nose",
      phrase: { group: "face", role: "with", fragment: "a crooked nose" },
    });
    // No phrase declared: the self-describing form the registry always had.
    expect(valueOf("identity.gender")).toBe("Gender: female");

    const world = buildImageWorldDigest({
      read: { kind: "transactional_projection", token: "read-appearance" },
      operation: {
        kind: "generate",
        task: "portrait",
        strategy: "text_to_image_description",
        subjectCount: 1,
        style: { medium: "photographic", descriptors: [] },
        literalText: [],
      },
      subjects: slices.subjects,
    }).digest;
    const claims = selectImagePositiveClaims(world).filter((claim) => claim.concept === "subject.appearance");
    const compiled = qwenImage2512Dialect.compilePositive({
      claims,
      operation: world.operation,
      references: [],
      entityLabels: { [`subject.${SUBJECT}`]: "Mira" },
      budget: {},
    });
    expect(compiled.droppedClaimIds).toEqual([]);
    const sentences = compiled.segments.map((segment) => segment.text);
    expect(sentences).toContain("Mira has platinum hair.");
    expect(sentences).toContain("Mira has hair to the shoulders.");
    expect(sentences).not.toContain("Mira has Hair color: platinum.");
  });

  /**
   * Gap 1: the age anchor's canonical semantic path, with the owner-ruled floor.
   * An adult band becomes a required `subject.apparent_age` claim sourced from
   * the attribute registry; a minor band states NOTHING and refuses nothing (a
   * designed suppression, never a missing anchor); no band at all fails the
   * mandatory age closed so the lane can refuse before spend.
   */
  it("anchors apparent age from the attribute registry with the adult floor", () => {
    const digest = characterDigest();
    const ageKey = `subject.${SUBJECT}.apparent_age`;

    const adult = adapterSlices(digest);
    const age = adult.subjects[0]?.facts.find((fact) => fact.concept === "subject.apparent_age");
    expect(age).toMatchObject({ key: ageKey, value: "in the late twenties", disposition: "required_visual" });
    expect(age?.source.owner).toBe(IMAGE_CHARACTER_ATTRIBUTE_OWNER);
    expect(adult.subjects[0]?.missingRequired).toEqual([]);

    // The floor itself (owner ruling 2026-07-29): `eighteen` states the number
    // outright as an adult, never a word that could read younger.
    const floor = adapterSlices(digest, {
      attributes: completeFixtureAttributes([
        ...crookedNoseAttributes(),
        { ...ADULT_AGE_VALUE, value: "eighteen" },
      ]),
    });
    const eighteen = floor.subjects[0]?.facts.find((fact) => fact.concept === "subject.apparent_age");
    expect(eighteen?.value).toBe("exactly eighteen years old, an adult");
    expect(eighteen?.value).not.toMatch(/\bteen\b/i);

    const minor = adapterSlices(digest, {
      attributes: completeFixtureAttributes([...crookedNoseAttributes(), MINOR_AGE_VALUE]),
    });
    expect(minor.subjects[0]?.facts.some((fact) => fact.concept === "subject.apparent_age")).toBe(false);
    expect(minor.subjects[0]?.missingRequired).toEqual([]);
    expect(minor.suppressions).toContainEqual({
      key: ageKey,
      owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER,
      reason: IMAGE_CHARACTER_AGE_WITHHELD,
    });

    const unset = adapterSlices(digest, { attributes: completeFixtureAttributes(crookedNoseAttributes()) });
    expect(unset.subjects[0]?.missingRequired).toContain(ageKey);

    // Only a band the REGISTRY recognizes is withheld by ruling. A string it
    // does not know ("adult", a legacy or malformed value the attribute schema
    // lets through) is nobody's ruling: it must fail the mandatory anchor
    // closed, never render age-silent. Falsified against the classifier that
    // treated every non-phrase string as withheld.
    const malformed = adapterSlices(digest, {
      attributes: completeFixtureAttributes([
        ...crookedNoseAttributes(),
        { ...ADULT_AGE_VALUE, value: "adult" },
      ]),
    });
    expect(malformed.subjects[0]?.facts.some((fact) => fact.concept === "subject.apparent_age")).toBe(false);
    expect(malformed.subjects[0]?.missingRequired).toContain(ageKey);
    expect(malformed.suppressions).toContainEqual({
      key: ageKey,
      owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER,
      reason: IMAGE_CHARACTER_AGE_UNRESOLVED,
    });
  });

  /**
   * The same floor when visual state DID project the anchor: the scaffold's
   * fail-closed unresolved record is reclassified as the owner ruling it is, so
   * the lane renders age-silent instead of refusing over a designed absence.
   */
  it("applies the same floor to a projected age anchor", () => {
    const digest = characterDigest([ageAnchorFeature()]);
    const minor = adapterSlices(digest, {
      attributes: completeFixtureAttributes([...crookedNoseAttributes(), MINOR_AGE_VALUE]),
    });
    expect(minor.subjects[0]?.facts.some((fact) => fact.concept === "subject.apparent_age")).toBe(false);
    expect(minor.subjects[0]?.missingRequired).toEqual([]);
    expect(minor.suppressions).toContainEqual({
      key: `${SUBJECT}/face/apparent_age`,
      owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER,
      reason: IMAGE_CHARACTER_AGE_WITHHELD,
    });

    // The floor reclassifies only bands the registry knows: a malformed value
    // on the projected anchor keeps the scaffold's fail-closed record instead
    // of being rewritten into a ruling nobody made.
    const malformed = adapterSlices(digest, {
      attributes: completeFixtureAttributes([
        ...crookedNoseAttributes(),
        { ...ADULT_AGE_VALUE, value: "adult" },
      ]),
    });
    expect(malformed.subjects[0]?.missingRequired).toContain(`${SUBJECT}/face/apparent_age`);
  });

  /**
   * The lane's `omit` policy (a scene inherits visible age from its identity
   * references) withholds the anchor ahead of the band, on both anchor paths,
   * as a designed suppression: no `subject.apparent_age` fact, and never a
   * `missingRequired` key. Falsified two ways — against the adapter that
   * synthesized the anchor for every lane (the compiled two-person scene read
   * "Nyx appears in the late twenties. Ilsa appears in the forties."), and
   * against an omit that fails the mandatory age closed instead, which would
   * refuse every `refuseOnMissingRequired` scene rung.
   */
  it.each([
    ["synthesized", characterDigest(), `subject.${SUBJECT}.apparent_age`],
    ["projected", characterDigest([ageAnchorFeature()]), `${SUBJECT}/face/apparent_age`],
  ])("withholds a %s age anchor under the omit policy without losing it", (_, digest, ageKey) => {
    for (const attributes of [[...crookedNoseAttributes(), ADULT_AGE_VALUE], crookedNoseAttributes()]) {
      const omitted = projectCharacterWorldSlices({
        digest,
        sources: { [SUBJECT]: fixtureSources({ attributes: completeFixtureAttributes(attributes) }) },
        apparentAge: "omit",
      });
      expect(omitted.subjects[0]?.facts.some((fact) => fact.concept === "subject.apparent_age")).toBe(false);
      expect(omitted.subjects[0]?.missingRequired).toEqual([]);
      expect(omitted.suppressions.filter((entry) => entry.key === ageKey)).toEqual([
        { key: ageKey, owner: IMAGE_CHARACTER_ATTRIBUTE_OWNER, reason: IMAGE_CHARACTER_AGE_OMITTED },
      ]);
    }
  });

  /**
   * Gap 4: record-shaped values become readable prompt values — the garment's
   * name (subtype-led for an accessory, per the face-jewelry rule) with `locus`,
   * `definitionId` and every other handle stripped — instead of relying on the
   * dialect's record-flattening fallback, which is one member away from putting
   * an id in a payload.
   */
  it("resolves record values to readable prompt values with every id stripped", () => {
    const ring = projectWardrobeFeatures({
      garments: [
        visualStateGarmentFixture({ id: "g_ring", categoryId: "jewelry", subtypeId: "nose_ring", name: "Thin gold hoop" }),
      ],
      subjectsByActor: new Map([[VISUAL_STATE_FIXTURE_ACTOR, SUBJECT]]),
      sceneSubjectId: SUBJECT,
    });
    const subject = adapterSlices(characterDigest(ring)).subjects[0];
    const byKey = new Map((subject?.facts ?? []).map((fact) => [fact.key, fact]));
    expect(byKey.get(`${SUBJECT}/item:g_ring/wardrobe.item`)?.value).toBe("nose ring: Thin gold hoop");
    expect(byKey.get(`${SUBJECT}/item:g_worn/wardrobe.garment`)?.value).toBe("top");
    expect(byKey.get(`${SUBJECT}/subject:${SUBJECT}/body_language.posture`)?.value).toBe("kneeling");
    expect(byKey.get(`${SUBJECT}/hair/presentation.hairstyle`)?.value).toEqual({
      text: "with the hair worn loose",
      phrase: { group: "hair", role: "trailer", fragment: "worn loose", order: 0 },
    });
    expect(byKey.get(`${SUBJECT}/wings/species.feature_group`)?.value).toBe("wings");

    const prose = (subject?.facts ?? []).map((fact) => String(fact.value)).join(" ");
    expect(prose).not.toContain("def_");
    expect(prose).not.toContain(VISUAL_STATE_FIXTURE_ACTOR);
  });

  /**
   * The resolver arm the digest cannot exercise deterministically (a located
   * fact may fall to camera coverage), asserted at the join itself: the value
   * comes from the row's PARSED value through its kind's own label, and a row
   * outside its validity window resolves nothing rather than resurrecting.
   */
  it("answers a located fact from its canonical row, honoring the validity window", () => {
    const freckle = appearanceFeatures().find(
      (feature) => feature.key === `${SUBJECT}/shoulders/pigmentation.freckle_cluster`,
    );
    expect(freckle).toBeDefined();

    const resolver = characterSemanticValueResolver({ sources: { [SUBJECT]: fixtureSources() }, atMinutes: 0 });
    expect(freckle && resolver(freckle)).toBe("Freckle cluster: dense, clustered");

    const expired = characterSemanticValueResolver({
      sources: { [SUBJECT]: fixtureSources({ locatedFacts: [freckleClusterFact({ validUntil: 5 })] }) },
      atMinutes: 10,
    });
    expect(freckle && expired(freckle)).toBeUndefined();
  });
});

/**
 * Gap 5: hair the worn headwear fully hides (docs/images/character-prompts.md
 * §Hair the headwear conceals). Visual state selected the hairstyle by camera
 * visibility and knows nothing of the band; the adapter is the one place that
 * holds both. Falsified against an adapter that carried `hairOcclusion` and read
 * it nowhere — the state the band's carrier left every prompt in — and against
 * one that filtered by value words, which the structural fixture (a record
 * value at the hair locus) never contains.
 */
describe("hair the headwear fully hides", () => {
  const HAIRSTYLE_KEY = `${SUBJECT}/hair/presentation.hairstyle`;

  it("withholds every hair fact at `full` as a designed suppression and states the concealment in its place", () => {
    const digest = characterDigest([ageAnchorFeature()]);
    expect(selectedByKey(digest).has(HAIRSTYLE_KEY)).toBe(true);

    const slices = adapterSlices(digest, { hairOcclusion: "full" });
    const subject = slices.subjects[0];
    const byKey = new Map((subject?.facts ?? []).map((fact) => [fact.key, fact]));
    expect(byKey.has(HAIRSTYLE_KEY)).toBe(false);
    expect(slices.suppressions).toContainEqual(
      expect.objectContaining({ key: HAIRSTYLE_KEY, reason: IMAGE_CHARACTER_HAIR_CONCEALED }),
    );
    const concealment = byKey.get(`subject.${SUBJECT}.hair_concealment`);
    expect(concealment?.concept).toBe("subject.hair_concealment");
    expect(concealment?.disposition).toBe("required_visual");
    // A withheld hair fact is not a lost anchor: the subject still binds.
    expect(subject?.missingRequired).toEqual([]);
    // Nothing else moved: the nose, the wings and the garment are exactly as
    // they were, so the filter is structural rather than a broad sweep.
    expect(byKey.get(`${SUBJECT}/nose/shape`)?.value).toBe("Nose shape: crooked");
    expect(byKey.get(`${SUBJECT}/item:g_worn/wardrobe.garment`)?.value).toBe("top");
  });

  it.each(["none", "partial"] as const)("leaves the hair exactly as selected at `%s`", (band) => {
    const digest = characterDigest([ageAnchorFeature()]);
    const facts = adapterSlices(digest, { hairOcclusion: band }).subjects[0]?.facts ?? [];
    expect(facts.some((fact) => fact.key === HAIRSTYLE_KEY)).toBe(true);
    expect(facts.some((fact) => fact.concept === "subject.hair_concealment")).toBe(false);
  });
});

/**
 * What the adapter refuses to say, and what it now says instead (#544).
 *
 * Three defects the compiled Qwen scene prompt shipped on 2026-09-10, each
 * traced to this module: a support relation flattened into "Katelyn Nacon is
 * surface, ground, legs, borne by." (D1), a bra and panties stated under an
 * opaque sweater (D6), and the subject re-named in every sentence because no
 * dialect may guess a pronoun (D2). The wording of one structured value is
 * `character-adapter-renderers.test.ts`'s claim; these cases prove the
 * PROJECTION applies it — the fact leaves, the suppression is recorded with its
 * own reason, and the mandatory floor is not moved by a designed silence.
 */
describe("what a scene prompt may say about a subject (#544)", () => {
  const WORN_GARMENT_KEY = `${SUBJECT}/item:g_worn/wardrobe.garment`;
  const SUPPORT_KEY = `${SUBJECT}/subject:${SUBJECT}/body_language.support`;

  /** The exact value from the owner's 2026-09-10 report: weight on the ground. */
  function supportFeature(): VisualStateFeature {
    return visualStateFeatureFixture({
      subjectId: SUBJECT,
      kindId: VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID,
      layer: "body_language",
      stability: "instantaneous",
      aspect: "body_language.support",
      locus: { kind: "subject", subjectId: SUBJECT },
      sourceRef: { kind: "scene_relation", relationId: "rel_support" },
      value: {
        relations: [
          {
            role: "borne_by",
            anchor: { kind: "surface", supportId: "sup_ground", surfaceKind: "ground" },
            loadZones: ["legs"],
          },
        ],
      },
    });
  }

  function digestOf(features: readonly VisualStateFeature[]): VisualImageDigest {
    return buildVisualImageDigest({
      snapshot: visualAttentionSnapshotFixture([...features]),
      context: visualAttentionContextFixture("image", { framing: { status: "known", value: "full_figure" } }),
    });
  }

  /**
   * D1, at the projection. With no posture fact the support relation states
   * where the weight rests in words somebody can draw; the flattened leaves
   * never appear in any emitted value.
   */
  it("words a support anchor and never ships its flattened relation record", () => {
    const digest = digestOf([supportFeature(), ageAnchorFeature()]);
    expect([...digest.mandatoryFacts, ...digest.optionalFacts].map((fact) => fact.kindId)).toContain(
      VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID,
    );
    const subject = adapterSlices(digest).subjects[0];
    expect(subject?.facts.find((fact) => fact.key === SUPPORT_KEY)?.value).toBe("standing on the floor");
    const prose = (subject?.facts ?? []).map((fact) => String(fact.value)).join(" ");
    expect(prose).not.toContain("borne by");
    expect(prose).not.toContain("surface, ground");
  });

  /**
   * The same relation beside a posture says nothing at all: posture already
   * places the body, and the two claims together are the duplication D10
   * records. A designed silence still leaves a provenance record.
   */
  it("withholds a support relation a posture already places", () => {
    const digest = characterDigest([supportFeature(), ageAnchorFeature()]);
    expect([...digest.mandatoryFacts, ...digest.optionalFacts].map((fact) => fact.kindId)).toContain(
      VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
    );
    const slices = adapterSlices(digest);
    expect(slices.subjects[0]?.facts.some((fact) => fact.key === SUPPORT_KEY)).toBe(false);
    expect(slices.suppressions).toContainEqual({
      key: SUPPORT_KEY,
      owner: IMAGE_SUBJECT_PROJECTION_OWNER,
      reason: IMAGE_CHARACTER_VALUE_UNREADABLE,
    });
  });

  /**
   * D6: a worn garment the wardrobe projection tags as fully concealed leaves
   * the prompt as a DESIGNED suppression. The tag is that projection's own read
   * of its occlusion edges (the tag literal is the contract between the two
   * slices), the exposure claims over the same coverage readout are untouched,
   * and the key never reaches `missingRequired` — a designed silence may not
   * refuse a rung.
   */
  it("withholds a concealed garment while leaving coverage and the mandatory floor alone", () => {
    const concealed = garmentFeatures().map((feature) =>
      feature.key === WORN_GARMENT_KEY
        ? { ...feature, semanticTags: [...feature.semanticTags, "wardrobe.concealed"] }
        : feature,
    );
    const digest = digestOf([...concealed, ageAnchorFeature()]);
    const slices = projectCharacterWorldSlices({
      digest,
      sources: {
        [SUBJECT]: fixtureSources({
          exposure: { torso: "covered", pelvis: "covered", legs: "bare", feet: "covered" },
        }),
      },
    });
    const subject = slices.subjects[0];

    expect(subject?.facts.some((fact) => fact.key === WORN_GARMENT_KEY)).toBe(false);
    expect(slices.suppressions).toContainEqual({
      key: WORN_GARMENT_KEY,
      owner: IMAGE_SUBJECT_PROJECTION_OWNER,
      reason: IMAGE_CHARACTER_WARDROBE_CONCEALED,
    });
    expect(subject?.missingRequired).not.toContain(WORN_GARMENT_KEY);
    // Coverage is untouched truth: the bare legs are still stated.
    expect(subject?.facts.filter((fact) => fact.concept === "subject.exposure").map((fact) => fact.key)).toEqual([
      `subject.${SUBJECT}.exposure.legs`,
    ]);

    // Untagged, the same garment is stated exactly as before.
    const stated = adapterSlices(digestOf([...garmentFeatures(), ageAnchorFeature()])).subjects[0];
    expect(stated?.facts.find((fact) => fact.key === WORN_GARMENT_KEY)?.value).toBe("top");
  });

  /**
   * The other side of "no structural fallback": a MANDATORY fact whose value no
   * renderer can word is reported, not quietly dropped and not flattened, so a
   * lane compiled with `refuseOnMissingRequired` refuses before provider spend.
   */
  it("reports a mandatory wardrobe fact no renderer can word", () => {
    const broken = garmentFeatures().map((feature) =>
      feature.key === WORN_GARMENT_KEY ? { ...feature, value: {} } : feature,
    );
    const slices = adapterSlices(digestOf([...broken, ageAnchorFeature()]));
    expect(slices.subjects[0]?.facts.some((fact) => fact.key === WORN_GARMENT_KEY)).toBe(false);
    expect(slices.suppressions).toContainEqual({
      key: WORN_GARMENT_KEY,
      owner: IMAGE_SUBJECT_PROJECTION_OWNER,
      reason: IMAGE_CHARACTER_VALUE_UNREADABLE,
    });
    expect(slices.subjects[0]?.missingRequired).toContain(WORN_GARMENT_KEY);
  });

  /**
   * D2: the slice carries the pronoun set its `identity.gender` implies, so a
   * prose dialect can introduce the subject once instead of writing a real
   * person's name into 28 sentences beside their own identity reference. No
   * gender, no field — a dialect then names them or points at the reference,
   * and never guesses.
   */
  it("carries the pronoun set the subject's gender implies, and none without one", () => {
    const digest = characterDigest([ageAnchorFeature()]);
    expect(adapterSlices(digest).subjects[0]?.pronouns).toBe("she_her");

    const genderless = adapterSlices(digest, {
      attributes: completeFixtureAttributes([...crookedNoseAttributes(), ADULT_AGE_VALUE]).filter(
        (attribute) => attribute.id !== "identity.gender",
      ),
    }).subjects[0];
    expect(genderless?.pronouns).toBeUndefined();
  });
});

describe("standaloneCharacterReadToken", () => {
  /**
   * The `entityReadToken` core (stability, revision movement) is owned by
   * `entity-digest.test.ts`; what this wrapper adds — and what a defect here
   * silently loses — is the EXTRA owners. A token minted from the character row
   * alone would let a wardrobe or identity-pack edit reuse the old token, so a
   * retry quietly renders the new outfit under the old composition's name.
   */
  it("moves when any contributing owner moves, not just the character row", () => {
    const base = { characterId: "chr_1", revision: "2026-08-21T00:00:00.000Z" };
    const pack = { owner: "identity_pack", entityId: "pack_1", revision: "r1" };
    const worn = { owner: "item.library", entityId: "itm_1", revision: "r1" };
    const token = standaloneCharacterReadToken({ ...base, extraRevisions: [pack, worn] });
    expect(standaloneCharacterReadToken({ ...base, extraRevisions: [worn, pack] })).toBe(token); // sorted, order-free
    expect(standaloneCharacterReadToken({ ...base, extraRevisions: [pack, { ...worn, revision: "r2" }] })).not.toBe(
      token,
    );
    expect(standaloneCharacterReadToken(base)).not.toBe(token);
    expect(standaloneCharacterReadToken({ ...base, revision: "2026-08-22T00:00:00.000Z" })).not.toBe(
      standaloneCharacterReadToken(base),
    );
  });
});
