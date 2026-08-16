import { z } from "zod";
import { APPEARANCE_ANATOMY_PRIORS } from "../appearance-features";
import { toUnitInterval } from "../affordances/core";
import { defineVisualStateKind, type VisualStateKindDefinition } from "./definitions";
import { visualStatePriorsFromAppearance, type VisualStateAttentionPriors } from "./priors";

/**
 * The visual-state kind catalog — one file, data only.
 *
 * The first release adapts EXISTING truth before inventing vocabulary, so the
 * catalog opens with exactly the three kinds the truth-level appearance
 * projection produces. Presentation, garment, body-surface, condition and scene
 * kinds join here as their adapters land; each is a data edit in this file, not
 * a schema migration.
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
];
