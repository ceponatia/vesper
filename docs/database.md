# Database

Postgres 17 + pgvector, Drizzle ORM. Database `vesper_dev` runs in Vesper's local `vesper-postgres` container (port 5435); integration suites run against `DATABASE_URL` and self-skip with a warning when it is unreachable or unmigrated.

## Conventions

- Schema lives in `src/server/db/schema.ts` (one file until it hurts). snake_case columns, cuid2 text PKs (`src/lib/ids.ts`), `created_at`/`updated_at` timestamptz.
- **JSONB columns are typed at the boundary**: every JSONB read goes through `parseOr` with its contract schema ([resilience.md](resilience.md)). Drizzle's `$type<T>()` documents the intent; zod enforces it.
- Embeddings are `vector(1536)` columns **on the owning table** (no polymorphic embedding table — supersede/delete the row and the embedding goes with it). HNSW cosine indexes where scale warrants it (see Indexes below).
- Bootstrap: the baseline migration (`drizzle/0000_*.sql`) opens with `CREATE EXTENSION IF NOT EXISTS vector`, so `pnpm db:migrate` self-enables pgvector and works against a fresh, empty database with no prior steps. `pnpm db:create` (idempotent, `scripts/db-create.ts`) remains for environments where the database itself doesn't exist yet — the docker container already creates `vesper_dev` on first init, so it's optional there.
- Migrations: `pnpm db:generate` (drizzle-kit generate) → review SQL in `drizzle/` → `pnpm db:migrate` (`scripts/db-migrate.ts`, the drizzle migrator). Never `drizzle-kit push` outside local experiments. (Drizzle replaces the old prisma-migrate-hangs workflow entirely.) drizzle-kit does **not** emit the `CREATE EXTENSION` line on its own — if the baseline migration is ever regenerated, re-add it as the first statement.

## Tables

### Identity & library (owner-scoped definitions)

| Table | Key columns |
| --- | --- |
| `users` | `email` unique, `name`, `role` (`user`/`admin`) — dev-cookie auth, see auth module |
| `characters` | `owner_id`, `name`, `profile` JSONB (`CharacterProfile`: bio, personality, voice, speciesId, bodyPlanId, `attributes` (`AttributeValue[]`), aliases, defaultOutfit item ids, schedule), `tags` JSONB, `avatar_image_id`, `search_embedding` vector |
| `locations` | `owner_id`, `name`, `description`, `ambient` JSONB (sensory), `scale` (`intimate`/`room`/`hall`/`open`/`expanse`), `affordances` JSONB, `tags` JSONB, `image_id`, `search_embedding` vector |
| `items` | `owner_id`, `kind` (`clothing`/`object`/`container`), `name`, `description`, `definition` JSONB (`ItemDefinition` extras: coverage, layer, opacity, sensory, fields), `tags` JSONB, `image_id`, `search_embedding` vector |

### Worlds (composition over the library)

| Table | Key columns |
| --- | --- |
| `worlds` | `owner_id`, `name`, `description`, `style` JSONB (`WorldStyle` — pinned in [contracts.md](contracts.md), includes `norms`), `lore` JSONB (`WorldLore`: synopsis, factions, plot anchors), `narrative_model`, `image_id`, `player_start_world_location_id?` (soft reference, no FK), `duplicated_from_world_id?` (world copy keeps lineage) |
| `world_cast` | `world_id`, `character_id`, `role` (`companion`/`npc`), `tier` (`major`/`minor`/`extra`), `start_world_location_id` (→ `world_locations`; NPC schedules live in `CharacterProfile.schedule`), `relationships` JSONB (`AuthoredRelationship[]` — directed edges toward cast names or `"player"`; spawn seeds `participant_relationships` at stage midpoints) |
| `world_locations` | `world_id`, `location_id`, `overrides` JSONB (may also override `scale`/`area`), `sort` (authored map order — the editor's array index on every save; reads ORDER BY it) |
| `world_links` | `world_id`, `from_world_location_id`, `to_world_location_id`, `label`, `travel_minutes`, `audibility` (reserved), `access` JSONB, `door_item_id?` |
| `world_items` | `world_id`, `item_id`, placement: `world_location_id?` or `cast_id?` (+ `worn`), `container_world_item_id?`, `quantity` |
| `lore_chunks` | `world_id`, `title`, `body`, `category`, `tier` (`always`/`scene`/`retrieval`), `visibility` (`public`/`secret`), `unlock_tags` JSONB, `location_tags` JSONB, `character_ids` JSONB, `sort`, `manually_unlocked` bool, `embedding` vector |

### Sessions (instances)

| Table | Key columns |
| --- | --- |
| `sessions` | `owner_id`, `world_id`, `title`, `embodied` bool, `status` (`ready`/`narrating`/`processing` — **3 states**; turn failure returns the session to `ready` with the turn marked `failed`), `clock_minutes` bigint, `runtime` JSONB (`SessionRuntime`), `brief` JSONB (`NextTurnBrief`), `scene` JSONB (`SceneGenState`) — all three shapes pinned in [contracts.md](contracts.md) |
| `session_participants` | `session_id`, `character_id?`, `is_user`, `display_name` (unique per session), `role`, `tier` (`major`/`minor`/`extra`), `snapshot` JSONB (`CharacterProfile` snapshot at spawn), `state` JSONB (`ParticipantState`, pinned in contracts.md), `location_id` → `session_locations`, `avatar_image_id` |
| `session_locations` | `session_id`, `location_id?` (null for emergent), `name`, `description`, `ambient` JSONB, `scale`, `area?`, `affordances` JSONB, `emergent` bool |
| `session_links` | `session_id`, `from_id`, `to_id`, `label`, `travel_minutes`, `audibility` (reserved), `access` JSONB, `door_item_id?` |
| `participant_relationships` | `session_id`, `from_participant_id` (edge owner — always an NPC), `to_participant_id`, `kind` (`feeling`/`perceived` — perceived only toward the player), `value` int, `stage` (denormalized from the stage registry, recomputed on write); unique (session, from, to, kind) |
| `item_instances` | `session_id`, `item_id?`, `snapshot` JSONB (ItemDefinition snapshot), `name`, exactly-one placement (`holder_participant_id` + `worn` bool, `location_id`, `container_instance_id`) **enforced by CHECK constraints** (`item_instances_one_placement`; `item_instances_worn_needs_holder` — `worn` requires a holder), `position_note`, `state` JSONB (condition/cleanliness/wetness/notes). Wardrobe visibility (visible/hinted/hidden per body location) is computed by `contracts/items/visibility.ts`, never stored |

### Turns & memory

| Table | Key columns |
| --- | --- |
| `turns` | `session_id`, `number` (unique with session), `author` (`player`/`director`/`companion`), `speaker_participant_id?` (set only when `author='companion'`), `input`, `narration`, `status` (`pending`/`narrating`/`processing`/`ready`/`failed`), `heartbeat_at` (liveness for recovery — see turn-engine.md), `minutes`, `agent_results` JSONB (raw per-agent outputs, for inspector/replay), `diagnostics` JSONB, `model`, `usage` JSONB |
| `turn_messages` | `turn_id`, `seq`, `role` (`player`/`narrator`/`character`/`system`), `speaker?`, `content` |
| `episodes` | `session_id`, `turn_number`, `summary`, `thread_ids` JSONB, `witnessed_by` JSONB (see [memory.md](memory.md)), `embedding` vector, `embedder` |
| `facts` | `session_id`, `kind`, `verb?`, `subject_kind`, `subject_id?`, `subject_name` (stored lowercased), `text`, `tags` JSONB, `confidence` real, `canon` bool (default true; reserved), `witnessed_by` JSONB, `status` (`active`/`superseded`/`retracted`), `superseded_by_id?`, `source_turn_id?`, `embedding` vector, `embedder`, `superseded_at?` |

Every embedding-bearing table carries `embedder` (`"<model-id>"` or `"pseudo"`). Similarity queries always filter `embedder = currentEmbedder()` — pseudo (demo) vectors and real vectors never compare against each other, and an embedding-model change degrades to reduced recall (+ an `embed_refresh` job can re-embed) instead of silently corrupted thresholds.

### Infrastructure

| Table | Key columns |
| --- | --- |
| `images` | `owner_id`, `kind` (`avatar`/`portrait_variant`/`scene`/`entity`), `entity_kind?` (`character`/`location`/`item`/`world` — set for `entity` images; always `character` for `avatar`/`portrait_variant`; app convention, not a constraint), `entity_id?`, `session_id?`, `path` (relative to `data/`), `prompt`, `source_image_id?` (reference-edit lineage), `status` (`pending`/`ready`/`failed` — row is written **before** the file; see images.md), `meta` JSONB |
| `jobs` | `session_id?`, `type` (`post_turn`/`reconcile`/`scene_image`/`avatar`/`portrait_variant`/`entity_image`/`embed_refresh`/`image_sweep`), `status` (`queued`/`running`/`done`/`failed`), `runner_id?` (atomic claim), `heartbeat_at`, `payload` JSONB, `error?`, `attempts`, timestamps |
| `events` | `session_id?`, `type`, `payload` JSONB — append-only observability stream (written via `server/events.ts`; the Turn Inspector route reads `retrieval` events by created-at window) |

## Indexes that matter

- `turns(session_id, number)` unique; `turn_messages(turn_id, seq)`; `facts(session_id, status)`; `episodes(session_id, turn_number)`.
- HNSW (`vector_cosine_ops`) on `facts.embedding`, `episodes.embedding`, `lore_chunks.embedding`. The library `search_embedding` columns are unindexed — owner-scoped libraries are small enough to scan.
- `jobs(status, type)` composite index for queue claims.

## Transactional invariants

- The post-turn merge commits all **world-state** writes — participant state, item instances, clock, runtime, brief, and the turn row — in **one transaction** (`engine/merge.ts`). Facts (+supersedence) and the episode are written first through the memory module, each internally transactional; their embeddings degrade per [memory.md](memory.md) instead of failing the merge.
- Fact supersedence updates `status`/`superseded_by_id`/`superseded_at` on the old row in the same transaction as the inserted replacement — the embedding lives on the row, so there is no orphaned-embedding state (a bug class in the old app).
- Session status transitions use compare-and-swap (`WHERE status = 'ready'`) to serialize turn submission.
