/**
 * Visual-state lane assembly (visual-state.plan.md slice 6; spec
 * §Implementation placement).
 *
 * The focused server barrel the spec names: snapshot and selection ASSEMBLY
 * from live chat state, the slice-6 shadow build, its measurements, the image
 * digest a character-bearing render consumes, and the inspector payload.
 * Everything in this folder is pure over passed-in
 * committed state — no IO, no env, no import from any other server module —
 * so the turn pipelines and previews (which own the loads) import THIS barrel
 * and the import direction stays one-way: `server/engine` → here → contracts.
 */
export * from "./assemble";
export * from "./image-digest";
export * from "./measure";
export * from "./preview";
export * from "./shadow";
