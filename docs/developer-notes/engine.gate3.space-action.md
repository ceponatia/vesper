# Engine plan — Gate 3: space, action, schedules, and live-scene arbitration

Part of the [engine.plan.md](engine.plan.md) gate set (split 2026-07-21; one doc per
gate — see the hub's gate index). Sequencing and current status live in
[roadmap.md](roadmap.md) and the hub; normative contracts live in the
[engine.spec.md](engine.spec.md) §-index.

## Gate 3 — space, action, schedules, and live-scene arbitration

Status: **ADVANCE — closed 2026-07-18.** E3.1–E3.5 shipped in dependency order
(2026-07-17/18, see §"Gate 3 build order"), the scenario corpus ran green (5 scenarios,
zero model calls, 2 709 pure + 351 integration tests), and the owner ruled advance on
2026-07-18. Open leftovers carried into later gates are recorded per-target in the build
order below (interim witness rule → Gate 4; hazards/`journey_delayed`, trespass texture,
route-uncertainty ruling 12 → travel polish; interpersonal consent → Gate 5).

Rough effort: **15–35 developer-days**.

This phase proves that world events become playable transitions rather than teleports.

### G3.1 Authoritative space

Add locations, zones, links, routes, passability, travel modes, containers, physical
loci, and explicit in-transit journeys. Movement must have a cause and a lower-bound
duration.

### G3.2 Typed actions and resources

Replace labels-plus-minutes with action definitions that include:

- preconditions and legal actor controllers;
- duration or duration distribution;
- exclusive claims and resource costs;
- interruptibility and resumability;
- start, progress, completion, failure, and cancellation effects;
- observation emissions;
- privacy, access, and consent requirements.

### G3.3 Commitments and temporal pressure

Represent work, appointments, promises, reservations, and routines as commitments with
earliest, target, and latest boundaries. Derive noticeAt, decideBy, and actBy from route,
preparation, reliability buffer, priority, and flexibility.

A 4pm shift must become:

1. upcoming pressure;
2. an acknowledged warning or internal decision;
3. preparation and departure;
4. a journey with a legal route and travel time;
5. arrival, lateness, cancellation, or a missed-shift consequence.

The schedule must never set location directly.

### G3.4 Engagement and live-scene arbiter

Make conversation an Engagement that claims attention but does not suspend the world.
Before narration, the arbiter:

1. drains due triggers;
2. integrates state through the proposed story-time boundary;
3. looks ahead through the pressure horizon;
4. enumerates legal outcomes;
5. chooses by deterministic policy or, rarely, an LLM deliberator;
6. commits physical outcomes;
7. compiles one NarrativeCut;
8. lets the narrator render it;
9. confirms only armed semantic effects.

### G3.5 Access, privacy, and player authority

Implement separate checks for route access, property entry, zone entry, current privacy,
and interpersonal consent. Missing or malformed private access data fails closed.

- “I go to Mara's house” can route the player to the doorstep; it does not grant entry.
- “Mara comes here” is a request or invitation; the NPC controller decides and travels.
- an NPC showering, sleeping, changing, working, or already in another physical
  engagement cannot be teleported into the scene;
- trespass or forced entry, if the product permits it, is an explicit time-consuming,
  noisy, witnessable action with consequences;
- storyteller override is a distinct, audited capability, never an accidental parse.

### Gate 3 scenario corpus

At minimum:

- a 4pm shift with advance notice and travel;
- pressure from the player to stay;
- flexible bedtime and hard sleep interruption;
- a shower with private cause redaction;
- attempted NPC summon;
- attempted uninvited home and bathroom entry;
- two concurrent chats competing for one NPC body;
- a delayed route and late arrival;
- narrator text that claims an impossible teleport;
- rerender during a committed journey.

### Gate 3 exit

All scenarios preserve one body, one physical locus, causal movement, access separation,
actor control, perspective safety, and deadline consequences. No model call is required
for routine departures.

