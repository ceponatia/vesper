/**
 * What the transport needs to know about its deployment, and the fixed budgets
 * it never asks anyone about.
 *
 * The package reads NO environment. The application resolves the process
 * environment into a `ReplicateConfig` once and hands it to
 * `createReplicateClient`, so a process cannot fingerprint one safety posture
 * and send another (monorepo-image-core.spec.replicate.md §"One safety value
 * from plan to send").
 */

export interface ReplicateConfig {
  /** `null` means the provider is unavailable; every call fails before network work. */
  apiToken: string | null;
  /**
   * Whether generated images bypass the provider's safety checker. Only ever
   * applied to models whose schema HAS the input — Replicate rejects unknown
   * inputs, so the key is never introduced, only overridden.
   */
  safetyCheckerDisabled: boolean;
  /** The default prediction budget, already resolved and clamped by the caller. */
  predictionTimeoutMs: number;
}

export const REPLICATE_BASE = "https://api.replicate.com/v1";

/**
 * The per-HTTP-call deadline every Replicate request carries, and the separate
 * one the output download gets.
 *
 * Both are EXPORTED because they are the only honest way to size how long one
 * render may legitimately take end to end. The identity trial's stale-claim
 * window has to exceed a whole render — prediction budget plus the reference
 * uploads, the settling poll, and the output fetch around it — and a window
 * derived from a hand-copied "about a minute" would silently stop covering the
 * real thing the first time either number moved.
 */
export const REQUEST_TIMEOUT_MS = 75_000;
export const OUTPUT_TIMEOUT_MS = 60_000;

/** The schema probe's own deadline — one GET, no polling. */
export const PROBE_TIMEOUT_MS = 20_000;

export const POLL_INTERVAL_MS = 1_500;

/**
 * The prediction budget band, exported so the application's environment
 * resolution and this package's per-request clamp use the same numbers rather
 * than two hand-copied copies of them.
 *
 * A caller asking for a 12-hour prediction is a bug, not a budget.
 */
export const DEFAULT_PREDICTION_TIMEOUT_MS = 5 * 60_000;
export const MIN_PREDICTION_TIMEOUT_MS = 30_000;
export const MAX_PREDICTION_TIMEOUT_MS = 30 * 60_000;

/** The default model the lab edits with when a request names no slug. */
export const REPLICATE_DEFAULT_EDIT_MODEL = "qwen/qwen-image-edit-2511";

/**
 * This run's prediction budget: the request's own value when it has one, else
 * the config's.
 *
 * A requested value is CLAMPED into the sane band rather than rejected — the
 * caller asked for a budget and deserves the nearest one it may have. The
 * config's value arrives already resolved, because deciding what an unset or
 * nonsense environment variable means is the application's job, not the
 * transport's.
 */
export function predictionTimeoutMs(config: ReplicateConfig, requested?: number): number {
  if (requested !== undefined && Number.isFinite(requested)) {
    return Math.min(Math.max(requested, MIN_PREDICTION_TIMEOUT_MS), MAX_PREDICTION_TIMEOUT_MS);
  }
  return config.predictionTimeoutMs;
}
