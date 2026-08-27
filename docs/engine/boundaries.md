# Engine boundaries

The engine's edges: which directory owns which layer of code, how a chat
reaches the engine at runtime, the purity rules that keep replay bit-exact,
and the limits the design deliberately does not cross.

## Package boundaries

The engine occupies three directories, one per authority layer:

| Directory                                 | Owns                                                  |
| ----------------------------------------- | ----------------------------------------------------- |
| `packages/simulation-core/src/contracts/` | Branded IDs, schemas, commands, events, registries    |
| `packages/simulation-core/src/lib/`       | Pure kernels — validators, resolvers, rates, policies |
| `apps/web/src/server/engine/simulation/`  | Stores, transactions, sequencer, scheduler, outbox    |

`contracts/` and `lib/` carry no database, network, file, process clock,
model, or global random dependency. `pnpm lint:package-boundaries`
(`scripts/check-workspace-imports.ts`) enforces the boundary: because
`@vesper/simulation-core` is declared a universal (browser/server-portable)
package, its `universal-runtime-dependency` rule fails any runtime import of
a server-only module (`pg`, `drizzle-orm`, `next`, `replicate`, …), and its
`universal-runtime-global` rule fails any reference to a single-runtime
global (`process`, `require`, `document`, `window`, …) — so the boundary
cannot quietly regress under a routine import. The server layer holds one
store per domain plus the shared `runSimulationCommand` transaction shell;
other application modules reach that layer only through its `index.ts`
barrel, while the store files inside the directory import each other
directly by relative path.

This split is engine-specific: which files are pure and which are stateful.
The repo-wide rules for how packages relate to the app and to each other —
layer ranks, the `exports` map, the boundary and resolution lint gates — live
in [../architecture.md](../architecture.md). The package's own published
surface, dependencies, and test setup are documented in its own contract,
[../../packages/simulation-core/README.md](../../packages/simulation-core/README.md).

## Public API surface

Every caller reaches the engine through
`apps/web/src/server/engine/simulation/index.ts`, the barrel other
application modules import through, which exports a domain-scoped function
per command or read rather than one generic entry point. The surface is
intent-oriented — callers submit commands and read projected state, never
write a field directly — just shaped as many functions:

- **Command submission** — one `submitDurable*` per domain (`submitDurableOpenEngagement`, `submitDurableMoveActor`, `submitDurableCreateCommitment`, `submitDurableMakeDisclosure`, `submitDurableTransferItem`, and dozens more), all running through the shared `runSimulationCommand` transaction shell
- **Branch state** — `assembleBranchState`, `readDurableBranchState`
- **Memory** — `queryMemoryDocuments`, `rebuildMemoryIndex`
- **Turn preparation** — `prepareEngagementTurn`, `submitDurableConfirmNarratorResult`
- **Narrative cut** — `loadPersistedCut`, `latestCutIdForEngagement`, `persistNarrativeCut`
- **Branching and rebuild** — `forkBranch`, `rebuildDurableBranchProjection`
- **Time** — `advanceBranchStoryTime`
- **Audit** — `explainItemPlacement`

There is no perspective or rerender entry point: a caller loads a cut by id
(`loadPersistedCut`) or narrative state by branch
(`assembleBranchState`/`readDurableBranchState`) instead.

No public entry exposes a raw setter — "set NPC location," "mark schedule
kept," "write current meter" — without a privileged migration or storyteller
capability. The reason is causal, not stylistic: every
state change the engine will admit traces back to a command and the events
it produced. A setter that skipped that path would leave state with no
event behind it, which replay could not reproduce and a fork could not
audit.

## Reaching the engine from chat

**Terminology.** Vesper has two distinct live conversation pipelines: the
**character-chat pipeline** and the **successor/simulation pipeline**. The
character-chat pipeline is not deprecated and should not be described as a
"legacy" system in documentation. The persisted authority enum still uses
`legacy_chat` as its historical wire value; that identifier remains until a
separate schema/API migration deliberately renames it.

A conversation only talks to the simulation engine once it is **routed** —
successor lane, `engine_authority` past the view threshold, branch and actors
mapped. Two chat-scoped routes carry that traffic, both gated by
`requireSimChat`; a character-chat-routed or shadow chat is refused with 409
`not_sim_enabled`. The gate is not recomputed client-side:
`GET /api/chats/[chatId]` computes `isSimRoutedAuthority` once, server-side,
and writes the result into the bootstrap payload as a plain `simRouted`
boolean; the conversation UI only reads that field, so a character-chat
conversation never even attempts the simulation-only read.

| Route                                  | Handler            | Returns                                               |
| -------------------------------------- | ------------------ | ----------------------------------------------------- |
| `GET /api/chats/[chatId]/world`        | `readSimChatWorld` | Player-facing world envelope (below)                  |
| `POST /api/chats/[chatId]/sim-command` | typed commands     | `{status, ...}` plus a durable world-beat side effect |

**The world read** returns the player-facing envelope: current place or
in-transit ETA, the non-player cast and their whereabouts, open destinations,
held items, the player-startable actions available at the current zone, and
whether a scene currently stands. The read is fail-open — a malformed
projection degrades to `null` (a 503 the client reads as "no card"), never a
throw, per the read-path default in `docs/resilience.md`. The pure shaping
lives in `packages/simulation-core/src/lib/world-read.ts`.

**Wardrobe authority follows the routed pipeline.** The successor narrator's
primary-character outfit comes from `sim_item_holdings` world truth. A
known-empty worn set is represented explicitly (`"no clothing"`), while
`null` means the simulation wardrobe read was unavailable/not applicable;
those states must never collapse into each other. The character-chat wardrobe
row is not a second authority for a successor-routed primary: the state PATCH
rejects actual wardrobe edits with `sim_wardrobe_managed_by_world`. Likewise,
the current character-chat scene-image route refuses new successor renders
with `scene_visual_authority_unavailable` until the simulation side exposes a
structured visual wardrobe projection with coverage/presentation data. This
is deliberately fail-closed: using character-chat clothing for the image
while narration reads simulation clothing would make two incompatible truths
for the same scene.

**The command route** carries the typed player commands, each an ordinary
durable command under the player principal; a refusal returns a public code,
reason, and legal alternatives, never a private cause:

| Command          | Effect                                                        |
| ---------------- | ------------------------------------------------------------- |
| `move`           | Relocate to an open, walkable destination zone                |
| `end_scene`      | End the standing co-present engagement                        |
| `give_item`      | Hand a held item to the present primary (player→primary only) |
| `start_activity` | Begin a player-startable action at the current zone           |
| `advance_time`   | Drain the branch clock forward through due triggers           |
| `travel`         | Composite: end scene gracefully, move, drain to arrival       |
| `move_together`  | Atomic walk-with-me: invite the co-present primary along      |
| `do_activity`    | Composite: start an activity, drain to its completion         |

Two of these are worth flagging for how they hold their atomicity boundary:

- **`travel`** ends a standing scene as a CHOICE first, so the move that
  follows never fires a hard interrupt, then moves and drains the branch
  clock to arrival within the same request. It is loop sugar over the
  ordinary move-and-drain events, not a bypass of them.
- **`move_together`** commits the scene-end, the journey, and its single
  arrival trigger as one branch-locked transaction, so "together" is true by
  construction rather than assembled from two separate moves. A version
  conflict degrades to an honest rejection — never a phantom solo departure,
  never a pair split mid-walk.

On commit, `travel` / `advance_time` / `end_scene` / `give_item` /
`do_activity` / `move_together` each write a best-effort "world beat"
message to the chat transcript — a side effect, not part of the response. A
failed beat write is logged and never fails the command that already
committed.

## Determinism and replay

The purity boundary in [Package boundaries](#package-boundaries) is what
makes replay reproducible, not merely modular: because `contracts/` and
`lib/` touch no database, network, file, clock, model, or global random
source, replaying the same event log through the same kernels always
produces the same projected state. That guarantee is what
lets a fork or a rebuild trust a from-scratch replay as the ground truth
against any accelerator built on top of it.

The one place true randomness enters the engine does not weaken this: a
consumer of a deterministic draw records the stream, index, value, and
derivation version on the event it produced, rather than depending on the
draw being reproducible on its own (detailed under
[Deliberate limits](#deliberate-limits) below).

The numeric contract underneath it: story time is an integer, deterministic
collections carry an explicit sort order, and hidden `Date`, `Math.random`,
locale-dependent, and floating-point-rounding behavior are banned.

## Deliberate limits

Durability spans nearly every domain — activities, access, engagements,
commitments, branches, material and item transfer, households, knowledge,
bodies, cohorts, LOD, promotion, routines, the relationship ledger, space
and movement, and the trigger scheduler, among others — each with its own
store persisting through Postgres. Most run through the shared
`runSimulationCommand` transaction shell (`command-runner.ts`), which
supplies the idempotency fast path, branch-row locking, duplicate-command
defense, optimistic version checks, and durable command-result persistence;
a handful of stores predate that shell and still inline an equivalent copy.
There is no in-memory adapter anywhere in the tree.

Three things the design leaves out on purpose, each because the shortcut
would break replay or the causal chain above:

- **No trigger cancellation.** Nothing mutates a trigger row to cancel it. A
  cancellation would have to be an event effect exactly like creation is, so
  that it replays; no cancellation event family exists today. Anything less and
  a forked replay resurrects an alarm the cancellation was meant to keep dead.
- **A trigger never sets location directly.** Movement is always a journey
  plus its arrival trigger; a scheduler outcome that wrote a location
  directly would bypass the movement laws that keep spatial state
  consistent.
- **Deterministic draws are recorded, never re-rolled.** Any consumer of a
  deterministic draw records its stream, index, value, and derivation
  version on the event that consumed it, so replay reproduces the recorded
  draw instead of drawing again.
