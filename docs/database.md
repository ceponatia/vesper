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

- **`users`** — `email` unique, `name`, `role` (`user`/`admin`), `email_verified`, `image?`,
  `banned?`/`ban_reason?`/`ban_expires?` (admin plugin) — Better Auth, see
  [auth.md](auth.md); plus `default_persona_id`, a soft pointer (no FK) to the `personas`
  row new chats start as, the middle rung of `resolveChatPersona`'s ladder. The old
  `player_persona` JSONB blob was backfilled into a persona row (migration 0052) and dropped
  (0053).
- **`auth_sessions` / `accounts` / `verifications`** — Better Auth's
  `session`/`account`/`verification` models (renamed to avoid the game-`sessions`
  collision): signed session tokens, credential+OAuth links, one-time tokens. Owned by the
  library; authored by hand in `schema.ts`, never via Better Auth's own CLI
  ([auth.md](auth.md)).
- **`characters`** — `owner_id`, `name`, `profile` JSONB (`CharacterProfile`: bio,
  personality, voice, speciesId, bodyPlanId, `attributes` (`AttributeValue[]`), aliases,
  defaultOutfit item ids, schedule), `tags` JSONB, `avatar_image_id`, `chat_model`
  (persisted character-chat narrator-model override; empty ⇒ default, migration 0016),
  **`visibility` (`private`/`public`) — cross-account share scope ([auth.md](auth.md))**,
  `cloned_from_id?` (soft remix provenance), `search_embedding` vector.
- **`personas`** — `owner_id`, **`title` — UNIQUE per owner
  (`personas_owner_title_unique`, migration 0051)**, `name`, `profile` JSONB
  (`PersonaProfile`: bio, voice, intimacy, species/heritage/bodyPlan, `intimateRegions`,
  `bodyFeatures`, `attributes`, `outfits`), `tags` JSONB, `avatar_image_id`,
  `search_embedding` vector.
  - **The player as a library entity** (`persona-library.plan.md`) — who *you* are in a
    chat, with a body and a wardrobe; the graduated successor to the single inline
    `users.player_persona` blob.
  - `title` is the library label whose per-owner uniqueness lets `name` repeat across
    personas ("Brian, 22" / "Brian, 40" are both named Brian); it is a database/UX concern
    only and never reaches a prompt — `PlayerPersona`, the shape every prompt consumer
    reads, has no `title` field. `id` stays the PK so a rename can't orphan FKs.
  - **No `visibility`/`cloned_from_id`** — a persona is *you*, so there is no public tier
    (every read is owner-strict; `searchLibraryIds` is called with `scope: "owned"`, the one
    scope that doesn't reference `visibility`). Not a row in `characters`: a "self"
    character would clutter every library list and need a `kind` discriminator plus
    filtering everywhere.
- **`locations`** — `owner_id`, `name`, `description`, `ambient` JSONB (sensory), `scale`
  (`intimate`/`room`/`hall`/`open`/`expanse`), `area?` (map-grouping label), `affordances`
  JSONB, `tags` JSONB, `image_id`, `visibility`, `cloned_from_id?`, `search_embedding`
  vector.
- **`location_links`** — `owner_id`, `from_location_id`, `to_location_id` (FK-cascade),
  `travel_minutes` — undirected library connections between locations (one row per pair).
  `travel_minutes` is defaulted and unread, reserved for the parked authored travel-duration
  plan; retain and annotate it rather than dropping/recreating the column.
- **`items`** — `owner_id`, `kind` (`clothing`/`object`/`container`), `name`, `description`,
  `definition` JSONB (`ItemDefinition` extras: coverage, layer, opacity, sensory, fields),
  `tags` JSONB, `image_id`, `visibility`, `cloned_from_id?`, `search_embedding` vector.
- **`social_cards`** — `owner_id`, `name`, `description`, `definition` JSONB
  (`SocialReactionCard` extras: kind, triggers, severity, defaultReaction,
  reactionOverrides), `tags` JSONB, `visibility`, `cloned_from_id?`, `search_embedding`
  vector (migration 0014). The reusable **card library** (`social-reaction-cards.plan.md`) —
  full CRUD at `/api/social-cards` (+ `/clone`, owner-or-public reads, semantic search via
  the shared `searchLibraryIds` `scope`), the `/social-cards` page + builder, and the
  All/Public/Owned discovery gallery. A character's selected cards live **inline** as
  snapshot copies on `characters.profile.socialCards` (no join/instance table); import
  snapshots a library row into that array, save-to-library is the reverse.

### Successor simulation authority (E2.2–E2.5)

These `sim_*` tables are an isolated successor-engine authority catalog; they do not
dual-write the character-chat rows.

- **`sim_worlds`** — explicit world ID, world type, opaque deterministic seed, ruleset
  version, lifecycle status.
- **`sim_branches`** — world ID, head sequence, optimistic version, integer story second;
  the row is the branch sequencer lock. **E2.5 ancestry (spec §29.3):**
  `origin_story_second` (seed clock for roots, fork clock for children), nullable
  `parent_branch_id` + `fork_sequence` + fork provenance (parent ruleset/event-schema
  versions, forking principal, reason, inherited snapshot checksum) — all-or-nothing per the
  `sim_branches_fork_shape` CHECK; `(parent_branch_id, world_id)` FK forces same-world
  parentage (`NO ACTION`, so a world cascade removing parent and child together still
  settles).
- **`sim_commands`** — full parsed envelope plus exhaustive accepted/rejected/conflict
  result; primary key `(branch_id, idempotency_key)`.
- **`sim_events`** — immutable schema-versioned event envelope; event ID globally unique and
  `(branch_id, sequence)` unique.
- **`sim_characters`** — minimum actor identity facts (the E2.2 `observed_container_ids`
  stand-in was dropped in 0070 — §20 observations own perception).
- **`sim_items`** (reworked E5.3, migrations 0069/0070) — stable branch-local item identity
  plus authored material facts: `material_kind_key`, `owner_actor_id` (ownership distinct
  from holding, §26.3), and the container config (`container_capacity_count` +
  `container_access` — containers are items, §26.2).
- **`sim_item_holdings`** (reworked E5.3) — exactly one row per branch/item, the §26.1
  one-locus invariant as the primary key, holding a typed locus (`locus_kind`
  held/worn/container/zone/gone with per-kind shape CHECKs and composite FKs to
  characters/items/zones, all `DEFERRABLE INITIALLY DEFERRED` for world-cascade ordering)
  and the last event sequence. `sim_holding_containers` (the Gate 1 pseudo-container
  stand-in) was dropped in 0070.
- **`sim_outbox`** (E2.3) — one delivery obligation per accepted event and consumer kind;
  unique `(consumer_kind, branch_id, source_event_id)` makes publication idempotent.
- **`sim_consumer_checkpoints`** (E2.3) — greatest applied source sequence per consumer and
  branch; progress metadata, not authority. Since E2.5 the consumer's gap guard is defined
  over **its own obligation events** (an unapplied earlier `item_transferred` event blocks),
  never over raw sequence density — other families advance the branch without creating feed
  work.
- **`sim_item_transfer_feed`** (E2.3; v2 in E5.3) — first disposable async projection: one
  row per material item event (`event_kind` transferred/destroyed with
  `from_locus`/`to_locus`, feed schema v2); never read by command validation.
- **`sim_triggers`** (E2.4) — durable future-evaluation requests: due story second,
  immutable `stable_order` tie-break, branch-unique `uniqueness_key`, lease/attempt
  coordination, and the scheduler `derivation_version` that produced the terminal outcome.
  **Since E2.5 a trigger row is only ever created by applying a committed `trigger_scheduled`
  event** (`applyTriggerScheduledEvent`), live or on fork replay — never by direct insert.
- **`sim_snapshots`** (E2.5) — replay checkpoints (spec §10.4): branch, projection kind,
  sequence, projection schema + ruleset versions, deterministic checksum, source event
  range, and the full projection payload so replay resumes there instead of walking to the
  root; unique `(branch_id, projection_kind, sequence)`.
- **`sim_locations` / `sim_zones` / `sim_links`** (E3.1) — authoritative topology per branch:
  locations with a default access policy, zones with a privacy policy, links with travel
  modes, minimum duration, access policy, and state.
- **`sim_physical_loci`** (E3.1) — exactly one physical locus per branch/actor (`at` a zone
  or `in_transit` on a link); the one-body invariant is the primary key.
- **`sim_journeys`** (E3.1) — committed travel: route link ids, departure/arrival seconds,
  status (`planned`/`arrived`/`abandoned`…); arrival re-validated at fire time by an E2.4
  trigger.
- **`sim_action_definitions` / `sim_activities`** (E3.2) — authored action vocabulary and
  running activity instances with the §16.3 phase machine; body/attention claims live on the
  activity row (no orphanable claim rows).
- **`sim_commitments` / `sim_temporal_pressures`** (E3.3) — obligations with the flexibility
  dial and §15.4 status machine; live pressure rows carry noticeAt/decideBy/actBy (actBy =
  latest departure, recomputed from the fire-time route).
- **`sim_engagements`** (E3.4) — conversations as attention reservations: participants,
  channel, §18.2 state, and the attention claim; one co-present scene per body enforced at
  open.
- **`sim_access_grants`** (E3.5, migration 0062) — authored entry rights (owner/resident/key…)
  scoped to a location and optionally zones, with validity/revocation seconds; malformed
  rows fail closed — they admit no one. `sim_worlds.permits_trespass` (same migration) gates
  explicit forced entry per world.
- **`sim_observations`** (E4.1, migration 0063) — the §20 perception log: one row per (event,
  witness) with channel, evidence class, fixed-point confidence, detail tier, and derivation
  version. Derived deterministically from the event stream at command commit (every store's
  transaction ends by recording who perceived its events), so replay/fork mints identical
  rows; no FK to `sim_events` because a fork child holds observations for ancestor-branch
  events it reads by reference.
- **`sim_assertions`** (E4.2, migration 0064) — the §21.1 claim ledger: a proposition made on
  a branch, possibly false (canon truth stays in `sim_events`), with `proposition_key`,
  `subject_ids`, `claimed_value`, source actor/event, validity interval
  (`valid_from`/`valid_until`), and status (`active`/`contradicted`/`superseded`/`retracted`).
  Derived deterministically from disclosure events (the id embeds the originating event), so
  a rebuilt/forked branch mints identical rows; no FK to `sim_events` for the same reason as
  `sim_observations`.
- **`sim_beliefs`** (E4.2, migration 0064) — the §21.2 held stance: one actor's position
  toward an assertion — fixed-point confidence, `basis_observation_ids`, the
  `learned_from_actor_ids` gossip chain, believed interval, status
  (`active`/`doubted`/`rejected`/`superseded`). Composite FK `(branch_id, assertion_id)` →
  `sim_assertions`; superseded rows keep their history, the active row is the current stance.
- **`sim_narrative_cuts`** (E4.3, migration 0065) — the §22 persisted NarrativeCut,
  **immutable and addressable**, one per (engagement, viewpoint): `compiler_version` +
  `semantic_hash`, branch version, sequence/story-second window, and the full parsed cut as
  `content` (the row IS the render input, bit for bit). No update path and no `updated_at` —
  recompiling the same cut id must reproduce `semantic_hash` or fail with a version
  diagnostic (§22.3); rerender re-reads the row and creates nothing.
- **`sim_soft_canon`** (E4.3, migration 0065) — the §23.4 bounded, expiring store of
  narrator-established details: `key` + `scope`
  (`scene`/`relationship`/`character`/`location`/`world`) + `subject_ids` + `value`,
  fixed-point confidence, `source_cut_ids`, and status (`active`/`promoted`/`demoted`) as
  audited moves. Expiry is read-time (`valid_until`), never a status write. Derived — every
  `soft_canon_*` event carries its full post-fold snapshot, so live upsert and fork replay
  mint identical rows.
- **`sim_memory_documents`** (E4.4, migration 0066) — the §24 redacted, indexable recall
  representation, derived from persisted source rows by the memory-index outbox consumer:
  `source_kind` (`observation`/`assertion`/`belief`/`speech_act`/`soft_canon`/`authored_lore`)
  + `source_id`, sequence interval, `visibility` (`public`/`actors`/`belief_holders`) +
  `eligible_actor_ids`/`about_entity_ids`, validity + supersedence seconds,
  `epistemic_label`, optional fixed-point confidence, redacted `text`, and an `embedding`
  vector(1536) with a named `embedding_model` (both-or-neither CHECK). Never widens what a
  viewpoint may see — eligibility/validity/privacy are resolved relationally at query time
  (§24.1); a missing or stale row only narrows recall.
- **`sim_body_meters`** (E5.1, migration 0067) — the §25.2 continuous substrate: one row per
  actor × meter with a fixed-point `value` (10000 ≡ 1.0) + `baseline` and
  `last_integrated_at` (the last **material** write). Queries integrate analytically from
  there and never persist, which makes partition invariance structural; `registry_version`
  stamps the meter registry. PK `(branch_id, actor_id, meter_key)`.
- **`sim_body_conditions`** (E5.1, migration 0067; `ended_at` added 0068) — the §25.1
  categorical, sourced, self-expiring states: `key`
  (`asleep`/`collapsed`/`afterglow`/`groggy`/`wired`/`ill`), `onset_at`/`expires_at`, status
  (`active`/`ended`) + `end_basis` (`expired`/`cleared`) matched by CHECK, and `ended_at`
  (added 0068) recording when it actually ended.
- **`sim_body_modifiers`** (E5.1, migration 0067) — the §25.3 single modifier contract: actor
  × `meter_key` with an `operation` JSONB (`add`/`multiply`/`clamp`/`override`/rate change),
  `stacking_group` + `priority`, valid interval, `visibility` (`obvious`/`private`), and an
  optional composite condition FK `(branch_id, condition_id)` → `sim_body_conditions`.
  Validity boundaries are integration boundaries — expiry needs no trigger because the
  piecewise solver already sees `valid_until`.
- **`sim_item_condition_meters`** (E5.3, 0073) — §26.7 wear/cleanliness item meters on the
  §25 kernel: PK `(branch_id, item_id, meter_key)`, fixed-point value/baseline, analytic
  `last_integrated_at`; lazily initialized for `condition_tracked` items.
- **`sim_item_condition_modifiers`** (E5.3, 0073) — §25.3 modifier contract scoped to items
  (worn-window cleanliness drift); operation jsonb, stacking group/priority, validity
  interval, deferrable FK to `sim_items`.
- **`sim_body_rhythms`** (E5.2, migration 0068) — the §25.5 authored, branch-scoped daily
  windows: `kind` (`sleep`/`wash`) as a minute-of-day range (0–1439), copied to fork children
  like action definitions. Sleep windows anchor the circadian curve; wash windows are
  window-crossing self-care. PK `(branch_id, actor_id, kind, start_minute_of_day)`.

`sim_outbox`, `sim_consumer_checkpoints`, `sim_item_transfer_feed`, `sim_snapshots`, and the
lease/attempt columns of `sim_triggers` are **disposable coordination state**. World truth is
`sim_events` plus the synchronous typed projections; these may be rebuilt, requeued, or (for
snapshots) discarded without changing it.

**Branch forks (E2.5).** A fork child stores only its own post-fork rows: ancestor events are
read through the parent chain bounded by `fork_sequence` (`readBranchAncestryEvents`), never
copied. `forkBranch` materializes the child's typed projections and trigger rows by replaying
ancestor events ≤ N through the same projectors that ran live — an alarm whose firing is
already inherited history is recorded `completed`, not re-armed — then checkpoints the fork
point in `sim_snapshots` and starts the child's outbox lane at N via
`sim_consumer_checkpoints`. Rebuild-from-zero (`rebuildDurableBranchProjection`) and
rebuild-from-snapshot must both hash-match the live projection; CI's `test:engine-e2-5`
enforces it so a wrong snapshot cannot hide a replay defect.

Domain identities are supplied explicitly instead of replaced by cuid2 row identities.
Causal bigint columns are database-checked against JavaScript's safe integer range.
Composite foreign keys prevent cross-world events and dangling item/container holdings. The holding-to-container `NO ACTION` key is manually `DEFERRABLE INITIALLY DEFERRED` in migration 0054 because Drizzle cannot model that PostgreSQL option: standalone live-container deletion still fails, while complete branch/world cascades can settle before the check.

### Character chat & memory

The character-chat lane's own tables (`character_chats` — one conversation, with its rolling summary, clock, plans, and roster; `chat_participants` — the character(s) in a conversation + the `memory_group_id` scope key; `chat_messages` — the transcript; `character_chat_state` — the per-participant tracked state, meters, conditions, wardrobe, scene memory; `chat_presets` — reusable scenario presets; `chat_visual_memory` — per-observer recognizable-feature notice/mention history, PK `(memory_group_id, viewpoint_id, subject_id)`, two-generation rows so a retake recomputes from the identical pre-exchange memory; `chat_contact_events` — the durable contact-provenance ledger, migration 0093: one row per lifecycle commit keyed by the exchange guard message id, idempotent on `(chat_id, event_ref, sequence)`, pruned by guard on a retake, with the versioned active-contact projection riding `character_chats.scene` as its replayable cache; `chat_npc_scene_decisions` — the NPC reply-scene decision envelope, migration 0094: one row per assistant message (unique `(chat_id, assistant_message_id)`, both FKs cascade), a durable tombstone for every outcome — trigger miss, degraded, evaluated — carrying reply/digest hashes, pre/post scene fingerprints, and a bounded payload; written only by the guarded CAS transaction in `chat-npc-scene-envelope.ts`, pruned unconditionally on a retake, and read newest-first by the dev inspector as the decision trace) are covered by [character-chat/](character-chat/README.md). The memory tables below are keyed to a chat memory group.

- **`episodes`** — `chat_memory_group_id` (scope key), `turn_number` (per-group exchange
  ordinal), `summary`, `witnessed_by` JSONB (see [memory.md](memory.md)),
  `source_message_id?` (chat provenance — the assistant message summarized), `embedding`
  vector, `embedder`.
- **`facts`** — `chat_memory_group_id` (scope key), `kind`, `verb?`, `subject_kind`,
  `subject_id?`, `subject_name` (stored lowercased), `text`, `tags` JSONB, `confidence` real,
  `canon` bool (default true; reserved), `pinned` bool (player/dev "remember this" — see
  [memory.md](memory.md) §Pinned facts), `origin` (`extracted`/`player`/`dev`),
  `witnessed_by` JSONB, `status` (`active`/`superseded`/`retracted`), `superseded_by_id?`,
  `source_message_id?` (chat provenance — the assistant message extracted from), `embedding`
  vector, `embedder`, `superseded_at?`.

`episodes` and `facts` are keyed to a **character-chat memory group** (`chat_memory_group_id`; see [memory.md](memory.md) §Memory keying) — the only scope column either table carries.

Every embedding-bearing table carries `embedder` (`"<model-id>"` or `"pseudo"`). Similarity queries always filter `embedder = currentEmbedder()` — pseudo (demo) vectors and real vectors never compare against each other, and an embedding-model change degrades to reduced recall (+ an `embed_refresh` job can re-embed) instead of silently corrupted thresholds.

### Infrastructure

- **`images`** — `owner_id`, `kind`
  (`avatar`/`portrait_variant`/`scene`/`entity`/`chat_upload`/`chat_look`/`chat_place`/`identity_face_crop`/`identity_trial_output`/`lab_control`/`lab_output`
  — the chat kinds are chat-private and hard-deleted with the chat; the last four are hidden
  derived assets excluded from every user surface via `HIDDEN_IMAGE_KINDS`: identity-pack
  crops, identity-trial outputs, and the Advanced Image Lab's control fixtures and results,
  see images/asset-registry.md and images/advanced-image-lab.md), `entity_kind?` (`character`/`location`/`item` — set for `entity` images;
  always `character` for `avatar`/`portrait_variant`; app convention, not a constraint),
  `entity_id?`, `chat_id?` (→ `character_chats`, SET NULL on chat delete — chat-scene keying,
  see images/pipelines.md), `anchor_message_id?` (the assistant line a chat scene illustrates; plain
  text, no FK), `path` (relative to `data/`), `prompt`, `source_image_id?` (reference-edit
  lineage), `status` (`pending`/`ready`/`failed` — row is written **before** the file; see
  images/asset-registry.md), `meta` JSONB.
- **`image_references`** — `scene_image_id` (→ `images`, **FK-cascade**), `kind`
  (`character`/`location`/`style`/`pose`/`layout`), `entity_id?` (library character/location
  id; null for non-entity roles), `role?`, `source?`
  (`generated`/`uploaded`/`composite`/`entity`; null = unknown), `image_id?` (the reference
  asset actually fed to a provider; null when textual-only), `name`. One row per reference a
  scene image featured — the authoritative, queryable record that replaced
  `images.meta.references` (scene-images.spec.md §4; the Gallery reads it).
  `SceneVisualReference` is the render-input superset, `SceneReference` the Gallery
  projection (packages/image-core/src/references/scene-reference.ts).
- **`image_lab_experiments`** — the Advanced Image Lab's durable experiment record
  (images/advanced-image-lab.md): `owner_id` (→ `users`, **FK-cascade**), `kind`
  (`control_probe`/`baseline_portrait`/`baseline_scene`, later stages reserved), `character_id?`
  / `chat_id?` (SET NULL), `model_slug`, `requested_version_id?` / `executed_version_id?`,
  `profile_id?` (plain snapshot, no FK — a deleted profile must not erase what a finished
  baseline ran), `instruction` + `final_prompt`, `inputs` JSONB (ordered role-tagged image
  list), `control_image_id?` / `result_image_id?` (→ `images`, SET NULL), `control_kind?`,
  `settings` JSONB, `status` (`pending`/`running`/`succeeded`/`failed`), `failure_code?`,
  `verdict?` + `verdict_note?` (probe kinds), `prediction_id?`, `started_at?`/`finished_at?`,
  `meta` JSONB; indexed `(owner_id, created_at)` for the lab listing.
- **`image_models`** — `slug` **unique** (the Replicate model path, optionally
  `owner/name:version`), `label`, `sort`, `builtin` (display provenance only — it does
  **not** gate deletion).
  - Probed from Replicate at save time: `can_generate`, `can_edit`, `reference_field`,
    `reference_arity`, `aspect_mode`, `supported_aspects` JSONB, `output_format?`,
    `extra_input` JSONB, `probed_version_id?` (the version those fields were read from).
  - Owner-set and **never** overwritten by a re-probe: `max_references` (no model declares
    `maxItems`), `reference_transport` (`file`/`data_url` — only found by running the model),
    the `for_portrait`/`for_variant`/`for_scene` surface toggles, and the reviewed judgments
    `edit_kind` (`none`/`instruction_edit`/`multi_reference_compose`/`img2img`/`unknown`),
    `identity_preservation` (`strong`/`moderate`/`weak`/`unknown`) and `operator_warning?`.
  - `advanced_capabilities` JSONB is reserved for probed control bindings and is `{}` today.
    Which models the app can run is **data, not a code union** — managed at
    `/settings/image-models`, seeded by migrations 0098 and 0104 (see
    [images/providers.md](images/providers.md)).
- **`image_model_profiles`** — `image_model_id` (→ `image_models`, **FK-cascade**), `key`
  (**unique per model**), `label`, `task`
  (`portrait`/`variant`/`scene`/`item`/`location`/`chat_look`/`chat_place`/`text_repair`/`example_transform`/`image_set`),
  `operation` (`generate`/`edit`), `prompt_strategy`, `reference_policy` JSONB
  (allowed/required roles and their order), `control_defaults` JSONB (normalized controls +
  seed policy; never a stored numeric seed), `provider_overrides` JSONB, `timeout_ms?`
  (30s–15min, CHECK-bounded), `enabled`, `is_default`, `builtin`, `sort`. **How** a model
  should be used for one job, as opposed to what it accepts — one Seedream row can be an
  everyday 2K scene and a slow 4K location. At most one enabled default per task, enforced by
  the partial unique index below. Seeded with 17 built-ins by migration 0100 and 5 more by
  0104.
- **`image_identity_packs`** — `character_id` (→ `characters`, **FK-cascade** — operational
  character data, dies with the character), `revision` (**unique per character**), `current`,
  `status` (`pending`/`ready`/`unusable`/`failed`/`stale`/`superseded`), `source_image_id?`
  (→ `images`, SET NULL safety net — a null source is immediately unusable),
  `source_content_hash` (SHA-256 over the stored normalized bytes),
  `source_width`/`source_height`, `schema_version`/`derivation_version`/`policy_version`,
  `method?` (`detector`/`heuristic`/`manual`), `detector_version?`, `confidence?`,
  `face_crop_image_id?` (→ `images`, SET NULL — the hidden `identity_face_crop` asset),
  `crop_json`/`quality_json`/`warning_codes_json` JSONB,
  `failure_code?`/`failure_message?`, `reviewed_by_user_id?` (→ `users`, no cascade — audit
  survives the reviewer), `review_reason?`/`reviewed_at?`. One durable identity reference per
  character: revisions are rows, exactly one may be `current` (partial unique index below).
  See [images/identity-packs.md](images/identity-packs.md) and image-identity-packs.spec.data.md. Added by
  migration 0101.
- **`image_identity_pack_trial_runs`** — `owner_id` (→ `users`, cascade), `label`, `status`
  (`draft`/`running`/`review`/`complete`), `config_json` JSONB — the validated create-request
  snapshot, so a later registry or profile edit can never change what a finished run claims
  it tested. One bounded admin comparison of identity-reference strategies over a character ×
  profile × strategy × fixture grid; the three tables below FK-cascade with their run. See
  [images/identity-packs.md](images/identity-packs.md) §The fixed-trial harness and
  image-identity-packs.spec.trial.md. Added by migration 0102.
- **`image_identity_pack_trial_cells`** — `run_id` (→ runs, **FK-cascade**), `cell_key`
  (**unique per run** — the deterministic `character:profile:fixture:strategy:variant` plan
  key; plain ascending order is the execution order), `status`
  (`planned`/`running`/`rendered`/`failed`/`refused`), `spec_json`/`result_json?` JSONB,
  `output_image_id?` (→ `images`, SET NULL — a deleted output makes the cell unreviewable,
  not invalid), `claim_token?`/`claimed_at?` — the durable execution claim (compare-and-set
  `planned`→`running`→terminal), so a restart mid-pass can't pay the provider twice for one
  cell's evidence.
- **`image_identity_pack_trial_grades`** — `run_id`/`cell_a_id`/`cell_b_id` (all
  **FK-cascade**), `pair_id` (**unique per run** — insert-once, so a double submission fails
  loudly instead of averaging), `left_is_a` (the persisted blind left/right↔A/B mapping;
  unblinded only in aggregation), `grades_json` JSONB, `reviewed_by_user_id?` (→ `users`, no
  cascade — audit survives the reviewer).
- **`image_identity_pack_trial_verdicts`** — `run_id` (**FK-cascade**), `profile_id` +
  `identity_strategy` (**unique per run** — one ruling per slot, upserted; replaced the run
  row's jsonb verdict array, whose read-modify-write let two admins ruling on different slots
  silently lose one), `verdict`
  (`promoted`/`retained_current`/`experimental_admin_only`/`rejected`), `reason` (required),
  `policy_version`, `override_incomplete_review` (the admin ruled before every reviewable
  pair was graded — unrecoverable once more grades arrive, so stored on the ruling),
  `decided_by_user_id` (→ `users`, no cascade, **not null** — a ruling with no actor is not
  an audit record), `decided_at`. Added by migration 0103.
- **`jobs`** — `type`
  (`chat_summary`/`chat_scene_sketch`/`chat_meanwhile`/`chat_scene_image`/`avatar`/`portrait_variant`/`entity_image`/`embed_refresh`/`image_sweep`/`identity_pack`/…
  — see the schema enum for the full list), `status` (`queued`/`running`/`done`/`failed`),
  `runner_id?` (atomic claim), `heartbeat_at`, `payload` JSONB, `error?`, `attempts`,
  timestamps.
- **`events`** — `type`, `payload` JSONB; append-only observability stream (written via
  `server/events.ts`; the chat inspector reads `retrieval` / `agent_failure` / `agent_run`
  events by created-at window).

## Indexes that matter

- `facts(chat_memory_group_id, status)`; `episodes(chat_memory_group_id, turn_number)` — the memory-scope lookups.
- HNSW (`vector_cosine_ops`) on `facts.embedding`, `episodes.embedding`. The library `search_embedding` columns are unindexed — owner-scoped libraries are small enough to scan.
- `jobs(status, type)` composite index for queue claims.
- `image_references(scene_image_id)` for grouping a scene's references; `image_references(kind, entity_id)` for the Gallery's "scenes featuring this character" facet.
- `image_model_profiles(task) WHERE is_default and enabled` — a **partial** unique index, so
  two rows can never both claim to be a task's default. The composite
  `image_model_profiles(image_model_id, key)` unique doubles as the per-model lookup index,
  so there is no separate one.
- `image_identity_packs(character_id) WHERE current` — the same partial-unique device, holding
  the one-current-pack-per-character invariant at the storage layer. The composite
  `image_identity_packs(character_id, revision)` unique doubles as the per-character lookup;
  `image_identity_packs(character_id, source_content_hash, schema_version, derivation_version, revision)`
  is the derivation-key coalescing/diagnostic lookup.
- `image_identity_pack_trial_cells(run_id, status)` — the execute path's "which cells of this
  run are still planned" hot filter. The per-run composite uniques — cells `(run_id, cell_key)`,
  grades `(run_id, pair_id)`, verdicts `(run_id, profile_id, identity_strategy)` — double as
  the per-run lookups, so no separate ones exist.
- Successor authority: `sim_events(branch_id, sequence)` unique,
  `sim_commands(branch_id, idempotency_key)` primary, command-ID audit lookup, and the
  `sim_item_holdings` locus lookups (`branch_id` × `container_item_id` for §26.2
  capacity/occupant scans, × `actor_id`, × `zone_id`).
- Scheduler: `sim_triggers(state, available_at, due_story_second, stable_order)` for the
  claim scan and `sim_triggers(branch_id, due_story_second, stable_order)` for per-branch
  drains. `(branch_id, uniqueness_key)` makes scheduling idempotent; `(branch_id, stable_order)`
  keeps simultaneous triggers totally ordered.

## Transactional invariants

- E2.2 `submitDurableItemTransfer` performs the idempotency recheck, pure resolution,
  event append, exclusive holding update, branch compare-and-swap advance, and durable
  command result under one `FOR UPDATE OF sim_branches` transaction. The joined world row is metadata, not a sibling-branch mutex. No model, network
  callback, or wall-clock-derived simulation decision is allowed under that lock. The typed branch reader uses a read-only `REPEATABLE READ` transaction so head, projection rows, and events share one snapshot.
- E2.4 `resolveNextDueTrigger` claims a trigger and increments its attempt count in one
  transaction, then resolves it through that same `submitDurableItemTransfer` transaction.
  Attempts increment at **claim** time, not at failure time: a worker that dies mid-resolution
  never runs its own failure path, so whoever next claims an exhausted trigger retires it —
  otherwise a crash loop reclaims forever and never reaches `maxAttempts`. Every terminal write
  is fenced on `(id, state='processing', lease_owner=workerId)`, so a worker whose lease expired
  cannot overwrite its successor's state.
- A scheduler command is admitted at the branch version read **under the branch lock**
  (`admitAtLockedVersion`), never at a version pre-read outside the transaction. A trigger's
  idempotency key is permanent, so an optimistic conflict would be *stored under that key* and
  replayed by every later retry — poisoning the trigger forever rather than delaying it. This
  is safe precisely because the scheduler has no stale read to protect: it holds a lease over a
  payload committed when the trigger was scheduled.
- The chat lane's post-turn finalize writes the state row, then facts (+supersedence) and the episode through the memory module, each internally transactional; their embeddings degrade per [memory.md](memory.md) instead of failing the exchange ([character-chat/pipeline.md](character-chat/pipeline.md)).
- Fact supersedence updates `status`/`superseded_by_id`/`superseded_at` on the old row in the same transaction as the inserted replacement — the embedding lives on the row, so there is no orphaned-embedding state (a bug class in the old app).
