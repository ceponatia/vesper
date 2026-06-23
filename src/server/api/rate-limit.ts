/**
 * In-memory sliding-window rate limiter (docs/authoring.md §Guardrails:
 * "forge calls are rate-limited per user"; docs/resilience.md §7). Per-process
 * state is the accepted single-instance constraint, same as the in-process job
 * runner — these caps bound financial / resource DoS on the paid-model and
 * heavy-write endpoints, not cross-instance fairness.
 */

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  now?: number;
}

/** Forge prose→draft calls (character/world authoring + draft saves). */
export const FORGE_RATE_LIMIT: RateLimitOptions = { limit: 10, windowMs: 60_000 };

/** Image generation (avatars, portrait variants, scene + entity images). */
export const GENERATION_RATE_LIMIT: RateLimitOptions = { limit: 20, windowMs: 60_000 };

/** Character-chat turns (text streaming + chat scene renders). */
export const CHAT_RATE_LIMIT: RateLimitOptions = { limit: 30, windowMs: 60_000 };

/** Heavy writes (world duplicate, session spawn). */
export const HEAVY_WRITE_RATE_LIMIT: RateLimitOptions = { limit: 10, windowMs: 60_000 };

const buckets = new Map<string, number[]>();

/** Returns true when the call is allowed (and records it). */
export function rateLimit(key: string, opts: RateLimitOptions): boolean {
  const now = opts.now ?? Date.now();
  const cutoff = now - opts.windowMs;
  const stamps = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (stamps.length >= opts.limit) {
    buckets.set(key, stamps);
    return false;
  }
  stamps.push(now);
  buckets.set(key, stamps);
  return true;
}

export function resetRateLimits(): void {
  buckets.clear();
}
