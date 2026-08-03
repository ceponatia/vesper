import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "./client";
import { jobs } from "./schema";

/**
 * "Is a job of this type already in flight for this chat?" — the one-live-per-chat
 * dedupe every detached enqueue path shares (scene render, scene sketch, summary
 * fold, meanwhile pass, look/place mints).
 *
 * The subtle part is the STALENESS bound. A job row only reaches a terminal
 * status because the process that started it lives long enough to write one
 * (`server/api/jobs.ts` settles it in a `.then`/`.catch`); nothing reclaims a row
 * whose process died. A Fly deploy replaces the machine mid-render, and the row
 * it was running stays `running` forever.
 *
 * Unbounded, that permanently wedges the feature for that chat: the dedupe keeps
 * seeing a live job, so every later request is refused and the client's
 * "rendering" flag never clears — the user sees a spinner that can never finish
 * (owner report 2026-08-02: a chat scene image killed by a deploy, one second
 * into its render, wedged that chat's scene rendering for good).
 *
 * So liveness is bounded exactly as the per-user concurrency cap already bounds
 * its slot count (`server/api/concurrency.ts` — same constant, same reasoning):
 * a job older than {@link JOB_STALE_MS} is presumed dead and no longer blocks a
 * new one. The cost of being wrong is one duplicate job after 15 minutes; the
 * cost of the alternative is a feature that never works again.
 */

/**
 * How long a `queued`/`running` row counts as in flight. Anything slower than
 * this is either dead or so slow the user has long since given up — 15 minutes
 * against observed scene renders of 15–110s.
 */
export const JOB_STALE_MS = 15 * 60_000;

/** The chat-scoped job types that dedupe one-live-per-chat. */
export type JobType = (typeof jobs.$inferSelect)["type"];

/**
 * Whether a non-stale `queued`/`running` job of `type` exists for `chatId`.
 * Callers use it both as the enqueue dedupe and (for the scene lane) as the
 * client's "still rendering" flag, so the same staleness rule governs both.
 */
export async function hasLiveChatJob(type: JobType, chatId: string): Promise<boolean> {
  const [live] = await db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, type),
        inArray(jobs.status, ["queued", "running"]),
        gt(jobs.createdAt, new Date(Date.now() - JOB_STALE_MS)),
        sql`${jobs.payload} ->> 'chatId' = ${chatId}`,
      ),
    )
    .limit(1);
  return live !== undefined;
}
