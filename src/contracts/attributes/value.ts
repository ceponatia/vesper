import { z } from "zod";
import { attributeIdPatternSchema } from "./types";
import {
  provenanceSourceSchema,
  provenanceSources,
  resolveProvenance,
  SOURCE_PRECEDENCE,
  type ProvenanceSource,
} from "../registry";

/**
 * Attribute value provenance + precedence now ride the shared registry spine
 * (`contracts/registry`), so attributes and personality traits resolve overlays
 * through one implementation. These re-exports keep the attribute-facing names
 * stable for existing callers.
 */
export const attributeValueSources = provenanceSources;
export const attributeValueSourceSchema = provenanceSourceSchema;
export type AttributeValueSource = ProvenanceSource;
export { SOURCE_PRECEDENCE };

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
 * by source precedence (ties: later entry wins). A thin alias over the shared
 * `resolveProvenance`.
 */
export function resolveAttributes(base: readonly AttributeValue[], overlays: readonly AttributeValue[]): AttributeValue[] {
  return resolveProvenance(base, overlays);
}
