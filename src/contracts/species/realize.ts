import type { AttributeDefinition } from "../attributes/types";
import {
  bodyLocationRegistry,
  isFeatureAttributeCategory,
  isFeatureGroup,
  INTIMATE_ATTRIBUTE_CATEGORIES,
  isIntimateRegionGroup,
} from "../body/locations";
import { bodyPlanById, DEFAULT_BODY_PLAN_ID } from "../body/plans";
import { DEFAULT_SPECIES_ID, speciesById } from "./registry";

/**
 * The realized body for one character — the single gating filter the spec calls
 * for (intimate-anatomy-sensory-and-species-spec.phase4.md §A). It composes:
 *
 *   body plan (superset of locations)
 *     → species (allow / disallow + forbidden attribute rules)
 *       → per-character body-config (which intimate region groups are present)
 *
 * and answers, for a given character, which body locations exist and which
 * attributes apply. The forge, the attribute editor, the narrator prompt
 * builders, and image generation all read this one view. An empty body-config
 * (no intimate regions) yields exactly the pre-existing everyday-only body.
 */
export interface RealizedBody {
  readonly bodyPlanId: string;
  readonly speciesId: string;
  readonly intimateRegions: ReadonlySet<string>;
  readonly bodyFeatures: ReadonlySet<string>;
  readonly locationIds: ReadonlySet<string>;
  isLocationPresent(id: string): boolean;
  hasIntimateRegion(group: string): boolean;
  hasFeature(group: string): boolean;
  isAttributeApplicable(def: AttributeDefinition): boolean;
}

export interface RealizeBodyInput {
  bodyPlanId?: string;
  speciesId?: string;
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
  const featureSource = input.bodyFeatures ?? species?.defaultFeatureGroups ?? [];
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

  const forbiddenAttributeIds = new Set(
    (species?.attributeRules ?? []).filter((r) => r.applicability === "forbidden").map((r) => r.attributeId),
  );

  const isAttributeApplicable = (def: AttributeDefinition): boolean => {
    if (!(def.appliesToEntityKinds ?? ["character"]).includes("character")) return false;
    if (def.appliesToBodyPlans && !def.appliesToBodyPlans.includes(bodyPlanId)) return false;
    if (def.excludesBodyPlans?.includes(bodyPlanId)) return false;
    if (forbiddenAttributeIds.has(def.id)) return false;
    // Intimate category gating: the region must be switched on for this character.
    if ((INTIMATE_ATTRIBUTE_CATEGORIES as readonly string[]).includes(def.category) && !intimateRegions.has(def.category)) {
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
    intimateRegions,
    bodyFeatures,
    locationIds,
    isLocationPresent: (id) => locationIds.has(id),
    hasIntimateRegion: (group) => intimateRegions.has(group),
    hasFeature: (group) => bodyFeatures.has(group),
    isAttributeApplicable,
  };
}
