# Data lifecycle — chat-scoped deletion, retention sweeps, intentional image orphans

Status: next (planned 2026-07-29 from the live orphaned-data audit; owner ruling
same day; re-verified against the code 2026-08-07)

Outcome: The owner can delete a chat and have everything belonging to it actually go —
its jobs, its telemetry, its provisioning records — while the images it produced stay in
the Gallery on purpose rather than by accident.

Companion detail: [data-lifecycle.audit.md](data-lifecycle.audit.md) — the
2026-07-29 live Neon + Fly audit this plan answers (orphan inventory,
provenance, verified-clean list). Its row counts are a **point-in-time
observation of one database on one day**, not current truth; the orphan
*classes* and their causes are the part that still holds.

## Owner ruling (2026-07-29)

> Everything should be linked to its chat id if it is part of the chat flow,
> and deletion of a chat should sweep **all** data with the same chat id. The
> only exception is images: we don't necessarily want to delete images when
> their chat or character is deleted, because we want them still in the
> Gallery — those can be **intentionally orphaned**.

Two consequences worth stating plainly:

- **Chat-flow rows get a real `chat_id` column with a cascade FK** — not an id
  buried in a jsonb payload. The audit's biggest bucket (orphaned `jobs` rows)
  exists precisely because the reference was jsonb-only.
- **A dangling `entity_id`/`chat_id` on an `images` row is a by-design
  state**, not a bug: the row and file survive their chat/character for the
  Gallery. The serve route already owner-scopes (dangling entity ⇒ never
  public), so this is retention policy, not exposure. The orphan avatars the
  audit found are keepers.

## What has landed since planning

One piece arrived ahead of this plan, by its own route (2026-08-02, from an
owner report of a chat tile that never resolved): **the image sweep is no
longer phantom.** `kickImageSweep` (`src/server/images/assets.ts`) runs
`sweepOrphans()` for real — a request-driven kick from the image pipeline
rather than a timer, throttled in-process and guarded by a durable six-hourly
`image_sweep` job row so overlapping machines don't double-run. The same tick
reclaims `queued`/`running` job rows whose process died, and runs
identity-pack maintenance. That closes half of slice 4 and establishes the
scheduling pattern the retention half should reuse.

A second piece arrived the same way (2026-08-24, from an owner check of the
Image Generator's delete path, which found eight July/August render failures
still sitting in the table): **failed image rows now expire.** The sweep's third
pass deletes a row that failed more than 24 hours ago, so a failed render is a
visible "this didn't work" tile for a day and then stops being a row at all. It
rides the existing tick exactly as §Design says retention should, and it
establishes two rails the three remaining deletions should reuse: a cap on how
many rows one pass may remove, and a refusal to delete anything when *most* of
the rows in scope are expired failures — the reading a volume that failed to
mount produces, where deleting rows is as unrecoverable as wiping the volume.
Slice 4's own three deletions are untouched by it.

Nothing else in this plan has landed. Re-verified 2026-08-07: `jobs` and
`events` still carry no `chat_id`; `sim_provisioning_requests.chat_id` is
still loose text; `deleteChat` still leaves jobs, telemetry, and provisioning
records behind; character delete still calls `deleteEntityImages`; no
production code deletes an `events` or a finished `jobs` row, or an expired
auth session; and `retrieval` telemetry still stores memory-search queries
verbatim in every environment.

One deletion-path detail did move and is worth knowing before touching this
code: `deleteChat` now blanks `images.prompt` for the chat's images and for
the participants' character-scoped scene images, so a surviving Gallery image
keeps its picture and loses the chat-derived text that produced it.

## Design

**Chat linkage.** Add a nullable chat reference with a cascade foreign key to
`jobs` and `events`, and convert `sim_provisioning_requests.chat_id` to the
same shape. Null means "not chat-flow" (system jobs, image telemetry for
library entities) and is exempt from the chat sweep. Existing `jobs` rows
backfill from the chat id already sitting in their payload. Writers pass the
chat id when they enqueue or log — every chat-lane leg already has it in hand.

**Deletion.** With the keys in place, deleting a chat sweeps its jobs, events,
and provisioning records by cascade: no new imperative cleanup, no sweep code
to forget. The existing pieces stay — transcript, state and participants
cascade, a participant-less memory group is purged, and a linked successor
world is hard-deleted.

**Images exception.** Character delete stops calling `deleteEntityImages` —
entity images (avatars, portraits, entity renders) survive with a dangling
`entity_id` as provenance. Scene images already survive chat delete and stay
unchanged. Two carve-outs from the exception, both already expressed in the
code:

- The Gallery-hidden chat-scoped kinds (`chat_upload`, `chat_look`,
  `chat_place`) **keep today's hard-delete on chat delete** (ruling 1): they
  can never appear in the Gallery, and uploads may be photos of real people.
- The hidden identity assets (the face crop an identity pack derives from, and
  admin trial outputs) are already deleted by their own named call on the
  character-delete path, precisely so that dropping `deleteEntityImages` never
  extends Gallery retention to an internal render input nobody browses.

**Retention.** The scheduling question is settled by what shipped: retention
deletions ride the **existing periodic sweep tick**, not a new module with its
own boot hook and interval. The tick already has a durable marker row, an
in-process throttle, and a diagnostic-only failure path. What it gains:

- telemetry `events` older than 30 days (ruling 2; a constant, retunable),
- `done`/`failed` `jobs` older than 7 days (ruling 2),
- expired auth sessions and verification records.

**Telemetry content minimization.** `retrieval` events store memory-search
queries verbatim — real player roleplay content — and agent-run details embed
voice lines. Retention shrinks the window; ruling 3 goes further:
**production stores ids and counts only** (raw query text has no production
reader and feeds no narration path), while development builds keep full
payloads for debugging and any future tuning corpus.

## Slices

0. **One-time purge of the existing orphans** — not run. Guarded SQL against
   Neon, reviewed before it runs, covering the classes the audit named:
   scope-less memory rows left by the R6 migration, stale `ready` provisioning
   records, jobs referencing deleted chats, the finished-jobs backlog, dangling
   image-reference and source-image pointers (nulled, not deleted), and expired
   auth sessions. Orphan avatars are **kept** — by-design under the ruling.
   Re-count before writing the statements; the audit's numbers are from
   2026-07-29.
1. **Schema + backfill** — not started. Chat foreign keys on `jobs` and
   `events`; `sim_provisioning_requests.chat_id` promoted to a real key;
   backfill jobs from their payload. These are pure adds and alters, so the
   migration should generate without an ambiguous rename prompt.
2. **Writers pass the chat id** — not started. The enqueue sites in the chat
   lane, and the event-logging sites that have a chat in scope (agent runs,
   agent failures, retrieval, composition fallback, chat-scoped image events).
   Provisioning stamps the chat id at the step where it already records the
   created chat.
3. **Deletion-path changes** — not started. Drop `deleteEntityImages` from
   character delete (the headline ruling), keeping the two carve-outs above;
   provisioning records now die with the chat via the slice-1 key. Document in
   `docs/images/asset-registry.md` and `docs/memory.md` that dangling entity and subject
   references are by-design provenance — a fact naming a deleted character
   belongs to the *observing* group's memory and is not scrubbed.
4. **Retention sweep** — half shipped 2026-08-02, half open. The sweep itself
   now runs (see above), so this slice is reduced to adding the three retention
   deletions to that tick and deleting the stale comments that still describe
   the sweep as something a caller merely hopes exists. Degradation tests per
   `docs/resilience.md`: a failed retention pass logs a diagnostic and never
   takes a turn down.
5. **Telemetry minimization** — not started. Trim retrieval and agent-run
   payloads in production to ids and counts, keeping full content only outside
   production, and preserving what the admin chat inspector actually reads.

Each slice updates the relevant system doc (`docs/images/`,
`docs/memory.md`, the jobs and events documentation) in the same change, and
the roadmap on completion.

## Open questions

None. The four raised at planning — hidden chat-image kinds, retention
windows, production telemetry content, account deletion — were all ruled
2026-07-29; see [data-lifecycle.audit.md](data-lifecycle.audit.md)
§"Rulings". Account deletion is parked in
[deferred.plan.md](deferred.plan.md) §"Account deletion".

## Non-goals

- At-rest encryption — its own queued plan
  ([at-rest-encryption.plan.md](at-rest-encryption.plan.md)). It reads the same
  columns this plan prunes, so shipping telemetry minimization first shrinks
  what encryption has to cover.
- Gallery UX changes (visibility filters stay as they are).
- Any change to the by-design dangling anchor-message semantics on images.
