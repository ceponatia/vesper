import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Which memory owner a fact/episode belongs to (docs/memory.md §Memory keying).
 * Exactly one keying is ever set on a row — a **session** (the turn lane) or a
 * **character chat** (owner+character) — enforced by the `*_scope_exactly_one`
 * CHECK constraints in `schema.ts`. This union is the single seam both memory
 * clients share; `addFacts`/`appendEpisode`/`retrieve*` take a scope, not a bare
 * session id.
 */
export type MemoryScope =
  | { kind: "session"; sessionId: string }
  | { kind: "chat"; ownerId: string; characterId: string };

/** The two scope-key columns a memory table exposes (facts + episodes share these). */
interface ScopedColumns {
  sessionId: AnyPgColumn;
  ownerId: AnyPgColumn;
  characterId: AnyPgColumn;
}

export function sessionScope(sessionId: string): MemoryScope {
  return { kind: "session", sessionId };
}

export function chatScope(ownerId: string, characterId: string): MemoryScope {
  return { kind: "chat", ownerId, characterId };
}

/**
 * WHERE predicate selecting the rows in a scope. Returns a single `eq` for the
 * session lane and an `and(owner, character)` for the chat lane; compose with
 * other clauses via `and(memoryScopeWhere(facts, scope), eq(facts.status, …), …)`
 * (drizzle flattens nested `and`).
 */
export function memoryScopeWhere(t: ScopedColumns, scope: MemoryScope): SQL | undefined {
  return scope.kind === "session"
    ? eq(t.sessionId, scope.sessionId)
    : and(eq(t.ownerId, scope.ownerId), eq(t.characterId, scope.characterId));
}

/** Column values to stamp on insert — the null of the columns the scope doesn't use. */
export function memoryScopeValues(scope: MemoryScope): {
  sessionId: string | null;
  ownerId: string | null;
  characterId: string | null;
} {
  return scope.kind === "session"
    ? { sessionId: scope.sessionId, ownerId: null, characterId: null }
    : { sessionId: null, ownerId: scope.ownerId, characterId: scope.characterId };
}

/** Session id for event logging — chats have no session row, so they log under `null`. */
export function scopeSessionId(scope: MemoryScope): string | null {
  return scope.kind === "session" ? scope.sessionId : null;
}

/** Compact scope descriptor for diagnostics context. */
export function scopeLabel(scope: MemoryScope): string {
  return scope.kind === "session" ? `session:${scope.sessionId}` : `chat:${scope.ownerId}/${scope.characterId}`;
}
