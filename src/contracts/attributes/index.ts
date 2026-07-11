import { buildRegistry } from "./registry";
import { attributeGroups } from "./categories";
import type { AttributeValue } from "./value";

export * from "./category-ids";
export * from "./types";
export * from "./registry";
export * from "./value";
export * from "./shared-values";
export { attributeGroups } from "./categories";

export const attributeRegistry = buildRegistry(attributeGroups);

/**
 * Fill absent core-visual registry defaults (`defaultValue`, curated on the
 * `coreVisual` set) into an attribute list — how a blank character is born
 * with a usable look (face-jewelry plan §defaults). Never overwrites a present
 * value; callers decide when to apply it (the create route seeds only truly
 * blank profiles — the forge keeps its own concept-varied fills).
 */
export function seedRegistryDefaultValues(values: readonly AttributeValue[]): AttributeValue[] {
  const present = new Set(values.map((v) => v.id));
  const seeded = [...values];
  for (const def of attributeRegistry.definitions) {
    if (!def.coreVisual || def.defaultValue === undefined || present.has(def.id)) continue;
    seeded.push({ id: def.id, value: def.defaultValue, source: "creation" });
  }
  return seeded;
}
