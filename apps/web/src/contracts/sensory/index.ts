/**
 * The nonvisual sensory presentation owners — touch, smell, and taste as
 * SIBLINGS beside `contracts/visual-state/`, under one shared presentation
 * architecture (owner ruling 2026-08-22).
 *
 * The ruling this package is the shape of: each sense keeps its OWN
 * observation contract; a routing envelope may carry a sensory channel; the
 * senses are never collapsed into one generic cross-sensory observation type;
 * and the shared `AffordanceObservation` gains no channel discriminant. Visual
 * state stays explicitly visual — these owners are beside it, not a
 * generalization that turns it into every sense.
 *
 * Import direction, on the affordance core's own pattern:
 *
 * ```text
 * affordances/core + contracts/diagnostics
 *   (+ appearance-features, for its canonical-encoding determinism primitive
 *      only — no visual truth crosses this edge)
 *         → contracts/sensory (this package)
 *         → producer domains adapt INTO it (affordances/contact routing among
 *           them) and the narrator adapter under src/server consumes it
 * ```
 *
 * This package never imports a producer domain — it is shared across all of
 * them, not a contact-specific copy — and it owns no truth: every observation
 * handed to it was already resolved from committed state by a producer whose
 * own laws forbid claims without owner reads. What it owns is PRESENTATION:
 * whether a specific observer can perceive an already-true fact (each sense's
 * access law), and which perceived facts are worth offering (the shared
 * selection). No narrator prose exists before that perception and selection;
 * the words live in the server adapter, behind its default-off switch.
 *
 * Pure and stateless: no IO, no environment, no clock, no persisted memory —
 * every cut recomputes from committed truth, so retakes restore exactly.
 */
export * from "./locus";
export * from "./diagnostics";
export * from "./presentation";
export * from "./tactile";
export * from "./olfactory";
export * from "./gustatory";
export * from "./fixtures";
