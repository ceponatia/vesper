# Indexes and transactional invariants

## Indexes that matter

- `facts(chat_memory_group_id, status)` and `episodes(chat_memory_group_id, turn_number)` — the
  memory-scope lookups.
- HNSW (`vector_cosine_ops`) on `facts.embedding` and `episodes.embedding`. The library
  `search_embedding` columns are unindexed — owner-scoped libraries are small enough to scan.
- `jobs(status, type)` — the composite index for queue claims.
- `image_references(scene_image_id)` for grouping a scene's references, and
  `image_references(kind, entity_id)` for the Gallery's "scenes featuring this character" facet.
- `image_model_profiles(task) WHERE is_default and enabled` — a **partial** unique index, so two
  rows can never both claim to be a task's default. The composite
  `image_model_profiles(image_model_id, key)` unique doubles as the per-model lookup index, so
  there is no separate one.
- `image_identity_packs(character_id) WHERE current` — the same partial-unique device, holding the
  one-current-pack-per-character invariant at the storage layer. The composite
  `image_identity_packs(character_id, revision)` unique doubles as the per-character lookup, and
  `image_identity_packs(character_id, source_content_hash, schema_version, derivation_version, revision)`
  is the derivation-key coalescing and diagnostic lookup.
- `character_reference_views(character_id, angle_id, wardrobe) WHERE current` — the same
  partial-unique device, holding the one-current-view-per-slot invariant at the storage layer, so a
  lost reservation race fails loudly instead of leaving a slot with two views the studio must choose
  between. `character_reference_views(character_id, angle_id, wardrobe, created_at)` is the per-slot
  history read, and its leading column doubles as the per-character lookup.
- `image_identity_lora_bindings(identity_pack_id) WHERE state = 'active'` — the same
  partial-unique device, so promoting a second character LoRA for one pack fails loudly instead of
  leaving two rows that both claim to be the character's likeness. The composite
  `image_identity_lora_bindings(identity_pack_id, lora_id)` unique refuses a duplicate binding,
  and `(identity_pack_id, state)` is the per-pack lookup the store reads.
- `image_identity_pack_trial_cells(run_id, status)` — the execute path's "which cells of this run
  are still planned" hot filter. The per-run composite uniques — cells `(run_id, cell_key)`,
  grades `(run_id, pair_id)`, verdicts `(run_id, profile_id, identity_strategy)` — double as the
  per-run lookups, so no separate ones exist.
- Successor authority: `sim_events(branch_id, sequence)` unique,
  `sim_commands(branch_id, idempotency_key)` primary, the command-ID audit lookup, and the
  `sim_item_holdings` locus lookups (`branch_id` × `container_item_id` for capacity and occupant
  scans, × `actor_id`, × `zone_id`).
- Scheduler: `sim_triggers(state, available_at, due_story_second, stable_order)` for the claim
  scan and `sim_triggers(branch_id, due_story_second, stable_order)` for per-branch drains.
  `(branch_id, uniqueness_key)` makes scheduling idempotent, and `(branch_id, stable_order)` keeps
  simultaneous triggers totally ordered.

## Transactional invariants

- `submitDurableItemTransfer` performs the idempotency recheck, pure resolution, event append,
  exclusive holding update, branch compare-and-swap advance, and durable command result under one
  `FOR UPDATE OF sim_branches` transaction. The joined world row is metadata, not a
  sibling-branch mutex. No model, network callback, or wall-clock-derived simulation decision is
  allowed under that lock.
- Every public multi-query simulation reader (`readDurable*`, `explainItemPlacement`) owns one
  read-only `REPEATABLE READ` transaction, so its head, projection rows, and events describe one
  committed state. A lower-level multi-query loader (`load*Projection`, `assembleBranchState`)
  requires the caller's transaction and never opens its own — a transaction inside a transaction
  is a savepoint, not a snapshot. No transaction stays open across a model call or a command
  submission.
- `resolveNextDueTrigger` claims a trigger and increments its attempt count in one transaction,
  then resolves it through that same `submitDurableItemTransfer` transaction. Attempts increment
  at **claim** time, not at failure time: a worker that dies mid-resolution never runs its own
  failure path, so whoever next claims an exhausted trigger retires it — otherwise a crash loop
  reclaims forever and never reaches `maxAttempts`. Every terminal write is fenced on
  `(id, state='processing', lease_owner=workerId)`, so a worker whose lease expired cannot
  overwrite its successor's state.
- A scheduler command is admitted at the branch version read **under the branch lock**
  (`admitAtLockedVersion`), never at a version pre-read outside the transaction. A trigger's
  idempotency key is permanent, so an optimistic conflict would be *stored under that key* and
  replayed by every later retry — poisoning the trigger forever rather than delaying it. This is
  safe precisely because the scheduler has no stale read to protect: it holds a lease over a
  payload committed when the trigger was scheduled.
- The chat lane's post-turn finalize writes the state row, then facts (plus supersedence) and the
  episode through the memory module, each internally transactional; their embeddings degrade per
  [../memory.md](../memory.md) instead of failing the exchange
  ([../character-chat/post-turn.md](../character-chat/post-turn.md)).
- Fact supersedence updates `status` / `superseded_by_id` / `superseded_at` on the old row in the
  same transaction as the inserted replacement — the embedding lives on the row, so there is no
  orphaned-embedding state.
