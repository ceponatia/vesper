import type { RegisteredAffordanceDomain } from "./core";

/**
 * The registered affordance domains, in resolution order.
 *
 * An EXPLICIT tuple, never filesystem discovery (the code-organization ruling):
 * the live set is readable in one file, ordering is deterministic — which is
 * what makes cue ranking's stable tie-break meaningful — and a domain cannot
 * join a production read merely by existing on disk.
 *
 * Empty today: the core ships disconnected from the narrator (plan slice 1),
 * and hair registers here in slice 2.
 */
export const affordanceDomains: readonly RegisteredAffordanceDomain[] = [];
