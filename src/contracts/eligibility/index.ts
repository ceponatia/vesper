/**
 * Adult eligibility (adult-eligibility.plan.md / .spec.md).
 *
 * The explicit `adult | minor | unresolved` declaration every participant in a scene
 * carries, the pure law that turns it into a verdict, and the adapter that hands that
 * verdict to the contact core. Lane-neutral: a character and a persona resolve through
 * the same code, and no lane wiring lives here.
 */
export * from "./declaration";
export * from "./resolve";
export * from "./contact-adapter";
