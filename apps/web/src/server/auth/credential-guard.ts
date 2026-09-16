import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { credentialFailures, db } from "../db";
import { log } from "@/server/log";

/**
 * Durable per-account backoff on failed credential checks.
 *
 * This is the second of two layers, and they bound different things. The per-IP
 * window (`server/api/rate-limit.ts`) bounds how fast ONE ADDRESS may attempt
 * anything; it lives in memory because losing a seconds-scale burst count to a
 * restart is harmless. It cannot bound guessing against one account, because an
 * attacker with a list of proxies simply spreads the attempts. This layer bounds
 * how fast ONE ACCOUNT may be guessed at, from everywhere at once, and is
 * accounted in Postgres because an attacker who could clear it by crash-looping
 * the process — or just by waiting for the next deploy — would not be bounded
 * at all.
 *
 * ## Shape of the defense
 *
 * Delay, not lockout. A hard lock is a gift to an attacker who knows an address:
 * a handful of deliberate failures and the owner is out until someone
 * intervenes. Here the penalty is a wait that grows with consecutive failures
 * and **stops growing** at {@link MAX_BACKOFF_MS}, so the worst an attacker can
 * impose is that ceiling, and it costs them a request every time they want to
 * keep imposing it. A correct password clears the record outright.
 *
 * ## What it does not reveal
 *
 * The record is keyed on whatever address was submitted, whether or not an
 * account exists for it, and the refusal is byte-identical either way. Better
 * Auth already burns a password hash on the unknown-user path so the timings
 * match; charging before the endpoint runs keeps that property, because the work
 * this module does is the same for both.
 */

/** Consecutive failures that cost nothing — a person mistyping a password. */
export const FREE_ATTEMPTS = 5;

/** The first penalty, doubling per failure after {@link FREE_ATTEMPTS}. */
export const BASE_BACKOFF_MS = 5_000;

/**
 * The ceiling, and the number that decides what this defense is worth.
 *
 * At five minutes a sustained attack against one account is bounded to ~12
 * guesses an hour from every source combined, which ends offline-scale guessing
 * against a known address. The same number bounds the denial-of-service: an
 * attacker who wants to keep an owner waiting must keep paying a request every
 * five minutes, and the owner is never locked out, only delayed.
 */
export const MAX_BACKOFF_MS = 300_000;

/**
 * Idle time after which the count restarts. Long enough that yesterday's typos
 * are not still being charged; short enough to be useless as an evasion, since
 * reaching it means attempting fewer than one guess an hour — slower than the
 * ceiling above already forces.
 */
export const DECAY_MS = 3_600_000;

/** Bound on the stored count. The delay saturates at 12, so this is headroom, not policy. */
export const FAILURE_CAP = 16;

/** Compare-and-swap rounds before giving up. Contention on one subject means an attack. */
const MAX_SWAP_ATTEMPTS = 3;

export interface CredentialDecision {
  readonly allowed: boolean;
  /** Whole seconds the caller must wait; 0 when allowed. */
  readonly retryAfterSeconds: number;
  /** Why a refusal happened — `backoff` is the policy, `unavailable` is a broken guard. */
  readonly reason: "allowed" | "backoff" | "unavailable";
}

const ALLOWED: CredentialDecision = { allowed: true, retryAfterSeconds: 0, reason: "allowed" };

function refused(reason: "backoff" | "unavailable", retryAfterMs: number): CredentialDecision {
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)), reason };
}

/**
 * The delay owed after `failures` consecutive misses.
 *
 * Exponential between the free allowance and the ceiling: 5s, 10s, 20s, 40s,
 * 80s, 160s, then flat at {@link MAX_BACKOFF_MS}. Doubling is what makes a long
 * run expensive without making the first slip annoying.
 */
export function backoffMs(failures: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  const step = failures - FREE_ATTEMPTS - 1;
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** step);
}

export interface FailureRecord {
  readonly failures: number;
  readonly lastFailureAt: number;
}

export interface NextFailureState {
  readonly failures: number;
  readonly retryAt: number;
}

/**
 * The state a fresh failure produces. Pure, so the schedule is one readable
 * function rather than arithmetic spread across a SQL statement — the database
 * only stores what this decides.
 */
export function nextFailureState(prior: FailureRecord | null, now: number): NextFailureState {
  const decayed = prior === null || now - prior.lastFailureAt >= DECAY_MS;
  const failures = decayed ? 1 : Math.min(prior.failures + 1, FAILURE_CAP);
  return { failures, retryAt: now + backoffMs(failures) };
}

/**
 * The bucket key for an address: normalized the way Better Auth normalizes it
 * before looking a user up (`findUserByEmail` lowercases), then salted and
 * digested.
 *
 * Matching that normalization is load-bearing, not tidiness — if `A@b.com` and
 * `a@b.com` were different keys here while naming one account there, varying the
 * case would multiply the allowance by however many spellings the attacker cared
 * to type.
 */
export function credentialSubject(address: string): string {
  const normalized = address.trim().toLowerCase();
  const salt = process.env.BETTER_AUTH_SECRET ?? "vesper-credential-salt";
  return createHmac("sha256", salt).update(normalized).digest("hex").slice(0, 32);
}

async function readRecord(subject: string): Promise<{ failures: number; lastFailureAt: Date; retryAt: Date } | null> {
  const [row] = await db()
    .select({
      failures: credentialFailures.failures,
      lastFailureAt: credentialFailures.lastFailureAt,
      retryAt: credentialFailures.retryAt,
    })
    .from(credentialFailures)
    .where(eq(credentialFailures.subject, subject))
    .limit(1);
  return row ?? null;
}

/**
 * Charge one credential attempt against `subject` and report whether it may
 * proceed.
 *
 * Called **before** the password is checked, so the count cannot be outrun: an
 * attempt that never reaches the verifier — a dropped connection, a crash
 * mid-request — has already been counted, and a burst of simultaneous guesses
 * cannot all read "under the threshold" and all proceed.
 *
 * Atomicity is a compare-and-swap rather than a single upsert: the update pins
 * the exact row the decision was computed from, so a concurrent charge either
 * loses and retries against the state the winner wrote, or wins and makes the
 * other retry. The alternative — computing the schedule inside the SQL so one
 * statement could do it — would put the policy in two places, which is how a
 * backoff quietly stops matching the schedule it documents.
 *
 * A refused attempt writes nothing. Hammering a closed window therefore cannot
 * push its own reset further out, the same property `checkRateLimit` keeps, and
 * an impatient owner cannot lengthen their own wait.
 */
export async function chargeCredentialAttempt(subject: string, now: number = Date.now()): Promise<CredentialDecision> {
  try {
    for (let round = 0; round < MAX_SWAP_ATTEMPTS; round += 1) {
      const prior = await readRecord(subject);

      if (prior !== null && prior.retryAt.getTime() > now) {
        return refused("backoff", prior.retryAt.getTime() - now);
      }

      const next = nextFailureState(
        prior === null ? null : { failures: prior.failures, lastFailureAt: prior.lastFailureAt.getTime() },
        now,
      );
      const values = {
        failures: next.failures,
        lastFailureAt: new Date(now),
        retryAt: new Date(next.retryAt),
        updatedAt: new Date(now),
      };

      if (prior === null) {
        const inserted = await db()
          .insert(credentialFailures)
          .values({ subject, ...values })
          .onConflictDoNothing({ target: credentialFailures.subject })
          .returning({ id: credentialFailures.id });
        if (inserted.length > 0) return ALLOWED;
        continue; // Another attempt created the row first; re-read and charge against it.
      }

      const swapped = await db()
        .update(credentialFailures)
        .set(values)
        .where(
          and(
            eq(credentialFailures.subject, subject),
            // Pinning both fields is what makes this a compare-and-swap: a
            // concurrent charge changes them together, so a stale decision
            // cannot land.
            eq(credentialFailures.failures, prior.failures),
            eq(credentialFailures.lastFailureAt, prior.lastFailureAt),
          ),
        )
        .returning({ id: credentialFailures.id });
      if (swapped.length > 0) return ALLOWED;
    }

    // Losing every round means many attempts are landing on one account at once,
    // which is the attack this exists to bound, not ordinary traffic.
    log.warn("auth.credential_guard", "credential backoff contended; refusing", {
      code: "auth.credential_guard.contended",
      subject,
    });
    return refused("backoff", BASE_BACKOFF_MS);
  } catch (err) {
    /**
     * Fail **closed**, deliberately, and unlike the cost guards in
     * `server/api/quota.ts`, which allow the call when their counter is
     * unreachable. That trade is right for a spend ceiling layered behind other
     * limits and wrong here, for two reasons.
     *
     * It costs almost nothing. A sign-in cannot succeed without this database:
     * the user lookup, the credential row and the session insert all need it. So
     * in the case people picture — Postgres is down — refusing changes nothing an
     * honest caller could have done anyway.
     *
     * And the case where it is not nothing is the one that matters. If reads
     * still work while this write does not, failing open would leave the account
     * defense off precisely while the sign-in path kept verifying passwords.
     * Refusing is recoverable in a minute; unbounded guessing against a known
     * admin address is not.
     */
    log.error("auth.credential_guard", "credential backoff unavailable; refusing", {
      code: "auth.credential_guard.unavailable",
      subject,
      error: err instanceof Error ? err.message : String(err),
    });
    return refused("unavailable", BASE_BACKOFF_MS);
  }
}

/**
 * Forget a subject's failures. Called when a credential check actually passed,
 * so an owner who fumbles a password four times and then gets it right starts
 * clean rather than carrying the count into next week.
 *
 * Never throws: the sign-in already succeeded by the time this runs, and failing
 * it over a bookkeeping delete would turn a working password into an error. The
 * stale row's only effect is a delay the owner's next success clears anyway, and
 * the retention pass removes it regardless.
 */
export async function clearCredentialFailures(subject: string): Promise<void> {
  try {
    await db().delete(credentialFailures).where(eq(credentialFailures.subject, subject));
  } catch (err) {
    log.warn("auth.credential_guard", "could not clear credential failures", {
      code: "auth.credential_guard.clear_failed",
      subject,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test-only: the raw record behind a subject. */
export async function readCredentialFailures(subject: string): Promise<FailureRecord | null> {
  const row = await readRecord(subject);
  return row === null ? null : { failures: row.failures, lastFailureAt: row.lastFailureAt.getTime() };
}

/** Rows whose last failure is older than this are spent and may be reaped. */
export function decayCutoff(now: Date): Date {
  return new Date(now.getTime() - DECAY_MS);
}
