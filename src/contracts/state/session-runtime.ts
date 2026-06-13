import { z } from "zod";

/**
 * An active comms link the player holds (presence-and-perception-spec §comms):
 * a call or text with an NPC who is otherwise absent. While the link is open the
 * NPC is `comms`-present — they may speak, but are not physically here. Opened and
 * closed by the simulant's `commsEvents`; persists in runtime across turns.
 */
export const commsLinkSchema = z.object({
  kind: z.enum(["call", "text"]),
  withParticipantId: z.string().min(1),
  /** Session clock-minutes when the link opened. */
  since: z.number().int().min(0).default(0),
});
export type CommsLink = z.infer<typeof commsLinkSchema>;

/**
 * An NPC-initiated message awaiting the player. The renderer (pending-messages
 * context line) ships in v1; population by the director / world-tick is phase 4
 * (NPC-initiated comms), so this is an empty seam until then.
 */
export const pendingCommsSchema = z.object({
  fromParticipantId: z.string().min(1),
  kind: z.enum(["call", "text"]),
  gist: z.string().default(""),
  urgency: z.enum(["low", "normal", "high"]).catch("normal").default("normal"),
});
export type PendingComms = z.infer<typeof pendingCommsSchema>;

/**
 * One accumulated entry on a thread — a major beat that contributed to it (new
 * evidence, a meaningful statement, an event). The developments[] log is the
 * "everything gleaned so far" the detail modal renders; `summary` stays the
 * rolling synopsis. `kind` is a soft tag for display only (.catch keeps a bad
 * value from rejecting the entry). See docs/story-threads.md.
 */
export const storyThreadDevelopmentSchema = z.object({
  turn: z.number().int().min(0).default(0),
  text: z.string().min(1),
  kind: z.enum(["evidence", "statement", "event", "lead", "update"]).catch("update").default("update"),
});

export type StoryThreadDevelopment = z.infer<typeof storyThreadDevelopmentSchema>;

export const storyThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Rolling synopsis (current state) — what the narrator sees; revised as the thread develops. */
  summary: z.string().default(""),
  /**
   * investigation = a question/problem/goal that can be resolved (tracks
   * evidence + closeConditions); ongoing = a standing topic only ever updated,
   * never auto-resolved (e.g. a character's social life). .catch keeps a legacy
   * or bad value from rejecting the thread (docs/story-threads.md).
   */
  kind: z.enum(["investigation", "ongoing"]).catch("investigation").default("investigation"),
  status: z.enum(["open", "cooling", "resolved", "archived"]).default("open"),
  source: z.enum(["anchor", "emergent", "player"]).default("emergent"),
  /** investigation: the core question/goal in one line — anchors dedup + the modal headline. */
  question: z.string().default(""),
  /** investigation: the events that would close it — shown in the modal, checked by the director. */
  closeConditions: z.array(z.string()).default([]),
  /** Accumulated major beats, oldest→newest (capped in the merge). */
  developments: z.array(storyThreadDevelopmentSchema).default([]),
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
  /** Active player comms links (presence-spec §comms). */
  commsLinks: z.array(commsLinkSchema).default([]),
  /** NPC-initiated messages awaiting the player (phase-4 populates; renderer ships v1). */
  pendingComms: z.array(pendingCommsSchema).default([]),
  flags: z.record(z.string(), z.boolean()).default({}),
});

export type SessionRuntime = z.infer<typeof sessionRuntimeSchema>;

export function emptySessionRuntime(): SessionRuntime {
  return sessionRuntimeSchema.parse({});
}
