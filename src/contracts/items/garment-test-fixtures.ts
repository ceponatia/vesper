import { clothingCategoryById } from "./clothing-categories";
import type { GarmentBlueprint } from "./garment-blueprint";
import {
  emptyGarmentPresentationState,
  pristineGarmentConditionState,
  type GarmentChangeStamp,
  type GarmentConditionState,
  type GarmentInstanceState,
  type GarmentPresentationState,
} from "./garment-instance";
import type { GarmentMaterialProfileId } from "./garment-material";
import type { GarmentSeed } from "./garment-store";
import { garmentTemplateForCategory } from "./garment-templates";

/**
 * Shared garment fixtures for the clothing-state-graph suites.
 *
 * Colocated in `src/contracts/items` rather than `src/test` because it imports
 * contracts only and pulls in no test runner — nothing here calls `expect`, so
 * it stays a plain data builder any suite (or another fixture) can compose.
 */

/** The fabric the template fixtures assume unless a case is specifically about material. */
export const TEST_GARMENT_MATERIAL: GarmentMaterialProfileId = "woven_cotton_linen";

/**
 * The sparse part template for a clothing category. THROWS on a missing
 * category: an absent template means the fixture named a category that isn't in
 * the registry, which is a broken test rather than a degraded read.
 */
export function templateFor(
  categoryId: string,
  material: GarmentMaterialProfileId = TEST_GARMENT_MATERIAL,
): GarmentBlueprint {
  const blueprint = garmentTemplateForCategory(categoryId, material);
  if (!blueprint) throw new Error(`no template for ${categoryId}`);
  return blueprint;
}

export interface WornGarmentSpec {
  id?: string;
  name?: string;
  /** The wearer handle this instance's `worn` locus points at. */
  actorId?: string;
  blueprintHash?: string;
  presentation?: Partial<GarmentPresentationState>;
  condition?: Partial<GarmentConditionState>;
  lastChange?: GarmentChangeStamp;
}

/**
 * One worn instance carrying the given presentation/condition — no store
 * needed, because a derived read (coverage, digest, observation) only ever sees
 * the instance plus its blueprint.
 */
export function wornGarment(spec: WornGarmentSpec = {}): GarmentInstanceState {
  return {
    id: spec.id ?? "g_shirt",
    blueprintHash: spec.blueprintHash ?? "h1",
    name: spec.name ?? "linen shirt",
    locus: { kind: "worn", actorId: spec.actorId ?? "c:wren" },
    presentation: { ...emptyGarmentPresentationState(), ...spec.presentation },
    condition: { ...pristineGarmentConditionState(), ...spec.condition },
    lastChange: spec.lastChange ?? { kind: "mint", atMinutes: 0 },
  };
}

/** Deterministic instance ids (`g1`, `g2`, …) so assertions read. */
export function counterIds(prefix = "g"): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

export interface GarmentSeedSpec {
  definitionId: string;
  /** Defaults to the definition id, which is what the store suite asserts against. */
  name?: string;
  categoryId: string;
  /** Defaults to the CATEGORY's coverage — the same fallback the real mint path takes. */
  coverage?: readonly string[];
  materialProfileId?: GarmentMaterialProfileId;
}

/** What one library item definition contributes when the chat store instantiates it. */
export function garmentSeed(spec: GarmentSeedSpec): GarmentSeed {
  const seed: GarmentSeed = {
    definitionId: spec.definitionId,
    name: spec.name ?? spec.definitionId,
    categoryId: spec.categoryId,
    coverage: spec.coverage ?? clothingCategoryById(spec.categoryId)?.coverage ?? [],
  };
  // Left OFF rather than set to `undefined` when unstated, so a seed reads the
  // same as the ones the library mint path builds.
  return spec.materialProfileId === undefined ? seed : { ...seed, materialProfileId: spec.materialProfileId };
}

/** The `definitionId -> seed` map `syncWornGarments` takes. */
export function garmentSeedMap(seeds: readonly GarmentSeed[]): Map<string, GarmentSeed> {
  return new Map(seeds.map((seed) => [seed.definitionId, seed]));
}
