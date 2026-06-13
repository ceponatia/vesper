import { z } from "zod";
import { attributeIdPatternSchema } from "./types";

/**
 * Source provenance for attribute values, ordered by precedence (low → high
 * within resolveAttributes). Extensible: add a value, slot it into
 * SOURCE_PRECEDENCE, update docs/contracts.md.
 */
export const attributeValueSources = [
  "base",
  "creation",
  "narrative",
  "condition",
  "injury",
  "item",
  "magic",
  "environment",
  "manual",
] as const;

export const attributeValueSourceSchema = z.enum(attributeValueSources);
export type AttributeValueSource = z.infer<typeof attributeValueSourceSchema>;

/** Higher wins when two values target the same attribute id. */
export const SOURCE_PRECEDENCE: Record<AttributeValueSource, number> = {
  base: 0,
  creation: 1,
  narrative: 2,
  condition: 3,
  injury: 3,
  item: 3,
  magic: 3,
  environment: 3,
  manual: 4,
};

export const attributeValueSchema = z.object({
  id: attributeIdPatternSchema,
  value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]),
  source: attributeValueSourceSchema,
  sourceId: z.string().min(1).optional(),
  note: z.string().optional(),
});

export type AttributeValue = z.infer<typeof attributeValueSchema>;

/**
 * Effective attribute view: overlays shadow base values by id, last-write-wins
 * by source precedence (ties: later entry wins).
 */
export function resolveAttributes(base: readonly AttributeValue[], overlays: readonly AttributeValue[]): AttributeValue[] {
  const effective = new Map<string, AttributeValue>();
  for (const value of [...base, ...overlays]) {
    const current = effective.get(value.id);
    if (!current || SOURCE_PRECEDENCE[value.source] >= SOURCE_PRECEDENCE[current.source]) {
      effective.set(value.id, value);
    }
  }
  return [...effective.values()];
}
