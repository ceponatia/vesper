import { z } from "zod";
import { defineAppearanceFeatureKind, type AppearanceFeatureKindDefinition } from "./definitions";
import { defineAppearanceRecognitionPriors } from "./priors";

/**
 * The seeded located-fact kinds — the catalog's first authoring priorities:
 * freckle/birthmark clusters, moles, one or two scar shapes with event
 * provenance.
 *
 * Vocabulary changes here are DATA edits, never schema migrations (the
 * registry-as-extension-point rule).
 *
 * CALIBRATION. Every prior below is an authored starting point on the shared
 * `0 … 10_000` fixed-point scale, not a measurement — they are meant to be
 * retuned once salience evaluation runs. The ordering is
 * the load-bearing part:
 *
 * - a scar outranks a freckle field on IMPORTANCE (it carries event
 *   provenance and usually a shared memory), while a birthmark outranks both
 *   on raw UNIQUENESS (one crescent mark is rarer than "she has freckles");
 * - a mole is the deliberate floor: real, locatable, and almost never worth
 *   mentioning — it exists to prove the low end suppresses rather than to be
 *   narrated.
 */

export const appearanceFreckleDensities = ["sparse", "moderate", "dense"] as const;
export const appearanceFreckleDensitySchema = z.enum(appearanceFreckleDensities);
export type AppearanceFreckleDensity = z.infer<typeof appearanceFreckleDensitySchema>;

export const appearanceFrecklePatterns = ["scattered", "clustered", "band"] as const;
export const appearanceFrecklePatternSchema = z.enum(appearanceFrecklePatterns);
export type AppearanceFrecklePattern = z.infer<typeof appearanceFrecklePatternSchema>;

/** Shared size bands for the mark families (birthmark, scar). */
export const appearanceMarkSizes = ["small", "medium", "large"] as const;
export const appearanceMarkSizeSchema = z.enum(appearanceMarkSizes);
export type AppearanceMarkSize = z.infer<typeof appearanceMarkSizeSchema>;

export const appearanceBirthmarkShapes = ["round", "crescent", "patch", "irregular"] as const;
export const appearanceBirthmarkShapeSchema = z.enum(appearanceBirthmarkShapes);
export type AppearanceBirthmarkShape = z.infer<typeof appearanceBirthmarkShapeSchema>;

export const appearanceMoleProminences = ["prominent", "subtle"] as const;
export const appearanceMoleProminenceSchema = z.enum(appearanceMoleProminences);
export type AppearanceMoleProminence = z.infer<typeof appearanceMoleProminenceSchema>;

export const appearanceScarShapes = ["linear", "curved", "branched"] as const;
export const appearanceScarShapeSchema = z.enum(appearanceScarShapes);
export type AppearanceScarShape = z.infer<typeof appearanceScarShapeSchema>;

export const appearanceFreckleClusterValueSchema = z.object({
  density: appearanceFreckleDensitySchema,
  pattern: appearanceFrecklePatternSchema,
});
export type AppearanceFreckleClusterValue = z.infer<typeof appearanceFreckleClusterValueSchema>;

export const appearanceBirthmarkValueSchema = z.object({
  shape: appearanceBirthmarkShapeSchema,
  size: appearanceMarkSizeSchema,
});
export type AppearanceBirthmarkValue = z.infer<typeof appearanceBirthmarkValueSchema>;

export const appearanceMoleValueSchema = z.object({
  prominence: appearanceMoleProminenceSchema,
});
export type AppearanceMoleValue = z.infer<typeof appearanceMoleValueSchema>;

export const appearanceScarValueSchema = z.object({
  shape: appearanceScarShapeSchema,
  size: appearanceMarkSizeSchema,
});
export type AppearanceScarValue = z.infer<typeof appearanceScarValueSchema>;

export const APPEARANCE_FRECKLE_CLUSTER_KIND_ID = "pigmentation.freckle_cluster";
export const APPEARANCE_BIRTHMARK_KIND_ID = "pigmentation.birthmark";
export const APPEARANCE_MOLE_KIND_ID = "pigmentation.mole";
export const APPEARANCE_SCAR_KIND_ID = "mark.scar";

/**
 * The shipped kinds. `mark.scar` is the acquired family: rows are expected to
 * carry `source: "event"` + a `sourceEventId`, and a healed wound supersedes
 * its wound-era row rather than editing it.
 */
export const appearanceFeatureKindDefinitions: readonly AppearanceFeatureKindDefinition[] = [
  defineAppearanceFeatureKind({
    id: APPEARANCE_FRECKLE_CLUSTER_KIND_ID,
    label: "Freckle cluster",
    valueSchema: appearanceFreckleClusterValueSchema,
    allowedBodyLocations: ["shoulders", "face", "chest", "back", "arms"],
    persistence: "stable",
    // Ordinary but locatable: common enough to be unremarkable on its own,
    // distinctive as part of a constellation.
    recognition: defineAppearanceRecognitionPriors({
      baseUniqueness: 3_500,
      baseImportance: 2_500,
      minimumDetailTier: 2,
      repeatFamily: "pigmentation",
    }),
    bodyAreaPath: ["surface", "freckles"],
  }),
  defineAppearanceFeatureKind({
    id: APPEARANCE_BIRTHMARK_KIND_ID,
    label: "Birthmark",
    valueSchema: appearanceBirthmarkValueSchema,
    allowedBodyLocations: ["shoulders", "chest", "back", "arms", "legs", "neck", "face"],
    persistence: "stable",
    // Rarer than a freckle field and shaped, so it identifies well; carries no
    // event weight of its own, so importance stays modest.
    recognition: defineAppearanceRecognitionPriors({
      baseUniqueness: 5_500,
      baseImportance: 3_000,
      minimumDetailTier: 2,
      repeatFamily: "pigmentation",
    }),
    bodyAreaPath: ["surface", "birthmarks"],
  }),
  defineAppearanceFeatureKind({
    id: APPEARANCE_MOLE_KIND_ID,
    label: "Mole",
    valueSchema: appearanceMoleValueSchema,
    allowedBodyLocations: ["face", "neck", "shoulders", "chest", "back", "arms", "legs"],
    persistence: "stable",
    // The deliberate low end. One tier for the whole kind (a "prominent" mole
    // is still a mole): tier 3 keeps it out of ordinary conversational reads.
    recognition: defineAppearanceRecognitionPriors({
      baseUniqueness: 2_000,
      baseImportance: 1_500,
      minimumDetailTier: 3,
      repeatFamily: "pigmentation",
    }),
    bodyAreaPath: ["surface", "moles"],
  }),
  defineAppearanceFeatureKind({
    id: APPEARANCE_SCAR_KIND_ID,
    label: "Scar",
    valueSchema: appearanceScarValueSchema,
    allowedBodyLocations: ["face", "neck", "shoulders", "chest", "back", "arms", "hands", "legs", "torso"],
    persistence: "persistent",
    // Importance above uniqueness on purpose: the spec's rule is that a common
    // shared-event scar may outrank a rare irrelevant detail.
    recognition: defineAppearanceRecognitionPriors({
      baseUniqueness: 4_500,
      baseImportance: 5_000,
      minimumDetailTier: 2,
      repeatFamily: "scar",
    }),
    bodyAreaPath: ["surface", "scars"],
  }),
];
