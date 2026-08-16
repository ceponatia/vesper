import { z } from "zod";
import { APPEARANCE_ANATOMY_PRIORS } from "../appearance-features";
import { toUnitInterval } from "../affordances/core";
import { FEATURE_GROUPS } from "../body/locations";
import { garmentLocusSchema } from "../items/garment-instance";
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
];
