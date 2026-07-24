# Successor world lifecycle — provisioning, deletion, and quota integrity

Status: draft (stub — successor-engine backlog item E20, parked 2026-07-24 from
the successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building)

## What

Three related integrity gaps around the `/worlds` front door
(`app/api/successor-chats/route.ts`):

**1. Provisioning is a non-atomic, non-idempotent five-step sequence** —
quota count (`:47-53`, no tx) → `provisionStarterWorld` (`:61`, itself five+
seeder transactions in sequence, `simulation/starter-world.ts`) → chat insert
(separate tx, `:71-79`) → conditional relationship seeding (`:93-117`, only
when `profile.playerRelationship` exists) → authority flip last (`:120`). The
route names its own partial states: `seed_failed` returns with world + chat
committed but authority still `legacy_chat` (an invisible unrouted chat +
live world), `flip_failed` at `:130` admits "the world was provisioned but the
chat could not be routed". World identity is minted fresh per call
(`starter-world.ts:54-56` `stw-${newId()}`), so the per-command idempotency
keys (`stw-${stamp}-${name}`) can never dedupe a retry — a retry builds a
second world. (HIGH · M)

**2. Deletion orphans the world.** `deleteChat`
(`chat-pipeline.ts:1971-2009`) removes chat assets, scene prompts, the chat
row (FK cascades), and memory — and touches no `sim_*` table. The FK points
the other way (`schema.ts:333` `sim_branch_id … onDelete: "set null"`), and
`sim_worlds` has no owner/chat back-reference, so every deleted successor
chat leaves a permanently unreachable world+branch. No production code
deletes `simWorlds`/`simBranches`; `sim_worlds.status` has an `"archived"`
enum value (`schema.ts:1024`) nothing ever sets. The Worlds page has no
delete/archive control even though the quota error says "delete one first"
(`route.ts:52`). (HIGH · M)

**3. The quota is racy and counts the wrong set.** Plain `SELECT` count at
`:47-53`, no lock/tx; the write that makes it true happens ~70 lines later —
two concurrent requests at N−1 both pass. The predicate
`ne(engineAuthority, "legacy_chat")` counts `successor_shadow` chats, which
`requireSimChat` rejects as unplayable (`sim-shared.ts:28-30`). Second-order:
a `flip_failed` orphan world never counts, so repeated failures mint
unbounded orphan worlds without tripping the cap. (MED · S)

## Why it matters

These are the highest data-integrity risks in the successor lane: partial
provisioning ships broken chats to real users, deletion leaks worlds forever
on Neon, and the quota neither serializes nor measures what it claims to
limit.

## Sketch

- Durable provisioning record with states
  `requested → world_created → chat_created → relationships_seeded → routed → ready`,
  keyed by a client-supplied idempotency key with deterministic derived ids
  (`composeSimulationId`), resumable retries, compensating cleanup, and the
  chat hidden from the UI until `ready`.
- A deletion ruling (owner): delete the private world+branches / archive the
  world (`status: "archived"` finally used) / detach and keep reusable — then
  implement transactionally, show the consequence in the confirm dialog, and
  add an orphan-world sweeper for the already-leaked rows.
- Quota inside a serializable tx or owner-scoped lock; count only playable
  successor worlds (or split limits for narrative vs shadow).

## Open questions

- Deletion semantics ruling (above) — the front door is 1:1 chat↔world today,
  which argues for delete-with-chat, but D19 forks and future multi-chat
  worlds argue for archive.
- Does provisioning stay synchronous (player waits on `ready`) or become a
  job with progressive UI? Sync is simpler and the seed is fast today.

## Slices

_(Defined at promotion.)_
