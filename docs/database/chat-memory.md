# Character chat and memory tables

The chat lane's own tables are covered by
[../character-chat/README.md](../character-chat/README.md); this page states their storage shape
and owns the memory tables keyed to a chat memory group.

## The chat lane's tables

- **`character_chats`** — one conversation, with its rolling summary, clock, plans, roster, and
  its per-conversation operational switches (`agent_reasoning_profile`, `scene_composer_model`,
  `visual_state_narration` — none of which ride the scenario, so story rollback never moves them).
- **`chat_participants`** — the character(s) in a conversation plus the `memory_group_id` scope
  key.
- **`chat_messages`** — the transcript.
- **`character_chat_state`** — the per-participant tracked state, meters, conditions, wardrobe,
  and scene memory.
- **`chat_presets`** — reusable scenario presets.
- **`chat_visual_memory`** — per-observer recognizable-feature notice and mention history, PK
  `(memory_group_id, viewpoint_id, subject_id)`, two-generation rows so a retake recomputes from
  the identical pre-exchange memory.
- **`chat_visual_cues`** — the narrator's own repeat and first-visibility record for the
  current-state and body-language details recognition memory deliberately does not hold (a rolled
  sleeve, a posture, an occupied hand). Same key and same two-generation retake law, kept as its
  own table because the two records are disjoint and because two upserts against one row inside
  one exchange would break the generation shuffle.
- **`chat_contact_events`** — the durable contact-provenance ledger: one row per lifecycle commit
  keyed by the exchange guard message id, idempotent on `(chat_id, event_ref, sequence)`, pruned
  by guard on a retake, with the versioned active-contact projection riding
  `character_chats.scene` as its replayable cache.
- **`chat_npc_scene_decisions`** — the NPC reply-scene decision envelope: one row per assistant
  message (unique `(chat_id, assistant_message_id)`, both FKs cascade), a durable tombstone for
  every outcome — trigger miss, degraded, evaluated — carrying reply and digest hashes, pre and
  post scene fingerprints, and a bounded payload. Written only by the guarded CAS transaction in
  `chat-npc-scene-envelope.ts`, pruned unconditionally on a retake, and read newest-first by the
  dev inspector as the decision trace.

## Memory tables

- **`episodes`** — `chat_memory_group_id` (scope key), `turn_number` (per-group exchange ordinal),
  `summary`, `witnessed_by` JSONB (see [../memory.md](../memory.md)), `source_message_id?` (chat
  provenance — the assistant message summarized), `embedding` vector, `embedder`.
- **`facts`** — `chat_memory_group_id` (scope key), `kind`, `verb?`, `subject_kind`,
  `subject_id?`, `subject_name` (stored lowercased), `text`, `tags` JSONB, `confidence` real,
  `canon` bool (default true; reserved), `pinned` bool (the player/dev "remember this" —
  [../memory.md](../memory.md) §Pinned facts), `origin` (`extracted`/`player`/`dev`),
  `witnessed_by` JSONB, `status` (`active`/`superseded`/`retracted`), `superseded_by_id?`,
  `source_message_id?` (chat provenance — the assistant message extracted from), `embedding`
  vector, `embedder`, `superseded_at?`.

Both are keyed to a **character-chat memory group** (`chat_memory_group_id`;
[../memory.md](../memory.md) §Memory keying) — the only scope column either table carries.
