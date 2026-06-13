import { z } from "zod";

/**
 * Attention (presence-and-perception-spec.phase3.md §Attention × salience,
 * decision 13). What a character is paying attention to, derived deterministically
 * from their `activity`/`posture` plus an optional perception hint on the item or
 * affordance they are using. Neutral default is `idle_alert` (also the degraded
 * default when activity data is missing — defaults doc witness-matrix note).
 */
export const attentionStateSchema = z.enum([
  "engaged_with", // actively attending to someone/something (a conversation, an embrace)
  "absorbed", // focused on a task (cooking, reading) — narrow attention
  "idle_alert", // unoccupied and aware of the room (the neutral default)
  "asleep_or_impaired", // asleep, unconscious, blackout drunk — minimal perception
]);
export type AttentionState = z.infer<typeof attentionStateSchema>;

/**
 * Perception hint on an item/affordance definition: a sink implies facing away
 * from the room, a guard post implies facing outward — no furniture geometry needed.
 */
export const attentionHintSchema = z.enum(["absorbing", "faces_away", "outward"]);
export type AttentionHint = z.infer<typeof attentionHintSchema>;

export interface DerivedAttention {
  state: AttentionState;
  /** Only meaningful for `absorbed`: the character's back is to the room. */
  facesAway: boolean;
}

const ASLEEP_KEYWORDS = [
  "asleep", "sleeping", "fast asleep", "unconscious", "passed out", "knocked out",
  "fainted", "comatose", "blackout", "dozing", "out cold",
];
const ENGAGED_KEYWORDS = [
  "talking", "speaking", "chatting", "conversing", "arguing", "kissing", "embracing",
  "hugging", "flirting", "listening to", "watching", "facing", "in conversation",
  "dancing with", "wrapped around", "tangled with", "gazing at",
];
const ABSORBED_KEYWORDS = [
  "reading", "writing", "cooking", "baking", "scrubbing", "washing", "doing the dishes",
  "cleaning", "studying", "working", "focused", "engrossed", "concentrating", "painting",
  "drawing", "sewing", "knitting", "typing", "staring at", "at the sink", "at the stove",
  "at the desk", "absorbed", "buried in", "lost in",
];
const ALERT_KEYWORDS = [
  "waiting", "watching the door", "on guard", "standing guard", "keeping watch",
  "looking around", "scanning", "people-watching", "loitering", "alert", "on the lookout",
];
const FACES_AWAY_KEYWORDS = [
  "back turned", "back to the room", "facing away", "turned away", "faces the wall",
  "facing the wall", "back to you", "her back to", "his back to",
];

function matches(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * Derive an attention state from free-text activity/posture and an optional hint.
 * Pure and deterministic. Precedence: asleep > engaged > absorbed > alert > neutral.
 * A hint sharpens the read (`absorbing` ⇒ absorbed, `outward` ⇒ idle_alert,
 * `faces_away` ⇒ sets the facesAway flag).
 */
export function deriveAttention(input: {
  activity?: string;
  posture?: string;
  hint?: AttentionHint;
}): DerivedAttention {
  const text = `${input.activity ?? ""} ${input.posture ?? ""}`.toLowerCase();
  const facesAway = input.hint === "faces_away" || matches(text, FACES_AWAY_KEYWORDS);

  if (matches(text, ASLEEP_KEYWORDS)) return { state: "asleep_or_impaired", facesAway: false };
  if (matches(text, ENGAGED_KEYWORDS)) return { state: "engaged_with", facesAway: false };
  if (input.hint === "absorbing" || matches(text, ABSORBED_KEYWORDS)) {
    return { state: "absorbed", facesAway };
  }
  if (input.hint === "outward" || matches(text, ALERT_KEYWORDS)) {
    return { state: "idle_alert", facesAway: false };
  }
  return { state: "idle_alert", facesAway };
}

/** Short narrator-facing description of an attention state, for awareness blocks. */
export function describeAttention(a: DerivedAttention): string {
  switch (a.state) {
    case "engaged_with":
      return "engaged in the moment";
    case "absorbed":
      return a.facesAway ? "absorbed in a task, back turned" : "absorbed in a task";
    case "idle_alert":
      return "unoccupied and aware of the room";
    case "asleep_or_impaired":
      return "asleep or insensible";
  }
}
