# At-rest encryption — user chat content unreadable on Neon

Status: draft (planned 2026-07-11; nothing built; column inventory re-grounded
against the schema 2026-08-07)

Outcome: The owner can lose control of the Neon database — a leaked backup, a stray
branch, an insider, or a subpoena of the database alone — and nobody on the other end
can read a word a player actually said.

Verified 2026-08-07: no part of this has shipped. There is no crypto module, no
envelope format in the codebase, no encrypted column anywhere in the schema, and
no encryption key in the environment. Every column named below is stored in
plaintext today.

## Goal & threat model

Make the durable, user-linked record of what players actually said and did —
chat transcripts, the state derived from them, and memory — unreadable to
anyone holding only the Neon database: Neon insiders, a Neon breach, a leaked
backup or branch, or a subpoena of the database alone. The app encrypts before
the wire; Neon stores ciphertext it has no key for. As a side effect the
plaintext also stops transiting Neon's compute, where query logging could
capture it.

**Explicitly out of scope** (owner ruling, 2026-07-11): the model providers.
Every turn already flows through the provider gateway and a model host in
plaintext — accepted, because that traffic is ephemeral, high-volume, and
effectively unlinkable to a stored user identity. Also out of scope: a
compromise of the Fly machine or the app itself (the key lives there by
necessity), and metadata — row counts, timestamps, who chats with which
character. That linkage stays visible.

**Not the mechanism**: database-side encryption functions. They encrypt on the
Postgres server, so the key and plaintext would transit Neon's compute, which
defeats the purpose. Neon's own at-rest encryption does not help either: Neon
manages those keys and its services decrypt as a matter of course, and no
customer-managed-key offering exists (verified against their security docs
2026-07-11).

## Design

### Envelope

App-side AES-256-GCM via `node:crypto`, one envelope format everywhere:

- **text columns** → a single prefix-detectable string carrying a key id, an
  initialization vector, and the ciphertext, so plaintext and ciphertext can
  coexist during backfill and the read path branches on the prefix.
- **jsonb columns** → the whole blob encrypted and stored under a reserved key,
  which keeps the column type (no migration) and stays detectable.
- **embeddings** → a binary envelope in a new column; the vector column and its
  index are dropped for the affected tables (see D1).

The key id gives rotation and per-user-key headroom without a format change.
Additional authenticated data binds each ciphertext to its table, column, and
row id, so a value cannot be replayed into another row.

### Keys

- v1: one master key. A key map plus an active-key pointer, both Fly secrets;
  old keys stay in the map, so rotation is: add key, flip active, re-encrypt,
  drop old key.
- **Key loss is total loss of every encrypted column.** The key must also live
  in the owner's password manager, not only in Fly secrets.
- A later phase (the envelope already supports it): per-user data keys wrapped
  by the master key — smaller blast radius, and account deletion becomes
  key destruction.
- Local development and tests use a fixed well-known test key, never used in
  production; a missing key in production fails boot, mirroring the existing
  auth-secret guard.

### Module & boundaries

A `src/server/crypto/` module behind a barrel (it needs environment and
randomness, so not `src/lib`): encrypt and decrypt helpers for text, JSON, and
vectors, plus a degrading decrypt following `docs/resilience.md`. A failed
decrypt — unknown key, tampering, corruption — returns the column's degraded
default with a diagnostic, never a failed turn. A transcript line that fails to
decrypt renders as an explicit unreadable marker rather than vanishing.

Encryption and decryption happen in the server data layer — the modules that
own each table's reads and writes — not in routes. Callers keep seeing
plaintext types.

## Column inventory

Re-grounded against `src/server/db/schema.ts` on 2026-08-07. The original
inventory was written before the R6 rollout deleted the legacy world and
session model, so its entire "session lane" section (turns, turn messages,
sessions, session participants, world cast, lore chunks) named tables that no
longer exist. What follows is the live surface.

### Encrypt (v1)

Conversation and its derived state:

- The transcript itself: message content, and the alternate-takes blob that
  mirrors it.
- Rolling summaries.
- Conversation-level free text and state on `character_chats`: title, premise,
  scene memory, player state, garments, environment, affordance cues, scene
  state, supporting cast, plans, the pending skip and meanwhile notes, skip
  history, the pre-exchange scenario snapshot, and the last reply failure.
- Per-character state on `character_chat_state`: mind note, outfit, open loops,
  milestones, relationship record and history, memory queries, attribute and
  trait overlays, voice exemplars, feeling, drives, whereabouts, surfaced cues,
  callback and selfie history, and both debug traces (the pulse trace and the
  memory trace quote chat text verbatim).
- Scenario presets: name, premise, outfit, social cards.

Memory:

- Fact text, subject name, and tags.
- Episode summaries.
- Fact and episode embeddings — see D1.

Derived sinks, easy to forget and all carrying chat text today:

- Retrieval telemetry payloads. The queries include raw player input and the
  candidate lists include fact and episode text. **Overlaps
  [data-lifecycle.plan.md](data-lifecycle.plan.md) slice 5**, which would strip
  this content in production outright — if that ships first, this item shrinks
  to "encrypt what is left".
- Job payloads: summary and scene jobs embed transcript excerpts, and rows
  persist after the job finishes.
- Image prompts and chat-derived image metadata: scene prompts are built from
  the transcript. Note that deleting a conversation now blanks the prompt on
  its images, so the exposure window is bounded to live conversations.
- Persona profiles — the name and biography a player wrote about themselves.
  (The original inventory named a column on `users` that no longer exists;
  personas are their own table now.)

### Leave plaintext (v1), with reasons

- Better Auth tables — identity, needed for auth lookups; passwords are already
  hashed.
- Library content: character profiles, locations, items, social cards, and
  their search embeddings. These are authored artifacts, not conversation;
  several are shareable and power name resolution and search. Intimate authored
  sheets are a candidate for a later phase, but they are not "what the user
  said".
- All ids, foreign keys, timestamps, enums, and the numeric relationship and
  meter scalars. Metadata is out of scope, and retrieval and joins need them.

### Newly in question (not in the original inventory)

Four chat-lane tables and the successor lane arrived after this plan was
written. None holds transcript text, but each encodes intimate activity in
structured form, and a reader with the database would learn a great deal from
them. They need a ruling before slice 2 is written — see Open questions.

- The contact ledger and the permission ledger (what was touched, what was
  allowed or withdrawn, and when).
- Recorded scene decisions for non-player characters.
- Per-observer visual memory (which features of whom a character has
  registered).
- The successor lane's event log and derived stores, which carry
  narration-derived content for engine-authoritative conversations.

## D1 — embeddings (the load-bearing decision)

Still open, still the decision the rest of the plan waits on.

Fact and episode embeddings are computed from chat text and are substantially
invertible, so leaving them plaintext undermines the whole feature. Options:

- **(a) Leave plaintext.** Zero work, keeps the vector index. Rejected as the
  default: it leaks approximately the thing being protected.
- **(b) Encrypt embeddings and rank in the app. Recommended.** Retrieval is
  always scoped to a single conversation's memory group, and per-scope corpora
  are small — hundreds, low thousands at worst. Fetch the scope's active rows,
  decrypt, and do the similarity and fusion math in process. The fusion math is
  already pure and separate, and the supersedence check moves the same way, so
  what changes is where the top-k is computed, not how. The vector indexes on
  facts and episodes are dropped, since they would never see a plaintext vector
  again.
  - Watch item: roughly 6 KB per row transferred per retrieval, so a large
    memory group costs a few megabytes from Neon per exchange. If measured
    latency hurts, add a per-scope in-memory cache on the single Fly machine —
    these rows are insert-mostly.
- **(c) Drop embeddings for chat-derived memory.** Kills retrieval entirely.
  Rejected.

Library search embeddings stay plaintext under the v1 inventory (authored
content, not conversation) and keep their index path untouched.

## Migration & backfill

1. Ship the crypto module and dual-read paths (detect an envelope by its
   prefix; writes always encrypt). One migration adds the encrypted embedding
   columns and drops the vector columns and their indexes.
2. An idempotent, batched backfill script that skips already-encrypted rows,
   run per environment over an SSH console, and reused for key rotation.
3. Optionally, later: a boot flag that treats a non-envelope value in an
   encrypted column as an error, once backfill is verified.

Honest caveat: Neon's point-in-time history and any existing branches retain
pre-backfill plaintext until they age out of the retention window or the
branches are deleted. Full closure is backfill, then letting history lapse and
deleting stale branches.

## Operational consequences

- **Database-level debugging goes blind on encrypted columns.** Any SQL client
  — the Neon console, a database MCP tool, psql — sees envelopes. The in-app
  developer inspector still works, because the server decrypts. Accepted cost;
  a developer-only decrypt script covers forensic moments.
- Seeding and fixtures write through the app path, so they encrypt
  automatically; integration tests run with the fixed test key.
- Degradation tests are mandatory per the repo rules: a tampered envelope
  yields the degraded default plus a diagnostic, and a missing key in
  production fails boot.
- `pnpm eval:retrieval` reads through the app path and is unaffected in
  principle, but it must be re-run after D1(b), because the retrieval
  implementation changes. The measured floors should not move — the math is
  identical.
- Performance: AES-GCM runs at gigabytes per second, so transcript decryption
  is noise. The embedding fetch under D1(b) is the only thing worth measuring.

## Slices (sketch)

1. Crypto module, envelope, and tests — round-trip, tampering, binding, and the
   degradation diagnostics.
2. The conversation: messages, takes, summaries, chat-level free text and
   state, per-character state, presets.
3. Memory: fact and episode text, plus D1(b) embeddings — the migration,
   retrieval and supersedence moving in-process, and a re-run of the retrieval
   eval.
4. Derived sinks: telemetry payloads, job payloads, image prompts and metadata,
   persona profiles.
5. Backfill script and the Fly rollout — secrets, backfill, verification, and
   the retention caveat above.

## Open questions

- **D1 ruling** — confirm (b), encrypted embeddings with app-side ranking, or
  accept (a), plaintext embeddings as a known leak, for v1 speed? Everything
  else is sequencing; this one changes the shape of retrieval.
- **The structured intimate ledgers** — encrypt the contact, permission,
  scene-decision, and visual-memory tables in v1, or accept them as structured
  metadata and defer with the library content?
- **The successor lane** — its event log is an append-only history that
  replays. Encrypting event payloads is possible but touches the engine's
  determinism story; is the successor lane in v1 scope at all?
- **Telemetry: wholesale or selective** — encrypting every telemetry payload is
  simpler but makes operational queries on unrelated event types opaque too.
  Resolve alongside the data-lifecycle minimization slice, which may remove the
  content before encryption ever has to cover it.
- **Character profiles (a later phase?)** — authored sheets are intimate but
  shareable and searchable; if they are encrypted later, name resolution needs
  the same app-side treatment per owner library.
- **Per-user data keys** — schedule once multi-user production is real, so that
  account deletion can be key destruction, or park until then?
