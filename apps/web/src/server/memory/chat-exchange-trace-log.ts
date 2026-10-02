import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { ZodType } from "zod";
import {
  agentFailureSchema,
  agentRunSchema,
  type AgentFailure,
  type AgentRun,
} from "@/contracts/turns/agent-failure";
import { compositionFallbackSchema, type CompositionFallback } from "@/contracts/turns/composition-fallback";
import {
  assembleExchangeTrace,
  CHAT_EXCHANGE_TRACE_EVENT,
  peekExchangeTracePartTraceId,
  type AssembledTrace,
} from "@/contracts/turns/chat-exchange-trace";
import { parseOr } from "@/lib/parse";
import { db, events } from "../db";

/**
 * Read side of the exchange-trace telemetry (#637) — written by
 * `server/engine/chat-exchange-trace.ts`, assembled by the pure
 * `assembleExchangeTrace` in `contracts/turns/chat-exchange-trace.ts`. Rows
 * live in the existing `events` table under `type = "chat_trace"` — append-only
 * observability, no migration, exactly like the agent-failure and
 * composition-fallback logs this module sits beside.
 *
 * Bounded reads only (docs/resilience.md): every scan is capped, and every row
 * crosses the trust boundary through `parseOr` — an unreadable row is dropped
 * (and, for a trace's own rows, counted in `unreadableParts` by the pure
 * assembler), never a thrown 500 on a debug page.
 *
 * **Correlation and selection are filtered by trace id in SQL, never by a
 * generic scan filtered afterward.** A chat's `chat_trace` / `agent_run` /
 * `agent_failure` / `composition_fallback` rows all share one `events` table,
 * so every query below narrows to the SELECTED trace id(s) in the `WHERE`
 * clause (`payload ->> 'traceId'` equality or `IN`) before any cap applies:
 * an active chat's newer, unrelated traffic can never crowd an older
 * selected trace's own rows out of the result. A fallback must never read as
 * a positive claim (docs/resilience.md §1), and a scan that silently dropped
 * a trace's own degraded evidence once a chat got busy enough would do
 * exactly that. The caps that remain are a defensive bound on one
 * already-narrow, trace-scoped result, never the selection mechanism itself.
 */

/** Event-type literals for the correlated rows — redeclared locally, same as `agent-failure-log.ts` /
 * `composition-fallback-log.ts` already do, rather than cross-importing between `server/ai` and
 * `server/memory`. */
const AGENT_RUN_EVENT = "agent_run";
const AGENT_FAILURE_EVENT = "agent_failure";
const COMPOSITION_FALLBACK_EVENT = "composition_fallback";

/** Defensive bound on one trace's own `chat_trace` rows (flushes, not traces — usually a handful
 * per exchange), and on the set loaded for an `IN (traceIds)` lookup (at most `limit`, max 50,
 * traces' worth). Not the selection mechanism — see the module doc. */
export const TRACE_ROW_SCAN_CAP = 2000;
/** Defensive bound per correlated type, applied AFTER the `traceId IN (...)` filter — see the
 * module doc. A single trace realistically carries a handful of these; this is headroom, not a
 * limit that is ever expected to bind. */
const AGENT_RUN_SCAN_CAP = 1000;
const AGENT_FAILURE_SCAN_CAP = 1000;
const COMPOSITION_FALLBACK_SCAN_CAP = 1000;

export interface LoadChatExchangeTracesQuery {
  chatId: string;
  /** Load exactly this trace, when known. */
  traceId?: string;
  /** Load whichever trace's header names this message as its prompt, reply, or guard line. */
  messageId?: string;
  /** Caps the number of TRACES returned (not rows). Default 1, max 50. */
  limit?: number;
}

const DEFAULT_LIMIT = 1;
const MAX_LIMIT = 50;

/** Scan a chat's rows of one `events.type`, narrowed to `traceIds` in SQL, parsed through `schema`
 * (`parseOr`-dropping anything unreadable). Empty `traceIds` short-circuits without a query. */
async function scanChatEventsForTraces<T>(
  schema: ZodType<T>,
  type: string,
  chatId: string,
  traceIds: readonly string[],
  cap: number,
): Promise<T[]> {
  if (traceIds.length === 0) return [];
  const rows = await db()
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.type, type), eq(events.chatId, chatId), inArray(sql`${events.payload} ->> 'traceId'`, traceIds)))
    .orderBy(desc(events.createdAt))
    .limit(cap);
  return rows.flatMap((row) => {
    const parsed = parseOr<T | null>(schema, row.payload, null);
    return parsed === null ? [] : [parsed];
  });
}

/** The newest `limit` distinct trace ids active on this chat, ordered by when EACH STARTED —
 * `min(created_at)`, part 0's own write — not by its most recent flush. A late part (a
 * `post_turn.shadow` or `jobs.scene_enqueue` flush landing after the next exchange has already
 * begun) must not make an older exchange outrank a genuinely newer one. An aggregate GROUP BY,
 * not a bounded row scan, so an older trace's activity window is decided by actual recency
 * rather than by how many OTHER rows this chat has written since. */
async function latestTraceIds(chatId: string, limit: number): Promise<string[]> {
  const rows = await db()
    .select({ traceId: sql<string>`${events.payload} ->> 'traceId'` })
    .from(events)
    .where(
      and(
        eq(events.type, CHAT_EXCHANGE_TRACE_EVENT),
        eq(events.chatId, chatId),
        sql`${events.payload} ->> 'traceId' is not null`,
      ),
    )
    .groupBy(sql`${events.payload} ->> 'traceId'`)
    .orderBy(desc(sql`min(${events.createdAt})`))
    .limit(limit);
  return rows.map((row) => row.traceId);
}

/** The newest `limit` distinct trace ids whose header (in ANY of that trace's own parts) names
 * `messageId` as its prompt, reply, or guard line — a direct jsonb predicate, not a bounded scan.
 * Ordered by `min(created_at)` (when each trace STARTED), the same rule {@link latestTraceIds}
 * uses, so the two paths agree on what "newest" means. */
async function traceIdsMatchingMessage(chatId: string, messageId: string, limit: number): Promise<string[]> {
  const rows = await db()
    .select({ traceId: sql<string>`${events.payload} ->> 'traceId'` })
    .from(events)
    .where(
      and(
        eq(events.type, CHAT_EXCHANGE_TRACE_EVENT),
        eq(events.chatId, chatId),
        sql`${events.payload} ->> 'traceId' is not null`,
        sql`(
          ${events.payload} -> 'header' ->> 'promptMessageId' = ${messageId}
          or ${events.payload} -> 'header' ->> 'replyMessageId' = ${messageId}
          or ${events.payload} -> 'header' ->> 'guardMessageId' = ${messageId}
        )`,
      ),
    )
    .groupBy(sql`${events.payload} ->> 'traceId'`)
    .orderBy(desc(sql`min(${events.createdAt})`))
    .limit(limit);
  return rows.map((row) => row.traceId);
}

/** Load every part belonging to any of `traceIds`, bucketed by trace id (an `IN` predicate, one
 * query, {@link TRACE_ROW_SCAN_CAP}-bounded). A trace id with no rows is simply absent from the
 * returned map — the caller's existence check, rather than this function synthesizing anything. */
async function loadPartsForTraceIds(chatId: string, traceIds: readonly string[]): Promise<Map<string, unknown[]>> {
  const byTraceId = new Map<string, unknown[]>();
  if (traceIds.length === 0) return byTraceId;
  const rows = await db()
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.type, CHAT_EXCHANGE_TRACE_EVENT),
        eq(events.chatId, chatId),
        inArray(sql`${events.payload} ->> 'traceId'`, traceIds),
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(TRACE_ROW_SCAN_CAP);
  for (const row of rows) {
    const traceId = peekExchangeTracePartTraceId(row.payload);
    if (traceId === null) continue;
    const bucket = byTraceId.get(traceId);
    if (bucket === undefined) byTraceId.set(traceId, [row.payload]);
    else bucket.push(row.payload);
  }
  return byTraceId;
}

/**
 * Load this chat's exchange traces, newest first, by latest, `limit`, `traceId`, or `messageId`.
 * "Newest" means when each exchange STARTED, never when its last flush happened to land — a
 * late part (`post_turn.shadow`, `jobs.scene_enqueue`) must not make an older exchange outrank
 * one that genuinely started more recently.
 *
 * 1. Resolve the target trace id(s) — a direct equality (`traceId` given), a jsonb-predicate
 *    aggregate ({@link traceIdsMatchingMessage}), or the newest-N aggregate ({@link latestTraceIds}).
 *    Both aggregates order by `min(created_at)` (part 0's own write), the same rule applied below.
 * 2. Load those trace ids' own parts in one `IN`-filtered query ({@link loadPartsForTraceIds}).
 *    An explicit `traceId` that matched nothing is dropped here, never assembled into an empty
 *    trace object.
 * 3. Load each correlated type ONCE, narrowed to the resolved trace ids
 *    ({@link scanChatEventsForTraces}) — never a chat-wide scan a busy chat's newer traces could
 *    crowd an older selected trace's own rows out of.
 * 4. Hand everything to the pure {@link assembleExchangeTrace}, which does the actual per-trace
 *    parsing/merge/outcome work, then sort the ASSEMBLED traces by `header.startedAt` — the
 *    authoritative in-memory exchange-start timestamp, which agrees with step 1's SQL-side
 *    `min(created_at)` proxy in the ordinary case and is the one source of truth when a trace's
 *    very first flush itself lands late.
 */
export async function loadChatExchangeTraces(query: LoadChatExchangeTracesQuery): Promise<AssembledTrace[]> {
  const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  const targetTraceIds = query.traceId
    ? [query.traceId]
    : query.messageId
      ? await traceIdsMatchingMessage(query.chatId, query.messageId, limit)
      : await latestTraceIds(query.chatId, limit);
  if (targetTraceIds.length === 0) return [];

  const partsByTraceId = await loadPartsForTraceIds(query.chatId, targetTraceIds);
  // Drops an explicit `traceId` that matched no rows at all, rather than assembling a synthetic
  // empty trace for it. Order is re-derived from `header.startedAt` below regardless.
  const resolvedTraceIds = targetTraceIds.filter((traceId) => (partsByTraceId.get(traceId)?.length ?? 0) > 0);
  if (resolvedTraceIds.length === 0) return [];

  const [agentRuns, agentFailures, compositionFallbacks] = await Promise.all([
    scanChatEventsForTraces<AgentRun>(agentRunSchema, AGENT_RUN_EVENT, query.chatId, resolvedTraceIds, AGENT_RUN_SCAN_CAP),
    scanChatEventsForTraces<AgentFailure>(
      agentFailureSchema,
      AGENT_FAILURE_EVENT,
      query.chatId,
      resolvedTraceIds,
      AGENT_FAILURE_SCAN_CAP,
    ),
    scanChatEventsForTraces<CompositionFallback>(
      compositionFallbackSchema,
      COMPOSITION_FALLBACK_EVENT,
      query.chatId,
      resolvedTraceIds,
      COMPOSITION_FALLBACK_SCAN_CAP,
    ),
  ]);

  const traces = resolvedTraceIds.map((traceId) =>
    assembleExchangeTrace({
      traceId,
      chatId: query.chatId,
      parts: partsByTraceId.get(traceId) ?? [],
      agentRuns: agentRuns.filter((r) => r.traceId === traceId),
      agentFailures: agentFailures.filter((f) => f.traceId === traceId),
      compositionFallbacks: compositionFallbacks.filter((f) => f.traceId === traceId),
    }),
  );
  // The authoritative final order: each trace's OWN recorded start time, descending. ISO strings
  // (or "" when a trace's header never resolved — sorts last, never a false claim of being newest)
  // compare correctly as plain strings.
  traces.sort((a, b) => (a.header.startedAt > b.header.startedAt ? -1 : a.header.startedAt < b.header.startedAt ? 1 : 0));
  return traces;
}
