import { eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Which memory owner a fact/episode belongs to (docs/memory.md §Memory keying).
 * Exactly one keying is ever set on a row — a **session** (the turn lane) or a
 * chat **memory group** (character-chat-standalone.spec.md §1.3: the scope a
 * chat participant reads/writes; shared-history conversations share a group,
 * fresh starts mint their own) — enforced by the `*_scope_exactly_one` CHECK
 * constraints in `schema.ts`. This union is the single seam both memory clients
 * share; `addFacts`/`appendEpisode`/`retrieve*` take a scope, not a bare id.
 */
export type MemoryScope = { kind: "session"; sessionId: string } | { kind: "chat"; groupId: string };

/** The two scope-key columns a memory table exposes (facts + episodes share these). */
interface ScopedColumns {
  sessionId: AnyPgColumn;
  chatMemoryGroupId: AnyPgColumn;
}

export function sessionScope(sessionId: string): MemoryScope {
  return { kind: "session", sessionId };
}

export function chatScope(groupId: string): MemoryScope {
  return { kind: "chat", groupId };
}

/**
 * WHERE predicate selecting the rows in a scope; compose with other clauses via
 * `and(memoryScopeWhere(facts, scope), eq(facts.status, …), …)`.
 */
export function memoryScopeWhere(t: ScopedColumns, scope: MemoryScope): SQL | undefined {
  return scope.kind === "session" ? eq(t.sessionId, scope.sessionId) : eq(t.chatMemoryGroupId, scope.groupId);
}

/** Column values to stamp on insert — the null of the column the scope doesn't use. */
export function memoryScopeValues(scope: MemoryScope): {
  sessionId: string | null;
  chatMemoryGroupId: string | null;
} {
  return scope.kind === "session"
    ? { sessionId: scope.sessionId, chatMemoryGroupId: null }
    : { sessionId: null, chatMemoryGroupId: scope.groupId };
}

/** Session id for event logging — chats have no session row, so they log under `null`. */
export function scopeSessionId(scope: MemoryScope): string | null {
  return scope.kind === "session" ? scope.sessionId : null;
}

/** Compact scope descriptor for diagnostics context. */
export function scopeLabel(scope: MemoryScope): string {
  return scope.kind === "session" ? `session:${scope.sessionId}` : `chat-group:${scope.groupId}`;
}
