# Data lifecycle — 2026-07-29 orphaned-data audit (live Neon + Fly)

Detail doc for [data-lifecycle.plan.md](data-lifecycle.plan.md). Snapshot of the
live production audit that motivated the plan: every orphan class found in the
Neon `Vesper` database (project `round-sky-30947574`) and on the Fly volume
(`vesper_data`, mounted at `/app/data`), with provenance traced to code.
Numbers are the 2026-07-29 counts — they will drift; the *classes* and causes
are the durable content.

## Method

- Schema-driven orphan queries against live Neon: for every loose text id (no
  FK) and every polymorphic reference, `NOT EXISTS` probes against the parent
  table; FK-covered links were spot-checked but cannot orphan by construction.
- Fly volume ↔ DB reconciliation: sorted file list under `/app/data/images`
  vs `images.path` for `status='ready'` rows compared by md5 of the joined
  sorted lists — **identical** (142 files ↔ 142 ready rows; the 6 `failed`
  rows correctly have no file).
- Code provenance: full trace of deletion/cleanup paths (character delete,
  chat delete, jobs, events, image sweep, user delete) with file:line
  citations, summarized per class below.

## Orphan classes found

### 1. `jobs` rows referencing deleted chats — 792 (of 2,861 total)

All finished chat-lane jobs (`chat_scene_sketch` 310, `chat_look_image` 149,
`chat_scene_image` 138, `chat_summary` 128, `chat_place_image` 67). Cause:
the chat reference lives in the jsonb `payload` (`payload->>'chatId'`), so no
FK can cascade; `deleteChat` (`src/server/engine/chat-pipeline.ts`) never
touches `jobs`; and **no production code deletes from `jobs` at all** —
`finishJob` only flips status, there is no scheduler, so done/failed rows
accumulate forever (2,502 finished rows older than 7 days at audit time).
Payloads are ids plus short display labels (`placeName`, `characterName`) —
no message text.

### 2. `events` telemetry retains user content, unbounded — 6,191 rows

`logEvent` (`src/server/events.ts`) is fire-and-forget; nothing prunes
(`db().delete(events)` exists only in tests). Two types carry real user
content: `retrieval` (3,386 rows) stores the memory-search **queries
verbatim** — actual personal roleplay content — and `agent_run` (2,427 rows)
embeds voice-line snippets in `details`. Chat deletion purges the chat's
memory but not the telemetry about it, so content describing deleted chats
survives here. Read-side caps (`TALLY_SCAN_CAP`) limit scanning, not storage.

### 3. Scope-less memory rows — 2 `facts` + 2 `episodes`

The Milo Finch / Sabrina Vale pair, written 2026-07-09 by the then-live
session lane. Pre-R6, scope was `session_id` XOR `chat_memory_group_id`
(CHECK `*_scope_exactly_one`, migrations 0018/0022), so session-lane rows
legitimately had a NULL group. R6's migration `0085_busy_marvel_boy.sql`
dropped the `session_id` column **without purging session-scoped rows**,
stranding them with no scope key at all. They are unreachable — retrieval
filters strictly `eq(chat_memory_group_id, groupId)`, which NULL never
matches — but retained, embeddings included. Their `subject_id`s (no FK)
also dangle against since-deleted characters, as does `source_turn_id`
(the `turns` table itself is gone).

### 4. Orphaned entity images — 2 avatar rows + live files

Two `kind='avatar'` images (owner `uQgqRUmEUGS2…`, created 2026-06-28) whose
characters were later deleted. Character delete does call
`deleteEntityImages` (`src/server/api/library.ts`), but as a `void`-discarded
best-effort, and the promised safety net is **phantom**: six code comments
say "image_sweep reconciles anything missed", yet the `image_sweep` job type
has no registered handler and `sweepOrphans()`
(`src/server/images/assets.ts`) is only ever called from an integration
test. Any missed cleanup is permanent. *Under the 2026-07-29 owner ruling
(images survive their chat/character for the Gallery) these two rows are now
by-design keepers, and `deleteEntityImages`-on-character-delete is itself the
thing to remove — see the plan.*

### 5. Stale provisioning idempotency records — 2 `ready` rows

Both `sim_provisioning_requests` rows point at a world **and** chat that no
longer exist (chat teardown correctly removed the world, E20-1, but not the
ledger row — `world_id`/`chat_id` there are loose text). Their stored
`response` blob replays a 201 naming ghosts on a same-key re-POST.

### 6. Minor rot

- 41 `image_references.image_id` and 32 `images.source_image_id` danglers:
  plain text, never nulled when the referenced image row is deleted (gallery
  delete nulls `characters.avatarImageId`/`locations.imageId`/`items.imageId`
  via `clearEntityImagePointers`, but not these).
- 37 expired `auth_sessions` rows — Better Auth never sweeps expired
  sessions.
- 85 dangling `images.anchor_message_id` — **documented by-design**
  (messages are individually deletable; a dangling anchor just demotes the
  image to the strip), listed here only for completeness.

## Adjacent finding: no user-deletion path

No route or Better Auth `deleteUser` config exists, and ten content tables
reference `users.id` with default RESTRICT — deleting a `users` row directly
would fail on FK violations. Not an orphan, but the same lifecycle family;
parked as an open question in the plan.

## Verified clean

- Fly volume ↔ `images` rows: exact match (checksummed), no stray or missing
  files.
- No participant-less chats; no messages stranded that way.
- No orphaned `sim_worlds` or `sim_branches` (every branch maps to a chat;
  chat delete removes the linked world).
- Memory-group purge on chat delete works (no group without a living
  participant).
- No dangling `characters.avatar_image_id` / `cloned_from_id` /
  `personas.avatar_image_id`; fact supersede chains intact.
- Image serving (`src/app/api/images/[id]/file/route.ts`) is owner-scoped
  (or public-entity with owner match) — none of the orphans were
  cross-user-readable. **No cross-user exposure anywhere in the audit.**

## Rulings (2026-07-29, owner)

The headline ruling (chat-flow data carries a `chat_id` and dies with its
chat; images are the deliberate Gallery-keeping exception) is quoted in the
plan. The four open questions it left were ruled the same day:

1. **Gallery-hidden chat image kinds** (`chat_upload`/`chat_look`/
   `chat_place`): **keep today's hard-delete on chat delete.** The images
   exception covers Gallery-visible kinds only.
2. **Retention windows:** telemetry `events` 30 days, finished `jobs`
   7 days (constants — retunable anytime).
3. **Telemetry content in prod: ids + counts only.** Conditional ruling —
   "if these are only used for debugging and aren't fixtures we can
   eventually use in prod to improve the narration then I agree with not
   keeping them." Verified: raw retrieval query text has no production
   reader and feeds no narration path; dev builds keep full payloads, so a
   future tuning corpus can be captured there if ever wanted.
4. **Account deletion: parked** →
   [deferred.plan.md](deferred.plan.md) §"Account deletion".

## Systemic causes (what the plan fixes)

1. **Loose text ids where a FK belongs** — chat references buried in jsonb
   (`jobs.payload`) or bare text (`sim_provisioning_requests.chat_id`,
   `events` payloads) that no cascade or sweep ever chases.
2. **Fire-and-forget cleanup with a nonexistent reconciler** — best-effort
   `void` deletes backed by an `image_sweep` that was never wired.
3. **No retention story** — `jobs` and `events` grow forever; telemetry
   stores content verbatim.
4. **Destructive migrations don't purge orphaned rows** — 0085 dropped a
   scope column and left the rows it scoped.
