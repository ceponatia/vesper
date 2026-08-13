import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PREDICTION_TIMEOUT_MS, MAX_PREDICTION_TIMEOUT_MS } from "@vesper/image-replicate";
import {
  disableSafetyChecker,
  hasReplicate,
  replicateClient,
  resetReplicateRuntimeForTesting,
  resolveReplicateConfig,
} from "./replicate-runtime";

/**
 * Environment resolution is the APPLICATION's half of the Replicate split: the
 * transport package reads no `process.env` at all, so the rules for what an
 * unset, blank or nonsense variable means live here and are pinned here
 * (monorepo-image-core.spec.replicate.md §"Environment inversion").
 *
 * `src/test/setup.ts` deletes the token for every application test, so each case
 * states the deployment it is about rather than inheriting one.
 */

const ENV_KEYS = ["REPLICATE_API_TOKEN", "REPLICATE_SAFE_MODE", "REPLICATE_PREDICTION_TIMEOUT_MS"] as const;
const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetReplicateRuntimeForTesting();
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetReplicateRuntimeForTesting();
});

describe("resolveReplicateConfig", () => {
  it("treats a missing or blank token as an unavailable provider", () => {
    withEnv({});
    expect(resolveReplicateConfig().apiToken).toBeNull();

    withEnv({ REPLICATE_API_TOKEN: "   " });
    expect(resolveReplicateConfig().apiToken).toBeNull();

    withEnv({ REPLICATE_API_TOKEN: "r8_live" });
    expect(resolveReplicateConfig().apiToken).toBe("r8_live");
  });

  it("keeps the safety checker on only for the exact string `true`", () => {
    // Every other value disables it, which is the controlled environment's
    // default and the behavior operators have today.
    withEnv({ REPLICATE_SAFE_MODE: "true" });
    expect(resolveReplicateConfig().safetyCheckerDisabled).toBe(false);

    for (const value of ["false", "TRUE", "1", ""]) {
      withEnv({ REPLICATE_SAFE_MODE: value });
      expect(resolveReplicateConfig().safetyCheckerDisabled).toBe(true);
    }

    withEnv({});
    expect(resolveReplicateConfig().safetyCheckerDisabled).toBe(true);
  });

  it("honours a sane prediction budget, clamps a huge one, and falls back otherwise", () => {
    withEnv({ REPLICATE_PREDICTION_TIMEOUT_MS: "900000" });
    expect(resolveReplicateConfig().predictionTimeoutMs).toBe(900_000);

    withEnv({ REPLICATE_PREDICTION_TIMEOUT_MS: "9999999999" });
    expect(resolveReplicateConfig().predictionTimeoutMs).toBe(MAX_PREDICTION_TIMEOUT_MS);

    // Below the 30s floor falls THROUGH to the default rather than clamping up —
    // an operator who wrote 5000 gets the five-minute default, which is the
    // behavior the transport had before the split.
    for (const value of [undefined, "not-a-number", "", "5000"]) {
      withEnv(value === undefined ? {} : { REPLICATE_PREDICTION_TIMEOUT_MS: value });
      expect(resolveReplicateConfig().predictionTimeoutMs).toBe(DEFAULT_PREDICTION_TIMEOUT_MS);
    }
  });
});

describe("the process runtime", () => {
  it("resolves once and reuses the same client", () => {
    withEnv({ REPLICATE_API_TOKEN: "r8_live" });
    const first = replicateClient();
    expect(replicateClient()).toBe(first);
    expect(hasReplicate()).toBe(true);
  });

  it("reports the deployment's posture through the same snapshot the payload uses", () => {
    // The fingerprint and the request must not be able to disagree: both read
    // this one client, so there is no second answer to give.
    withEnv({ REPLICATE_API_TOKEN: "r8_live", REPLICATE_SAFE_MODE: "true" });
    expect(disableSafetyChecker()).toBe(false);
    expect(replicateClient().safetyCheckerDisabled).toBe(false);

    withEnv({ REPLICATE_API_TOKEN: "r8_live" });
    expect(disableSafetyChecker()).toBe(true);
    expect(replicateClient().safetyCheckerDisabled).toBe(true);
  });

  it("reports an unconfigured deployment without a token", () => {
    withEnv({});
    expect(hasReplicate()).toBe(false);
    expect(replicateClient().configured).toBe(false);
  });
});
