# Database

Postgres 17 + pgvector, Drizzle ORM. Database `vesper_dev` runs in Vesper's local
`vesper-postgres` container (port 5435); integration suites run against `DATABASE_URL` and
self-skip with a warning when it is unreachable or unmigrated.

## Reading order

| Doc                              | What it covers                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------- |
| [library.md](library.md)         | Owner-scoped definition tables: users, characters, personas, locations, items     |
| [simulation.md](simulation.md)   | The `sim_*` successor-engine authority catalog, forks, and disposable projections |
| [chat-memory.md](chat-memory.md) | The chat lane's tables and the memory-group-keyed `episodes` / `facts`            |
| [images.md](images.md)           | Assets, references, model registry and profiles, identity packs, bench runs       |
| [indexes.md](indexes.md)         | The indexes that matter and the transactional invariants                          |

## Conventions

- Schema lives in `apps/web/src/server/db/schema.ts` (one file until it hurts). snake_case
  columns, cuid2 text PKs (`apps/web/src/lib/ids.ts`), `created_at`/`updated_at` timestamptz.
- **JSONB columns are typed at the boundary**: every JSONB read goes through `parseOr` with its
  contract schema ([../resilience.md](../resilience.md)). Drizzle's `$type<T>()` documents the
  intent; zod enforces it.
- Embeddings are `vector(1536)` columns **on the owning table** — no polymorphic embedding
  table, so superseding or deleting the row takes the embedding with it. HNSW cosine indexes
  where scale warrants it ([indexes.md](indexes.md)).
- Every embedding-bearing table carries `embedder` (`"<model-id>"` or `"pseudo"`). Similarity
  queries always filter `embedder = currentEmbedder()`: pseudo (demo) vectors and real vectors
  never compare against each other, and an embedding-model change degrades to reduced recall —
  an `embed_refresh` job can re-embed — instead of silently corrupted thresholds.

## Migrations

`pnpm db:generate` (drizzle-kit generate) → review SQL in `drizzle/` → `pnpm db:migrate`
(`scripts/db-migrate.ts`, the drizzle migrator). Never `drizzle-kit push` outside local
experiments.

Bootstrap: the baseline migration (`drizzle/0000_*.sql`) opens with
`CREATE EXTENSION IF NOT EXISTS vector`, so `pnpm db:migrate` self-enables pgvector and works
against a fresh, empty database with no prior steps. drizzle-kit does **not** emit the
`CREATE EXTENSION` line on its own — if the baseline migration is ever regenerated, re-add it as
the first statement.

`pnpm db:create` (idempotent, `scripts/db-create.ts`) remains for environments where the database
itself does not exist yet; the docker container already creates `vesper_dev` on first init, so it
is optional there.

## Operational tables

- **`jobs`** — `type`
  (`chat_summary` / `chat_scene_sketch` / `chat_meanwhile` / `chat_scene_image` / `avatar` /
  `portrait_variant` / `entity_image` / `embed_refresh` / `image_sweep` / `identity_pack` / … —
  see the schema enum for the full list), `status` (`queued` / `running` / `done` / `failed`),
  `runner_id?` (atomic claim), `heartbeat_at`, `payload` JSONB, `error?`, `attempts`, timestamps.
- **`events`** — `type`, `payload` JSONB; an append-only observability stream written via
  `server/events.ts`. The chat inspector reads `retrieval` / `agent_failure` / `agent_run` events
  by created-at window.
