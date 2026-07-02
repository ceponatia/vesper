import { z } from "zod";
import { attributeIdPatternSchema, type AttributeMutability } from "./types";
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
  // Leaf-.catch (resilience §3): a malformed source degrades to the low-precedence
  // "creation" (it can never escalate to manual/magic authority) instead of
  // rejecting the whole embedding profile at the JSONB boundary.
  source: attributeValueSourceSchema.catch("creation"),
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

/**
 * May an overlay from `source` change an attribute of this `mutability`?
 *
 * Inherent traits (eye color, gender, apparent age, species presentation, bone
 * structure) accept only deliberate, high-authority changes — a human author
 * (`manual`) or an explicit supernatural transformation (`magic`). Plain narrative
 * drift and every other source are rejected, so an LLM over-reading prose ("her eyes
 * flashed green") can't silently rewrite a defining trait. Mutable attributes accept
 * any source. Enforced at the write boundary (engine/merge.ts); the resolver stays a
 * pure last-write-wins function.
 *
 * `magic` is admitted but never produced today (the transformation seam is future
 * work) — it future-proofs the policy so a real transformation is a later data/flag
 * change, not a redesign.
 */
export function overlaySourceMayChange(mutability: AttributeMutability, source: AttributeValueSource): boolean {
  if (mutability === "inherent") return source === "manual" || source === "magic";
  return true;
}
