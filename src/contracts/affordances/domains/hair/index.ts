/**
 * The hair affordance domain — the plan's first production proving domain
 * (body-attribute-affordances.spec.hair.md).
 *
 * ```text
 * hair.length/density/strand_thickness/texture/condition  →  structural profile
 *                          + arrangement, coverage, wetness  →  effective mechanics
 *                     + contacts, wind/motion, events        →  hair frame
 *                                                            →  four phenomena
 * ```
 *
 * Import direction is one-way: this folder consumes the affordance core and
 * ordinary pure contracts, and the core knows nothing about hair.
 */
export * from "./attribute-maps";
export * from "./profile";
export * from "./mechanics";
export * from "./frame";
export * from "./phenomena";
export * from "./domain";
export * from "./fixtures";
