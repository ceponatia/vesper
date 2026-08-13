import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  compositionFallbackSchema,
  tallyCompositionFallbacks,
  type CompositionFallback,
} from "@/contracts/turns/composition-fallback";
import { parseOr } from "@/lib/parse";
import { db, events } from "../db";

/**
 * Read side of the composition-fallback telemetry (written by
 * `server/engine/composition-diagnostics.ts` — C15). Rows live in the existing `events` table
 * under `type = "composition_fallback"` — append-only observability, no migration for a debug
 * surface, exactly like the agent-failure log.
 *
 * Every row crosses a trust boundary on the way back (a jsonb payload from an older build may
 * be missing fields), so it is `parseOr`'d — an unreadable row is dropped, never a thrown 500
 * on a debug page (docs/resilience.md).
 */

const COMPOSITION_FALLBACK_EVENT = "composition_fallback";

/**
 * How many rows the tally ever scans. Well above any plausible degradation count for a debug
 * window (a healthy build records few or none), and a bound on the memory this read can cost.
 */
export const COMPOSITION_TALLY_SCAN_CAP = 1000;

export interface CompositionFallbackQuery {
  /** Restrict to one conversation (the inspector's per-chat panel). Omit for the global view. */
  chatId?: string;
  since: Date;
  /** Cap on the returned list (the tally counts every matched row, not just these). */
  limit?: number;
}

export interface CompositionFallbackReport {
  recent: CompositionFallback[];
  total: number;
  byCode: { key: string; count: number }[];
  bySite: { key: string; count: number }[];
}

/** Fetch + tally composition fallbacks over the window (pure tally in app code, small window). */
export async function compositionFallbackReport(
  query: CompositionFallbackQuery,
): Promise<CompositionFallbackReport> {
  const limit = query.limit ?? 50;
  const rows = await db()
    .select({ payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(
      and(
        eq(events.type, COMPOSITION_FALLBACK_EVENT),
        gte(events.createdAt, query.since),
        ...(query.chatId ? [sql`${events.payload} ->> 'chatId' = ${query.chatId}`] : []),
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(COMPOSITION_TALLY_SCAN_CAP);

  const fallbacks = rows.flatMap((row) => {
    const parsed = parseOr<CompositionFallback | null>(compositionFallbackSchema, row.payload, null);
    if (!parsed) return [];
    return [parsed.at ? parsed : { ...parsed, at: row.createdAt?.toISOString() ?? "" }];
  });

  const tally = tallyCompositionFallbacks(fallbacks);
  return { recent: fallbacks.slice(0, limit), total: tally.total, byCode: tally.byCode, bySite: tally.bySite };
}
