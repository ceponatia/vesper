/**
 * Scene diagnostic codes, in the house dotted convention
 * (romantic-contact-affordances.spec.scene.md §"Degraded behaviour").
 *
 * Only the codes this module actually pushes exist. The severity rule is the
 * contact core's, unchanged:
 *
 * - **`warn`** — a fact nobody owns, or an intent that arrived after the scene
 *   had moved past it. Nothing is corrupt; something is missing or late.
 *   Expected while the lanes have no pose, support, or proximity owner,
 *   degraded, and worth counting.
 * - **`error`** — a value nobody meant: a malformed intent, stored scene state
 *   that no longer parses, stored facts that contradict each other. Only an
 *   adapter, a store, or an older release can produce one.
 * - **no diagnostic at all** for an ordinary refusal. "The player cannot move
 *   that body" is an ANSWER, and logging answers turns the diagnostics channel
 *   into a transcript of the fiction. A movement that merely RESTATES what the
 *   scene already says is the same: nothing is wrong, so nothing is filed.
 */

/** A movement intent is structurally unusable, or names something the scene does not contain. `error`. */
export const SCENE_INTENT_INVALID = "scene.intent_invalid";

/** No control fact for the participant an intent moves. `warn`. */
export const SCENE_CONTROL_UNAVAILABLE = "scene.control_unavailable";

/** A movement intent was older than the fact it would have overwritten, so nothing moved. `warn`. */
export const SCENE_INTENT_STALE = "scene.intent_stale";

/** A relation read could not be answered from the facts present. `warn`. */
export const SCENE_RELATION_UNAVAILABLE = "scene.relation_unavailable";

/** Stored scene state was unreadable or dangling in part (`error`), or unreadable in whole — including its version (`warn`). */
export const SCENE_STATE_INVALID = "scene.state_invalid";

/** Stored scene facts claimed one key twice, and every claimant was dropped. `error`. */
export const SCENE_STATE_CONTRADICTORY = "scene.state_contradictory";
