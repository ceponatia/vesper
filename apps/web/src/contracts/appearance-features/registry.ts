import { bodyLocationRegistry } from "../body/locations";
import { buildRegistryCore, type RegistryParseResult } from "../registry";
import { appearanceFeatureKindDefinitions } from "./kinds";
import type { AppearanceFeatureKindDefinition } from "./definitions";

/**
 * The located-fact kind registry — the shared registry spine
 * (`contracts/registry`) plus the one lookup this family needs beyond an id
 * index: "may a mark of this kind sit HERE?".
 *
 * Same idiom as `attributeRegistry` (contracts/attributes/registry.ts): the
 * core owns duplicate-id detection and per-id value parsing, the wrapper adds
 * the domain lookup.
 */

export interface AppearanceFeatureKindRegistry {
  readonly definitions: readonly AppearanceFeatureKindDefinition[];
  byId(id: string): AppearanceFeatureKindDefinition | undefined;
  /** Validate + coerce a raw located-fact `value` for a kind id. */
  parseValue(id: string, raw: unknown): RegistryParseResult<unknown>;
  /**
   * True when `bodyLocationId` is one of the kind's allowed locations or a
   * DESCENDANT of one — a scar allowed on `arms` is legal on `forearms`,
   * because the body tree already says a forearm is part of an arm.
   */
  allowsBodyLocation(id: string, bodyLocationId: string): boolean;
}

function buildAppearanceFeatureKindRegistry(
  definitions: readonly AppearanceFeatureKindDefinition[],
): AppearanceFeatureKindRegistry {
  const core = buildRegistryCore<AppearanceFeatureKindDefinition, unknown>({
    definitions,
    valueSchemaFor: (definition) => definition.valueSchema,
    idLabel: "appearance feature kind",
  });

  const allowedIndex = new Map<string, ReadonlySet<string>>();
  for (const definition of definitions) {
    allowedIndex.set(
      definition.id,
      new Set(definition.allowedBodyLocations.flatMap((id) => [...bodyLocationRegistry.expand(id)])),
    );
  }

  return {
    definitions,
    byId: core.byId,
    parseValue: core.parseValue,
    allowsBodyLocation: (id, bodyLocationId) => allowedIndex.get(id)?.has(bodyLocationId) ?? false,
  };
}

export const appearanceFeatureKindRegistry = buildAppearanceFeatureKindRegistry(appearanceFeatureKindDefinitions);
