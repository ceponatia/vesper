# Level of detail

Level of detail (LOD) is how the simulation engine keeps a large, populous world
affordable to run: it trades simulation resolution and model spend against what a
scene actually needs. The two are independent axes tracked per actor — how much
simulation an actor gets, and how much inference (model spend) a decision about
that actor gets.

## Simulation LOD

### Levels

| Level     | Resolution                                                       |
| --------- | ---------------------------------------------------------------- |
| exact     | Explicit activities, claims, resources, routes, and observations |
| event     | Resolves named actors only at material transitions               |
| aggregate | Resolves population/institution flows as sampled outcomes        |
| dormant   | Performs no scheduled work until a dependency or wake trigger    |

LOD changes how much resolution an actor gets, never what is true about the
world — a dormant actor's meters still drift correctly underneath it, and every
invariant that holds at `exact` holds at `dormant` too (engine.spec §27.1).

### Promotion

Promotion from `aggregate` to `exact` follows one fixed shape: identify the
aggregate facts already committed, reserve the conserved quantities they draw
down, sample any missing detail from a named deterministic stream, emit a
materialization event, and preserve every known observation, commitment,
relationship, and causal constraint. The engine never materializes a detail
that contradicts something already observed — promotion fills in blanks, it
never overwrites history (engine.spec §27.2).

This same five-step shape underlies both item promotion (a cohort's tracked
goods becoming one lot-tracked item) and actor promotion (a cohort member
becoming a named actor, below) — one mechanism serving two subjects
(engine.spec §27.2, §27.7).

### Demotion

Demotion compacts unobserved routine detail into a summary projection;
immutable material events are never rewritten or discarded. An actor cannot
demote out of active work: an active contested claim, a held named scarce
item, an unresolved commitment, or a near-boundary hazard (an expiring body
condition) each block it (engine.spec §27.3).

The guards run in a fixed order at assignment time — claim-holding
activities, then unresolved temporal pressures, then claim-holding
engagements, then, only when landing below `event`, an active body
condition — and the first one to trip names the rejection. Only a move
toward *less* simulation resolution is guarded this way: raising resolution
for an actor whose full state already exists is bookkeeping, and moving the
inference axis is a spend dial with no world consequence to guard against
(engine.spec §27.4, §27.5).

In practice the guards do the compaction's job before demotion ever runs:
everything that would need summarizing is already forced closed first, so the
actor's ordinary persisted rows — meters, holdings, ledger entries — serve as
the summary projection. No separate summary artifact exists (engine.spec
§27.7).

### The per-actor LOD ledger

Simulation LOD and inference LOD (below) are independent axes tracked on one
row per actor. The ledger is sparse: an actor with no row reads versioned
registry defaults — `exact` simulation resolution plus full deliberation on
the inference axis (the registry key is `actor-lod-v1`) — so leaving an actor
unassigned changes nothing (engine.spec §27.4).

Only the storyteller and system principals can assign a LOD
(`assign_actor_lod`). Every assignment is audited as an `actor_lod_assigned`
event whose payload captures the values it replaced, so the history explains
itself without needing to re-read prior state. Assigning a LOD is bookkeeping,
not a world event: it produces no observation, no memory document, and no
narrative beat (engine.spec §27.4).

Every consumer resolves an actor's LOD the same way, through one read seam —
the assigned row, or the defaults. Two call sites read it today: admission to
full deliberation reads the acting NPC's inference LOD, and consent
escalation reads the deciding target's (engine.spec §27.4).

### The below-event alarm law

Below `event` — `aggregate` or `dormant` — an actor is scheduled no work at
all: no meter alarms, no routine alarm, nothing fires until something wakes
them (engine.spec §27.5).

- An actor cannot land below `event` while a body condition is active. A live
  self-expiring condition is a near-boundary hazard: retiring its expiry
  alarm while it is still running would leave the projection lying about when
  it ends, so a sleeping actor waits until the condition clears.
- Whenever an actor's simulation axis moves at all, its full set of body
  alarms — every meter's threshold alarm plus the collapse alarm — is retired
  and, only if the new level is `event` or `exact`, re-armed fresh from
  current law. Landing below `event` re-arms nothing. Moving only the
  inference axis never touches body alarms.
- Initializing a body for an actor already below `event` sets up the meters
  (they read correctly and lazily) but arms no alarms — the no-scheduled-work
  rule holds even at creation time.
- Forking a branch replays this the same way: a simulation-axis-moving
  assignment retires the actor's alarm keys during replay exactly as it did
  live, so a forked child never inherits a phantom alarm.

Being below `event` never changes what a read returns: a dormant actor's
meters keep drifting analytically underneath and integrate lazily whenever
something reads them. LOD gates scheduled work, never the read path
(engine.spec §27.5).

Waking an actor is a promotion back to `event` or `exact` — either an
explicit assignment, or the automatic wake an engagement causes when it
reaches a below-event participant (below). Any other command that targets a
below-event actor is treated as an authored intervention: it needs the actor
promoted first, because its own alarms would otherwise fire against an actor
scheduled for no work (engine.spec §27.5, §27.7).

### Population cohorts

A cohort is a branch-scoped, conserved count of unnamed background people —
one row regardless of how many people it represents. It exists only through a
`cohort_created` event (storyteller/system principals; the zones it can be
present in are validated at creation) and changes only through
`cohort_adjusted`: signed integer deltas carrying one of a closed set of
reasons — authoring, an influx, attrition, or a promotion reservation. Every
adjustment records both the replaced and resulting count, so the audit trail
needs no extra reads. An adjustment that would take the count below zero is
refused outright, never silently clamped (engine.spec §27.6).

Presence is where the `aggregate` level (above) becomes concrete, and it is
fully analytic: authored minute-of-day windows each place
`floor(population × share / 10 000)` people at one zone; outside every window
the cohort disperses. Reading presence writes nothing, arms no triggers, and
calls no model — it is a pure function of authored data and the story clock,
so a population of ten costs the same per-minute work as a population of ten
thousand. A zone the read reports as empty is a real answer ("the square is
empty tonight"), not a missing one (engine.spec §27.6).

Cohort bookkeeping is invisible the same way LOD assignment is: it derives no
observation, becomes no beat, and is never remembered — a crowd's ebb and
flow reaches a viewpoint only by reading presence directly (engine.spec
§27.6).

A cohort can carry a coarse means band (the actor/household/cohort
vocabulary), but it can never be lot-tracked — a cohort's means read is
always either a band or `unknown`, by construction, because nothing
individually identifiable exists within it to track. Institutions today are
modeled as households plus restock; a cohort does not represent zone-level
shop stock (engine.spec §27.6).

### Actor promotion, dependency wake, and catch-up

Promoting a cohort member into a named actor is the only way a named actor
comes to exist mid-branch — every other actor is seeded at branch creation.
`promote_actor_from_cohort` concretizes the general five-step promotion shape
(above) for actors specifically, and only the storyteller/system principals
can invoke it (engine.spec §27.7):

1. the source cohort's committed count is the aggregate fact being drawn on;
2. a reservation debit against that cohort happens first, chained to the same
   cause — the actor can only come to exist because the aggregate provably
   gave up a member; a cohort with nothing left to give refuses the
   promotion outright;
3. any detail the caller did not supply (most commonly a name) is sampled
   from a named deterministic stream against the cohort's authored pool —
   replay never re-samples, it replays the recorded draw; a name request
   against a cohort with no authored pool is refused rather than inventing
   one;
4. one `actor_materialized_from_aggregate` event records the materialization:
   it creates the actor's row, places them at a named zone, and pins their
   landing detail levels to `event` or `exact` (`dormant` or `aggregate`
   would contradict a person now existing);
5. the materialization is legal only at a zone the aggregate's own presence
   read would admit a person into — inside a covering window with at least
   one person present there or dispersed elsewhere, or anywhere while every
   window is closed. A zone presence reports empty cannot yield a promoted
   person.

A promoted actor's identity derives deterministically from the command that
created them, so two promotions can never collide. Headcount stays exactly
conserved when a cohort's presence share is the whole population; at a
fractional share the ±1 rounding wobble at the promotion boundary is the
aggregate's own approximation being honest about itself, not a break in
conservation — the underlying conserved count never wobbles (engine.spec
§27.7).

Like LOD assignment, a promotion event is pure bookkeeping: no observation,
no beat, no memory document records it. The person was already there in
aggregate; only what they do afterward becomes perceptible, through the
ordinary event rules that apply to any actor (engine.spec §27.7).

**Dependency wake.** Opening an engagement with a below-event participant
promotes them to `event` as part of the same transaction (their inference
axis is untouched) — attention is something a below-event actor cannot
supply, since by definition they perform no scheduled work. If the engagement
itself is rejected, nothing wakes. Opening an engagement is the only kind of
command that wakes a below-event actor this way; every other command still
needs the actor promoted first (engine.spec §27.7).

**Catch-up.** A newly woken or promoted actor never needs retroactive events.
Meters integrate lazily and analytically from their last known boundary
regardless of how long they were dormant, and every alarm re-solves fresh
from current law at wake time — jumping a long dormant span in one hop
produces the same state as if the actor had never been dormant at all
(engine.spec §27.7).

## Inference LOD and model budget

Inference LOD is the second, independent axis: how much model spend a
decision gets, decoupled from how exactly the actor's physical state is
tracked. A physically `exact` activity may need no model call at all, while a
decision made at the `aggregate` level can still justify a full deliberation
(engine.spec §28).

The default turn spends exactly one model call:

| Turn stage           | Model calls         |
| -------------------- | ------------------- |
| Input admission      | deterministic, zero |
| World reconciliation | deterministic, zero |
| Context compilation  | deterministic, zero |
| Narration            | one narrator call   |
| Routine state agents | zero by default     |

Anything beyond that default — an extra deliberation, a background agent —
needs an explicit budget and a defined fallback for when it is skipped.
Background agents never fan out once per NPC or once per meter; batch
classifiers, deterministic reducers, and outbox workers do that work instead
(engine.spec §28).

## Invariants

- An actor below `event` performs no scheduled work of any kind — no meter
  alarms, no routine alarm — until something promotes or wakes it (§27.5).
- Promotion never materializes a detail that contradicts something already
  observed or committed (§27.2).
- A cohort's count never goes negative and never silently clamps; it fails
  closed as a structured rejection instead (§27.6).
- LOD assignment, cohort adjustment, and actor promotion are bookkeeping —
  none of them produce an observation, a memory document, or a narrative beat
  (§27.4, §27.6, §27.7).
- Reads never depend on LOD: a dormant actor's meters are always correct at
  read time, because LOD gates scheduled work, not the read path (§27.5).
- Simulation LOD and inference LOD are read and assigned independently —
  moving one never implies moving the other (§27.4, §28).
- The default turn makes exactly one model call, the narrator's; everything
  else is opt-in and budgeted (§28).

## Related

- `engine.spec.md` — the normative
  contract; §27–§28 are this doc's source.
- [@vesper/simulation-core](../../packages/simulation-core/README.md) — the engine's
  broader event-sourced contracts (identities, envelopes, branching).
