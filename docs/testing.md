# Testing

Vitest 4, one root config (`vitest.config.ts`) including `src/**/*.test.ts` and `scripts/**/*.test.ts`. The global setup file `src/test/setup.ts` forces demo mode for every test: it sets `AI_FAKE=1` and deletes `OPENROUTER_API_KEY` / `VENICE_API_KEY`, so no test can hit a real provider. `pnpm test` runs everything that needs no network; DB-backed suites need the dev Postgres up.

## Layers

| Suite | Location | Covers | IO |
| --- | --- | --- | --- |
| contracts | `src/contracts/**/*.test.ts` | Registry invariants (unique ids, valid enums, alias fan-out — one alias may resolve to several attributes), parse/resolve round-trips, attribute precedence, condition logic, wardrobe visibility, chat scene-memory merge/switch (caps, dedupe oldest-out, current-place protection, degraded parse) | none |
| lib | `src/lib/**/*.test.ts` | parseOr/parseOrNull, game-clock math, client API error envelope, SSE turn-stream parsing, session feed/status reducers, **speaker segmenter edge cases** (`segmenter.ts` — dialogue tags + the chat lane's standalone-quote attribution) | none |
| engine unit | `src/server/engine/**/*.test.ts` | **The merge reducer** (the most-tested code: every event type, clamping, invalid-reference dropping, all-agents-failed degradation), scene assembly incl. wardrobe visibility, movement intent capture, demo-mode generators, prompt builders (structural assertions, not snapshots of full text), chat one-turn reads (`chat-intent.ts` — scene movement, sense-targeted focus, reply-discipline gates: hook cadence + intimate check-in) | none (fake rows) |
| memory unit | `src/server/memory/**/*.test.ts` | Supersedence gating, fact lifecycle, lore eligibility filtering, retrieval merge/dedup | mocked embeddings (deterministic vectors) |
| server unit | `src/server/{api,authoring,images}/**/*.test.ts` | Rate limiting, error envelopes, body schemas; forge grounding (attributes, outfits, item placements, location graphs) plus demo-mode forge runs; image prompt builders, monogram SVG, atomic webp writes | none |
| api unit | `src/app/api/**/_shared/*.test.ts` | SSE framing, engine-error → HTTP status mapping, turn event streaming, status payloads | none |
| components | `src/components/**/*.test.ts` | Pure logic extracted from components (draft merge/seed, attribute editor helpers, inline markup, message-markup span display + `commsLine` texted-line detection, chat reply segment→label mapping, focus-trap targeting, monogram initials) — no DOM rendering | none |
| fixtures | `scripts/fixtures/harbor-house.test.ts` | The seed fixture validates against the contracts registries, so a vocabulary change that breaks the seed fails in tests, not at seed time | none |
| db integration | `src/**/*.int.test.ts` (engine, memory, images) | Spawn + full demo-mode turns, CAS turn locking, transactional merge, vector queries, asset lifecycle | `DATABASE_URL` database (suites probe at collection and self-skip with a stderr warning if unreachable) |
| api | `src/app/api/**/*.int.test.ts` | Route handlers called directly with mocked auth (`vi.mock` of `server/auth`): validation, envelopes, the SSE event sequence in demo mode | demo mode, `DATABASE_URL` database |

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
                        #   run `pnpm db:create && pnpm db:migrate` first; suites self-skip if the DB is unreachable
pnpm typecheck
pnpm lint
```
