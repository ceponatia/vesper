import { z, type ZodType } from "zod";
import type { AttributeCategory } from "./category-ids";
import type { AttributeDefinition, AttributeGroup } from "./types";
import { buildRegistryCore } from "../registry";

export interface AttributeParseFailure {
  ok: false;
  issues: string[];
}

export interface AttributeParseSuccess {
  ok: true;
  value: string | string[] | number | boolean;
}

export type AttributeParseResult = AttributeParseSuccess | AttributeParseFailure;

export interface AttributeRegistry {
  readonly definitions: readonly AttributeDefinition[];
  byId(id: string): AttributeDefinition | undefined;
  forCategory(category: AttributeCategory): readonly AttributeDefinition[];
  forBodyLocation(bodyLocationId: string): readonly AttributeDefinition[];
  /** Resolve a free-text mention ("ginger", "freckled") to candidate attribute ids. */
  resolveAlias(text: string): readonly AttributeDefinition[];
  /** Validate + coerce a raw value for an attribute id. */
  parseValue(id: string, raw: unknown): AttributeParseResult;
}

function valueSchemaFor(def: AttributeDefinition): ZodType<string | string[] | number | boolean> {
  switch (def.valueType) {
    case "enum": {
      const values = def.allowedValues ?? [];
      return z.enum(values as [string, ...string[]]);
    }
    case "enum_list": {
      const values = def.allowedValues ?? [];
      return z.array(z.enum(values as [string, ...string[]])).min(1);
    }
    case "number": {
      let schema = z.number();
      if (def.min !== undefined) schema = schema.min(def.min);
      if (def.max !== undefined) schema = schema.max(def.max);
      return schema;
    }
    case "text":
      return z.string().min(1).max(500);
    case "flag":
      return z.boolean();
  }
}

export function buildRegistry(groups: readonly AttributeGroup[]): AttributeRegistry {
  const definitions = groups.flatMap((g) => g.definitions);
  // Index + value-parser come from the shared registry spine; the
  // attribute-specific lookups (category, body location, alias) are layered on.
  const core = buildRegistryCore<AttributeDefinition, string | string[] | number | boolean>({
    definitions,
    valueSchemaFor,
    idLabel: "attribute",
    validate: (def) => {
      if ((def.valueType === "enum" || def.valueType === "enum_list") && (def.allowedValues?.length ?? 0) < 2) {
        throw new Error(`Attribute ${def.id} is ${def.valueType} but has fewer than 2 allowedValues`);
      }
    },
  });

  const aliasIndex = new Map<string, AttributeDefinition[]>();
  for (const def of definitions) {
    for (const alias of def.aliases ?? []) {
      const key = alias.toLowerCase();
      const list = aliasIndex.get(key) ?? [];
      list.push(def);
      aliasIndex.set(key, list);
    }
  }

  return {
    definitions,
    byId: core.byId,
    forCategory: (category) => definitions.filter((d) => d.category === category),
    forBodyLocation: (bodyLocationId) => definitions.filter((d) => d.bodyLocationId === bodyLocationId),
    resolveAlias: (text) => aliasIndex.get(text.toLowerCase()) ?? [],
    parseValue: core.parseValue,
  };
}
