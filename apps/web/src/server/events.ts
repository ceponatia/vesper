import { db, events } from "./db";
import { log } from "@/server/log";

/**
 * Observability stream (docs/database/README.md §Operational tables).
 * Fire-and-forget: an event insert
 * failure must never affect the caller.
 */
export async function logEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await db().insert(events).values({ type, payload });
  } catch (err) {
    log.warn("events", `failed to record ${type}`, { error: err instanceof Error ? err.message : String(err) });
  }
}
