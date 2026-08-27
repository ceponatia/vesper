/**
 * The hair affordance domain — the first production proving domain.
 *
 * ```text
 * hair.length/density/strand_thickness/texture/condition  →  structural profile
 *                          + arrangement, coverage, wetness  →  effective mechanics
 *                     + contacts, wind/motion, events        →  hair frame
 *                                                            →  five phenomena
 * ```
 *
 * Import direction is one-way: this folder consumes the affordance core and
 * ordinary pure contracts, and the core knows nothing about hair.
 *
 * `claims.ts` is the one outward-facing addition (narrator-physical-guidance slice
 * 2): the domain's own vocabulary for what a narrator may claim about this body
 * part, expressed as data the lane-neutral guidance compiler carries without
 * understanding. It imports a TYPE from `affordances/guidance`; the dependency runs
 * that way and never back, which is what the guidance folder's neutrality test
 * enforces from the other side.
 */
export * from "./attribute-maps";
export * from "./profile";
export * from "./mechanics";
export * from "./frame";
export * from "./phenomena";
export * from "./claims";
export * from "./domain";
export * from "./fixtures";
