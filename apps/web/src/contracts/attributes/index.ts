import { buildRegistry } from "./registry";
import { attributeGroups } from "./categories";
import type { AttributeCategory } from "./category-ids";
import type { AttributeDefinition } from "./types";
import type { AttributeValue } from "./value";

export * from "./category-ids";
export * from "./types";
export * from "./registry";
export * from "./value";
export * from "./shared-values";
export { attributeGroups } from "./categories";
export { BUST_SCALE_TO_BREAST_SIZE } from "./categories/chest";

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

/**
 * Bump when a category's materialized defaults are recalibrated, so a backfill
 * can tell an old materialization from the current one. Categories absent here
 * are at v1.
 */
const MATERIALIZE_DEFAULT_VERSIONS: Partial<Record<AttributeCategory, number>> = {};

/** The versioned provenance `sourceId` a materialized registry default carries. */
export function registryDefaultSourceId(category: AttributeCategory): string {
  return `registry-default:${category}:v${MATERIALIZE_DEFAULT_VERSIONS[category] ?? 1}`;
}

export interface MaterializeDefaultsOptions {
  /** Body-plan/species gate — a definition rejected here is skipped, not forced. */
  readonly isApplicable?: (def: AttributeDefinition) => boolean;
  /** Species-narrowed vocabulary; a default outside it is not written. */
  readonly allowedValuesFor?: (def: AttributeDefinition) => readonly string[] | undefined;
  /** The species rule's own default — the fallback when narrowing rejects the registry's. */
  readonly ruleDefaultFor?: (def: AttributeDefinition) => unknown;
}

/**
 * Materialize the persisted-baseline registry defaults (`materializeDefault`)
 * into an attribute list — the pre-slice-3 foot-facts guarantee that a stored
 * body always carries these facts. Unlike {@link seedRegistryDefaultValues}
 * this runs on EVERY grounding (blank, forged, imported, cloned, persona,
 * PATCH-heal, backfill), is fill-only (a supplied or existing value is never
 * overwritten), and stamps the versioned `registry-default:<category>:vN`
 * sourceId at the low-precedence `creation` source so manual edits and
 * narrative overlays stay authoritative. Callers that know the body thread the
 * realized-body gates through `options` (see `materializeBodyDefaults`); a
 * species-narrowed vocabulary that rejects both the registry default and the
 * species rule's own default skips the fact rather than inventing a value.
 */
export function materializeRegistryDefaults(
  values: readonly AttributeValue[],
  options: MaterializeDefaultsOptions = {},
): AttributeValue[] {
  const present = new Set(values.map((v) => v.id));
  const materialized = [...values];
  for (const def of attributeRegistry.definitions) {
    if (!def.materializeDefault || def.defaultValue === undefined || present.has(def.id)) continue;
    if (options.isApplicable && !options.isApplicable(def)) continue;
    let value: AttributeValue["value"] | undefined = def.defaultValue;
    const allowed = options.allowedValuesFor ? options.allowedValuesFor(def) : def.allowedValues;
    if (typeof value === "string" && allowed && !allowed.includes(value)) {
      const ruleDefault = options.ruleDefaultFor?.(def);
      value = typeof ruleDefault === "string" && allowed.includes(ruleDefault) ? ruleDefault : undefined;
    }
    if (value === undefined) continue;
    materialized.push({ id: def.id, value, source: "creation", sourceId: registryDefaultSourceId(def.category) });
  }
  return materialized;
}
