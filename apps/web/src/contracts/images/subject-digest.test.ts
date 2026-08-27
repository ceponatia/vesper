import { imageConcept, imageMorphologyProtectionOf, type ImageWorldFact } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { toUnitInterval } from "../affordances/core";
import { visualAttentionContextFixture, visualAttentionSnapshotFixture } from "../affordances/recognition";
import { crookedNoseAttributes, freckleClusterFact, missingFingerState, projectFixture } from "../appearance-features";
import {
  adaptProjectedAppearanceTruth,
  projectSpeciesFeatureGroups,
  projectWardrobeFeatures,
  visualStateFeatureFixture,
  visualStateGarmentFixture,
  visualStateNonHumanBody,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_FIXTURE_ACTOR,
  type VisualStateFeature,
} from "../visual-state";
import {
  imageSubjectFactNeedsSemanticValue,
  projectSubjectDigests,
  projectCameraFacts,
  standaloneCharacterReadToken,
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
 * two layers proving one claim.
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
