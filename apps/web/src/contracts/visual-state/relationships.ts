import { z } from "zod";
import { unitIntervalSchema } from "../affordances/core";

/**
 * Typed composition between features (visual-state.spec.md §Composition).
 *
 * Composition keeps retained features TRACEABLE instead of flattening the
 * layers into one winner: wetness modifies a hairstyle, a wig replaces natural
 * hair as the visible surface, a hat covers part of it, smudging modifies
 * makeup, a coat occludes a shirt, water beading derives from garment material
 * and wetness. The covered feature stays in the snapshot — an image render
 * still needs it to hold the character together — while observer selection
 * respects the coverage.
 *
 * The RESOLVER is not here. Slice 1 owns the shape so every adapter can emit
 * relationships from the first day; resolving targets, detecting cycles, and
 * suppressing broken links is the composition slice's work.
 */
export const visualStateRelationshipSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("modifies"), targetKey: z.string().min(1) }),
  z.object({ kind: z.literal("replaces_visible_surface"), targetKey: z.string().min(1) }),
  z.object({ kind: z.literal("covers"), targetKey: z.string().min(1), degree: unitIntervalSchema }),
  z.object({ kind: z.literal("occludes"), targetKey: z.string().min(1), degree: unitIntervalSchema }),
  z.object({ kind: z.literal("attached_to"), targetKey: z.string().min(1) }),
  z.object({ kind: z.literal("derived_from"), targetKey: z.string().min(1) }),
]);

export type VisualStateRelationship = z.infer<typeof visualStateRelationshipSchema>;
