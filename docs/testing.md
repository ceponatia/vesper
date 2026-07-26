# Testing

Vitest 4, one root config (`vitest.config.ts`) including `src/**/*.test.ts` and `scripts/**/*.test.ts`. The global setup file `src/test/setup.ts` forces demo mode for every test: it sets `AI_FAKE=1` and deletes `OPENROUTER_API_KEY` / `VENICE_API_KEY`, so no test can hit a real provider. `pnpm test` runs everything that needs no network; DB-backed suites need the dev Postgres up.

## Layers

| Suite | Location | Covers | IO |
| --- | --- | --- | --- |
| contracts | `src/contracts/**/*.test.ts` | Registry invariants (unique ids, valid enums, alias fan-out — one alias may resolve to several attributes), parse/resolve round-trips, attribute precedence, condition logic, wardrobe visibility, chat scene-memory merge/switch (caps, dedupe oldest-out, current-place protection, degraded parse) | none |
| lib | `src/lib/**/*.test.ts` | parseOr/parseOrNull, game-clock math, client API error envelope, chat SSE-stream parsing, **speaker segmenter edge cases** (`segmenter.ts` — dialogue tags + the chat lane's standalone-quote attribution), the successor `lib/simulation/*` pure rules (space, activities, commitments, engagements, perception, knowledge, bodies, LOD, …) | none |
| engine unit | `src/server/engine/**/*.test.ts` | Demo-mode generators, chat prompt builders (structural assertions, not snapshots of full text), the chat extraction field library, chat one-turn reads (`chat-intent.ts` — scene movement, sense-targeted focus, reply-discipline gates: hook cadence + intimate check-in), the reply-stream watchdog (`withStreamTimeouts` — first-token/overall trip aborts + passes tokens through) and the bounded lock-wait (`acquireKeyedLockWithin` — acquires/waits/times-out, re-issuing its stop) behind the atomic rerun | none (fake rows) |
| memory unit | `src/server/memory/**/*.test.ts` | Supersedence gating, fact lifecycle, fused retrieval merge/dedup, witness-eligibility filtering | mocked embeddings (deterministic vectors) |
| server unit | `src/server/{api,authoring,images}/**/*.test.ts` | Rate limiting, error envelopes, body schemas; character-forge grounding (attributes, traits, outfits, drives, social cards) plus demo-mode forge runs; image prompt builders, monogram SVG, atomic webp writes | none |
| api unit | `src/app/api/**/_shared/*.test.ts` | SSE framing, engine-error → HTTP status mapping, turn event streaming, status payloads | none |
| components | `src/components/**/*.test.ts` | Pure logic extracted from components (draft merge/seed, attribute editor helpers, inline markup, message-markup span display + `commsLine` texted-line detection, chat reply segment→label mapping, focus-trap targeting, monogram initials) — no DOM rendering | none |
| fixtures | `scripts/fixtures/harbor-house.test.ts` | The seed fixture validates against the contracts registries, so a vocabulary change that breaks the seed fails in tests, not at seed time | none |
| db integration | `src/**/*.int.test.ts` (engine, memory, images) | The **successor simulation engine** (`server/engine/simulation/*.int.test.ts` — branch/command/event durability, idempotency, typed holdings, injected-crash atomicity, the scheduler, and the gate corpora E2–E6), the chat lane (`chat-*.int.test.ts` — extraction legs, wardrobe, state fidelity, memory-failure), the successor narrator (`sim-narrator.int.test.ts`), plus memory vector queries and image asset lifecycle | `DATABASE_URL` database (suites probe at collection and self-skip locally with a stderr warning if unreachable; CI applies migrations, runs the gate targets explicitly, and treats an unavailable or unmigrated database as failure) |
| api | `src/app/api/**/*.int.test.ts` | Route handlers called directly with mocked auth (`vi.mock` of `server/auth`): validation, envelopes, the chat SSE event sequence in demo mode, the atomic chat **rerun** (stop→wait→acquire→transact: snips successors + reuses the guard row; stops an in-flight reply then succeeds; byte-identical transcript + 409 when the lock can't be re-acquired; 4xx on a non-user/missing/foreign target; snapshot rollback vs. the degraded `chat_state.rerun.no_rollback`), and the successor `/api/chats` sim routes | demo mode, `DATABASE_URL` database |

## Rules

- LLM calls are **never** mocked at the fetch layer — `server/ai` exposes a fake provider (`AI_FAKE=1` / demo mode, forced globally by `src/test/setup.ts`) returning canned typed results; tests exercise real parsing/degradation paths.
- Degradation tests assert the fallback **and** the diagnostic code ([resilience.md](resilience.md) §8).
- Every bug fix lands with the regression test that would have caught it.
- Embedding-dependent logic tests use `pseudoEmbed` (deterministic, from `server/ai/embeddings`) so similarity thresholds are exact.

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
ordinary unanchored players fail). CI exports it for the `pnpm test:engine` step,
so a plain local `pnpm test:int` reports **~120 spurious failures** in
`simulation/*-store` and the gate corpora that CI never sees. Note also that CI
runs `test:engine`'s curated glob rather than the whole suite, so the route-level
suites (`gallery`, `chat`, `library-routes`, `authz-matrix`, `public-dto`,
`variants`) are **not** gated on merge — see `rate-limits.plan.md` OQ3.

Fixtures inserting `images` rows must go through **`canonicalImageRow`**
(`@/server/test-support`): the `images_path_canonical` CHECK requires the stored
path to be exactly `images/<owner_id>/<id>.webp`, and the helper derives the id
and the path together so a suite cannot pick one without the other.

The probe lives in one place, `src/server/test-support/int-db.ts` (`probeIntegrationDb(suite, table)`), imported through the `@/server/test-support` barrel. **A suite honors strict mode only once it uses that helper**; suites still carrying their own inline probe skip regardless of the flag. Converted so far: the security surface — `server/api/authz-matrix`, `server/api/public-dto`, `server/api/library`, `server/api/social-cards`, `server/images/variants`, `server/engine/simulation/command-authz`, `app/api/chats/chat`. Everything else (the engine `simulation/*-store` and gate-corpus suites, the remaining `app/api/**` route suites, `server/memory`, `server/images/assets`, the chat-lane `server/engine/chat-*` suites) still self-skips — convert a suite's probe to the helper when you next touch it.
