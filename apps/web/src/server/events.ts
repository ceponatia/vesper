import { db, events } from "./db";
import { log } from "@/server/log";

/**
 * What a caller knows about an event beyond its diagnostic payload.
 *
 * The split is the point. `payload` is **diagnostic data** — ids, statuses,
 * counts, scores, durations, error classes — and is stored everywhere. `content`
 * is **user-authored or roleplay-derived text** — a retrieval query, a prompt, a
 * voice line, what a model actually wrote — and is stored only outside
 * production. Telemetry must help debug the app without becoming a second copy
 * of a player's roleplay history.
 */
export interface LogEventOptions {
  /**
   * The conversation this event belongs to, when the caller already holds one.
   * Written to `events.chat_id`, which cascades from the chat: deleting the
   * conversation takes its telemetry with it. Never look one up to fill this in.
   */
  chatId?: string | null;
  /** Text keys merged into the payload outside production, dropped in production. */
  content?: Record<string, unknown>;
}

/** The row `logEvent` inserts — the pure result of the production rule. */
export interface EventRow {
  type: string;
  payload: Record<string, unknown>;
  chatId: string | null;
}

/**
 * Decide what actually gets stored. PURE — the production-vs-development rule is
 * one function so it is testable without a database.
 *
 * In production the `content` keys are never stored at all; the row holds the
 * diagnostic payload alone. Outside production they are merged in, so the dev
 * chat inspector keeps the detail it renders. `payload` is spread LAST, so a
 * development row is exactly its production row plus the content keys — a
 * content key can never shadow a diagnostic one.
 */
export function buildEventRow(
  type: string,
  payload: Record<string, unknown>,
  opts: LogEventOptions | undefined,
  production: boolean,
): EventRow {
  const content = production ? undefined : opts?.content;
  return {
    type,
    payload: content ? { ...content, ...payload } : { ...payload },
    chatId: opts?.chatId ?? null,
  };
}

/**
 * Observability stream (docs/database/README.md §Operational tables).
 * Fire-and-forget: an event insert failure must never affect the caller — that
 * includes the foreign key on `chat_id`, so a conversation deleted mid-flight
 * makes the insert fail and be swallowed exactly like any other insert failure.
 *
 * Rows age out after 30 days (`server/retention/events.ts`).
 */
export async function logEvent(
  type: string,
  payload: Record<string, unknown>,
  opts?: LogEventOptions,
): Promise<void> {
  try {
    await db()
      .insert(events)
      .values(buildEventRow(type, payload, opts, process.env.NODE_ENV === "production"));
  } catch (err) {
    log.warn("events", `failed to record ${type}`, { error: err instanceof Error ? err.message : String(err) });
  }
}
