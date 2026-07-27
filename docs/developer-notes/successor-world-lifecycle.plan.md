# Successor world lifecycle — provision once, delete honestly, count what's real

Status: next (graduated 2026-07-27 from successor-engine backlog item **E20**,
parked 2026-07-24 from the successor engine & chat-UI product review. Owner
rulings recorded below — copy into engine.spec §39 at build. Queued at the top
of [roadmap.md](roadmap.md) §Next.)

Three integrity gaps around the `/worlds` front door, one theme: a successor
world's **lifecycle** must be as honest as its turns now are. **Provision
once** so a retry can never mint a second world; **delete honestly** so the
one destructive verb takes the world with the chat instead of leaking it
forever on Neon; **count what's real** so the quota measures playable worlds
under a lock instead of racing an unlocked count over the wrong set. The
sibling of [command-integrity.plan.md](command-integrity.plan.md) (turns) and
[sim-read-seam-guards.plan.md](sim-read-seam-guards.plan.md) (reads), closing
the same review's last HIGH items. Each slice is **independently shippable**.

## The three defects (re-verified 2026-07-27)

### 1 — Provisioning is non-atomic and non-idempotent (HIGH · M)

`app/api/successor-chats/route.ts` POST is a five-step sequence with no
shared transaction and no resume path: quota count (`:47-53`, plain SELECT,
no lock) → `provisionStarterWorld` (`:61`, itself sequential seeder
transactions in `engine/simulation/starter-world.ts`) → chat + participant
insert (separate tx, `:71-79`) → conditional relationship seeding
(`:85-118`, only when `profile.playerRelationship` exists) → authority flip
last (`:120-130`). The route names its own partial states: `seed_failed`
(`:115`) returns with world + chat committed but authority still
`legacy_chat` — an unrouted chat sitting in the ordinary chat list plus a
live orphan world — and `flip_failed` (`:130`) admits "the world was
provisioned but the chat could not be routed". World identity is minted
fresh per call (`starter-world.ts:54-56`, `stamp = newId()` →
`stw-${stamp}`), so the seeder's per-command idempotency keys
(`stw-${stamp}-${name}`) can never dedupe a retry — a retry after ANY
failure builds a second complete world.

### 2 — Deletion orphans the world (HIGH · M)

`deleteChat` (`engine/chat-pipeline.ts:1978-2030`) removes chat assets,
scene-prompt text, the chat row (FK cascades take transcript/participants/
state), and unshared memory groups — and touches **no `sim_*` table**. The
FK points the other way (`db/schema.ts:333`: `character_chats.sim_branch_id
→ sim_branches.id, onDelete: "set null"`), and `sim_worlds` has no
owner/chat back-reference, so every deleted successor chat leaves a
permanently unreachable world + branch + all branch-scoped rows. No
production code deletes `simWorlds`/`simBranches` (every `delete(simWorlds)`
in the repo is int-test cleanup); `sim_worlds.status` has an `"archived"`
enum value (`schema.ts:1075`) nothing ever sets. The Worlds page has no
delete control even though the quota error says "delete one first"
(`route.ts:52`). The schema already makes the fix one statement:
`sim_branches` cascades from `sim_worlds` (`schema.ts:1106`) and every
branch-scoped table cascades from `sim_branches`, so `DELETE FROM
sim_worlds WHERE id = …` takes the whole graph.

### 3 — The quota is racy and counts the wrong set (MED · S)

Plain `SELECT` count at `route.ts:47-53`, no lock or transaction; the write
that makes it true happens ~70 lines later — two concurrent requests at N−1
both pass. The predicate `ne(engineAuthority, "legacy_chat")` counts
`successor_shadow` chats, which `requireSimChat` rejects as unplayable
(`chats/[chatId]/sim-shared.ts:40`). Second-order: a `flip_failed` orphan
world never counts (its chat stays `legacy_chat`), so repeated failures mint
unbounded orphan worlds without ever tripping the cap.

## Owner rulings (2026-07-27 — copy into engine.spec §39 at build)

- **E20-1 Hard-delete with the chat.** The front door is 1:1 chat↔world, and
  the app already treats archive as the everyday action (`archived_at` on the
  chat) and delete as the one destructive verb — so deleting a successor chat
  deletes its world and branches in the same transaction, and the confirm
  dialog states the consequence. (Archive-the-world rejected — recoverable
  worlds need a UI story and a sweeper anyway; detach-and-keep rejected —
  needs an ownership back-reference and a re-attach flow that don't exist.
  D19 fork/multi-chat futures re-open this ruling if they land.)
- **E20-2 Sweep the already-leaked rows per the same ruling.** An
  orphan-world sweeper (worlds no chat references) hard-deletes them — a
  one-time cleanup for the existing leak plus a periodic guard against any
  future one.
- **E20-3 Provisioning stays synchronous, made resumable.** The player waits
  on one request (the seed is fast today); the fix is a durable provisioning
  record keyed by a client idempotency key with deterministic derived ids, so
  a retry **resumes** instead of re-minting. (Background-job provisioning
  rejected for now — more UI for no player-visible gain; revisit if starter
  worlds grow slow.)

## Design / sketch

**Provisioning record** — a `sim_provisioning_requests` table (the
`sim_command_requests` shape from command-integrity slice 4, one migration):
keyed `(ownerId, requestId)` with a state machine `requested → world_created
→ chat_created → relationships_seeded → ready | failed`, a canonical hash of
the request payload (`idempotency_mismatch` 409 on same-key/different-body),
and the final HTTP result for verbatim replay. The client mints a stable
`requestId` per tap; the route derives `stamp` **from the key**
(`composeSimulationId`-style) instead of `newId()`, so every `stw-${stamp}-…`
id — world, branch, actors, seeder command keys, the relationship-seed
idempotency keys (already branch-derived at `route.ts:99-103`) — becomes
stable across retries and the existing per-command dedupe finally does its
job. A re-POST with the same key resumes from the recorded state (skip
completed steps, finish the rest, flip, mark `ready`); a terminal failure
runs compensating cleanup (delete the world graph, the chat row if inserted,
mark `failed`) so no partial state survives as `seed_failed`/`flip_failed`
does today. The whole handler runs under an owner-scoped keyed lock
(`successor_provision:${ownerId}` — the `chat_exchange` seam from
command-integrity, reused), which also serializes the quota check.

**Deletion** — `deleteChat` learns the successor case: when the chat row
carries a `simBranchId`, resolve `worldId` through `sim_branches` and add
`DELETE FROM sim_worlds WHERE id = …` to the existing transaction (cascades
take branches and all branch-scoped rows; the chat-side FK's `set null`
never fires because the chat row dies in the same tx). The Worlds page gains
the missing delete control; both its confirm dialog and the chat-list one
say the world goes too (E20-1). Drop the never-set `"archived"` value from
the `sim_worlds.status` enum (app-level enum on a text column — code-only,
no migration; dead vocabulary under E20-1).

**Orphan sweep** — a world is orphaned when no `character_chats` row
references any of its branches and no provisioning record for it is in a
non-terminal state (grace: skip worlds younger than ~1h so an in-flight
provision is never swept). Sweep = the E20-1 delete. Ships as a maintenance
seam (`server/engine` function + admin route), run once at deploy for the
existing leak; the periodic guard rides the existing jobs seam.

**Quota** — inside the provisioning lock, count chats at
`successor_narrative_view` **plus** the owner's non-terminal provisioning
records (in-flight worlds hold a slot; `successor_shadow` no longer counts).
Derived count, not a tracked counter — the `checkStorageQuota` philosophy
(`server/api/quota.ts`): deletion frees a slot by itself. Keep the 409 with
its retry metadata shape from rate-limits.

## Slices (independently shippable)

1. **Deletion closes the leak** — the `deleteChat` successor branch (world
   graph deleted in-tx), the Worlds page delete control, consequence copy in
   both confirm dialogs, drop the dead `"archived"` enum value. Int tests:
   deleting a successor chat leaves zero `sim_*` rows for its world; a
   legacy chat delete touches none; ownership still re-proved in-service
   (security-authz slice 2 parity). (M)
2. **Orphan sweep** — the orphan predicate + hard-delete sweeper, one-time
   deploy run for the existing leak, periodic guard on the jobs seam, grace
   window. Int tests: orphan swept, routed world untouched, in-flight
   (young / non-terminal record) world untouched. (S)
3. **Resumable provisioning** — the `sim_provisioning_requests` migration,
   client `requestId`, key-derived `stamp`, owner-scoped lock, resume path,
   compensating cleanup, `seed_failed`/`flip_failed` retired. Crash-point
   int tests: kill after each committed step, re-POST converges to ONE
   world / ONE chat / `ready`; same-key replay returns the recorded
   response; different-payload same-key → `idempotency_mismatch` 409.
   Degradation tests assert fallback **and** diagnostic code. (M)
4. **Honest quota** — the locked count over `successor_narrative_view` +
   in-flight records (depends on slice 3's record; the lock can land with
   slice 3). Int test: two concurrent creates at N−1 → one 201, one 409.
   (S)

Order: 1 → 2 stop the bleeding and clean the past before 3 → 4 make the
front door honest. Slices 1+2 have no migration; slice 3 carries the one
migration.

## Testing

Resilience law throughout (docs/resilience.md): `parseOr` at the new route
boundary (requestId), diagnostics over exceptions, degraded defaults over
failed turns. Integration tests need Postgres and gate in CI. The
crash-point pattern from command-integrity slice 4 is the model for slice 3.

## Open questions

Resolved-by-lean (adopt unless owner redirects): **archiving a chat**
(`archived_at`) does *not* pause the world — the clock only moves on play,
so a shelved chat's world is already inert; `status: "paused"` stays unused
vocabulary until something needs it. **The sweeper's admin surface** is a
plain admin route + deploy-time call, not a cron — the periodic guard rides
the existing jobs seam only if the one-time sweep finds recurring leaks
(post-fix, slice 1 should make new leaks impossible).
