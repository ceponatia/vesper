# Engine boundaries

The engine's edges: which directory owns which layer of code, how a chat
reaches the engine at runtime, the purity rules that keep replay bit-exact,
and the limits the design deliberately does not cross.

## Package boundaries

The engine occupies three directories, one per authority layer (engine.spec §31):

| Directory                                 | Owns                                                  |
| ----------------------------------------- | ----------------------------------------------------- |
| `packages/simulation-core/src/contracts/` | Branded IDs, schemas, commands, events, registries    |
| `packages/simulation-core/src/lib/`       | Pure kernels — validators, resolvers, rates, policies |
| `apps/web/src/server/engine/simulation/`  | Stores, transactions, sequencer, scheduler, outbox    |

`contracts/` and `lib/` carry no database, network, file, process clock,
model, or global random dependency — the repository's ESLint
`no-restricted-imports` rule enforces the boundary, so it cannot quietly
regress under a routine import. The server layer holds one store per domain
plus the shared `runSimulationCommand` transaction shell, and modules there
import each other only through `index.ts` barrels.

This split is engine-specific: which files are pure and which are stateful.
The repo-wide rules for how packages relate to the app and to each other —
layer ranks, the `exports` map, the boundary and resolution lint gates — live
in [../architecture.md](../architecture.md). The package's own published
surface, dependencies, and test setup are documented in its own contract,
[../../packages/simulation-core/README.md](../../packages/simulation-core/README.md).

## Public API surface

The engine's public surface is intent-oriented — callers submit commands and
read projected state or perspectives, never write a field directly
(engine.spec §30):

- **Command and time** — `submitCommand`, `advanceTo`
- **Reading branch state** — `getBranchState`, `getActorPerspective`, `queryEligibleMemory`
- **Turn and scene** — `openEngagement`, `prepareTurn`, `getNarrativeCut`, `confirmNarratorResult`
- **Retakes and forks** — `rerenderCut`, `forkForRetake`, `rebuildProjection`
- **Audit** — `explainEvent`

No public entry exposes a raw setter — "set NPC location," "mark schedule
kept," "write current meter" — without a privileged migration or storyteller
capability (engine.spec §30). The reason is causal, not stylistic: every
state change the engine will admit traces back to a command and the events
it produced. A setter that skipped that path would leave state with no
event behind it, which replay could not reproduce and a fork could not
audit.

## Reaching the engine from chat

A conversation only talks to the engine once it is **routed** — successor
lane, `engine_authority` past the view threshold, branch and actors mapped.
Two chat-scoped routes carry that traffic, both gated by `requireSimChat`; a
legacy or shadow chat is refused with 409 `not_sim_enabled`, and the
conversation UI mirrors the gate client-side (it computes the same
`isSimRoutedAuthority` predicate from the transcript bootstrap) so a legacy
chat never even attempts the read (engine.spec §30).

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
`do_activity` each write a best-effort "world beat" message to the chat
transcript — a side effect, not part of the response. A failed beat write is
logged and never fails the command that already committed.

## Determinism and replay

The purity boundary in [Package boundaries](#package-boundaries) is what
makes replay reproducible, not merely modular: because `contracts/` and
`lib/` touch no database, network, file, clock, model, or global random
source, replaying the same event log through the same kernels always
produces the same projected state (engine.spec §31). That guarantee is what
lets a fork or a rebuild trust a from-scratch replay as the ground truth
against any accelerator built on top of it.

The one place true randomness enters the engine does not weaken this: a
consumer of a deterministic draw records the stream, index, value, and
derivation version on the event it produced, rather than depending on the
draw being reproducible on its own (detailed under
[Deliberate limits](#deliberate-limits) below).

The full numeric and performance contract — integer story time, explicit
sort order for deterministic collections, banned hidden `Date` /
`Math.random` / locale / floating-rounding behavior, and the profiling bar a
native rewrite would have to clear — is engine.spec §32.

## Deliberate limits

Durability today covers only the first item-transfer family. The in-memory
adapter remains a pure test and replay fixture; production persistence is
what actually supplies crash atomicity, cross-process branch locking,
durable command results, asynchronous rebuildable consumers, and a durable
trigger queue (engine.spec §30).

Three things the design leaves out on purpose, each because the shortcut
would break replay or the causal chain above:

- **No trigger cancellation.** Nothing mutates a trigger row to cancel it —
  a cancellation is an event effect exactly like creation would be (a
  `trigger_cancelled` family). Anything less and a forked replay resurrects
  an alarm the cancellation was meant to keep dead.
- **A trigger never sets location directly.** Movement is always a journey
  plus its arrival trigger; a scheduler outcome that wrote a location
  directly would bypass the movement laws that keep spatial state consistent
  (engine.spec §17).
- **Deterministic draws are recorded, never re-rolled.** Any consumer of a
  deterministic draw records its stream, index, value, and derivation
  version on the event that consumed it, so replay reproduces the recorded
  draw instead of drawing again.
