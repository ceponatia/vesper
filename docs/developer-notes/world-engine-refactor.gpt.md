# World engine refactor — GPT supplemental review

Status: **supplemental architecture review — corrected after adversarial verification**

Companion to [world-engine-refactor.plan.md](world-engine-refactor.plan.md) and
[gpt-sim-design.plan.md](gpt-sim-design.plan.md). This document does not replace either
plan. It identifies where the two analyses reinforce one another, where they imply
different architectures, and which additional decisions follow from reading them
together—especially in light of the owner answers embedded in the open questions of the
Claude plan.

## Executive synthesis

The plans agree on most of the product philosophy:

- the successor is character chat generalized into a world, not a resurrection of the
  deprecated session lane;
- story time, not wall time, remains authoritative;
- deterministic code should do nearly all routine simulation;
- LLM calls must be rationed and should propose rather than directly mutate canon;
- physiological substrate should be separated from what a narrator can perceive;
- LOD is necessary as the roster and world grow;
- the current aggregate state and agent fan-out cannot simply grow without bound.

Claude's plan is strongest as a locally grounded feature catalog and latency/call-budget
analysis. It correctly finds several high-value seams already latent in the code:

- the substrate/read split;
- the need for a salience bus;
- a composed `SceneFrame`;
- the cost hidden inside the settle lock;
- schedule activity kinds;
- cheap, deterministic environment derivation;
- LOD for roster-sized post-turn fan-out.

The GPT plan is stronger on authoritative state, causality, identity, concurrency,
perspective, and long-run extensibility:

- commands and stable IDs;
- domain events and versioned projections;
- an event scheduler rather than a world tick;
- world truth distinct from character belief and narration;
- a deterministic narrator context compiler;
- normalized high-churn state;
- durable jobs, replay, branching, and idempotency;
- structured knowledge before vector retrieval.

The central tension is Claude's thesis **“derive the world, remember the people.”** It is
excellent when applied to exogenous, path-independent phenomena. It becomes incorrect
when it is applied to actual movement, item state, access, resource use, schedules,
illness onset, relationships, or any other result that depends on what happened.

The reconciled thesis should be:

> **Derive exogenous fields. Schedule possible changes. Record what actually happens.
> Project current world state. Remember each character's perspective. Narrate only from
> an allowed view.**

This is not a return to per-minute ticking. The missing middle is an event-driven world
kernel.

## Correction ledger after repository verification

A later adversarial pass found three errors in this review and one important defect that
all prior documents missed:

1. The criticism that `rhythmBodyPatch` “silently launders” missed meals or washing was
   wrong. The queued meter plan had already removed the blanket restore under owner
   ruling OQ3 and explicitly distinguishes a 6am landing from an 8am landing.
2. “Both tracks can proceed” was structurally false. Two Track A constraints depend on
   the command/event and space/action foundations that the same sequence placed in Track
   B. For one developer, this is a gated sequence, not parallel work.
3. The recommended first integrated slice was not a cheap slice. It combined identity,
   bodies, space, schedules, resources, illness, perception, RAG, replay, and narration.
   It is a graduation scenario after most risk has already been taken.
4. Group-chat retakes have a live rollback-integrity bug: only the primary member receives
   a pre-exchange state snapshot. Non-primary members retain state changes from the
   discarded reply and then settle the replacement reply on top.

The corrections below replace the affected recommendations rather than merely appending
a caveat. The event-driven north star still stands, but it must earn its scope through
small experiments, quality evaluation, and invariant repairs.

## Comparison at a glance

| Concern | Claude plan | GPT plan | Reconciled direction |
| --- | --- | --- | --- |
| World evolution | Derive from authored data, seed, and clock; remember history | Commands, events, scheduler, projections | Derive only path-independent inputs; event-source path-dependent outcomes |
| Time | Lazy formulas and skip folds | Priority queue and analytical integration | Analytical values plus scheduled threshold/action events; no fixed tick |
| Space | Inert place properties; reject movement authority | Containment/travel/access graph with authoritative events | Lightweight authoritative spatial graph; no continuous geometry or narrator-blocking traversal |
| Schedules | The queued chat plan deliberately credits crossed rhythm slots under owner ruling OQ3 | In a mature causal kernel, schedule is intention rather than proof | Ship the ruling-compatible chat adapter without pretending it is action history; introduce attempted-action semantics only after the required substrate exists and the ruling is explicitly revisited |
| LOD | Primarily ration post-turn settle calls | Ration both simulation fidelity and LLM attention | Two independent LOD policies sharing one relevance model |
| Agents | Add no new legs; extend current calls | Narrow current extractors; add sparse semantic/deliberation jobs when justified | No new fixed per-turn legs; allow event-triggered jobs and an optional bounded input interpreter |
| Narrator | Existing pipeline remains central | Narrator renders pre-resolved events through `NarrativeView` | Formalize current digest tiers as a typed context contract; narrator never creates hard effects |
| Memory | Facts/episodes/meanwhile are history | World truth, belief ledger, episodes, then RAG | Facts and episodes become perspective projections of events, not the authority |
| State | Extend current seams, then redesign meter classes | Normalize high-churn state and add event journal | Ship tactical adapters, but establish the new authority boundary before broad feature growth |
| Economy | Prefer authored `means`; park transaction ledger | Exact active transactions plus aggregate background economy | Start with `means`, but build a generic resource-transfer substrate so later fidelity is possible |

## Correcting the pure-derivation boundary

The Claude plan groups several things together as pure functions of authored data, seed,
and clock. Some are genuinely pure. Others contain path-dependent state and must be split
into a derived component and a historical component.

| Concept | Purely derived part | Historical or event-sourced part |
| --- | --- | --- |
| Season, lunar phase, birthday occurrence | Calendar function | How a character celebrated, whether somebody remembered, resulting feelings |
| Daylight | Calendar, latitude, and clock | Broken lights, closed blinds, fires, power loss, witnessed visibility |
| Weather | Seeded baseline or forecast field | Storm damage, wet clothing, cancelled travel, fires, player/world interventions |
| Ambient temperature | Baseline climate + time + place envelope | Heating state, open windows, damaged shelter, body thermal state |
| Circadian pressure | Biological phase function | Actual sleep reserve and sleep debt |
| Appetite rhythm | Habit and mealtime expectation | Actual intake, illness, exertion, and current satiation |
| Work routine | Authored intended schedule | Whether the character traveled, arrived, worked, left, or missed the shift |
| Illness risk | Hazard rate derived from conditions | The illness-onset event and its actual course |
| Whereabouts expectation | Routine inference | Actual departure, travel, arrival, and observation events |

Two rules follow.

### A derived value that causes history must be captured

Pure derivation is replayable only while the derivation algorithm, seed, authored inputs,
and calendar semantics remain identical. If a derived value causes an authoritative
effect, the event should capture the causal value and derivation version.

For example, an outdoor-plan cancellation event should record that the weather read was
`heavy_rain` under `weather-v2`, rather than expecting a future replay under
`weather-v5` to regenerate exactly the same band.

Recommended fields:

```ts
type DerivedEvidence = {
  kind: string;
  value: unknown;
  derivationId: string;
  derivationVersion: number;
  seedScope: string;
  evaluatedAt: number;
};
```

### Skip partitioning must not change outcomes

Seeding a roll from “the clock at the end of this skip” is deterministic but not
necessarily invariant. One three-day skip and three one-day skips can produce different
illness, encounter, or interruption outcomes.

Scheduled stochastic events should use a stable hazard process or stable interval/event
keys. Property tests should require:

```text
advance(t0 → t3) == advance(t0 → t1 → t2 → t3)
```

for authoritative state and event identity, aside from explicitly presentation-only
summaries.

## No world tick does not mean no scheduler

Claude correctly rejects a universal world tick. The replacement is not read-time
derivation alone; it is a priority queue of meaningful events.

The scheduler should hold things such as:

- action completion and interruption checks;
- departures and arrivals;
- appointments, shifts, deadlines, and birthdays;
- condition transitions and expirations;
- messages in transit;
- resource replenishment or recurring expenses;
- a physiological state crossing an action-relevant threshold;
- weather or institutional events that have been materialized because something depends
  on them.

Continuous components can still integrate analytically. The scheduler exists only for
points at which the world may make a different decision or emit a durable consequence.

During a time skip:

1. Read the next scheduled event.
2. Integrate affected analytical state to that event's time.
3. Validate and resolve the event against current projections.
4. Append resulting domain events.
5. Schedule any follow-up events.
6. Continue until the requested target time.

This produces the composability Claude wants without pretending that actual history is a
clock function.

## Owner answers imply a concrete identity model

The owner annotations settle several previously open questions:

- there will be many worlds;
- locations return, including furniture, ownership/inhabitants, routines, mappings, and
  guarded procedural generation;
- realism has no fixed feature ceiling, but systems should be ordered by usefulness and
  permit sensible deferral or “sway”;
- the player has a simulated body governed by most NPC physical rules;
- `desire` should be scheduled;
- aggregate state and overlay composition likely need redesign.

These answers make `(chatId)` the wrong long-term owner of mutable life state.

### Recommended entity hierarchy

```mermaid
flowchart TD
    WT["World type"] --> W["World"]
    CT["Character template"] --> WC["World character"]
    W --> WC
    W --> B["World branch"]
    B --> C["Conversation or scene"]
    WC --> SP["Scene participant"]
    C --> SP
```

| Entity | Owns |
| --- | --- |
| `WorldType` | Compatible species/content schemas, default mechanics, calendars, climate families, action packs, optional economy/health modules |
| `World` | Lore, seed, authored locations, instantiated characters, rule configuration, current canonical branch |
| `WorldBranch` | Story clock, event sequence, projections, alternate-take lineage |
| `CharacterTemplate` | Reusable authored identity, body template, voice, personality, compatibility declarations; no mutable world life |
| `WorldCharacter` | Instantiated body, location, inventory, relationships, beliefs, memories, schedules, and conditions in one world/branch |
| `Conversation` or `Scene` | Transcript, presentation preferences, scene-local state, participant references; not the owner of bodies or the world clock |
| `PlayerCharacter` | A world entity using shared physical/action systems, controlled by the player rather than an NPC decision policy |

This composes the owner's three possibilities rather than choosing only one:

- characters remain reusable templates;
- worlds carry distinct lore and optional mechanics while sharing a core kernel;
- a template can declare compatible world types, and instantiation validates or adapts
  it into a `WorldCharacter`.

Existing chats can migrate by creating a private world and one world-character instance
per participant. “Fresh start/AU” should create a new world or branch rather than merely a
new memory island. Shared-history conversations should point at the same world-character
instances.

## Authoritative space should return, but in a lighter form

Claude's D.1–D.4 place properties are strong. D.6's permanent rejection of travel and
movement authority no longer fits the owner's answer or the wider simulation goal.

The previous movement implementation failed because schedule movement was late or
teleporting and narration depended on that state. It does not follow that authoritative
location is inherently wrong.

The replacement should be a lightweight spatial model:

- containment: world → region → district → parcel/building → room → zone/container;
- sparse connections rather than precise geometry;
- connection duration, access rules, transport mode, opening hours, and hazards;
- occupancy and capacity;
- privacy, light, noise, shelter, temperature envelope, and perception channels;
- ownership, residence, employment, and routine links;
- furniture and items contributing affordances;
- `departed`, `travel_interrupted`, and `arrived` events.

Most travel can be one scheduled interval, not pathfinding through every sidewalk. A
route planner may choose among a few links; only live or highly consequential travel
needs interruption detail. The narrator never waits for a movement agent—the kernel
already knows whether departure or arrival occurred.

### Procedural-location guardrails

Procedural generation should propose location definitions, never write arbitrary canon
directly. A proposal should require:

- a stable parent location;
- purpose and type from a world-type vocabulary;
- a canonical normalized name and alias set;
- a reason the location is needed by a plan, resident, job, service, or player action;
- non-duplication against name, purpose, owner, coordinates/parent, and embedding
  similarity;
- reachability from at least one existing node;
- bounded counts by type and region;
- required affordances and missing-resource checks;
- a deterministic idempotency key;
- provenance and an audit trail.

Useful lifecycle states are `provisional`, `canonized`, `merged`, and `retired`.
Provisional locations can support a proposed future scene without polluting general
retrieval. They become canon when visited, explicitly authored, or referenced by an
authoritative event. Duplicate proposals merge into an existing location rather than
creating “Café”, “The Café”, and “Cafe Downtown” as separate places.

## Schedule semantics — current owner ruling versus successor target

The earlier criticism of `rhythmBodyPatch` attacked a design the queued
[chat-meter-economy plan](chat-meter-economy.plan.md) no longer contains. Owner ruling OQ3
already removed the blanket `hygiene = max(current, 0.9)` restore. The proposed patch
scans the skipped window: a skip landing at 6am before a 7am wash row leaves the character
unwashed, while an 8am landing credits the crossed row. The unmet need then remains in the
scene. Calling that “silently laundering away” the missed action was inaccurate, and this
review retracts the claim.

It was also inappropriate to make the current number-one queued plan depend on
availability, travel, opening hours, inventory, competing commitments, and action
completion when the chat lane has none of those primitives. That would silently reverse
a fresh owner ruling and block near-term meter repair on a successor kernel.

Two implementation qualifications still matter:

- The shipped `rhythmOutfitPatch(profile, clockMinutes)` is **arrival-covering**: it
  chooses the schedule row covering the landing clock. The proposed
  `rhythmBodyPatch(profile, fromMinutes, toMinutes)` is **window-crossing**: it must scan
  and apply every relevant row crossed during the interval. Calling it a deterministic
  sibling understates new iteration, boundary, duplicate-day, long-skip, and partition
  behavior.
- `inferScheduleKind(activity)` is a brand-new text-matching contract. It is precisely
  the tactical debt this review warns against elsewhere. It may be a migration adapter,
  but it needs a corpus test, explicit unknown behavior, telemetry, typed `kind`
  authoring going forward, and a deletion plan. A false-positive `wash` or `meal`
  classification is a hard state mutation, not harmless prompt flavor.

The corrected recommendation is therefore two-level:

1. **Current chat lane:** implement the owner-approved window-crossing rhythm projection
   without pretending it proves access, inventory, or a fully simulated action. Mark its
   effects as a chat-LOD policy and test interval partitioning. Do not block it on
   nonexistent world primitives.
2. **Successor causal kernel:** after command/event and space/action contracts exist,
   schedules may produce `ScheduledIntent` candidates whose completion is resolved
   against availability, access, resources, interruptions, and conflicts. This is a
   later fidelity upgrade and owner-policy decision, not a correction the queued plan
   must absorb now.

Routine can remain a deterministic off-screen policy at low LOD even after richer action
resolution exists. The important boundary is to avoid mistaking the current adapter for
general-purpose authoritative action history.

## Live-scene arbitration — world events must become playable transitions

A live conversation is itself a world activity, not an exemption from the world. The
scheduler must not teleport an NPC when a clock boundary is crossed, but the chat must
not freeze obligations indefinitely either. The correct seam is a **live-scene
arbiter**: it looks ahead, turns upcoming constraints into decision pressure, resolves
the actor's choice, commits physical outcomes, and gives the narrator a bounded dramatic
transition to portray.

The governing rule is:

> **The clock creates pressure; an actor decision creates an action; actions create
> departures, journeys, interruptions, and arrivals. A schedule never directly changes
> location.**

Wall-clock latency never advances story time. Nothing becomes 4pm while the model is
generating merely because thirty real seconds passed. Story time advances only through a
committed turn span, action, wait, travel, or skip. That gives the engine a stable
boundary at which to reconcile the world before prose streams.

### What the current repository provides—and what is unsafe to inherit

| Current seam | Useful precedent | Successor gap |
| --- | --- | --- |
| `ScheduleEntry` in [profile.ts](../../src/contracts/world/profile.ts) | Authored recurring time windows and day masks | `locationName` and `activity` are prose; there is no priority, flexibility, preparation time, travel deadline, or outcome |
| Action registry in [registry.ts](../../src/contracts/actions/registry.ts) | Stable action IDs, durations, aliases, and meter effects | No real affordance/resource/access preconditions, interruption policy, concurrency claims, failure modes, or observation profile |
| Chat plans in [chat-plans.ts](../../src/contracts/turns/chat-plans.ts) | Story-clock targets and lifecycle labels | Name/prose matching; a narrator may mark `kept`, and elapsed time can assume NPC↔NPC completion |
| Chat scene memory in [chat-scene-memory.ts](../../src/contracts/turns/chat-scene-memory.ts) | Durable setting continuity and pre-prompt movement recognition | Places are narrator-imagined names; `switchScenePlace` can change the current scene immediately without route, access, or travel |
| `StagedIntent` plus [movement.ts](../../src/server/engine/movement.ts) | No teleport from an unplaced NPC; passable path, one-hop movement, arrival-gated payload, and commitment that beats routine | Director-authored, turn-budgeted, hop-count routing; no story-time ETA, activity phases, player interaction, or general schedule arbitration |
| Presence channels in [perception.md](../perception.md) | Physical sight, remote comms, and absence grant different narrator rights | Needs to become a world-wide projection shared by chat, actions, memory, and access—not prompt guidance alone |
| `LinkAccess` in [access.ts](../../src/contracts/world/access.ts) | One pure rule for locks, doors, and opening windows | `private` deliberately does not block the player, malformed access degrades to public, keys are not implemented, and invitation/consent scopes do not exist |

The session movement system is a good source of invariants, not a literal framework to
restore. In particular, “staged intent beats the schedule, no path means no move, and
arrival gates the beat” should survive. “One hop per turn,” narrator/director text
contracts, and fail-open private access should not.

### Non-negotiable world invariants

These are database/kernel laws, never prompt suggestions:

1. **One physical locus per body.** An entity is either at one location/zone or on one
   journey edge. It cannot be at home, at work, and in the current chat simultaneously.
2. **Every relocation has a cause.** Physical locus changes only through an authorized
   departure/journey/arrival sequence, an explicit spawn/despawn rule, or an auditable
   author override. Regular player prose and narrator prose cannot relocate an NPC.
3. **Travel has a lower bound.** Arrival time is no earlier than departure plus the
   selected route's minimum travel time. Route access is evaluated at traversal time.
4. **Incompatible activities cannot overlap.** A body cannot shower, drive, sleep, work a
   register, and physically socialize at once. Activities claim body, attention,
   affordance, item, and space resources according to compatibility rules.
5. **Control is capability-scoped.** A player command may directly control only their
   player character. “Mara comes over” is a request, invitation, or asserted fiction—not
   an NPC movement command. NPC policy owns Mara's choice.
6. **Access is not consent.** A key, invitation to the home, or relationship does not
   imply permission to enter every room, interrupt sleep, touch someone, or enter an
   intimate activity. Location access, zone privacy, and interpersonal consent are
   separate checks.
7. **No deadline disappears silently.** Crossing a commitment's decision or departure
   boundary must create a decision/outcome: leave, delay, renegotiate, cancel, miss, or
   accept a consequence.
8. **Knowledge is viewpoint-scoped.** A remote player may learn only “no answer,” not
   “she is showering,” unless communication, sound, prior disclosure, or another
   perception supports that inference.
9. **Narration renders one committed cut.** Every reply is grounded in a world version,
   story-time span, and event sequence range. Later events cannot retroactively alter
   the cut already narrated.
10. **Unarmed prose cannot create hard effects.** A narrator sentence cannot unlock a
    door, grant an invitation, end a journey, complete a shift, or move an item without
    the corresponding command/event authority.

### State needed to enforce those invariants

Do not model this as a larger `present | away` flag. The minimum successor contracts
should distinguish commitments, activities, journeys, access, engagement, and physical
locus:

```ts
type PhysicalLocus =
  | { kind: "at"; locationId: string; zoneId?: string }
  | { kind: "in_transit"; journeyId: string; linkId: string };

type Commitment = {
  id: string;
  actorId: string;
  kind: "shift" | "appointment" | "promise" | "reservation" | "routine";
  destinationId?: string;
  earliestStart: number;
  targetStart: number;
  latestArrival?: number;
  priority: number;
  flexibility: "fixed" | "negotiable" | "optional";
  status: "planned" | "preparing" | "en_route" | "active" | "kept" |
          "late" | "missed" | "cancelled";
  consequencePolicyId?: string;
};

type ActivityInstance = {
  id: string;
  actorId: string;
  actionId: string;
  locationId: string;
  phase: "queued" | "preparing" | "active" | "paused" | "interrupted" |
         "completed" | "failed" | "cancelled";
  startedAt?: number;
  expectedEnd?: number;
  interruptibility: "free" | "brief" | "costly" | "none";
  attention: "available" | "divided" | "unavailable";
  privacy: "public" | "private" | "intimate";
  exclusiveClaims: string[];
};

type Journey = {
  id: string;
  travelerId: string;
  originId: string;
  destinationId: string;
  routeLinkIds: string[];
  departedAt: number;
  earliestArrivalAt: number;
  expectedArrivalAt: number;
  status: "planned" | "in_transit" | "interrupted" | "arrived" | "abandoned";
};

type AccessGrant = {
  id: string;
  granteeId: string;
  scopeId: string;
  issuerId?: string;
  basis: "public" | "resident" | "employee" | "invited" | "key" | "emergency";
  validFrom: number;
  validUntil?: number;
  permissions: Array<"approach" | "enter" | "remain" | "use" | "bring_guest">;
  revocable: boolean;
};

type Engagement = {
  id: string;
  participantIds: string[];
  channel: "physical" | "call" | "text";
  sceneLocationId?: string;
  state: "opening" | "active" | "winding_down" | "ended" | "interrupted";
  openedAt: number;
  lastAcknowledgedPressureIds: string[];
};

type TemporalPressure = {
  id: string;
  actorId: string;
  source: { kind: "commitment" | "need" | "hazard" | "access_window"; id: string };
  noticeAt: number;
  decideBy: number;
  actBy: number;
  severity: "background" | "salient" | "urgent" | "hard";
  legalResponseIds: string[];
};
```

A `Commitment` says what matters and when. An `ActivityInstance` says what the actor is
actually doing. A `Journey` says where the actor is between locations. `AccessGrant` says
what entry is authorized. `Engagement` makes a conversation a first-class activity
without freezing the NPC in place. `TemporalPressure` is the bridge from scheduler state
to an upcoming dramatic choice.

Sleep generally starts as a routine or need pressure, not a fixed appointment. A shift
or train may have a hard latest-arrival time. The same arbitration interface can serve
both while preserving different flexibility.

### Convert schedules into notice, decision, departure, and outcome boundaries

A 4pm work row should not schedule “set location = workplace at 4pm.” It should create or
refresh a work commitment and derive several thresholds:

```text
latestDeparture =
  latestArrival
  - routeTravelTime(expected conditions)
  - preparationDuration
  - reliabilityBuffer

noticeAt   = latestDeparture - context/personality notice window
decideBy   = latestDeparture - minimum wind-down time
actBy      = latestDeparture
```

The notice window may vary with personality, relationship, urgency, and whether the
other person already knows about the commitment. The physical deadline may not. World
truth must still be separated from actor knowledge: an NPC policy receives the pressure
only if the NPC remembers the commitment or perceives an alarm, calendar reminder, boss
message, or contextual cue. A forgotten appointment may be missed; the scheduler must
not make the character omniscient.

Example for a 4pm shift, a 25-minute route, and five minutes of preparation:

| Story time | Engine state | Narrative opportunity |
| --- | --- | --- |
| 3:05 | Work pressure enters the scene horizon | NPC may glance at the time or mention work once; no forced exposition |
| 3:20 | Decision becomes salient | Legal choices might be wind down, ask the player to come along, call work, or knowingly risk lateness |
| 3:30 | Latest safe departure | Resolve the NPC's choice; if leaving, commit `conversation_winding_down` and `departed` |
| 3:30–3:55 | `PhysicalLocus = in_transit` | NPC cannot act at either endpoint; calls/texts depend on travel mode and attention |
| 3:55 | Arrival | Commit `arrived`, then start or queue the work activity |
| After 4:00 | Consequence window | If the NPC stayed, record late/missed work and let employment/reputation rules react |

Journey progress can be integrated analytically from departure time, route, and
interruptions. The journal needs departures, material route changes, delays, and arrivals,
not a per-minute travel tick.

Warnings should have acknowledgement state so the narrator does not repeat “I need to
leave soon” every exchange. If the player asks the NPC to stay, that is a new social
request. It can influence utility, trust, or consequences, but it cannot erase travel
time. A high-LOD deliberator may choose among legal options; it never invents “teleport
to work after the scene.”

### Turn reconciliation must happen before the narrator streams

The safe exchange pipeline is:

```mermaid
flowchart TD
    A["Player input + world version"] --> B["Drain due triggers and look ahead"]
    B --> C["Build legal actor choices"]
    C --> D["Resolve and commit hard events"]
    D --> E["Compile perspective-safe NarrativeCut"]
    E --> F["Narrator renders the cut"]
    F --> G["Confirm armed speech/soft effects"]
```

More concretely:

1. **Resolve to turn start.** Drain scheduled triggers due at or before the current story
   time; integrate continuous values; finish actions and journeys whose completion is
   already due.
2. **Estimate the turn span.** Determine the proposed story-time cost of speech, the
   player's action, waiting, travel, or a skip. Model-generation wall time is irrelevant.
3. **Look ahead.** Query commitments, action completions, access-window closures, need
   thresholds, hazards, and journey arrivals intersecting the span plus a small scene
   horizon.
4. **Build legal outcomes.** Apply locus, route, access, resource, activity,
   interruptibility, consent, relationship, and actor-control rules.
5. **Choose.** Use deterministic policy/utility scoring for routine NPC behavior. Invoke
   a high-LOD deliberator only for consequential close choices, and give it only legal
   candidates.
6. **Commit hard history.** Append decisions, action transitions, departures, journey
   creation, arrivals, denials, and consequences transactionally before prose streams.
7. **Compile a `NarrativeCut`.** Include the exact sequence range, viewpoint,
   must-enact transitions, temporal pressures, perceptions, permitted dialogue/action
   choices, and forbidden claims.
8. **Narrate.** The narrator explains and dramatizes what was resolved; it does not
   rerun pathfinding, access, or schedule logic.
9. **Confirm semantic effects.** Disclosures, promises, warnings actually spoken, and
   bounded soft canon may use the arm–narrate–confirm path. They cannot revise the
   already-committed physical outcome.

A useful contract is:

```ts
type NarrativeCut = {
  worldId: string;
  branchId: string;
  worldVersion: number;
  sequenceFrom: number;
  sequenceTo: number;
  storyTimeFrom: number;
  storyTimeTo: number;
  viewpointId: string;
  mustEnact: DomainEventSummary[];
  currentActivities: ActivityView[];
  temporalPressures: TemporalPressureView[];
  allowedTransitions: ArmedEffect[];
  forbiddenClaims: string[];
  perceptibleFailureReasons: FailurePresentation[];
};
```

If another authorized command changes the shared world while narration is streaming, it
receives a later sequence and appears on the next cut. Do not hold a database lock for
the whole model stream. The committed cut is stable; later state is not allowed to
rewrite it.

### Engagement is a claim on attention, not a freeze on the NPC

A conversation should create an `Engagement` so the world knows the NPC is occupied and
which channel is in use. It must not grant the player ownership of the NPC's schedule.

Activity compatibility can be table-driven:

| Current activity | Physical chat | Call/text | Likely behavior |
| --- | --- | --- | --- |
| Casual cooking, walking, tidying | Usually compatible with divided attention | Usually compatible | Continue, pause briefly, or invite the player along |
| Work task, driving, medical care | Limited or unsafe | Mode-dependent | Short reply, defer, or refuse; never perform impossible simultaneous acts |
| Showering, toileting, changing | Privacy-gated and normally unavailable | Device/access dependent | Do not expose the private cause remotely; knock/text may go unanswered |
| Sleeping | Unavailable until waking unless an interrupt succeeds | Phone rules and urgency apply | Missed call, wake event, or no response |
| Intimate activity | Consent- and privacy-gated | Usually unavailable | No intrusion without an explicit, allowed interruption path |

An interruption is its own command and event. It checks whether the activity is
interruptible, what it costs, what claims must be released, and whether the actor chooses
to accept. “NPC stops showering” cannot be a side effect of the player sending a line.

At hard pressure, the engagement moves to `winding_down` or `interrupted`. The narrator
receives a must-enact transition such as “Mara checks the time, says she has to leave,
collects her bag, and ends the conversation.” The departure event is authoritative; the
wording is not.

### Player movement and NPC movement require different authority

Normal player input must be interpreted as a proposed command, never accepted as a
declarative rewrite of the world:

- “I go to Mara's house” proposes player travel. The engine resolves a route and time,
  then normally arrives at the public approach/doorstep—not inside a private room.
- “I walk into Mara's bedroom” checks household access, zone permission, door state,
  current privacy, and any invitation scope. If denied, the threshold is the scene.
- “Mara comes here” is an invitation/request. Mara's controller may accept, refuse,
  delay, negotiate, or start a journey. She does not appear immediately.
- “Mara is standing beside me now” is an unsupported assertion in normal player mode.
  It may become a social/imaginative utterance, a request for clarification, or a denied
  authorial claim.
- Storyteller/GM mode may propose an explicit `AuthorOverride`, but it still emits an
  audited event, checks world-type policy, and resolves collisions. It is never smuggled
  through ordinary dialogue.

If the game permits trespass, lockpicking, coercion, or forced entry, those should be
explicit risky actions with duration, noise, witnesses, skill/resource requirements, and
social/legal consequences. “Secure” should not mean every transgressive choice is
impossible; it means the choice cannot bypass causality.

### Access, privacy, and consent must fail safely without leaking secrets

The successor must change the current `private has no player effect` rule.

Use layered authorization:

1. **Route access:** can the actor reach the threshold?
2. **Property access:** public, resident, employee, invited, key-holder, emergency, or
   trespassing.
3. **Zone access:** foyer, staff area, bedroom, bathroom, locked office, and so on.
4. **Occupancy/privacy:** is the zone currently reserved by an activity or another actor?
5. **Interaction consent:** may this actor interrupt, remain, touch, observe, or join?
6. **Perception:** what reason for denial can the viewpoint actually know?

Authored absence may deliberately default a clearly public link to public. Malformed or
contradictory private-access data must not silently upgrade to public; quarantine it,
fall back to the nearest safe threshold, and emit a diagnostic.

Command results should separate private cause from public presentation:

```ts
type FailurePresentation = {
  code: "unavailable" | "access_denied" | "locked" | "no_path" | "busy" | "refused";
  publicReason: string;
  perceptibleEvidence: string[];
  safeAlternatives: string[];
  privateCauseEventId?: string; // never placed in an unauthorized NarrativeCut
};
```

A player texting from across town may see “She doesn't answer.” A player outside the
bathroom may hear running water if acoustics and attention allow it. Only the latter view
may support the inference that she is showering.

### Multiple chats and shared-world concurrency

One world character cannot be physically active in two independent chat scenes. A
versioned `Engagement` is an authoritative reservation on participation/attention, not an
in-process mutex:

- a second physical-chat command for the same NPC must join the existing scene, use a
  compatible comms channel, queue, or receive a grounded unavailable result;
- world commands are ordered by the world/branch sequencer;
- actions reserve exclusive resources with optimistic versions;
- a conflict is resolved before narration, never by letting two replies establish
  incompatible truths;
- engagement expiry is based on story-time/state transitions, not wall-clock model
  latency;
- separate world instances have separate character instances and therefore do not
  conflict.

For a single-player product this may initially seem unnecessary, but it is also the rule
that prevents two internal chat lanes or background jobs from moving the same NPC
differently.

### Agent and narrator responsibilities

| Component | May decide | Must not decide |
| --- | --- | --- |
| Scheduler/kernel | Due triggers, route timing, access, compatibility, action phases, hard outcomes, event order | Character prose, emotional nuance, or hidden semantic meaning |
| Deterministic NPC policy | Routine choices, obvious deadline behavior, utility-ranked legal actions | Illegal actions or exceptions outside its candidates |
| High-LOD deliberator | Rare consequential choice among legal options: leave, stay late, renegotiate, invite along | New locations, zero-time travel, access grants, completed actions, or player intent |
| Input interpreter | Map ambiguous player text to proposed commands and uncertainty | Treat asserted NPC behavior as authority |
| Context compiler | Build `NarrativeCut`, redact private causes, label pressures, and expose affordances | Add story events |
| Narrator | Voice warnings, refusals, wind-down, travel transitions, failed attempts, and consequences naturally | Mutate locus, access, activity, commitment, inventory, or knowledge |
| Continuity/physics auditor | Flag contradiction with the committed cut and measure failure | Repair world truth from prose |
| Memory consolidator | Summarize observed committed events for eligible viewpoints | Turn an uncommitted narration detail into history |
| World director | Propose future pressures or opportunities early enough to schedule | Teleport actors or force immediate hard effects |

Most of this path is code. An LLM deliberator is justified only when character nuance
materially changes a close legal choice. To keep latency out of the turn, the scheduler
can precompute high-LOD decisions when a pressure first enters the horizon and revalidate
them at `decideBy`. A stale or invalid choice falls back to deterministic policy.

### Security and immersion test matrix

The subsystem needs property tests plus scripted scenes:

- **4pm shift:** the NPC warns or otherwise winds down, departs by a resolved choice,
  spends route time in transit, and arrives no earlier than physically possible.
- **Player pressures them to stay:** the NPC may refuse, renegotiate, or accept lateness;
  the work consequence is recorded instead of the deadline disappearing.
- **Sleep:** fatigue and routine create a wind-down opportunity; sleep starts through an
  action transition, not a mid-sentence location/presence switch.
- **Shower/privacy:** a remote player receives no private-cause leak; an invited visitor
  still cannot enter a private occupied zone without a new permission or force action.
- **Summon attempt:** “come here now” cannot move the NPC; acceptance creates a journey
  and ETA.
- **Barge-in attempt:** player reaches the threshold, access is checked, and any forced
  entry consumes time and creates evidence/consequences.
- **Exclusive activity:** showering and sleeping cannot overlap work, driving, or a
  physical scene.
- **Travel partitioning:** one 30-minute advance and three 10-minute advances produce
  the same journey/arrival result.
- **Narrator hallucination:** an invented arrival, invitation, or activity completion
  leaves projections unchanged and is recorded as a grounding failure.
- **Retake:** discarded warnings, decisions, departures, and arrivals do not survive the
  branch/rollback boundary.
- **Concurrency:** two commands attempting incompatible engagements produce one ordered
  winner and one grounded alternative, never two locations.
- **Perspective:** blocked/failed command output reveals only what the viewpoint can
  perceive.

Track metrics for premature/late departures, schedule warnings emitted and actually
enacted, repeated-warning rate, impossible-action proposals, access denials by reason,
private-cause leakage, narrator grounding failures, decision-agent calls, and extra
first-token latency.

### Incremental implementation order

This should not land as one giant “real life” subsystem:

1. Add read-only `TemporalPressure` compilation for one existing schedule commitment and
   measure whether the narrator winds down naturally.
2. Add `Engagement` and actor-control checks so ordinary player prose cannot move an NPC
   or claim them in two physical scenes.
3. Replace physical `present/away` with `PhysicalLocus` plus a story-time `Journey` for
   one route.
4. Enforce property/zone access and invitations; change private access from advisory to
   authoritative.
5. Add one phased, exclusive activity—showering is a strong test because it exercises
   duration, privacy, attention, interruption, perception redaction, and meter effects.
6. Add commitment decisions and consequences using the 4pm-shift scenario.
7. Generalize to sleep, work, appointments, calls, visits, and other actions.
8. Add rare precomputed LLM deliberation only after deterministic policy and quality
   evaluation show a real gap.

The existing owner-approved `rhythmBodyPatch` remains a low-LOD current-chat policy
during this migration. It should not be retrofitted into this entire mechanism before
the mechanism exists.

### Product rulings this design still needs

- How many story minutes does ordinary dialogue consume, and when may narration compress
  or expand a scene?
- Are shift times exact deadlines, flexible windows, or world-type data?
- Which violations—trespass, coercion, forced entry, waking someone—are playable actions
  versus product-level prohibitions?
- What privileges does storyteller/GM mode have, and how visible are override events?
- How much should NPCs proactively reveal about obligations versus express them through
  behavior?
- When an NPC chooses the player over an obligation, which systems own the resulting
  employment, relationship, health, or reputation consequences?
- Can multiple players or chats share one active world concurrently, or is concurrency
  initially limited to internal jobs?


## LOD has two separate jobs

Claude's insight that roster growth makes the settle a scaling problem is correct. The
GPT plan's use of LOD for world simulation is also necessary. A large event-driven world
does not pay a per-minute tick, but it can still generate too many appointments,
transactions, social encounters, and projections.

Use two policies:

### Simulation LOD

Controls how much causal detail is resolved.

| Tier | Simulation behavior |
| --- | --- |
| Live | Exact actions, locations, resources, perceptions, and interruptions |
| Active | Exact important events; routine intervals may be compressed |
| Background | Daily/shift/household aggregates with deterministic exception events |
| Dormant | No ongoing event queue; lazily materialize from last checkpoint and durable obligations |

### Inference and narrative LOD

Controls model calls, prompt weight, extraction, and UI attention.

| Tier | LLM/prompt behavior |
| --- | --- |
| Engaged | Full narrator context and relevant character analysis |
| Present but quiet | Compact state, deterministic pulse where possible, no redundant personal-note call |
| Off-screen relevant | No per-exchange call; eligible for sparse decision or meanwhile jobs |
| Dormant | No call and no prompt presence |

The policies often correlate, but they are not identical. A politically important
off-screen character may receive active simulation without appearing in the prompt. A
quiet witness in the current room may need exact perception but no personal LLM pass.

## State taxonomy should go beyond a meter class field

Claude correctly observes that one flat linear `perHour` law cannot support the proposed
body catalog. A single law per broad class is still too restrictive: reserves can be
linear, exponential, event-only, or piecewise; loads can clear with different kinetics;
some values are not meters at all.

Prefer a discriminated dynamics contract:

```ts
type Dynamics =
  | { kind: "analytic_exponential"; tauMinutes: number }
  | { kind: "linear"; unitsPerMinute: number }
  | { kind: "toward_baseline"; ratePerMinute: number }
  | { kind: "event_accumulating" }
  | { kind: "phase"; periodMinutes: number }
  | { kind: "piecewise"; segments: Segment[] }
  | { kind: "custom"; resolverId: string; version: number };
```

Each continuous component should declare:

- semantic units and bounds;
- dynamics and last integration time;
- causal inputs and couplings;
- derived drives;
- action effects;
- perception rules;
- LOD approximation;
- version and migration behavior.

Conditions, commitments, resources, relationships, beliefs, and skills should remain
separate component families rather than being forced into the meter registry.

### Couplings need an explicit resolver

The larger body design adds many cross-effects: exertion drains hydration and energy;
temperature affects stress; caffeine masks sleepiness; illness changes appetite; clothing
changes thermal exposure. Hand-coded call order will become unstable.

Represent couplings as a dependency graph, reject cycles that lack an explicit iterative
resolver, and evaluate all changes at one timestamp before emitting threshold signals.

## Replace overlay paths with one modifier engine

Claude's OQ7 and the GPT state critique point to the same refactor. Regard overlays,
meter-driven disposition, conditions, relationship masks, narrative trait shifts, and
future environment modifiers should not each own a hidden precedence rule.

Use immutable authored bases plus explicit modifiers:

```ts
type Modifier = {
  id: string;
  targetEntityId: string;
  targetPath: string;
  operation: "add" | "multiply" | "clamp" | "override";
  value: number | string | boolean;
  sourceKind: string;
  sourceEventId?: string;
  priority: number;
  startsAt: number;
  expiresAt?: number;
  stackingKey?: string;
};
```

Resolution should declare:

1. authored base;
2. world/species/body defaults;
3. durable lived development;
4. current conditions and environment;
5. relationship-specific context;
6. bounded narrative overlays;
7. final domain clamp.

Every effective value becomes explainable, reversible, and inspectable. Caps should be
domain-specific rather than one global “band step” rule.

## The salience bus should be a typed signal bus

Claude's salience-bus proposal is one of the most important immediate recommendations.
The improvement is not to collapse every producer into one `{ kind, urgency, want,
source }` ranking.

Four concepts differ:

- physiological or situational urgency;
- action-selection utility;
- narrative salience;
- perceptibility to the current viewpoint.

A severe private need may dominate the character's action choice without being visible
to the player or deserving direct narration. A low-urgency promise may be narratively
important because it closes a long arc.

Use a richer signal:

```ts
type SimSignal = {
  id: string;
  subjectId: string;
  kind: string;
  sourceEventIds: string[];
  urgency: number;
  deadline?: number;
  actionUtility: number;
  narrativeSalience: number;
  observability: ObservationProfile;
  candidateActionIds: string[];
  suppressionTags: string[];
  cooldownKey?: string;
};
```

Different consumers apply different pure policies:

- the decision controller ranks action utility;
- the interruption controller combines urgency, deferrability, and current commitment;
- the context compiler filters by observability and narrative salience;
- the pulse receives only socially/emotionally relevant signals;
- the UI uses a separate visibility policy.

Budgets should be per character and per consumer. A single global foreground signal is
insufficient for ensemble scenes.

## “No ceiling on realism” still needs an admission contract

The owner's answer means niche systems should remain architecturally possible, not that
every measurable quantity should immediately become stored state.

A proposed system should answer all of the following before admission:

1. What authoritative events change it?
2. What decisions, capabilities, or other systems consume it?
3. What can a character or player perceive?
4. What actions can change or resolve it?
5. How does it degrade at background and dormant LOD?
6. How is it replayed and tested?
7. What is its player-facing value relative to complexity and noise?

If it has no consumer or observable consequence, it should remain prose or a derived
flavor read. This keeps the architecture open-ended without accumulating inert meters.

## Player body and the formal meaning of “sway”

The owner has ruled that the player has a body and follows most NPC physical rules. The
player character should therefore share:

- location and travel constraints;
- inventories and resources;
- body reserves, loads, conditions, and action effects;
- perception and knowledge boundaries;
- environmental exposure;
- time and interruption mechanics.

It should not share autonomous personality or goal selection. The simulation may model
consequences of player-declared actions, but it must not invent the player's intent or
choose voluntary actions for them.

“Sway” should be a formal arbitration rule, not an instruction to ignore inconvenient
meters. A need can be deferred when the current activity has high commitment or desire,
but the underlying state continues to worsen.

One possible shape:

```ts
type InterruptionPressure = {
  needId: string;
  urgency: number;
  deferrability: number;
  currentActivityCommitment: number;
  hardLimitAt?: number;
};
```

- Below the soft threshold, the need is texture only.
- Above it, the decision controller strongly prefers a resolving action.
- A valued activity can defer the action according to `deferrability` and character
  traits.
- Deferral never restores the underlying reserve or load.
- At a hard physiological limit, only involuntary or capability-limiting consequences
  occur; the narrator still does not choose the player's voluntary response.

This also resolves the distinction between “she notices hunger,” “she wants food,” “she
mentions food,” and “she interrupts the scene to eat.” They are four separate gates.

## Agent budget: retain the ladder, add missing dimensions

Claude's T0–T5 ladder is useful for model latency. It is not a full implementation-cost
model. A T0 function can be CPU-heavy or semantically dangerous, and a T2 field can
degrade an existing extractor enough to recreate the failed thirteen-field monolith.

Every proposal should be scored on at least:

- synchronous latency;
- LLM call and token cost;
- CPU and database cost;
- write amplification and contention;
- determinism/replay risk;
- prompt or extractor cognitive load;
- schema/migration complexity;
- evaluation burden;
- failure blast radius.

### “No new fixed legs” is good; “no new job types ever” is not

The recommendation should be:

- do not add another unconditional per-exchange LLM leg;
- do not keep stuffing unrelated fields into existing legs merely because that is T2;
- allow sparse event-triggered deliberation or semantic jobs with strict deterministic
  gates;
- batch decisions where privacy boundaries permit;
- cache or precompute off-screen high-LOD decisions before they become turn-critical.

An intricate open-ended action system may eventually require a bounded input semantic
interpreter. Standard actions should resolve from structured UI actions, stable
affordances, and deterministic parsing. If confidence is low, a small interpreter can
map text onto enumerated candidate commands. T5 should be **closed by default**, not
constitutionally forbidden at the cost of misinterpreting the player.

## Immediate P0 defect — group retakes are not rollback-invariant

Repository verification found a live data-integrity bug stronger than the abstract
warning about aggregate snapshots.

In [chat-pipeline.ts](../../src/server/engine/chat-pipeline.ts),
`restoreOrDegrade()` loads `preExchangeState` only for the primary
`characterId`. In [chat-state.ts](../../src/server/engine/chat-state.ts),
`finalizeChatState()` saves that primary snapshot. The non-primary roster loop instead
loads each member's current state, applies its pulse and personal-note folds, and calls
`saveChatState()` without saving a corresponding pre-exchange snapshot.

Consequently, an applicable group-chat regenerate or “another take” rolls back the
primary and shared scenario but not the other members. Non-primary regard, emotional
state, drives, wardrobe/personal fields, relationship samples, and milestones produced
by the discarded reply remain persisted; the replacement reply then settles on top of
them. Message-provenance memory retraction does not repair these state columns.

This should be fixed before architecture experiments and does not require a world kernel:

1. Preserve each roster member's stored pre-drift state during prompt assembly.
2. On regenerate and a latest-target rerun, load every member from their own recorded
   snapshot before drift and prompt construction.
3. After each guarded member save, write that same member's pre-exchange snapshot under
   the same prompt-row guard.
4. Add group tests in which a discarded reply changes a secondary member's regard,
   emotional state, drive reveal, and milestone, then assert the replacement is applied
   exactly once and the discarded effects are absent.
5. Keep reach-back reruns explicit: if the requested target predates the one available
   snapshot, reject full rollback or branch from durable history rather than implying
   restoration occurred.

A later event journal makes multi-aggregate rollback auditable, but the immediate lesson
is smaller: a snapshot is only an invariant if it covers every aggregate the exchange
can mutate.

## The settle lock is a transition blocker

Claude correctly identifies that post-turn work is not truly free because the exchange
lock remains held. LOD reduces the number of calls but does not fix the authority problem.

The long-term sequence should be:

1. Resolve and persist the authoritative command/events.
2. Stream and persist narration.
3. Commit the message/event watermark and release the exchange lock.
4. Run memory, summaries, analytics, and soft-canon proposals as durable idempotent jobs
   keyed to immutable event/message IDs.

Jobs must compare projection versions rather than rewrite a full stale `ChatState` row.
If a background projection loses a race, it should recompute from events or append a new
proposal—not overwrite newer state.

This requires replacing the current in-process lock and runner assumptions with a
world/branch command sequence, optimistic versions, a transactional outbox, durable job
leases, and idempotency keys. Without that work, cross-chat continuity in one shared
world is unsafe.

## Narration needs a formal authority boundary

Both plans imply, but only the GPT plan states directly, that the narrator should render
pre-resolved truth rather than create it.

The existing binding/gate/license/flavor digest is the right seed for a typed
`NarrativeView`:

- `mustBeTrue`: authoritative state and resolved events;
- `perceptibleNow`: observation results for the current viewpoint;
- `speakerBeliefs`: beliefs the speaking character may act upon, labeled as beliefs;
- `recentCausalEvents`: compact causes relevant to this reply;
- `allowedActions`: already-resolved beats the reply may portray;
- `forbiddenClaims`: impossible movement, knowledge, item, or player-agency claims;
- `creativeLicenses`: bounded soft details that may be invented;
- `provenance`: event, projection, or memory source for inspection.

Post-turn extraction should be restricted to things the engine could not know in
advance—episode compression, semantic facts from dialogue, and permitted soft-canon
proposals. It should not decide completed movement, inventory transfer, body effects, or
commitment outcomes.

## Belief, gossip, relationships, and RAG need a shared foundation

Claude identifies gossip, belief-vs-truth, reputation, and derived NPC relationships as
cheap extensions of facts. The shared reading shows that the fact table alone is too
weak to carry all four.

### `canon: false` is not a belief model

A boolean cannot represent:

- who believes the proposition;
- who told them;
- how confident they are;
- whether they directly witnessed it or heard it third-hand;
- when it was true or believed true;
- whether they later learned a contradiction;
- whether they are lying despite knowing the truth.

Use an assertion plus knower ledger. Gossip should emit a communication/transmission
event that may create or update a belief with source and confidence. It should not blindly
copy the same fact into another memory group.

### Relationship evolution should not be derived only from prose facts

Authored NPC↔NPC relationships can remain immutable baselines. Lived relationship state
should be a deterministic projection of validated social events, with facts and episodes
serving as each character's memory of those events.

This preserves the “authored canon is never machine-edited” rule without making
relationship change dependent on semantic search or extractor wording.

Recommended split:

```text
authored relationship baseline
+ validated lived-event deltas
+ current contextual modifiers
= effective relationship read
```

### RAG becomes the last-mile recall layer

Retrieval should proceed in this order:

1. Resolve world, branch, viewpoint, participants, location, and time.
2. Query authoritative state and applicable commitments exactly.
3. Query the belief ledger for what the viewpoint may know.
4. Restrict episodes by knower, entities, time, location, and validity.
5. Use hybrid lexical/vector retrieval within that eligible set.
6. Compile a bounded narrative view.

Vector similarity never determines whether something is true or knowable. Retrieval
evaluation should include perspective leakage, false/stale beliefs, duplicate names,
temporal validity, causal recall, and exact commitment retrieval.

## Material systems: `means` is a good first LOD, not the final model

Claude's authored `means` band is an excellent early feature. It can shape narration and
routine choices before a full economy exists. It should be designed as one projection of
a more general resource model rather than a permanent substitute.

A staged material model can use:

- authored `means` for legacy/dormant characters;
- household budgets and recurring income/expenses for background characters;
- exact money, inventory, and ownership transfers for live/active entities;
- aggregate prices, supply, and employment at district/world LOD.

The generic primitive is not “economy”; it is a balanced resource transfer with
provenance. Gifts, purchases, meals, medicine, rent, and consumables can all use it.

Physical traces are particularly high-value: cooking consumes ingredients and produces
food/dishes, travel consumes time or fare, a gift changes ownership, and work creates
income or output. These are world history and cannot be reconstructed safely from prose.

## Corrected sequencing — one gated path, not two parallel tracks

The previous sentence “Both can proceed if tactical work obeys the future boundary” was
wrong. At least two of Track A's seven constraints presuppose Track B:

| Prior Track A constraint | Required foundation | Why it is gated |
| --- | --- | --- |
| Schedules produce intent, not guaranteed completed actions | Track B item 4: space, actions, affordances, resources, and interruptions | The current chat lane cannot resolve an attempted action because those primitives do not exist |
| Derivation functions are versioned when their output can cause history | Track B item 2: commands, events, replay, and durable causation | A version has nowhere authoritative to attach until history-producing events exist |

Signals with stable subjects and provenance also become much more useful after identity
contracts exist, although a typed in-process bus can be prototyped earlier. For a single
developer, the plan must be a dependency-ordered queue.

### Gate 0 — repair current invariants

- Fix the primary-only group-retake snapshot bug.
- Assert the single-machine premise or add database-level per-session ordering.
- Fence the highest-risk narrator ratchets, especially secret revelation and plan
  completion.
- Record a baseline of latency, model-call fan-out, degraded legs, and representative
  transcript quality.

### Gate 1 — ship only independent current-lane work

The clock-keyed meter economy, the owner-approved `rhythmBodyPatch`, read-only
environment derivations, a composed `SceneFrame`, and a typed signal bus may proceed
when they do not claim future action semantics or create new unrestricted hard-state
writeback. `inferScheduleKind` must be treated as a measured migration adapter, not a
successor contract.

This work is sequential with kernel work in developer time. “Independent” means it does
not require a kernel to be correct, not that one developer can build both simultaneously.

### Gate 2 — run cheap discriminating experiments

Run the three sub-day spikes below and the quality harness before committing to a broad
foundation. Each experiment must have a result that can reduce or redirect scope.

### Gate 3 — build the minimum authority seam

Only after the experiments, implement the smallest command → event → projection →
viewpoint path. Do not begin with bodies, illness, economies, two worlds, and a week of
fast-forward.

### Gate 4 — expand in dependency order

If the seam earns expansion, the successor order remains:

1. world and character identity;
2. command/event authority, versions, idempotency, and replay;
3. scheduler, analytical integration, projections, and outbox;
4. space, affordances, actions, schedules, and resources;
5. observation, knowledge eligibility, `NarrativeView`, and perspective-scoped RAG;
6. bodies, inventories, households, relationships, and material traces;
7. dual LOD, utility-driven autonomy, and sparse high-LOD deliberation.

Current-lane features should migrate behind these interfaces only when the interface they
need exists.

## Rough single-developer cost envelope

These are order-of-magnitude engineering estimates, not commitments. They assume
familiarity with the repository, exclude content authoring and production polish, and
must be re-estimated after each gate.

| Work | Rough effort | Confidence |
| --- | ---: | --- |
| Fix and regression-test the group-retake snapshot invariant | 0.5–1.5 days | Medium |
| Add baseline transcript/latency/call-count harness | 1–2 days | Medium |
| Each sub-day spike below | 0.5–1 day | Medium |
| Queued meter-economy implementation, including window-crossing tests and schedule-kind audit | 3–7 days | Low–medium |
| Minimum command/event/projection/viewpoint slice | 5–10 days | Low |
| Identity + event kernel + scheduler/projection production foundation | 15–30 days | Low |
| Space/action/schedule/resource substrate plus live-scene arbitration, journeys, and access | 15–35 days | Low |
| Perspective ledger, narrator view, and RAG eligibility migration | 10–25 days | Low |
| Bodies/material systems and current-chat migration | 15–35 days | Very low |
| Dual LOD and autonomous background behavior | 10–25 days | Very low |

The north-star foundation is therefore plausibly **60–120+ focused developer-days**
before broad content, UI tooling, balancing, migration cleanup, and production hardening.
The old “first integrated slice” touched most of that surface and could not provide an
early verdict.

## Product-quality evaluation

Correct state is not enough. The live chat lane's writing quality is the asset at risk,
so every architecture experiment needs a paired product evaluation.

Start with a small, versioned corpus of at least 12–20 representative exchanges covering
romance, conflict, secrets, group scenes, time skips, callbacks, and ordinary banter.
For each change:

- run baseline and treatment with the same inputs and model configuration, using multiple
  samples where model nondeterminism matters;
- blind the ordering during review;
- score character voice, chemistry/tension, emotional continuity, pacing, causal
  enactment, contradiction, unwanted exposition, perspective leakage, and player agency;
- record p50/p95 latency, synchronous and settlement calls, token use, degraded legs, and
  hard-effect repair/rejection rate;
- predeclare the pass/fail threshold before reading results.

A reasonable initial non-regression gate is: zero deterministic secret-leak failures,
at least 80% correct enactment when the tested state is relevant, no forced mention when
it is irrelevant, no median decline in voice/chemistry, and no material latency increase
unless player-visible value clearly improves. The exact numbers can change after the
baseline, but an experiment without a threshold cannot fail.

## Three sub-day discriminating spikes

### Spike 1 — make witness eligibility real

**Build:** Add a `viewpointId` to the controlled session-lane fact retrieval path and
apply witness eligibility in SQL before top-k selection. For the spike, use extracted
facts with non-empty `witnessedBy`; explicitly preserve separately authored/global
facts rather than blindly hiding every row whose witness set is empty. Reuse the existing
concealment tests and add an end-to-end case where a back-turned character must not
retrieve the hidden act while an actual witness still can.

**Budget:** 0.5–1 day.

**Falsifies:** Whether the existing perception → persisted witness set → retrieval path
can enforce a meaningful perspective boundary without a new ledger. It succeeds only if
leakage disappears without deleting legitimate witnessed recall or damaging transcript
quality.

This is the best cheap test in the current repository. It validates one vertical seam of
the proposed belief architecture. It does **not** prove the entire belief tier: hearsay,
inference, lies, forgetting, confidence, contradictions, authored knowledge, and empty
legacy witness sets still require explicit semantics.

### Spike 2 — shadow-test `inferScheduleKind`

**Build:** Run `inferScheduleKind` in non-mutating shadow mode over every authored
schedule used by the live app. Compare results with a small manually labeled corpus,
record unknowns and ambiguous phrases, and inspect the exact intervals
`rhythmBodyPatch` would credit. Do not change meters during the experiment.

**Budget:** 0.5–1 day.

**Falsifies:** Whether text inference is safe enough as a temporary migration adapter.
For automatic body-state credit, precision matters more than coverage: any material
false-positive `wash` or `meal` classification should fail the adapter and require
authored `kind` values or a migration.

### Spike 3 — one grounded-context ablation in the live chat

**Build:** Behind a flag, compile one deterministic, already-available state distinction
into the prompt—such as daylight/privacy or the 6am-unwashed versus 8am-washed rhythm
state—without adding a model call or a new state writer. Run paired transcripts with the
field present and withheld.

**Budget:** 0.5–1 day for the flag and corpus run, plus review time.

**Falsifies:** Whether code-grounded context is enacted naturally and improves perceived
continuity without harming voice or turning the reply into mechanical exposition. If
reviewers cannot detect relevant causal enactment, or quality falls, pause context
expansion and fix the compiler/presentation seam before building more simulation.

The group-retake repair is deliberately not counted as an experiment. It is a known
integrity defect and should be fixed regardless of architectural preference.

## First architectural slice — one invariant across one seam

The first kernel slice should be small enough to reject the architecture before the
world has been built.

Build only:

- one world/branch identity and version;
- one stable item, two containers or locations, and one `transfer_item` command;
- command validation, one domain event, and one current-state projection;
- one observer and one non-observer;
- a minimal perspective view consumed by the existing narrator;
- no scheduler, physiology, illness, economy, autonomous NPC, procedural generation, or
  new LLM leg.

Acceptance properties:

- an invalid transfer emits no event and cannot appear in the projection;
- the same command/event replay produces the same projection hash;
- the observer may recall the transfer and the non-observer may not;
- regenerate/another-take cannot leave a discarded transfer in either state or memory;
- the narrator cannot invent a second transfer or reveal it to the wrong viewpoint;
- paired transcripts pass the quality and latency gate.

This is roughly a 5–10 day risk probe. It tests identity, authority, replay, projection,
perspective, retake behavior, and narrator integration without first implementing every
world subsystem.

## Later graduation scenario — not the first slice

The prior “first integrated slice” is retained only as a later integration milestone. It
should not be used to decide whether the architecture is viable because it reports its
verdict after most foundational risk has already been taken.

After the smaller seams work, a graduation scenario may include:

- one `WorldType` and two world instances;
- one reusable character template instantiated independently in both worlds;
- one player character with a minimal body;
- three connected locations: home, workplace, and café;
- opening hours, privacy, weather exposure, and a few furniture/item affordances;
- sleep, energy, satiation, hydration, warmth, desire, and one illness condition;
- a work schedule, one meal intent, one appointment, and one gift;
- authoritative departures/arrivals and item ownership;
- perception events and one fact that only one character knows;
- a seven-day fast-forward with no routine LLM calls;
- one narrator reply compiled from the resulting perspective-safe view.

Its acceptance properties remain valuable:

- the same seed and commands replay to the same event hash;
- one seven-day skip equals seven one-day skips;
- the character may miss work or a meal because a real prerequisite failed;
- their state in world A cannot leak into world B;
- the player and NPC share physical rules without the engine choosing player intent;
- the narrator cannot reveal the private fact or invent an unrecorded arrival, item, or
  plan outcome;
- background simulation uses no per-character-per-tick agent;
- every visible consequence has an inspectable causation chain;
- changing a derivation implementation does not rewrite committed history.

This is a broad integration and graduation test, not a cheap slice.

## Remaining product decisions

The owner annotations settle the direction but leave a few decisions to formalize:

1. Can a character template instantiate into any compatible world type, or can a creator
   permanently bind it to one type?
2. Is “another take” a private branch that may later become canonical, or an immediate
   rewind that discards descendants?
3. Which systems and body signals are visible in the UI versus intentionally hidden and
   expressed only through narration?
4. May authored or magical events override normally derived weather, season, aging, or
   physiology, and how are those overrides represented?
5. Can the narrator propose a provisional location, or must all procedural generation be
   initiated by a planner/authoring workflow?
6. How much initial player-body state is authored, defaulted, or explicitly declared by
   the player?
7. Which world mechanics are mandatory kernel modules and which are optional world-type
   packages?

These are compatible with incremental implementation, but their contracts should be
settled before migrating multiple chats into shared worlds.

## Final recommendation

Keep Claude's cost discipline, environment derivations, substrate/read law, `SceneFrame`,
salience insight, and warning about settle fan-out. Keep the GPT plan's event authority,
identity split, scheduler, spatial/action contracts, knowledge ledger, narrator view,
durable concurrency, and replay requirements.

Correct the execution order: fix the group-retake invariant first, establish a quality
baseline, run the three cheap discriminating spikes, and ship only current-lane work that
is genuinely independent. The queued rhythm/body work should not be forced to solve
unbuilt action primitives or silently reverse its owner ruling; its text-matching adapter
must be measured and explicitly temporary.

Only then should the command/event design be tested through one narrow authority seam.
Before broad world expansion, the next earned seam should make one scheduled obligation
play through a live scene as warning → decision → departure → journey → arrival, with
access, actor control, and perspective-safe failure presentation enforced by code. The
broad two-world, body, space, schedule, illness, perception, and fast-forward scenario is
a graduation test, not the first bet.

The combined design is neither the old ticked world model nor a larger conversational
state blob. It is a sparse event-driven world in which cheap fields are derived, actual
outcomes are recorded, current state is projected, characters remember different
versions of events, and the narrator receives only the perspective-safe slice it is
allowed to render.
