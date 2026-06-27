import type { AtmosphereLabel, EmotionResult } from "../mood";
import type { EvaluatedReaction } from "../personality/reactions";
import {
  type AvatarCue,
  BASELINE_HOLD_MS,
  type PoseLabel,
  REACTION_HOLD_MS,
  type ReactionLabel,
  type TransitionLabel,
} from "./cue";

/**
 * `deriveAvatarCue` — the pure, token-free state → cue projection
 * (docs/developer-notes/avatar-3d.spec.md §3). A *read* over state the engine already
 * computes: the already-derived `EmotionResult` (mood owns `deriveEmotionLabel`), the
 * latest social-reaction beat, free-text posture, and the scene's atmosphere. No IO, no
 * new LLM leg, **total** (always returns a valid cue). The cue is then serialized into
 * the turn/chat stream and `parseOr`'d at the client boundary.
 *
 * All numbers are starting values tuned in playtest — named constants here, mirroring
 * `mood/projection.ts` and `personality/reactions.ts` (logic is code; knobs are data).
 */

export interface AvatarCueInputs {
  /** The sustained baseline expression — from `deriveEmotionLabel` (already computed). */
  emotion: EmotionResult;
  /** The latest social-reaction result (the beat); absent ⇒ no one-shot beat. */
  reaction?: EvaluatedReaction;
  /** Concept id behind `reaction` (e.g. `flirt`, `boundary_push`) — refines the beat. */
  reactionConcept?: string;
  /** Free-text activity posture (`activityUpdates.posture`) → `PoseLabel`. */
  posture?: string | null;
  /** Scene tone (director / location ambient); defaults `calm`. */
  atmosphere?: AtmosphereLabel;
  /** Continuity key (active location / chat id). */
  sceneId: string;
  /** Worn-outfit key; resolves through the manifest at render. */
  outfitId?: string;
  /** Caller knows the sustained emotion is unchanged ⇒ a `soft` settle, not a crossfade. */
  emotionChanged?: boolean;
  /** Caller knows the continuity scene changed ⇒ a `cut`. */
  sceneChanged?: boolean;
}

// --- Tuning constants (starting values) -----------------------------------------

/** A reaction below this magnitude doesn't fire a beat (mirrors mood's beat floor). */
export const BEAT_MIN_MAGNITUDE = 0.3;
/** At/above this magnitude the louder beat plays (`laugh`/`flinch` vs `nod`/`sigh`). */
export const BEAT_STRONG_MAGNITUDE = 2;

/** Concept ids that read as a startle rather than their raw valence. */
const SURPRISE_CONCEPTS: ReadonlySet<string> = new Set(["boundary_push"]);
/** Concept ids that read as bashful when the baseline is already `flustered`. */
const FLIRT_CONCEPTS: ReadonlySet<string> = new Set(["flirt", "compliment", "proposition"]);

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Map free-text posture → a `PoseLabel`. Ordered most-specific-first; a miss is `idle`.
 * A `poseId` registry is the later, cleaner source (spec §3) — this keyword map is the
 * PoC bridge from the narrator's free-text `activityUpdates.posture`.
 */
const POSE_PATTERNS: ReadonlyArray<readonly [RegExp, PoseLabel]> = [
  [/\b(reclin|lying|lie down|lounge|sprawl|in bed|on the bed|curl(ed)? up)/, "reclining"],
  [/\b(arms? crossed|cross(es|ed|ing)? (her|his|their)? arms|guard|defensiv|closed off|stiffen|brace)/, "guarded"],
  [/\b(withdraw|turn(s|ed|ing)? (partly )?away|step(s|ped|ping)? back|pull(s|ed|ing)? back|distant|recoil|shrink)/, "withdrawn"],
  [/\b(lean(s|ed|ing)? (in|toward|forward|close)|move(s|d)? closer|reach(es|ed|ing)? (out|toward)|reassur|comfort|cradle)/, "reassuring"],
  [/\b(excit|animat|bounc|energetic|spring|light(s|ed)? up|perk)/, "excited"],
  [/\b(think|ponder|consider|thoughtful|glance(s|d)? (aside|away)|look(s|ed)? off|tilt(s|ed)? (her|his|their)? head)/, "thinking"],
  [/\b(open|receptiv|welcom|invit|relax)/, "open"],
];

export function poseFromPosture(posture: string | null | undefined): PoseLabel {
  if (!posture) return "idle";
  const p = posture.toLowerCase();
  for (const [pattern, pose] of POSE_PATTERNS) {
    if (pattern.test(p)) return pose;
  }
  return "idle";
}

/**
 * Map the latest social-reaction band → a one-shot `ReactionLabel` (spec §3). `none`
 * when there's no reaction or it's below the beat floor. The sustained `emotion` is the
 * low-affinity proxy for the bashful flirt beat (mood sets `flustered` for exactly that).
 */
export function deriveReactionBeat(
  reaction: EvaluatedReaction | undefined,
  reactionConcept: string | undefined,
  emotion: EmotionResult["emotion"],
): ReactionLabel {
  if (!reaction || reaction.magnitude < BEAT_MIN_MAGNITUDE) return "none";
  if (reactionConcept && SURPRISE_CONCEPTS.has(reactionConcept)) return "gasp";

  const strong = reaction.magnitude >= BEAT_STRONG_MAGNITUDE;
  if (reaction.valence === "like") {
    if (reactionConcept && FLIRT_CONCEPTS.has(reactionConcept) && emotion === "flustered") return "blush";
    return strong ? "laugh" : "nod";
  }
  // dislike
  return strong ? "flinch" : "sigh";
}

/** Pick the transition: `cut` on a scene change, `soft` to settle, else `crossfade`. */
function deriveTransition(i: AvatarCueInputs): TransitionLabel {
  if (i.sceneChanged) return "cut";
  if (i.emotionChanged === false) return "soft";
  return "crossfade";
}

/** Resolve the full cue from already-computed state. Total — always a valid cue. */
export function deriveAvatarCue(i: AvatarCueInputs): AvatarCue {
  const reaction = deriveReactionBeat(i.reaction, i.reactionConcept, i.emotion.emotion);
  return {
    character: {
      emotion: i.emotion.emotion,
      intensity: clamp01(i.emotion.intensity),
      pose: poseFromPosture(i.posture),
      reaction,
    },
    environment: {
      atmosphere: i.atmosphere ?? "calm",
      sceneId: i.sceneId,
    },
    wardrobe: {
      outfitId: i.outfitId ?? "",
    },
    timing: {
      transition: deriveTransition(i),
      holdMs: reaction === "none" ? BASELINE_HOLD_MS : REACTION_HOLD_MS,
    },
  };
}
