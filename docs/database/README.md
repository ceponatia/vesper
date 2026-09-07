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
  `portrait_variant` / `entity_image` / `embed_refresh` / `image_sweep` / `identity_pack` /
  `reference_views` / … —
  see the schema enum for the full list), `status` (`queued` / `running` / `done` / `failed`),
  `runner_id?` (atomic claim), `heartbeat_at`, `payload` JSONB, `error?`, `attempts`, timestamps,
  and `chat_id?` — an indexed foreign key to `character_chats` with `ON DELETE CASCADE`, written by
  the chat-lane enqueue paths and null for system and library work, so deleting a conversation
  takes its background jobs with it. Terminal rows (`done` / `failed`) are deleted seven days after
  they settle; `queued` and `running` rows are never removed by age.
- **`events`** — `type`, `payload` JSONB, `chat_id?` (indexed, `ON DELETE CASCADE`); an append-only
  observability stream written via `server/events.ts`. A writer that already holds a conversation
  passes its id — never a lookup made to fill the column in — so deleting a chat takes its telemetry
  with it; everything else leaves it null. **In production the row stores the diagnostic payload
  alone** — ids, statuses, counts, scores, durations, error classes — and never the user-authored or
  roleplay-derived text a call site passes separately as `content` (a retrieval query, a leg's
  summary and detail, a fallback's private cause). Outside production that text is merged into the
  stored payload, which is the detail the dev chat inspector renders. Rows expire 30 days after
  `created_at`. The chat inspector reads `agent_failure` / `agent_run` / `composition_fallback`
  events by created-at window.

## Retention

The image sweep's maintenance tick (`kickImageSweep` in `apps/web/src/server/images/asset-maintenance.ts`)
also runs the passes in `apps/web/src/server/retention/`. Each pass is a bounded delete of at
most `RETENTION_BATCH_SIZE` (1000) rows per tick, decided from the row's own timestamp or status
alone — a large backlog is worked down over several ticks, never in one statement. These passes
carry **no** mass-expiry refusal: that rule is the image sweep's own, guarding against a missing
volume making healthy image rows look broken, and it does not apply to rows whose expiry comes
from database data.

| Pass                                  | Deletes when        |
| ------------------------------------- | ------------------- |
| `events`                              | older than 30 days  |
| `jobs` (terminal: `done` / `failed`)  | older than 7 days   |
| `auth_sessions`                       | past `expires_at`   |
| `verifications`                       | past `expires_at`   |
