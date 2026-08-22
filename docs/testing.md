# Testing

Vitest 4, split by ownership. The root config (`vitest.config.ts`) declares the two **application** projects and nothing else; every workspace package owns its own `vitest.config.ts` and its own `test` script.

| Project   | Covers                                                      | Setup                        |
| --------- | ----------------------------------------------------------- | ---------------------------- |
| `app`     | `apps/web/src/**` + `scripts/**`, minus `*.int.test.ts`     | `apps/web/src/test/setup.ts` |
| `app-int` | `apps/web/src/**` + `scripts/**` `*.int.test.ts` (needs DB) | `apps/web/src/test/setup.ts` |

`pnpm test` runs the `app` project and then `pnpm -r --workspace-concurrency=1 run test`, which walks the workspace and runs each package's suite from that package's own directory, one at a time. A package joins the run by owning a `test` script — no root script names it, and none has to be edited to add one.

`apps/web/src/test/setup.ts` forces demo mode for the two application projects: it sets `AI_FAKE=1` and deletes `OPENROUTER_API_KEY` / `REPLICATE_API_TOKEN`, so no application test can hit a real provider. Package configs declare **no** setup file and **no** `@/` alias — a package test must prove something about the package, not about Vesper's configuration, and its workspace dependencies resolve through the installed workspace link rather than an alias pointing at source (`monorepo-image-core.spec.guardrails.md`).

The application suite is the one exception to package-owned configs, and two repository-level properties force it. **The runner's working directory must be the repository root**: several tripwire tests locate source with `process.cwd()` plus a repo-relative path such as `apps/web/src/app/api`, so a config rooted at `apps/web` would resolve them one directory too deep. And the suite spans two workspaces — `scripts/**` tests run in the `app` project on purpose, because they scan application source and import `@/server/test-support`, so they need the application alias and the same demo-mode setup as the code they inspect. `apps/web` therefore defines a `typecheck` script but **no** `test` script; a workspace without one is skipped by the recursive run, which is what keeps the application suite from being collected twice.

Among those tripwires, `scripts/workspace-registration.test.ts` guards the two workspace registration points nothing can discover on its own: the Dockerfile's manifest COPY lines and `next.config.ts`'s `transpilePackages`. Both fail late — in a Fly build or a production build — and neither names its cause.

`pnpm test` runs everything that needs no network; DB-backed suites need the dev Postgres up.

## Layers

Each layer names its file glob, what it covers, and the IO it needs.

- **contracts** (`apps/web/src/contracts/**/*.test.ts`) — registry invariants (unique ids, valid
  enums, alias fan-out — one alias may resolve to several attributes), parse/resolve
  round-trips, attribute precedence, condition logic, wardrobe visibility, chat
  scene-memory merge/switch (caps, dedupe oldest-out, current-place protection, degraded
  parse). No IO.
- **lib** (`apps/web/src/lib/**/*.test.ts`) — parseOr/parseOrNull, game-clock math, client API error
  envelope, chat SSE-stream parsing, **speaker segmenter edge cases** (`segmenter.ts` —
  dialogue tags + the chat lane's standalone-quote attribution), and the story-clock and
  world-beat presentation the successor lane renders through. No IO.
- **simulation-core** (`packages/simulation-core/src/**/*.test.ts`, the package's own project) —
  the successor's pure contracts and kernels (space, activities, commitments, engagements,
  perception, knowledge, bodies, LOD, …), plus the `node:crypto` equivalence pins on the two
  persisted sha256 identities. Runs with **no `@/` alias and no demo-mode setup**, so a test
  here proves something about the simulation rather than about Vesper's configuration. No IO.
  Two app-parity tests deliberately stay on the app side instead
  (`apps/web/src/lib/simulation/world-read.test.ts` and `world-beat.test.ts`): they check the
  package's output against the client API schemas in `@/lib/client/api`, which is an
  application fact.
- **engine unit** (`apps/web/src/server/engine/**/*.test.ts`) — demo-mode generators, chat prompt
  builders (structural assertions, not snapshots of full text), the chat extraction field
  library, chat one-turn reads (`chat-intent.ts` — scene movement, sense-targeted focus,
  reply-discipline gates: hook cadence + intimate check-in), the reply-stream watchdog
  (`withStreamTimeouts` — first-token/overall trip aborts + passes tokens through) and the
  bounded lock-wait (`acquireKeyedLockWithin` — acquires/waits/times-out, re-issuing its
  stop) behind the atomic rerun. No IO (fake rows).
- **memory unit** (`apps/web/src/server/memory/**/*.test.ts`) — supersedence gating, fact lifecycle,
  fused retrieval merge/dedup, witness-eligibility filtering. IO: mocked embeddings
  (deterministic vectors).
- **server unit** (`apps/web/src/server/{api,authoring,images}/**/*.test.ts`) — rate limiting, error
  envelopes (`respond.ts` — including the request-size guards), body schemas, the paced SSE text
  reveal (`stream.ts`); character-forge grounding (attributes, traits, outfits, drives,
  social cards) plus demo-mode forge runs; image prompt builders, monogram SVG, atomic webp
  writes. No IO.
- **api unit** (`apps/web/src/app/api/**/*.test.ts`) — the pure decisions that live in route
  folders: chat-permission override direction, the sim-routing decision (every POST kind on a
  sim-routed chat maps to a successor mode or a refusal), and the `/self/` admin mirror parity
  tripwires (every canonical route has a twin, and every handler is gated by an owner-admin
  wrapper rather than a bare `withUser`). No IO.
- **components** (`apps/web/src/components/**/*.test.ts`) — pure logic extracted from components
  (draft merge/seed, attribute editor helpers, inline markup, message-markup span display +
  `commsLine` texted-line detection, chat reply segment→label mapping, focus-trap
  targeting, monogram initials) — no DOM rendering. No IO.
- **fixtures** (`scripts/fixtures/harbor-house.test.ts`) — the seed fixture validates
  against the contracts registries, so a vocabulary change that breaks the seed fails in
  tests, not at seed time. No IO.
- **db integration** (`apps/web/src/**/*.int.test.ts` — engine, memory, images) — the **successor
  simulation engine** (`server/engine/simulation/*.int.test.ts` — branch/command/event
  durability, idempotency, typed holdings, injected-crash atomicity, the scheduler, and the
  gate corpora E2–E6), the chat lane (`chat-*.int.test.ts` — extraction legs, wardrobe,
  state fidelity, memory-failure), the successor narrator (`sim-narrator.int.test.ts`), plus
  memory vector queries and image asset lifecycle. IO: a `DATABASE_URL` database — suites
  probe at collection and self-skip with a stderr warning if unreachable, which keeps
  day-to-day runs usable; the `engine` gate target refuses to start without the dev Postgres
  and runs strict, so an unavailable or unmigrated database fails the gate instead of
  disappearing from it.
- **api** (`apps/web/src/app/api/**/*.int.test.ts`) — route handlers called directly with mocked auth
  (`vi.mock` of `server/auth`): validation, envelopes, the chat SSE event sequence in demo
  mode, the atomic chat **rerun** (stop→wait→acquire→transact: snips successors + reuses the
  guard row; stops an in-flight reply then succeeds; byte-identical transcript + 409 when the
  lock can't be re-acquired; 4xx on a non-user/missing/foreign target; snapshot rollback vs.
  the degraded `chat_state.rerun.no_rollback`), and the successor `/api/chats` sim routes.
  IO: demo mode, `DATABASE_URL` database.

## Shared test utilities

Three homes, split by the purity fence (`eslint.config.mjs` bans `@/server/**`
imports from contracts/lib, tests included) and by the workspace boundary:

- **`apps/web/src/server/test-support/`** (import via the `@/server/test-support`
  barrel — lint-enforced) — for server-side suites. Auth mock
  (`routeAuthModule`/`bindAuthUser`/`withAuthUser` — restore-safe role swaps),
  request builders (`apiRequest`/`routeCtx`), response assertions
  (`expectJson`/`expectApiError`/`drainStream`), DB fixtures
  (`seedTestUser`/`purgeOwnerRows`/`endTestPool` — ends AND clears the shared
  pool), the simulation suite scaffold (`simulationSuiteHarness`, `simCommand` +
  principals, `seedSimBranch`/`seedSimpleBranch`, `readBranchEvents`/`forkAtHead`,
  `expectAccepted`/`expectRejected`, schema-derived `branchFootprint` — a new
  `sim_*` table is footprint-covered automatically), chat-lane fixtures
  (`seedChatFixture`/`newChat`/`settleChatExchange`, `chatMemoryMockModule`),
  routed-sim-chat fixtures (fixed rollout world — those suites must not run
  file-parallel), profile/prompt fixtures + prompt assertions
  (`expectOrder`/`expectNumberedRule`/`expectFenced` — assert content, not
  ordinals or nonce literals), image/tmp-dir/memory/png fixtures, authoring/ai
  fixtures, and `source-scan` (the guardrail's scanner primitives, shared with
  `scripts/image-internal-callers.test.ts`).
  **No production code may import this barrel** — several modules import vitest.
  The one production consumer (the authorization seam's legacy-mode read) lives
  in the engine (`simulation/legacy-test-mode.ts`) and is re-exported here.
- **`apps/web/src/test/`** (import via `@/test/...`) — pure helpers importable from
  contracts/lib tests: registry invariants (`expectUniqueIds`,
  `expectAllValidate`, `expectRefsResolve`, `expectCaseInsensitiveLookup`,
  `expectContiguousBands`) and diagnostics assertions
  (`codes`/`expectDiagnostics`/`expectDiagnostic`/`expectCleanSink`). These
  modules import only contracts/lib/vitest/zod — never `@/server`.
- **`packages/simulation-core/src/test-support/`** — the simulation fixtures, which
  live beside the kernels they build inputs for: command/event envelope builders
  (`commandEnvelope`/`eventEnvelope`/`bindSimEnvelopes`/`testPrincipal`) and the
  space/material/meter fixtures. Package tests import them relatively. The two an
  application suite also needs are published as exact subpaths —
  `@vesper/simulation-core/testing/sim-envelopes` and `…/testing/sim-space-fixtures`
  — so a shared fixture crosses the workspace boundary as declared public API rather
  than by filesystem path.
- Garment blueprint fixtures are colocated at
  `apps/web/src/contracts/items/garment-test-fixtures.ts` (contracts-only imports).

Prefer deriving expectations from the registry/schema under test over
hand-enumerating entries (the pattern in `attributes/registry.test.ts` and
`scripts/fixtures/harbor-house.test.ts`): a vocabulary addition should never
force test edits, while broken production logic and crossed policy tripwires
(which stay literal, commented) still fail.

## Rules

- LLM calls are **never** mocked at the fetch layer — `server/ai` exposes a fake provider (`AI_FAKE=1` / demo mode, forced globally by `apps/web/src/test/setup.ts` — don't re-set it per file) returning canned typed results; tests exercise real parsing/degradation paths.
- Degradation tests assert the fallback **and** the diagnostic code ([resilience.md](resilience.md) §8) — via `@/test/diagnostics` so the idiom stays uniform.
- Every bug fix lands with the regression test that would have caught it.
- `pnpm jscpd` covers test files too (threshold 3; they were excluded until
  2026-07-28, which is how ~3.2k duplicated test lines accumulated) — reuse the
  shared utilities instead of copy-pasting scaffolding.
- Embedding-dependent logic tests use `pseudoEmbed` (deterministic, from `server/ai/embeddings`) so similarity thresholds are exact.
- The symlink-escape containment cases (`server/images/paths.test.ts`, `server/images/assets.test.ts`) gate on `canCreateSymlinks()` (`@/server/test-support`), which probes once by planting a symlink in a temp dir: on Windows without Developer Mode or elevation `fs.symlink` fails with EPERM, so those cases self-skip with a stderr note rather than failing on fixture setup. `CI=true` is honored as a strict signal: with it set, a failed probe **throws** instead — the escape tests are a security gate and must never silently vanish from a run that claims to have verified them. The containment logic itself is never weakened by the skip.

## The verification gate

The gate is CI: GitHub Actions on AWS CodeBuild managed runners
(`.github/workflows/ci.yml`). The aggregate `verify` status check is required on
`main` and `prod`, so a PR merges only when it is green. Draft PRs run no jobs;
mark a PR ready to run the applicable gates, and `gh workflow run CI --ref main`
is the deliberate full pre-deploy run (engine and build included).

| Job                | Runs                                                          |
| ------------------ | ------------------------------------------------------------- |
| lint               | type-aware ESLint at `--max-warnings 0`                       |
| static checks      | cycles, authz, package boundaries/resolution, typecheck, jscpd |
| unit tests         | the pure Vitest suite (no database)                           |
| engine integration | `pnpm test:engine` (strict) + the Gate 1 benchmark            |
| production build   | the Next production build, heap-pinned to 4096 MB             |

The **engine job** exports `VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER=1` and
`REQUIRE_INTEGRATION_DB=true`, so an unreachable or unmigrated database fails
the suites rather than letting them self-skip — a gate must never report green
for a suite it never ran. The **build job** pins the heap to 4096 MB to match
the Dockerfile's build stage, so a build that would exhaust the Fly builder
fails in CI instead of during a deploy ([deployment.md](deployment.md)).

There are no local git hooks and no local gate: commits and pushes run nothing,
and the retired `scripts/verify.sh` wrapper is not part of the workflow. Run an
individual command (`pnpm test`, `pnpm lint`, `pnpm typecheck`) to answer a
focused question while developing; the run that counts is CI's.

## Commands

```
pnpm test               # the app project + every package's own suite: everything that needs no DB
pnpm test:watch         # the app project in watch mode (a package watches through
                        #   `pnpm --filter @vesper/image-core exec vitest`)
pnpm test:int           # the app-int project: DB suites only (file parallelism off — they share one DB)
pnpm test:int:strict    # the SAME run as a release gate: REQUIRE_INTEGRATION_DB=true, so an unreachable
                        #   or unmigrated database FAILS the converted suites instead of skipping them
pnpm test:engine        # the successor engine's authority + narrator + sim-route int suites
pnpm test:engine-e2-5   # focused successor branch transaction + crash/concurrency proof (gate-specific
                        #   scripts run e2-4 … e6-5; run `pnpm db:migrate` first; a bare run self-skips if
                        #   the database is unreachable, the `engine` gate target fails)
pnpm typecheck
pnpm lint
```

The `test:engine*` scripts pass file paths, which Vitest applies as filters
across the root config's projects — so they keep working without naming one.
That only holds for paths under `apps/web/src`: a package's tests belong to the
package's own Vitest project, which the root config cannot see. So each
per-gate `test:engine-eN-M` script runs its pure half through the package
(`pnpm --filter @vesper/simulation-core exec vitest run …`) and then its
database half through the root config, joined by `&&`.

## Strict integration mode (the release form)

Every `.int.test.ts` suite probes the database at collection and **self-skips** when it is unreachable or unmigrated — right for ordinary dev, wrong for a claimed release gate, where a broken database would silently skip (for instance) the entire authorization matrix and still report green.

`pnpm test:int:strict` is the same run with `REQUIRE_INTEGRATION_DB=true`: the shared probe **throws** instead of returning "skip", so the suite fails loudly and names what was unreachable. Use it before a deploy, or any time a green run is meant to mean something; plain `pnpm test:int` stays skip-tolerant for day-to-day work. The `engine` gate target sets the same flag around its `pnpm test:engine` run, which is why that gate cannot report a suite it never executed. (`CI=true` and `VESPER_REQUIRE_TEST_DB=1` are honored as strict signals too — they predate the flag.)

### Running the whole integration suite locally

`pnpm test:int` needs **`VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER=1`**:

```
VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER=1 pnpm test:int
```

The low-level engine suites seed bare branches and submit the shared synthetic
player fixture, which the simulation authorization seam refuses without this
opt-in (deliberately — authorization tests leave it unset and keep proving that
ordinary unanchored players fail). The `engine` gate target exports it for its
`pnpm test:engine` run.

A flagless run **fails fast at collection** instead of drowning you in denials:
each player-principal suite calls `requireLegacyUnanchoredEngineTestMode(suite)`
(`@/server/test-support`) right after its DB probe succeeds, and the guard
throws a message naming the flag and this section — without it a flagless
`pnpm test:int` reports ~120 opaque "expected accepted, got rejected" domain
failures. An unreachable database still self-skips (the guard only
fires when the suite would otherwise run), and `command-authz.int.test` never
calls it, so denial coverage stays independent of the flag. A suite that
submits `kind: "player"` commands against directly-seeded branches must call
this guard; suites using only `npc_policy`/`system` principals (material,
scheduler, time-job stores) don't need it.

Note also that the `engine` gate target runs `test:engine`'s curated glob rather
than the whole suite, so the route-level suites (`gallery`, `chat`,
`library-routes`, `authz-matrix`, `public-dto`, `variants`) are covered by **no**
gate — run `pnpm test:int` yourself to exercise them. See `rate-limits.plan.md`
OQ3.

Fixtures inserting `images` rows must go through **`canonicalImageRow`**
(`@/server/test-support`): the `images_path_canonical` CHECK requires the stored
path to be exactly `images/<owner_id>/<id>.webp`, and the helper derives the id
and the path together so a suite cannot pick one without the other.

The probe lives in one place, `apps/web/src/server/test-support/int-db.ts` (`probeIntegrationDb(suite, table)`), imported through the `@/server/test-support` barrel (the simulation suites get it via `simulationSuiteHarness`). **Every `.int.test.ts` suite uses it as of 2026-07-28** — the last 51 inline copies were converted, so strict mode genuinely gates the whole integration surface. A new suite must use the helper (or the harness) from day one; an inline probe silently opts the suite out of the release gate.
