import { z } from "zod";
import { attributeIdPatternSchema, type AttributeDefinition, type AttributeMutability } from "./types";
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
  // Leaf-.catch (docs/resilience.md §3): a malformed source degrades to the low-precedence
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
 * Prompt-side "none" elision — the single rule every prompt builder (image,
 * narrator, chat) runs a resolved value through before rendering it. A `"none"`
 * (no piercings, no freckles, no glow) is DROPPED unless the definition opts in
 * via `renderNoneInPrompts`: "nose piercings: none" both spends tokens and
 * plants the very noun we don't want the model dwelling on — image models
 * sometimes paint the mentioned feature anyway. Enum-list values have their
 * "none" members filtered out; a list left empty elides whole. Storage and
 * editing are untouched — a stored "none" still pins the attribute down in the
 * editor (unlike *unset*, which invites the forge/narrator to infer).
 *
 * Returns the (possibly filtered) value, or null when nothing renderable remains.
 */
export function promptValueWithNoneElided(
  def: Pick<AttributeDefinition, "renderNoneInPrompts">,
  value: AttributeValue["value"],
): AttributeValue["value"] | null {
  if (def.renderNoneInPrompts) return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "none" ? null : value;
  if (Array.isArray(value)) {
    const kept = value.filter((v) => v.trim().toLowerCase() !== "none");
    return kept.length > 0 ? kept : null;
  }
  return value;
}

/**
 * Non-visual attributes never belong in an image prompt — an image can't depict
 * how someone sounds, smells, or how sensitive they are. `kind: "sensory"` is the
 * auditory/olfactory/tactile-response set (voice pitch/timbre/cadence, baseline
 * scent, intimate scent/taste, and per-region sensitivity), so every image prompt
 * builder drops it. (Intimate sensory anatomy is additionally gated by the
 * exposure predicates, which stay lane-side.)
 */
export function isNonVisualAttribute(def: AttributeDefinition): boolean {
  return def.kind === "sensory";
}

/** A registry vocabulary member as a readable word — `tied_back` → `tied back`. */
export function humanizeVocabularyValue(value: string): string {
  return value.replaceAll("_", " ").trim();
}

/**
 * Value-only prompt token for an attribute (no label noun) — the "none" elision
 * applied, enum members humanized, numbers carrying their unit. `""` when nothing
 * renderable remains. Shared by the grouped avatar prompt, the digest clause
 * resolver and the character image adapter, so one rule owns how a stored
 * vocabulary member becomes prompt text.
 */
export function formatAttributeValue(def: AttributeDefinition, value: string | string[] | number | boolean): string {
  // "none" is elided unless the definition opts in (see promptValueWithNoneElided) —
  // "piercings: none" plants the very noun the image model then paints anyway.
  const rendered = promptValueWithNoneElided(def, value);
  if (rendered === null) return "";
  if (typeof rendered === "boolean") return rendered ? humanizeVocabularyValue(def.label).toLowerCase() : "";
  if (typeof rendered === "number") return `${rendered}${def.unit ? ` ${def.unit}` : ""}`;
  return Array.isArray(rendered) ? rendered.map(humanizeVocabularyValue).join(", ") : humanizeVocabularyValue(rendered);
}

/** Self-describing `Label: value` form (scene appearance summaries, digest fact values). */
export function formatAttribute(def: AttributeDefinition, value: string | string[] | number | boolean): string {
  if (typeof value === "boolean") return value ? def.label : "";
  const text = formatAttributeValue(def, value);
  return text ? `${def.label}: ${text}` : "";
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
