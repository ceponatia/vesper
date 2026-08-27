/**
 * Burst rate limiting — the in-process half of the cost guards.
 *
 * Per-process state is the accepted single-instance constraint (fly.toml pins
 * one machine; cross-instance sharing stays deferred). What lives here is only
 * the *seconds-scale* half of the story: losing a sliding window to a restart is
 * harmless. Anything whose loss would be exploitable — daily spend, disk, queued
 * work — is durable instead and lives in `quota.ts` / `concurrency.ts`, because
 * an in-memory budget is reset by crash-looping the process.
 */

export interface RateLimitPolicy {
  /** Calls admitted per window. */
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  /** Calls still admissible in the current window (0 when denied). */
  readonly remaining: number;
  /** Epoch ms at which the window frees a slot — the `RateLimit-Reset` anchor. */
  readonly resetAt: number;
  /** Whole seconds to wait, rounded up; always ≥ 1 when denied, 0 when allowed. */
  readonly retryAfterSeconds: number;
}

const MINUTE = 60_000;

/**
 * Per-user policies, keyed by name. **The name is the bucket**: every image
 * route shares `image_generate` rather than owning a private window, because the
 * cost being bounded is "renders this account paid for", not "renders through
 * this URL". Adding a route is therefore a policy choice, never a new limit.
 *
 * Tier invariant (pinned by `rate-limit.test.ts`): every provider-backed or
 * storage-backed name is strictly stricter than `read`. Ordinary reads must
 * never be the thing that throttles a session.
 */
export const API_RATE_LIMITS = {
  /** Ordinary GETs — list/detail/library reads. Generous on purpose. */
  read: { limit: 120, windowMs: MINUTE },
  /** Ordinary owned-entity mutations that cost a row, not a provider call. */
  write: { limit: 60, windowMs: MINUTE },
  /** Chat turns, scene requests, remembers — one narrative provider call each. */
  chat: { limit: 30, windowMs: MINUTE },
  /** Copy-on-use duplication: cheap per call, unbounded rows if left open. */
  clone: { limit: 20, windowMs: MINUTE },
  /** Player-supplied bytes (avatar upload, chat attachment). */
  upload: { limit: 20, windowMs: MINUTE },
  /** Every image render lane: avatars, portrait variants, entity and scene images. */
  image_generate: { limit: 12, windowMs: MINUTE },
  /** Prose→draft authoring calls (character forge, attribute extraction, item draft). */
  forge: { limit: 10, windowMs: MINUTE },
  /** Embedding work driven directly by a request. */
  embed: { limit: 10, windowMs: MINUTE },
  /** Re-running a turn the caller already paid for — cheap to spam, real cost each time. */
  regenerate: { limit: 10, windowMs: MINUTE },
  /** Whole-history rebuilds and other multi-call fan-outs. */
  heavy_write: { limit: 6, windowMs: MINUTE },
} as const satisfies Record<string, RateLimitPolicy>;

export type ApiLimitName = keyof typeof API_RATE_LIMITS;

/**
 * The names that spend money or disk. Kept explicit rather than inferred from
 * the numbers so the tier test asserts intent ("this lane is expensive") and not
 * merely today's arithmetic.
 */
export const EXPENSIVE_LIMIT_NAMES = [
  "chat",
  "clone",
  "upload",
  "image_generate",
  "forge",
  "embed",
  "regenerate",
  "heavy_write",
] as const satisfies readonly ApiLimitName[];

/**
 * Pre-authentication per-IP policies. `ip_auth` covers the credential surface
 * (`/api/auth/*`), where the abuse shape is guessing rather than spending, so it
 * is far tighter than the app-wide default.
 */
export const IP_RATE_LIMITS = {
  ip_default: { limit: 300, windowMs: MINUTE },
  ip_auth: { limit: 20, windowMs: MINUTE },
} as const satisfies Record<string, RateLimitPolicy>;

export type IpLimitName = keyof typeof IP_RATE_LIMITS;

/**
 * Bucket ceiling. The map is keyed partly by client IP, so an attacker rotating
 * source addresses would otherwise grow it without bound — the limiter itself
 * becomes the memory-DoS. Eviction is LRU (see `touch`), and the ceiling is
 * sized well above any plausible legitimate concurrent-key count.
 */
const MAX_BUCKETS = 20_000;

/** Full sweep cadence, in recorded calls, to retire windows nobody revisits. */
const SWEEP_EVERY = 5_000;

const buckets = new Map<string, number[]>();
let callsSinceSweep = 0;

/** Re-inserting moves the key to the end of the Map's order, making it the MRU entry. */
function touch(key: string, stamps: number[]): void {
  buckets.delete(key);
  buckets.set(key, stamps);
}

function sweep(now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  for (const [key, stamps] of buckets) {
    if (stamps.length === 0 || (stamps[stamps.length - 1] ?? 0) <= cutoff) buckets.delete(key);
  }
}

function evictOldest(): void {
  // Map iterates in insertion order and `touch` re-inserts on write, so the
  // front of the iteration is the least-recently-used key.
  const overflow = buckets.size - MAX_BUCKETS;
  if (overflow <= 0) return;
  let removed = 0;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    if (++removed >= overflow) break;
  }
}

/**
 * Record one call against `key` and report the decision. A denied call is **not**
 * recorded — a client hammering a closed window cannot push its own reset time
 * further out.
 */
export function checkRateLimit(key: string, policy: RateLimitPolicy, now: number = Date.now()): RateLimitDecision {
  if (++callsSinceSweep >= SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweep(now, policy.windowMs);
  }

  const cutoff = now - policy.windowMs;
  const stamps = (buckets.get(key) ?? []).filter((t) => t > cutoff);

  if (stamps.length >= policy.limit) {
    touch(key, stamps);
    // The window frees a slot when its oldest surviving call ages out.
    const oldest = stamps[0] ?? now;
    const resetAt = oldest + policy.windowMs;
    return {
      allowed: false,
      limit: policy.limit,
      remaining: 0,
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  stamps.push(now);
  touch(key, stamps);
  if (buckets.size > MAX_BUCKETS) evictOldest();

  return {
    allowed: true,
    limit: policy.limit,
    remaining: policy.limit - stamps.length,
    resetAt: (stamps[0] ?? now) + policy.windowMs,
    retryAfterSeconds: 0,
  };
}

/** Per-user check. The policy name is the bucket; `ownerId` scopes it. */
export function checkUserRateLimit(name: ApiLimitName, ownerId: string, now?: number): RateLimitDecision {
  return checkRateLimit(`u:${name}:${ownerId}`, API_RATE_LIMITS[name], now);
}

/** Per-IP check, applied before authentication resolves. */
export function checkIpRateLimit(name: IpLimitName, ip: string, now?: number): RateLimitDecision {
  return checkRateLimit(`ip:${name}:${ip}`, IP_RATE_LIMITS[name], now);
}

export function resetRateLimits(): void {
  buckets.clear();
  callsSinceSweep = 0;
}

/** Test-only visibility into bucket retention; not part of the route surface. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}
