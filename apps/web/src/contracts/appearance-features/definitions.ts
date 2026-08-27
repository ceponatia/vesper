import { z, type ZodType } from "zod";
import { bodyLocationRegistry } from "../body/locations";
import { defineAppearanceRecognitionPriors, type AppearanceRecognitionPriors } from "./priors";

/**
 * Located-fact KIND definitions — validation plus recognition calibration.
 *
 * "The registry stores calibration, not which features a character has."
 * A kind says what a freckle cluster's value may look like, where it may sit,
 * how long it lasts, and how distinctive one is by default; the per-character
 * rows live in `facts.ts`.
 *
 * Definition-time construction THROWS (a bad id or an unknown body location is
 * a programmer error); every runtime read degrades with a diagnostic instead
 * (docs/resilience.md).
 */

/** `<family>.<snake_case>` — e.g. `pigmentation.freckle_cluster`. */
export type AppearanceFeatureKindId = string;

/** Where a kind's marks hang in the derived body-area view (see projection.ts). */
export type AppearanceBodyAreaPath = readonly string[];

/**
 * How long an instance of this kind lasts. Projection maps it to the
 * candidate's `stability`: `stable` → inherent, `persistent` → persistent,
 * `transient` → transient. Temporary marks (bruises, dirt) are NOT this — they
 * stay with the body condition/state owners.
 */
export const appearanceFeaturePersistences = ["stable", "persistent", "transient"] as const;

export const appearanceFeaturePersistenceSchema = z.enum(appearanceFeaturePersistences);

export type AppearanceFeaturePersistence = z.infer<typeof appearanceFeaturePersistenceSchema>;

export interface AppearanceFeatureKindDefinition<TValue = unknown> {
  readonly id: AppearanceFeatureKindId;
  readonly label: string;
  /** Parses the row's `value`; arbitrary JSON and executable prose are forbidden. */
  readonly valueSchema: ZodType<TValue>;
  /** Coarse body locations (descendants included) this kind may be placed at. */
  readonly allowedBodyLocations: readonly string[];
  readonly persistence: AppearanceFeaturePersistence;
  /**
   * Forward-compat only: no visual-realizer system exists yet, so this is
   * optional and unread. Named here so the field does not have to be
   * retrofitted onto authored kinds later.
   */
  readonly visualRealizerId?: string;
  readonly recognition: AppearanceRecognitionPriors;
  /**
   * Nesting under the locus in the derived body-area diagnostics view, e.g.
   * `["surface", "freckles"]` → `shoulders: { surface: { freckles: [ … ] } }`.
   * Spec deviation (documented): the spec shows that view's shape but not
   * where the labels come from, and the view can only see a projected record —
   * carrying the path on the definition is what lets it reproduce the spec's
   * example without a second lookup table.
   */
  readonly bodyAreaPath: AppearanceBodyAreaPath;
}

export const APPEARANCE_FEATURE_KIND_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * Construct + validate one kind. Throws on a malformed id, an empty or unknown
 * body-location list, an empty body-area path, or out-of-range priors.
 */
export function defineAppearanceFeatureKind<TValue>(
  definition: AppearanceFeatureKindDefinition<TValue>,
): AppearanceFeatureKindDefinition<TValue> {
  if (!APPEARANCE_FEATURE_KIND_ID_PATTERN.test(definition.id)) {
    throw new Error(`Appearance feature kind id must be <family>.<snake_case>: ${definition.id}`);
  }
  if (definition.allowedBodyLocations.length === 0) {
    throw new Error(`Appearance feature kind ${definition.id} allows no body locations`);
  }
  for (const bodyLocationId of definition.allowedBodyLocations) {
    if (!bodyLocationRegistry.byId(bodyLocationId)) {
      throw new Error(`Appearance feature kind ${definition.id} names unknown body location ${bodyLocationId}`);
    }
  }
  if (definition.bodyAreaPath.length === 0) {
    throw new Error(`Appearance feature kind ${definition.id} needs a body-area path`);
  }
  defineAppearanceRecognitionPriors(definition.recognition);
  return definition;
}
