import type { ZodType } from "zod";

/**
 * The shared registry spine (docs/contracts/attributes.md §The shared registry spine). Both the character
 * attribute registry and the personality trait registry are an id-indexed bundle
 * of definitions with per-id value validation; this module owns that core — the
 * duplicate-id guard and the value parser — so neither system reimplements it
 * (jscpd-safe). Each caller layers its own surface on top (attributes add
 * category/body-location/alias lookups; traits add band readout + lexicon).
 */

export interface RegistryParseFailure {
  ok: false;
  issues: string[];
}

export interface RegistryParseSuccess<V> {
  ok: true;
  value: V;
}

export type RegistryParseResult<V> = RegistryParseSuccess<V> | RegistryParseFailure;

/** Minimal shape every registered definition shares. */
export interface RegistryDefinition {
  id: string;
}

/** The core surface shared by the attribute and trait registries. */
export interface RegistryCore<Def extends RegistryDefinition, V> {
  readonly definitions: readonly Def[];
  byId(id: string): Def | undefined;
  /** Validate + coerce a raw value for a definition id. */
  parseValue(id: string, raw: unknown): RegistryParseResult<V>;
}

export interface RegistryConfig<Def extends RegistryDefinition, V> {
  definitions: readonly Def[];
  /** The Zod schema that validates + coerces a raw value for a given definition. */
  valueSchemaFor: (def: Def) => ZodType<V>;
  /** Extra per-definition invariant checks; throw to reject the whole registry. */
  validate?: (def: Def) => void;
  /** Noun used in duplicate/unknown-id error messages ("attribute", "trait"). */
  idLabel?: string;
}

/**
 * Build the shared registry core: an id index with duplicate detection plus a
 * per-id value parser. Definition-shape-specific lookups are added by the caller
 * around this return value.
 */
export function buildRegistryCore<Def extends RegistryDefinition, V>(
  config: RegistryConfig<Def, V>,
): RegistryCore<Def, V> {
  const label = config.idLabel ?? "registry";
  const byId = new Map<string, Def>();
  const valueSchemas = new Map<string, ZodType<V>>();

  for (const def of config.definitions) {
    if (byId.has(def.id)) throw new Error(`Duplicate ${label} id: ${def.id}`);
    config.validate?.(def);
    byId.set(def.id, def);
    valueSchemas.set(def.id, config.valueSchemaFor(def));
  }

  return {
    definitions: config.definitions,
    byId: (id) => byId.get(id),
    parseValue: (id, raw) => {
      const schema = valueSchemas.get(id);
      if (!schema) return { ok: false, issues: [`unknown ${label} id: ${id}`] };
      const result = schema.safeParse(raw);
      if (result.success) return { ok: true, value: result.data };
      return { ok: false, issues: result.error.issues.map((i) => i.message) };
    },
  };
}
