[← Vesper docs](../README.md)

# Simulation Kernel

The successor simulation engine's causal spine: the invariants every command and
event must satisfy, the components that enforce them, branded identity, story
time, determinism, and who is allowed to act. Persistence, transactions, the
command/event envelope shapes, and the scheduler live in
[commands-events.md](commands-events.md).

The engine (`apps/web/src/server/engine/simulation`, pure contracts in
`@vesper/simulation-core`) is event-sourced: a world type's authored rules
instantiate a world, a world holds one or more causally isolated branches, and
a branch is an ordered, replayable history of domain events. Nothing mutates
truth directly — every change is a command resolved into events, and every
read of "current state" is a projection rebuilt from that history.

## Vocabulary

| Term       | Meaning                                                         |
| ---------- | --------------------------------------------------------------- |
| World type | Authored rules, packages, calendars, and defaults for a setting |
| World      | One instantiated setting shared by one or more branches         |
| Branch     | One ordered, causally isolated timeline of a world              |
| Story time | Simulated time advanced only by committed game operations       |
| Sequence   | Total event order within a branch                               |

## Core invariants

### Physical and temporal

Every physical actor occupies exactly one PhysicalLocus in a branch — one
place and zone, or one journey — and every relocation traces to a cause: a
validated move, a journey arriving, a transport, a rescue, or an explicit
privileged override. A schedule or clock boundary alone
never changes location; only a resolved command or its journey/trigger
machinery does. Ordinary movement respects a route and a lower-bound travel
duration, so nothing teleports by skipping the trip.

An actor cannot hold incompatible exclusive activity, body, item, or attention
claims at the same story second — this is what stops one
actor from standing in two scenes, or holding an item it already gave away, at
the same simulated instant.

Wall-clock generation latency never advances story time:
an LLM call that takes ten seconds of real time advances the story by however
much narrative time the resolved command represents, not by the ten seconds.
This is also why a long skip and the equivalent run of smaller skips must
produce the same material outcomes for equal commands, ruleset, seed, and
exogenous inputs — determinism has to survive both
fast-forwarding and turn-by-turn play, or replay and skip-ahead diverge.

When a derived value causes history — it decided whether an event occurred,
which action won, what an actor observed, or a threshold crossing — the event
that used it captures the value or its full causal inputs and a derivation
version. A value that never influenced an outcome
can stay a cheap on-the-fly computation instead.

### Authority

The player controls only actors carrying an explicit controller grant for the
authenticated principal — narrative closeness (loving an
NPC, authoring the character) never implies control. An utterance about an NPC
is not an NPC command: "Mara comes here" is a request, invitation, prediction,
or unsupported assertion until Mara's own controller acts on it.

Everything an LLM emits is untrusted input: it passes schema, authorization,
precondition, and invariant validation before it can become a command or an
event, and a narrator specifically can never create a hard movement,
inventory, injury, body, access, commitment, observation, or knowledge event
on its own. A world director may introduce future
pressures and opportunities but cannot rewrite current truth without an
explicit privileged command, and any privileged relocation, retcon, or
storyteller action is separately authorized, logged, and visibly distinct from
ordinary causality — see [Principals](#principals)
below.

## Architectural components

The engine's ownership boundaries — not necessarily separate processes; an
initial deployment can be one modular monolith.

| Component            | Role                                                              |
| -------------------- | ----------------------------------------------------------------- |
| Command gateway      | Authenticates the principal, validates the envelope, idempotency  |
| Branch sequencer     | Serializes per-branch operations, assigns sequence numbers        |
| Pure kernel          | Validates preconditions, resolves commands into events            |
| Scheduler            | Evaluates due triggers, advances story time analytically          |
| Core projector       | Applies invariant-critical projections in the command transaction |
| Async projector      | Builds search, analytics, and embeddings through the outbox       |
| Live-scene arbiter   | Reconciles an engagement against due world pressure               |
| NPC policy           | Chooses routine legal actions deterministically                   |
| Deliberator          | Rarely selects among a bounded legal candidate set                |
| Perception engine    | Computes observation eligibility and evidence                     |
| Knowledge ledger     | Stores assertions, beliefs, provenance, and supersedence          |
| Context compiler     | Produces one redacted NarrativeCut                                |
| Narrator             | Renders prose from that cut                                       |
| Presentation auditor | Flags impossible or leaked claims; never mutates truth            |
| Memory indexer       | Represents eligible records for semantic recall                   |

"Kernel" in this document's title names the whole causal spine these
components enforce together, not only the single Pure kernel row above.

## Branded identity

Every identity family is a distinct nominal TypeScript type over the same
strict opaque-string shape. An ID is never
trimmed, case-folded, or resolved from a display name, so a
`LocationId` and an `ItemId` cannot be swapped by the type checker even though
both are strings underneath, and an entity's display name is never usable as a
foreign key, route target, access target, or memory-eligibility key.

| Identity            | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| WorldTypeId         | Versioned package and authored-rule selection                 |
| WorldId             | Instantiated setting                                          |
| WorldBranchId       | Causally isolated timeline                                    |
| CharacterTemplateId | Reusable authored character definition                        |
| WorldCharacterId    | One instantiated character body and life in one world         |
| PlayerCharacterId   | A WorldCharacter role controlled by a player principal        |
| LocationId          | Stable place                                                  |
| ZoneId              | Sub-area with its own access, privacy, and occupancy          |
| LinkId              | Traversable connection between zones or locations             |
| ItemId              | Stable material object or fungible lot                        |
| ActionDefinitionId  | Versioned action contract                                     |
| ActivityInstanceId  | One attempted action over time                                |
| CommitmentId        | One obligation, promise, appointment, reservation, or routine |
| JourneyId           | One in-transit movement                                       |
| EngagementId        | One conversation or interaction                               |
| EventId             | Globally unique event identifier                              |

Deterministically derived identities — an event ID derived from its branch and
command, for instance — use length-prefixed parts rather than delimiter
concatenation, so an event's identity includes both branch and command
identity: the same command ID replayed on a causally isolated branch cannot
collide in the global event catalog. Every branch-scoped mutable row carries
its `WorldBranchId`.

`CharacterTemplateId` is declared in the identity vocabulary and **is not wired
to anything**: no template table, no instantiation path, no editing flow. Treat
it as reserved rather than as a described mechanism. The separation it anticipates
— authored input distinct from the historical identity that plays it out, so
editing an author's template never silently rewrites an instantiated character's
past — is a contract intent, not current behavior.

Numeric causal primitives follow the same discipline: story time and branch
versions are nonnegative safe integers, event sequence and schema version are
positive safe integers, and fractional, negative, infinite, or unsafe-integer
values are rejected at the trust boundary rather than silently coerced.

## Story time and determinism

### Representation and ordering

Story time is an integer `StorySecond` relative to the world's calendar
epoch. Within a branch, events order by branch sequence first, story second
next, and — only to resolve simultaneous due work — stable trigger priority
and trigger ID last: sequence, not timestamp, breaks ties. That ordering is
why replay is deterministic even when two triggers land on the same story
second.

### Advancement

Story time moves only through a committed operation — a dialogue span under
the configured turn-duration policy, a validated action, a wait, travel, a
skip, or a privileged time advance. It is monotonic within
a branch: nothing moves it backward, because "earlier" is a branch fork, not a
negative-duration command. A `requestedStorySecond` on a command is only a
request; the kernel checks it against the current branch time and the
principal's capabilities before honoring it.

### Randomness

No kernel code reads ambient randomness. Every random result derives from a
named stream: `deterministicDrawUnit` keys a draw on world seed, branch ID, a
stream identifier, and a draw index, and callers compose that stream identifier
from the causal command ID plus a purpose label — the same key
always reproduces the same draw. The ruleset version is **not** part of the draw
key. Iteration order is fixed
before drawing, and when a sampled result affects history, the event records
both the chosen result and the random-stream version.

### Derivation

A pure, path-independent view — daylight from calendar and coordinates, age
from birth date and story time — can be recomputed on demand without being
written down. A derivation becomes historical, and must be recorded on the
causing event, the moment it decides whether an event occurs, which action
wins, which route is taken, what an actor observes or remembers, resource
consumption, a stochastic sample, or a deadline crossing.

## Principals

Every command carries a principal and a capability set:

| Principal kind  | Normal authority                                         |
| --------------- | -------------------------------------------------------- |
| player          | Controlled player actors, player-owned UI operations     |
| npc_policy      | One NPC actor under deterministic policy                 |
| npc_deliberator | Selecting among candidate IDs already legal for one NPC  |
| system          | Due triggers, mechanical consequences, projection repair |
| director        | Future pressures, opportunities, casting proposals       |
| storyteller     | Explicit world-type-defined privileged operations        |
| migration       | Versioned, audited data conversion                       |

Controller grants are checked independently of narrative viewpoint: seeing,
loving, or having authored an NPC does not grant moment-to-moment
control of it in a shared world — only an explicit controller grant does,
which is why `npc_policy` and `npc_deliberator` exist as their own principal
kinds rather than folding into `player`.

Storyteller authority is never a hidden flag on an ordinary command. It uses a
distinct command family (e.g. `StorytellerRelocateActor`) and emits an event
whose privileged cause is visible to audit tooling; the ordinary `MoveActor`
command has no bypass path. This restates the authority
invariant above at the command-family level: privileged causality is always
structurally distinguishable from ordinary causality, never just documented
as such.

## Related

- [commands-events.md](commands-events.md) — command and event envelopes,
  persistence, transactions, and the scheduler.
- [@vesper/simulation-core](../../packages/simulation-core/README.md) — the TypeScript
  identity, envelope, and replay contracts this document describes in prose.
