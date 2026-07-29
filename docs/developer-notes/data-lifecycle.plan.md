# Data lifecycle — chat-scoped deletion, retention sweeps, intentional image orphans

Status: next (planned 2026-07-29 from the live orphaned-data audit; owner ruling same day)

Companion detail: [data-lifecycle.audit.md](data-lifecycle.audit.md) — the
2026-07-29 live Neon + Fly audit this plan answers (orphan inventory,
provenance, verified-clean list).

## Owner ruling (2026-07-29)

> Everything should be linked to its chat id if it is part of the chat flow,
> and deletion of a chat should sweep **all** data with the same chat id. The
> only exception is images: we don't necessarily want to delete images when
> their chat or character is deleted, because we want them still in the
> Gallery — those can be **intentionally orphaned**.

Two consequences worth stating plainly:

- **Chat-flow rows get a real `chat_id` column with a cascade FK** — not an id
  buried in a jsonb payload. The audit's biggest bucket (792 orphaned `jobs`
  rows) exists precisely because the reference was jsonb-only.
- **A dangling `entity_id`/`chat_id` on an `images` row is now a by-design
  state**, not a bug: the row and file survive their chat/character for the
  Gallery. The serve route already owner-scopes (dangling entity ⇒ never
  public), so this is retention policy, not exposure. The two orphan avatars
  the audit found are keepers.

## Design

**Chat linkage.** Add nullable `chat_id text REFERENCES character_chats(id) ON
DELETE CASCADE` to `jobs` and `events`; convert
`sim_provisioning_requests.chat_id` to the same FK shape. Null means "not
chat-flow" (system jobs, image.* telemetry for library entities) and is
exempt from the chat sweep. Backfill `jobs.chat_id` from `payload->>'chatId'`.
Writers pass the chat id at enqueue/log time — every chat-lane leg already has
it in hand.

**Deletion.** With the FKs in place, `deleteChat` sweeps jobs, events, and
provisioning records by cascade — no new imperative cleanup, no sweep code to
forget. The existing pieces stay: transcript/state/participants cascade,
participant-less memory-group purge, linked `sim_worlds` hard-delete.

**Images exception.** Character delete stops calling `deleteEntityImages` —
entity images (avatars, portraits, entity renders) survive with a dangling
`entity_id` as provenance. Scene images already survive chat delete
(`chat_id` SET NULL) — unchanged. The Gallery-hidden chat-scoped kinds
(`chat_upload` / `chat_look` / `chat_place`) are OQ1 below.

**Retention.** One in-process daily sweep (on boot + `setInterval` in the
single Fly machine's job-runner process — we have no cron infrastructure and
don't need it for this):

- `events` older than the retention window (OQ2; default 30 days),
- `done`/`failed` `jobs` older than 7 days (OQ2),
- expired `auth_sessions` and `verifications`,
- `sweepOrphans()` — finally wired for real (see slice 4); today six code
  comments promise an `image_sweep` reconciler that never runs.

**Telemetry content minimization.** `retrieval` events currently store the
memory-search queries verbatim (real user roleplay content) and `agent_run`
details embed voice lines. Retention shrinks the window; OQ3 decides whether
prod should store that content at all.

## Slices

0. **One-time purge of the existing orphans** (guarded SQL, run against Neon
   after review; counts in the audit doc):
   - the 4 scope-less memory rows (`chat_memory_group_id IS NULL` — R6
     stragglers, unreachable by any retrieval),
   - the 2 stale `ready` `sim_provisioning_requests`,
   - the 792 orphan-chat jobs and the finished-jobs backlog (>7 days),
   - null the 41 dangling `image_references.image_id` and 32
     `images.source_image_id` values,
   - the 37 expired `auth_sessions`.
   The 2 orphan avatars are **kept** (by-design under the ruling).
1. **Schema + backfill**: `chat_id` FK columns on `jobs` and `events`;
   `sim_provisioning_requests.chat_id` → FK; backfill jobs from payload;
   migration via `pnpm db:generate` (expect the create-vs-rename prompt to be
   clean — these are pure adds/alters).
2. **Writers pass `chat_id`**: `enqueueJob` call sites in the chat lane,
   `logEvent` call sites that have a chat in scope (`agent_run`,
   `agent_failure`, `retrieval`, `composition_fallback`,
   chat-scoped `image.*`). Provisioning stamps `chat_id` at the
   `chat_created` step it already records.
3. **Deletion-path changes**: drop `deleteEntityImages` from character
   delete (the ruling); resolve OQ1 for the chat-scoped image kinds; delete
   provisioning records on chat delete arrives free via the slice-1 FK.
   Document in `docs/images.md` + `docs/memory.md` that dangling
   `entity_id` / `subject_id` references are by-design provenance (a fact
   naming a deleted character belongs to the *observing* group's memory and
   is not scrubbed).
4. **Retention sweep**: small `retention` module in `src/server` (boot +
   daily interval, advisory-locked so overlapping machines/deploys don't
   double-run), covering the four bullets above; register a real
   `image_sweep` handler that calls `sweepOrphans()` (or delete the phantom
   job type and fold the call into the retention sweep — implementer's
   choice; kill the six stale "image_sweep reconciles" comments either way).
   Degradation tests per `docs/resilience.md`: sweep failure logs a
   diagnostic and never takes a turn down.
5. **Telemetry minimization** (after OQ3): trim `retrieval`/`agent_run`
   payloads in prod to ids + counts (or gate full content behind
   `NODE_ENV !== "production"` / a debug flag), preserving what the admin
   chat-inspector actually reads.

Each slice updates the relevant system doc (`docs/images.md`,
`docs/memory.md`, jobs/events docs) in the same change, and the roadmap on
completion.

## Open questions

- **OQ1 — chat-scoped hidden image kinds on chat delete.** `chat_upload` /
  `chat_look` / `chat_place` are Gallery-*hidden* by design, so "keep them
  for the Gallery" cannot apply; uploads are player-attached photos
  (possibly of real people), where privacy argues for deletion.
  **Recommend: keep today's hard-delete for these three kinds**; the images
  exception covers Gallery-visible kinds (scenes, avatars, portraits,
  entities) only.
- **OQ2 — retention windows.** Recommend `events` 30 days, finished `jobs`
  7 days. Purely operational; owner can retune anytime (constants, not
  schema).
- **OQ3 — telemetry content in prod.** `retrieval` query text appears to
  have **no production reader** (the inspector reads `agent_run` summaries
  and failure tallies). Recommend: stop storing raw query text in prod
  (ids + hit counts only), keep full payloads in dev.
- **OQ4 — account deletion.** No user-deletion path exists at all (no
  route, Better Auth `deleteUser` off, RESTRICT FKs from ten content
  tables). Out of scope here; recommend parking in
  [deferred.plan.md](deferred.plan.md) until the product needs it (it will
  eventually — data-protection hygiene), at which point the cascade/ownership
  map in the audit doc is the starting inventory.

## Non-goals

- At-rest encryption — its own queued plan
  ([at-rest-encryption.plan.md](at-rest-encryption.plan.md)).
- Gallery UX changes (visibility filters stay as they are).
- Any change to the by-design `anchor_message_id` dangling semantics.
