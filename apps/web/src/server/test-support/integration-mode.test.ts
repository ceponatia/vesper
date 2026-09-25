import { describe, expect, it } from "vitest";
import {
  INTEGRATION_LEGACY_CAPABILITY_ENV,
  INTEGRATION_LEGACY_FILES_ENV,
  INTEGRATION_MODE_ENV,
  integrationWorkerAttestation,
  type IntegrationWorkerInput,
} from "./integration-mode";

/**
 * The integration worker's own mode check (#638): a strict worker can never
 * carry the legacy capability, a legacy worker runs only audited files with it,
 * and both need strict database probes and the fake providers.
 */

const ROOT = "/repo";
const STRICT_FILE = "apps/web/src/server/api/authz-matrix.int.test.ts";
const LEGACY_FILE = "apps/web/src/server/engine/simulation/space-store.int.test.ts";

function input(env: Record<string, string | undefined>, file = STRICT_FILE, strictDatabase = true): IntegrationWorkerInput {
  return {
    env: { AI_FAKE: "1", NODE_ENV: "test", ...env },
    testPath: `${ROOT}/${file}`,
    cwd: ROOT,
    strictDatabase,
  };
}

const legacyEnv = {
  [INTEGRATION_MODE_ENV]: "legacy",
  [INTEGRATION_LEGACY_CAPABILITY_ENV]: "1",
  [INTEGRATION_LEGACY_FILES_ENV]: `${LEGACY_FILE}\napps/web/src/server/engine/simulation/body-store.int.test.ts`,
};

describe("integrationWorkerAttestation", () => {
  it("asserts nothing in the unpartitioned view", () => {
    expect(integrationWorkerAttestation(input({}))).toBeUndefined();
    expect(integrationWorkerAttestation(input({ [INTEGRATION_MODE_ENV]: "all", [INTEGRATION_LEGACY_CAPABILITY_ENV]: "1" }))).toBeUndefined();
  });

  it("attests a clean strict worker", () => {
    expect(integrationWorkerAttestation(input({ [INTEGRATION_MODE_ENV]: "strict" }))).toEqual({
      mode: "strict",
      file: STRICT_FILE,
      legacyCapability: "absent",
      strictDatabase: true,
      fakeProviders: true,
    });
  });

  it.each(["1", "0", ""])("fails a strict worker that carries the capability at all (%j)", (value) => {
    expect(() =>
      integrationWorkerAttestation(input({ [INTEGRATION_MODE_ENV]: "strict", [INTEGRATION_LEGACY_CAPABILITY_ENV]: value })),
    ).toThrow(/strict mode must not carry VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER/);
  });

  it("attests an audited legacy file with the capability", () => {
    expect(integrationWorkerAttestation(input(legacyEnv, LEGACY_FILE))).toEqual({
      mode: "legacy",
      file: LEGACY_FILE,
      legacyCapability: "enabled",
      strictDatabase: true,
      fakeProviders: true,
    });
  });

  it("fails a legacy worker importing a file that is not an audited exception", () => {
    expect(() => integrationWorkerAttestation(input(legacyEnv, STRICT_FILE))).toThrow(/is not an audited legacy exception/);
  });

  it.each<[string, Record<string, string | undefined>]>([
    ["without the capability", { [INTEGRATION_LEGACY_CAPABILITY_ENV]: undefined }],
    ["with a malformed capability", { [INTEGRATION_LEGACY_CAPABILITY_ENV]: "true" }],
    ["outside NODE_ENV=test", { NODE_ENV: "production" }],
  ])("fails a legacy worker %s", (_label, change) => {
    expect(() => integrationWorkerAttestation(input({ ...legacyEnv, ...change }, LEGACY_FILE))).toThrow(/legacy mode needs/);
  });

  it("fails either mode without strict database probes", () => {
    expect(() => integrationWorkerAttestation(input({ [INTEGRATION_MODE_ENV]: "strict" }, STRICT_FILE, false))).toThrow(
      /requires strict database probes/,
    );
  });

  it.each<[string, Record<string, string | undefined>]>([
    ["without AI_FAKE", { AI_FAKE: undefined }],
    ["with a provider credential", { OPENROUTER_API_KEY: "sk-live" }],
    ["with an image-provider credential", { FAL_API_KEY: "fal-live" }],
    ["with a LoRA-provider credential", { CIVITAI_API_TOKEN: "civitai-live" }],
  ])("fails a worker %s", (_label, change) => {
    expect(() => integrationWorkerAttestation(input({ [INTEGRATION_MODE_ENV]: "strict", ...change }))).toThrow(/fake-provider setup/);
  });

  it("fails an unknown mode and a worker that cannot name its suite", () => {
    expect(() => integrationWorkerAttestation(input({ [INTEGRATION_MODE_ENV]: "loose" }))).toThrow(/is not strict, legacy or all/);
    expect(() =>
      integrationWorkerAttestation({ ...input({ [INTEGRATION_MODE_ENV]: "strict" }), testPath: undefined }),
    ).toThrow(/cannot name the suite/);
  });
});
