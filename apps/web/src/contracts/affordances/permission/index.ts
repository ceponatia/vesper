/**
 * The `romantic_touch` PERMISSION OWNER — pure contracts
 * (romantic-contact-affordances.spec.permission.md; owner rulings settled
 * 2026-08-04 in romantic-contact-affordances.plan.md §"`romantic_touch`
 * permission-owner rulings").
 *
 * The branch-local, directional, exact-scope grant ledger's pure half: the
 * event vocabulary and schema, the chronology comparator, the active-projection
 * fold, and the resolver-adapter mapping onto the contact core's
 * `ContactInteractionPolicyRead`.
 *
 * Import direction is ONE-WAY: this directory may import `../contact` and
 * `../core`; the contact core must never import this one. Permission is a lane
 * answer the contact resolver consumes, not a thing the shared core computes.
 *
 * `test-support.ts` is deliberately NOT exported — a probe grant that reached
 * production would be a permission nobody gave.
 */
export * from "./diagnostics";
export * from "./events";
export * from "./chronology";
export * from "./projection";
export * from "./policy";
