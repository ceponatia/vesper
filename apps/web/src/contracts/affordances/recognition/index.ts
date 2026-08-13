/**
 * Recognition — observer salience, visual memory, and narrator mention policy
 * (body-attribute-affordances.spec.code-organization.md §Recognition ownership).
 *
 * Body truth stays upstream in `src/contracts/appearance-features`. This layer
 * owns only the observer-relative half: what THIS observer can currently make
 * of a feature, what they have noticed before, and whether saying it is worth
 * the beat. It never mutates anatomy, never persists prose, and never merges
 * two observers.
 *
 * Import direction: appearance-features → affordance core → recognition → lane
 * adapters under `src/server`. Nothing here imports a lane.
 */
export * from "./candidates";
export * from "./salience";
export * from "./visual-memory";
export * from "./mention-policy";
export * from "./fixtures";
