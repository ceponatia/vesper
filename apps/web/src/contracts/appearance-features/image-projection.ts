import {
  attributeRegistry,
  formatAttribute,
  formatAttributePhrase,
  isNonVisualAttribute,
  promptValueWithNoneElided,
  type AttributeDefinition,
  type AttributeValue,
  type ImageAppearanceClass,
  type ImageAppearanceMetadata,
  type ImageAppearanceMinimumFraming,
  type ImageAppearancePhraseValue,
} from "../attributes";
import type { AppearanceSourceRef } from "./projection";
import { appearanceCanonicalFingerprint } from "./projection";

export interface ImageAppearanceAttributeProjectionInput {
  /** Canonical, already overlay-resolved attribute rows. */
  readonly attributes: readonly AttributeValue[];
  /** The caller's realized-body applicability decision. */
  readonly isAttributeApplicable: (definition: AttributeDefinition) => boolean;
}

/**
 * One prompt-ready semantic attribute fact. `truthFingerprint` and
 * `sourceRef` are provenance; only `readableValue` and `phraseValue` may become
 * prompt text.
 */
export interface ProjectedImageAppearanceAttribute {
  readonly attributeId: string;
  readonly definition: AttributeDefinition;
  readonly bodyLocationId: string | undefined;
  readonly sourceRef: AppearanceSourceRef;
  readonly truthFingerprint: string;
  /** The self-describing `Label: value` form — always present. */
  readonly readableValue: string;
  /**
   * The same fact as PROSE, when the registry declares a phrase for this value:
   * the standalone noun phrase a dialect states on its own ("dark-brown hair")
   * plus the group/role/fragment a composing dialect joins into one sentence.
   *
   * `null` where the registry has no wording — an attribute with no natural
   * phrase, or one member of an enum that has none — and the caller then uses
   * `readableValue`. Both are offered rather than one replacing the other: the
   * label form is still the honest answer for a consumer that is listing facts
   * rather than writing a sentence.
   */
  readonly phraseValue: ImageAppearancePhraseValue | null;
  readonly class: ImageAppearanceClass;
  readonly referenceFreeRequired: boolean;
  readonly minimumFraming: ImageAppearanceMinimumFraming;
  readonly maximumFraming: ImageAppearanceMinimumFraming;
  readonly ordinarySilhouette: boolean;
}

function withoutOmittedValues(
  value: AttributeValue["value"],
  metadata: ImageAppearanceMetadata,
): AttributeValue["value"] | null {
  const omitted = new Set(metadata.omitValues ?? []);
  if (typeof value === "string") return omitted.has(value) ? null : value;
  if (!Array.isArray(value)) return value;
  const kept = value.filter((member) => !omitted.has(member));
  return kept.length > 0 ? kept : null;
}

/**
 * Project canonical saved attributes into the image-description policy.
 *
 * This is deliberately independent of observer recognition. It performs only
 * registry/body eligibility and prompt-safety filtering; later image policy
 * owns visibility, current-state replacement, references, and completeness.
 */
export function projectImageAppearanceAttributes(
  input: ImageAppearanceAttributeProjectionInput,
): readonly ProjectedImageAppearanceAttribute[] {
  // Inputs are expected to be resolved, but last-row-wins keeps the projector
  // deterministic and prevents duplicate facts when a boundary violates that
  // expectation.
  const resolved = new Map<string, AttributeValue>();
  for (const attribute of input.attributes) resolved.set(attribute.id, attribute);

  const projected: ProjectedImageAppearanceAttribute[] = [];
  for (const attribute of resolved.values()) {
    const definition = attributeRegistry.byId(attribute.id);
    if (!definition?.imageAppearance) continue;
    if (definition.excludeFromPrompts || isNonVisualAttribute(definition)) continue;
    if (!input.isAttributeApplicable(definition)) continue;

    const eligible = withoutOmittedValues(attribute.value, definition.imageAppearance);
    if (eligible === null) continue;
    const promptValue = promptValueWithNoneElided(definition, eligible);
    if (promptValue === null) continue;
    const readableValue = formatAttribute(definition, promptValue);
    if (!readableValue) continue;

    projected.push({
      attributeId: definition.id,
      definition,
      bodyLocationId: definition.bodyLocationId,
      sourceRef: { kind: "attribute", attributeId: definition.id },
      truthFingerprint: appearanceCanonicalFingerprint(attribute.value),
      readableValue,
      phraseValue: formatAttributePhrase(definition, promptValue),
      class: definition.imageAppearance.class,
      referenceFreeRequired: definition.imageAppearance.referenceFreeRequired ?? false,
      minimumFraming: definition.imageAppearance.minimumFraming ?? "close_up",
      maximumFraming: definition.imageAppearance.maximumFraming ?? "wide",
      ordinarySilhouette: definition.imageAppearance.ordinarySilhouette ?? false,
    });
  }

  return projected.sort((left, right) =>
    left.attributeId < right.attributeId ? -1 : left.attributeId > right.attributeId ? 1 : 0,
  );
}
