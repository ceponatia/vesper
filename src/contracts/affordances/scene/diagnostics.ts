/**
 * Scene diagnostic codes, in the house dotted convention
 * (romantic-contact-affordances.spec.scene.md §"Degraded behaviour").
 *
 * Only the codes this module actually pushes exist. The severity rule is the
 * contact core's, unchanged:
 *
 * - **`warn`** — a fact nobody owns. Expected while the lanes have no pose,
 *   support, or proximity owner, degraded, and worth counting.
 * - **`error`** — a value nobody meant: a malformed intent, stored scene state
 *   that no longer parses. Only an adapter, a store, or an older release can
 *   produce one.
 * - **no diagnostic at all** for an ordinary refusal. "The player cannot move
 *   that body" is an ANSWER, and logging answers turns the diagnostics channel
 *   into a transcript of the fiction.
 */

/** A movement intent is structurally unusable, or names something the scene does not contain. `error`. */
export const SCENE_INTENT_INVALID = "scene.intent_invalid";

/** No control fact for the participant an intent moves. `warn`. */
export const SCENE_CONTROL_UNAVAILABLE = "scene.control_unavailable";

/** A relation read could not be answered from the facts present. `warn`. */
export const SCENE_RELATION_UNAVAILABLE = "scene.relation_unavailable";

/** Stored scene state was unreadable, in whole or in part. `error`. */
export const SCENE_STATE_INVALID = "scene.state_invalid";
