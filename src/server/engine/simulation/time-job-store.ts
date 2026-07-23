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
 *   two. `enqueueTimeJob` catches that and returns the existing job.
 * - **Leased + fenced** — a job is claimed with `FOR UPDATE SKIP LOCKED` + a lease; every
 *   progress/terminal write is fenced on `lease_owner = this worker AND state = 'processing'`, so
 *   a stale claimant (its lease expired, another worker took over) can never overwrite live work.
 * - **Re-claimable** — a claim reclaims a job whose lease has expired, so a crashed worker's job
 *   is picked up by the boot/next-request sweep, never stranded.
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
 * partial unique index is the race backstop (a concurrent insert violates it → we re-read).
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
      .where(
        and(
          eq(simTimeJobs.branchId, input.branchId),
          or(eq(simTimeJobs.state, "pending"), eq(simTimeJobs.state, "processing")),
        ),
      )
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
    try {
      await tx.insert(simTimeJobs).values({
        id,
        worldId: input.worldId,
        branchId: input.branchId,
        chatId: input.chatId,
        targetStorySecond: input.targetStorySecond,
        reachedStorySecond: input.reachedStorySecond,
      });
      return { id, created: true };
    } catch {
      // A peer inserted between our select and insert; the partial unique index caught it.
      const [raced] = await tx
        .select()
        .from(simTimeJobs)
        .where(
          and(
            eq(simTimeJobs.branchId, input.branchId),
            or(eq(simTimeJobs.state, "pending"), eq(simTimeJobs.state, "processing")),
          ),
        )
        .limit(1);
      return { id: raced?.id ?? id, created: false };
    }
  });
}

/** Whether a branch has an active (pending/processing) time job — the mutation guard's read. */
export async function hasActiveTimeJob(branchId: string, options: { database?: Db } = {}): Promise<boolean> {
  const database = options.database ?? db();
  const [row] = await database
    .select({ id: simTimeJobs.id })
    .from(simTimeJobs)
    .where(
      and(
        eq(simTimeJobs.branchId, branchId),
        or(eq(simTimeJobs.state, "pending"), eq(simTimeJobs.state, "processing")),
      ),
    )
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

  const base = { jobId: job.id, branchId: job.branchId, chatId: job.chatId, targetStorySecond: job.targetStorySecond };

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const outcome = await advanceBranchStoryTime(job.branchId, job.targetStorySecond, {
      workerId,
      budgetMs: STEP_BUDGET_MS,
      maxTriggers: STEP_MAX_TRIGGERS,
      database,
    });
    reached = outcome.storySecond;
    terminalFailures += outcome.terminalFailures ?? 0;

    if (outcome.status === "advanced") {
      const fenced = await fencedSet(database, job.id, workerId, {
        state: "completed",
        reachedStorySecond: reached,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: clock(),
        updatedAt: clock(),
      });
      if (!fenced) return { ...base, outcome: "lease_lost", reachedStorySecond: reached, terminalFailures };
      return { ...base, outcome: "completed", reachedStorySecond: reached, terminalFailures };
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
      if (!fenced) return { ...base, outcome: "lease_lost", reachedStorySecond: reached, terminalFailures };
      return { ...base, outcome: "backoff", reachedStorySecond: reached, terminalFailures };
    }

    // A budget reason (trigger_budget / time_budget) — persist progress, extend the lease, loop.
    const fenced = await fencedSet(database, job.id, workerId, {
      reachedStorySecond: reached,
      leaseExpiresAt: new Date(clock().getTime() + leaseSeconds * 1000),
      updatedAt: clock(),
    });
    if (!fenced) return { ...base, outcome: "lease_lost", reachedStorySecond: reached, terminalFailures };

    // Defensive stuck-guard: a budget catch-up that makes NO clock progress repeatedly means the
    // drain cannot advance (should never happen — poison triggers are skipped, backoff is handled
    // above). Block for repair rather than spinning to the step backstop.
    if (reached <= lastReached) {
      noProgress += 1;
      if (noProgress >= 3) {
        await fencedSet(database, job.id, workerId, {
          state: "blocked",
          reachedStorySecond: reached,
          lastError: `time job made no progress past ${reached}/${job.targetStorySecond}`,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: clock(),
        });
        return { ...base, outcome: "blocked", reachedStorySecond: reached, terminalFailures };
      }
    } else {
      noProgress = 0;
      lastReached = reached;
    }
  }

  await fencedSet(database, job.id, workerId, {
    state: "blocked",
    reachedStorySecond: reached,
    lastError: `time job hit the ${MAX_STEPS}-step backstop at ${reached}/${job.targetStorySecond}`,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: clock(),
  });
  return { ...base, outcome: "stalled", reachedStorySecond: reached, terminalFailures };
}

/** A fenced write: only lands while this worker still holds the processing lease. Returns applied?. */
async function fencedSet(
  database: Db,
  jobId: string,
  workerId: string,
  set: Partial<typeof simTimeJobs.$inferInsert>,
): Promise<boolean> {
  const [updated] = await database
    .update(simTimeJobs)
    .set(set)
    .where(and(eq(simTimeJobs.id, jobId), eq(simTimeJobs.leaseOwner, workerId), eq(simTimeJobs.state, "processing")))
    .returning({ id: simTimeJobs.id });
  return updated !== undefined;
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
