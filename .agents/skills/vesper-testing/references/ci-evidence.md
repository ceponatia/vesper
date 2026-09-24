# CI evidence

Read this before claiming a test ran or a change is fully covered. Repository-root [docs/testing.md](../../../../docs/testing.md#the-verification-gate) owns the current workflow shape and [integration modes](../../../../docs/testing.md#integration-modes); confirm `.github/workflows/ci.yml` when exact selection matters.

The aggregate `verify` check validates the jobs the changed-path classifier selected. A documentation-only change runs only the documentation job, so a green `verify` on it proves nothing about tests.

Every ready code change runs:

- the `app unit tests` shards (the root `app` project) and `workspace package tests` (every package's own suite); and
- the `integration` matrix, which runs the complete application integration inventory: every tracked `*.int.test.ts` under `apps/web/src/` or `scripts/`, split into a strict mode and an audited legacy-fixture mode (`scripts/integration-policy.mjs`).

`verify` reconciles the integration evidence (`scripts/verify-integration-results.mjs`): it fails unless every discovered suite executed exactly once, in its mode, and passed with no skipped or todo case. Its job summary lists each batch.

For completion evidence:

1. Name the run and the tested head SHA whose `verify` succeeded.
2. For a unit or package test, name the job that collects it.
3. For an integration suite, confirm it appears in that run's integration evidence (the `verify` summary counts, or the batch's uploaded report) rather than inferring it from the file's location.
4. A new integration suite that needs the legacy synthetic-player capability must be a listed legacy exception; otherwise it fails its strict run, and that failure is the evidence.

Do not use a local Vitest run to fill a gap. Do not claim a suite ran because a neighboring CI job was green.
