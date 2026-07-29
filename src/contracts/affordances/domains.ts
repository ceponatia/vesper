import type { RegisteredAffordanceDomain } from "./core";
import { hairAffordanceDomain } from "./domains/hair/domain";
import { garmentAffordanceDomain } from "./domains/garment/domain";

/**
 * The registered affordance domains, in resolution order.
 *
 * An EXPLICIT tuple, never filesystem discovery (the code-organization ruling):
 * the live set is readable in one file, ordering is deterministic — which is
 * what makes cue ranking's stable tie-break meaningful — and a domain cannot
 * join a production read merely by existing on disk.
 *
 * Hair is the first production proving domain (plan slices 2–3); garment is the
 * second (slice 6), and the pair is the proof that the shared core is not
 * hair-specific — one is compiled from the character's own attributes, the other
 * from what the character is wearing, and both ride this same tuple.
 *
 * Order is resolution order, and hair leads for a narration reason rather than a
 * technical one: cue ranking's tie-break is `Array#sort`'s stability, so when a
 * damp head of hair and a damp shirt both read `clear`, the hair wins the scarce
 * slot. That matches how a reader notices a person.
 */
export const affordanceDomains: readonly RegisteredAffordanceDomain[] = [
  hairAffordanceDomain,
  garmentAffordanceDomain,
];
