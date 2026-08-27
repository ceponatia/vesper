/**
 * The foot affordance domain — romantic contact's first proving domain.
 *
 * ```text
 * feet.arch / feet.nails / feet.toes             →  regional structural profile
 *                     + coarse surface condition →  regional effective mechanics
 *   + a COMMITTED contact, footwear, support,
 *     pose, and an asserted tactile channel      →  foot frame
 *                                                →  five phenomena
 * ```
 *
 * Import direction is one-way: this folder consumes the affordance core, the
 * shared contact core, and the body-location registry. `affordances/core` and
 * `affordances/contact` know nothing about feet, and their own neutrality tests
 * enforce that from the other side.
 *
 * The domain is NOT in `affordances/domains.ts`. Every phenomenon requires a
 * committed contact from a lifecycle neither lane owns, so declaring it live
 * would be a promise this build cannot keep; slice 3 wires the lane and adds the
 * row together. `foot.test.ts` pins the absence and its reason.
 *
 * `fixtures.ts` is deliberately NOT re-exported, following the contact core's
 * `test-support.ts` precedent: its builders throw on an unusable case and carry
 * defaults nobody chose, and a default that reaches production is how an
 * invented physical claim gets made. Tests import the module directly.
 */
export * from "./topology";
export * from "./attribute-maps";
export * from "./profile";
export * from "./condition";
export * from "./friction";
export * from "./footwear";
export * from "./support";
export * from "./mechanics";
export * from "./frame";
export * from "./phenomena";
export * from "./domain";
