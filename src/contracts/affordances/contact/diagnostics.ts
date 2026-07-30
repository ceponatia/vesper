/**
 * Contact diagnostic codes
 * (romantic-contact-affordances.spec.md §"Degraded behavior", renamed into the
 * house dotted convention that `affordance.input.unavailable` and
 * `guidance.disclosure.leak` already use).
 *
 * Only the codes slice 1 actually emits live here. A constant for a code nobody
 * pushes is a promise the diagnostics surface cannot keep, and the later slices
 * add theirs when they add the behaviour.
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

/** A lifecycle commit named a contact that is not active, or stored state failed to parse. `error`. */
export const CONTACT_LIFECYCLE_INVALID = "contact.lifecycle_invalid";
