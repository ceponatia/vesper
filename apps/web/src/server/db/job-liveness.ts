import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
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
 * Fail every `queued`/`running` row older than {@link JOB_STALE_MS} — the rows whose
 * process is gone. Nothing re-drives this table (a `queued` row is kicked in-process the
 * moment it is inserted, and only that process ever settles it), so a row past the bound
 * is dead by construction, not merely slow.
 *
 * The staleness bound already makes those rows harmless; this is the bookkeeping half,
 * so the table reads honestly and an operator looking at `running` sees work that is
 * actually running. Runs from the periodic sweep (`images/sweep-schedule.ts`). Returns
 * how many rows were reclaimed.
 */
export async function reclaimOrphanedJobs(now: Date = new Date()): Promise<number> {
  const reclaimed = await db()
    .update(jobs)
    .set({
      status: "failed",
      error: "orphaned (the process that started it never settled it); reclaimed by the sweep",
      finishedAt: now,
    })
    .where(
      and(
        inArray(jobs.status, ["queued", "running"]),
        lt(jobs.createdAt, new Date(now.getTime() - JOB_STALE_MS)),
      ),
    )
    .returning({ id: jobs.id });
  return reclaimed.length;
}

/**
 * Whether a non-stale `queued`/`running` job of `type` exists for `chatId`.
 * Callers use it both as the enqueue dedupe and (for the scene lane) as the
 * client's "still rendering" flag, so the same staleness rule governs both.
 *
 * Read from the PAYLOAD, not from the first-class `jobs.chat_id` column, and
 * deliberately so: every chat-lane enqueue writes the id to both, the payload is
 * the reading the character dedupe below shares, and a chat-scoped row can only
 * be live while its chat exists (the column's `ON DELETE CASCADE` takes the row
 * with the chat). The two readings therefore agree on every row this predicate
 * can see.
 */
export function hasLiveChatJob(type: JobType, chatId: string): Promise<boolean> {
  return hasLiveJobForSubject(type, "chatId", chatId);
}

/**
 * The same dedupe keyed on a CHARACTER — identity-pack preparation is queued from
 * every canonical-portrait write (generate, upload/promote, clone), and a user
 * clicking through three portraits in a row must not start three derivations of
 * the same face.
 *
 * Same staleness bound, for the same reason: a deploy that kills a derivation
 * mid-flight must not wedge that character's pack forever.
 */
export function hasLiveCharacterJob(type: JobType, characterId: string): Promise<boolean> {
  return hasLiveJobForSubject(type, "characterId", characterId);
}

/** The payload id fields a one-live-per-subject dedupe may key on. */
type LiveJobSubject = "chatId" | "characterId";

/**
 * The shared query behind both dedupes. The payload key is interpolated with
 * `sql.raw` because `jsonb ->> $1` is ambiguous to Postgres (the operator is
 * overloaded on `text` and `integer`, so an untyped bind parameter fails to
 * resolve); the value can only ever be a member of the closed union above, so
 * nothing user-supplied reaches the statement text.
 */
function hasLiveJobForSubject(type: JobType, subject: LiveJobSubject, id: string): Promise<boolean> {
  return db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, type),
        inArray(jobs.status, ["queued", "running"]),
        gt(jobs.createdAt, new Date(Date.now() - JOB_STALE_MS)),
        sql`${jobs.payload} ->> ${sql.raw(`'${subject}'`)} = ${id}`,
      ),
    )
    .limit(1)
    .then((rows) => rows.length > 0);
}
