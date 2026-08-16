# NPC mind: policy and perception

How a simulated actor decides what to do next, and what it can know about an
event that just happened. This covers the deliberation loop (candidate
generation, deterministic scoring, the routine controller, and bounded model
escalation) and the perception model that feeds it. Belief, gossip, and
relationship history built on top of perception live in
[knowledge.md](knowledge.md); how a decision and its perceptible evidence turn
into prose lives in [narration.md](narration.md).

## Deciding what to do

Every actor decision is a funnel: a legality pass narrows the field first, a
deterministic score picks among what remains, and a model is consulted only in
the narrow case where the deterministic layer cannot separate two live
options.

### Candidate generation

A candidate action reaches scoring only after surviving a legality pass
rooted in controller authority, physical locus and route, active claims and
activity compatibility, access/privacy/consent, resource and body
capability, actor knowledge and perceived cues, commitments and deadlines,
and world-type safety rules (engine.spec §19.1). An action illegal under any
of these checks never reaches scoring at all — the funnel narrows before
utility runs, so utility never has to reason about actions the world already
forbids.

### Deterministic scoring

There is no single multi-factor scoring formula. Each escalation site scores its
own narrow candidate set: the routine controller weighs circadian sleep pressure
against a flat obligation penalty plus a meal weight, and the narrative-departure
escalation ranks unresolved pressures on deadline lateness alone. The broader
factor set §19.2 describes — goal progress, habit and role, safety risk, effort
cost, interruption cost, a seeded variation term — is **not implemented**.
The score breakdown can be kept as an audit explanation, but it never
contains or claims to expose a model's private reasoning — deterministic
scoring has no reasoning to leak in the first place (engine.spec §19.2).

### The routine controller

Background-life actors — those simulated at the coarse level of detail used
when nobody is watching a scene closely — get their moment-to-moment behavior
from a durable routine controller rather than ad hoc scheduling. A
routine-policy alarm arms when such an actor's body is being tracked, and
fires at the actor's next routine boundary: the start of the sleep window, or
the start of any authored meal rhythm window, whichever comes first
(engine.spec §19.2.1). Firing re-validates that the actor is still eligible
(still at the coarse level of detail, body tracked, not already asleep)
before resolving anything, and resolution is entirely deterministic — the
routine controller never consults the model deliberator described below; a
routine choice is a no-model decision by definition (engine.spec §19.2.1).

The candidate set is closed and small:

| Candidate   | Legal gate                                    | Always legal? |
| ----------- | --------------------------------------------- | ------------- |
| begin_sleep | inside the sleep window; no blocking claim    | no            |
| eat_meal    | inside a meal window; an eligible item exists | no            |
| hold        | none — the universal fallback                 | yes           |

Vocabulary order is the tie order: a later candidate must strictly outscore
the current winner, so any tie collapses back to `hold`. A candidate scores
zero outside its own rhythm window, so a routine firing at the wrong time of
day can never turn a hold into an unscheduled nap (engine.spec §19.2.1).

Scoring detail:

- `begin_sleep` scores the actor's circadian pressure, minus a large penalty
  applied when an unresolved obligation's deadline falls inside the would-be
  sleep window — large enough that a live obligation outranks routine
  bedtime, though heavy sleep debt still eventually outranks the obligation
  as pressure keeps climbing. The penalty attaches to sleep rather than to
  `hold`, so an evening obligation cannot also starve an instant midday meal
  along the way (engine.spec §19.2.1).
- `eat_meal` scores a flat value inside its window, high enough to beat
  routine bedtime when a sleep and meal window happen to overlap but below
  what heavily overdue sleep eventually reaches. Eating is instantaneous, so
  no obligation penalty ever applies to it (engine.spec §19.2.1).

Eligibility for `eat_meal` additionally requires finding a real, unreserved
food item authored with a meal-source consumption effect, owned by nobody or
by the actor, not sealed inside an inaccessible container, and rooted at the
actor or the actor's zone — an item the actor is already holding is
preferred over one in the zone, with a lexicographic id break settling any
remaining tie. Routine behavior never eats against someone else's ownership
(engine.spec §19.2.1).

Every decision — every candidate's score, the winner, the admitting level of
detail, and the chosen sleep condition or meal item — persists as a decision
record. It is not itself perceptible, not a narrative beat, and not
memory-eligible. The chosen sleep or meal then commits through the same
state machinery a player-directed sleep or meal command would use, so a
routine decision and a commanded one are indistinguishable in the resulting
record. A hold or a completed meal re-arms the controller for the next
boundary, and a missed window self-heals at the following one rather than
requiring recovery logic (engine.spec §19.2.1).

### Escalating to a model

A candidate set can reach scoring without a clear winner — two options close
enough that picking between them deterministically would be arbitrary. Only
in that case may an LLM deliberator run, and only when every one of these
holds at once: the actor is at a level of detail that supports model
inference, at least two legal candidates remain, their score gap sits below
a configured threshold, the outcome is actually consequential, the branch
still has model budget, and a deterministic fallback exists if the call
fails (engine.spec §19.3).

The prompt the deliberator sees carries opaque candidate IDs and bounded
evidence rather than raw game state. It can select one ID and attach a short
rationale summary that the player never sees, but any new action text it
writes is ignored (engine.spec §19.3) — the deliberator chooses among
candidates the deterministic layer already generated; it can never invent an
action of its own.

## What an NPC can perceive

Perception is the gate between something happening in the world and an actor
being able to act on, remember, or discuss it: for every event it computes
whether that event produces evidence for a given viewpoint (engine.spec
§20). The gate is **deliberately coarse in v1**: it grades by how the evidence
arrived, not by who the witness is. A fixed table maps event type, channel
(sight, sound, touch, smell, device, social) and zone/location co-presence onto
a confidence and detail tier. Lighting, cover, distance, barriers, attention,
impairment, salience and communicated-information authentication are named by
§20 but are not computed — they are deferred to a bumped derivation version.

Where an event does produce evidence, that evidence is a first-class row:

    type Observation = {
      id: string;
      branchId: string;
      sourceEventId: string;
      // Denormalized from the source event so interval reads never join the log.
      sourceEventSequence: number;
      witnessActorId: string;
      storySecond: number;
      channel: string;
      evidenceClass: string;
      confidenceFixedPoint: number;
      detailTier: number;
      derivationVersion: string;
    };

An event can produce zero, one, or many observations — a shout in a plaza
may be witnessed by everyone present and by no one behind a closed door a
room away. Eligibility computed this way has to be read back explicitly by
every query that needs it, never assumed just because a row exists
(engine.spec §20).

Not every momentary sensory detail earns a durable row: persistence is
reserved for observations that go on to affect belief, memory, action
choice, relationships, evidence, or narration continuity (engine.spec §20).
A detail nothing will ever ask about again does not need to outlive the
moment it happened.

## Related

- [knowledge.md](knowledge.md) — what an actor believes once perception
  feeds it evidence, and how belief spreads as gossip and settles into
  relationship history.
- [narration.md](narration.md) — how a viewpoint's perceptible evidence and
  the mind layer's decisions compile into the cut the narrator writes from.
