# Architecture

## Stack

| Layer      | Choice                                          | Notes                                                                                                                                                                |
| ---------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework  | Next.js 16 (App Router) + React 19              | Single app — no workspace packages                                                                                                                                   |
| Language   | TypeScript, `strict`                            | Plain `.ts`/`.tsx`, ESM                                                                                                                                              |
| Database   | Postgres 17 + pgvector                          | Local `vesper-postgres` container (port 5435), database `vesper_dev`                                                                                                 |
| ORM        | Drizzle ORM + drizzle-kit                       | SQL migrations generated with `drizzle-kit generate`, applied with `pnpm db:migrate` (the drizzle-orm migrator in `scripts/db-migrate.ts`); never `drizzle-kit push` |
| LLM        | AI SDK 6 (`ai`) + `@openrouter/ai-sdk-provider` | `streamText` for narrative, `generateChecked` (structured output + repair) for agents                                                                                |
| Embeddings | OpenRouter `/embeddings` endpoint               | 1536-dim, pgvector columns on owning tables                                                                                                                          |
| Image gen  | Replicate (text-to-image + reference edit)      | One backend; the model list is data in `image_models` — see [images.md](images.md)                                                                                   |
| Validation | Zod 4                                           | All registries, all JSONB boundaries, all API input                                                                                                                  |
| Styling    | Tailwind CSS 4                                  | Design tokens in `globals.css` `@theme`                                                                                                                              |
| Tests      | Vitest 4                                        | See [testing.md](testing.md)                                                                                                                                         |

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
      world/             #   life-stage, location, and character-profile schemas
      simulation/        #   successor-engine identity/envelope/projection contracts
      state/             #   scene-gen state
      turns/             #   chat turn contracts (archivist, pulse, clock, plans, …)
      diagnostics.ts     #   Diagnostic record + helpers
    lib/                 # pure shared utilities (parseOr, ids, clock)
      client/            #   client data layer (fetch wrappers, stream parser, hooks)
    server/
      db/                # drizzle schema, client, query helpers
      ai/                # OpenRouter (text) + Replicate (images) clients, embeddings, demo fallbacks
      api/               # route-handler support: request schemas, responders, library services
      engine/            # character-chat pipeline (chat-*) + the successor simulation engine (sim-* / simulation/)
      memory/            # fact supersedence, episodes, fused retrieval (chat-scoped)
      images/            # avatar/scene/variant pipelines, asset registry
      authoring/         # character forge + in-sheet fill/re-draft/portrait
      auth/              # Better Auth instance + session resolution (docs/auth.md)
      players/           # default player-character persona resolution (docs/auth.md)
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
engine ← memory              (the chat pipeline calls memory retrieval/writes)
engine ← images              (the chat pipeline schedules scene-image jobs only via the jobs API)
app/api    →  server/*       (route handlers are thin: validate → call server fn → shape response)
components →  contracts (types only), never server/*
```

Two lanes live under `server/engine`: the **character-chat** lane (`chat-*` files —
[character-chat/](character-chat/README.md)) and the **successor simulation engine**
(`sim-*` files + `simulation/`, an event-sourced world model — contracts in
[contracts/simulation.md](contracts/simulation.md), design in `docs/developer-notes/engine.*`).
These are the only two lanes — there is no world/session lane.

- `src/contracts` and `src/lib` are **pure**: no database, no fetch, no env reads. They must be importable from both server and client code. (Lint-enforced — see the boundary rule in `eslint.config.mjs`.)
- Server modules export through their `index.ts` barrel; other modules import the barrel, not deep paths. (Lint-enforced.)
- React components get server data via route handlers / server components only.
- **Auth & ownership** ([auth.md](auth.md)): `server/auth` wraps Better Auth (signed sessions; `getCurrentUser` → 401 on no session). Every entity carries `ownerId` and every **write** is owner-strict. The single cross-owner relaxation is a **read** widening to owner-or-public (`findViewable`) confined to the browse/preview/copy path, and even there a foreign viewer receives an **allow-listed public representation** (`toPublicCharacter` & co.), never the persisted row; "using" a public entity copies it (no live cross-owner reference), preserving the IDOR-clean property.

## Data flow (one chat exchange)

```
player message
   │
   ▼
POST /api/chats/:chatId/messages  (SSE response)
   │
   ├─ pre-reply (parallel): fused fact + episode RAG · one-turn intent reads
   │                        + deterministic: drift, scene/state slice, prompt build
   ▼
narrative model (streamText) ──► speaker segmenter ──► SSE chunks
   │ (full reply persisted)
   ▼
post-turn fan-out (parallel): reaction pulse ‖ three extraction legs
   │
   ▼
finalize: state row + facts (+supersedence) + episode, then jobs
   (scene image, summary fold, meanwhile)
```

The full lifecycle is [character-chat/pipeline.md](character-chat/pipeline.md). The
successor engine's request flow (command → event → synchronous projection → NarrativeCut) is
[contracts/simulation.md](contracts/simulation.md).

## Naming

The app is **Vesper**. Database `vesper_dev` (integration suites run against `DATABASE_URL` and self-skip when it is unreachable). Model/env var names are documented in [getting-started.md](getting-started.md).
