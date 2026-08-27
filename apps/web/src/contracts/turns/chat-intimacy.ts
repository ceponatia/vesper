/**
 * The chat lane's **intimate gate** — the chat-lane port of the session lane's.
 *
 * The session lane gates its authored intimate notes on the turn's four-axis
 * `ExposureMask` (`buildIntimateDispositionBlock` — any of appearance/touch/taste at the
 * `intimate` tier). The chat lane has no such mask: it has no proximity model and no
 * per-sense brief. So intimate prose has been surfacing under a soft "when the moment
 * turns intimate" *framing* rather than a real gate — the model reads it every turn and
 * is asked to ignore it, which is exactly the always-on dump the notes were designed to
 * avoid.
 *
 * This is the lane's own gate, built from the three signals it actually has:
 *
 * 1. **The character's coverage** — their intimate regions read bare.
 * 2. **The player's coverage** — likewise. Only possible since the player got a real
 *    wardrobe; before that the lane was half-blind here.
 * 3. **Arousal** — the lane's own "this is turning intimate" scalar.
 *
 * Both coverage signals are COMPUTED from worn items, never a manual flag, so the gate
 * can't be toggled open by an author or talked open by a model.
 *
 * PURE. Deliberately not an `ExposureMask` port: the mask's axes (appearance/touch/taste
 * at four tiers) describe a spatial scene the chat lane does not model, and faking one
 * would be more machinery than the signals justify.
 */
import { intimateRegionsBare, type RegionExposure } from "../items/visibility";

/**
 * The arousal level at which a scene reads intimate on that signal alone. Anchored to the
 * meter registry's own `above: 0.55` "visibly affected" threshold — the point the lane
 * already considers legible from outside — but held as its own constant deliberately:
 * that threshold exists to trigger a *narrator hint*, and retuning the hint should not
 * silently move a content gate. (A future regrade of arousal should revisit this
 * number on purpose.)
 */
export const CHAT_INTIMATE_AROUSAL_AT = 0.55;

export interface ChatIntimateSignals {
  /** The character's intimate regions read bare — coverage-computed (`intimateRegionsBare`). */
  characterExposed?: boolean;
  /** The player's intimate regions read bare — coverage-computed. */
  playerExposed?: boolean;
  /** Live chat meters; only `arousal` is read. */
  meters?: Record<string, number>;
}

/**
 * Has this scene reached the intimate tier? Any one signal is enough — the session lane's
 * "any axis" ruling (owner, 2026-07-13) transposed: a
 * scene is intimate the moment it is *physically* intimate, even if the other signals
 * lag. Defaults to **false** on missing input: a chat with no state and no wardrobe has
 * shown nothing, so it earns nothing.
 */
export function chatSceneIsIntimate(signals: ChatIntimateSignals): boolean {
  if (signals.characterExposed === true) return true;
  if (signals.playerExposed === true) return true;
  return (signals.meters?.arousal ?? 0) >= CHAT_INTIMATE_AROUSAL_AT;
}

/** Convenience: derive the bare-flag the gate wants straight from computed coverage. */
export function exposureIsIntimate(exposure: RegionExposure | undefined): boolean {
  return exposure ? intimateRegionsBare(exposure) : false;
}
