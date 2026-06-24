import { z } from "zod";
import { atmosphereLabelSchema } from "../mood/atmosphere";

export const exposureMaskSchema = z.object({
  appearance: z.enum(["ambient", "close", "intimate"]).catch("ambient"),
  scent: z.enum(["none", "ambient", "close", "intimate"]).catch("none"),
  touch: z.enum(["none", "close", "intimate"]).catch("none"),
  // Taste is the most intimate sense — earned only at intimate contact (a kiss,
  // mouth on skin). `.catch` makes briefs persisted before this axis parse with
  // taste:"none", so no migration and today's behavior by default.
  taste: z.enum(["none", "close", "intimate"]).catch("none"),
});

export type ExposureMask = z.infer<typeof exposureMaskSchema>;

export function defaultExposureMask(): ExposureMask {
  return { appearance: "ambient", scent: "none", touch: "none", taste: "none" };
}

export const nextTurnBriefSchema = z.object({
  sceneSummary: z.string().default("The story begins."),
  storySoFar: z.string().default(""),
  characterNotes: z.array(z.string()).default([]),
  directives: z.array(z.string()).default([]),
  memoryQueries: z.array(z.string()).default([]),
  exposure: exposureMaskSchema.default(defaultExposureMask()),
  /**
   * The active scene's emotional tone (scene-atmosphere.spec.md) — a *read* the mood
   * drift and (later) the avatar consume. Defaulted so briefs persisted before this
   * field parse unchanged (⇒ `calm` ⇒ a zero mood shift).
   */
  atmosphere: atmosphereLabelSchema.default("calm"),
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
