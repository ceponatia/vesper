/**
 * Contact diagnostic codes
 * (romantic-contact-affordances.spec.md §"Degraded behavior", renamed into the
 * house dotted convention that `affordance.input.unavailable` and
 * `guidance.disclosure.leak` already use).
 *
 * Only the codes this layer actually emits live here. A constant for a code
 * nobody pushes is a promise the diagnostics surface cannot keep, and the later
 * slices add theirs when they add the behaviour.
 *
 * Severity follows one rule, inherited from the guidance layer:
 *
 * - **`warn`** — an owner could not answer. Expected today (the audit records
 *   pose, reach, and material-between as unowned in both lanes), degraded, and
 *   worth counting.
 * - **`error`** — a value nobody meant. A malformed intent or a stored contact
 *   that no longer parses can only come from an adapter, a store, or an older
 *   release; it is a bug, not a policy.
 * - **no diagnostic at all** for an ordinary refusal. Permission denied, out of
 *   reach, and a garment in the way are ANSWERS. Logging them would turn the
 *   diagnostics channel into a transcript of the fiction.
 */

/** The intent or its context is structurally unusable. `error`. */
export const CONTACT_ACTION_INVALID = "contact.action_context_invalid";

/** No actor-control owner could answer for the initiating movement. `warn`. */
export const CONTACT_ACTOR_CONTROL_UNAVAILABLE = "contact.actor_control_unavailable";

/** No behaviour authority could answer for the target's own movement. `warn`. */
export const CONTACT_TARGET_AGENCY_UNAVAILABLE = "contact.target_agency_unavailable";

/** Adult eligibility is missing, or does not cover every participant. `warn`. */
export const CONTACT_ELIGIBILITY_UNAVAILABLE = "contact.participant_eligibility_unavailable";

/** The permission owner could not answer. `warn`. */
export const CONTACT_PERMISSION_UNAVAILABLE = "contact.policy_unavailable";

/** Permission exists but does not cover the action's scope. `warn`. */
export const CONTACT_PERMISSION_SCOPE_MISSING = "contact.consent_required";

/** No pose/reach owner for this cut. `warn`. */
export const CONTACT_GEOMETRY_UNAVAILABLE = "contact.pose_unavailable";

/** No support/mobility owner for the acting surface. `warn`. */
export const CONTACT_SUPPORT_UNAVAILABLE = "contact.support_unavailable";

/**
 * No owner could say what lies between the surfaces. `warn`.
 *
 * The spec sketched this as `contact_wardrobe_unavailable`. It is not a wardrobe
 * code here: the core deals in material layers and has no idea whether a layer is
 * a garment, a blanket, or a table, and naming a domain in a shared code is the
 * first step to the shared layer learning that domain.
 */
export const CONTACT_MATERIAL_UNAVAILABLE = "contact.material_unavailable";

/**
 * The lifecycle was asked for something the projection contradicts. `error` when
 * a caller or a replayed stream named a contact that is not there; `warn` when
 * the fold ABSORBED the contradiction deterministically — a stale assertion that
 * was not applied, a framing change that ended a live contact, capacity pressure
 * that ended the oldest ones. Also the code for stored state that failed to
 * parse or failed a cross-field check (`error`).
 */
export const CONTACT_LIFECYCLE_INVALID = "contact.lifecycle_invalid";

/**
 * An active contact's authorization no longer holds and the contact was ended.
 * `warn`.
 *
 * Not a refusal, and not a bug: permission being withdrawn mid-scene is an
 * ordinary story event. It is reported because a contact disappearing from the
 * projection for a reason no attempt produced is otherwise invisible.
 */
export const CONTACT_AUTHORIZATION_LAPSED = "contact.authorization_lapsed";

/**
 * A stored contact's transmission disagreed with its own material layers and was
 * recomputed from them. `warn`.
 *
 * The layers are the physical claim; the composition is derived. Recomputing can
 * only ever narrow what the stored blob claimed — the direction that cannot buy
 * a claim nobody committed.
 */
export const CONTACT_STATE_RECOMPUTED = "contact.state_recomputed";

/**
 * An action outcome was asked for a committable resolution with no durable
 * acknowledgment behind it. `error` when the caller supplied none at all (asking
 * before the write is a pipeline bug), `warn` when the store answered that the
 * write did not happen.
 *
 * Either way the outcome is `unresolved`, never `committed`: the narrator's
 * correct output for a contact that may not have been recorded is silence.
 */
export const CONTACT_COMMIT_UNACKNOWLEDGED = "contact.commit_unacknowledged";

/**
 * A durable acknowledgment arrived, and it does not name the commit THIS action
 * produced. `error`.
 *
 * Distinct from the code above because the two failures need different fixes: a
 * missing acknowledgment is a pipeline that forgot to ask the store, while a
 * mismatched one is a pipeline that asked and then believed the wrong answer —
 * an acknowledgment from an earlier write, from another contact, for a commit
 * kind that did not happen, or for the END of the contact rather than its start.
 * Both resolve `unresolved`; only the second means somebody's bookkeeping is
 * crossed, which is worth being able to count on its own.
 */
export const CONTACT_COMMIT_MISMATCHED = "contact.commit_acknowledgment_mismatch";
