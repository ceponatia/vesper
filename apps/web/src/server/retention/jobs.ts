import { and, inArray, sql } from "drizzle-orm";
import { db, jobs } from "@/server/db";
import { RETENTION_BATCH_SIZE, type RetentionPass } from "./pass";

/**
 * How long a settled job row is kept. A `done`/`failed` row is a receipt: the UI
 * has long since read whatever it was polling for (an image row's status, a
 * summary, a mint), and an operator reading a failure is looking at hours, not
 * weeks.
 */
export const JOB_RETENTION_DAYS = 7;

const RETENTION_MS = JOB_RETENTION_DAYS * 24 * 60 * 60_000;

/**
 * Delete terminal (`done` / `failed`) job rows older than
 * {@link JOB_RETENTION_DAYS}.
 *
 * `queued` and `running` rows are NEVER touched, at any age. An old live row is
 * an orphan, and turning it into an honest `failed` row with a reason belongs to
 * `reclaimOrphanedJobs` on this same tick; deleting it here would destroy that
 * evidence before it was ever written. A reclaimed row becomes eligible on its
 * own terms, seven days after it settles.
 *
 * Age is measured from `finished_at` and falls back to `created_at` for terminal
 * rows that carry no finish stamp (legacy rows, and any settle whose timestamp
 * write was lost) — without the fallback a null `finished_at` would keep a row
 * forever.
 *
 * This pass cannot erase the sweep's durable "already swept" guard: `sweptRecently`
 * (`server/images/assets.ts`) looks for an `image_sweep` row inside a SIX-HOUR
 * window, so every marker old enough to delete here stopped being read days ago.
 *
 * Bounded to {@link RETENTION_BATCH_SIZE} rows per run — Postgres `DELETE` has no
 * `LIMIT`, hence the `id IN (SELECT … LIMIT n)` form — and a backlog is worked
 * down over ticks. There is deliberately no mass-expiry refusal: status and age
 * are read from the database itself, so a big batch is legitimate cleanup rather
 * than the missing-volume symptom that makes the image sweep refuse.
 */
export const jobsExpired: RetentionPass = {
  name: "jobsExpired",
  async run(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    const expired = and(
      inArray(jobs.status, ["done", "failed"]),
      sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt}) < ${cutoff}`,
    );
    const deleted = await db()
      .delete(jobs)
      .where(inArray(jobs.id, db().select({ id: jobs.id }).from(jobs).where(expired).limit(RETENTION_BATCH_SIZE)))
      .returning({ id: jobs.id });
    return deleted.length;
  },
};
