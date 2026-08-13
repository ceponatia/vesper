import type { AttributeDefinition } from "../attributes/types";
import type { AttributeRule } from "../rules/attribute-rule";
import {
  bodyLocationRegistry,
  isFeatureAttributeCategory,
  isFeatureGroup,
  isIntimateRegionGroup,
} from "../body/locations";
import { bodyPlanById, DEFAULT_BODY_PLAN_ID } from "../body/plans";
import { DEFAULT_SPECIES_ID, heritageFor, speciesById } from "./registry";

/**
 * The realized body for one character — the single gating filter the spec calls
 * for (intimate-anatomy-sensory-and-species-spec.phase4.md §A). It composes:
 *
 *   body plan (superset of locations)
 *     → species (allow / disallow + forbidden attribute rules)
 *       → heritage (additive overlay: extra feature groups, rules that override
 *         the species' by attributeId)
 *         → per-character body-config (which intimate region groups are present)
 *
 * and answers, for a given character, which body locations exist and which
 * attributes apply. The forge, the attribute editor, the narrator prompt
 * builders, and image generation all read this one view. An empty body-config
 * (no intimate regions) yields exactly the pre-existing everyday-only body.
 */
export interface RealizedBody {
  readonly bodyPlanId: string;
  readonly speciesId: string;
  /** The resolved heritage id when one applies, else undefined. */
  readonly heritageId: string | undefined;
  readonly intimateRegions: ReadonlySet<string>;
  readonly bodyFeatures: ReadonlySet<string>;
  readonly locationIds: ReadonlySet<string>;
  isLocationPresent(id: string): boolean;
  hasIntimateRegion(group: string): boolean;
  hasFeature(group: string): boolean;
  isAttributeApplicable(def: AttributeDefinition): boolean;
  /** The species attribute rule targeting this id, if any. */
  attributeRuleFor(attributeId: string): AttributeRule | undefined;
  /** True when the species marks this attribute `required` (always present). */
  isAttributeRequired(def: AttributeDefinition): boolean;
  /**
   * Species-narrowed allowed values for an enum/enum_list attribute: the
   * definition's `allowedValues` intersected with the rule's `allowedValues`
   * and minus its `disallowedValues`. Returns the definition's own values
   * unchanged when no rule narrows them, and `undefined` for non-enum
   * attributes (which have no `allowedValues`).
   */
  allowedValuesFor(def: AttributeDefinition): readonly string[] | undefined;
  /**
   * The species-supplied default value for this attribute, if the rule carries
   * one (e.g. elf `ears.shape` → "pointed"). The consumer decides how to use it
   * (forge seeding, picker initial value); resolution stays out of this view.
   */
  defaultValueFor(def: AttributeDefinition): unknown;
}

export interface RealizeBodyInput {
  bodyPlanId?: string;
  speciesId?: string;
  /** Optional heritage within the species; ignored if it isn't one of the species' heritages. */
  heritageId?: string;
  /** The per-character body-config — present intimate region groups. */
  intimateRegions?: readonly string[];
  /**
   * Present additive body feature groups. Omitted ⇒ species defaults; provided
   * (including []) ⇒ explicit per-character override.
   */
  bodyFeatures?: readonly string[];
}

export function realizeBody(input: RealizeBodyInput): RealizedBody {
  const bodyPlanId = input.bodyPlanId ?? DEFAULT_BODY_PLAN_ID;
  const speciesId = input.speciesId ?? DEFAULT_SPECIES_ID;
  const intimateRegions = new Set<string>((input.intimateRegions ?? []).filter(isIntimateRegionGroup));

  const plan = bodyPlanById(bodyPlanId);
  const species = speciesById(speciesId);
  // Heritage is a pure overlay within the species: it never touches the body
  // plan or location set, only the feature defaults and attribute rules below.
  const heritage = heritageFor(speciesId, input.heritageId);
  // Default feature groups = species defaults ∪ heritage additions, unless the
  // per-character bodyFeatures override is supplied (even an empty one).
  const featureSource =
    input.bodyFeatures ?? [...(species?.defaultFeatureGroups ?? []), ...(heritage?.defaultFeatureGroups ?? [])];
  const bodyFeatures = new Set<string>(featureSource.filter(isFeatureGroup));

  // Base location set = the body plan's ids (or the full registry if the plan id
  // is unknown — a degraded default that keeps everyday anatomy available).
  let baseIds = new Set<string>(plan ? plan.bodyLocationIds : bodyLocationRegistry.all.map((l) => l.id));

  // Species narrowing: optional whitelist, then disallow removals.
  if (species?.allowedBodyLocationIds) {
    const allow = new Set(species.allowedBodyLocationIds);
    baseIds = new Set([...baseIds].filter((id) => allow.has(id)));
  }
  for (const id of species?.disallowedBodyLocationIds ?? []) baseIds.delete(id);

  // Body-config gating: tagged locations are realized only when their
  // corresponding per-character config switches the group on.
  const locationIds = new Set<string>();
  for (const id of baseIds) {
    const loc = bodyLocationRegistry.byId(id);
    if (loc?.intimateGroup && !intimateRegions.has(loc.intimateGroup)) continue;
    if (loc?.featureGroup && !bodyFeatures.has(loc.featureGroup)) continue;
    locationIds.add(id);
  }

  // Index the species rules by attribute id. First rule per id wins; a second
  // rule for the same id is an authoring error (a species registry test asserts
  // ids are unique), so the map silently keeps the first. Heritage rules are
  // then applied last-wins: a heritage rule **overrides** the species rule for
  // the same attribute, and heritage-only rules add to the set.
  const rulesById = new Map<string, AttributeRule>();
  for (const rule of species?.attributeRules ?? []) {
    if (!rulesById.has(rule.attributeId)) rulesById.set(rule.attributeId, rule);
  }
  for (const rule of heritage?.attributeRules ?? []) rulesById.set(rule.attributeId, rule);
  const forbiddenAttributeIds = new Set(
    [...rulesById.values()].filter((r) => r.applicability === "forbidden").map((r) => r.attributeId),
  );

  const allowedValuesFor = (def: AttributeDefinition): readonly string[] | undefined => {
    const base = def.allowedValues;
    if (!base) return base; // non-enum attributes have no value set to narrow
    const rule = rulesById.get(def.id);
    if (!rule || (!rule.allowedValues && !rule.disallowedValues)) return base;
    let out: readonly string[] = base;
    if (rule.allowedValues) {
      const allow = new Set(rule.allowedValues.map((v) => String(v)));
      out = out.filter((v) => allow.has(v));
    }
    if (rule.disallowedValues) {
      const deny = new Set(rule.disallowedValues.map((v) => String(v)));
      out = out.filter((v) => !deny.has(v));
    }
    return out;
  };

  const isAttributeApplicable = (def: AttributeDefinition): boolean => {
    if (!(def.appliesToEntityKinds ?? ["character"]).includes("character")) return false;
    if (def.appliesToBodyPlans && !def.appliesToBodyPlans.includes(bodyPlanId)) return false;
    if (def.excludesBodyPlans?.includes(bodyPlanId)) return false;
    if (forbiddenAttributeIds.has(def.id)) return false;
    // Intimate REGION-GROUP gating: a toggleable region (breasts/vulva/penis/
    // testicles) must be switched on for this character. Keyed on
    // `isIntimateRegionGroup`, NOT INTIMATE_ATTRIBUTE_CATEGORIES — the latter also
    // includes the universal intimate categories (anus/perineum), which are
    // present on every body and must never be body-config-gated out.
    if (isIntimateRegionGroup(def.category) && !intimateRegions.has(def.category)) {
      return false;
    }
    if (isFeatureAttributeCategory(def.category) && !bodyFeatures.has(def.category)) return false;
    // An attribute bound to a body location that isn't realized is dropped.
    if (def.bodyLocationId && !locationIds.has(def.bodyLocationId)) return false;
    return true;
  };

  return {
    bodyPlanId,
    speciesId,
    heritageId: heritage?.id,
    intimateRegions,
    bodyFeatures,
    locationIds,
    isLocationPresent: (id) => locationIds.has(id),
    hasIntimateRegion: (group) => intimateRegions.has(group),
    hasFeature: (group) => bodyFeatures.has(group),
    isAttributeApplicable,
    attributeRuleFor: (attributeId) => rulesById.get(attributeId),
    isAttributeRequired: (def) => rulesById.get(def.id)?.applicability === "required",
    allowedValuesFor,
    defaultValueFor: (def) => rulesById.get(def.id)?.defaultValue,
  };
}
