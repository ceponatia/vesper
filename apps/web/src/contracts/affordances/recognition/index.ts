/**
 * Recognition — observer salience, visual memory, and narrator mention policy.
 *
 * Body truth stays upstream in `src/contracts/appearance-features`. This layer
 * owns only the perception-relative half: what a viewpoint can currently make
 * of a feature, what an observer has noticed before, and whether using it is
 * worth the beat. It never mutates anatomy, never persists prose, and never
 * merges two observers.
 *
 * The `visual-attention` / `visual-selection` pair scores and selects over the
 * lane-neutral visual-state projection under the same attention-and-memory
 * laws. They live HERE because recognition consumes that
 * projection, never the reverse — the import direction `visual-state/scope.ts`
 * reserved — and both structural-identity meeting points are enforced in
 * `visual-attention.ts`.
 *
 * Import direction: appearance-features / visual-state → affordance core →
 * recognition → lane adapters under `src/server`. Nothing here imports a lane.
 */
export * from "./candidates";
export * from "./salience";
export * from "./visual-memory";
export * from "./mention-policy";
export * from "./visual-attention";
export * from "./visual-selection";
export * from "./fixtures";
