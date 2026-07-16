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
| Space/action/schedule/resource substrate | 10–25 days | Low |
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
The broad two-world, body, space, schedule, illness, perception, and fast-forward scenario
is a graduation test, not the first bet.

The combined design is neither the old ticked world model nor a larger conversational
state blob. It is a sparse event-driven world in which cheap fields are derived, actual
outcomes are recorded, current state is projected, characters remember different
versions of events, and the narrator receives only the perspective-safe slice it is
allowed to render.
