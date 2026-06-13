import { and, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import { diag } from "@/contracts/diagnostics";
import { db, jobs, sessions, turns } from "../db";
import { HEARTBEAT_STALE_MS } from "./constants";
import { kickSession, recoverStaleJobs } from "./jobs";

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
  const failedJobs = await recoverStaleJobs(sessionId);

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
