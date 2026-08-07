# Testing

Vitest 4, one root config (`vitest.config.ts`) including `src/**/*.test.ts` and `scripts/**/*.test.ts`. The global setup file `src/test/setup.ts` forces demo mode for every test: it sets `AI_FAKE=1` and deletes `OPENROUTER_API_KEY` / `REPLICATE_API_TOKEN`, so no test can hit a real provider. `pnpm test` runs everything that needs no network; DB-backed suites need the dev Postgres up.

## Layers

Each layer names its file glob, what it covers, and the IO it needs.

- **contracts** (`src/contracts/**/*.test.ts`) — registry invariants (unique ids, valid
  enums, alias fan-out — one alias may resolve to several attributes), parse/resolve
  round-trips, attribute precedence, condition logic, wardrobe visibility, chat
  scene-memory merge/switch (caps, dedupe oldest-out, current-place protection, degraded
  parse). No IO.
- **lib** (`src/lib/**/*.test.ts`) — parseOr/parseOrNull, game-clock math, client API error
  envelope, chat SSE-stream parsing, **speaker segmenter edge cases** (`segmenter.ts` —
  dialogue tags + the chat lane's standalone-quote attribution), the successor
  `lib/simulation/*` pure rules (space, activities, commitments, engagements, perception,
  knowledge, bodies, LOD, …). No IO.
- **engine unit** (`src/server/engine/**/*.test.ts`) — demo-mode generators, chat prompt
  builders (structural assertions, not snapshots of full text), the chat extraction field
  library, chat one-turn reads (`chat-intent.ts` — scene movement, sense-targeted focus,
  reply-discipline gates: hook cadence + intimate check-in), the reply-stream watchdog
  (`withStreamTimeouts` — first-token/overall trip aborts + passes tokens through) and the
  bounded lock-wait (`acquireKeyedLockWithin` — acquires/waits/times-out, re-issuing its
  stop) behind the atomic rerun. No IO (fake rows).
- **memory unit** (`src/server/memory/**/*.test.ts`) — supersedence gating, fact lifecycle,
  fused retrieval merge/dedup, witness-eligibility filtering. IO: mocked embeddings
  (deterministic vectors).
- **server unit** (`src/server/{api,authoring,images}/**/*.test.ts`) — rate limiting, error
  envelopes, body schemas; character-forge grounding (attributes, traits, outfits, drives,
  social cards) plus demo-mode forge runs; image prompt builders, monogram SVG, atomic webp
  writes. No IO.
- **api unit** (`src/app/api/**/_shared/*.test.ts`) — SSE framing, engine-error → HTTP
  status mapping, turn event streaming, status payloads. No IO.
- **components** (`src/components/**/*.test.ts`) — pure logic extracted from components
  (draft merge/seed, attribute editor helpers, inline markup, message-markup span display +
  `commsLine` texted-line detection, chat reply segment→label mapping, focus-trap
  targeting, monogram initials) — no DOM rendering. No IO.
- **fixtures** (`scripts/fixtures/harbor-house.test.ts`) — the seed fixture validates
  against the contracts registries, so a vocabulary change that breaks the seed fails in
  tests, not at seed time. No IO.
- **db integration** (`src/**/*.int.test.ts` — engine, memory, images) — the **successor
  simulation engine** (`server/engine/simulation/*.int.test.ts` — branch/command/event
  durability, idempotency, typed holdings, injected-crash atomicity, the scheduler, and the
  gate corpora E2–E6), the chat lane (`chat-*.int.test.ts` — extraction legs, wardrobe,
  state fidelity, memory-failure), the successor narrator (`sim-narrator.int.test.ts`), plus
  memory vector queries and image asset lifecycle. IO: a `DATABASE_URL` database — suites
  probe at collection and self-skip locally with a stderr warning if unreachable; CI applies
  migrations, runs the gate targets explicitly, and treats an unavailable or unmigrated
  database as failure.
- **api** (`src/app/api/**/*.int.test.ts`) — route handlers called directly with mocked auth
  (`vi.mock` of `server/auth`): validation, envelopes, the chat SSE event sequence in demo
  mode, the atomic chat **rerun** (stop→wait→acquire→transact: snips successors + reuses the
  guard row; stops an in-flight reply then succeeds; byte-identical transcript + 409 when the
  lock can't be re-acquired; 4xx on a non-user/missing/foreign target; snapshot rollback vs.
  the degraded `chat_state.rerun.no_rollback`), and the successor `/api/chats` sim routes.
  IO: demo mode, `DATABASE_URL` database.

## Shared test utilities

Two homes, split by the purity fence (`eslint.config.mjs` bans `@/server/**`
imports from contracts/lib, tests included):

- **`src/server/test-support/`** (import via the `@/server/test-support`
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
- **`src/test/`** (import via `@/test/...`) — pure helpers importable from
  contracts/lib tests: registry invariants (`expectUniqueIds`,
  `expectAllValidate`, `expectRefsResolve`, `expectCaseInsensitiveLookup`,
  `expectContiguousBands`), sim command/event envelope builders
  (`commandEnvelope`/`eventEnvelope`/`bindSimEnvelopes`/`testPrincipal`),
  space/material/meter fixtures, diagnostics assertions
  (`codes`/`expectDiagnostics`/`expectDiagnostic`/`expectCleanSink`). These
  modules import only contracts/lib/vitest/zod — never `@/server`.
- Garment blueprint fixtures are colocated at
  `src/contracts/items/garment-test-fixtures.ts` (contracts-only imports).

Prefer deriving expectations from the registry/schema under test over
hand-enumerating entries (the pattern in `attributes/registry.test.ts` and
`scripts/fixtures/harbor-house.test.ts`): a vocabulary addition should never
force test edits, while broken production logic and crossed policy tripwires
(which stay literal, commented) still fail.

## Rules

- LLM calls are **never** mocked at the fetch layer — `server/ai` exposes a fake provider (`AI_FAKE=1` / demo mode, forced globally by `src/test/setup.ts` — don't re-set it per file) returning canned typed results; tests exercise real parsing/degradation paths.
- Degradation tests assert the fallback **and** the diagnostic code ([resilience.md](resilience.md) §8) — via `@/test/diagnostics` so the idiom stays uniform.
- Every bug fix lands with the regression test that would have caught it.
- `pnpm jscpd` covers test files too (threshold 3; they were excluded until
  2026-07-28, which is how ~3.2k duplicated test lines accumulated) — reuse the
  shared utilities instead of copy-pasting scaffolding.
- Embedding-dependent logic tests use `pseudoEmbed` (deterministic, from `server/ai/embeddings`) so similarity thresholds are exact.
- The symlink-escape containment cases (`server/images/paths.test.ts`, `server/images/assets.test.ts`) gate on `canCreateSymlinks()` (`@/server/test-support`), which probes once by planting a symlink in a temp dir: on Windows without Developer Mode or elevation `fs.symlink` fails with EPERM, so those cases self-skip with a stderr note rather than failing on fixture setup. On CI (`CI=true`) a failed probe **throws** — the escape tests are a security gate and must never silently vanish there. The containment logic itself is never weakened by the skip.

## Commands

```
pnpm test               # all non-DB suites (excludes **/*.int.test.ts)
pnpm test:watch         # same exclusion, watch mode
pnpm test:int           # DB suites only (filename filter ".int.test.", file parallelism off — they share one DB)
pnpm test:int:strict    # the SAME run as a release gate: REQUIRE_INTEGRATION_DB=true, so an unreachable
                        #   or unmigrated database FAILS the converted suites instead of skipping them
pnpm test:engine        # the successor engine's authority + narrator + sim-route int suites
pnpm test:engine-e2-5   # focused successor branch transaction + crash/concurrency proof (gate-specific
                        #   scripts run e2-4 … e6-5; run `pnpm db:migrate` first; local runs self-skip if unreachable, CI fails)
pnpm typecheck
pnpm lint
```

## Strict integration mode (the release form)

Every `.int.test.ts` suite probes the database at collection and **self-skips** when it is unreachable or unmigrated — right for ordinary dev, wrong for a claimed release gate, where a broken database would silently skip (for instance) the entire authorization matrix and still report green.

`pnpm test:int:strict` is the same run with `REQUIRE_INTEGRATION_DB=true`: the shared probe **throws** instead of returning "skip", so the suite fails loudly and names what was unreachable. Use it before a release or in CI; plain `pnpm test:int` stays skip-tolerant for local work. (`CI=true` and `VESPER_REQUIRE_TEST_DB=1` are honored as strict signals too — they predate the flag.)

### Running the whole integration suite locally

`pnpm test:int` needs **`VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER=1`**:

```
VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER=1 pnpm test:int
```

The low-level engine suites seed bare branches and submit the shared synthetic
player fixture, which the simulation authorization seam refuses without this
opt-in (deliberately — authorization tests leave it unset and keep proving that
ordinary unanchored players fail). CI exports it for the `pnpm test:engine` step.

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

Note also that CI runs `test:engine`'s curated glob rather than the whole
suite, so the route-level suites (`gallery`, `chat`, `library-routes`,
`authz-matrix`, `public-dto`, `variants`) are **not** gated on merge — see
`rate-limits.plan.md` OQ3.

Fixtures inserting `images` rows must go through **`canonicalImageRow`**
(`@/server/test-support`): the `images_path_canonical` CHECK requires the stored
path to be exactly `images/<owner_id>/<id>.webp`, and the helper derives the id
and the path together so a suite cannot pick one without the other.

The probe lives in one place, `src/server/test-support/int-db.ts` (`probeIntegrationDb(suite, table)`), imported through the `@/server/test-support` barrel (the simulation suites get it via `simulationSuiteHarness`). **Every `.int.test.ts` suite uses it as of 2026-07-28** — the last 51 inline copies were converted, so strict mode genuinely gates the whole integration surface. A new suite must use the helper (or the harness) from day one; an inline probe silently opts the suite out of the release gate.
