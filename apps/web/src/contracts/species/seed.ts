import { attributeRegistry, type AttributeValue } from "../attributes";
import { isFeatureGroup, isIntimateRegionGroup } from "../body/locations";

export interface SeededBodyConfig {
  /** Present intimate region groups (CharacterProfile.intimateRegions). */
  intimateRegions: string[];
  /** Additive feature groups (CharacterProfile.bodyFeatures). */
  bodyFeatures: string[];
}

/**
 * The creation-time body-config seeded by a character's attribute values — the
 * generalization of the old gender→intimateRegions special case. It reads each
 * attribute definition's declarative `activatesGroups` (e.g. identity.gender
 * "female" → vulva + breasts) and unions the activated groups.
 *
 * This is a SEED, not a lock: the result is the *initial* body-config, which is
 * authoritative and fully editable thereafter (a "male" character can still be
 * given a vulva in the editor). Group ids are validated against the body-config
 * vocabulary (INTIMATE_REGION_GROUPS / FEATURE_GROUPS) and the result is
 * order-stable and de-duplicated, so the same attributes always seed the same
 * body-config.
 */
export function seedBodyConfigFromAttributes(values: readonly AttributeValue[]): SeededBodyConfig {
  const intimateRegions: string[] = [];
  const bodyFeatures: string[] = [];
  for (const value of values) {
    const map = attributeRegistry.byId(value.id)?.activatesGroups;
    if (!map || typeof value.value !== "string") continue;
    const activation = map[value.value];
    if (!activation) continue;
    for (const group of activation.intimateRegions ?? []) {
      if (isIntimateRegionGroup(group) && !intimateRegions.includes(group)) intimateRegions.push(group);
    }
    for (const group of activation.bodyFeatures ?? []) {
      if (isFeatureGroup(group) && !bodyFeatures.includes(group)) bodyFeatures.push(group);
    }
  }
  return { intimateRegions, bodyFeatures };
}
