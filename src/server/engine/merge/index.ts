/**
 * The merge reducer (docs/turn-engine.md §Merge reducer): deterministic planning
 * over the typed bundle + whatever agent subset succeeded (plan.ts), then one
 * transaction for all world-state writes (apply.ts). Invalid references degrade
 * to dropped events with diagnostics; a turn with every agent failed still
 * advances the clock, applies drift, and writes a synthetic episode.
 *
 * This barrel is the module's **public** surface only (merge-decomposition.spec.md
 * §3.2). The per-subsystem planners + phase glue live in ./phases and ./grounding;
 * the unit tests import those directly via relative sibling paths.
 */
export { applyTurnResults, type ApplyTurnInput } from "./apply";
export { planTurnEffects } from "./plan";
export { stagedLocationAnchor } from "./grounding";
export { WorkingState } from "./working-state";
export type { ItemPlacement, WorkingItem, WorkingParticipant } from "./working-state";
export type { GroundingDeps, MergeMode, MergePlan, MergeTurn, PlanInput } from "./types";
