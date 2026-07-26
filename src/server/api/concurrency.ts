import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { db, jobs } from "@/server/db";
import { newId } from "@/lib/ids";
import type { ApiJobType } from "./job-types";

/**
 * Per-user concurrency caps for background work (rate-limits.plan.md slice 5).
 *
 * Per-minute limits bound how often a user may *start* work; they say nothing
 * about how much can be in flight at once. Twenty image renders submitted inside
 * one window are twenty simultaneous provider calls, so the queue needs its own
 * ceiling.
 */

export const MAX_CONCURRENT_JOBS_PER_USER = 4;

/**
 * A job orphaned by a crash keeps `status = 'running'` forever. Counting only
 * recent rows means a lost job costs its owner a slot for this long instead of
 * permanently — self-healing without a reaper process.
 */
export const JOB_SLOT_STALE_MS = 15 * 60_000;

const ACTIVE_STATUSES = ["queued", "running"] as const;

export type JobSlotClaim =
  | { readonly ok: true; readonly jobId: string }
  | { readonly ok: false; readonly active: number; readonly limit: number };

export interface ClaimJobSlotInput {
  readonly ownerId: string;
  readonly type: ApiJobType;
  readonly payload: Record<string, unknown>;
  readonly limit?: number;
}

/** Active (queued or running, non-stale) background jobs for one owner. */
export async function activeJobCount(ownerId: string, staleMs = JOB_SLOT_STALE_MS): Promise<number> {
  const [row] = await db()
    .select({ active: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.ownerId, ownerId),
        inArray(jobs.status, [...ACTIVE_STATUSES]),
        gt(jobs.createdAt, new Date(Date.now() - staleMs)),
      ),
    );
  return row?.active ?? 0;
}

/**
 * Insert a running job row only if the owner is under their concurrency cap.
 *
 * Count and insert are one statement on purpose. A read-then-write check loses
 * the race that matters most here — the UI fires several renders at once, so
 * "both requests counted 3 and both inserted" is the normal case, not the
 * exotic one. Postgres evaluates the subquery against the same snapshot as the
 * insert, so the cap is enforced by the database rather than by timing.
 */
export async function claimJobSlot(input: ClaimJobSlotInput): Promise<JobSlotClaim> {
  const limit = input.limit ?? MAX_CONCURRENT_JOBS_PER_USER;
  const id = newId();
  const staleCutoff = sql`now() - ${JOB_SLOT_STALE_MS} * interval '1 millisecond'`;

  const inserted = await db().execute(sql`
    INSERT INTO "jobs" ("id", "type", "status", "owner_id", "payload", "attempts", "started_at", "heartbeat_at")
    SELECT ${id}, ${input.type}, 'running', ${input.ownerId}, ${JSON.stringify(input.payload)}::jsonb, 1, now(), now()
    WHERE (
      SELECT count(*) FROM "jobs"
      WHERE "jobs"."owner_id" = ${input.ownerId}
        AND "jobs"."status" IN ('queued', 'running')
        AND "jobs"."created_at" > ${staleCutoff}
    ) < ${limit}
    RETURNING "id"
  `);

  if (inserted.rows.length > 0) return { ok: true, jobId: id };
  return { ok: false, active: await activeJobCount(input.ownerId), limit };
}
