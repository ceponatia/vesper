import { and, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { diag } from "@/contracts/diagnostics";
import { log } from "@/server/log";
import { db, jobs, sessions, turns } from "../db";
import { API_JOB_STALE_MS, HEARTBEAT_STALE_MS, RECOVERY_SWEEP_INTERVAL_MS } from "./constants";
import { abandonOverAttemptedJobs, kickSession, recoverStaleJobs } from "./jobs";

/**
 * Heartbeat-based recovery (docs/resilience.md §5), run on each turn submit
 * (and safe to run any time): fail abandoned turns/jobs and un-wedge the
 * session. Liveness is heartbeat freshness, never row age — a slow-but-alive
 * narrative stream or merge is never clobbered.
 */

export interface RecoveryReport {
  failedTurnIds: string[];
  failedJobs: number;
  sessionReset: boolean;
}

export async function recoverAbandonedTurns(sessionId: string): Promise<RecoveryReport> {
  const cutoff = new Date(Date.now() - HEARTBEAT_STALE_MS);
  // Stale running → failed, then abandon any queued job that has already hit the
  // attempt cap (security Cluster I6) — done before the liveJob check / re-kick
  // below so an over-cap poison job is never treated as live and never re-kicked.
  const failedJobs = (await recoverStaleJobs(sessionId)) + (await abandonOverAttemptedJobs(sessionId));

  // A live gating job: queued (claimable any time) or running with a fresh heartbeat.
  const [liveJob] = await db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.sessionId, sessionId),
        inArray(jobs.type, ["post_turn", "reconcile"]),
        or(eq(jobs.status, "queued"), and(eq(jobs.status, "running"), gt(jobs.heartbeatAt, cutoff))),
      ),
    )
    .limit(1);

  const abandonedDiag = JSON.stringify([
    diag("error", "recovery.turn_abandoned", "turn abandoned: heartbeat went stale and was recovered"),
  ]);

  // Narrating turns die on a stale heartbeat alone; processing turns survive
  // while a live post_turn/reconcile job can still finish them.
  const failedTurnIds: string[] = [];
  const failedNarrating = await db()
    .update(turns)
    .set({ status: "failed", diagnostics: sql`${turns.diagnostics} || ${abandonedDiag}::jsonb` })
    .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "narrating"), lt(turns.heartbeatAt, cutoff)))
    .returning({ id: turns.id });
  failedTurnIds.push(...failedNarrating.map((t) => t.id));

  if (!liveJob) {
    const failedProcessing = await db()
      .update(turns)
      .set({ status: "failed", diagnostics: sql`${turns.diagnostics} || ${abandonedDiag}::jsonb` })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "processing"), lt(turns.heartbeatAt, cutoff)))
      .returning({ id: turns.id });
    failedTurnIds.push(...failedProcessing.map((t) => t.id));
  }

  let sessionReset = false;
  const [session] = await db()
    .select({ status: sessions.status, updatedAt: sessions.updatedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (session && session.status !== "ready") {
    if (liveJob) {
      // Work is pending but maybe orphaned by a process restart — re-kick the queue.
      kickSession(sessionId);
    } else if (session.updatedAt < cutoff) {
      // The session row itself must be stale too: a status flipped moments ago
      // belongs to a live submit whose turn row may not exist yet.
      const [liveTurn] = await db()
        .select({ id: turns.id })
        .from(turns)
        .where(
          and(
            eq(turns.sessionId, sessionId),
            inArray(turns.status, ["narrating", "processing"]),
            gt(turns.heartbeatAt, cutoff),
          ),
        )
        .limit(1);
      if (!liveTurn) {
        const updated = await db()
          .update(sessions)
          .set({ status: "ready" })
          .where(and(eq(sessions.id, sessionId), ne(sessions.status, "ready")))
          .returning({ id: sessions.id });
        sessionReset = updated.length > 0;
      }
    }
  }

  return { failedTurnIds, failedJobs, sessionReset };
}

/**
 * Global recovery sweep: reconcile every session that isn't `ready` so a session
 * wedged by a process restart (its in-flight post-turn job orphaned, its UI
 * blocked from submitting) self-heals instead of waiting for a turn submit that
 * can never come. Heartbeat-based via `recoverAbandonedTurns`, so it never
 * clobbers live work — an in-flight turn is only recovered once its heartbeat is
 * stale, and a queued-but-orphaned job is simply re-kicked. Safe to run any time
 * and repeatedly; multi-instance-safe (no instance fails another's fresh work).
 */
export async function sweepAbandonedSessions(): Promise<number> {
  let recovered = 0;
  const wedged = await db().select({ id: sessions.id }).from(sessions).where(ne(sessions.status, "ready"));
  for (const row of wedged) {
    try {
      const report = await recoverAbandonedTurns(row.id);
      if (report.sessionReset || report.failedTurnIds.length > 0 || report.failedJobs > 0) recovered++;
    } catch (err) {
      log.warn("recovery", "sweep: session recovery failed", { sessionId: row.id, error: errorText(err) });
    }
  }
  return recovered;
}

/**
 * Fail detached (session-less) jobs orphaned by a process death (codebase-review
 * D4). Two populations share the gap: api-side `startJob` rows (server/api/jobs.ts
 * — run in-process, `heartbeat_at` frozen at its insert default, updated only when
 * the promise settles) and detached engine-queue jobs like `chat_summary`
 * (heartbeated while running, but `recoverStaleJobs` is session-scoped and never
 * reaches a NULL `session_id`). Either way a crash mid-run pins the row `running`
 * forever. The predicate: running + no session + heartbeat older than
 * API_JOB_STALE_MS — generous, because api-side rows can't distinguish slow from
 * dead (an image render can take minutes), and a survivor that settles after
 * being swept simply overwrites the row with its real outcome.
 */
export async function sweepDetachedApiJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - API_JOB_STALE_MS);
  const failed = await db()
    .update(jobs)
    .set({ status: "failed", error: "abandoned: process died before the detached job settled", finishedAt: new Date() })
    .where(and(eq(jobs.status, "running"), isNull(jobs.sessionId), lt(jobs.heartbeatAt, cutoff)))
    .returning({ id: jobs.id });
  return failed.length;
}

let sweepTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Start the background recovery sweep (idempotent). Called once per process from
 * instrumentation.ts: an immediate pass on boot, then every
 * RECOVERY_SWEEP_INTERVAL_MS. `unref` so it never keeps the process alive.
 */
export function startRecoverySweep(): void {
  if (sweepTimer) return;
  const tick = () => {
    void sweepAbandonedSessions()
      .then((n) => {
        if (n > 0) log.info("recovery", `sweep recovered ${n} wedged session(s)`);
      })
      .catch((err: unknown) => log.error("recovery", "sweep failed", { error: errorText(err) }));
    void sweepDetachedApiJobs()
      .then((n) => {
        if (n > 0) log.info("recovery", `sweep failed ${n} detached api job(s)`);
      })
      .catch((err: unknown) => log.error("recovery", "detached-job sweep failed", { error: errorText(err) }));
  };
  tick();
  sweepTimer = setInterval(tick, RECOVERY_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
