# Existing helper lookup

Read this before writing test setup, fixtures, auth mocks, database cleanup, prompt assertions, or registry checks.

1. Read [the shared utilities section](../../../../docs/testing.md#shared-test-utilities) for ownership boundaries.
2. Search the nearest existing suite for the behavior and fixture shape.
3. Inspect the relevant helper barrel or directory before creating a helper:
   - Pure application helpers: `apps/web/src/test/` via `@/test/...`.
   - Server and integration helpers: `apps/web/src/server/test-support/` via its `@/server/test-support` barrel.
   - Simulation package fixtures: `packages/simulation-core/src/test-support/`, imported relatively inside the package or through its declared testing subpaths from the app.
4. Extend an existing helper only when several tests share the setup. Keep one-off setup beside its test.

Useful existing families include registry invariants, diagnostics assertions, auth binding and restoration, route request/response helpers, owner-scoped database fixtures and cleanup, simulation suite harnesses, prompt structure assertions, temporary data roots, image rows, and deterministic simulation envelopes. Search by the capability you need instead of copying names from this reference; the barrels are the current catalog.

Production code must not import `@/server/test-support`, because that barrel includes Vitest dependencies. Contracts and lib tests must not import server helpers. Cross-workspace fixtures use declared package exports rather than filesystem escapes.
