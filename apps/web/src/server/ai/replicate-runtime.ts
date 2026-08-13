import {
  createReplicateClient,
  DEFAULT_PREDICTION_TIMEOUT_MS,
  MAX_PREDICTION_TIMEOUT_MS,
  MIN_PREDICTION_TIMEOUT_MS,
  type ReplicateClient,
  type ReplicateConfig,
} from "@vesper/image-replicate";

/**
 * The application's Replicate runtime — the ONLY code in Vesper that reads
 * Replicate environment variables.
 *
 * The transport package performs the network IO but owns no ambient
 * configuration (monorepo-image-core.spec.replicate.md). Deployment settings are
 * the application's: this module resolves them once, builds one configured
 * client, and hands that client to every render, preprocessor run and schema
 * probe in the process.
 *
 * That single snapshot is what makes the safety posture single-source. The
 * render kernel fingerprints a plan with `disableSafetyChecker()` and the
 * payload builder writes `client.safetyCheckerDisabled`; because both are the
 * same resolved value, a process cannot hash one posture and send another.
 */

let client: ReplicateClient | null = null;

/**
 * Read the deployment's Replicate settings.
 *
 * Behavior is the transport's historical behavior, moved rather than changed:
 *
 * - a missing or blank token means the provider is unavailable;
 * - `REPLICATE_SAFE_MODE === "true"` keeps the provider's safety checker on;
 *   every other value (including unset) disables it, which is the controlled
 *   environment's default;
 * - the prediction budget is honored only when finite and at least 30 seconds,
 *   is clamped at 30 minutes, and otherwise falls back to five minutes.
 */
export function resolveReplicateConfig(): ReplicateConfig {
  const token = process.env.REPLICATE_API_TOKEN?.trim();
  const requested = Number(process.env.REPLICATE_PREDICTION_TIMEOUT_MS);
  return {
    apiToken: token ? token : null,
    safetyCheckerDisabled: process.env.REPLICATE_SAFE_MODE !== "true",
    predictionTimeoutMs:
      Number.isFinite(requested) && requested >= MIN_PREDICTION_TIMEOUT_MS
        ? Math.min(requested, MAX_PREDICTION_TIMEOUT_MS)
        : DEFAULT_PREDICTION_TIMEOUT_MS,
  };
}

/**
 * The process's configured Replicate client, resolved on first use.
 *
 * Lazily rather than at module import: Next loads server modules while building
 * and analyzing routes, when runtime secrets are absent, and a snapshot taken
 * then would describe the build machine rather than the deployment.
 */
export function replicateClient(): ReplicateClient {
  client ??= createReplicateClient(resolveReplicateConfig());
  return client;
}

/** Whether this deployment can reach Replicate at all. */
export function hasReplicate(): boolean {
  return replicateClient().configured;
}

/**
 * Whether generated images bypass the provider's safety checker.
 *
 * Anything that fingerprints what a render sends asks THIS, the same value the
 * payload builder writes — otherwise the fingerprint would describe a stored
 * placeholder while the provider received the deployment's answer.
 */
export function disableSafetyChecker(): boolean {
  return replicateClient().safetyCheckerDisabled;
}

/**
 * Drop the memoized client so the next call re-reads the environment.
 *
 * For tests that need to run under a different deployment posture than the one
 * the first call happened to resolve. Production never calls it: one process,
 * one snapshot.
 */
export function resetReplicateRuntimeForTesting(): void {
  client = null;
}
