import { beforeEach, expect } from "vitest";
import { INTEGRATION_ATTESTATION_META_KEY, integrationWorkerAttestation, requireIntegrationDb } from "./integration-mode";

/**
 * `app-int` setup, after `apps/web/src/test/setup.ts` (which forces the fake
 * providers). Runs ahead of every integration suite's own imports, so a worker
 * whose environment contradicts its mode fails that suite's collection before
 * any fixture or production module loads. In `strict`/`legacy` mode each test
 * then carries the worker's attestation in its metadata; the unpartitioned
 * `all` view (plain `pnpm test:int`) asserts and stamps nothing.
 */
const attestation = integrationWorkerAttestation({
  env: process.env,
  testPath: expect.getState().testPath,
  cwd: process.cwd(),
  strictDatabase: requireIntegrationDb(),
});

if (attestation !== undefined) {
  beforeEach(({ task }) => {
    Object.assign(task.meta, { [INTEGRATION_ATTESTATION_META_KEY]: attestation });
  });
}
