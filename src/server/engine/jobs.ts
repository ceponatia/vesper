import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { log } from "@/server/log";
import { db, jobs, sessions } from "../db";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, MAX_JOB_ATTEMPTS } from "./constants";

/**
 * DB-backed job rows + an in-process runner, strictly serial per session and
 * concurrent across sessions (docs/turn-engine.md §Jobs and ordering). The
 * jobs table is the contract; this runner is an accepted single-instance
 * design — claims are still atomic so an accidental second instance cannot
 * double-process.
 */

export type JobType =
  | "post_turn"
  | "reconcile"
  | "inner_note"
  | "chat_summary"
  | "chat_scene_sketch"
  | "chat_meanwhile"
  | "chat_look_image"
  | "chat_place_image"
  | "scene_image"
  | "avatar"
  | "portrait_variant"
  | "entity_image"
  | "embed_refresh"
  | "image_sweep";

/** Job types that gate session readiness — image/embedding work never blocks play. */
const SESSION_GATING_TYPES: JobType[] = ["post_turn", "reconcile"];

export type JobRow = typeof jobs.$inferSelect;
export type JobHandler = (job: JobRow) => Promise<void>;

/**
 * Poison-job guard (security Cluster I6). `attempts` is incremented atomically
 * on every claim, so the value on a just-claimed row already counts this run.
 * Once it exceeds MAX_JOB_ATTEMPTS the job is abandoned instead of re-run — a
 * single bad job (or one that crashes the process mid-run and gets re-kicked by
 * recovery) can never loop forever. PURE so the cap is unit-testable.
 */
export function jobExceedsAttemptCap(attempts: number): boolean {
  return attempts > MAX_JOB_ATTEMPTS;
}

const RUNNER_ID = `runner_${newId()}`;

interface RunnerState {
  handlers: Map<string, JobHandler>;
  /** sessionId → in-flight drain loop. */
  active: Map<string, Promise<void>>;
}

declare global {
  // var declaration so the runner state survives Next.js dev-server module reloads
  var __vesperJobRunner: RunnerState | undefined;
}

function runnerState(): RunnerState {
  globalThis.__vesperJobRunner ??= { handlers: new Map(), active: new Map() };
  return globalThis.__vesperJobRunner;
}

export function registerJobHandler(type: JobType, fn: JobHandler): void {
  runnerState().handlers.set(type, fn);
}

export interface EnqueueJobInput {
  sessionId: string | null;
  type: JobType;
  payload: Record<string, unknown>;
}

export async function enqueueJob(input: EnqueueJobInput): Promise<string> {
  const [row] = await db()
    .insert(jobs)
    .values({ sessionId: input.sessionId, type: input.type, payload: input.payload })
    .returning({ id: jobs.id });
  if (!row) throw new Error("job insert returned no row");
  if (input.sessionId) kickSession(input.sessionId);
  else void runDetachedJob(row.id);
  return row.id;
}

/** True while any job for the session is queued or running. */
export async function sessionBusy(sessionId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.sessionId, sessionId), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  return row !== undefined;
}

/** Start (or no-op if already running) the serial drain loop for a session. */
export function kickSession(sessionId: string): void {
  const state = runnerState();
  if (state.active.has(sessionId)) return;
  const run = (async () => {
    try {
      await drainSessionQueue(sessionId);
    } catch (err) {
      log.error("jobs", "session runner crashed", { sessionId, error: errorText(err) });
    } finally {
      state.active.delete(sessionId);
    }
    // Re-kick if a job landed between our last empty claim and the delete above.
    if (await hasQueuedJobs(sessionId)) kickSession(sessionId);
  })();
  state.active.set(sessionId, run);
}

/**
 * Fail running jobs whose heartbeat is older than HEARTBEAT_STALE_MS
 * (liveness is heartbeat-based, never age-based — a slow-but-alive job is
 * never clobbered). Returns the number of jobs failed.
 */
export async function recoverStaleJobs(sessionId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - HEARTBEAT_STALE_MS);
  const conditions = [eq(jobs.status, "running"), lt(jobs.heartbeatAt, cutoff)];
  if (sessionId) conditions.push(eq(jobs.sessionId, sessionId));
  const failed = await db()
    .update(jobs)
    .set({ status: "failed", error: "stale heartbeat — recovered as abandoned", finishedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: jobs.id, sessionId: jobs.sessionId });
  if (failed.length > 0) {
    log.warn("jobs", `recovered ${failed.length} stale job(s)`, { sessionId: sessionId ?? "all" });
  }
  return failed.length;
}

/**
 * Fail any `queued` job for the session that has already hit the attempt cap
 * (security Cluster I6), so a re-kicked drain loop never re-claims a poison job.
 * Called by recovery before it re-kicks an orphaned queue. Uses `>=` (not the
 * post-claim `>` of `jobExceedsAttemptCap`) because these rows haven't been
 * re-claimed yet — a row already at the cap would exceed it on the next claim.
 * Returns the number abandoned.
 */
export async function abandonOverAttemptedJobs(sessionId: string): Promise<number> {
  const abandoned = await db()
    .update(jobs)
    .set({ status: "failed", error: `abandoned: reached poison-job attempt cap (${MAX_JOB_ATTEMPTS})`, finishedAt: new Date() })
    .where(and(eq(jobs.sessionId, sessionId), eq(jobs.status, "queued"), sql`${jobs.attempts} >= ${MAX_JOB_ATTEMPTS}`))
    .returning({ id: jobs.id });
  if (abandoned.length > 0) {
    log.warn("jobs", `abandoned ${abandoned.length} poison job(s) at attempt cap`, { sessionId });
  }
  return abandoned.length;
}

async function hasQueuedJobs(sessionId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.sessionId, sessionId), eq(jobs.status, "queued")))
    .limit(1);
  return row !== undefined;
}

async function drainSessionQueue(sessionId: string): Promise<void> {
  for (;;) {
    const claimed = await claimNextJob(sessionId);
    if (!claimed) break;
    await runJob(claimed);
    await settleSessionStatus(sessionId);
  }
}

async function claimNextJob(sessionId: string): Promise<JobRow | null> {
  for (;;) {
    const [candidate] = await db()
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.sessionId, sessionId), eq(jobs.status, "queued")))
      .orderBy(asc(jobs.createdAt), asc(jobs.id))
      .limit(1);
    if (!candidate) return null;
    // Atomic claim: only one runner can flip queued → running.
    const [claimed] = await db()
      .update(jobs)
      .set({
        status: "running",
        runnerId: RUNNER_ID,
        startedAt: new Date(),
        heartbeatAt: new Date(),
        attempts: sql`${jobs.attempts} + 1`,
      })
      .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "queued")))
      .returning();
    if (claimed) return claimed;
    // Lost the race to another runner; try the next queued job.
  }
}

async function runDetachedJob(jobId: string): Promise<void> {
  const [claimed] = await db()
    .update(jobs)
    .set({ status: "running", runnerId: RUNNER_ID, startedAt: new Date(), heartbeatAt: new Date(), attempts: sql`${jobs.attempts} + 1` })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "queued")))
    .returning();
  if (claimed) await runJob(claimed);
}

async function runJob(job: JobRow): Promise<void> {
  // Poison-job cap (security Cluster I6): the claim already bumped `attempts`,
  // so an over-cap row is abandoned here — failing it (which still drains the
  // gating queue, so the session settles to `ready`) rather than re-invoking a
  // handler that keeps crashing.
  if (jobExceedsAttemptCap(job.attempts)) {
    log.warn("jobs", `job ${job.type} abandoned after ${job.attempts} attempts`, {
      jobId: job.id,
      sessionId: job.sessionId ?? undefined,
    });
    await finishJob(job.id, "failed", `abandoned after ${job.attempts} attempts (poison-job cap ${MAX_JOB_ATTEMPTS})`);
    return;
  }
  const handler = runnerState().handlers.get(job.type);
  if (!handler) {
    await finishJob(job.id, "failed", `no handler registered for job type "${job.type}"`);
    return;
  }
  const beat = setInterval(() => {
    void (async () => {
      try {
        await db().update(jobs).set({ heartbeatAt: new Date() }).where(eq(jobs.id, job.id));
      } catch {
        // heartbeat is best-effort; recovery handles a truly dead runner
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  beat.unref?.();
  try {
    await handler(job);
    await finishJob(job.id, "done", null);
  } catch (err) {
    const message = errorText(err);
    log.error("jobs", `job ${job.type} failed`, { jobId: job.id, sessionId: job.sessionId ?? undefined, error: message });
    await finishJob(job.id, "failed", message);
  } finally {
    clearInterval(beat);
  }
}

async function finishJob(jobId: string, status: "done" | "failed", error: string | null): Promise<void> {
  try {
    await db()
      .update(jobs)
      .set({ status, error, finishedAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")));
  } catch (err) {
    log.error("jobs", "failed to finalize job row", { jobId, error: errorText(err) });
  }
}

/**
 * The session returns to `ready` only when its gating queue (post_turn /
 * reconcile) drains — a failed job still drains the queue, so a failed turn
 * never wedges the session. Image/embedding jobs never gate readiness.
 */
async function settleSessionStatus(sessionId: string): Promise<void> {
  const [gating] = await db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.sessionId, sessionId),
        inArray(jobs.status, ["queued", "running"]),
        inArray(jobs.type, SESSION_GATING_TYPES),
      ),
    )
    .limit(1);
  if (gating) return;
  await db()
    .update(sessions)
    .set({ status: "ready" })
    .where(and(eq(sessions.id, sessionId), eq(sessions.status, "processing")));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
