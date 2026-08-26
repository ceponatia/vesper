/**
 * Narrator Prompt Lab — the server half (narrator-prompt-lab.plan.md slice 2).
 *
 * Owner-scoped persistence for handwritten narrator instruction prompts: named
 * templates, their append-only revision chain, the per-conversation selection,
 * and the single function an exchange calls to turn that selection into a frozen
 * `NarratorInstructionSource`. The pure shapes, limits and request schemas live
 * in `contracts/narrator-prompts`; nothing in this folder decides product law.
 *
 * Two rules the rest of the app depends on:
 *
 * - **Every function takes an explicit `ownerId`** and puts it in the `where` of
 *   every read and write. Admin role decides whether the Prompt Lab is usable at
 *   all; it is never a licence to touch another account's prompts.
 * - **Resolution never fails a turn.** `resolveNarratorInstructionSource` returns
 *   production instructions plus a diagnostic for every way a selection can go
 *   bad, and throws for none of them.
 */
export * from "./templates";
export * from "./selection";
