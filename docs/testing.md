# Testing

Vesper uses Vitest 4 with one root-owned application configuration and package-owned workspace configurations. CI is the application validation surface; local application gates are disabled by project policy.

## Ownership

This page owns test-project wiring, layer boundaries, shared utility locations, integration contracts, and what each CI job selects. The `vesper-testing` skill owns whether a test should be added and which layer should carry a claim. Live UI and API verification belongs to the `verify` skill.

## Execution policy

Do not run application tests or gates on the development machine. The prohibition includes `pnpm test`, every `pnpm test:*` script, direct or package-filtered Vitest, watch mode, application lint, typecheck, build, Docker-backed integration setup, and local substitutes for CI jobs.

Code changes are validated by the applicable jobs in `.github/workflows/ci.yml`. A documentation-only change may run `pnpm lint:docs` locally because `scripts/check-docs.mjs` uses Node built-ins and starts no application service. A skill-owned shell or Python helper may use dependency-free offline fixture tests when those fixtures start neither Vesper nor a database nor an external service.

Command definitions in `package.json` describe CI composition and suite ownership. Their presence does not authorize local execution.

## Test projects

The root `vitest.config.ts` declares two application projects:

| Project   | Selection                                                   | Setup                        |
| --------- | ----------------------------------------------------------- | ---------------------------- |
| `app`     | `apps/web/src/**` and `scripts/**`, excluding integration   | `apps/web/src/test/setup.ts` |
| `app-int` | `apps/web/src/**` and `scripts/**` `*.int.test.ts` files    | `apps/web/src/test/setup.ts` |

The root `pnpm test` script, used by CI's `unit tests` job, runs the `app` project and then invokes each workspace package's own `test` script serially. Every package owns its `vitest.config.ts`; adding a package does not add a root Vitest project or a root script entry.

`apps/web` has no `test` script. Its tests already belong to the root `app` and `app-int` projects, and a recursive app script would collect them twice or run them from the wrong directory. The root directory matters because repository tripwires locate source through `process.cwd()`, and `scripts/**` tests share the application alias and setup.

Application setup forces `AI_FAKE=1` and removes live provider credentials. Package configurations have no application setup and no `@/` alias; package tests resolve workspace dependencies through installed workspace links.

The root integration scripts have different selections:

| Script                 | Selection                                                                 |
| ---------------------- | ------------------------------------------------------------------------- |
| `pnpm test:int`        | Entire `app-int` project; database probes may self-skip outside strict CI |
| `pnpm test:int:strict` | Entire `app-int` project with unreachable or unmigrated DB as failure     |
| `pnpm test:engine`     | Explicit curated integration paths listed in `package.json`               |
| `pnpm test:engine-e*`  | Focused engine proof paths used for targeted gate work                    |

No current CI job selects `pnpm test:int` or `pnpm test:int:strict`. The workflow's database job selects `pnpm test:engine`; the CI section below states the resulting coverage boundary.

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

## Strict integration mode

Every application integration suite uses `probeIntegrationDb` from `@/server/test-support`, directly or through `simulationSuiteHarness`. In ordinary non-CI execution the probe can self-skip when the database is absent. Strict signals (`REQUIRE_INTEGRATION_DB=true`, `VESPER_REQUIRE_TEST_DB=1`, or `CI=true`) make absence or migration failure fatal.

Suites that submit the legacy synthetic `player` principal against directly seeded simulation branches call `requireLegacyUnanchoredEngineTestMode`. CI's engine job exports `VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER=1` for the curated engine run. Authorization-denial suites leave that capability disabled.

Integration files run without file parallelism because they share a database. Image-row fixtures normally use `canonicalImageRow`, which derives a path satisfying the `images_path_canonical` database constraint. Tests of the constraint itself may deliberately construct invalid rows.

## The verification gate

GitHub Actions runs `.github/workflows/ci.yml` on AWS CodeBuild managed runners. Draft pull requests run no jobs. Ready pull requests run jobs selected from changed paths; a manual dispatch on `main` and every pull request into `prod` force the integration and production-build gates.

| Job                  | Current command and claim                                                           |
| -------------------- | ----------------------------------------------------------------------------------- |
| Documentation checks | `node scripts/check-docs.mjs`; links, section citations, retired references         |
| Lint                 | `pnpm lint`; type-aware ESLint                                                      |
| Static checks        | Cycles, route auth, package boundaries/resolution, typecheck, jscpd                 |
| Unit tests           | `pnpm test`; root `app` plus every package-owned pure suite                         |
| Engine integration   | Postgres, migrations, curated `pnpm test:engine`; Gate 1 only when `engine == true` |
| Production build     | Next production build with the Fly builder's heap ceiling                           |

Documentation-only changes run the documentation job. Ready code changes run lint, static checks, and unit tests; changed-path rules decide whether the engine integration and production build jobs apply. A documentation-only follow-up may reuse the preceding revision's green code-gate basis only when `scripts/ci-safe-followup.mjs` proves the update is ancestor-preserving, documentation-only, against the same base, and follows a successful `verify` result. The new revision still earns its own documentation result and aggregate check.

The aggregate `verify` job requires every applicable job to succeed and requires inapplicable jobs to be skipped or successful. It prevents an applicable cancelled or skipped job from appearing green. It does not claim that inapplicable jobs or unselected test files ran.

### What a green integration job proves

The `engine integration` job starts Postgres, migrates from zero, and runs the exact `pnpm test:engine` path list in `package.json`. That list includes the successor simulation-store directory and named successor narrator, admin, image, identity-pack, and route suites. `CI=true` makes their database probes strict.

The job does not run the entire `app-int` project. In particular, `apps/web/src/app/api/gallery.int.test.ts` and `apps/web/src/server/api/authz-matrix.int.test.ts` are not selected. Many legacy-chat, route, memory, retention, quota, and other integration suites are also outside the curated command. A green `engine integration` job leaves every unselected suite unverified.

Completion reports map each target test file to the script and CI job that selected it. When a relevant integration suite is outside `test:engine`, the report states that it did not run, even if aggregate `verify` is green. `package.json` is the exact source of the curated selection; inferred family names are not evidence that a file ran.
