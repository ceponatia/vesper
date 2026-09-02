import { sql } from "drizzle-orm";
import { db, events } from "@/server/db";
import { RETENTION_BATCH_SIZE, type RetentionPass } from "./pass";

/**
 * How long an observability row is worth keeping. Telemetry answers "is a leg
 * failing, and how slow is it right now?" — a question about the build running
 * today. Past a month a row is no longer a diagnostic, only a retained copy of
 * what a player was doing, so it goes.
 */
export const EVENT_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete `events` rows older than {@link EVENT_RETENTION_DAYS}, at most
 * {@link RETENTION_BATCH_SIZE} per tick.
 *
 * Postgres `DELETE` has no `LIMIT`, so the bound is a subquery of ids. Expiry is
 * decided entirely from `created_at`, so a large backlog is ordinary cleanup
 * worked down over ticks — there is deliberately no mass-expiry refusal here
 * (that safeguard belongs to the image sweep, where a missing volume can make
 * every row *look* orphaned).
 *
 * Chat-scoped rows usually leave earlier than this: `events.chat_id` cascades,
 * so deleting a conversation takes its telemetry immediately. This pass is what
 * clears the rest — the rows with no conversation to be deleted along with.
 */
export const eventsRetentionPass: RetentionPass = {
  name: "eventsExpired",
  async run(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * DAY_MS);
    const expired = sql`select ${events.id} from ${events} where ${events.createdAt} < ${cutoff} limit ${RETENTION_BATCH_SIZE}`;
    const deleted = await db()
      .delete(events)
      .where(sql`${events.id} in (${expired})`)
      .returning({ id: events.id });
    return deleted.length;
  },
};
