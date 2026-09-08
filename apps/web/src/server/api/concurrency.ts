import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { db, jobs, JOB_STALE_MS } from "@/server/db";
import { newId } from "@/lib/ids";
import type { ApiJobType } from "./job-types";

/**
 * Per-user concurrency caps for background work.
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
 *
 * The same cutoff bounds the one-live-per-chat enqueue dedupe (`server/db/
 * job-liveness.ts`), so the two readings of "in flight" can never drift apart —
 * an orphan that no longer costs a slot must not still block a re-render.
 */
export const JOB_SLOT_STALE_MS = JOB_STALE_MS;

const ACTIVE_STATUSES = ["queued", "running"] as const;

export type JobSlotClaim =
  | { readonly ok: true; readonly jobId: string; readonly inserted: boolean }
  | { readonly ok: false; readonly active: number; readonly limit: number };

export interface ClaimJobSlotInput {
  readonly ownerId: string;
  readonly type: ApiJobType;
  readonly payload: Record<string, unknown>;
  /** Stable caller request id. An existing row converges without a new slot. */
  readonly requestedJobId?: string;
  /**
   * The conversation this work belongs to, written to the first-class `chat_id`
   * column so the row dies with its chat. Absent for work that belongs to no
   * conversation, which stores null.
   */
  readonly chatId?: string;
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
 * The count and the insert run inside one transaction that first takes a
 * per-owner advisory lock, because the conditional-INSERT form alone does NOT
 * hold under concurrency: at READ COMMITTED each parallel statement's subquery
 * counts against a snapshot that excludes the other in-flight uncommitted
 * inserts, so twenty simultaneous submits can all read "under the cap" and all
 * insert (observed: 13 of 20 admitted at a cap of 4). `pg_advisory_xact_lock`
 * serializes claims per owner — the race the UI actually produces (several
 * renders fired at once) queues on the lock and the second claimant counts the
 * first's committed row. The lock releases with the transaction, and distinct
 * owners never contend. The conditional insert stays as the in-transaction
 * check so a refusal writes nothing.
 */
export async function claimJobSlot(input: ClaimJobSlotInput): Promise<JobSlotClaim> {
  const limit = input.limit ?? MAX_CONCURRENT_JOBS_PER_USER;
  const id = input.requestedJobId ?? newId();
  const staleCutoff = sql`now() - ${JOB_SLOT_STALE_MS} * interval '1 millisecond'`;

  const inserted = await db().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`job_slot:${input.ownerId}`}, 0))`);
    if (input.requestedJobId) {
      const [existing] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, input.requestedJobId)).limit(1);
      if (existing) return { existing: true, rows: [] };
    }
    return tx.execute(sql`
      INSERT INTO "jobs" ("id", "type", "status", "owner_id", "payload", "attempts", "started_at", "heartbeat_at", "chat_id")
      SELECT ${id}, ${input.type}, 'running', ${input.ownerId}, ${JSON.stringify(input.payload)}::jsonb, 1, now(), now(), ${input.chatId ?? null}::text
      WHERE (
        SELECT count(*) FROM "jobs"
        WHERE "jobs"."owner_id" = ${input.ownerId}
          AND "jobs"."status" IN ('queued', 'running')
          AND "jobs"."created_at" > ${staleCutoff}
      ) < ${limit}
      RETURNING "id"
    `);
  });

  if ("existing" in inserted) return { ok: true, jobId: id, inserted: false };
  if (inserted.rows.length > 0) return { ok: true, jobId: id, inserted: true };
  return { ok: false, active: await activeJobCount(input.ownerId), limit };
}
