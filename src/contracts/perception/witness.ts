import type { AttentionState } from "./attention";
import type { Salience, VisualSalience, AudibleSalience } from "./salience";

/**
 * The witness matrix (multi-character-v1-defaults.phase3.md §Witness matrix):
 * given an observer's attention and an action's salience, did the observer
 * perceive it? Pure and deterministic — the single rule both the pre-turn
 * awareness blocks (prediction) and the post-turn witness-set computation
 * (application) call, so prompt and memory never disagree.
 *
 * An observer perceives an action if they perceive EITHER its visual OR its
 * audible channel. `engagedWithActor` distinguishes engaged_with(actor) — full
 * perception of what they're attending to — from engaged_with(other), where a
 * conversation masks subtle/quiet things happening elsewhere.
 */
export interface PerceptionObserver {
  attention: AttentionState;
  /** Only meaningful for `absorbed`: back to the room. */
  facesAway?: boolean;
  /** The observer is attending to the actor of THIS action (not someone else). */
  engagedWithActor?: boolean;
}

export interface PerceptionMods {
  /** Location is dark right now (darkness.ts) — visual `obvious` reads as `subtle`. */
  dark?: boolean;
  /** Per-observer sight modifier from conditions (blindfolded ⇒ blocked, drunk ⇒ reduced). */
  sight?: "normal" | "reduced" | "blocked";
  /** Per-observer hearing modifier from conditions. */
  hearing?: "normal" | "reduced" | "blocked";
  /**
   * contact/entwined partner perceives everything done to them, regardless of
   * attention (defaults doc proximity modifier). Phase-4 proximity tracking sets
   * this; absent in v1.
   */
  proximityOverride?: boolean;
}

function visualPerceived(
  attention: AttentionState,
  facesAway: boolean,
  engagedWithActor: boolean,
  visual: VisualSalience,
): boolean {
  switch (attention) {
    case "engaged_with":
      return engagedWithActor ? true : visual === "obvious";
    case "idle_alert":
      return visual === "obvious";
    case "absorbed":
      return facesAway ? false : visual === "obvious";
    case "asleep_or_impaired":
      return false;
  }
}

function audiblePerceived(
  attention: AttentionState,
  engagedWithActor: boolean,
  audible: AudibleSalience,
): boolean {
  if (audible === "silent") return false;
  switch (attention) {
    case "engaged_with":
      return engagedWithActor ? true : audible === "loud";
    case "idle_alert":
      return true; // alert hears both loud and quiet
    case "absorbed":
      return audible === "loud";
    case "asleep_or_impaired":
      return audible === "loud";
  }
}

/** Did this observer perceive an action of the given salience? */
export function perceives(
  observer: PerceptionObserver,
  salience: Salience,
  mods: PerceptionMods = {},
): boolean {
  if (mods.proximityOverride) return true;

  const facesAway = observer.facesAway ?? false;
  const engagedWithActor = observer.engagedWithActor ?? false;

  // Visual channel, with darkness + sight modifiers stacking down toward subtle/none.
  let vp = false;
  if (mods.sight !== "blocked") {
    let visual = salience.visual;
    if ((mods.dark || mods.sight === "reduced") && visual === "obvious") visual = "subtle";
    vp = visualPerceived(observer.attention, facesAway, engagedWithActor, visual);
  }

  // Audible channel, with hearing modifier (reduced hearing misses quiet).
  let ap = false;
  if (mods.hearing !== "blocked") {
    let audible = salience.audible;
    if (mods.hearing === "reduced" && audible === "quiet") audible = "silent";
    ap = audiblePerceived(observer.attention, engagedWithActor, audible);
  }

  return vp || ap;
}
