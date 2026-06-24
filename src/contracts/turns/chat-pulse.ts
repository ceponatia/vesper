import { z } from "zod";

/**
 * The character-chat reaction pulse (character-chat-state.spec.md §4): one small
 * structured agent call after a chat reply settles. It does ONLY the cheap
 * generative parts — classify the player's act into the interaction-concept
 * vocabulary and refresh the "what's on their mind" note. The deterministic §6
 * curve (engine/chat-state.ts) turns the classified act into every number, so the
 * schema carries no deltas. Fully `.default()`/`.catch()`ed so a parsed-empty
 * object IS the degraded fallback (docs/resilience.md §3).
 *
 * The character-chat light-state char caps live here, not engine/constants.ts:
 * `src/contracts` is pure and importable by both the server engine AND the client
 * chat UI (which may not import server modules), so a single source for the caps
 * keeps the schema, the route validation, and the composer textarea in lockstep.
 */

/** Cap on the pulse-written mindNote (1–3 sentences of disposition). */
export const CHAT_MIND_NOTE_MAX_CHARS = 320;
/** Cap on the player-set per-chat premise (a scenario, not a bio). */
export const CHAT_PREMISE_MAX_CHARS = 600;

export const chatPulseSchema = z.object({
  /** The player's primary act toward the character, classified into a concept id; null ⇒ none. */
  playerAct: z.object({ concept: z.string().min(1) }).nullable().catch(null).default(null),
  /** Refreshed 1–3 sentence "what's on their mind"; "" ⇒ keep the prior note. */
  mindNote: z.string().max(CHAT_MIND_NOTE_MAX_CHARS).catch("").default(""),
});

export type ChatPulse = z.infer<typeof chatPulseSchema>;

/**
 * Degraded default (docs/resilience.md §1/§3): no classified act, no note refresh.
 * The turn keeps the reply and persists drift-only state — still "alive", just not
 * conversation-reactive that exchange.
 */
export function degradedChatPulse(): ChatPulse {
  return { playerAct: null, mindNote: "" };
}

/**
 * Last-turn debug trace persisted beside the state row for the state-tools modal
 * (spec §4). The "why" is derived deterministically from the concept + valence +
 * the §6 curve, not authored by the model. Parsed defensively from the jsonb
 * column (`parseOr(chatPulseTraceSchema, …, emptyChatPulseTrace())`).
 */
export const chatPulseTraceSchema = z.object({
  /** Concept the pulse classified the player's act into (null ⇒ none recognised). */
  concept: z.string().nullable().catch(null).default(null),
  /** Resolved valence against the character's preferences (null ⇒ no match). */
  valence: z.enum(["like", "dislike"]).nullable().catch(null).default(null),
  /** Signed affinity move applied this exchange (post per-turn clamp). */
  affinityDelta: z.number().catch(0).default(0),
  /** Signed mood-meter move applied this exchange (0–1 scale). */
  moodDelta: z.number().catch(0).default(0),
  /** Which state fields the pulse changed (affinity / mood / mindNote). */
  changed: z.array(z.string()).catch([]).default([]),
  /** True when the pulse degraded to drift-only (timeout / parse failure / demo). */
  degraded: z.boolean().catch(false).default(false),
  /** Degradation diagnostic code, when degraded. */
  diagnostic: z.string().optional(),
});

export type ChatPulseTrace = z.infer<typeof chatPulseTraceSchema>;

export function emptyChatPulseTrace(): ChatPulseTrace {
  return chatPulseTraceSchema.parse({});
}
