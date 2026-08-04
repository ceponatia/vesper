/**
 * Romantic-permission diagnostic codes
 * (romantic-contact-affordances.spec.permission.md §"Events and active
 * projection", §"Chronology and non-retroactivity" — house dotted convention,
 * same rules as `contact/diagnostics.ts`).
 *
 * Only codes this layer actually emits live here. Severity follows the contact
 * layer's rule: `error` for a value nobody meant (a malformed event can only
 * come from a store, an adapter, or an older release), `warn` for an answer the
 * chronology could not establish, and **no diagnostic at all** for an ordinary
 * refusal — a denial or a withdrawal is an ANSWER, and logging answers would
 * turn the diagnostics channel into a transcript of the fiction.
 */

/**
 * A permission event that could not be read as one — a payload that fails the
 * schema, a duplicate event id, or a developer override carrying no operation.
 * Dropped, never repaired: an unreadable event must not become a grant. `error`.
 */
export const PERMISSION_EVENT_INVALID = "permission.event_invalid";

/**
 * An event was excluded from the projection because its order against the
 * attempt's chronology position could not be established. Ambiguous ordering
 * fails closed (spec §"Chronology and non-retroactivity"): the event does not
 * authorize, and the gap is reported here rather than resolved by a guess.
 * `warn`.
 */
export const PERMISSION_CHRONOLOGY_AMBIGUOUS = "permission.chronology_ambiguous";
