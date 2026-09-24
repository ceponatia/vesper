# Testing

Vesper uses Vitest 4 with one root-owned application configuration and package-owned workspace configurations. CI is the application validation surface; local application gates are disabled by project policy.

## Ownership

This page owns test-project wiring, layer boundaries, shared utility locations, integration contracts, and what each CI job selects. The `vesper-testing` skill owns whether a test should be added and which layer should carry a claim; the `vesper-test-keeper` role (`.codex/agents/`, `.claude/agents/`) applies it to a finished change, updating the owning tests and reporting what CI selected. Live UI and API verification belongs to the `verify` skill.

## Execution policy

Do not run application tests or gates on the development machine. The prohibition includes `pnpm test`, every `pnpm test:*` script, direct or package-filtered Vitest, watch mode, application lint, typecheck, build, Docker-backed integration setup, and local substitutes for CI jobs.

Code changes are validated by the applicable jobs in `.github/workflows/ci.yml`. A documentation-only change may run `pnpm lint:docs` locally because `scripts/check-docs.mjs` uses Node built-ins and starts no application service. A skill-owned shell or Python helper may use dependency-free offline fixture tests when those fixtures start neither Vesper nor a database nor an external service.

Command definitions in `package.json` describe suite ownership. CI runs the integration inventory through `scripts/ci-integration.mjs` rather than a `package.json` script, because each CI batch fixes its own mode, database, and shard. No command's presence authorizes local execution.

## Test projects

The root `vitest.config.ts` declares two application projects:

| Project   | Selection                                                   | Setup                        |
| --------- | ----------------------------------------------------------- | ---------------------------- |
| `app`     | `apps/web/src/**` and `scripts/**`, excluding integration   | `apps/web/src/test/setup.ts` |
| `app-int` | `apps/web/src/**` and `scripts/**` `*.int.test.ts` files    | `apps/web/src/test/setup.ts` |

The root `pnpm test` script remains the developer-facing composition of the `app` project followed by every workspace package's own `test` script. CI does not execute that compound command as one serial job: it runs the `app` project in two Vitest shards and runs package-owned suites in a separate job. Every package owns its `vitest.config.ts`; adding a package does not add a root Vitest project or a root script entry.

`apps/web` has no `test` script. Its tests already belong to the root `app` and `app-int` projects, and a recursive app script would collect them twice or run them from the wrong directory. The root directory matters because repository tripwires locate source through `process.cwd()`, and `scripts/**` tests share the application alias and setup.

Application setup forces `AI_FAKE=1` and removes live provider credentials. Package configurations have no application setup and no `@/` alias; package tests resolve workspace dependencies through installed workspace links.

The integration commands have different selections:

| Command                                      | Selection                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm test:int`                              | Whole `app-int` project in the `all` view; probes may self-skip outside CI     |
| `pnpm test:int:strict`                       | Whole `app-int` project; an unreachable or unmigrated database fails           |
| `node scripts/ci-integration.mjs --mode=...` | One authorization mode and shard on its own database; the CI executor          |
| `pnpm census:integration`                    | The policy census: discovered suites, strict/legacy partition, problems        |
| `pnpm test:engine`                           | Curated engine, image, and authoring paths in `app-int`; not a CI selection    |
| `pnpm test:engine-e*`                        | Focused engine proof paths used for targeted gate work                         |

The `all` view holds legacy-fixture suites, which need the legacy capability, and strict suites, whose authorization-denial claims need it absent, in one process, so no single `all` process can pass both. The two launcher modes are the complete run; [Integration modes](#integration-modes) owns the split.

## Test layers

Place a claim at the lowest layer that owns it. Higher layers verify only their seam to that owner.

| Layer                | Primary ownership                                                                   | IO                         |
| -------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| Contracts            | Registries, schemas, precedence, parsing, state transformations                     | None                       |
| Library              | General parsing, clocks, client envelopes, stream parsing, presentation             | None                       |
| Simulation package   | Pure simulation contracts, kernels, replay, deterministic identities                | None                       |
| Engine unit          | Prompt structure, extraction, pure engine decisions, bounded control flow           | Fake rows and fake AI      |
| Server unit          | API primitives, authoring, images, memory rules                                     | Fake rows or mocked IO     |
| Route unit           | Pure route decisions, mirror parity, wrapper selection                              | None                       |
| Components           | Extracted UI logic                                                                  | None; no DOM rendering     |
| Repository tripwires | Source topology, workspace registration, static policy facts                        | Filesystem reads           |
| Store integration    | Persistence, transactions, idempotency, concurrency, replay, database constraints   | Postgres                   |
| Route integration    | Authorization across stored rows, validation, envelopes, route-to-store wiring      | Postgres with mocked auth  |

Pure simulation rules belong in `packages/simulation-core`. Application parity checks remain under `apps/web` when the claim compares package output with application client schemas. A real integration test is justified by a database property or a genuine route/database seam, not by the location of the production function.

## Shared test utilities

Shared helpers follow the purity and workspace boundaries:

- `apps/web/src/test/`, imported through `@/test/...`, contains pure registry invariants and diagnostic assertions usable by contracts and library tests.
- `apps/web/src/server/test-support/`, imported through its `@/server/test-support` barrel, contains server-side auth bindings, request and response helpers, database fixtures and cleanup, simulation harnesses, prompt assertions, temporary data roots, image fixtures, and source scanners. Production code must not import this barrel because it includes Vitest dependencies.
- `packages/simulation-core/src/test-support/` contains simulation command, event, space, material, and meter fixtures. Package tests import them relatively. App consumers use declared package testing subpaths rather than filesystem escapes.
- Garment blueprint fixtures live beside their contracts in `apps/web/src/contracts/items/garment-test-fixtures.ts`.

Search these homes and the nearest existing suite before creating setup. Extend a shared helper when several tests share the behavior; keep one-off setup beside its test.

## Test laws

- Test a meaningful invariant, regression, external contract, or failure mode. Code existence alone creates no test obligation, and no new test is a valid result.
- Apply the `vesper-testing` admission rubric to bug fixes. When a new regression assertion is warranted, use the smallest assertion that fails for the observed bug; existing owning coverage may already catch it.
- Degradation tests assert the fallback and the diagnostic code, using `@/test/diagnostics` where the purity boundary permits it ([resilience.md](resilience.md)).
- Derive registry expectations from the registry or schema. Do not maintain a second hand-written member list.
- Prompt tests use structural assertions such as ordering, numbered-rule, and fenced-content helpers instead of large snapshots or incidental nonce and ordinal values.
- Application tests use the configured fake AI provider. They do not mock LLM calls at the fetch layer or restore deleted provider credentials.
- Embedding-dependent tests use the deterministic `pseudoEmbed` implementation.
- Reuse fixtures instead of copying setup; jscpd includes test files.
- Preserve literal assertions only where the literal is the contract, including persisted hashes, wire formats, migration compatibility, and security allowlists.
- Symlink-containment tests may self-skip only when the local platform cannot create their fixture. `CI=true` makes fixture failure fatal so a security gate cannot disappear from CI.

## Integration modes

`scripts/integration-policy.mjs` owns the application integration inventory; the root Vitest configuration, the CI launcher, and the evidence verifier all read it.

- The universe is every tracked `*.int.test.ts` under `apps/web/src/` or `scripts/`. It is discovered, never listed: a new ordinary suite joins the gate by existing. Package-owned tests keep their own configurations and are outside it.
- An integration-looking file the universe cannot collect, such as a `.int.test.tsx`, a `.int.spec.ts`, or an `.int.test.ts` outside both roots and outside `packages/`, is a census problem.
- The policy's legacy exceptions name exact files, each with a reason. The STRICT mode runs every other suite; the LEGACY mode runs exactly the exceptions. There is no directory or pattern admission, and a stale, duplicate, pattern, or non-integration entry is a census problem.
- `VESPER_INTEGRATION_MODE` is `strict`, `legacy`, or unset (`all`). The `app-int` project applies it inside its own `include`/`exclude`, because Vitest does not pass a command-line include or exclude down to a project. An unknown value fails configuration loading.
- A suite is a legacy exception only when an expected outcome needs a `player` principal whose id names no account to pass `authorizeSimulationCommand` on a branch no chat anchors, whether the outcome is an acceptance or a domain-level rejection. Such a suite passes `legacyPlayerMode: true` to `simulationSuiteHarness`, whose default is `false`; that option fails the file at collection unless the capability is on. `scripts/integration-policy.test.ts` requires the exception list and those declarations to agree.
- A suite that asserts an authorization denial is strict. `command-authz.int.test.ts` proves an account-less player is refused on an unanchored branch with the capability absent; `command-authz-legacy.int.test.ts` proves the capability admits only that combination and never a real account or an anchored branch.

Every `app-int` worker runs `apps/web/src/server/test-support/integration-worker-setup.ts` after the application setup and before the suite is imported. In the `strict` and `legacy` modes it requires strict database probes and the fake providers. A strict worker must not carry `VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER` in any form. A legacy worker must carry it under `NODE_ENV=test` and may import only a listed exception. A contradiction fails that file's collection. Every test in those modes records the worker's attestation in its task metadata under `vesperIntegration`, where the evidence verifier reads it back out of the JSON report.

Every application integration suite uses `probeIntegrationDb` from `@/server/test-support`, directly or through `simulationSuiteHarness`. In ordinary non-CI execution the probe can self-skip when the database is absent. Strict signals (`REQUIRE_INTEGRATION_DB=true`, `VESPER_REQUIRE_TEST_DB=1`, or `CI=true`) make absence or migration failure fatal.

Integration files run without file parallelism because the files in one process share one database. CI parallelism happens one level higher, on separate runners and separate databases. Image-row fixtures normally use `canonicalImageRow`, which derives a path satisfying the `images_path_canonical` database constraint. Tests of the constraint itself may deliberately construct invalid rows.

## The verification gate

GitHub Actions runs `.github/workflows/ci.yml` on GitHub-hosted `ubuntu-latest` runners. Draft pull requests run no jobs. Ready pull requests run jobs selected from changed paths; a manual dispatch and every pull request into `prod` force all release-candidate gates. Workflow-file changes also force the Gate 1 benchmark, production-build, and Docker packaging gates so CI changes exercise the jobs they modify.

| Job                      | Current command and claim                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| Documentation checks     | `node scripts/check-docs.mjs`; links, section citations, retired references                  |
| Lint                     | `pnpm lint`; type-aware ESLint                                                               |
| Static checks            | Cycles, route auth, package boundaries/resolution, typecheck, jscpd                          |
| App unit tests           | Two `vitest --project=app --shard=…` jobs                                                    |
| Workspace package tests  | Package-owned pure suites with bounded workspace concurrency                                 |
| Integration              | Two runners, each running its strict and legacy shard through `scripts/ci-integration.mjs`   |
| Production build         | Next production build with the Fly builder's heap ceiling and persisted `.next/cache`        |
| Docker packaging build   | Production Docker image build when packaging inputs move and for release-candidate runs      |

Documentation-only changes run the documentation job. Every ready code change, meaning any change with a path that is not documentation, runs lint, static checks, both application-unit shards, package tests, and the complete integration gate. No feature area, test-only, script-only, or CI-policy-only change can suppress integration. Changed-path rules decide only the Gate 1 benchmark, the production build, and Docker packaging. `scripts/ci-classify.mjs` owns those rules and has table-driven tests.

A path is documentation when it ends in `.md`, is an issue or pull-request template, or sits under `docs/` with a documentation extension (`.md`, `.mdx`, `.txt`, `.yaml`, `.yml`, or an image) and no `.test.` or `.spec.` in its name. A test or executable file does not become documentation by moving under `docs/`. The safe-follow-up detector imports the same predicate. Deleted and renamed paths are classified on both sides, because the changed-path list is collected without rename detection.

Ordinary application and workspace-source changes now select the production build. This is intentional: the build has been cheaper than the slowest test gates in recent Actions runs, so running it concurrently broadens verification without normally extending the critical path. Docker validation remains narrower because it is intended to prove packaging inputs, not every application edit.

A documentation-only follow-up may reuse the preceding revision's green code-gate basis only when `scripts/ci-safe-followup.mjs` proves the update is ancestor-preserving, documentation-only, against the same base, and follows a successful `verify` result. The new revision still earns its own documentation result and aggregate check.

The aggregate `verify` job requires every applicable job to succeed and requires inapplicable jobs to be skipped or successful. A matrix job is successful only when every shard is successful, so one failed/cancelled unit or integration shard cannot hide behind another green shard.

### Authorization verification

The changed-route authorization guard receives the actual PR base SHA from CI rather than assuming `origin/main`, which keeps promotion PR comparisons correct. Manual full-verification runs and `prod`-bound promotion PRs also execute `scripts/check-route-authz-all.ts`, which scans every resource-ID route recognized by the guard and fails if any route lacks recognized authorization evidence.

The full inventory is intentionally release-gated because it checks repository-wide state rather than only the current diff. It reports how many resource-ID routes it examined and fails when that count is zero: an API tree or `RESOURCE_ROUTE` change that empties the inventory is a broken gate, so it turns the release check red instead of passing a vacuous scan as evidence.

### What a green integration gate proves

The integration matrix has two runners. Each starts one disposable Postgres service and runs its shard of the strict mode, then its shard of the legacy mode, as separate Vitest processes through `scripts/ci-integration.mjs`. Each batch:

- reconciles `git ls-files` against the policy and fails on any census problem;
- drops, creates, and migrates from zero its own `vesper_ci_strict` or `vesper_ci_legacy` database on the local service, and refuses a non-local host;
- asks Vitest for the discovered universe and for its mode's inventory and shard, through Vitest's own file listing and configured sequencer, and fails when either disagrees with the census;
- runs `pnpm exec vitest run --project=app-int --no-file-parallelism --shard=<i>/<n>` from an argument array with the console and JSON reporters. A strict child never carries the legacy capability; a legacy child always does;
- records a planned-empty shard as no-work without invoking Vitest; and
- writes `integration-evidence/<mode>/envelope.json` beside the JSON report, uploaded as `integration-evidence-shard-<i>-of-<n>-attempt-<k>`.

The legacy batch runs even when the strict batch fails, so one run reports both, and either failure fails the job. The Gate 1 benchmark runs once, on shard 1, against its own migrated `vesper_ci_benchmark` database without the legacy capability.

Whenever integration applies, `verify` runs `scripts/verify-integration-results.mjs` before its job-status check, and it fails `verify` unless:

- the census it recomputes from its own checkout has no problem, and every batch discovered exactly that universe;
- each mode and shard has exactly one batch from the job attempt the GitHub API reports as that shard's latest execution, so an earlier attempt's success never covers a rerun;
- every batch tested this run's checkout and pull-request head and base, under this policy hash, with its own database, recorded environment, and the launcher's exact argument array;
- the planned shards partition each mode's inventory, and the two modes partition the universe;
- the executed files, counted before any merge, equal the planned files with multiplicity one, and no pure `app` file appears;
- every executed file passed with at least one passed case and no failed, skipped, or todo case, and every case carries the attestation for its mode; and
- every planned-empty shard recorded no-work.

A green `verify` on a code change therefore means every tracked application integration suite executed exactly once, in its mode, and passed. The gate has no exception mechanism for skipped or todo cases. The `verify` job summary lists each batch's planned and executed files, case counts, durations, and evidence artifact. A completion report cites that run at the tested head, not a file's membership in the inventory.
