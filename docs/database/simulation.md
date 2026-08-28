# Successor simulation authority

The `sim_*` tables are an isolated successor-engine authority catalog; they do not dual-write the
character-chat rows. Their behavior is [../engine/README.md](../engine/README.md).

## World, branch, command, event

- **`sim_worlds`** — explicit world ID, world type, opaque deterministic seed, ruleset version,
  lifecycle status. `permits_trespass` gates explicit forced entry per world.
- **`sim_branches`** — world ID, head sequence, optimistic version, integer story second; the row
  is the branch sequencer lock. Ancestry: `origin_story_second` (seed clock for roots, fork clock
  for children), nullable `parent_branch_id` + `fork_sequence` + fork provenance (parent
  ruleset/event-schema versions, forking principal, reason, inherited snapshot checksum) —
  all-or-nothing per the `sim_branches_fork_shape` CHECK. `(parent_branch_id, world_id)` FK forces
  same-world parentage (`NO ACTION`, so a world cascade removing parent and child together still
  settles).
- **`sim_commands`** — the full parsed envelope plus an exhaustive accepted/rejected/conflict
  result; primary key `(branch_id, idempotency_key)`.
- **`sim_events`** — the immutable schema-versioned event envelope; event ID globally unique and
  `(branch_id, sequence)` unique.
- **`sim_characters`** — minimum actor identity facts.

## Material items

- **`sim_items`** — stable branch-local item identity plus authored material facts:
  `material_kind_key`, `owner_actor_id` (ownership distinct from holding), and the container
  config (`container_capacity_count` + `container_access` — containers are items).
- **`sim_item_holdings`** — exactly one row per branch and item, the one-locus invariant as the
  primary key, holding a typed locus (`locus_kind` held/worn/container/zone/gone, with per-kind
  shape CHECKs and composite FKs to characters, items and zones, all
  `DEFERRABLE INITIALLY DEFERRED` for world-cascade ordering) and the last event sequence.

## Delivery and projection

- **`sim_outbox`** — one delivery obligation per accepted event and consumer kind; unique
  `(consumer_kind, branch_id, source_event_id)` makes publication idempotent.
- **`sim_consumer_checkpoints`** — the greatest applied source sequence per consumer and branch;
  progress metadata, not authority. The consumer's gap guard is defined over **its own obligation
  events** — an unapplied earlier `item_transferred` event blocks — never over raw sequence
  density, so other families advance the branch without creating feed work.
- **`sim_item_transfer_feed`** — the first disposable async projection: one row per material item
  event (`event_kind` transferred/destroyed with `from_locus`/`to_locus`, feed schema v2); never
  read by command validation.
- **`sim_snapshots`** — replay checkpoints: branch, projection kind, sequence, projection schema
  and ruleset versions, deterministic checksum, source event range, and the full projection
  payload so replay resumes there instead of walking to the root; unique
  `(branch_id, projection_kind, sequence)`.

`sim_outbox`, `sim_consumer_checkpoints`, `sim_item_transfer_feed`, `sim_snapshots`, and the
lease and attempt columns of `sim_triggers` are **disposable coordination state**. World truth is
`sim_events` plus the synchronous typed projections; these may be rebuilt, requeued, or (for
snapshots) discarded without changing it.

## Scheduling

- **`sim_triggers`** — durable future-evaluation requests: due story second, immutable
  `stable_order` tie-break, branch-unique `uniqueness_key`, lease and attempt coordination, and
  the scheduler `derivation_version` that produced the terminal outcome. A trigger row is only
  ever created by applying a committed `trigger_scheduled` event (`applyTriggerScheduledEvent`),
  live or on fork replay — never by direct insert.

## Topology, travel, activity

- **`sim_locations` / `sim_zones` / `sim_links`** — authoritative topology per branch: locations
  with a default access policy, zones with a privacy policy, links with travel modes, minimum
  duration, access policy, and state.
- **`sim_physical_loci`** — exactly one physical locus per branch and actor (`at` a zone or
  `in_transit` on a link); the one-body invariant is the primary key.
- **`sim_journeys`** — committed travel: route link ids, departure and arrival seconds, status
  (`planned`/`arrived`/`abandoned`…); arrival is re-validated at fire time by a trigger.
- **`sim_action_definitions` / `sim_activities`** — the authored action vocabulary and running
  activity instances with the phase machine; body and attention claims live on the activity row,
  so there are no orphanable claim rows.
- **`sim_commitments` / `sim_temporal_pressures`** — obligations with the flexibility dial and
  status machine; live pressure rows carry noticeAt / decideBy / actBy (actBy = latest departure,
  recomputed from the fire-time route).
- **`sim_engagements`** — conversations as attention reservations: participants, channel, state,
  and the attention claim; one co-present scene per body, enforced at open.
- **`sim_access_grants`** — authored entry rights (owner, resident, key…) scoped to a location and
  optionally zones, with validity and revocation seconds; malformed rows fail closed and admit no
  one.

## Perception, belief, narration

- **`sim_observations`** — the perception log: one row per (event, witness) with channel, evidence
  class, fixed-point confidence, detail tier, and derivation version. Derived deterministically
  from the event stream at command commit — every store's transaction ends by recording who
  perceived its events — so replay and fork mint identical rows. No FK to `sim_events`, because a
  fork child holds observations for ancestor-branch events it reads by reference.
- **`sim_assertions`** — the claim ledger: a proposition made on a branch, possibly false (canon
  truth stays in `sim_events`), with `proposition_key`, `subject_ids`, `claimed_value`, source
  actor and event, validity interval (`valid_from` / `valid_until`), and status
  (`active`/`contradicted`/`superseded`/`retracted`). Derived deterministically from disclosure
  events — the id embeds the originating event — so a rebuilt or forked branch mints identical
  rows; no FK to `sim_events`, for the same reason as `sim_observations`.
- **`sim_beliefs`** — the held stance: one actor's position toward an assertion — fixed-point
  confidence, `basis_observation_ids`, the `learned_from_actor_ids` gossip chain, believed
  interval, status (`active`/`doubted`/`rejected`/`superseded`). Composite FK
  `(branch_id, assertion_id)` → `sim_assertions`; superseded rows keep their history, and the
  active row is the current stance.
- **`sim_narrative_cuts`** — the persisted NarrativeCut, **immutable and addressable**, one per
  (engagement, viewpoint): `compiler_version` + `semantic_hash`, branch version,
  sequence/story-second window, and the full parsed cut as `content` — the row IS the render
  input, bit for bit. There is no update path and no `updated_at`: recompiling the same cut id
  must reproduce `semantic_hash` or fail with a version diagnostic, and rerender re-reads the row
  and creates nothing.
- **`sim_soft_canon`** — the bounded, expiring store of narrator-established details: `key` +
  `scope` (`scene`/`relationship`/`character`/`location`/`world`) + `subject_ids` + `value`,
  fixed-point confidence, `source_cut_ids`, and status (`active`/`promoted`/`demoted`) as audited
  moves. Expiry is read-time (`valid_until`), never a status write. Derived: every `soft_canon_*`
  event carries its full post-fold snapshot, so live upsert and fork replay mint identical rows.
- **`sim_memory_documents`** — the redacted, indexable recall representation, derived from
  persisted source rows by the memory-index outbox consumer: `source_kind`
  (`observation`/`assertion`/`belief`/`speech_act`/`soft_canon`/`authored_lore`) + `source_id`,
  sequence interval, `visibility` (`public`/`actors`/`belief_holders`) + `eligible_actor_ids` /
  `about_entity_ids`, validity and supersedence seconds, `epistemic_label`, optional fixed-point
  confidence, redacted `text`, and an `embedding` vector(1536) with a named `embedding_model`
  (both-or-neither CHECK). It never widens what a viewpoint may see — eligibility, validity and
  privacy are resolved relationally at query time, so a missing or stale row only narrows recall.

## Bodies

- **`sim_body_meters`** — the continuous substrate: one row per actor × meter with a fixed-point
  `value` (10000 ≡ 1.0) plus `baseline` and `last_integrated_at` (the last **material** write).
  Queries integrate analytically from there and never persist, which makes partition invariance
  structural; `registry_version` stamps the meter registry. PK `(branch_id, actor_id, meter_key)`.
- **`sim_body_conditions`** — the categorical, sourced, self-expiring states: `key`
  (`asleep`/`collapsed`/`afterglow`/`groggy`/`wired`/`ill`), `onset_at` / `expires_at`, status
  (`active`/`ended`) plus `end_basis` (`expired`/`cleared`) matched by CHECK, and `ended_at`
  recording when it actually ended.
- **`sim_body_modifiers`** — the single modifier contract: actor × `meter_key` with an `operation`
  JSONB (`add`/`multiply`/`clamp`/`override`/rate change), `stacking_group` + `priority`, valid
  interval, `visibility` (`obvious`/`private`), and an optional composite condition FK
  `(branch_id, condition_id)` → `sim_body_conditions`. Validity boundaries are integration
  boundaries, so expiry needs no trigger — the piecewise solver already sees `valid_until`.
- **`sim_item_condition_meters`** — wear and cleanliness item meters on the meter kernel: PK
  `(branch_id, item_id, meter_key)`, fixed-point value and baseline, analytic
  `last_integrated_at`; lazily initialized for `condition_tracked` items.
- **`sim_item_condition_modifiers`** — the modifier contract scoped to items (worn-window
  cleanliness drift): operation jsonb, stacking group and priority, validity interval, deferrable
  FK to `sim_items`.
- **`sim_body_rhythms`** — the authored, branch-scoped daily windows: `kind` (`sleep`/`wash`) as a
  minute-of-day range (0–1439), copied to fork children like action definitions. Sleep windows
  anchor the circadian curve; wash windows are window-crossing self-care. PK
  `(branch_id, actor_id, kind, start_minute_of_day)`.

## Branch forks

A fork child stores only its own post-fork rows: ancestor events are read through the parent chain
bounded by `fork_sequence` (`readBranchAncestryEvents`), never copied.

`forkBranch` materializes the child's typed projections and trigger rows by replaying ancestor
events ≤ N through the same projectors that ran live — an alarm whose firing is already inherited
history is recorded `completed`, not re-armed — then checkpoints the fork point in `sim_snapshots`
and starts the child's outbox lane at N via `sim_consumer_checkpoints`.

Rebuild-from-zero (`rebuildDurableBranchProjection`) and rebuild-from-snapshot must both hash-match
the live projection; the `test:engine-e2-5` suite enforces it, so a wrong snapshot cannot hide a
replay defect.

## Structural rules

Domain identities are supplied explicitly instead of replaced by cuid2 row identities. Causal
bigint columns are database-checked against JavaScript's safe integer range. Composite foreign keys
prevent cross-world events and dangling item or container holdings.

The holding-to-container `NO ACTION` key is manually `DEFERRABLE INITIALLY DEFERRED` in its
migration because Drizzle cannot model that PostgreSQL option: standalone live-container deletion
still fails, while complete branch and world cascades can settle before the check.
