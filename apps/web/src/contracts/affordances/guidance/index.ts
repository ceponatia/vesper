/**
 * Narrator physical guidance — the lane-neutral constraint, correction, and
 * action-result projection (narrator-physical-guidance.plan.md; as-built
 * contracts in narrator-physical-guidance.spec.md).
 *
 * Import direction: attribute/body contracts + `contracts/diagnostics` →
 * affordance `core` → **guidance** → lane adapters under `src/server`.
 *
 * A deliberate SIBLING of `core/`, not a member of it. The core stages a
 * calculation it knows nothing about and may not know that narration exists;
 * this layer exists precisely to know what a narrator may be told. What it may
 * never know is a DOMAIN: nothing here imports `../domains/*` or any lane, and
 * domain vocabulary arrives as data (`ConstraintClaimMapping`, opaque claim
 * codes) rather than as an import. `guidance/domain-neutrality.test.ts` enforces
 * both halves mechanically.
 */
export * from "./types";
export * from "./fingerprint";
export * from "./constraint-candidates";
export * from "./action-outcome";
export * from "./disclosure";
export * from "./selection";
export * from "./compile";
