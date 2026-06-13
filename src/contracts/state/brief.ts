import { z } from "zod";

export const exposureMaskSchema = z.object({
  appearance: z.enum(["ambient", "close", "intimate"]).catch("ambient"),
  scent: z.enum(["none", "ambient", "close", "intimate"]).catch("none"),
  touch: z.enum(["none", "close", "intimate"]).catch("none"),
});

export type ExposureMask = z.infer<typeof exposureMaskSchema>;

export function defaultExposureMask(): ExposureMask {
  return { appearance: "ambient", scent: "none", touch: "none" };
}

export const nextTurnBriefSchema = z.object({
  sceneSummary: z.string().default("The story begins."),
  storySoFar: z.string().default(""),
  characterNotes: z.array(z.string()).default([]),
  directives: z.array(z.string()).default([]),
  memoryQueries: z.array(z.string()).default([]),
  exposure: exposureMaskSchema.default(defaultExposureMask()),
  droppedEvents: z.array(z.string()).default([]),
  /**
   * Off-screen NPC movement staged for the next narration (schedule ticks
   * into/out of the player's location): "Mara arrived from the market." /
   * "Tom left toward the docks." Self-expiring — rebuilt every merge.
   * Defaulted so briefs persisted before this field parse unchanged.
   */
  arrivals: z.array(z.string()).default([]),
  departures: z.array(z.string()).default([]),
});

export type NextTurnBrief = z.infer<typeof nextTurnBriefSchema>;

export function emptyBrief(): NextTurnBrief {
  return nextTurnBriefSchema.parse({});
}
