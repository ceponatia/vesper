import { attributeRegistry } from "../attributes";
import { bodyLocationRegistry } from "../body/locations";
import { defineAppearanceRecognitionPriors, type AppearanceRecognitionPriors } from "./priors";
import type { AppearanceBodyAreaPath } from "./definitions";

/**
 * The attribute → recognition catalog. Optional recognition metadata lives
 * beside the definition; the character profile continues to store only the
 * ordinary `AttributeValue`.
 *
 * V1 CHOICE: the metadata is a COLOCATED catalog keyed
 * by `attributeId` rather than new optional fields on
 * `AttributeDefinition`. Same effect, far smaller blast radius — the attribute
 * registry is read by the forge, the editor, every prompt builder, and the
 * image pipeline, and none of them should have to learn a recognition
 * vocabulary to add an eye color. When a second consumer needs the same
 * metadata, moving it onto the definition is a mechanical change from here.
 *
 * Entries are validated at DEFINITION time and throw: an unknown attribute, an
 * eligible value outside the attribute's own `allowedValues`, a missing body
 * location, or a duplicated (locus, aspect) pair is a programmer error.
 *
 * Eligibility is the "not every non-default attribute is recognition-worthy"
 * anti-pattern guard: only the distinctive members of a vocabulary project.
 * An ordinary straight nose is not a recognizable feature.
 */

interface AppearanceAttributeRecognitionShape {
  readonly attributeId: string;
  /** Feature aspect within the locus — unique per (locus, aspect). */
  readonly aspect: string;
  /** The distinctive members of the attribute's vocabulary. */
  readonly eligibleValues: readonly string[];
  readonly priors: AppearanceRecognitionPriors;
  /** Nesting under the locus in the derived body-area view. */
  readonly bodyAreaPath: AppearanceBodyAreaPath;
  readonly semanticTagsFor: (value: string) => readonly string[];
}

export interface AppearanceAttributeRecognitionInput extends AppearanceAttributeRecognitionShape {
  /**
   * Required ONLY when the attribute definition carries no `bodyLocationId`.
   * There is deliberately no "face" fallback — an unplaced feature would be
   * silently mislocated for every observer.
   */
  readonly bodyLocationId?: string;
}

export interface AppearanceAttributeRecognitionEntry extends AppearanceAttributeRecognitionShape {
  readonly bodyLocationId: string;
}

function defineAppearanceAttributeRecognition(
  inputs: readonly AppearanceAttributeRecognitionInput[],
): readonly AppearanceAttributeRecognitionEntry[] {
  const seenAspects = new Set<string>();
  return inputs.map((input) => {
    const definition = attributeRegistry.byId(input.attributeId);
    if (!definition) {
      throw new Error(`Appearance recognition catalog names unknown attribute ${input.attributeId}`);
    }
    const allowed = definition.allowedValues ?? [];
    if (input.eligibleValues.length === 0) {
      throw new Error(`Appearance recognition entry ${input.attributeId} lists no eligible values`);
    }
    for (const value of input.eligibleValues) {
      if (!allowed.includes(value)) {
        throw new Error(`Appearance recognition entry ${input.attributeId} eligible value "${value}" is not in allowedValues`);
      }
    }
    const bodyLocationId = definition.bodyLocationId ?? input.bodyLocationId;
    if (bodyLocationId === undefined) {
      throw new Error(`Appearance recognition entry ${input.attributeId} needs an explicit bodyLocationId`);
    }
    if (!bodyLocationRegistry.byId(bodyLocationId)) {
      throw new Error(`Appearance recognition entry ${input.attributeId} names unknown body location ${bodyLocationId}`);
    }
    const aspectKey = `${bodyLocationId}/${input.aspect}`;
    if (seenAspects.has(aspectKey)) {
      throw new Error(`Appearance recognition catalog has two entries for ${aspectKey}`);
    }
    seenAspects.add(aspectKey);
    defineAppearanceRecognitionPriors(input.priors);
    return { ...input, bodyLocationId };
  });
}

/**
 * CALIBRATION, same scale and caveats as the located-fact kinds: authored
 * starting points, ordered so a striking mouth (fangs, a gold cap) outranks
 * facial freckling, and teeth sit at detail tier 3 because they need a smile
 * or closeness while a crooked nose reads across a table (tier 2).
 */
export const appearanceAttributeRecognitionCatalog: readonly AppearanceAttributeRecognitionEntry[] =
  defineAppearanceAttributeRecognition([
    {
      attributeId: "nose.shape",
      aspect: "shape",
      // The spec's canonical attribute example. `crooked` was added to the
      // nose vocabulary for exactly this (registries are the extension point).
      eligibleValues: ["crooked", "hooked", "aquiline"],
      priors: defineAppearanceRecognitionPriors({
        baseUniqueness: 3_500,
        baseImportance: 3_000,
        minimumDetailTier: 2,
        repeatFamily: "facial_geometry",
      }),
      bodyAreaPath: ["geometry", "shape"],
      semanticTagsFor: (value) => ["nose", value],
    },
    {
      attributeId: "teeth.shape",
      aspect: "teeth_shape",
      eligibleValues: ["gapped", "fanged", "all_pointed", "serrated", "sharp_canines"],
      priors: defineAppearanceRecognitionPriors({
        baseUniqueness: 5_000,
        baseImportance: 3_500,
        minimumDetailTier: 3,
        repeatFamily: "teeth",
      }),
      bodyAreaPath: ["teeth", "shape"],
      semanticTagsFor: (value) => ["teeth", value],
    },
    {
      attributeId: "teeth.condition",
      aspect: "teeth_condition",
      eligibleValues: ["chipped", "gold_capped"],
      priors: defineAppearanceRecognitionPriors({
        baseUniqueness: 4_500,
        baseImportance: 3_000,
        minimumDetailTier: 3,
        repeatFamily: "teeth",
      }),
      bodyAreaPath: ["teeth", "condition"],
      semanticTagsFor: (value) => ["teeth", value],
    },
    {
      attributeId: "face.freckles",
      aspect: "freckles",
      // The denser end only: "faint" or "light_dusting" freckling is ordinary
      // appearance description, not an identifying feature.
      eligibleValues: ["scattered", "prominent", "heavy"],
      priors: defineAppearanceRecognitionPriors({
        baseUniqueness: 2_500,
        baseImportance: 2_000,
        minimumDetailTier: 2,
        repeatFamily: "pigmentation",
      }),
      bodyAreaPath: ["surface", "freckles"],
      semanticTagsFor: (value) => ["face", "freckles", value],
    },
  ]);

const catalogByAttributeId = new Map(
  appearanceAttributeRecognitionCatalog.map((entry) => [entry.attributeId, entry]),
);

const catalogByAspectKey = new Map(
  appearanceAttributeRecognitionCatalog.map((entry) => [`${entry.bodyLocationId}/${entry.aspect}`, entry]),
);

export function appearanceAttributeRecognitionFor(attributeId: string): AppearanceAttributeRecognitionEntry | undefined {
  return catalogByAttributeId.get(attributeId);
}

/** Reverse lookup for a projected record, which knows only its locus + aspect. */
export function appearanceAttributeRecognitionAt(
  bodyLocationId: string,
  aspect: string,
): AppearanceAttributeRecognitionEntry | undefined {
  return catalogByAspectKey.get(`${bodyLocationId}/${aspect}`);
}
