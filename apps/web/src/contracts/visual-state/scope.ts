import { z } from "zod";

/**
 * Which continuity a visual snapshot belongs to.
 *
 * Chat snapshots follow the chat MEMORY GROUP, so "continue our history" keeps
 * one continuity while a fresh or alternate-universe conversation stays
 * isolated; successor snapshots are branch-scoped, so a fork or a retake cannot
 * leak later visual knowledge backward.
 *
 * ## Why this is declared here and not imported
 *
 * It is structurally identical to `VisualMemoryScopeRef`
 * (`contracts/affordances/recognition/visual-memory.ts`), and a snapshot must
 * agree with the memory read taken against it about which continuity they are
 * in. The obvious move is to import that type — and slice 1 did.
 *
 * It is declared locally instead because the import direction is about to
 * reverse. Recognition consumes this projection from slice 5 onward
 * (attention and memory integration), and an edge from `visual-state` into
 * `affordances/recognition` today becomes a circular import the moment it does
 * — caught by `pnpm lint:cycles`, at the worst possible time, in someone else's
 * slice. Two two-member unions that both describe a committed continuity are
 * cheap to keep in step, and the place they meet in slice 5 is a compile error
 * if they ever stop matching.
 */
export const visualStateScopeRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), memoryGroupId: z.string().min(1) }),
  z.object({ kind: z.literal("world_branch"), branchId: z.string().min(1) }),
]);

export type VisualStateScopeRef = z.infer<typeof visualStateScopeRefSchema>;

/** A flat, stable string for one scope — the form a diagnostic or debug row carries. */
export function visualStateScopeKey(ref: VisualStateScopeRef): string {
  switch (ref.kind) {
    case "chat":
      return `chat:${ref.memoryGroupId}`;
    case "world_branch":
      return `world_branch:${ref.branchId}`;
  }
}
