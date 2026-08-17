/**
 * Reference-image extraction (visual-state.plan.md slice 9) — the admin-only,
 * review-first workflow that lets a canonical image PROPOSE structured facts.
 * Storage, fresh diffs, and the apply-on-accept path live here; the pure
 * boundary, slot identity, reconciliation and review law live in
 * `contracts/visual-state/extraction.ts`. Canonical owners are written only
 * through their own paths, only from a human acceptance.
 */
export * from "./service";
