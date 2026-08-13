import { newId } from "@/lib/ids";
import { log } from "../log";
import {
  advanceBranchStoryTime,
  claimDueTimeJob,
  enqueueTimeJob,
  runClaimedTimeJob,
  type EnqueueTimeJobInput,
  type RunJobResult,
} from "./simulation";
import { recordCompositionFallback } from "./composition-diagnostics";
import { writeWorldBeat } from "./sim-beats";

/**
 * Durable time-job orchestration (drain-hardening A5 slice 4) — the engine seam over the
 * `time-job-store` (which is pure durable state + the scheduler drain). This layer adds the two
 * things the store can't: the landing beat a completed job writes, and the C15 recording of a
 * poison/blocked outcome. Routes call `escalateToTimeJob` (hand a long skip's remainder to the
 * server) and `runDueTimeJobs` (the boot/next-request sweep).
 *
 * "Server owns completion" is delivered by: an always-on Fly machine (the detached kick runs the
 * job past the request that created it) + the sweep (any request re-drives due jobs, so a
 * deploy/crash mid-skip loses nothing — the branch clock, triggers, and the job row are all
 * durable). A backed-off job re-becomes due after its wall-clock backoff and the next sweep
 * resumes it.
 */

const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Fast-path knobs: a short in-request window so ordinary skips finish synchronously (ruling 1). */
const FAST_PATH_CALLS = 3;
const FAST_PATH_BUDGET_MS = 2_000;
const FAST_PATH_MAX_TRIGGERS = 200;

export interface SkipResult {
  /** `completed` — the fast path reached the target in-request. `catching_up` — a job owns the rest. */
  status: "completed" | "catching_up";
  reachedStorySecond: number;
  /** Poison triggers seen in the fast path (the caller records them; the job records its own). */
  terminalFailures: number;
}

/**
 * Run a time skip with escalation (drain-hardening A5, ruling 1–2): a bounded fast path drains
 * the branch in-request so ordinary skips finish synchronously; a skip that doesn't converge in
 * that window hands its remainder to a durable, server-owned job (which writes the landing beat
 * on completion) and returns `catching_up` so the client shows staged progress. The world's clock
 * only ever moves forward, so the fast path's partial advance is already committed and honest.
 */
export async function runSkipWithEscalation(
  input: {
    worldId: string;
    branchId: string;
    chatId: string;
    targetStorySecond: number;
  },
  options: { kick?: boolean } = {},
): Promise<SkipResult> {
  let reached = input.targetStorySecond;
  let terminalFailures = 0;

  for (let call = 0; call < FAST_PATH_CALLS; call += 1) {
    const outcome = await advanceBranchStoryTime(input.branchId, input.targetStorySecond, {
      workerId: `sim-skip-fast-${newId()}`,
      budgetMs: FAST_PATH_BUDGET_MS,
      maxTriggers: FAST_PATH_MAX_TRIGGERS,
    });
    reached = outcome.storySecond;
    terminalFailures += outcome.terminalFailures ?? 0;
    if (outcome.status === "advanced") {
      return { status: "completed", reachedStorySecond: reached, terminalFailures };
    }
    // A backed-off trigger won't clear inside this request — hand it to the job, which waits it out.
    if (outcome.reason === "trigger_backoff") break;
  }

  await escalateToTimeJob(
    {
      worldId: input.worldId,
      branchId: input.branchId,
      chatId: input.chatId,
      targetStorySecond: input.targetStorySecond,
      reachedStorySecond: reached,
    },
    { kick: options.kick ?? true },
  );
  return { status: "catching_up", reachedStorySecond: reached, terminalFailures };
}

/**
 * Hand a long time-advance's remainder to a durable job and kick the runner detached. Idempotent
 * per branch (the store enqueues at most one active job per branch). The originating request has
 * already advanced the clock as far as its bounded fast path reached; this owns the rest.
 */
export async function escalateToTimeJob(
  input: EnqueueTimeJobInput,
  options: { kick?: boolean } = {},
): Promise<{ id: string; created: boolean }> {
  const enqueued = await enqueueTimeJob(input);
  // Kick the runner past this request (the always-on machine keeps it alive; the sweep is the
  // backstop if the process is cut over mid-run). Fire-and-forget — never blocks or fails the
  // request that escalated. Tests pass `kick: false` and drive `runDueTimeJobs` deterministically.
  if (options.kick !== false) {
    void runDueTimeJobs(`time-job-kick-${newId()}`).catch((error) => {
      log.warn("engine.sim.time_job", "detached time-job kick failed; the sweep will retry", {
        branchId: input.branchId,
        error: msg(error),
      });
    });
  }
  return enqueued;
}

/**
 * Claim ONE due job and run it to a stopping point, then apply the engine-level effects: a
 * completed job writes its landing beat; poison triggers seen during the run are recorded (C15);
 * a blocked/stalled job is recorded for admin attention. Returns the run result, or null when no
 * job was claimable.
 */
export async function processOneTimeJob(workerId: string): Promise<RunJobResult | null> {
  const job = await claimDueTimeJob(workerId);
  if (!job) return null;

  let result: RunJobResult;
  try {
    result = await runClaimedTimeJob(job, workerId);
  } catch (error) {
    // A thrown drain leaves the job leased; the lease expires and the sweep reclaims it. Record
    // and move on — never crash the sweep.
    log.warn("engine.sim.time_job", "time-job run threw; lease will expire and the sweep will retry", {
      jobId: job.id,
      branchId: job.branchId,
      error: msg(error),
    });
    return null;
  }

  if (result.outcome === "completed") {
    // The landing beat, stamped at the clock the job actually reached (now the target).
    await writeWorldBeat({ chatId: result.chatId, branchId: result.branchId, kind: "time_skipped" });
  }
  if (result.terminalFailures > 0) {
    // Never hidden: a poison trigger during the offline drain is surfaced exactly like the
    // in-request path records it (C15), so the admin tally counts both.
    recordCompositionFallback({
      site: "advance_time",
      code: "trigger_failed",
      chatId: result.chatId,
      detail: `${result.terminalFailures} poison trigger(s) during durable skip`,
    });
  }
  if (result.outcome === "blocked" || result.outcome === "stalled") {
    recordCompositionFallback({
      site: "advance_time",
      code: "drain_diverged",
      chatId: result.chatId,
      detail: `durable skip ${result.outcome} at ${result.reachedStorySecond}/${result.targetStorySecond}`,
    });
  }
  return result;
}

/**
 * The sweep (boot / next-request): drain every immediately-due job to a stopping point. Backed-off
 * jobs (a future `available_at`) are NOT busy-looped — they simply aren't claimable yet, so the
 * loop stops and a later sweep resumes them after their backoff elapses. Bounded by `maxJobs` so a
 * pathological backlog can't hold a request thread forever.
 */
export async function runDueTimeJobs(workerId: string, options: { maxJobs?: number } = {}): Promise<number> {
  const maxJobs = options.maxJobs ?? 100;
  let processed = 0;
  for (let i = 0; i < maxJobs; i += 1) {
    const result = await processOneTimeJob(`${workerId}-${i}`);
    if (!result) break;
    processed += 1;
  }
  return processed;
}
