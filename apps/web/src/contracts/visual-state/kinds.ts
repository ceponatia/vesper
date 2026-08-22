import { z } from "zod";
import { APPEARANCE_ANATOMY_PRIORS } from "../appearance-features";
import { contactActionKinds, contactMotionBands, contactSurfaceSides } from "../affordances/contact";
import { affordanceIntensityBands, toUnitInterval } from "../affordances/core";
import {
  SCENE_MAX_SUPPORT_RELATIONS,
  sceneBodyZones,
  sceneFacings,
  scenePostures,
  sceneSupportKinds,
  sceneSupportRoles,
} from "../affordances/scene";
import { FEATURE_GROUPS } from "../body/locations";
import { conditionSeveritySchema } from "../conditions/condition";
import { bodySurfaceMarkBands, bodySurfaceMarkKinds } from "../state/body-surface";
import {
  garmentDamageKinds,
  garmentDepositKinds,
  garmentDisplacementKinds,
  garmentLocusSchema,
  garmentTuckStates,
} from "../items/garment-instance";
import { garmentDepositFreshnessBands } from "../items/garment-condition";
import { garmentDegreeBandSchema } from "../items/garment-material";
import { defineVisualStateKind, type VisualStateKindDefinition } from "./definitions";
import { visualStatePriorsFromAppearance, type VisualStateAttentionPriors } from "./priors";

/**
 * The visual-state kind catalog — one file, data only.
 *
 * The first release adapts EXISTING truth before inventing vocabulary, so the
 * catalog opens with the three kinds the truth-level appearance projection
 * produces, then adds the identity and presentation owners slice 2 reads:
 * species feature groups, garment and item loci, and the five non-item
 * presentation choices. Body-surface, condition and scene kinds join here as
 * their adapters land; each is a data edit in this file, not a schema
 * migration.
 *
 * Vocabularies here are CLOSED enums, never free text. A presentation choice a
 * model can phrase however it likes is exactly the prose-as-truth the plan
 * forbids, and an open string would make two identical looks fingerprint
 * differently.
 */

/**
 * The value of an adapted appearance feature IS the upstream canonical
 * fingerprint.
 *
 * `projectAppearanceTruth` keeps a canonical-JSON fingerprint and a semantic-tag
 * list, not the parsed source value — so adapting cannot conjure a richer value,
 * and inventing one would be exactly the "second truth store" the plan forbids.
 * Natively projected kinds from later slices carry structured values.
 */
const adaptedAppearanceValueSchema = z.string().min(1);

/** A canonical attribute the appearance recognition catalog treats as a feature. */
export const VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID = "appearance.attribute";
/** An authored or event-acquired located mark — a freckle cluster, a scar. */
export const VISUAL_STATE_APPEARANCE_LOCATED_FACT_KIND_ID = "appearance.located_fact";
/** A departure from the baseline body — absent, altered, or prosthetic. */
export const VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID = "appearance.anatomy";

/**
 * CALIBRATION for the two non-topology adapter kinds. These are DEFAULTS only:
 * an adapted record carries the priors its own appearance kind authored, and the
 * compatibility adapter keeps those. They matter for a feature whose upstream
 * priors are unusable, and as the shape a reviewer reads first.
 */
const ADAPTED_APPEARANCE_DEFAULT_PRIORS: VisualStateAttentionPriors = {
  baseUniqueness: toUnitInterval(5_500),
  baseImportance: toUnitInterval(4_500),
  minimumDetailTier: 2,
};

/**
 * Topology is the one adapted kind that is MANDATORY for a render.
 *
 * A missing digit, a prosthetic, or an intentionally unusual body is both the
 * rarest thing the projection emits and the thing an image quality prompt is
 * most likely to "correct" on its own. Marking it mandatory is what stops
 * salience from ever trading it away for a prettier optional detail
 * (spec invariant 7), and it is a requirement flag, not a score.
 */
const ADAPTED_ANATOMY_PRIORS: VisualStateAttentionPriors = {
  ...visualStatePriorsFromAppearance(APPEARANCE_ANATOMY_PRIORS),
  mandatoryForIdentity: true,
  mandatoryForContinuity: true,
};

// ---------------------------------------------------------------------------
// Species feature groups (identity)
// ---------------------------------------------------------------------------

/** Wings, horns, a tail — a static additive group, never evented anatomy. */
export const VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID = "species.feature_group";

export const visualStateSpeciesFeatureGroupValueSchema = z
  .object({ group: z.enum(FEATURE_GROUPS) })
  .strict();

export type VisualStateSpeciesFeatureGroupValue = z.infer<typeof visualStateSpeciesFeatureGroupValueSchema>;

/**
 * CALIBRATION. An intentional appendage is the single most identity-laden thing
 * this projection can emit and the thing an image quality prompt is most likely
 * to "correct" away, so it sits above topology on both axes and is mandatory on
 * both counts. Tier 1: wings read from a silhouette, unlike a missing finger.
 */
const SPECIES_FEATURE_GROUP_PRIORS: VisualStateAttentionPriors = {
  baseUniqueness: toUnitInterval(8_500),
  baseImportance: toUnitInterval(8_000),
  minimumDetailTier: 1,
  mandatoryForIdentity: true,
  mandatoryForContinuity: true,
};

// ---------------------------------------------------------------------------
// Wardrobe (presentation)
// ---------------------------------------------------------------------------

/** Ordinary clothing: what the piece is and where it currently sits. */
export const VISUAL_STATE_WARDROBE_GARMENT_KIND_ID = "wardrobe.garment";
/** Item-backed presentation — jewelry, eyewear, headwear (plan §First-release source map). */
export const VISUAL_STATE_WARDROBE_ITEM_KIND_ID = "wardrobe.item";

/**
 * A garment's identity and locus, and nothing else.
 *
 * Closure, roll, tuck, displacement, wetness, deposits and damage are slice 3's
 * — they are the garment's CURRENT state, they belong on the current layer, and
 * the wardrobe owner already fingerprints them
 * (`garment-digest.ts:garmentLookFingerprint`). What is here is what a garment
 * IS and WHERE it is, which is the presentation fact.
 */
export const visualStateWardrobeValueSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    locus: garmentLocusSchema,
    /** Library provenance, when the instance has any. */
    definitionId: z.string().trim().min(1).max(64).optional(),
    /** The accessory vocabulary member ("earring", "glasses") — prompt-bearing upstream. */
    subtypeId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type VisualStateWardrobeValue = z.infer<typeof visualStateWardrobeValueSchema>;

/**
 * CALIBRATION. Wardrobe is LOW uniqueness and HIGH importance — nobody is
 * recognized by today's shirt, and no render may quietly change it. The
 * mandatory-for-continuity flag is set per FEATURE rather than here, because it
 * is true of a worn or carried piece and false of a jacket left on a chair.
 */
const WARDROBE_PRIORS: VisualStateAttentionPriors = {
  baseUniqueness: toUnitInterval(3_500),
  baseImportance: toUnitInterval(6_000),
  minimumDetailTier: 1,
};

/** An accessory is smaller and rarer than a garment: more distinctive, less load-bearing. */
const WARDROBE_ITEM_PRIORS: VisualStateAttentionPriors = {
  baseUniqueness: toUnitInterval(5_000),
  baseImportance: toUnitInterval(4_500),
  minimumDetailTier: 2,
};

// ---------------------------------------------------------------------------
// Non-item presentation
// ---------------------------------------------------------------------------

export const VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID = "presentation.hairstyle";
export const VISUAL_STATE_PRESENTATION_MAKEUP_KIND_ID = "presentation.makeup";
export const VISUAL_STATE_PRESENTATION_GROOMING_KIND_ID = "presentation.grooming";
export const VISUAL_STATE_PRESENTATION_NAIL_FINISH_KIND_ID = "presentation.nail_finish";
export const VISUAL_STATE_PRESENTATION_COSMETIC_MARK_KIND_ID = "presentation.cosmetic_mark";

/** How hair is currently worn — the arrangement, never its colour or length. */
export const presentationHairArrangements = [
  "loose",
  "tied_back",
  "ponytail",
  "braided",
  "bun",
  "updo",
  "pinned",
  "wrapped",
] as const;
export type PresentationHairArrangement = (typeof presentationHairArrangements)[number];

/**
 * What has happened TO a deliberate choice since it was made. It rides on the
 * presentation entry rather than becoming a located fact of its own, because
 * smudged makeup is a disturbed presentation, not a permanent facial mark
 * (plan §Keep four layers separate).
 */
export const presentationDisturbances = ["smudged", "tousled", "running", "flaked", "displaced"] as const;
export type PresentationDisturbance = (typeof presentationDisturbances)[number];

export const presentationMakeupStyles = ["bare", "natural", "defined", "dramatic", "theatrical"] as const;
export type PresentationMakeupStyle = (typeof presentationMakeupStyles)[number];

/**
 * Deliberate grooming of one area RIGHT NOW. Distinct from the canonical
 * `presentation.grooming` attribute, which is the character's habitual standard
 * and stays where it is: one is "she keeps herself immaculate", the other is
 * "the beard is trimmed today". Neither is derived from the other.
 */
export const presentationGroomingAreas = ["facial_hair", "body_hair", "brows", "hands"] as const;
export type PresentationGroomingArea = (typeof presentationGroomingAreas)[number];

export const presentationGroomingStates = ["bare", "trimmed", "shaped", "natural", "overgrown"] as const;
export type PresentationGroomingState = (typeof presentationGroomingStates)[number];

export const presentationNailFinishes = [
  "bare",
  "buffed",
  "clear",
  "polished",
  "painted",
  "french",
  "sculpted",
] as const;
export type PresentationNailFinish = (typeof presentationNailFinishes)[number];

export const presentationCosmeticMarks = [
  "bindi",
  "face_paint",
  "body_paint",
  "glitter",
  "temporary_tattoo",
  "decal",
] as const;
export type PresentationCosmeticMark = (typeof presentationCosmeticMarks)[number];

export const visualStateHairstyleValueSchema = z
  .object({
    arrangement: z.enum(presentationHairArrangements),
    disturbance: z.enum(presentationDisturbances).optional(),
  })
  .strict();

export const visualStateMakeupValueSchema = z
  .object({
    style: z.enum(presentationMakeupStyles),
    disturbance: z.enum(presentationDisturbances).optional(),
  })
  .strict();

export const visualStateGroomingValueSchema = z
  .object({
    area: z.enum(presentationGroomingAreas),
    state: z.enum(presentationGroomingStates),
  })
  .strict();

export const visualStateNailFinishValueSchema = z
  .object({ finish: z.enum(presentationNailFinishes) })
  .strict();

export const visualStateCosmeticMarkValueSchema = z
  .object({
    mark: z.enum(presentationCosmeticMarks),
    disturbance: z.enum(presentationDisturbances).optional(),
  })
  .strict();

/**
 * CALIBRATION for the non-item choices. All five are `presentation` stability,
 * so none of them can earn a recognition floor however distinctive they look —
 * a hairstyle is something a person chose this morning, not something they are.
 */
function presentationPriors(
  baseUniqueness: number,
  baseImportance: number,
  minimumDetailTier: 1 | 2 | 3,
): VisualStateAttentionPriors {
  return {
    baseUniqueness: toUnitInterval(baseUniqueness),
    baseImportance: toUnitInterval(baseImportance),
    minimumDetailTier,
  };
}

// ---------------------------------------------------------------------------
// Current state (slice 3)
// ---------------------------------------------------------------------------

/** Standing wetness on skin or hair — the body-surface owner's one channel. */
export const VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID = "body_surface.wetness";
/** A committed temporary contact mark on skin — the body-surface owner's marks module. */
export const VISUAL_STATE_BODY_SURFACE_MARK_KIND_ID = "body_surface.contact_mark";
/** One garment condition channel off its neutral band — wet, soiled, rumpled, worn. */
export const VISUAL_STATE_GARMENT_CONDITION_KIND_ID = "garment.condition";
/** One garment part's non-neutral arrangement — open, rolled, tucked, displaced. */
export const VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID = "garment.presentation";
/** A located contaminant on a garment — mud, blood, dust, paint. */
export const VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID = "garment.deposit";
/** A located damage mark on a garment — a tear, a scuff, a burn. */
export const VISUAL_STATE_GARMENT_DAMAGE_KIND_ID = "garment.damage";
/** A DERIVED wet-material effect — beading, clinging, going translucent. */
export const VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID = "garment.material_effect";
/** An active condition on the subject as a whole — blindfolded, drunk, bound. */
export const VISUAL_STATE_CONDITION_ACTIVE_KIND_ID = "condition.active";
/** A supported physical-affordance observation — strands clumping, hair stirring. */
export const VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID = "affordance.observation";

/**
 * The non-dry wetness bands, shared with the garment ladder BY NAME so wet hair
 * and a wet shirt can never band differently for the same fixed-point level.
 * `dry` is deliberately absent: a dry surface projects NOTHING — absence is the
 * body-surface owner's own default, and a "dry" feature would be a fact with
 * nothing to say. The adapter derives the band through the garment ladder
 * (`garmentConditionBand`), so these members are pinned by test against it.
 */
export const bodySurfaceWetnessBands = ["damp", "wet", "soaked"] as const;
export type BodySurfaceWetnessBand = (typeof bodySurfaceWetnessBands)[number];

export const visualStateBodySurfaceWetnessValueSchema = z
  .object({ band: z.enum(bodySurfaceWetnessBands) })
  .strict();
export type VisualStateBodySurfaceWetnessValue = z.infer<typeof visualStateBodySurfaceWetnessValueSchema>;

/**
 * One location's strongest current contact mark, in the body-surface owner's
 * own vocabularies (`bodySurfaceMarkKinds` / `bodySurfaceMarkBands`) — reused
 * by name for the wetness-band reason: the owner that commits the mark is the
 * owner that says what kinds and bands exist, and a second list here would
 * drift. A fully faded mark projects NOTHING; absence is the owner's default.
 */
export const visualStateBodySurfaceMarkValueSchema = z
  .object({ kind: z.enum(bodySurfaceMarkKinds), band: z.enum(bodySurfaceMarkBands) })
  .strict();
export type VisualStateBodySurfaceMarkValue = z.infer<typeof visualStateBodySurfaceMarkValueSchema>;

/**
 * One condition channel's NON-NEUTRAL bands, per channel. Each list is its
 * garment ladder minus the neutral band (`GARMENT_CONDITION_NEUTRAL_BANDS`) —
 * a neutral channel is silence, not a feature — and drift against the upstream
 * ladders is pinned by test rather than by construction, because a zod enum
 * needs a literal tuple.
 */
export const visualStateGarmentConditionValueSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("wetness"), band: z.enum(["damp", "wet", "soaked"]) }).strict(),
  z.object({ channel: z.literal("cleanliness"), band: z.enum(["filthy", "soiled", "marked", "clean"]) }).strict(),
  z.object({ channel: z.literal("crease_load"), band: z.enum(["creased", "rumpled", "crumpled"]) }).strict(),
  z.object({ channel: z.literal("wear"), band: z.enum(["worn", "shabby", "threadbare"]) }).strict(),
]);
export type VisualStateGarmentConditionValue = z.infer<typeof visualStateGarmentConditionValueSchema>;

/**
 * One part's structural presentation, in the digest's own bands
 * (`garmentStructuralFacts`): closure loses its neutral `fastened`, roll its
 * neutral `down`, displacement its neutral `seated`. Tuck keeps ALL THREE
 * readings on purpose — the digest rules that tuck has no neutral (a hem is
 * always out, half, or in, and which one is a fact the narrator must not
 * contradict), and this projection follows that ruling rather than re-judging.
 */
export const visualStateGarmentPresentationValueSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("closure"), band: z.enum(["partly_open", "open"]) }).strict(),
  z.object({ channel: z.literal("roll"), band: z.literal("rolled") }).strict(),
  z.object({ channel: z.literal("tuck"), band: z.enum(garmentTuckStates) }).strict(),
  z.object({ channel: z.literal("displacement"), band: z.enum(garmentDisplacementKinds) }).strict(),
]);
export type VisualStateGarmentPresentationValue = z.infer<typeof visualStateGarmentPresentationValueSchema>;

export const visualStateGarmentDepositValueSchema = z
  .object({
    deposit: z.enum(garmentDepositKinds),
    intensity: garmentDegreeBandSchema,
    /** Freshness drives PHRASING (wet mud vs dried mud) — a visual change, so it fingerprints. */
    freshness: z.enum(garmentDepositFreshnessBands),
    /** Sorted part ids carrying it; empty ⇒ the whole garment. */
    parts: z.array(z.string().min(1).max(64)).max(16),
  })
  .strict();
export type VisualStateGarmentDepositValue = z.infer<typeof visualStateGarmentDepositValueSchema>;

export const visualStateGarmentDamageValueSchema = z
  .object({ damage: z.enum(garmentDamageKinds), severity: garmentDegreeBandSchema })
  .strict();
export type VisualStateGarmentDamageValue = z.infer<typeof visualStateGarmentDamageValueSchema>;

/**
 * The derived wet-material effects, and the whole vocabulary of them. Each is
 * gated on a material-profile coefficient plus a wetness band (the calibration
 * lives in `garment-state.ts`), and each is DERIVED: recomputed per cut, never
 * persisted, carrying a `derived_from` edge to the wetness fact it rides on.
 */
export const garmentMaterialEffects = ["beading", "clinging", "translucent"] as const;
export type GarmentMaterialEffect = (typeof garmentMaterialEffects)[number];

export const visualStateGarmentMaterialEffectValueSchema = z
  .object({ effect: z.enum(garmentMaterialEffects) })
  .strict();
export type VisualStateGarmentMaterialEffectValue = z.infer<typeof visualStateGarmentMaterialEffectValueSchema>;

/**
 * An active condition, by its CANONICAL KEY — the normalized label every
 * condition-vocabulary table in the app matches on (`conditionKey`). Not free
 * prose: it is the condition system's own committed identity, and the one
 * value that can name a condition without inventing a second vocabulary. The
 * cap matches the owner's ordinary labels; a longer one fails the schema and
 * degrades to silence plus a diagnostic.
 */
export const visualStateActiveConditionValueSchema = z
  .object({
    condition: z.string().min(1).max(60),
    severity: conditionSeveritySchema.optional(),
  })
  .strict();
export type VisualStateActiveConditionValue = z.infer<typeof visualStateActiveConditionValueSchema>;

const AFFORDANCE_PHENOMENON_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export const visualStateObservationValueSchema = z
  .object({
    /** `<domain>.<snake_case>` — the affordance core's own phenomenon id shape. */
    phenomenon: z.string().regex(AFFORDANCE_PHENOMENON_ID_PATTERN),
    band: z.enum(affordanceIntensityBands),
    /** The body location an adhesion-style observation reaches toward. */
    target: z.string().min(1).max(64).optional(),
  })
  .strict();
export type VisualStateObservationValue = z.infer<typeof visualStateObservationValueSchema>;

/**
 * CALIBRATION for the current-state kinds. None is recognition-eligible except
 * body-surface wetness: damp hair is something an observer registers and
 * change-detects (the plan's opening example), while a garment's own state is
 * continuity that changes every scene — spending observer memory rows on it
 * would evict facts about the person. None is mandatory: current state is
 * always optional detail, and invariant 7 protects identity and wardrobe
 * truth, not dampness.
 */
const BODY_SURFACE_WETNESS_PRIORS = presentationPriors(3_500, 5_500, 2);
// A fresh mark is rarer than wetness and reads as recent contact — slightly
// more unique, comparably important, gone within the story hour either way.
const BODY_SURFACE_MARK_PRIORS = presentationPriors(5_000, 5_000, 2);
const GARMENT_CONDITION_PRIORS = presentationPriors(3_000, 5_000, 2);
const GARMENT_PRESENTATION_CHANNEL_PRIORS = presentationPriors(3_500, 5_500, 2);
const GARMENT_DEPOSIT_PRIORS = presentationPriors(5_500, 5_000, 2);
const GARMENT_DAMAGE_PRIORS = presentationPriors(5_500, 5_500, 2);
const GARMENT_MATERIAL_EFFECT_PRIORS = presentationPriors(4_500, 3_500, 2);
const CONDITION_ACTIVE_PRIORS = presentationPriors(4_000, 6_000, 2);
const AFFORDANCE_OBSERVATION_PRIORS = presentationPriors(5_000, 4_000, 2);
// Body language (slice 4)
// ---------------------------------------------------------------------------

export const VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID = "body_language.posture";
export const VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID = "body_language.support";
export const VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID = "body_language.facing";
export const VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID = "body_language.hand_occupation";
export const VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID = "body_language.motion";
/** The whole committed contact relation — who touches whom, surface to surface. */
export const VISUAL_STATE_BODY_LANGUAGE_CONTACT_RELATION_KIND_ID = "body_language.contact_relation";

/**
 * Every value vocabulary below is REUSED from the owner that proves the fact —
 * the scene / body-relations layer and the contact lifecycle — never restated.
 * A second posture list here would drift from the one the intents write, and
 * the plan's rule is that this projection owns no truth.
 */
export const visualStateBodyLanguagePostureValueSchema = z
  .object({ posture: z.enum(scenePostures) })
  .strict();

export type VisualStateBodyLanguagePostureValue = z.infer<typeof visualStateBodyLanguagePostureValueSchema>;

/**
 * The support SET as one value, mirroring the owner: the scene stores a
 * participant's support as one fact whose value is the whole relation list, so
 * one feature carries the list and its fingerprint moves when the set does.
 * Anchor ids are the scene owner's own identifiers, carried verbatim;
 * `surfaceKind` is resolved from the scene's surface table when the anchor
 * names a surface the scene actually holds.
 */
export const visualStateBodyLanguageSupportValueSchema = z
  .object({
    relations: z
      .array(
        z
          .object({
            role: z.enum(sceneSupportRoles),
            anchor: z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("surface"),
                  supportId: z.string().min(1),
                  surfaceKind: z.enum(sceneSupportKinds).optional(),
                })
                .strict(),
              z.object({ kind: z.literal("participant"), subjectId: z.string().min(1) }).strict(),
            ]),
            loadZones: z.array(z.enum(sceneBodyZones)).max(sceneBodyZones.length),
          })
          .strict(),
      )
      .min(1)
      .max(SCENE_MAX_SUPPORT_RELATIONS),
  })
  .strict();

export type VisualStateBodyLanguageSupportValue = z.infer<typeof visualStateBodyLanguageSupportValueSchema>;

/** Directional, like the owner's fact: `towardSubjectId` is the scene-side id, verbatim. */
export const visualStateBodyLanguageFacingValueSchema = z
  .object({
    facing: z.enum(sceneFacings),
    towardSubjectId: z.string().min(1),
  })
  .strict();

export type VisualStateBodyLanguageFacingValue = z.infer<typeof visualStateBodyLanguageFacingValueSchema>;

/** Which hand, when the committed contact states a side; `unspecified` when it does not. */
export const visualStateHandSides = ["left", "right", "unspecified"] as const;
export type VisualStateHandSide = (typeof visualStateHandSides)[number];

/**
 * DELIBERATELY minimal: the visual fact is that the hand is engaged, and the
 * value says no more. What engages it is the contact's own business — the
 * action kinds ride the feature's semantic tags and evidence, and the gesture
 * itself is the `body_language.motion` kind beside this one. A value carrying
 * the occupying contacts would change fingerprint every time a touch was
 * re-asserted, making an unmoved hand read as a change candidate.
 */
export const visualStateBodyLanguageHandOccupationValueSchema = z
  .object({ side: z.enum(visualStateHandSides) })
  .strict();

export type VisualStateBodyLanguageHandOccupationValue = z.infer<
  typeof visualStateBodyLanguageHandOccupationValueSchema
>;

/** A committed contact's motion, as committed: the band and the domain's own path tokens. */
export const visualStateBodyLanguageMotionValueSchema = z
  .object({
    band: z.enum(contactMotionBands),
    pathDetailIds: z.array(z.string().trim().min(1).max(64)).min(1).max(16).optional(),
  })
  .strict();

export type VisualStateBodyLanguageMotionValue = z.infer<typeof visualStateBodyLanguageMotionValueSchema>;

/**
 * One end of a committed contact, in the contact owner's own vocabulary: a
 * registry body location, the owner's side, and the domain's opaque sub-surface
 * token carried verbatim.
 */
const visualStateContactEndLocusSchema = z
  .object({
    bodyLocationId: z.string().min(1).max(64),
    side: z.enum(contactSurfaceSides).optional(),
    detail: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * The first-class contact relation, sourced from `CommittedContactRead`
 * (romantic-contact-affordances.spec.effects.md §5): both participants, both
 * loci, the action kind as relation identity, and the committed material
 * summary. STRICT because the must-not list is load-bearing — permission state,
 * pressure, motion, emotion, and rejected alternatives may never ride this
 * value. Motion already has its own kind beside it; pressure is tactile, not
 * visual; permission is disclosure. The contact id is the feature's relation
 * locus and source ref, not a value field, matching the motion kind.
 */
export const visualStateBodyLanguageContactRelationValueSchema = z
  .object({
    actionKind: z.enum(contactActionKinds),
    source: z
      .object({ subjectId: z.string().min(1), locus: visualStateContactEndLocusSchema })
      .strict(),
    target: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("body"), subjectId: z.string().min(1), locus: visualStateContactEndLocusSchema })
        .strict(),
      z
        .object({ kind: z.literal("object"), entityId: z.string().min(1), surfaceId: z.string().min(1) })
        .strict(),
    ]),
    /**
     * The committed transmission's visually relevant half, verbatim: whether
     * skin meets skin, and which interposed layers the wardrobe/material owner
     * named (ids in source→target order — order is identity). A contact only
     * commits over a SUPPORTED material read, so this is owner-backed truth,
     * never a guess.
     */
    materialBetween: z
      .object({
        directSkinContact: z.boolean(),
        layerIds: z.array(z.string().min(1)).max(16),
      })
      .strict(),
  })
  .strict();

export type VisualStateBodyLanguageContactRelationValue = z.infer<
  typeof visualStateBodyLanguageContactRelationValueSchema
>;

/**
 * CALIBRATION for the five body-language kinds. All are `instantaneous` — true
 * for exactly one committed cut — so none may be recognition-eligible
 * (`defineVisualStateKind` enforces it) and none can ever earn a recognition
 * floor. Nobody is REMEMBERED by how they were sitting.
 *
 * None is mandatory. The plan's mandatory set is identity, morphology, wardrobe
 * truth, subject count, requested action and authored absence; staging already
 * reaches the image lane through the scene-committed camera read, and marking
 * posture mandatory here would force a full-body fact into a face portrait.
 */
function bodyLanguagePriors(
  baseUniqueness: number,
  baseImportance: number,
  minimumDetailTier: 1 | 2 | 3,
): VisualStateAttentionPriors {
  return {
    baseUniqueness: toUnitInterval(baseUniqueness),
    baseImportance: toUnitInterval(baseImportance),
    minimumDetailTier,
  };
}

export const visualStateKindDefinitions: readonly VisualStateKindDefinition[] = [
  defineVisualStateKind({
    id: VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID,
    layer: "identity",
    valueSchema: adaptedAppearanceValueSchema,
    allowedLoci: ["body"],
    stability: "inherent",
    repeatFamily: "appearance_attribute",
    recognitionEligible: true,
    narratorEligible: true,
    imageEligible: true,
    priors: ADAPTED_APPEARANCE_DEFAULT_PRIORS,
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_APPEARANCE_LOCATED_FACT_KIND_ID,
    layer: "identity",
    valueSchema: adaptedAppearanceValueSchema,
    allowedLoci: ["body"],
    stability: "persistent",
    repeatFamily: "appearance_mark",
    recognitionEligible: true,
    narratorEligible: true,
    imageEligible: true,
    priors: ADAPTED_APPEARANCE_DEFAULT_PRIORS,
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID,
    layer: "identity",
    valueSchema: adaptedAppearanceValueSchema,
    allowedLoci: ["body"],
    stability: "persistent",
    repeatFamily: "anatomy",
    recognitionEligible: true,
    narratorEligible: true,
    imageEligible: true,
    priors: ADAPTED_ANATOMY_PRIORS,
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
    layer: "identity",
    valueSchema: visualStateSpeciesFeatureGroupValueSchema,
    allowedLoci: ["body"],
    stability: "inherent",
    repeatFamily: "species_feature",
    recognitionEligible: true,
    narratorEligible: true,
    imageEligible: true,
    priors: SPECIES_FEATURE_GROUP_PRIORS,
  }),
  // Wardrobe hangs at an `item` locus, not a body one: a garment is a thing with
  // its own identity that MOVES — onto a body, into a hand, over a chair — and
  // filing it under the body location it currently covers would lose it the
  // moment it came off. What it covers is a composition edge, not its home.
  defineVisualStateKind({
    id: VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
    layer: "presentation",
    valueSchema: visualStateWardrobeValueSchema,
    allowedLoci: ["item"],
    stability: "presentation",
    repeatFamily: "wardrobe_garment",
    // Nobody is recognized by today's shirt. Clothing is continuity, not
    // identity, and letting it into recognition candidates would spend observer
    // memory rows on facts that change every scene.
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: WARDROBE_PRIORS,
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_WARDROBE_ITEM_KIND_ID,
    layer: "presentation",
    valueSchema: visualStateWardrobeValueSchema,
    allowedLoci: ["item"],
    stability: "presentation",
    repeatFamily: "wardrobe_item",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: WARDROBE_ITEM_PRIORS,
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_PRESENTATION_HAIRSTYLE_KIND_ID,
    layer: "presentation",
    valueSchema: visualStateHairstyleValueSchema,
    allowedLoci: ["body"],
    stability: "presentation",
    repeatFamily: "presentation_hair",
    recognitionEligible: true,
    narratorEligible: true,
    imageEligible: true,
    priors: presentationPriors(4_000, 5_500, 1),
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_PRESENTATION_MAKEUP_KIND_ID,
    layer: "presentation",
    valueSchema: visualStateMakeupValueSchema,
    allowedLoci: ["body"],
    stability: "presentation",
    repeatFamily: "presentation_makeup",
    recognitionEligible: true,
    narratorEligible: true,
    imageEligible: true,
    priors: presentationPriors(3_500, 4_500, 2),
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_PRESENTATION_GROOMING_KIND_ID,
    layer: "presentation",
    valueSchema: visualStateGroomingValueSchema,
    allowedLoci: ["body"],
    stability: "presentation",
    repeatFamily: "presentation_grooming",
    recognitionEligible: true,
    narratorEligible: true,
    imageEligible: true,
    priors: presentationPriors(3_000, 3_500, 2),
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_PRESENTATION_NAIL_FINISH_KIND_ID,
    layer: "presentation",
    valueSchema: visualStateNailFinishValueSchema,
    allowedLoci: ["body"],
    stability: "presentation",
    repeatFamily: "presentation_nails",
    recognitionEligible: true,
    narratorEligible: true,
    imageEligible: true,
    priors: presentationPriors(3_000, 2_500, 3),
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_PRESENTATION_COSMETIC_MARK_KIND_ID,
    layer: "presentation",
    valueSchema: visualStateCosmeticMarkValueSchema,
    allowedLoci: ["body"],
    stability: "presentation",
    repeatFamily: "presentation_cosmetic_mark",
    recognitionEligible: true,
    narratorEligible: true,
    imageEligible: true,
    priors: presentationPriors(6_000, 4_500, 2),
  }),
  // --- Current state (slice 3) -------------------------------------------------
  defineVisualStateKind({
    id: VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID,
    layer: "current",
    valueSchema: visualStateBodySurfaceWetnessValueSchema,
    allowedLoci: ["body"],
    stability: "transient",
    repeatFamily: "body_surface_wetness",
    recognitionEligible: true,
    narratorEligible: true,
    imageEligible: true,
    priors: BODY_SURFACE_WETNESS_PRIORS,
  }),
  // Committed contact marks, read from the body-surface owner like wetness
  // beside it. NOT recognition-eligible — a mark fades inside the story hour,
  // so "seen before" bookkeeping would outlive the fact. NOT image-eligible for
  // contact_relation's exact reason: the cast-1 scene digest consumes image
  // selection live and ungated, and admitting a new kind there is a deliberate
  // enable once its clause rendering exists, not a registration side effect.
  defineVisualStateKind({
    id: VISUAL_STATE_BODY_SURFACE_MARK_KIND_ID,
    layer: "current",
    valueSchema: visualStateBodySurfaceMarkValueSchema,
    allowedLoci: ["body"],
    stability: "transient",
    repeatFamily: "body_surface_contact_mark",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: false,
    priors: BODY_SURFACE_MARK_PRIORS,
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_GARMENT_CONDITION_KIND_ID,
    layer: "current",
    valueSchema: visualStateGarmentConditionValueSchema,
    // `item` for the whole garment's worst reading, `garment_part` for a region
    // that reads differently from it — a wet hem on a dry shirt is two features.
    allowedLoci: ["item", "garment_part"],
    stability: "transient",
    repeatFamily: "garment_condition",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: GARMENT_CONDITION_PRIORS,
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID,
    layer: "current",
    valueSchema: visualStateGarmentPresentationValueSchema,
    allowedLoci: ["garment_part"],
    // A rolled sleeve is a deliberate, currently maintained arrangement — the
    // stability is `presentation` even though the LAYER is current state: the
    // plan's layers separate what a fact is about, stability how long it holds.
    stability: "presentation",
    repeatFamily: "garment_presentation",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: GARMENT_PRESENTATION_CHANNEL_PRIORS,
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_GARMENT_DEPOSIT_KIND_ID,
    layer: "current",
    valueSchema: visualStateGarmentDepositValueSchema,
    // The garment, not a part: a deposit may span several parts (or the whole
    // garment), so the parts ride the value and the locus stays the one thing
    // every deposit has — the garment it is on.
    allowedLoci: ["item"],
    stability: "transient",
    repeatFamily: "garment_deposit",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: GARMENT_DEPOSIT_PRIORS,
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_GARMENT_DAMAGE_KIND_ID,
    layer: "current",
    valueSchema: visualStateGarmentDamageValueSchema,
    allowedLoci: ["garment_part"],
    // A tear does not decay and only a repair removes it.
    stability: "persistent",
    repeatFamily: "garment_damage",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: GARMENT_DAMAGE_PRIORS,
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_GARMENT_MATERIAL_EFFECT_KIND_ID,
    layer: "current",
    valueSchema: visualStateGarmentMaterialEffectValueSchema,
    allowedLoci: ["item"],
    stability: "transient",
    repeatFamily: "garment_material_effect",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: GARMENT_MATERIAL_EFFECT_PRIORS,
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_CONDITION_ACTIVE_KIND_ID,
    layer: "current",
    valueSchema: visualStateActiveConditionValueSchema,
    // The subject as a whole. The condition owner has no body locus (a
    // condition cannot be placed — visual-state.audit.md finding 11), and the
    // `subject` locus is the honest home rather than a guessed body location.
    allowedLoci: ["subject"],
    stability: "transient",
    repeatFamily: "condition_active",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: CONDITION_ACTIVE_PRIORS,
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID,
    layer: "current",
    valueSchema: visualStateObservationValueSchema,
    allowedLoci: ["body"],
    // True for exactly one committed cut, so it can never be recognition
    // eligible — `defineVisualStateKind` enforces the pairing.
    stability: "instantaneous",
    repeatFamily: "affordance_observation",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: AFFORDANCE_OBSERVATION_PRIORS,
  }),
  // Posture and support hang at a `subject` locus: they are whole-body facts,
  // and pinning either to one body location would claim a precision the five
  // coarse postures deliberately do not have. Tier 1 — both read from a
  // silhouette.
  defineVisualStateKind({
    id: VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
    layer: "body_language",
    valueSchema: visualStateBodyLanguagePostureValueSchema,
    allowedLoci: ["subject"],
    stability: "instantaneous",
    repeatFamily: "body_posture",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: bodyLanguagePriors(2_500, 6_500, 1),
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID,
    layer: "body_language",
    valueSchema: visualStateBodyLanguageSupportValueSchema,
    allowedLoci: ["subject"],
    stability: "instantaneous",
    repeatFamily: "body_support",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: bodyLanguagePriors(3_000, 6_000, 1),
  }),
  // Facing and motion hang at a `relation` locus — each is a fact about a pair
  // (an ordered facing pair; a contact), and the relation id is the owner's own
  // row identity.
  defineVisualStateKind({
    id: VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID,
    layer: "body_language",
    valueSchema: visualStateBodyLanguageFacingValueSchema,
    allowedLoci: ["relation"],
    stability: "instantaneous",
    repeatFamily: "body_facing",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: bodyLanguagePriors(2_000, 5_500, 1),
  }),
  // Hand occupation hangs at the `hands` body locus (with the contact's side
  // when one was committed), so coverage and framing reads about hands apply to
  // it like any other hand fact. Tier 2 — an occupied hand does not read from a
  // silhouette.
  defineVisualStateKind({
    id: VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID,
    layer: "body_language",
    valueSchema: visualStateBodyLanguageHandOccupationValueSchema,
    allowedLoci: ["body"],
    stability: "instantaneous",
    repeatFamily: "hand_occupation",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: bodyLanguagePriors(3_500, 6_000, 2),
  }),
  defineVisualStateKind({
    id: VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID,
    layer: "body_language",
    valueSchema: visualStateBodyLanguageMotionValueSchema,
    allowedLoci: ["relation"],
    stability: "instantaneous",
    repeatFamily: "contact_motion",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: true,
    priors: bodyLanguagePriors(4_000, 5_500, 2),
  }),
  // The relation locus is the contact's own id, like motion beside it. Above
  // motion on importance: "whose hand is on whom" is the relation, the gesture
  // decorates it. NOT image-eligible yet — the cast-1 scene digest consumes the
  // image selection live and ungated, and admitting a new kind there is a
  // deliberate enable once its clause rendering exists, not a registration
  // side effect; the narrator consumer is gated per chat.
  defineVisualStateKind({
    id: VISUAL_STATE_BODY_LANGUAGE_CONTACT_RELATION_KIND_ID,
    layer: "body_language",
    valueSchema: visualStateBodyLanguageContactRelationValueSchema,
    allowedLoci: ["relation"],
    stability: "instantaneous",
    repeatFamily: "contact_relation",
    recognitionEligible: false,
    narratorEligible: true,
    imageEligible: false,
    priors: bodyLanguagePriors(4_500, 6_500, 2),
  }),
];
