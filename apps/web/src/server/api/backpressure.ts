import { and, count, gt, inArray } from "drizzle-orm";
import { db, jobs } from "@/server/db";
import { log } from "@/server/log";
import { errorText } from "./respond";
import { JOB_SLOT_STALE_MS } from "./concurrency";

/**
 * Backpressure.
 *
 * Rate limits protect the app from its callers; backpressure protects it from
 * its dependencies. When an image provider is timing out, admitting the next
 * twelve renders converts one broken upstream into twelve occupied workers and a
 * queue nobody can drain. Shedding early keeps the failure small and hands the
 * caller a `Retry-After` instead of a hung request.
 *
 * Health is a liveness signal, not an accounting fact, so unlike budgets it
 * stays in memory: a restart *should* forget it and re-probe.
 */

export const PROVIDER_LANES = ["text", "image", "embedding"] as const;
export type ProviderLane = (typeof PROVIDER_LANES)[number];

/** `degraded` is the half-open state: one probe is admitted to test recovery. */
export type LaneHealth = "healthy" | "degraded" | "unhealthy";

/** Consecutive failures that trip a lane. Above transient blips, below a stall. */
const TRIP_AFTER_FAILURES = 5;

/** How long a tripped lane sheds before admitting a probe. */
const COOLDOWN_MS = 30_000;

interface LaneState {
  consecutiveFailures: number;
  trippedAt: number | null;
}

const lanes = new Map<ProviderLane, LaneState>();

function laneState(lane: ProviderLane): LaneState {
  let state = lanes.get(lane);
  if (state === undefined) {
    state = { consecutiveFailures: 0, trippedAt: null };
    lanes.set(lane, state);
  }
  return state;
}

/**
 * Report the outcome of one provider call. Any success closes the breaker: a
 * lane that is answering is healthy regardless of its history, and holding a
 * grudge would keep shedding work the provider can now serve.
 */
export function recordProviderOutcome(lane: ProviderLane, ok: boolean, now: number = Date.now()): void {
  const state = laneState(lane);
  if (ok) {
    if (state.trippedAt !== null) {
      log.info("api.limits", `provider lane recovered: ${lane}`, { lane });
    }
    state.consecutiveFailures = 0;
    state.trippedAt = null;
    return;
  }
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= TRIP_AFTER_FAILURES && state.trippedAt === null) {
    state.trippedAt = now;
    log.warn("api.limits", `provider lane tripped: ${lane}`, {
      lane,
      consecutiveFailures: state.consecutiveFailures,
    });
  }
}

export function laneHealth(lane: ProviderLane, now: number = Date.now()): LaneHealth {
  const state = laneState(lane);
  if (state.trippedAt === null) return "healthy";
  return now - state.trippedAt >= COOLDOWN_MS ? "degraded" : "unhealthy";
}

/** Seconds a shed caller should wait — the remaining cooldown, floored at 1. */
export function laneRetryAfterSeconds(lane: ProviderLane, now: number = Date.now()): number {
  const state = laneState(lane);
  if (state.trippedAt === null) return 0;
  return Math.max(1, Math.ceil((state.trippedAt + COOLDOWN_MS - now) / 1000));
}

export function resetProviderHealth(): void {
  lanes.clear();
}

/**
 * Global queued+running ceiling. Unlike the per-user cap this is about the
 * machine: one Fly VM with a shared CPU cannot usefully hold hundreds of
 * in-flight renders no matter how many accounts asked for them.
 */
export const QUEUE_DEPTH_CEILING = 200;

export async function queueDepth(): Promise<number> {
  const [row] = await db()
    .select({ depth: count() })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ["queued", "running"]),
        gt(jobs.createdAt, new Date(Date.now() - JOB_SLOT_STALE_MS)),
      ),
    );
  return row?.depth ?? 0;
}

/** Degrades open: an unreadable queue must not itself become an outage. */
export async function queueSaturated(ceiling = QUEUE_DEPTH_CEILING): Promise<boolean> {
  try {
    return (await queueDepth()) >= ceiling;
  } catch (err) {
    log.error("api.limits", "queue depth unavailable; not shedding", { error: errorText(err) });
    return false;
  }
}
