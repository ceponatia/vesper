import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { FactDraft } from "@/contracts/facts/taxonomy";
import { currentEmbedder, embedText, embedTexts, toVectorLiteral, type Embedded } from "../ai";
import { db, facts, type DbWriter } from "../db";
import { logEvent } from "../events";
import { FACT_MIN_CONFIDENCE, FACT_RETRIEVAL_LIMIT, SUPERSEDE_CANDIDATES, SUPERSEDE_MIN_SCORE } from "./constants";
import { memoryScopeValues, memoryScopeWhere, scopeLabel, scopeSessionId, type MemoryScope } from "./scope";

/** Draft optionally pre-grounded by the merge reducer (subject_id resolution). */
export type FactDraftInput = FactDraft & {
  subjectId?: string | null;
  /** Participant ids present when the fact originated — interim co-location semantics (decision 3); write-only until the knowledge ledger ships. */
  witnessedBy?: string[];
};

export interface AddFactsResult {
  insertedIds: string[];
  supersededIds: string[];
}

export interface FactHit {
  id: string;
  kind: string;
  subjectName: string;
  text: string;
  score: number;
}

export function normalizeSubjectName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Supersedence gate (docs/memory.md §Semantic facts): same lowercased subject
 * AND cosine similarity at/above SUPERSEDE_MIN_SCORE. Pure — tested with
 * pseudoEmbed-derived scores.
 */
export function supersedes(draftSubjectName: string, candidateSubjectName: string, score: number): boolean {
  return (
    normalizeSubjectName(draftSubjectName) === normalizeSubjectName(candidateSubjectName) &&
    score >= SUPERSEDE_MIN_SCORE
  );
}

/** Pure cosine similarity, mirrors pgvector's `1 - (a <=> b)`. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Insert archivist fact drafts with supersedence, in ONE transaction:
 * low-confidence drafts dropped, texts batch-embedded, each draft searched
 * against the top-3 active same-embedder facts; gate passes ⇒ old row marked
 * superseded and linked. An embedding failure degrades to inserting without
 * vectors (facts keep their audit value, drop out of RAG + supersedence).
 */
/**
 * Where extracted facts came from: the session lane's turn row, or the chat
 * lane's assistant message (character-chat-standalone.spec.md §4.3) — the anchor
 * edit/delete/another-take reconciliation retracts by. `null` ⇒ no anchor
 * (authored inner notes, player "remember this").
 */
export type FactSource = { turnId?: string | null; messageId?: string | null } | null;

export async function addFacts(
  scope: MemoryScope,
  drafts: readonly FactDraftInput[],
  source: FactSource,
  sink?: DiagnosticSink,
): Promise<AddFactsResult> {
  const eligible: FactDraftInput[] = [];
  let droppedLowConfidence = 0;
  for (const draft of drafts) {
    if (draft.confidence < FACT_MIN_CONFIDENCE) {
      droppedLowConfidence++;
      continue;
    }
    if (!normalizeSubjectName(draft.subjectName) || !draft.text.trim()) {
      sink?.push(
        diag("warn", "memory.facts.invalid_draft", "fact draft with empty subject or text dropped", {
          context: { scope: scopeLabel(scope), subjectName: draft.subjectName },
        }),
      );
      continue;
    }
    eligible.push(draft);
  }
  if (droppedLowConfidence > 0) {
    sink?.push(
      diag(
        "info",
        "memory.facts.low_confidence_dropped",
        `${droppedLowConfidence} fact draft(s) under confidence ${FACT_MIN_CONFIDENCE} dropped`,
        { context: { scope: scopeLabel(scope), dropped: droppedLowConfidence } },
      ),
    );
  }
  if (eligible.length === 0) return { insertedIds: [], supersededIds: [] };

  let embedded: Embedded[] = [];
  try {
    embedded = await embedTexts(eligible.map((d) => d.text));
  } catch (err) {
    sink?.push(
      diag("error", "memory.facts.embed_failed", `fact embedding failed: ${errorText(err)}`, {
        context: { scope: scopeLabel(scope), draftCount: eligible.length },
      }),
    );
  }

  const insertedIds: string[] = [];
  const supersededIds: string[] = [];
  await db().transaction(async (tx) => {
    for (let i = 0; i < eligible.length; i++) {
      const draft = eligible[i];
      if (!draft) continue;
      const emb = embedded[i];
      const subjectName = normalizeSubjectName(draft.subjectName);

      let toSupersede: string[] = [];
      if (emb) {
        const vec = toVectorLiteral(emb.vector);
        const candidates = await tx
          .select({
            id: facts.id,
            subjectName: facts.subjectName,
            score: sql<number>`1 - (${facts.embedding} <=> ${vec}::vector)`,
          })
          .from(facts)
          .where(
            and(
              memoryScopeWhere(facts, scope),
              eq(facts.status, "active"),
              eq(facts.embedder, emb.embedder),
              isNotNull(facts.embedding),
            ),
          )
          .orderBy(sql`${facts.embedding} <=> ${vec}::vector`)
          .limit(SUPERSEDE_CANDIDATES);
        toSupersede = candidates.filter((c) => supersedes(subjectName, c.subjectName, c.score)).map((c) => c.id);
      }

      const [inserted] = await tx
        .insert(facts)
        .values({
          ...memoryScopeValues(scope),
          kind: draft.kind,
          verb: draft.verb ?? null,
          subjectKind: draft.subjectKind,
          subjectId: draft.subjectId ?? null,
          subjectName,
          text: draft.text,
          tags: draft.tags,
          confidence: draft.confidence,
          witnessedBy: draft.witnessedBy ?? [],
          sourceTurnId: source?.turnId ?? null,
          sourceMessageId: source?.messageId ?? null,
          embedding: emb?.vector ?? null,
          embedder: emb?.embedder ?? null,
        })
        .returning({ id: facts.id });
      if (!inserted) continue;
      insertedIds.push(inserted.id);

      if (toSupersede.length > 0) {
        const updated = await tx
          .update(facts)
          .set({ status: "superseded", supersededById: inserted.id, supersededAt: new Date() })
          .where(and(inArray(facts.id, toSupersede), eq(facts.status, "active")))
          .returning({ id: facts.id });
        supersededIds.push(...updated.map((u) => u.id));
      }
    }
  });

  return { insertedIds, supersededIds };
}

/**
 * Top active facts by cosine similarity (no minimum score — docs/memory.md
 * specifies only the limit for the facts channel; the ≤8 merged cap is the
 * prompt builder's concern).
 */
export async function retrieveFacts(
  scope: MemoryScope,
  queryText: string,
  limit = FACT_RETRIEVAL_LIMIT,
  sink?: DiagnosticSink,
): Promise<FactHit[]> {
  const query = queryText.trim();
  if (!query || limit <= 0) return [];

  let embedded: Embedded;
  try {
    embedded = await embedText(query);
  } catch (err) {
    sink?.push(
      diag("error", "memory.facts.embed_failed", `query embedding failed: ${errorText(err)}`, {
        context: { scope: scopeLabel(scope) },
      }),
    );
    return [];
  }

  const vec = toVectorLiteral(embedded.vector);
  const hits = await db()
    .select({
      id: facts.id,
      kind: facts.kind,
      subjectName: facts.subjectName,
      text: facts.text,
      score: sql<number>`1 - (${facts.embedding} <=> ${vec}::vector)`,
    })
    .from(facts)
    .where(
      and(
        memoryScopeWhere(facts, scope),
        eq(facts.status, "active"),
        eq(facts.embedder, currentEmbedder()),
        isNotNull(facts.embedding),
      ),
    )
    .orderBy(sql`${facts.embedding} <=> ${vec}::vector`)
    .limit(limit);

  await logEvent(scopeSessionId(scope), "retrieval", {
    kind: "facts",
    scope: scopeLabel(scope),
    query: query.slice(0, 300),
    candidates: hits.map((h) => ({ id: h.id, subjectName: h.subjectName, score: round(h.score) })),
  });
  return hits;
}

/**
 * Edit/rerun reconciliation (docs/turn-engine.md): facts sourced from the turn
 * are retracted, never deleted. Facts THEY superseded are deliberately NOT
 * reactivated — history moved past them; both stay invisible to retrieval and
 * `superseded_by_id` keeps the audit trail.
 */
/**
 * Retract every active fact extracted from one chat assistant message (spec §4.3)
 * — the edit/delete/another-take reconciliation. Status-flip, never a row delete
 * (audit trail), same as the session lane's turn retraction below.
 */
export async function retractFactsForMessage(messageId: string): Promise<string[]> {
  const updated = await db()
    .update(facts)
    .set({ status: "retracted" })
    .where(and(eq(facts.sourceMessageId, messageId), eq(facts.status, "active")))
    .returning({ id: facts.id });
  return updated.map((u) => u.id);
}

export async function retractFactsFromTurn(turnId: string): Promise<string[]> {
  const retracted = await db()
    .update(facts)
    .set({ status: "retracted" })
    .where(and(eq(facts.sourceTurnId, turnId), eq(facts.status, "active")))
    .returning({ id: facts.id });
  return retracted.map((r) => r.id);
}

/**
 * Hard-delete every fact in a scope. Sessions cascade-delete their facts with the session
 * row, so this is the chat lane's bulk purge (the single "Clear Chat" — character-chat-primary.spec.md §4).
 */
export async function deleteFactsForScope(scope: MemoryScope, dbc: DbWriter = db()): Promise<number> {
  const deleted = await dbc.delete(facts).where(memoryScopeWhere(facts, scope)).returning({ id: facts.id });
  return deleted.length;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round(score: number): number {
  return Math.round(score * 1000) / 1000;
}
