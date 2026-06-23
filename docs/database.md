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
| `locations` | `owner_id`, `name`, `description`, `ambient` JSONB (sensory), `scale` (`intimate`/`room`/`hall`/`open`/`expanse`), `area?` (map-grouping label), `affordances` JSONB, `tags` JSONB, `image_id`, `search_embedding` vector |
| `location_links` | `owner_id`, `from_location_id`, `to_location_id` (FK-cascade), `travel_minutes` — undirected library connections (one row per pair); the library counterpart of `world_links`. Importing a linked set into a world recreates them as `world_links` (`materializeLocations`) |
| `items` | `owner_id`, `kind` (`clothing`/`object`/`container`), `name`, `description`, `definition` JSONB (`ItemDefinition` extras: coverage, layer, opacity, sensory, fields), `tags` JSONB, `image_id`, `search_embedding` vector |

### Worlds (instance copies of the library)

A world holds its **own snapshot copy** of every entity it uses, not a live reference
(the library → world → session copy cascade — see [developer-notes/world-instances.plan.md](developer-notes/world-instances.plan.md)).
Each `world_*` row carries a `snapshot` of the effective entity plus a **soft**
`source_*_id` pointer (provenance only — **no FK**) and `source_stamped_at` (the
source's `updated_at` at copy time, the diff baseline for future opt-in propagation).
So deleting or editing a library row never breaks a world; the source pointer just
dangles. Library entities remain the single reuse surface (forge writes them; a
world materialization copies them in the same step).

| Table | Key columns |
| --- | --- |
| `worlds` | `owner_id`, `name`, `description`, `style` JSONB (`WorldStyle` — pinned in [contracts/state.md](contracts/state.md), includes `norms`), `lore` JSONB (`WorldLore`: synopsis, factions, plot anchors), `narrative_model`, `agent_model` (per-world in-session agent override; migration 0003), `image_id`, `player_character_id?` (default player the new-session wizard pre-fills; FK→`characters` ON DELETE set null; migration 0007), `player_start_world_location_id?` (soft reference, no FK), `duplicated_from_world_id?` (world copy keeps lineage) |
| `world_cast` | `world_id`, `source_character_id?` (soft, no FK), `name` (display copy), `snapshot` JSONB (`CharacterProfile` copy), `avatar_image_id?` (shared owner-asset, kept fresh by the world image backfill), `source_stamped_at?`, `role` (`companion`/`npc`), `tier` (`major`/`minor`/`extra`), `start_world_location_id` (→ `world_locations`; NPC schedules live in `CharacterProfile.schedule`), `relationships` JSONB (`AuthoredRelationship[]` — directed edges toward cast names or `"player"`; spawn seeds `participant_relationships` at stage midpoints) |
| `world_locations` | `world_id`, `source_location_id?` (soft, no FK), `snapshot` JSONB (`LocationSnapshot` — name/description/ambient/scale/area/affordances/tags), `source_stamped_at?`, `sort` (authored map order — the editor's array index on every save; reads ORDER BY it) |
| `world_links` | `world_id`, `from_world_location_id`, `to_world_location_id`, `label`, `travel_minutes`, `audibility` (reserved), `access` JSONB, `door_item_id?` |
| `world_items` | `world_id`, `source_item_id?` (soft, no FK), `name` (display copy), `snapshot` JSONB (`ItemDefinition` copy), `source_stamped_at?`, placement: `world_location_id?` or `cast_id?` (+ `worn`), `container_world_item_id?`, `quantity` |
| `lore_chunks` | `world_id`, `title`, `body`, `category`, `tier` (`always`/`scene`/`retrieval`), `visibility` (`public`/`secret`), `unlock_tags` JSONB, `location_tags` JSONB, `character_ids` JSONB, `sort`, `manually_unlocked` bool, `embedding` vector |

### Sessions (instances)

A session is a full instantiation of its **world** (which is itself already a copy of
the library), so play never reads world or library rows again. The `character_id?` /
`location_id?` / `item_id?` back-pointers on the tables below are **soft source
references — no FK** (same cascade rationale as `world_*`): a deleted library row
leaves the snapshot intact.

| Table | Key columns |
| --- | --- |
| `sessions` | `owner_id`, `world_id`, `title`, `embodied` bool, `status` (`ready`/`narrating`/`processing` — **3 states**; turn failure returns the session to `ready` with the turn marked `failed`), `clock_minutes` bigint, `runtime` JSONB (`SessionRuntime`), `brief` JSONB (`NextTurnBrief`), `scene` JSONB (`SceneGenState`) — all three shapes pinned in [contracts/state.md](contracts/state.md) |
| `session_participants` | `session_id`, `character_id?`, `is_user`, `display_name` (unique per session), `role`, `tier` (`major`/`minor`/`extra`), `snapshot` JSONB (`CharacterProfile` snapshot at spawn), `state` JSONB (`ParticipantState`, pinned in [contracts/state.md](contracts/state.md)), `location_id` → `session_locations`, `avatar_image_id` |
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
| `image_references` | `scene_image_id` (→ `images`, **FK-cascade**), `kind` (`character`/`location`/`style`/`pose`/`layout`), `entity_id?` (library character/location id; null for non-entity roles), `role?`, `source?` (`generated`/`uploaded`/`composite`/`entity`; null = unknown), `image_id?` (the reference asset actually fed to a provider; null when textual-only), `name`. One row per reference a scene image featured — the authoritative, queryable record that replaced `images.meta.references` (scene-images.spec.md §4; the Gallery reads it). `SceneVisualReference` is the render-input superset, `SceneReference` the Gallery projection (contracts/images/scene-reference.ts) |
| `jobs` | `session_id?`, `type` (`post_turn`/`reconcile`/`scene_image`/`avatar`/`portrait_variant`/`entity_image`/`embed_refresh`/`image_sweep`), `status` (`queued`/`running`/`done`/`failed`), `runner_id?` (atomic claim), `heartbeat_at`, `payload` JSONB, `error?`, `attempts`, timestamps |
| `events` | `session_id?`, `type`, `payload` JSONB — append-only observability stream (written via `server/events.ts`; the Turn Inspector route reads `retrieval` events by created-at window) |

## Indexes that matter

- `turns(session_id, number)` unique; `turn_messages(turn_id, seq)`; `facts(session_id, status)`; `episodes(session_id, turn_number)`.
- HNSW (`vector_cosine_ops`) on `facts.embedding`, `episodes.embedding`, `lore_chunks.embedding`. The library `search_embedding` columns are unindexed — owner-scoped libraries are small enough to scan.
- `jobs(status, type)` composite index for queue claims.
- A leading-column composite **covers** a plain index on its first column, so don't add both: `session_participants_session_idx` and `participant_relationships_session_idx` were dropped (migration 0006, UX-audit P8) as redundant with the `…_name_unique` / `…_edge_unique` composites that already lead with `session_id`.
- `image_references(scene_image_id)` for grouping a scene's references; `image_references(kind, entity_id)` for the Gallery's "scenes featuring this character" facet.

## Transactional invariants

- The post-turn merge commits all **world-state** writes — participant state, item instances, clock, runtime, brief, and the turn row — in **one transaction** (`engine/merge.ts`). Facts (+supersedence) and the episode are written first through the memory module, each internally transactional; their embeddings degrade per [memory.md](memory.md) instead of failing the merge.
- Fact supersedence updates `status`/`superseded_by_id`/`superseded_at` on the old row in the same transaction as the inserted replacement — the embedding lives on the row, so there is no orphaned-embedding state (a bug class in the old app).
- Session status transitions use compare-and-swap (`WHERE status = 'ready'`) to serialize turn submission.
