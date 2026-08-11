import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { db, simTimeJobs, type Db } from "@/server/db";
import { advanceBranchStoryTime } from "./scheduler-store";

/**
 * Durable time-job store (drain-hardening A5 slice 4). A long skip / travel drain that outlives
 * its HTTP request runs here: the SERVER owns completion. A leased, fenced runner drains the
 * branch to `targetStorySecond` in bounded steps, persisting progress as it goes, and finishes
 * whether or not the app stays open (the Fly machine never auto-stops).
 *
 * Concurrency is the whole point (the 2026-07-23 review's load-bearing requirement):
 * - **One active job per branch** — the `sim_time_jobs_one_active_per_branch` partial unique
 *   index makes a second active job a constraint violation, so a race to escalate cannot create
 *   two. `enqueueTimeJob` defers to that index (`on conflict … do nothing`) and adopts the
 *   winner's job instead of erroring.
 * - **Leased + fenced** — a job is claimed with `FOR UPDATE SKIP LOCKED` + a lease; every
 *   progress/terminal write is fenced on `lease_owner = this worker AND state = 'processing'`, so
 *   a stale claimant (its lease expired, another worker took over) can never overwrite live work.
 * - **Re-claimable** — a claim reclaims a job whose lease has expired, so a crashed worker's job
 *   is picked up by the boot/next-request sweep, never stranded.
 * - **Retargeting** — between steps the runner re-reads the row's `target_story_second` (fenced
 *   like every other job read), and the completed write re-verifies the target it reached, so a
 *   mid-drain bump — an `enqueueTimeJob` on a processing row: a delayed arrival, an escalation —
 *   EXTENDS the running drain instead of stranding on a completed row (ruling 24).
 *
 * The beat write on completion and the C15 poison recording are the CALLER's job (engine level):
 * this store is pure durable state + the deterministic drain, with no engine/IO dependencies
 * beyond the scheduler advance it wraps.
 */

export type TimeJobState = "pending" | "processing" | "completed" | "failed" | "blocked";

export interface TimeJob {
  id: string;
  worldId: string;
  branchId: string;
  chatId: string;
  targetStorySecond: number;
  reachedStorySecond: number;
  state: TimeJobState;
  attempts: number;
}

/** Lease + budget knobs. A step drains a bounded window, then re-leases and loops. */
const LEASE_SECONDS = 60;
const STEP_BUDGET_MS = 5_000;
const STEP_MAX_TRIGGERS = 500;
/** A backstop on the runner loop — far above any real drain, so a logic bug can't spin forever. */
const MAX_STEPS = 20_000;
/** A job that exhausts this many claims without terminating is quarantined (`failed`). */
const MAX_ATTEMPTS = 100;

function rowToJob(row: typeof simTimeJobs.$inferSelect): TimeJob {
  return {
    id: row.id,
    worldId: row.worldId,
    branchId: row.branchId,
    chatId: row.chatId,
    targetStorySecond: row.targetStorySecond,
    reachedStorySecond: row.reachedStorySecond,
    state: row.state,
    attempts: row.attempts,
  };
}

/**
 * "Active" is the partial unique index's own predicate (`state in ('pending','processing')`) —
 * one definition, used by every read that asks whether a branch already has a job in flight, so
 * the code and `sim_time_jobs_one_active_per_branch` can never drift apart.
 */
function activeForBranch(branchId: string) {
  return and(
    eq(simTimeJobs.branchId, branchId),
    or(eq(simTimeJobs.state, "pending"), eq(simTimeJobs.state, "processing")),
  );
}

export interface EnqueueTimeJobInput {
  worldId: string;
  branchId: string;
  chatId: string;
  targetStorySecond: number;
  /** Where the drain has already reached in-request (the fast path's honest short second). */
  reachedStorySecond: number;
}

/**
 * Ensure a durable job exists for this branch's remaining drain. Idempotent per branch: if an
 * active (pending/processing) job already exists it is kept — its target bumped forward when the
 * new request reaches further — and returned; otherwise a fresh pending job is inserted. The
 * partial unique index is the race backstop: a concurrent insert loses to it and merges into the
 * winner's job.
 *
 * The opening `for update` locks an EXISTING active row (so a claim can't terminate the job
 * between our read and our target bump), but a row lock cannot stop a phantom — two enqueues that
 * both find nothing will both try to insert, and the index has to settle it.
 *
 * That settlement is `on conflict … do update`, NOT a try/catch around a bare insert, and the
 * distinction is load-bearing: a raised unique violation poisons the WHOLE transaction, so every
 * later statement in it fails with 25P02 ("current transaction is aborted"). A catch block that
 * re-reads the winner's row from inside that transaction is therefore a recovery path that can
 * only ever fail — it threw instead of adopting, intermittently, exactly when the race it exists
 * to handle actually fired.
 *
 * `do update` rather than `do nothing`, because the two enqueues racing here are NOT duplicates of
 * one intent: an arrival settlement escalating a few minutes can collide with a player's 30-day
 * skip. A loser that merely adopted the winner's row would silently truncate its own drain to the
 * winner's nearer target, so the merge takes `greatest(…)` of the two — the same bump-only-forward
 * rule the `for update` path applies, now applied on the race path too. Whoever loses, the
 * surviving job targets the furthest second anyone asked for.
 *
 * Two Postgres details the code can't show:
 * - The conflict target must repeat the partial index's predicate verbatim (`targetWhere`),
 *   because inference only picks an arbiter index whose own predicate is implied by the one given
 *   here. Drop it and this becomes a plain `(branch_id)` inference that matches no index, and the
 *   statement errors outright.
 * - `do update` waits out the peer's in-flight insert, then merges against the row it committed
 *   (`excluded` is our attempted row), taking that row's lock for the merge — the same lock
 *   discipline as the `for update` bump above, just arrived at from the losing side. So it always
 *   yields exactly one row: ours when we inserted, the winner's when we merged, which is the whole
 *   of how `created` is decided. No post-conflict read, and no state where the answer is unknown.
 */
export async function enqueueTimeJob(
  input: EnqueueTimeJobInput,
  options: { database?: Db } = {},
): Promise<{ id: string; created: boolean }> {
  const database = options.database ?? db();
  return database.transaction(async (tx) => {
    const [active] = await tx
      .select()
      .from(simTimeJobs)
      .where(activeForBranch(input.branchId))
      .limit(1)
      .for("update");
    if (active) {
      if (input.targetStorySecond > active.targetStorySecond) {
        await tx
          .update(simTimeJobs)
          .set({ targetStorySecond: input.targetStorySecond, updatedAt: new Date() })
          .where(eq(simTimeJobs.id, active.id));
      }
      return { id: active.id, created: false };
    }
    const id = newId();
    const [upserted] = await tx
      .insert(simTimeJobs)
      .values({
        id,
        worldId: input.worldId,
        branchId: input.branchId,
        chatId: input.chatId,
        targetStorySecond: input.targetStorySecond,
        reachedStorySecond: input.reachedStorySecond,
      })
      .onConflictDoUpdate({
        target: simTimeJobs.branchId,
        targetWhere: sql`state in ('pending', 'processing')`,
        // Only the target moves, and only forward. Everything else on a live job — its progress,
        // state, lease, attempts — belongs to whoever is draining it, and a late enqueue must not
        // reach into any of it.
        set: {
          targetStorySecond: sql`greatest(${simTimeJobs.targetStorySecond}, excluded.target_story_second)`,
        },
      })
      .returning({ id: simTimeJobs.id });
    if (!upserted) {
      // Unreachable, and typed only because `noUncheckedIndexedAccess` can't see the guarantee:
      // `on conflict … do update … returning` always yields a row (it either inserted ours or
      // updated the winner's, and there is no `setWhere` that could filter the update away). Not a
      // race path — the race is fully settled above. Answer "someone else owns this drain", the
      // one reply that can't mislead a caller into thinking this request created one.
      return { id, created: false };
    }
    // Our own fresh id came back ⇒ the insert landed; anything else is the winner we merged into.
    return { id: upserted.id, created: upserted.id === id };
  });
}

/** Whether a branch has an active (pending/processing) time job — the mutation guard's read. */
export async function hasActiveTimeJob(branchId: string, options: { database?: Db } = {}): Promise<boolean> {
  const database = options.database ?? db();
  const [row] = await database
    .select({ id: simTimeJobs.id })
    .from(simTimeJobs)
    .where(activeForBranch(branchId))
    .limit(1);
  return row !== undefined;
}

/**
 * Claim the oldest due, claimable job (`FOR UPDATE SKIP LOCKED`) — pending, or processing with an
 * expired lease (a crashed worker's job) — set it processing with a fresh lease and bump attempts.
 * Returns the claimed job, or null when nothing is claimable. A job past its attempt ceiling is
 * quarantined (`failed`) instead of reclaimed forever.
 */
export async function claimDueTimeJob(
  workerId: string,
  options: { now?: Date; database?: Db; leaseSeconds?: number } = {},
): Promise<TimeJob | null> {
  const database = options.database ?? db();
  const now = options.now ?? new Date();
  const leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS;
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);

  return database.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(simTimeJobs)
      .where(
        and(
          lte(simTimeJobs.availableAt, now),
          or(
            eq(simTimeJobs.state, "pending"),
            and(eq(simTimeJobs.state, "processing"), lte(simTimeJobs.leaseExpiresAt, now)),
          ),
        ),
      )
      .orderBy(asc(simTimeJobs.availableAt), asc(simTimeJobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;

    if (candidate.attempts >= MAX_ATTEMPTS) {
      await tx
        .update(simTimeJobs)
        .set({
          state: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: `time job exhausted ${candidate.attempts}/${MAX_ATTEMPTS} claims without terminating`,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(simTimeJobs.id, candidate.id));
      return null;
    }

    const [claimed] = await tx
      .update(simTimeJobs)
      .set({
        state: "processing",
        leaseOwner: workerId,
        leaseExpiresAt,
        attempts: sql`${simTimeJobs.attempts} + 1`,
        updatedAt: now,
      })
      .where(eq(simTimeJobs.id, candidate.id))
      .returning();
    return claimed ? rowToJob(claimed) : null;
  });
}

/** The terminal outcome of running one claimed job to a stopping point. */
export interface RunJobResult {
  jobId: string;
  branchId: string;
  chatId: string;
  outcome: "completed" | "backoff" | "blocked" | "lease_lost" | "stalled";
  reachedStorySecond: number;
  targetStorySecond: number;
  /** Poison (terminally-failed) triggers seen across the run — the caller records them (C15). */
  terminalFailures: number;
}

/**
 * Drive a claimed job toward its target in bounded, fenced steps until a stopping point:
 * - **completed** — reached the target; the caller writes the landing beat.
 * - **backoff** — a trigger transiently failed and parked the clock; the job is returned to
 *   `pending` with `available_at` at the backoff, so the sweep resumes it after it elapses.
 * - **blocked** — a poison trigger with no forward progress (defensive; the drain normally moves
 *   past poison). Surfaced for admin repair, never a silent success.
 * - **lease_lost** — a fenced write updated 0 rows, so another worker owns the job now. Abort.
 * - **stalled** — the step backstop tripped (a logic bug); recorded, not silently spun.
 *
 * Every progress and terminal write is fenced on `lease_owner = workerId AND state = 'processing'`.
 * The TARGET is live, not frozen at claim time: each step re-reads the row's `target_story_second`
 * (same fence) and drains to that, and the completed write additionally re-verifies the target it
 * reached. So a mid-drain bump — an `enqueueTimeJob` on this processing row: a delayed arrival, an
 * escalation reaching further — extends this run instead of stranding on a completed row (ruling
 * 24). The backoff and progress writes never touch `target_story_second` and leave the row active,
 * so a bump landing beside them simply survives on the row and is picked up on resume.
 */
export async function runClaimedTimeJob(
  job: TimeJob,
  workerId: string,
  options: { now?: () => Date; database?: Db; leaseSeconds?: number } = {},
): Promise<RunJobResult> {
  const database = options.database ?? db();
  const clock = options.now ?? (() => new Date());
  const leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS;
  let terminalFailures = 0;
  let reached = job.reachedStorySecond;
  let lastReached = reached;
  let noProgress = 0;
  /** The live target — re-read from the row each step, so a bump extends this run. */
  let target = job.targetStorySecond;

  const ids = { jobId: job.id, branchId: job.branchId, chatId: job.chatId };
  /** Every return path reports the target as of NOW, never the one captured at claim time. */
  const result = (outcome: RunJobResult["outcome"]): RunJobResult => ({
    ...ids,
    outcome,
    reachedStorySecond: reached,
    targetStorySecond: target,
    terminalFailures,
  });

  for (let step = 0; step < MAX_STEPS; step += 1) {
    // Adopt whatever the row says now (`enqueueTimeJob` only ever bumps it forward); a row that is
    // no longer ours means another worker owns the drain, so stop.
    const live = await readOwnedTarget(database, job.id, workerId);
    if (live === null) return result("lease_lost");
    target = live;

    const outcome = await advanceBranchStoryTime(job.branchId, target, {
      workerId,
      budgetMs: STEP_BUDGET_MS,
      maxTriggers: STEP_MAX_TRIGGERS,
      database,
    });
    reached = outcome.storySecond;
    terminalFailures += outcome.terminalFailures ?? 0;

    if (outcome.status === "advanced") {
      // Fenced on the target too: completing is only correct for the target we actually drained to.
      const fenced = await fencedSet(
        database,
        job.id,
        workerId,
        {
          state: "completed",
          reachedStorySecond: reached,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: clock(),
          updatedAt: clock(),
        },
        { expectTargetStorySecond: target },
      );
      if (fenced) return result("completed");
      // 0 rows — either a bump committed while this step drained (still ours: keep going, to the
      // further target) or the lease is gone. The MAX_STEPS backstop bounds a pathological bumper.
      const bumped = await readOwnedTarget(database, job.id, workerId);
      if (bumped === null) return result("lease_lost");
      target = bumped;
      continue;
    }

    // catch_up_required — a backed-off trigger parks the clock; wait it out and resume later.
    if (outcome.reason === "trigger_backoff") {
      const availableAt = outcome.availableAt ?? new Date(clock().getTime() + 1000);
      const fenced = await fencedSet(database, job.id, workerId, {
        state: "pending",
        reachedStorySecond: reached,
        availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: clock(),
      });
      if (!fenced) return result("lease_lost");
      return result("backoff");
    }

    // A budget reason (trigger_budget / time_budget) — persist progress, extend the lease, loop.
    const fenced = await fencedSet(database, job.id, workerId, {
      reachedStorySecond: reached,
      leaseExpiresAt: new Date(clock().getTime() + leaseSeconds * 1000),
      updatedAt: clock(),
    });
    if (!fenced) return result("lease_lost");

    // Defensive stuck-guard: a budget catch-up that makes NO clock progress repeatedly means the
    // drain cannot advance (should never happen — poison triggers are skipped, backoff is handled
    // above). Block for repair rather than spinning to the step backstop.
    if (reached <= lastReached) {
      noProgress += 1;
      if (noProgress >= 3) {
        await fencedSet(database, job.id, workerId, {
          state: "blocked",
          reachedStorySecond: reached,
          lastError: `time job made no progress past ${reached}/${target}`,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: clock(),
        });
        return result("blocked");
      }
    } else {
      noProgress = 0;
      lastReached = reached;
    }
  }

  await fencedSet(database, job.id, workerId, {
    state: "blocked",
    reachedStorySecond: reached,
    lastError: `time job hit the ${MAX_STEPS}-step backstop at ${reached}/${target}`,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: clock(),
  });
  return result("stalled");
}

/**
 * A fenced write: only lands while this worker still holds the processing lease. Returns applied?.
 * `expectTargetStorySecond` adds the target to the fence — the terminal completion uses it so a
 * target bumped mid-step cannot be sealed away on a completed row.
 */
async function fencedSet(
  database: Db,
  jobId: string,
  workerId: string,
  set: Partial<typeof simTimeJobs.$inferInsert>,
  options: { expectTargetStorySecond?: number } = {},
): Promise<boolean> {
  const [updated] = await database
    .update(simTimeJobs)
    .set(set)
    .where(
      and(
        eq(simTimeJobs.id, jobId),
        eq(simTimeJobs.leaseOwner, workerId),
        eq(simTimeJobs.state, "processing"),
        options.expectTargetStorySecond === undefined
          ? undefined
          : eq(simTimeJobs.targetStorySecond, options.expectTargetStorySecond),
      ),
    )
    .returning({ id: simTimeJobs.id });
  return updated !== undefined;
}

/**
 * A fenced read of the job's live target — the same `id + lease_owner + processing` fence every
 * write uses. `null` means the row is no longer ours to drive (lease taken over, or terminal).
 */
async function readOwnedTarget(database: Db, jobId: string, workerId: string): Promise<number | null> {
  const [row] = await database
    .select({ targetStorySecond: simTimeJobs.targetStorySecond })
    .from(simTimeJobs)
    .where(and(eq(simTimeJobs.id, jobId), eq(simTimeJobs.leaseOwner, workerId), eq(simTimeJobs.state, "processing")))
    .limit(1);
  return row?.targetStorySecond ?? null;
}

/** The catch-up UI / status read for one chat — its most recent job, if any. */
export interface TimeJobStatus {
  state: TimeJobState;
  targetStorySecond: number;
  reachedStorySecond: number;
}

export async function readTimeJobForChat(
  chatId: string,
  options: { database?: Db } = {},
): Promise<TimeJobStatus | null> {
  const database = options.database ?? db();
  const [row] = await database
    .select({
      state: simTimeJobs.state,
      targetStorySecond: simTimeJobs.targetStorySecond,
      reachedStorySecond: simTimeJobs.reachedStorySecond,
      createdAt: simTimeJobs.createdAt,
    })
    .from(simTimeJobs)
    .where(eq(simTimeJobs.chatId, chatId))
    .orderBy(sql`${simTimeJobs.createdAt} desc`)
    .limit(1);
  if (!row) return null;
  return {
    state: row.state,
    targetStorySecond: row.targetStorySecond,
    reachedStorySecond: row.reachedStorySecond,
  };
}
