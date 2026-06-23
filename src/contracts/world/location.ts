import { z } from "zod";
import { locationScaleSchema } from "../perception/proximity";

/**
 * Ambient sensory blob on a location ({ scent, sound, light }). Canonical home —
 * server (API input, session bundle) and client both import this one definition.
 */
export const ambientSchema = z.object({
  scent: z.string().max(500).optional(),
  sound: z.string().max(500).optional(),
  light: z.string().max(500).optional(),
});
export type Ambient = z.infer<typeof ambientSchema>;

/**
 * A world's self-contained copy of a library location (world-instances.plan.md):
 * the full effective location, baked at materialize time and stored in
 * `world_locations.snapshot`. The world owns this copy, so it survives the source
 * library row being edited or deleted. `area` is world-placement data (map
 * grouping); `affordances` is left lenient (`unknown[]`) — its element shape is
 * validated downstream where it is consumed.
 */
export const locationSnapshotSchema = z.object({
  name: z.string().default(""),
  description: z.string().default(""),
  ambient: ambientSchema.default({}),
  scale: locationScaleSchema.catch("room").default("room"),
  area: z.string().nullable().default(null),
  affordances: z.array(z.unknown()).default([]),
  tags: z.array(z.string()).default([]),
});
export type LocationSnapshot = z.infer<typeof locationSnapshotSchema>;

export function emptyLocationSnapshot(): LocationSnapshot {
  return locationSnapshotSchema.parse({});
}
