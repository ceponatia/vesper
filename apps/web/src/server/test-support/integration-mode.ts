import path from "node:path";

/**
 * The integration worker's own statement of the authorization mode it runs in.
 *
 * CI runs the application integration inventory as two separate Vitest
 * processes (`scripts/ci-integration.mjs`): STRICT, whose environment has no
 * legacy synthetic-player capability at all, and LEGACY, which carries it for an
 * audited list of files only (`scripts/integration-policy.mjs`). A launcher
 * manifest claiming "strict" proves nothing about the process that actually
 * imported a suite, so every integration worker checks its own environment
 * BEFORE the suite is imported (`integration-worker-setup.ts`) and stamps the
 * result onto each test's metadata, where the evidence verifier reads it back
 * out of the JSON report.
 *
 * Pure on purpose: no database, engine or policy import, so the setup that runs
 * ahead of every integration file loads nothing a suite might later `vi.mock`.
 * The environment names below are asserted equal to their owners' constants by
 * `scripts/integration-policy.test.ts`.
 */

/** Mirrors `LEGACY_CAPABILITY_ENV` (policy) and `LEGACY_ENGINE_TEST_PLAYER_ENV` (engine). */
export const INTEGRATION_LEGACY_CAPABILITY_ENV = "VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER";

/** Mirrors `INTEGRATION_MODE_ENV` in `scripts/integration-policy.mjs`. */
export const INTEGRATION_MODE_ENV = "VESPER_INTEGRATION_MODE";

/** Newline-separated legacy exception files; the root Vitest config provides it to `app-int` workers (mirrors the policy's constant). */
export const INTEGRATION_LEGACY_FILES_ENV = "VESPER_INTEGRATION_LEGACY_FILES";

/** The task-metadata key the evidence verifier reads. */
export const INTEGRATION_ATTESTATION_META_KEY = "vesperIntegration";

/** The canonical strict-database flag; the CI launcher and `pnpm test:int:strict` set it. */
export const REQUIRE_INTEGRATION_DB_ENV = "REQUIRE_INTEGRATION_DB";

/**
 * True when an unreachable or unmigrated database must fail a suite rather than
 * skip it (`probeIntegrationDb`). The two older signals, `CI=true` and
 * `VESPER_REQUIRE_TEST_DB=1`, keep working so converting a suite never loosens it.
 */
export function requireIntegrationDb(env: Record<string, string | undefined> = process.env): boolean {
  return env[REQUIRE_INTEGRATION_DB_ENV] === "true" || env.VESPER_REQUIRE_TEST_DB === "1" || env.CI === "true";
}

export interface IntegrationAttestation {
  mode: "strict" | "legacy";
  /** Repo-relative path of the suite this worker imported. */
  file: string;
  legacyCapability: "absent" | "enabled";
  strictDatabase: boolean;
  fakeProviders: boolean;
}

export interface IntegrationWorkerInput {
  env: Record<string, string | undefined>;
  /** Absolute path of the suite about to be imported (`expect.getState().testPath`). */
  testPath: string | undefined;
  /** The run root; the launcher fixes it to the repository root. */
  cwd: string;
  /** Whether an unreachable database fails the suite (`requireIntegrationDb()`). */
  strictDatabase: boolean;
}

const PROVIDER_CREDENTIALS = [
  "OPENROUTER_API_KEY",
  "REPLICATE_API_TOKEN",
  "FEATHERLESS_API_TOKEN",
  "FAL_API_KEY",
  "CIVITAI_API_TOKEN",
] as const;

/**
 * Check the worker's environment against its declared mode. Returns the
 * attestation for `strict`/`legacy`, `undefined` for the unpartitioned `all`
 * view, and THROWS when the environment contradicts the mode — a throw here
 * fails the suite's collection, which the gate reports as a failed file.
 */
export function integrationWorkerAttestation(input: IntegrationWorkerInput): IntegrationAttestation | undefined {
  const { env } = input;
  const mode = env[INTEGRATION_MODE_ENV] ?? "";
  if (mode === "" || mode === "all") return undefined;
  if (mode !== "strict" && mode !== "legacy") {
    throw new Error(`[integration mode] ${INTEGRATION_MODE_ENV}=${JSON.stringify(mode)} is not strict, legacy or all.`);
  }
  if (input.testPath === undefined || input.testPath === "") {
    throw new Error(`[integration mode] ${mode} worker cannot name the suite it is about to import.`);
  }
  const file = path.relative(input.cwd, input.testPath).split(path.sep).join("/");
  const capability = env[INTEGRATION_LEGACY_CAPABILITY_ENV];
  const fakeProviders = env.AI_FAKE === "1" && PROVIDER_CREDENTIALS.every((key) => env[key] === undefined);

  if (!input.strictDatabase) {
    throw new Error(
      `[integration mode] ${file}: ${mode} mode requires strict database probes (REQUIRE_INTEGRATION_DB=true), so an unreachable database fails instead of skipping.`,
    );
  }
  if (!fakeProviders) {
    throw new Error(`[integration mode] ${file}: the fake-provider setup did not run before this suite (AI_FAKE=1, provider credentials cleared).`);
  }

  if (mode === "strict") {
    if (capability !== undefined) {
      throw new Error(
        `[integration mode] ${file}: strict mode must not carry ${INTEGRATION_LEGACY_CAPABILITY_ENV} (found ${JSON.stringify(capability)}). ` +
          `The strict process is where authorization-denial claims are proven; the capability would admit unanchored non-account players.`,
      );
    }
    return { mode, file, legacyCapability: "absent", strictDatabase: true, fakeProviders };
  }

  const allowed = (env[INTEGRATION_LEGACY_FILES_ENV] ?? "").split("\n").filter((line) => line !== "");
  if (!allowed.includes(file)) {
    throw new Error(
      `[integration mode] ${file} is not an audited legacy exception, so it may not run with ${INTEGRATION_LEGACY_CAPABILITY_ENV}. ` +
        `List it in scripts/integration-policy.mjs only if its fixtures genuinely need the legacy synthetic player.`,
    );
  }
  if (capability !== "1" || env.NODE_ENV !== "test") {
    throw new Error(
      `[integration mode] ${file}: legacy mode needs ${INTEGRATION_LEGACY_CAPABILITY_ENV}=1 under NODE_ENV=test (found ${JSON.stringify(capability)} / ${JSON.stringify(env.NODE_ENV)}).`,
    );
  }
  return { mode, file, legacyCapability: "enabled", strictDatabase: true, fakeProviders };
}
