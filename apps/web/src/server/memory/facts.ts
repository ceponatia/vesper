import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  NARRATOR_VISIBLE_FACT_CHANNELS,
  parseFactChannel,
  type FactChannel,
  type FactDraft,
} from "@/contracts/facts/taxonomy";
import { parseOr } from "@/lib/parse";
import { currentEmbedder, embedText, embedTexts, toVectorLiteral, type Embedded } from "../ai";
import { db, facts, type DbWriter } from "../db";
import { logEvent } from "../events";
import {
  FACT_MIN_CONFIDENCE,
  FACT_MIN_SCORE,
  FACT_RETRIEVAL_LIMIT,
  PINNED_FACT_CAP,
  RRF_K,
  SUPERSEDE_CANDIDATES,
  SUPERSEDE_MIN_SCORE,
} from "./constants";
import { fuseByRrf, nonBlankQueries } from "./fusion";
import type { QueryEmbeddings } from "./query-embeddings";
import { memoryScopeValues, memoryScopeWhere, scopeLabel, type MemoryScope } from "./scope";
import { witnessEligibilityWhere, type WitnessEligibility } from "./witness-eligibility";

const stringArraySchema = z.array(z.string());

/**
 * Who authored a fact: the background
 * archivist ("extracted", the default), the player's "remember this"
 * ("player"), or a dev inspector edit ("dev").
 */
export type FactOrigin = "extracted" | "player" | "dev";

/** Draft optionally pre-grounded by the merge reducer (subject_id resolution). */
export type FactDraftInput = FactDraft & {
  subjectId?: string | null;
  /** Participant ids present when the fact originated — interim co-location semantics (decision 3); write-only until the knowledge ledger ships. */
  witnessedBy?: string[];
  /** Force-include in retrieval + protect from extracted supersedence ("remember this"). */
  pinned?: boolean;
  /** Provenance; defaults to "extracted" (archivist drafts). */
  origin?: FactOrigin;
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
  /**
   * Raw cosine similarity to the query (best across queries in the fused path).
   * Force-included pinned rows the similarity search didn't surface carry 0 —
   * "not scored", never a fabricated similarity.
   */
  score: number;
  pinned: boolean;
  origin: FactOrigin;
}

/** A fused-retrieval hit: which queries retrieved it (per-source attribution). */
export type FusedFactHit = FactHit & {
  /** Queries that retrieved this hit; [] for force-included pinned rows no query found. */
  sources: string[];
};

/** Full fact row for the dev inspector's list read. */
export interface FactRecord {
  id: string;
  kind: string;
  subjectKind: string;
  subjectId: string | null;
  subjectName: string;
  text: string;
  tags: string[];
  confidence: number;
  status: "active" | "superseded" | "retracted";
  pinned: boolean;
  origin: FactOrigin;
  /** The channel this fact was established through (slice 6) — degraded-parsed from the column. */
  channel: FactChannel;
  sourceTurnId: string | null;
  sourceMessageId: string | null;
  supersededById: string | null;
  createdAt: Date;
  supersededAt: Date | null;
}

export function normalizeSubjectName(name: string): string {
  return name.trim().toLowerCase();
}

/** The incoming draft's identity fields the supersedence gate consults. */
export interface SupersedeDraft {
  subjectName: string;
  subjectId?: string | null;
  /** Defaults to "extracted" — the pinned asymmetry's least-privileged origin. */
  origin?: FactOrigin;
}

/** The stored candidate's identity fields the supersedence gate consults. */
export interface SupersedeCandidate {
  subjectName: string;
  subjectId: string | null;
  pinned: boolean;
  origin: FactOrigin;
}

/**
 * Supersedence gate (docs/memory.md §Semantic facts): same subject AND cosine
 * similarity at/above SUPERSEDE_MIN_SCORE. Pure — tested with
 * pseudoEmbed-derived scores. Two slice-7 refinements:
 *
 * - Subject identity: when BOTH sides carry a `subjectId`, id
 *   equality is the test — differing ids block supersedence even when names
 *   match (two "Twin"s are two entities), and matching ids pass even across a
 *   rename. When either side lacks an id (all chat-lane drafts today), fall
 *   back to lowercased-name equality.
 * - Pinned asymmetry: a pinned candidate is only superseded when
 *   the incoming draft's origin is "player" or "dev" — an "extracted" draft
 *   never retires a pinned fact. Pinned facts supersede others freely.
 */
export function supersedes(draft: SupersedeDraft, candidate: SupersedeCandidate, score: number): boolean {
  if (score < SUPERSEDE_MIN_SCORE) return false;
  if (candidate.pinned && (draft.origin ?? "extracted") === "extracted") return false;
  if (draft.subjectId != null && candidate.subjectId != null) return draft.subjectId === candidate.subjectId;
  return normalizeSubjectName(draft.subjectName) === normalizeSubjectName(candidate.subjectName);
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
 * lane's assistant message — the anchor
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
            subjectId: facts.subjectId,
            pinned: facts.pinned,
            origin: facts.origin,
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
        const draftRef: SupersedeDraft = { subjectName, subjectId: draft.subjectId ?? null, origin: draft.origin };
        toSupersede = candidates.filter((c) => supersedes(draftRef, c, c.score)).map((c) => c.id);
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
          // Trust boundary (slice 6): an unknown channel from the archivist degrades to
          // `perceived` with a diagnostic; a missing one is the ordinary un-classified write.
          channel: parseFactChannel(draft.channel, sink),
          pinned: draft.pinned ?? false,
          origin: draft.origin ?? "extracted",
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
 * Top-k active same-embedder facts by cosine similarity (shared by both retrievers).
 * FENCED to narrator-visible channels (slice 6): `private`/`ooc` facts are excluded here,
 * in SQL BEFORE the limit, so they never reach the narrator AND never eat the cap's slots.
 * The dev inspector's `listFactsForScope` and the pulse are separate reads — they still see
 * every channel.
 */
async function queryFactCandidates(
  scope: MemoryScope,
  vec: string,
  limit: number,
  eligibility?: WitnessEligibility,
): Promise<FactHit[]> {
  return db()
    .select({
      id: facts.id,
      kind: facts.kind,
      subjectName: facts.subjectName,
      text: facts.text,
      score: sql<number>`1 - (${facts.embedding} <=> ${vec}::vector)`,
      pinned: facts.pinned,
      origin: facts.origin,
    })
    .from(facts)
    .where(
      and(
        memoryScopeWhere(facts, scope),
        eq(facts.status, "active"),
        eq(facts.embedder, currentEmbedder()),
        isNotNull(facts.embedding),
        inArray(facts.channel, [...NARRATOR_VISIBLE_FACT_CHANNELS]),
        witnessEligibilityWhere(facts.witnessedBy, eligibility),
      ),
    )
    .orderBy(sql`${facts.embedding} <=> ${vec}::vector`)
    .limit(limit);
}

/**
 * The scope's active pinned facts, newest first, capped at PINNED_FACT_CAP —
 * force-included ahead of the similarity top-k. No embedder filter:
 * a pinned row is retrieved even when it never embedded. With a query vector
 * the row's true cosine is reported when comparable (same embedder, non-null
 * embedding); otherwise the honest "not scored" 0. FENCED to narrator-visible
 * channels (slice 6): a pinned fact filed on a non-perceived channel still never
 * reaches the narrator (the fence applies uniformly, force-include notwithstanding).
 */
async function selectPinnedFacts(
  scope: MemoryScope,
  vec: string | null,
  eligibility?: WitnessEligibility,
): Promise<FactHit[]> {
  const score = vec
    ? sql<number>`coalesce(case when ${facts.embedder} = ${currentEmbedder()} then 1 - (${facts.embedding} <=> ${vec}::vector) end, 0)`
    : sql<number>`0`;
  return db()
    .select({
      id: facts.id,
      kind: facts.kind,
      subjectName: facts.subjectName,
      text: facts.text,
      score,
      pinned: facts.pinned,
      origin: facts.origin,
    })
    .from(facts)
    .where(
      and(
        memoryScopeWhere(facts, scope),
        eq(facts.status, "active"),
        eq(facts.pinned, true),
        inArray(facts.channel, [...NARRATOR_VISIBLE_FACT_CHANNELS]),
        witnessEligibilityWhere(facts.witnessedBy, eligibility),
      ),
    )
    .orderBy(desc(facts.createdAt))
    .limit(PINNED_FACT_CAP);
}

/**
 * Single-query fact retrieval: the scope's pinned facts ride ahead of the
 * similarity top-k (on top of `limit`, deduped by id), then scored hits at/above
 * FACT_MIN_SCORE (pinned rows exempt from the floor).
 * A query-embedding failure degrades to the pinned-only result with a
 * diagnostic, never a throw.
 */
export async function retrieveFacts(
  scope: MemoryScope,
  queryText: string,
  limit = FACT_RETRIEVAL_LIMIT,
  sink?: DiagnosticSink,
  eligibility?: WitnessEligibility,
): Promise<FactHit[]> {
  const query = queryText.trim();
  if (!query || limit <= 0) return [];

  let embedded: Embedded | null = null;
  try {
    embedded = await embedText(query);
  } catch (err) {
    sink?.push(
      diag("error", "memory.facts.embed_failed", `query embedding failed: ${errorText(err)}`, {
        context: { scope: scopeLabel(scope) },
      }),
    );
  }

  const vec = embedded ? toVectorLiteral(embedded.vector) : null;
  const pinnedHits = await selectPinnedFacts(scope, vec, eligibility);
  const pinnedIds = new Set(pinnedHits.map((h) => h.id));
  const candidates = vec ? await queryFactCandidates(scope, vec, limit, eligibility) : [];
  const scored = candidates.filter((c) => !pinnedIds.has(c.id) && (c.pinned || c.score >= FACT_MIN_SCORE));
  const hits = [...pinnedHits, ...scored];

  await logEvent(
    "retrieval",
    {
      kind: "facts",
      scope: scopeLabel(scope),
      minScore: FACT_MIN_SCORE,
      pinnedCount: pinnedHits.length,
      viewpointId: eligibility?.viewpointId ?? null,
      candidates: candidates.map((h) => ({ id: h.id, subjectName: h.subjectName, score: round(h.score) })),
      hitIds: hits.map((h) => h.id),
    },
    // The query is the player's own words: development detail, never stored in
    // production. The memory scope keys a memory GROUP, not a conversation, so
    // there is no chat id to pass without a lookup this path must not do.
    { content: { query: query.slice(0, 300) } },
  );
  return hits;
}

/**
 * Multi-query fact retrieval: every query embedded in one batch
 * call, one top-k cosine select per query, fused by reciprocal rank. The
 * relevance floor applies to each hit's BEST raw cosine across queries (never
 * the RRF number), pinned rows exempt and force-included ahead of the fused
 * top-k exactly as in `retrieveFacts`. Zero usable queries or an embedding
 * failure degrades to the pinned-only result.
 */
export async function retrieveFactsFused(
  scope: MemoryScope,
  queries: readonly string[],
  limit = FACT_RETRIEVAL_LIMIT,
  sink?: DiagnosticSink,
  /**
   * The turn's shared query-embedding cache (chat-agent-improvements slice 3). Passed by
   * callers that also run the episode leg (and the chat callback) over the same texts, so
   * one batch serves them all. Absent ⇒ this leg embeds its own queries, exactly as before.
   */
  embeddings?: QueryEmbeddings,
  eligibility?: WitnessEligibility,
): Promise<FusedFactHit[]> {
  const usable = nonBlankQueries(queries);

  let pairs: { query: string; vector: string }[] = [];
  if (usable.length > 0 && limit > 0) {
    if (embeddings) {
      pairs = embeddings.pairsFor(usable);
    } else {
      try {
        const embedded = await embedTexts(usable);
        pairs = embedded.map((emb, i) => ({ query: usable[i] ?? "", vector: toVectorLiteral(emb.vector) }));
      } catch (err) {
        sink?.push(
          diag("error", "memory.facts.embed_failed", `query embedding failed: ${errorText(err)}`, {
            context: { scope: scopeLabel(scope), queryCount: usable.length },
          }),
        );
      }
    }
  }

  const lists = await Promise.all(
    pairs.map(async (pair) => ({
      query: pair.query,
      hits: await queryFactCandidates(scope, pair.vector, limit, eligibility),
    })),
  );
  const fused = fuseByRrf(lists);
  const fusedById = new Map(fused.map((f) => [f.hit.id, f]));

  const pinnedHits: FusedFactHit[] = (await selectPinnedFacts(scope, null, eligibility)).map((row) => {
    const f = fusedById.get(row.id);
    return { ...row, score: f?.bestScore ?? 0, sources: f?.sources ?? [] };
  });
  const pinnedIds = new Set(pinnedHits.map((h) => h.id));

  const scored: FusedFactHit[] = fused
    .filter((f) => !pinnedIds.has(f.hit.id) && (f.hit.pinned || f.bestScore >= FACT_MIN_SCORE))
    .slice(0, limit)
    .map((f) => ({ ...f.hit, score: f.bestScore, sources: f.sources }));
  const hits = [...pinnedHits, ...scored];

  await logEvent(
    "retrieval",
    {
      kind: "facts",
      fused: true,
      scope: scopeLabel(scope),
      minScore: FACT_MIN_SCORE,
      rrfK: RRF_K,
      pinnedCount: pinnedHits.length,
      viewpointId: eligibility?.viewpointId ?? null,
      candidates: fused.map((f) => ({
        id: f.hit.id,
        subjectName: f.hit.subjectName,
        bestScore: round(f.bestScore),
        rrfScore: round(f.rrfScore, 4),
        sources: f.sources,
      })),
      hitIds: hits.map((h) => h.id),
    },
    // Player-authored text — development detail only (see `retrieveFacts`).
    { content: { queries: usable.map((q) => q.slice(0, 300)) } },
  );
  return hits;
}

/**
 * Full fact rows for a scope, newest first — the dev inspector's list read.
 * Default: active rows only; `includeInactive` adds superseded +
 * retracted history.
 */
export async function listFactsForScope(
  scope: MemoryScope,
  opts: { includeInactive?: boolean; sink?: DiagnosticSink } = {},
): Promise<FactRecord[]> {
  const where = opts.includeInactive
    ? memoryScopeWhere(facts, scope)
    : and(memoryScopeWhere(facts, scope), eq(facts.status, "active"));
  const rows = await db()
    .select({
      id: facts.id,
      kind: facts.kind,
      subjectKind: facts.subjectKind,
      subjectId: facts.subjectId,
      subjectName: facts.subjectName,
      text: facts.text,
      tags: facts.tags,
      confidence: facts.confidence,
      status: facts.status,
      pinned: facts.pinned,
      origin: facts.origin,
      channel: facts.channel,
      sourceTurnId: facts.sourceTurnId,
      sourceMessageId: facts.sourceMessageId,
      supersededById: facts.supersededById,
      createdAt: facts.createdAt,
      supersededAt: facts.supersededAt,
    })
    .from(facts)
    .where(where)
    .orderBy(desc(facts.createdAt));
  return rows.map((row) => ({
    ...row,
    tags: parseOr(stringArraySchema, row.tags, [], opts.sink, "facts.tags"),
    // Read boundary (slice 6): a stray/unknown channel value degrades to `perceived`
    // with a diagnostic, so the inspector never renders an out-of-vocabulary label.
    channel: parseFactChannel(row.channel, opts.sink),
  }));
}

/**
 * Edit/rerun reconciliation: facts sourced from the turn
 * are retracted, never deleted. Facts THEY superseded are deliberately NOT
 * reactivated — history moved past them; both stay invisible to retrieval and
 * `superseded_by_id` keeps the audit trail.
 */
/**
 * Retract every active fact extracted from one chat assistant message — the
 * edit/delete/another-take reconciliation. Status-flip, never a row delete
 * (audit trail), same as the session lane's turn retraction below. Pinned player
 * facts carry no `source_message_id`, so they never match here.
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
 * row, so this is the chat lane's bulk purge (the single "Clear Chat").
 */
export async function deleteFactsForScope(scope: MemoryScope, dbc: DbWriter = db()): Promise<number> {
  const deleted = await dbc.delete(facts).where(memoryScopeWhere(facts, scope)).returning({ id: facts.id });
  return deleted.length;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round(score: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(score * factor) / factor;
}
