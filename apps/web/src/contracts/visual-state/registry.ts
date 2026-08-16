import { buildRegistryCore, type RegistryParseResult } from "../registry";
import type { VisualStateKindDefinition } from "./definitions";
import { visualStateKindDefinitions } from "./kinds";
import type { VisualStateLocusKind } from "./vocabulary";

/**
 * The visual-state kind registry — the shared registry spine
 * (`contracts/registry`) plus the one lookup this family needs beyond an id
 * index: "may a feature of this kind hang HERE?".
 *
 * Same idiom as `appearanceFeatureKindRegistry`: the core owns duplicate-id
 * detection and per-id value parsing, the wrapper adds the domain lookup.
 */

export interface VisualStateKindRegistry {
  readonly definitions: readonly VisualStateKindDefinition[];
  byId(id: string): VisualStateKindDefinition | undefined;
  /** Validate + coerce a raw feature `value` for a kind id. */
  parseValue(id: string, raw: unknown): RegistryParseResult<unknown>;
  /** True when the kind declares this locus kind. Unknown kind ⇒ false. */
  allowsLocus(id: string, locusKind: VisualStateLocusKind): boolean;
}

function buildVisualStateKindRegistry(
  definitions: readonly VisualStateKindDefinition[],
): VisualStateKindRegistry {
  const core = buildRegistryCore<VisualStateKindDefinition, unknown>({
    definitions,
    valueSchemaFor: (definition) => definition.valueSchema,
    idLabel: "visual state kind",
  });

  const allowedIndex = new Map<string, ReadonlySet<VisualStateLocusKind>>();
  for (const definition of definitions) {
    allowedIndex.set(definition.id, new Set(definition.allowedLoci));
  }

  return {
    definitions,
    byId: core.byId,
    parseValue: core.parseValue,
    allowsLocus: (id, locusKind) => allowedIndex.get(id)?.has(locusKind) ?? false,
  };
}

export const visualStateKindRegistry = buildVisualStateKindRegistry(visualStateKindDefinitions);
