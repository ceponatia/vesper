import { eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Which memory owner a fact/episode belongs to (docs/memory.md §Memory keying).
 * The chat lane's memory group is the only scope now (the session lane is gone):
 * shared-history conversations share a group, fresh starts mint their own.
 * This is the single seam both memory
 * clients share; `addFacts`/`appendEpisode`/`retrieve*` take a scope, not a bare
 * id. Kept a one-armed discriminated union so a future scope (library/global)
 * is an additive arm, not a signature change.
 */
export type MemoryScope = { kind: "chat"; groupId: string };

/** The scope-key column a memory table exposes (facts + episodes share it). */
interface ScopedColumns {
  chatMemoryGroupId: AnyPgColumn;
}

export function chatScope(groupId: string): MemoryScope {
  return { kind: "chat", groupId };
}

/**
 * WHERE predicate selecting the rows in a scope; compose with other clauses via
 * `and(memoryScopeWhere(facts, scope), eq(facts.status, …), …)`.
 */
export function memoryScopeWhere(t: ScopedColumns, scope: MemoryScope): SQL | undefined {
  return eq(t.chatMemoryGroupId, scope.groupId);
}

/** Column values to stamp on insert. */
export function memoryScopeValues(scope: MemoryScope): { chatMemoryGroupId: string } {
  return { chatMemoryGroupId: scope.groupId };
}

/** Compact scope descriptor for diagnostics context. */
export function scopeLabel(scope: MemoryScope): string {
  return `chat-group:${scope.groupId}`;
}
