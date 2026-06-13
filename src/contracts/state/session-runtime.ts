import { z } from "zod";

export const storyThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(""),
  status: z.enum(["open", "cooling", "resolved", "archived"]).default("open"),
  source: z.enum(["anchor", "emergent", "player"]).default("emergent"),
  openedAtTurn: z.number().int().min(0).default(0),
  lastTouchedTurn: z.number().int().min(0).default(0),
  touchCount: z.number().int().min(0).default(0),
});

export type StoryThread = z.infer<typeof storyThreadSchema>;

export const sessionRuntimeSchema = z.object({
  storyThreads: z.array(storyThreadSchema).default([]),
  visitedLocationIds: z.array(z.string()).default([]),
  encounteredParticipantIds: z.array(z.string()).default([]),
  unlockedLoreIds: z.array(z.string()).default([]),
  /** participantId → last turn number with a *targeted* interaction (intent target, companion speech, or addressed while co-located) — feeds follow-score recency. */
  lastInteractedTurn: z.record(z.string(), z.number().int()).default({}),
  /** Session clock-minutes up to which affinity decay has been applied (whole weeks only). Absent until the first post-turn merge seeds it. */
  lastAffinityDecayAt: z.number().int().min(0).optional().catch(undefined),
  flags: z.record(z.string(), z.boolean()).default({}),
});

export type SessionRuntime = z.infer<typeof sessionRuntimeSchema>;

export function emptySessionRuntime(): SessionRuntime {
  return sessionRuntimeSchema.parse({});
}
