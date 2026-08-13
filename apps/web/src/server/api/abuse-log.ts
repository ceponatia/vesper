import { db, events } from "@/server/db";
import { log } from "@/server/log";
// Deliberately no `./respond` import: `respond.ts` reaches this module through
// the pre-auth IP limiter, so importing back would close a cycle
// (`pnpm lint:cycles`). The one-line error text is inlined below instead.

/**
 * Abuse-signal recording (rate-limits.plan.md slice 7).
 *
 * The requirement is to log abuse signals *without* storing sensitive prompt
 * content. That is enforced structurally rather than by discipline: {@link
 * AbuseSignal} has no free-form content field, so there is no member a prompt,
 * message body, or generated text could travel in even by accident. Callers hand
 * over a policy name and a pair of numbers.
 */

export const ABUSE_SIGNAL_EVENT = "abuse_signal";

export type AbuseSignalKind =
  | "ip_rate_limited"
  | "rate_limited"
  | "budget_exceeded"
  | "storage_quota_exceeded"
  | "job_cap_exceeded"
  | "backpressure_shed";

export interface AbuseSignal {
  readonly kind: AbuseSignalKind;
  /** Route pathname — a URL template's worth of information, never a query or body. */
  readonly route: string;
  readonly method: string;
  /** Policy / counter name that denied the call. */
  readonly policy: string;
  readonly scope: "ip" | "user";
  readonly ownerId: string | null;
  /** Salted digest, never a raw address (see `client-ip.ts`). */
  readonly ipHash: string | null;
  readonly limit: number;
  readonly observed: number;
}

/**
 * Escalation threshold. Persisting an `events` row per denial would hand an
 * attacker a write amplifier — every rejected request causing a database insert
 * is a cheaper DoS than the one being blocked. So denials are counted in memory
 * and only a *sustained* pattern earns a durable record, at most once per window
 * per scope.
 */
const ESCALATE_AFTER = 20;
const ESCALATION_WINDOW_MS = 5 * 60_000;

interface Escalation {
  count: number;
  windowStart: number;
  persisted: boolean;
}

const escalations = new Map<string, Escalation>();

/** Bounds the escalation map the same way the limiter bounds its buckets. */
const MAX_ESCALATION_KEYS = 10_000;

function escalationKey(signal: AbuseSignal): string {
  return `${signal.kind}:${signal.scope}:${signal.ownerId ?? signal.ipHash ?? "anonymous"}`;
}

/** True when this signal has just crossed the durable-record threshold. */
function shouldPersist(signal: AbuseSignal, now: number): boolean {
  const key = escalationKey(signal);
  const current = escalations.get(key);
  if (current === undefined || now - current.windowStart > ESCALATION_WINDOW_MS) {
    if (escalations.size >= MAX_ESCALATION_KEYS) escalations.clear();
    escalations.set(key, { count: 1, windowStart: now, persisted: false });
    return false;
  }
  current.count += 1;
  if (current.count < ESCALATE_AFTER || current.persisted) return false;
  current.persisted = true;
  return true;
}

/**
 * Record one denial. Always logs; persists only on sustained abuse. Never
 * throws and never awaits the caller's critical path — a limiter that can fail a
 * request by failing to *record* the rejection is worse than one that stays
 * quiet (docs/resilience.md).
 */
export function recordAbuseSignal(signal: AbuseSignal, now: number = Date.now()): void {
  log.warn("api.limits", `${signal.kind} on ${signal.method} ${signal.route}`, {
    policy: signal.policy,
    scope: signal.scope,
    ownerId: signal.ownerId,
    ipHash: signal.ipHash,
    limit: signal.limit,
    observed: signal.observed,
  });

  if (!shouldPersist(signal, now)) return;

  void db()
    .insert(events)
    .values({
      type: ABUSE_SIGNAL_EVENT,
      payload: {
        schemaVersion: 1,
        kind: signal.kind,
        route: signal.route,
        method: signal.method,
        policy: signal.policy,
        scope: signal.scope,
        ownerId: signal.ownerId,
        ipHash: signal.ipHash,
        limit: signal.limit,
        observed: signal.observed,
        threshold: ESCALATE_AFTER,
        windowMs: ESCALATION_WINDOW_MS,
      },
    })
    .catch((err: unknown) => {
      log.error("api.limits", "failed to persist abuse signal", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export function resetAbuseSignals(): void {
  escalations.clear();
}
