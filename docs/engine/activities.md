# Commitments, Activities, and Engagements

How the simulation engine tracks what a character is doing, what a character
owes the world, and who has a claim on a character's attention right now —
and how it settles conflicting claims before the narrator writes a single
word. For the physical world, access and consent, and travel between places,
see [world.md](world.md).

## Three kinds of claim

A character can be pulled in three different directions at once, and the
engine keeps each pull as its own construct rather than folding them
together:

- A **commitment** is an obligation on the calendar — a shift, an
  appointment, a promise — that has not necessarily started yet.
- An **activity** is what an actor's body is doing right now, the live
  occupant of that actor's attention and hands.
- An **engagement** is the live social frame — who is present, on what
  channel — that governs whose turn it is to act or react.

A commitment can generate the pressure that starts an activity (leaving for
a shift); an activity can be compatible or incompatible with an ongoing
engagement (cooking while on a call); and an engagement's own state changes
which activities and interruptions are legal. The reconciliation algorithm
below is where all three get resolved into one sequence of hard events
before any prose renders.

## Commitments and pressure

### Commitments

A commitment records an actor's obligation: who owes it, what kind it is
(a shift, appointment, promise, reservation, or standing routine), an
arrival window, how flexible it is, and how far along its own lifecycle it
has gotten. Flexibility runs from `soft` through `negotiable` and `firm` to
`hard`, and three separate timing knobs — preparation time, a reliability
buffer, and a notice lead — shape how much slack the actor gets before the
deadline actually bites.

A commitment carries a `knowledgeSource` — a tagged record of how the actor came
to know, not a bare id — that proves the actor has a
reason to know about it — a memory, an observation, an assertion, or a
belief the actor could plausibly hold. A calendar entry the player can see
is not automatically something the NPC knows; if the source becomes
unavailable, a new cue has to be perceived before pressure can act on it
again. This keeps an authored deadline from turning
into an NPC that mysteriously already knows what's coming.

A destination is optional. A commitment with nowhere to travel to still has
a deadline, but with no locus to check arrival against it can only ever
resolve `kept` (an explicit fulfillment before the deadline) or `missed`
(the deadline passes with nothing filed) — never `late`, since lateness
presumes travel in progress.

A commitment may also name the actor it runs toward — `promisedToActorId` —
when the obligation is interpersonal rather than solo. A commitment naming
a counterpart writes a directional ledger entry when it's kept, missed, or
later repaired; a commitment with no counterpart (a shift, a solo routine)
never does, because the ledger records evidence between two actors, not a
fact about one actor alone. Naming oneself as the counterpart is rejected
outright rather than silently accepted.

Commitment status moves through a fixed lifecycle:

| From        | Legal next states                              |
| ----------- | ---------------------------------------------- |
| planned     | noticed, accepted, declined, cancelled, missed, kept, late |
| noticed     | accepted, declined, cancelled, missed, kept, late          |
| accepted    | in_progress, cancelled, missed, kept, late                 |
| declined    | cancelled, or accepted again if renegotiated   |
| in_progress | kept, late, missed, cancelled                  |
| kept        | terminal                                       |
| late        | kept, missed, or a terminal consequence        |
| missed      | terminal, or repaired by a new commitment      |
| cancelled   | terminal                                       |

A `missed` commitment is never rewritten in place — its own row stays
`missed` forever. Repair means creating a new commitment of the same kind,
for the same actor, that names the missed one as what it repairs; the
repair is additional evidence, not a correction of the record.

### Pressure

Pressure is what turns a commitment into something an actor actually acts
on. Each pressure names its source commitment — the only source kind there is —
and carries three points in time — when the actor first
notices it, the latest moment a decision is still meaningful, and the
latest moment acting is still possible — plus a severity that climbs from
`background` through `salient` and `urgent` to `hard`.

For a commitment with a destination, the actor's must-leave-by time is
worked out backward from the arrival deadline: subtract the minimum route
duration, then preparation time, then the reliability buffer. That backward
calculation has to be redone whenever a material input changes — a
different route, a later preparation estimate — or the actor either leaves
too early on stale assumptions or, worse, too late.

As a deadline approaches, pressure moves through a consistent arc regardless
of what the commitment is: it enters the actor's look-ahead horizon, becomes
salient only once the actor actually knows about it, and from there the
actor can warn the player, prepare, negotiate, decline, or accept the
consequences of being late. Choosing to leave starts an activity and then a
journey, which consumes story time and can itself be delayed; arrival,
lateness, cancellation, or a missed commitment each emit their own
consequence event. Nothing about this makes the actor disappear at the
deadline — a player request to stay changes the decision's weighting, not
the travel time or the underlying obligation. Once a pressure has been
acknowledged, it is not re-raised every turn unless its severity or
assumptions change — otherwise every turn near a
deadline repeats the same warning.

## Actions and activities

### Actions

An action definition is the reusable template for something an actor can
do: which kinds of principal can control it, how long it takes, its
preconditions and required claims, its resource costs, how interruptible it
is (`free`, `pausable`, `abort_only`, or `locked`), and its privacy and consent
requirements. There is no authored `effects` field: starting acquires claims and
reserves items, completion spends or wears the resource costs the definition
already names, and failure applies nothing.
Privacy and consent gating on an action is the same access/consent model
[world.md](world.md) owns; an action definition just names which
requirement applies.

Aliases and display labels belong to language interpretation, not legality
— naming an action something friendlier does not change what it takes to
perform it. Any authored field that implies an enforcement rule has to
actually be enforced or removed; an inert field that looks like a
constraint but isn't checked is not acceptable. Consent
gating follows the same discipline: an action definition can name at most
one consent scope, and starting an action that names one without a
covering consent record is rejected before any claim or resource is
reserved — fail-closed, not fail-open.

### Activities

An activity instance is one live occupant of an actor's (or several actors'
shared) attention: which actors are in it, which action definition it's
running, its current phase, its progress, and the claims it holds. Two
kinds of claim exist — attention claims and exclusive claims — and starting
an activity atomically acquires whichever exclusive claims it needs;
completing, failing, or cancelling it releases them. Because claims are
projected from activity events rather than held only in memory, a crashed
worker can never leave a claim orphaned — replaying the events reconstructs
exactly what should still be held.

An activity's phase moves through:

| From        | Legal next phases                                 |
| ----------- | ------------------------------------------------- |
| queued      | preparing, active, cancelled, failed              |
| preparing   | active, interrupted, cancelled, failed            |
| active      | paused, interrupted, completed, failed, cancelled |
| paused      | active, interrupted, cancelled, failed            |
| interrupted | active, cancelled, failed                         |
| completed   | terminal                                          |
| failed      | terminal                                          |
| cancelled   | terminal                                          |

### Compatibility while an activity is underway

A graded compatibility matrix — conversation-while-cooking, hands-free calls
while driving, messages queuing unread for a sleeping actor — is **not built**.
The engine enforces one generic rule instead: a full-attention claim, on the body
or on attention, blocks joining any engagement on any channel, and a partial or
absent claim does not. Nothing distinguishes driving from cooking, and nothing
separates text from voice.

Message delivery and an actor perceiving that message remain different events, so
a delivered message never implies it was read.

## Engagements and live-scene arbitration

### Engagement lifecycle

An engagement is the live social frame a scene runs inside: its
participants, its channel (co-present, text, voice, video, or mixed), an
optional location and zone, its own attention claims, and which pressures it
has already surfaced to the player. Branch version is not one of its fields — it
is pinned onto the compiled NarrativeCut instead. A co-present
engagement needs the participants to actually share a compatible physical
locus; a remote one needs channel access and message delivery but not
co-location.

| From         | Legal next states                |
| ------------ | -------------------------------- |
| opening      | active, ended, interrupted       |
| active       | winding_down, ended, interrupted |
| winding_down | active, ended, interrupted       |
| interrupted  | active, ended                    |
| ended        | terminal                         |

Ending an engagement releases its attention claims but does not relocate
any participant — nothing about ending a scene teleports an NPC away. And
`winding_down` is itself a playable state, not a promise that the NPC stays
until the player agrees to let the scene end.

### Reconciliation

Every turn, before the narrator streams a single token, the engine runs a
fixed sequence that resolves commitments, activities, and engagement state
into hard, committed facts. In rough order: authenticate the player and
resolve the controlled actor, engagement, and branch; catch up any
scheduled triggers that came due; turn the player's message into a proposed
story-time interval; look ahead across that interval for pressures that
become relevant; enumerate the NPC responses, interruptions, warnings, and
departures that are actually legal given that state; pick one
deterministically (with a narrow allowance for a single deliberator call at
high level of detail on a close choice); commit the resulting commands as
one batch; compile the committed sequence into one immutable narrative cut;
stream prose from that cut; commit only the narrator's explicitly enacted
effects; and index the results into memory.

The point of running all of this before rendering is that the narrator
never gets to invent an outcome — it is not the narrator that decides a
schedule was kept, that an actor teleported, or that an item changed hands.
Those are committed facts by the time prose starts.

### External events and narrator failure

A compiled cut is pinned to a branch version and a maximum sequence number.
Anything committed while the narrator is still streaming has a higher
sequence and is not retroactively woven into that prose — the next turn is
what reconciles it. If an external event and the streaming cut would both
need the same body or claim, the command layer has to have rejected one of
them before either cut was compiled, so the two can never both hold the
same exclusive claim.

A narrator timeout or an invalid response is a presentation failure, not a
world rollback — whatever hard outcomes the cut already committed stay
authoritative regardless of what happens to the prose. The system can retry
the same model against the same cut, fall back to a smaller model, render a
minimal deterministic transition, or surface a retry to the player, but it
never implicitly reruns the simulation to produce a different outcome.

## Related

- [world.md](world.md) — physical topology, access/consent/entry, and
  journeys between places.
- [@vesper/simulation-core](../../packages/simulation-core/README.md) — the command and
  event envelopes actors use to start, join, and end activities and
  engagements.
