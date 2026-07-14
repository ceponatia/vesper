import type { ChatActionId } from "@/contracts";

/**
 * Chat action beats (chat-action-beats.plan.md): the pure cue for a tapped action
 * chip. A chip is no longer a silent state nudge — it is a narrated one-beat
 * exchange (`action_beat`). The engine applies the chip's deterministic effect to
 * the drifted state pre-narration (so the reply reflects the shift) and hands the
 * narrator THIS cue as a synthetic player turn, the same way the opening/continue
 * beats do (chat-pipeline.ts `OPENING_CUE` / `CONTINUE_CUE`).
 *
 * The cue addresses the character in second person (like those beats), naming the
 * player, so it never assumes the character's gender. One-beat restraint mirrors the
 * reopen opener: the gesture licenses a small scene beat, not a scene change. It is
 * register-aware — apart ⇒ answer as a text, co-present ⇒ play it in the scene —
 * derived by the caller from the same comms-register signal the selfie offer reads
 * (the last reply's `*Name: …*` spans, engine/chat-selfie.ts `hasCommsSpans`).
 */

/** Per-chip gesture wording: what the player did, and the small shift the reply reflects. */
const ACTION_BEAT_GESTURES: Record<ChatActionId, { gesture: string; shift: string }> = {
  drink: {
    gesture: "offers you a drink, and you take it",
    shift: "Play one small beat as you have some and let it loosen you a touch.",
  },
  freshen: {
    gesture: "gives you a moment to freshen up",
    shift: "Play one small beat as you tidy yourself — a splash of water, hair smoothed, feeling fresher.",
  },
  rest: {
    gesture: "suggests the two of you take a breather",
    shift: "Play one small beat as you ease off, let the tension go, and catch your breath.",
  },
  fluster: {
    gesture: "heats things up between you",
    shift: "Play one small beat as the warmth of it catches you — color rising, breath a little quick.",
  },
};

export interface ActionBeatCueInput {
  chipId: ChatActionId;
  characterName: string;
  playerName: string;
  /** True when the exchange reads as comms (the last reply carried texted `*Name: …*` spans). */
  apart: boolean;
}

/**
 * The synthetic player-turn cue for an action beat (PURE). Composition: the player's
 * gesture → the small shift to reflect → the register rule (a text when apart, in-scene
 * when together) → one-beat restraint. Wrapped in parens like the opening/continue cues,
 * so it reads as a stage direction, never literal player speech.
 */
export function buildActionBeatCue(input: ActionBeatCueInput): string {
  const g = ACTION_BEAT_GESTURES[input.chipId];
  const register = input.apart
    ? `You and ${input.playerName} are apart right now — answer as a text on its own line: *${input.characterName}: your words*.`
    : `You are together in the scene — play it there, in the moment.`;
  const lines = [
    `${input.playerName} ${g.gesture}.`,
    g.shift,
    register,
    `One beat only: land it and end on something ${input.playerName} can answer. Do not narrate ${input.playerName}, and do not leap the scene forward.`,
  ];
  return `(${lines.join(" ")})`;
}
