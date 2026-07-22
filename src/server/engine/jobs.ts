import { and, eq, sql } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { log } from "@/server/log";
import { db, jobs } from "../db";
import { HEARTBEAT_INTERVAL_MS, MAX_JOB_ATTEMPTS } from "./constants";

/**
 * DB-backed job rows + an in-process runner for detached background work
 * (chat summaries, scene sketches, reference images). The jobs table is the
 * contract; claims are atomic so an accidental second instance cannot
 * double-process.
 */

export type JobType =
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

export type JobRow = typeof jobs.$inferSelect;
export type JobHandler = (job: JobRow) => Promise<void>;

/**
 * Poison-job guard (security Cluster I6). `attempts` is incremented atomically
 * on every claim, so the value on a just-claimed row already counts this run.
 * Once it exceeds MAX_JOB_ATTEMPTS the job is abandoned instead of re-run — a
 * single bad job can never loop forever. PURE so the cap is unit-testable.
 */
export function jobExceedsAttemptCap(attempts: number): boolean {
  return attempts > MAX_JOB_ATTEMPTS;
}

const RUNNER_ID = `runner_${newId()}`;

interface RunnerState {
  handlers: Map<string, JobHandler>;
}

declare global {
  // var declaration so the runner state survives Next.js dev-server module reloads
  var __vesperJobRunner: RunnerState | undefined;
}

function runnerState(): RunnerState {
  globalThis.__vesperJobRunner ??= { handlers: new Map() };
  return globalThis.__vesperJobRunner;
}

export function registerJobHandler(type: JobType, fn: JobHandler): void {
  runnerState().handlers.set(type, fn);
}

export interface EnqueueJobInput {
  type: JobType;
  payload: Record<string, unknown>;
}

export async function enqueueJob(input: EnqueueJobInput): Promise<string> {
  const [row] = await db()
    .insert(jobs)
    .values({ type: input.type, payload: input.payload })
    .returning({ id: jobs.id });
  if (!row) throw new Error("job insert returned no row");
  void runDetachedJob(row.id);
  return row.id;
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
  // so an over-cap row is abandoned here rather than re-invoking a handler that
  // keeps crashing.
  if (jobExceedsAttemptCap(job.attempts)) {
    log.warn("jobs", `job ${job.type} abandoned after ${job.attempts} attempts`, { jobId: job.id });
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
        // heartbeat is best-effort
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  beat.unref?.();
  try {
    await handler(job);
    await finishJob(job.id, "done", null);
  } catch (err) {
    const message = errorText(err);
    log.error("jobs", `job ${job.type} failed`, { jobId: job.id, error: message });
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
