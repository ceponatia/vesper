import { z } from "zod";
import { emotionLabelEnum } from "../mood/emotion-label";

/**
 * The character-chat reaction pulse: one small
 * structured agent call after a chat reply settles. It does ONLY the cheap
 * generative parts — classify the player's act into the interaction-concept
 * vocabulary and refresh the "what's on their mind" note. The deterministic
 * response curve (engine/chat-state/pulse-rules.ts) turns the classified act into every number, so the
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
/** Cap on the pulse-proposed feeling cause phrase. */
export const CHAT_FEELING_CAUSE_MAX = 120;
/** Cap on the player-set per-chat premise (a scenario, not a bio). */
export const CHAT_PREMISE_MAX_CHARS = 600;

/**
 * **Action chips**: a chip tap is a narrated one-beat
 * exchange (`action_beat` — engine/chat-action-beat.ts builds the register-aware cue),
 * carrying the chip id and a paired deterministic state effect the engine applies
 * pre-narration. The id + label + `hint` live here (pure) so the chat UI renders the
 * chips with affordance copy (label + tooltip that says what the tap will do) and the
 * engine's effect registry keys off the same ids; the engine owns the effect functions.
 * `chatActionIdSchema` validates the action at the route boundary.
 */
export const CHAT_ACTIONS = [
  { id: "drink", label: "Offer a drink", hint: "Offer a drink — a beat as it loosens the mood." },
  { id: "freshen", label: "Freshen up", hint: "A moment to freshen up and feel put-together again." },
  { id: "rest", label: "Take a breather", hint: "Take a breather together — the tension eases." },
  { id: "fluster", label: "Heat things up", hint: "Heat things up — the mood turns warmer." },
] as const;

export type ChatActionId = (typeof CHAT_ACTIONS)[number]["id"];

export const chatActionIdSchema = z.enum(["drink", "freshen", "rest", "fluster"]);

export const chatPulseSchema = z.object({
  /** The player's primary act toward the character, classified into a concept id; null ⇒ none. */
  playerAct: z.object({ concept: z.string().min(1) }).nullable().catch(null).default(null),
  /** Refreshed 1–3 sentence "what's on their mind"; "" ⇒ keep the prior note. */
  mindNote: z.string().max(CHAT_MIND_NOTE_MAX_CHARS).catch("").default(""),
  /**
   * A PERSISTENT emotional beat this exchange landed:
   * label + cause only — intensity derives deterministically from the response-curve
   * outcome (the model never proposes numbers, same contract as `playerAct`).
   * null ⇒ no lasting weather (most turns); `"neutral"` ⇒ the exchange RESOLVED
   * the standing feeling and it clears.
   */
  feeling: z
    .object({ label: emotionLabelEnum, cause: z.string().max(CHAT_FEELING_CAUSE_MAX).catch("").default("") })
    .nullable()
    .catch(null)
    .default(null),
  /**
   * True ONLY when the character's reply states she is sending/taking/attaching a
   * photo of herself for the player THIS exchange. The
   * deterministic gates (player request / apart+warm+cooldown offer eligibility)
   * decide whether it actually queues a render — the pulse only reads the fiction.
   */
  sentPhoto: z.boolean().catch(false).default(false),
});

export type ChatPulse = z.infer<typeof chatPulseSchema>;

/**
 * Degraded default (docs/resilience.md §1/§3): no classified act, no note refresh.
 * The turn keeps the reply and persists drift-only state — still "alive", just not
 * conversation-reactive that exchange.
 */
export function degradedChatPulse(): ChatPulse {
  return { playerAct: null, mindNote: "", feeling: null, sentPhoto: false };
}

/**
 * Last-turn debug trace persisted beside the state row for the state-tools
 * modal. The "why" is derived deterministically from the concept + valence +
 * the response curve, not authored by the model. Parsed defensively from the jsonb
 * column (`parseOr(chatPulseTraceSchema, …, emptyChatPulseTrace())`).
 */
export const chatPulseTraceSchema = z.object({
  /** Concept the pulse classified the player's act into (null ⇒ none recognised). */
  concept: z.string().nullable().catch(null).default(null),
  /** Resolved valence against the character's preferences (null ⇒ no match). */
  valence: z.enum(["like", "dislike"]).nullable().catch(null).default(null),
  /** Signed regard move applied this exchange (post per-turn clamp). */
  regardDelta: z.number().catch(0).default(0),
  /** Signed mood-meter move applied this exchange (0–1 scale). */
  moodDelta: z.number().catch(0).default(0),
  /** Arousal-meter move from an intimate act this exchange (0–1 scale; slice 4). */
  arousalDelta: z.number().catch(0).default(0),
  /** Which state fields the pulse changed (regard / mood / arousal / mindNote / feeling). */
  changed: z.array(z.string()).catch([]).default([]),
  /** The persistent feeling label applied this exchange (emotional-weather), null ⇒ none. */
  feeling: z.string().nullable().catch(null).default(null),
  /** Combined regard-delta multiplier applied (feeling bias × streak × bruise); 1 ⇒ unmodified. */
  regardScale: z.number().catch(1).default(1),
  /** The pulse read the reply as sending a photo this exchange. */
  sentPhoto: z.boolean().catch(false).default(false),
  /** True when the pulse degraded to drift-only (timeout / parse failure / demo). */
  degraded: z.boolean().catch(false).default(false),
  /** Degradation diagnostic code, when degraded. */
  diagnostic: z.string().optional(),
});

export type ChatPulseTrace = z.infer<typeof chatPulseTraceSchema>;

export function emptyChatPulseTrace(): ChatPulseTrace {
  return chatPulseTraceSchema.parse({});
}
