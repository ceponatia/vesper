/**
 * Sensory presentation diagnostic and suppression codes, in the house dotted
 * convention.
 *
 * Severity follows the contact layer's one rule:
 *
 * - **`warn`** — an owner could not answer (a lane supplied no range or
 *   oral-contact read). Degraded, and worth counting.
 * - **no diagnostic at all** for an ordinary refusal. An observer who was not
 *   part of the touch, stood out of scent range, or never made oral contact is
 *   an ANSWER, carried as a payload-free suppression only.
 *
 * Every code here doubles as the suppression's `code`, so the withheld set and
 * the sink never disagree about why a candidate fell silent.
 */

/** The observer did not take part in the committed contact the tactile fact rides. Suppression only. */
export const SENSORY_TACTILE_NOT_PARTICIPANT = "sensory.tactile.not_participant";

/** No owner could answer whether the observer is within scent range. `warn` + suppression. */
export const SENSORY_OLFACTORY_RANGE_UNAVAILABLE = "sensory.olfactory.range_unavailable";

/** The observer is attested out of scent range. Suppression only — an answer, not a degradation. */
export const SENSORY_OLFACTORY_OUT_OF_RANGE = "sensory.olfactory.out_of_range";

/** No owner could answer what the observer's committed oral contact touches. `warn` + suppression. */
export const SENSORY_GUSTATORY_ORAL_CONTACT_UNAVAILABLE = "sensory.gustatory.oral_contact_unavailable";

/** The observer's committed oral contact does not touch the tasted surface. Suppression only. */
export const SENSORY_GUSTATORY_NO_ORAL_CONTACT = "sensory.gustatory.no_oral_contact";
