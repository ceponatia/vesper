import { and, desc, eq } from "drizzle-orm";
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
  parseExchangeTracePart,
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
 * crosses the trust boundary through `parseExchangeTracePart` / `parseOr` — an
 * unreadable row is dropped (and, for a trace's own rows, counted in
 * `unreadableParts`), never a thrown 500 on a debug page.
 */

/** Event-type literals for the correlated rows — redeclared locally, same as `agent-failure-log.ts` /
 * `composition-fallback-log.ts` already do, rather than cross-importing between `server/ai` and
 * `server/memory`. */
const AGENT_RUN_EVENT = "agent_run";
const AGENT_FAILURE_EVENT = "agent_failure";
const COMPOSITION_FALLBACK_EVENT = "composition_fallback";

/** How many of this chat's OWN `chat_trace` rows (flushes, not traces — usually a handful per
 * exchange) a read ever scans. Generous: even `limit`'s max of 50 traces at several flushes
 * each stays well under this. */
export const TRACE_ROW_SCAN_CAP = 2000;
/** How many correlated agent_run / agent_failure / composition_fallback rows a read ever scans
 * per type, for this chat. Mirrors the existing per-type tally caps. */
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

/** One row's `payload`, as scanned, plus when it was written (for "newest first"). */
interface ScannedRow {
  payload: unknown;
  createdAt: Date;
}

/** Scan a chat's rows of one `events.type`, parse each through `schema`, and drop what fails (`parseOr`). */
async function scanChatEventsByType<T>(schema: ZodType<T>, type: string, chatId: string, cap: number): Promise<T[]> {
  const rows = await db()
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.type, type), eq(events.chatId, chatId)))
    .orderBy(desc(events.createdAt))
    .limit(cap);
  return rows.flatMap((row) => {
    const parsed = parseOr<T | null>(schema, row.payload, null);
    return parsed === null ? [] : [parsed];
  });
}

/** Does this raw part's own header patch name `messageId` as its prompt / reply / guard line? */
function partNamesMessage(raw: unknown, messageId: string): boolean {
  const header = parseExchangeTracePart(raw)?.header;
  if (!header) return false;
  return header.promptMessageId === messageId || header.replyMessageId === messageId || header.guardMessageId === messageId;
}

/**
 * Load this chat's exchange traces, newest first, by latest, `limit`, `traceId`, or `messageId`.
 *
 * Reads the chat's `chat_trace` rows ONCE (bounded by {@link TRACE_ROW_SCAN_CAP}), groups them
 * by their own `traceId` (a cheap peek — a row too malformed to even identify its trace is
 * simply not grouped, never attributed), then:
 * - `traceId` given: that one trace, if its rows were seen at all.
 * - `messageId` given: traces whose header names it, newest first, capped at `limit`.
 * - neither given: the `limit` most recently active traces.
 *
 * Correlated `agent_run` / `agent_failure` / `composition_fallback` rows for the chat are
 * loaded once and filtered to the selected trace ids before handing everything to the pure
 * {@link assembleExchangeTrace}, which does the actual per-trace parsing/merge/outcome work.
 */
export async function loadChatExchangeTraces(query: LoadChatExchangeTracesQuery): Promise<AssembledTrace[]> {
  const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  const rows = await db()
    .select({ payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(eq(events.type, CHAT_EXCHANGE_TRACE_EVENT), eq(events.chatId, query.chatId)))
    .orderBy(desc(events.createdAt))
    .limit(TRACE_ROW_SCAN_CAP);

  const byTraceId = new Map<string, { parts: unknown[]; lastSeen: Date }>();
  for (const row of rows as ScannedRow[]) {
    const traceId = peekExchangeTracePartTraceId(row.payload);
    if (traceId === null) continue;
    const bucket = byTraceId.get(traceId);
    if (bucket === undefined) {
      byTraceId.set(traceId, { parts: [row.payload], lastSeen: row.createdAt });
    } else {
      bucket.parts.push(row.payload);
      if (row.createdAt > bucket.lastSeen) bucket.lastSeen = row.createdAt;
    }
  }

  let targetTraceIds: string[];
  if (query.traceId) {
    targetTraceIds = byTraceId.has(query.traceId) ? [query.traceId] : [];
  } else {
    const candidates = query.messageId
      ? [...byTraceId.entries()].filter(([, bucket]) => bucket.parts.some((raw) => partNamesMessage(raw, query.messageId as string)))
      : [...byTraceId.entries()];
    targetTraceIds = candidates
      .sort((a, b) => b[1].lastSeen.getTime() - a[1].lastSeen.getTime())
      .slice(0, limit)
      .map(([traceId]) => traceId);
  }
  if (targetTraceIds.length === 0) return [];

  const [agentRuns, agentFailures, compositionFallbacks] = await Promise.all([
    scanChatEventsByType<AgentRun>(agentRunSchema, AGENT_RUN_EVENT, query.chatId, AGENT_RUN_SCAN_CAP),
    scanChatEventsByType<AgentFailure>(agentFailureSchema, AGENT_FAILURE_EVENT, query.chatId, AGENT_FAILURE_SCAN_CAP),
    scanChatEventsByType<CompositionFallback>(
      compositionFallbackSchema,
      COMPOSITION_FALLBACK_EVENT,
      query.chatId,
      COMPOSITION_FALLBACK_SCAN_CAP,
    ),
  ]);

  const traces = targetTraceIds.map((traceId) =>
    assembleExchangeTrace({
      traceId,
      chatId: query.chatId,
      parts: byTraceId.get(traceId)?.parts ?? [],
      agentRuns: agentRuns.filter((r) => r.traceId === traceId),
      agentFailures: agentFailures.filter((f) => f.traceId === traceId),
      compositionFallbacks: compositionFallbacks.filter((f) => f.traceId === traceId),
    }),
  );

  // `targetTraceIds` is already newest-first for the latest/messageId paths; a single explicit
  // `traceId` lookup is trivially sorted too. Re-deriving the order here (rather than trusting
  // the construction above) keeps this function correct even if that ordering logic changes.
  traces.sort((a, b) => (byTraceId.get(b.traceId)?.lastSeen.getTime() ?? 0) - (byTraceId.get(a.traceId)?.lastSeen.getTime() ?? 0));
  return traces;
}
