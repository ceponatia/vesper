# At-rest encryption — user chat content unreadable on Neon

Status: draft

Outcome: The owner can lose control of the Neon database — a leaked backup, a stray
branch, an insider, or a subpoena of the database alone — and nobody on the other end
can read a word a player actually said.

## Goal & threat model

Make the durable, user-linked record of what players actually said and did —
chat transcripts, session narration, and everything derived from them — 
unreadable to anyone holding only the Neon database: Neon insiders, a Neon
breach, a leaked backup/branch, or a subpoena of the DB alone. The app
encrypts before the wire; Neon stores ciphertext it has no key for. As a side
effect the plaintext also stops transiting Neon's compute (today parameterized
INSERTs send it in the protocol, where query logging could capture it).

**Explicitly out of scope** (owner ruling, 2026-07-11): the LLM providers.
Every turn already flows through OpenRouter and a model host in plaintext —
accepted, because that traffic is ephemeral, high-volume, and effectively
unlinkable to a stored user identity. Also out of scope: a compromise of the
Fly machine or the app itself (the key lives there by necessity), and
metadata (row counts, timestamps, who chats with which character — that
linkage stays visible).

**Not the mechanism**: pgcrypto. It encrypts on the Postgres server, so the
key and plaintext would transit Neon's compute — defeats the purpose. Neon's
own AES-256 at-rest encryption also doesn't help here: Neon manages those
keys (AWS KMS / Azure Key Vault) and their services decrypt as a matter of
course; no CMEK offering exists (verified against their security docs
2026-07-11).

## Design

### Envelope

App-side AES-256-GCM via `node:crypto`, one envelope format everywhere:

- **text columns** → `enc1.<keyId>.<iv b64>.<ciphertext+tag b64>` — a single
  prefix-detectable string, so plaintext and ciphertext coexist during
  backfill and the read path branches on the `enc1.` prefix.
- **jsonb columns** → the whole blob encrypted, stored as
  `{"__enc": "enc1...."}` — keeps the column type (no migration), detectable
  by the `__enc` key.
- **embeddings** → binary envelope in a new `embedding_enc bytea` column
  (Float32Array plaintext, ~6.1 KB/row); the `vector(1536)` column and its
  HNSW index are dropped for the affected tables (see D1).

`keyId` gives rotation + per-user-key headroom without a format change
(forward-compatible-schema preference). AAD binds the row: `table:column:id`
so a ciphertext can't be replayed into another row/column.

### Keys

- v1: one master key. `DATA_ENCRYPTION_KEYS` (JSON map `{keyId: base64}`) +
  `DATA_ENCRYPTION_ACTIVE_KEY` as Fly secrets; old keys stay in the map so
  rotation = add key, flip active, re-encrypt backfill, drop old key.
- **Key loss = total loss of every encrypted column.** The key must also live
  in the owner's password manager, not only in Fly secrets.
- Phase 2 (not v1, envelope already supports it): per-user DEKs wrapped by
  the master key — limits blast radius and gives crypto-shredding account
  deletion.
- Local dev/tests: a fixed well-known test key checked into test fixtures
  (never used in prod); missing env in production fails boot (mirrors the
  `BETTER_AUTH_SECRET` guard).

### Module & boundaries

`src/server/crypto/` behind an `index.ts` barrel (needs env + randomness, so
not `src/lib`): `encryptText/decryptText`, `encryptJson/decryptJson`,
`encryptVector/decryptVector`, plus `decryptOr(...)` following
`docs/resilience.md` — a failed decrypt (unknown keyId, tamper, corruption)
returns the column's degraded default (`""` / `{}` / `[]`) with a
`crypto.decrypt_failed` diagnostic, never a failed turn. A transcript row
that fails decrypt renders as an explicit `[unreadable]` line rather than
vanishing.

Encryption/decryption happens in the server data layer (the modules that own
each table's reads/writes), not in routes — callers keep seeing plaintext
types.

## Column inventory

### Encrypt (v1)

Chat lane:
- `character_chat_messages.content`, `.takes` (jsonb — mirrors content)
- `character_chat_summaries.summary`
- `character_chats.title` (user-editable free text)
- `character_chat_state`: `mind_note`, `premise`, `outfit`,
  `pending_skip_note`, `scene_memory`, `relationship_record`, `open_loops`,
  `milestones`, `memory_queries`, `attribute_overlays`, `last_pulse_trace`,
  `last_memory_trace`, `pre_exchange_state`, `surfaced_cues` (the traces and
  state snapshots quote chat text verbatim)
- `chat_scenario_presets.premise`, `.outfit`, `.social_cards`, `.name`

Session lane:
- `turns.input`, `.narration`, `.agent_results`, `.intent_brief`
  (agent outputs quote narration/input)
- `turn_messages.content`, `.speaker`? (speaker is a display name — leave)
- `sessions.runtime`, `.brief` (brief carries characterNotes/memoryQueries
  derived from play)

Memory (both lanes):
- `facts.text`, `.subject_name` (lowercased chat-derived names), `.tags`
- `episodes.summary`
- `facts`/`episodes` embeddings → `embedding_enc` (D1)

Derived sinks (easy to forget, all carry chat text today):
- `events.payload` for `type = "retrieval"` (queries include raw player
  input, candidates include fact/episode text) — encrypt payload for that
  type, or all event payloads for simplicity
- `jobs.payload` (chat_summary / scene jobs embed transcript excerpts) —
  encrypt wholesale; jobs are transient but rows persist after `done`
- `images.prompt` + chat-derived `meta` (scene prompts are built from the
  transcript)
- `users.player_persona` (name + bio the player wrote about themselves)

### Leave plaintext (v1), with reasons

- Better Auth tables (`users.email/name`, sessions, accounts) — identity,
  needed for auth lookups; passwords already hashed.
- Library content (`characters.profile`, `locations`, `items`,
  `social_cards`, `worlds`, `lore_chunks` + their `search_embedding`s) —
  authored artifacts, not conversation; several are `public`/shareable and
  power SQL fuzzy search. Intimate authored sheets are a candidate for
  phase 2, but they're not "what the user said."
- World/session structural snapshots (`world_cast.snapshot`,
  `session_participants.snapshot`, locations/items/links) — copies of
  authored content. (`session_participants.state` evolves during play; see
  Open questions.)
- All ids, FKs, timestamps, enums, meters/regard/familiarity scalars —
  metadata is out of scope; retrieval/joins need them.

## D1 — embeddings (the load-bearing decision)

Fact/episode embeddings are computed from chat text and are substantially
invertible — leaving them plaintext undermines the whole feature. Options:

- **(a) Leave plaintext.** Zero work, keeps HNSW. Rejected as the default:
  it leaks approximately the thing we're protecting.
- **(b) Encrypt embeddings; rank app-side. Recommended.** Retrieval is
  always scoped (one session / one chat memory group) and per-scope corpora
  are small (hundreds, low thousands at worst). Fetch the scope's active
  rows (`id`, `embedding_enc`, floor fields), decrypt, cosine + RRF in JS —
  1536-dim × a few thousand rows is milliseconds of math. Fusion math in
  `memory/fusion.ts` is already pure; the SQL top-k in
  `queryFactCandidates` / episodes moves into the same in-process path.
  Supersedence's top-3 ≥ 0.86 check moves app-side identically. HNSW
  indexes on `facts`/`episodes` are dropped (they never see plaintext
  vectors again).
  - Perf watch-item: ~6 KB/row transfer per retrieval (a 500-row group ≈
    3 MB from Neon per exchange). If measured latency hurts, add a per-scope
    in-memory LRU on the single Fly machine (rows are insert-mostly;
    invalidate on write/count).
- **(c) No embeddings for chat-derived memory.** Kills RAG — conflicts with
  RAG-improvements.plan.md. Rejected.

`lore_chunks.embedding` stays plaintext under the v1 inventory (authored
lore, not chat) and keeps its HNSW path — the lore retriever is untouched.

## Migration & backfill

1. Ship the crypto module + dual-read paths (prefix-detect: `enc1.` /
   `__enc`), writes always encrypt. One drizzle migration adds
   `facts.embedding_enc` / `episodes.embedding_enc` and drops the two vector
   columns + HNSW indexes (generate via `pnpm db:generate`; the create-vs-
   rename prompt must be answered by the owner if it appears).
2. Backfill script `scripts/encrypt-backfill.ts` (idempotent, batched,
   prefix-skips already-encrypted rows), run per environment via
   `fly ssh console`. Also re-used for key rotation (`--rekey`).
3. Optional strict mode later: a boot flag that treats non-envelope values in
   encrypted columns as errors once backfill is verified.

Honest caveat: Neon's point-in-time history and any existing branches retain
pre-backfill plaintext until they age out of the retention window / branches
are deleted. Full closure = backfill, then let retention lapse (or reset
history), and delete stale branches.

## Operational consequences

- **SQL-level debugging goes blind on encrypted columns** — Neon SQL editor,
  `mcp__Neon__run_sql`, the postgres MCP tools, and psql all see envelopes.
  The in-app dev inspector still works (server decrypts). Accepted cost; a
  dev-only decrypt CLI (`scripts/decrypt-row.ts`, needs the key in env) covers
  forensic moments.
- `pnpm db:seed` and fixtures write through the app path → encrypted
  automatically; int tests run with the fixed test key.
- Degradation tests (mandatory per repo rules): tampered envelope ⇒ degraded
  default + `crypto.decrypt_failed`; missing key in prod ⇒ boot failure.
- Eval harnesses (`eval:retrieval`, `eval:narration`) read through the app
  path — unaffected, but `eval:retrieval` must be re-run after D1(b) since
  the retrieval implementation changes (floors shouldn't move; the math is
  identical).
- Perf: AES-GCM is ~GB/s — transcript decrypt cost is noise. The embedding
  fetch (D1b) is the only thing worth measuring.

## Slices (sketch)

1. Crypto module + envelope + tests (pure round-trip/tamper/AAD +
   degradation diagnostics).
2. Chat lane: messages, takes, summaries, chat title, chat state fields,
   presets — dual-read, encrypted writes.
3. Session lane: turns, turn_messages, session runtime/brief.
4. Memory: facts/episodes text + D1(b) embeddings (migration; retrieval and
   supersedence move app-side; re-run `eval:retrieval`).
5. Derived sinks: events.payload, jobs.payload, images.prompt/meta,
   users.player_persona.
6. Backfill script + Fly rollout (secrets, backfill, verify, retention note).

## Open questions

- **D1 ruling** — confirm (b) encrypted embeddings + app-side ranking, or
  accept (a) plaintext embeddings as a known leak for v1 speed?
- **`session_participants.state` / participant snapshots** — evolve during
  play (conditions, positions) and can encode intimate state. Encrypt in v1
  or defer with the library content?
- **Events wholesale vs retrieval-only** — encrypting all `events.payload`
  is simpler but makes ops queries on other event types opaque too.
- **Character profiles (phase 2?)** — authored sheets are intimate but
  shareable/searchable; if encrypted later, `search_embedding` fuzzy
  resolution needs the same app-side treatment per owner library.
- **Per-user DEKs** — worth scheduling once multi-user production is real
  (crypto-shredding deletes), or park until then?
