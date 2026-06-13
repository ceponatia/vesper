import { z } from "zod";
import { factDraftSchema } from "../facts/taxonomy";
import { conditionSeveritySchema } from "../conditions/condition";
import { exposureMaskSchema, defaultExposureMask } from "../state/brief";

/**
 * Post-turn agent output schemas (docs/turn-engine.md §Post-turn agents).
 * Field-level rules: every field .default()ed so the parsed-empty object IS
 * the degraded fallback; entities referenced by display name, never ids;
 * leaf enums .catch()ed so one bad field doesn't reject the object.
 */

export const itemEventActionSchema = z.enum([
  "wear",
  "remove",
  "pick_up",
  "drop",
  "place",
  "store_in",
  "take_from",
  "open",
  "close",
  "alter",
]);

export const simulantResultSchema = z.object({
  minutesAdvanced: z.number().int().catch(30).default(30),
  movements: z
    .array(
      z.object({
        participantName: z.string().min(1),
        toLocationName: z.string().min(1),
        reason: z.string().optional(),
      }),
    )
    .default([]),
  itemEvents: z
    .array(
      z.object({
        action: itemEventActionSchema,
        itemName: z.string().min(1),
        byName: z.string().optional(),
        locationName: z.string().optional(),
        containerName: z.string().optional(),
        stateNote: z.string().optional(),
      }),
    )
    .default([]),
  meterAdjustments: z
    .array(
      z.object({
        participantName: z.string().min(1),
        meterId: z.string().min(1),
        delta: z.number().min(-1).max(1).catch(0),
        reason: z.string().optional(),
      }),
    )
    .default([]),
  conditionEvents: z
    .array(
      z.object({
        op: z.enum(["add", "end"]),
        participantName: z.string().min(1),
        label: z.string().min(1),
        severity: conditionSeveritySchema.optional().catch(undefined),
        durationMinutes: z.number().int().positive().optional().catch(undefined),
        promptHint: z.string().optional(),
      }),
    )
    .default([]),
  attributeChanges: z
    .array(
      z.object({
        participantName: z.string().min(1),
        attributeId: z.string().min(1),
        value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]),
        note: z.string().optional(),
      }),
    )
    .default([]),
  activityUpdates: z
    .array(
      z.object({
        participantName: z.string().min(1),
        activity: z.string().min(1),
        posture: z.string().optional(),
      }),
    )
    .default([]),
  /**
   * Relationship movement this turn (cast-tiers-and-affinity-spec): fromName's
   * feeling toward towardName changed. Deltas are clamped tiny in the reducer
   * (story speed, not whiplash). When fromName is the player, the merge
   * records it as the NPC's *perceived* affinity from the player (decision 41).
   */
  affinityAdjustments: z
    .array(
      z.object({
        fromName: z.string().min(1),
        towardName: z.string().min(1),
        delta: z.number().catch(0),
        reason: z.string().optional(),
      }),
    )
    .default([]),
});

export type SimulantResult = z.infer<typeof simulantResultSchema>;

export const archivistResultSchema = z.object({
  episodeSummary: z.string().default(""),
  facts: z.array(factDraftSchema).default([]),
  supersedeHints: z
    .array(z.object({ factIndex: z.number().int().min(0), oldFactText: z.string().min(1) }))
    .default([]),
});

export type ArchivistResult = z.infer<typeof archivistResultSchema>;

export const continuityResultSchema = z.object({
  violations: z
    .array(
      z.object({
        subject: z.string().min(1),
        claim: z.string().min(1),
        canonical: z.string().min(1),
        severity: z.enum(["minor", "major"]).catch("minor"),
      }),
    )
    .default([]),
  normBreaches: z
    .array(
      z.object({
        normRule: z.string().min(1),
        byName: z.string().min(1),
        witnessNames: z.array(z.string()).default([]),
        suggestedReaction: z.string().default(""),
      }),
    )
    .default([]),
  driftNotes: z.array(z.string()).default([]),
});

export type ContinuityResult = z.infer<typeof continuityResultSchema>;

export const directorResultSchema = z.object({
  sceneSummary: z.string().default(""),
  storySoFar: z.string().default(""),
  characterNotes: z.array(z.string()).default([]),
  directives: z.array(z.string()).default([]),
  memoryQueries: z.array(z.string()).default([]),
  exposure: exposureMaskSchema.default(defaultExposureMask()),
  threadSignals: z
    .object({
      touch: z.array(z.object({ id: z.string().optional(), title: z.string(), summary: z.string().optional() })).default([]),
      propose: z.array(z.object({ title: z.string().min(1), summary: z.string().default("") })).default([]),
      resolve: z.array(z.string()).default([]),
    })
    .default({ touch: [], propose: [], resolve: [] }),
  imageMoment: z
    .object({ worthIt: z.boolean().default(false), description: z.string().default("") })
    .optional(),
});

export type DirectorResult = z.infer<typeof directorResultSchema>;

export interface AgentResults {
  simulant: SimulantResult | null;
  archivist: ArchivistResult | null;
  continuity: ContinuityResult | null;
  director: DirectorResult | null;
}
