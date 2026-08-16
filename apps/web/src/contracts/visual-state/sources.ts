import { z } from "zod";
import { appearanceSourceRefSchema, type AppearanceSourceRef } from "../appearance-features";

/**
 * Which owner a visual feature was read from (visual-state.spec.md §Loci and
 * sources) — provenance, never a copy of the owner's value.
 *
 * SPEC DEVIATION, recorded here because it is load-bearing. The spec writes
 * this union as `AppearanceSourceRef | { kind: "presentation"; presentationId }
 * | { kind: "body_condition"; conditionId } | …`, which cannot be built: the
 * appearance union already owns `{ kind: "presentation"; itemId }` and
 * `{ kind: "condition"; conditionKey }`, so two arms would claim one
 * discriminator with different shapes. Widening the appearance union instead is
 * not an option — it is a frozen seam whose two exhaustive `switch`es live in
 * the recognition layer.
 *
 * So appearance provenance is NESTED under one `appearance` arm rather than
 * spread. That keeps the frozen union untouched, makes "this fact came through
 * the truth-level appearance projection" explicit, and leaves every new arm the
 * spec names available at its own discriminator.
 */
export const visualStateSourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("appearance"), ref: appearanceSourceRefSchema }),
  z.object({
    kind: z.literal("body_surface"),
    subjectId: z.string().min(1),
    locationId: z.string().min(1),
  }),
  z.object({ kind: z.literal("body_condition"), conditionId: z.string().min(1) }),
  z.object({ kind: z.literal("garment"), garmentInstanceId: z.string().min(1) }),
  z.object({
    kind: z.literal("garment_part"),
    garmentInstanceId: z.string().min(1),
    partId: z.string().min(1),
  }),
  z.object({ kind: z.literal("presentation"), presentationId: z.string().min(1) }),
  z.object({ kind: z.literal("item_locus"), itemInstanceId: z.string().min(1) }),
  z.object({ kind: z.literal("scene_relation"), relationId: z.string().min(1) }),
  z.object({ kind: z.literal("affordance"), observationKey: z.string().min(1) }),
]);

export type VisualStateSourceRef = z.infer<typeof visualStateSourceRefSchema>;

/** The appearance projection's own provenance, in its own vocabulary. */
function appearanceSourceKey(ref: AppearanceSourceRef): string {
  switch (ref.kind) {
    case "attribute":
      return `attribute:${ref.attributeId}`;
    case "located_fact":
      return `located_fact:${ref.factId}`;
    case "anatomy":
      return `anatomy:${ref.locusKey}`;
    case "condition":
      return `condition:${ref.conditionKey}`;
    case "presentation":
      return `presentation:${ref.itemId}`;
  }
}

/**
 * A flat, stable string for one source — the form evidence entries and
 * diagnostic context carry. Never parsed back into parts.
 */
export function visualStateSourceKey(ref: VisualStateSourceRef): string {
  switch (ref.kind) {
    case "appearance":
      return `appearance:${appearanceSourceKey(ref.ref)}`;
    case "body_surface":
      return `body_surface:${ref.subjectId}:${ref.locationId}`;
    case "body_condition":
      return `body_condition:${ref.conditionId}`;
    case "garment":
      return `garment:${ref.garmentInstanceId}`;
    case "garment_part":
      return `garment_part:${ref.garmentInstanceId}:${ref.partId}`;
    case "presentation":
      return `presentation:${ref.presentationId}`;
    case "item_locus":
      return `item_locus:${ref.itemInstanceId}`;
    case "scene_relation":
      return `scene_relation:${ref.relationId}`;
    case "affordance":
      return `affordance:${ref.observationKey}`;
  }
}
