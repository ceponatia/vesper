import {
  attributeRegistry,
  heritageFor,
  realizeBody,
  speciesById,
  type AttributeDefinition,
  type AttributeValue,
  type RealizedBody,
} from "@/contracts";

/** Pure helpers behind the registry-driven attribute picker. */

export function attributeValueMap(values: readonly AttributeValue[]): Map<string, AttributeValue> {
  const map = new Map<string, AttributeValue>();
  for (const value of values) map.set(value.id, value);
  return map;
}

/** Upsert with `source: "manual"` — touching an AI value claims it (docs/authoring.md). */
export function setAttribute(
  values: readonly AttributeValue[],
  id: AttributeValue["id"],
  value: AttributeValue["value"],
): AttributeValue[] {
  const next: AttributeValue = { id, value, source: "manual" };
  const index = values.findIndex((v) => v.id === id);
  if (index < 0) return [...values, next];
  return values.map((v, i) => (i === index ? next : v));
}

export function removeAttribute(values: readonly AttributeValue[], id: string): AttributeValue[] {
  return values.filter((v) => v.id !== id);
}

/**
 * Whether the editor may clear this attribute back to unset. Materialized
 * baselines (`materializeDefault`) are never clearable: the server re-materializes
 * the registry default on save, so a blank control would show an empty field
 * while the stored body carries the default. Ordinary sparse attributes stay
 * clearable. A selected replacement still goes through {@link setAttribute}
 * (`source: "manual"`) either way.
 */
export function isClearableAttribute(def: AttributeDefinition): boolean {
  return def.materializeDefault !== true;
}

/** AI chip shows for forge-sourced values until the human touches them. */
export function isAiSourced(value: AttributeValue): boolean {
  return value.source === "creation";
}

export interface SliderBounds {
  min: number;
  max: number;
  step: number;
}

/** Sensible slider bounds for number attributes missing explicit min/max. */
export function sliderBounds(def: Pick<AttributeDefinition, "min" | "max">): SliderBounds {
  const min = def.min ?? 0;
  const max = def.max ?? (def.min !== undefined ? def.min + 100 : 1);
  const range = max - min;
  const step = range > 10 ? 1 : range > 2 ? 0.5 : 0.05;
  return { min, max, step };
}

/**
 * First enum member eligible to be an automatic default — skips any the
 * registry marks `autoDefaultExcludes` (e.g. minor apparent ages), falling back
 * to the bare first value if exclusion would leave nothing.
 */
function firstAutoDefault(def: AttributeDefinition): string | undefined {
  const values = def.allowedValues;
  if (!values || values.length === 0) return undefined;
  const excl = def.autoDefaultExcludes;
  if (excl && excl.length > 0) {
    const eligible = values.find((v) => !excl.includes(v));
    if (eligible !== undefined) return eligible;
  }
  return values[0];
}

/** Default value for a definition when first added: the curated registry
 *  default when one exists, else a per-type generic. */
export function defaultValueFor(def: AttributeDefinition): AttributeValue["value"] {
  if (def.defaultValue !== undefined) return def.defaultValue;
  switch (def.valueType) {
    case "enum":
      return firstAutoDefault(def) ?? "";
    case "enum_list": {
      const first = firstAutoDefault(def);
      return first !== undefined ? [first] : [];
    }
    case "number": {
      const { min, max } = sliderBounds(def);
      return (min + max) / 2;
    }
    case "text":
      return "";
    case "flag":
      return true;
  }
}

/** Coerce a stored value into the list shape an enum_list control needs. */
export function asList(value: AttributeValue["value"]): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

// --- Species-rule narrowing (the editor hard-restricts to these) -------------

/**
 * Options an enum/enum_list control may offer for THIS character: the
 * species/heritage-narrowed set when a rule applies (`allowedValuesFor`), else the
 * definition's full set. The editor renders only these.
 */
export function allowedOptionsFor(def: AttributeDefinition, body: RealizedBody): readonly string[] {
  return body.allowedValuesFor(def) ?? def.allowedValues ?? [];
}

/**
 * True when a non-empty stored value falls outside the narrowed option set (e.g. left
 * over after a species change). The editor surfaces it as a flagged option rather than
 * silently rewriting it.
 */
export function isOutOfRuleValue(allowed: readonly string[], value: string): boolean {
  return value !== "" && !allowed.includes(value);
}

/**
 * Seed value when adding an attribute in the editor: the species rule `defaultValue`
 * when one exists (e.g. a required trait), else the generic per-type default.
 */
export function seedValueFor(def: AttributeDefinition, body: RealizedBody): AttributeValue["value"] {
  const ruleDefault = body.defaultValueFor(def);
  if (ruleDefault !== undefined) return ruleDefault as AttributeValue["value"];
  return defaultValueFor(def);
}

/** The realized-body inputs needed to seed species/heritage defaults. */
export interface BodyConfig {
  speciesId: string;
  heritageId?: string;
  bodyPlanId: string;
  intimateRegions: string[];
  bodyFeatures?: string[];
}

/**
 * Seed species/heritage `required`-rule defaults (e.g. elf `ears.shape` → "pointed",
 * faerie `wings.shape` → "butterfly") into the attribute list for a newly-realized body
 * — mirrors the forge's creation-time seeding so a species trait holds without the
 * author hunting for it. Never clobbers a value already set; only fills required gaps.
 */
export function seedRequiredAttributes(attributes: readonly AttributeValue[], config: BodyConfig): AttributeValue[] {
  const body = realizeBody(config);
  const present = new Set(attributes.map((a) => a.id));
  const seeded: AttributeValue[] = [];
  for (const def of attributeRegistry.definitions) {
    if (present.has(def.id) || !body.isAttributeApplicable(def) || !body.isAttributeRequired(def)) continue;
    const value = body.defaultValueFor(def);
    if (value === undefined) continue;
    seeded.push({ id: def.id, value: value as AttributeValue["value"], source: "creation" });
  }
  return seeded.length > 0 ? [...attributes, ...seeded] : [...attributes];
}

/**
 * The body-bearing slice of a profile — everything species/heritage changes touch.
 * Structural, not a named contract, so BOTH `CharacterProfile` and `PersonaProfile`
 * satisfy it — reuse, never fork.
 */
export interface BodyProfileParts {
  speciesId: string;
  heritageId?: string;
  bodyPlanId: string;
  intimateRegions: string[];
  bodyFeatures?: string[];
  attributes: AttributeValue[];
}

/**
 * The patch for changing species: a heritage belongs to ONE species, so the old
 * value clears to the new species' default subtype (when it has one), the body plan
 * follows the species, the feature config resets to the resolved species/subtype
 * defaults, and required attributes re-seed. Returns `null` for an unknown id
 * (the caller leaves state alone).
 */
export function speciesChangePatch(profile: BodyProfileParts, speciesId: string): Partial<BodyProfileParts> | null {
  const species = speciesById(speciesId);
  if (!species) return null;
  const heritage = heritageFor(species.id, undefined);
  const groups = [...(species.defaultFeatureGroups ?? []), ...(heritage?.defaultFeatureGroups ?? [])];
  const bodyFeatures = groups.length > 0 ? [...new Set(groups)] : undefined;
  return {
    speciesId: species.id,
    heritageId: heritage?.id,
    bodyPlanId: species.bodyPlanId,
    bodyFeatures,
    attributes: seedRequiredAttributes(profile.attributes, {
      speciesId: species.id,
      heritageId: heritage?.id,
      bodyPlanId: species.bodyPlanId,
      intimateRegions: profile.intimateRegions,
      bodyFeatures,
    }),
  };
}

/**
 * The patch for changing heritage: features compose species + heritage defaults, and
 * required attributes re-seed. Returns `null` when the profile's species is unknown;
 * an unknown/blank heritage id resolves the species default subtype when one exists,
 * otherwise it clears the heritage (the "— None —" option).
 */
export function heritageChangePatch(profile: BodyProfileParts, heritageId: string): Partial<BodyProfileParts> | null {
  const species = speciesById(profile.speciesId);
  if (!species) return null;
  const heritage = heritageFor(species.id, heritageId);
  const groups = [...(species.defaultFeatureGroups ?? []), ...(heritage?.defaultFeatureGroups ?? [])];
  const bodyFeatures = groups.length > 0 ? [...new Set(groups)] : undefined;
  return {
    heritageId: heritage?.id,
    bodyFeatures,
    attributes: seedRequiredAttributes(profile.attributes, {
      speciesId: species.id,
      heritageId: heritage?.id,
      bodyPlanId: profile.bodyPlanId,
      intimateRegions: profile.intimateRegions,
      bodyFeatures,
    }),
  };
}
