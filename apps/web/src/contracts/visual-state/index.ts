/**
 * Visual state — the lane-neutral projection of what a character looks like
 * right now (visual-state.plan.md, visual-state.spec.md).
 *
 * This package owns the SHAPE of a visual fact: its layer, locus, source,
 * stability, key, fingerprint, typed composition, attention priors, and the
 * deterministic order a snapshot puts them in. It owns no truth. Canonical
 * attributes, located facts, anatomy, wardrobe, body-surface state, conditions
 * and scene relations remain the authorities; a `VisualStateFeature` is a
 * normalized READ over them, which is what makes conflicts diagnosable and
 * replay deterministic.
 *
 * ONE exception, and it is deliberate: deliberate non-item presentation — how
 * the hair is worn, whether there is makeup on, how the nails are finished — had
 * no owner anywhere, so `presentation.ts` is that owner rather than a read over
 * one. Everything else here reads somebody else's truth.
 *
 * Pure and lane-neutral: no IO, no environment, no clock. It may import the
 * appearance, affordance, body and item contracts; it never imports server code,
 * and nothing here decides what an observer can see or what is worth saying.
 */
export * from "./vocabulary";
export * from "./scope";
export * from "./locus";
export * from "./sources";
export * from "./priors";
export * from "./relationships";
export * from "./definitions";
export * from "./kinds";
export * from "./registry";
export * from "./diagnostics";
export * from "./suppression";
export * from "./feature";
export * from "./composition";
export * from "./snapshot";
export * from "./compat";
export * from "./species";
export * from "./wardrobe";
export * from "./presentation";
export * from "./fixtures";
