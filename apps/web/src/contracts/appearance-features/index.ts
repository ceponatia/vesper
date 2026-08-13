/**
 * Appearance features — body-truth contracts for recognizable features
 * (body-attribute-affordances.spec.recognizable-features.md; code layout in
 * body-attribute-affordances.spec.code-organization.md §Recognition
 * ownership).
 *
 * This package owns HOW identity details are recorded (fine locus, feature
 * kinds, located facts, evented anatomy state) and the truth-level
 * projection. Salience, observer memory, and mention policy live downstream
 * in `src/contracts/affordances/recognition/` — this package never imports
 * the affordance layer.
 */
export * from "./locus";
export * from "./definitions";
export * from "./kinds";
export * from "./registry";
export * from "./facts";
export * from "./anatomy-state";
export * from "./attribute-recognition";
// `./priors` is deliberately absent: `./projection` re-exports it whole, so
// the frozen seam keeps owning those names and the barrel exports them once.
export * from "./projection";
export * from "./fixtures";
