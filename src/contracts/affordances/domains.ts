import type { RegisteredAffordanceDomain } from "./core";
import { hairAffordanceDomain } from "./domains/hair/domain";

/**
 * The registered affordance domains, in resolution order.
 *
 * An EXPLICIT tuple, never filesystem discovery (the code-organization ruling):
 * the live set is readable in one file, ordering is deterministic — which is
 * what makes cue ranking's stable tie-break meaningful — and a domain cannot
 * join a production read merely by existing on disk.
 *
 * Hair is the first production proving domain (plan slices 2–3). It still
 * resolves to silence in production until slice 4 connects the lane adapters
 * that supply wetness, coverage, and the environment read.
 */
export const affordanceDomains: readonly RegisteredAffordanceDomain[] = [hairAffordanceDomain];
