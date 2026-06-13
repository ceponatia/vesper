/**
 * In-memory sliding-window rate limiter (docs/authoring.md §Guardrails:
 * "forge calls are rate-limited per user"). Per-process state is the accepted
 * single-instance constraint, same as the in-process job runner.
 */

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  now?: number;
}

export const FORGE_RATE_LIMIT: RateLimitOptions = { limit: 10, windowMs: 60_000 };

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
