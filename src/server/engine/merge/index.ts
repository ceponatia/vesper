/**
 * The merge reducer (docs/turn-engine.md §Merge reducer): deterministic planning
 * over the typed bundle + whatever agent subset succeeded (plan.ts), then one
 * transaction for all world-state writes (apply.ts). Invalid references degrade
 * to dropped events with diagnostics; a turn with every agent failed still
 * advances the clock, applies drift, and writes a synthetic episode. This barrel
 * is the module's public surface; the phase glue + per-subsystem planners live in
 * ./phases and are re-exported here for the unit tests that exercise them
 * (merge-decomposition.spec.md §3.2).
 */
export * from "./working-state";
export * from "./grounding";
export * from "./types";
export * from "./phases/movement";
export * from "./phases/items";
export * from "./phases/meters";
export * from "./phases/reactions";
export * from "./phases/conditions";
export * from "./phases/attributes";
export * from "./phases/activities";
export * from "./phases/schedule";
export * from "./phases/facts";
export * from "./phases/threads";
export * from "./phases/witness";
export * from "./phases/comms";
export * from "./phases/affinity";
export * from "./phases/brief";
export * from "./plan";
export * from "./apply";
