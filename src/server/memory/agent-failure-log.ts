import { and, desc, eq, gte, sql } from "drizzle-orm";
import { agentFailureSchema, tallyAgentFailures, type AgentFailure } from "@/contracts/turns/agent-failure";
import { parseOr } from "@/lib/parse";
import { db, events } from "../db";

/**
 * Read side of the agent-failure telemetry (written by `server/ai/agent-failures.ts`,
 * contract + classifier in `contracts/turns/agent-failure.ts`). Rows live in the existing
 * `events` table under `type = "agent_failure"` — append-only observability, which is what
 * that table is for, and no migration for a debug surface.
 *
 * Every row crosses a trust boundary on the way back (a jsonb payload written by an older
 * build may be missing fields), so it is `parseOr`'d at the boundary — an unreadable row is
 * dropped, never a thrown 500 on a debug page.
 */

const AGENT_FAILURE_EVENT = "agent_failure";

export interface AgentFailureQuery {
  /** Restrict to one conversation (the inspector's per-chat panel). Omit for the global view. */
  chatId?: string;
  /** Only failures at or after this instant. */
  since: Date;
  /** Cap on the returned list (the tally counts every matched row, not just these). */
  limit?: number;
}

export interface AgentFailureReport {
  /** The most recent failures, newest first (capped by `limit`). */
  recent: AgentFailure[];
  total: number;
  byLeg: { key: string; count: number }[];
  byCause: { key: string; count: number }[];
}

/**
 * Fetch + tally failures. The tally is computed over the whole matched window, in app code
 * rather than SQL: the window is small (a debug view over hours/days of one user's chats),
 * the payload is jsonb, and the pure `tallyAgentFailures` is already the tested seam.
 */
export async function agentFailureReport(query: AgentFailureQuery): Promise<AgentFailureReport> {
  const limit = query.limit ?? 50;
  const rows = await db()
    .select({ payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(
      and(
        eq(events.type, AGENT_FAILURE_EVENT),
        gte(events.createdAt, query.since),
        // Chat-scoped rows carry their conversation in the payload (the chat lane has no
        // session id, so `events.session_id` is null for all of them).
        ...(query.chatId ? [sql`${events.payload} ->> 'chatId' = ${query.chatId}`] : []),
      ),
    )
    .orderBy(desc(events.createdAt))
    // A hard ceiling on how much of the window we ever read into memory. The tally is over
    // what we read — stated as such in the UI, never silently truncated.
    .limit(TALLY_SCAN_CAP);

  const failures = rows.flatMap((row) => {
    const parsed = parseOr<AgentFailure | null>(agentFailureSchema, row.payload, null);
    if (!parsed) return [];
    // An old row with no stamped `at` falls back to the event's own clock.
    return [parsed.at ? parsed : { ...parsed, at: row.createdAt?.toISOString() ?? "" }];
  });

  const tally = tallyAgentFailures(failures);
  return {
    recent: failures.slice(0, limit),
    total: tally.total,
    byLeg: tally.byLeg,
    byCause: tally.byCause,
  };
}

/**
 * How many rows the tally ever scans. Well above any plausible failure count for a debug
 * window (a healthy build records zero), and a bound on the memory this debug read can cost.
 */
export const TALLY_SCAN_CAP = 1000;
