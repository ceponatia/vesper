import { db, events } from "./db";
import { log } from "@/lib/log";

/**
 * Observability stream (docs/database.md). Fire-and-forget: an event insert
 * failure must never affect the caller.
 */
export async function logEvent(sessionId: string | null, type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await db().insert(events).values({ sessionId, type, payload });
  } catch (err) {
    log.warn("events", `failed to record ${type}`, { error: err instanceof Error ? err.message : String(err) });
  }
}
