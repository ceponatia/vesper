# Architecture

## Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js 16 (App Router) + React 19 | Single app — no workspace packages |
| Language | TypeScript, `strict` | Plain `.ts`/`.tsx`, ESM |
| Database | Postgres 17 + pgvector | Local `vesper-postgres` container (port 5435), database `vesper_dev` |
| ORM | Drizzle ORM + drizzle-kit | SQL migrations generated, applied with `drizzle-kit migrate` (never `push` in CI) |
| LLM | AI SDK 6 (`ai`) + `@openrouter/ai-sdk-provider` | `streamText` for narrative, `generateChecked` (structured output + repair) for agents |
| Embeddings | OpenRouter `/embeddings` endpoint | 1536-dim, pgvector columns on owning tables |
| Image gen | OpenRouter image models + Venice edit API | See [images.md](images.md) |
| Validation | Zod 4 | All registries, all JSONB boundaries, all API input |
| Styling | Tailwind CSS 4 | Design tokens in `globals.css` `@theme` |
| Tests | Vitest 4 | See [testing.md](testing.md) |

Why a single app instead of the old 12-package monorepo: every package served exactly one consumer. Module boundaries are kept as folders with barrel exports; the import graph below is enforced by an ESLint `no-restricted-imports` boundary rule (`eslint.config.mjs`) plus review, not workspace plumbing.

## Directory layout

```
vesper/
  docs/                  # this folder
  drizzle/               # generated SQL migrations (committed)
  data/                  # runtime-generated image assets (gitignored)
  src/
    contracts/           # pure zod registries & schemas — NO IO, NO db imports
      attributes/        #   attribute groups + central registry
      body/              #   body-location tree, body plans
      meters/            #   meter definition registry
      conditions/        #   active-condition schema
      items/             #   item definitions, instances, placement
      facts/             #   fact taxonomy + fact schema
      world/             #   world/lore/style schemas
      state/             #   character & session runtime state
      turns/             #   agent result schemas, turn result, briefs
      diagnostics.ts     #   Diagnostic record + helpers
    lib/                 # pure shared utilities (parseOr, ids, clock)
      client/            #   client data layer (fetch wrappers, turn-stream parser, hooks)
    server/
      db/                # drizzle schema, client, query helpers
      ai/                # OpenRouter/Venice clients, embeddings, demo fallbacks
      api/               # route-handler support: request schemas, responders, library/world/session services
      engine/            # turn pipeline: assembly, streaming, agents, merge, jobs
      memory/            # retrieval, fact supersedence, episodes, lore RAG
      images/            # avatar/scene/variant pipelines, asset registry
      authoring/         # world forge, character forge
      auth/              # Better Auth instance + session resolution (docs/auth.md)
      log.ts             # logging (reads LOG_LEVEL — server-only, kept out of lib)
    app/                 # Next.js routes (pages + API route handlers)
    components/          # React components
```

## Module dependency rules

```
contracts  ←  lib            (contracts may use lib; both are pure)
   ↑
server/db  ←  server/*       (db is imported by all server modules)
   ↑
server/ai  ←  engine, memory, images, authoring
   ↑
engine ← memory              (engine calls memory retrieval/writes)
engine ← images              (engine schedules scene-image jobs only via jobs API)
app/api    →  server/*       (route handlers are thin: validate → call server fn → shape response)
components →  contracts (types only), never server/*
```

- `src/contracts` and `src/lib` are **pure**: no database, no fetch, no env reads. They must be importable from both server and client code. (Lint-enforced — see the boundary rule in `eslint.config.mjs`.)
- Server modules export through their `index.ts` barrel; other modules import the barrel, not deep paths. (Lint-enforced.)
- React components get server data via route handlers / server components only.
- **Auth & ownership** ([auth.md](auth.md)): `server/auth` wraps Better Auth (signed sessions; `getCurrentUser` → 401 on no session). Every entity carries `ownerId` and every **write** is owner-strict. The single cross-owner relaxation is a **read** widening to owner-or-public (`findViewable`) confined to the browse/preview/copy path; "using" a public entity copies it (no live cross-owner reference), preserving the IDOR-clean property.

## Data flow (one turn)

```
player input
   │
   ▼
POST /api/sessions/:id/turns  (SSE response)
   │
   ├─ pre-turn fan-out (parallel): episode RAG · fact retrieval · lore retrieval
   │                               + deterministic: scene snapshot, wardrobe
   │                               visibility, movement intent, canonical facts
   ▼
narrative model (streamText, per-world model) ──► speaker segmenter ──► SSE chunks
   │ (full narration persisted)
   ▼
post-turn fan-out (parallel generateObject agents):
   simulant · archivist · continuity · director
   │
   ▼
deterministic merge reducer → one DB transaction
   (state, items, clock, facts+supersedence, episode, threads, next-turn brief)
   │
   ▼
maintenance jobs: scene image gen, lore unlocks, library embedding refresh
```

Details in [turn-engine.md](turn-engine.md).

## Naming

The app is **Vesper**. Database `vesper_dev` (integration suites run against `DATABASE_URL` and self-skip when it is unreachable). Model/env var names are documented in [getting-started.md](getting-started.md).
