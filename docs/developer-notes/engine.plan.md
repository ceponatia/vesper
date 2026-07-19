# Successor world engine — implementation plan

Status: **fresh implementation plan, draft 2026-07-16**

Companion to [engine.spec.md](engine.spec.md). This plan replaces neither the queued
character-chat plans nor their owner rulings. It turns the architectural conclusions in
[world-engine-refactor.gpt.md](world-engine-refactor.gpt.md) into a gated delivery plan.
The spec owns normative contracts; this document owns sequence, scope, cost, experiments,
migration, and exit criteria.

The one-line direction:

> Build one deterministic, event-driven authority for world truth; let code resolve
> routine life and physical causality; let sparse LLM agents choose only among legal
> alternatives; and make the narrator render a perspective-safe committed cut.

## Decisions this plan makes

1. **TypeScript stays for the first production foundation.** The present risks are
   authority, persistence, concurrency, scheduling, and evaluation—not raw arithmetic
   throughput. The kernel must be isolated, deterministic, benchmarked, and portable so a
   measured hotspot can later move to Rust or WASM without moving product rules.
2. **The successor is not an extension of the deprecated session engine.** Useful ideas
   may be recovered, but its aggregates, movement-by-turn, narrator authority, and
   permissive access defaults are not the target architecture.
3. **There is no per-minute world tick.** A durable scheduler jumps between due triggers,
   integrates continuous rates analytically, and records only material outcomes.
4. **Schedules express intent and constraints.** They never directly set an NPC's
   location or mark themselves kept because a clock boundary passed.
5. **A live conversation is a world activity.** It can consume attention and create
   dramatic pressure, but it cannot freeze jobs, sleep, travel, hazards, or other actors.
6. **LLMs do not own hard state.** They may interpret language, rank a small legal choice
   set, render narration, and propose soft canon. Commands, validation, domain events,
   projections, and access rules remain deterministic.
7. **Truth, observation, belief, memory, and prose are separate.** RAG is a perspective-
   filtered recall layer, never the source of physical truth.
8. **One developer follows one gated path.** Work is not called parallel when an earlier
   contract is a prerequisite. Independent current-chat fixes may ship while the
   successor is being designed, but successor phases are sequential.
9. **The first architecture slice is intentionally tiny.** It proves one authority and
   one perspective invariant with an item transfer. The rich life scenario is a later
   graduation test, not the first experiment.
10. **Current owner rulings remain intact.** In particular, the queued rhythm body patch
    deliberately uses window crossing and no blanket self-care restore. The successor
    must not block that current-lane work on primitives the lane does not yet have.

## Product goal

Vesper should feel as though characters continue to inhabit one causally coherent world
whether or not the player is looking. Characters should have bodies, commitments,
relationships, possessions, homes, work, travel, knowledge, privacy, and consequences.
The player should be able to influence that world without receiving omnipotent control
over NPC bodies or bypassing space, time, access, and consent.

The engine succeeds when it makes richer roleplay possible while preserving:

- character voice and chemistry;
- player agency;
- causal and physical continuity;
- perspective and privacy;
- bounded latency and model cost;
- replayability and debuggability;
- graceful degradation when models or background jobs fail.

## Non-goals

The first production foundation will not attempt:

- continuous physics, exact fluid dynamics, or a general scientific simulator;
- an LLM process for every character, institution, room, or minute;
- perfect psychological prediction;
- exact simulation of every commodity and anonymous citizen;
- natural-language text as the authoritative database;
- a universal action ontology before real scenarios demand it;
- simultaneous migration of every current-chat subsystem;
- a promise that all authored worlds use the maximum simulation depth.

The architecture must admit greater depth, but each world type may choose packages,
fidelity, content rules, and population scale.

## Current baseline and immediate corrections

Before an architectural comparison is trustworthy, the current lane must satisfy its own
invariants.

### P0 — group retake rollback integrity

The current group-chat rerun snapshot is primary-only. Non-primary members can retain
regard, emotional state, drives, wardrobe or personal fields, relationship samples, and
milestones from a discarded reply, after which the replacement reply settles on top.

Repair this independently of the new engine:

1. retain every roster member's stored pre-drift state;
2. load each member's snapshot on regenerate or latest-turn rerun;
3. save each member's snapshot after the guarded member save;
4. add group regression tests covering all mutable member state;
5. reject or branch reach-back reruns instead of presenting an in-place rollback that is
   not real.

Exit criterion: discarding a reply leaves the complete group state equal to the
pre-reply snapshot, byte-for-byte for fields in scope.

### Preserve the queued meter ruling

The planned rhythm body patch is window-crossing logic. It is not a simple sibling of
the arrival-covering rhythm outfit patch, and it does not blanket-restore missed meals or
hygiene. Keep the current 6am-versus-8am behavior and its owner-approved semantics.

The temporary inferScheduleKind helper introduces a new text-matching contract. Treat it
as a migration adapter only:

- add an explicit unknown result;
- run it in shadow mode over the authored corpus;
- log matched rule and confidence;
- prohibit false-positive hard effects;
- write typed schedule kind on all new or edited entries;
- remove inference after migration coverage reaches the declared threshold.

## Feasibility boundary

### Feasible now in deterministic code

- stable world, branch, actor, place, item, activity, and event identity;
- travel over a bounded topology with time and access constraints;
- schedules, deadlines, preparation, lateness, cancellation, and consequences;
- body rates, thresholds, sleep pressure, hygiene, arousal, illness, and recovery;
- inventories, containers, ownership, reservations, and resource consumption;
- observation eligibility, disclosure, beliefs, gossip provenance, and contradiction;
- relationship ledgers and bounded derived reads;
- routine NPC policy, utility scoring, and event-driven catch-up;
- analytical low-detail populations and institutions;
- replay, branching, retakes, audits, and perspective-safe context compilation.

### Feasible only with approximation

- nuanced long-horizon plans;
- social reputation across large populations;
- labor, housing, and market behavior;
- emergent romance and conflict;
- urban traffic, queues, weather effects, and institutional response;
- thousands of off-screen actors.

These should use aggregates, representative agents, bounded stochastic models, and
event-triggered promotion to higher detail. They should not pretend to be exact.

### Infeasible or counterproductive as a near-term target

- one reasoning model call per NPC per turn;
- exact simulation of every anonymous person's private life;
- unrestricted narrator-created movement, items, injuries, or knowledge;
- a vector store queried as though similarity established truth;
- attempting to encode every human action before shipping one end-to-end seam;
- choosing a systems language before a profiler identifies a stable hotspot.

## North-star topology

The target consists of small services or packages with explicit authority:

| Component | Owns | Does not own |
| --- | --- | --- |
| Command gateway | identity, authorization, idempotency, command admission | world outcomes |
| Simulation kernel | validation, deterministic resolution, domain events | prose or vector recall |
| Branch sequencer | one ordered stream per world branch | model calls |
| Scheduler | due triggers and analytical integration | direct location changes |
| Projections | current query state | historical authority |
| Live-scene arbiter | pressure, legal outcomes, committed transitions | narration |
| Perception and knowledge | observation, assertion, belief eligibility | physical truth |
| Context compiler | one redacted NarrativeCut | creative prose |
| Narrator | presentation of the committed cut | hard state mutation |
| Memory indexer | searchable representations of eligible records | canon decisions |
| Policy controller | cheap routine NPC choices | bypassing validators |
| Deliberator | rare choice among legal candidates | inventing candidates or effects |

The first implementation may run these components in one process. The boundaries are
contracts and transaction seams, not a requirement for microservices.

## Delivery strategy

Each gate has four possible outcomes:

- **advance** — evidence meets the declared exit criteria;
- **revise** — the seam is valuable but the contract is wrong;
- **hold** — value is plausible but cost or latency is unacceptable;
- **stop** — the architecture does not outperform a simpler current-lane solution.

No later phase is justified merely because it appears in this plan.

## Gate 0 — establish trustworthy evidence

Status: **ADVANCE — closed 2026-07-16.** See the exact evidence and bounded follow-ups in
[gate0.closeout.md](gate0.closeout.md). This status permits Gate 1 only; no spike was
promoted to production.

Rough effort: **3–6 developer-days**, excluding the already queued meter plan.

### G0.1 Repair the known invariant

Ship the group-retake repair above and preserve a regression fixture with at least two
non-primary members whose mutable fields change during the discarded response.

### G0.2 Build the baseline harness

Create a fixed scenario corpus and capture:

- input messages and authored setup;
- deterministic state before and after each turn;
- rendered transcript;
- model, prompt, and completion tokens by leg;
- p50 and p95 end-to-end latency;
- model-call count and degraded-leg count;
- contradiction, perspective leak, and hard-effect repair counts.

The harness must replay a pinned case without editing fixtures by hand.

### G0.3 Run three sub-day spikes

**Witness eligibility spike.** In the old session lane only, make viewpoint identity a
SQL eligibility condition before vector ranking. Preserve explicitly global or authored
records. Use the existing concealment fixture to verify that an observer can retrieve a
transfer and a non-observer cannot.

**Schedule-kind shadow spike.** Run inferScheduleKind without causing effects. Review its
confusion matrix across authored profiles, especially ambiguous activity prose. Any
false-positive hard physiological or location effect fails the spike.

**Grounded-context ablation.** Give the current narrator one deterministic, redacted
context difference—such as daylight/privacy or the owner-approved 6am-versus-8am body
state—without adding a model call. Compare baseline and treatment transcripts blindly.

### Gate 0 exit

- retakes restore all member state;
- baseline data is reproducible;
- at least one spike improves a declared quality dimension without a deterministic leak;
- no spike is silently promoted into production based on anecdotes.

If viewpoint filtering provides no measurable benefit in the controlled scenario, revise
the proposed belief slice before building its tables.

## Gate 1 — minimum authority seam

Rough effort: **5–10 developer-days**.

This is the cheapest test of the successor architecture. Build only:

- one world and one branch with stable identity and an optimistic version;
- one stable item and two containers or locations;
- one transfer_item command;
- one validator, one domain event, and one synchronous projection;
- one observer and one non-observer;
- a minimal perspective view consumed by the existing narrator;
- replay and presentation-only rerender.

Do not add a scheduler, physiology, illness, economy, autonomous NPC, procedural
generation, or a new model leg.

### Gate 1 acceptance

- an invalid transfer emits no event and changes no projection;
- duplicate idempotency keys produce one outcome;
- replay produces the same projection hash;
- the observer may recall the transfer and the non-observer may not;
- rerender cannot leave a discarded transfer in state or memory;
- the narrator cannot invent a second transfer or expose it to the wrong viewpoint;
- added p95 latency remains inside the predeclared budget;
- the implementation is small enough to delete if it fails.

Stop or redesign if a one-command seam cannot remain understandable, replayable, and
faster than an LLM-mediated equivalent.

## Gate 2 — production identity, event kernel, and scheduler

Status: **ADVANCE — closed 2026-07-17.** E2.1–E2.5 shipped in sequence; E2.6 ran the
required proofs (21/21 checks at the full synthetic-month profile — evidence and one
accepted caveat about schedule-time trigger templates going stale under live load in
[engine-gate2-soak.plan.md](engine-gate2-soak.plan.md) §Verdict) and the owner ruled
advance. This status permits Gate 3 design; its build stays blocked on the 10 product
rulings below.

Rough effort: **15–30 developer-days** after Gate 1.

### Deliverables

- WorldType, World, WorldBranch, CharacterTemplate, WorldCharacter, PlayerCharacter,
  Location, Item, Action, Commitment, and Event identities;
- a branch-scoped command log, event log, version, idempotency record, and outbox;
- deterministic ordering and seeded random streams;
- schema-versioned event envelopes and upcasters;
- synchronous core projections and asynchronous rebuildable projections;
- a durable next-trigger queue;
- analytical integration between triggers;
- fork, replay, snapshot, projection hash, and audit tools;
- branch-level serialization without holding a database lock across a model call;
- feature flags that assign a test world to the successor.

### Gate 2 build order

Gate 2 is split into stable implementation targets. The IDs describe dependency order;
they are not GitHub pull-request numbers.

1. **E2.1 — production identity and envelopes.** Promote the Gate 1 identifiers,
   integer causal primitives, principal taxonomy, command envelopes, event envelopes,
   and exhaustive results into reusable contracts. Migrate `transfer_item` onto them
   without changing its outcome. No database tables yet.
2. **E2.2 — durable branch transaction.** Add `sim_worlds`, `sim_branches`,
   `sim_commands`, `sim_events`, and the minimum typed item-holding projection. Serialize
   accepted work per branch; persist idempotent results and prove crash atomicity.
3. **E2.3 — outbox and rebuildable consumers.** Add transactional outbox rows,
   idempotent consumer checkpoints, one asynchronous projection, retry diagnostics, and
   rebuild-from-zero tooling.
4. **E2.4 — durable scheduler and deterministic draws.** Add trigger identity,
   uniqueness, claim/retry semantics, stable simultaneous ordering, named random streams,
   and one trigger that resolves through the same kernel transaction.
5. **E2.5 — forks, snapshots, and audit.** Add branch ancestry, fork boundaries,
   checksummed snapshots, projection comparison, and causal explanation queries.
6. **E2.6 — Gate 2 soak and verdict.** Run the synthetic-month, partition-invariance,
   retry, crash, queue-growth, replay-hash, and diagnostics proofs. Record advance,
   revise, hold, or stop before movement or live-scene work begins.

Each target stays reviewable on its own. E2.2 consumes E2.1; E2.3 and E2.4 consume the
E2.2 transaction; E2.5 consumes the stable event store; E2.6 closes the gate.

### Required proofs

- a large time skip and equivalent partitions produce the same material outcomes;
- a scheduler retry cannot duplicate an event;
- a stale command fails with a structured conflict;
- a crashed outbox consumer resumes idempotently;
- every path-dependent derived decision records the value or inputs and derivation
  version that caused history;
- rebuild from events matches live projections.

### Gate 2 exit

The kernel can run for a simulated month of synthetic commands and triggers with stable
hashes, bounded queue growth, no duplicate outcomes, and useful diagnostics.

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

## Gate 4 — perception, knowledge, narration, and RAG

Status: **ACTIVE — build started 2026-07-18** (Gate 3 closed with the owner's advance
verdict the same day). Both Gate 4-blocking decisions were resolved by the owner on
2026-07-18: ruling 14 (soft-canon promotion → safe documented auto-promotion; normative
wording in [engine.spec.md](engine.spec.md) §39) and the exit scope (the deterministic
corpus closes the gate; the live paired voice/chemistry eval rides the owner-gated spend
list in [deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs).

Rough effort: **10–25 developer-days**.

### Deliverables

- observations with channel, witness, evidence, confidence, and source event;
- assertions distinct from events;
- beliefs with holder, provenance, confidence, validity, contradiction, and
  supersedence;
- disclosure and gossip as causal events;
- relationship ledgers derived from witnessed interaction and explicit changes;
- a typed NarrativeCut with must-enact, perceptible, believed, allowed, forbidden, and
  failure-presentation fields;
- perspective eligibility applied before vector ranking;
- memory documents linked back to assertions or events;
- an ArmedEffect confirmation path for speech and other semantic effects;
- a continuity/physics auditor that flags presentation defects but cannot mutate truth.

### RAG migration rule

The vector store indexes eligible representations. It does not decide whether a memory
is true, current, known, or visible. Eligibility is resolved from normalized ledgers
before top-k ranking, and every returned item carries provenance.

### Gate 4 exit

- deterministic tests show zero cross-viewpoint leaks;
- contradictions and retractions do not leave both claims presented as current truth;
- rerendering the same cut does not create new memories or events;
- narrator failures can be retried from the same cut;
- added context improves causal enactment without degrading median voice or chemistry.

Ruled 2026-07-18: the first four (the deterministic corpus) close the gate. The fifth is
a live paired eval and rides the owner-gated spend list — it does not hold the verdict.

### Gate 4 build order

Like Gates 2 and 3, Gate 4 splits into dependency-ordered targets. The IDs describe
order, not GitHub PR numbers; each stays reviewable on its own and ships to the
long-lived `engine` branch.

1. **E4.1 — perception and observation.** Status: **shipped — 2026-07-18.** The §20
   perception engine: typed `Observation` rows (`sim_observations`, migration 0063) —
   channel, evidence class, fixed-point confidence, detail tier, derivation version
   (`perception-v1`) on every row. One pure rule table (`lib/simulation/perception.ts`,
   exhaustive over the event union so a new event kind cannot ship without a perception
   ruling): participants perceive embodied at full detail; a zone-anchored physical event
   is seen clearly in its zone and only heard across zones of the same location; captured
   payload witness sets are trusted as-is (the action's noticeability profile already
   encoded them — a private activity stays private); engagement events split by channel
   (co-present participants embodied with location-level bystander glimpses, remote
   participants device-only); a co-present speech act can be overheard at its location, a
   remote one cannot; storyteller relocation grants destination-zone glimpses only —
   never the mechanism (ruling 4); scheduler/commitment bookkeeping derives nothing.
   Every command transaction now ends by deriving observations against the post-command
   locus rows (the §11.1 shell hook covers all shell stores; the pre-shell space and
   item-transfer stores got the same one-line hook), and replay grades each command's
   events against its group-final space folded through `applySpaceEvent` — live and
   rebuilt rows are identical by construction, proven bit-for-bit in the int suite and
   wired into `forkBranch` (a mid-journey fork carries exactly the observations its
   inherited history explains). The E3.5 interim witness rule is DELETED: `compileGate3Cut`
   takes `viewpointObservations` and re-decides nothing about witnessing (corpus green
   unchanged), and the E3.3 knowledge gate's new `observed` member fires notice only for
   an actor holding a real observation of the named event — fails closed otherwise.
   9 pure + 4 integration cases; CI runs `test:engine-e4-1`. Delivery notes:
   confidence/tier constants are deliberately coarse (graded by how evidence arrived, not
   who witnessed — impairment/lighting/distance refine under a bumped derivation
   version); `activity_interrupted`/`activity_resumed` grade participants only until a
   command emits them; `touch`/`smell`/`social` channels and `reported`/`inferred`
   evidence classes are reserved vocabulary for E4.2 gossip; the legacy Gate-1
   observed-containers mechanism still feeds `ItemTransferObservation` for the Gate 1/2
   proofs — typed rows now derive alongside it, and folding it in is a later cleanup.
2. **E4.2 — assertions, beliefs, disclosure, and gossip.** The §21 knowledge substrate:
   `sim_assertions` + `sim_beliefs` (own migration) with provenance
   (basis observations, learned-from actors), validity intervals, and the
   contradiction/supersedence status machines; `DisclosureMade` as a causal event whose
   listeners gain observations and belief updates, each gossip hop preserving provenance
   through an explicit event; the E3.3 commitment knowledge source widens from its one
   `authored` member to observation/assertion/belief members (the promised no-schema-change
   tightening); the §21.3 relationship-evidence seam as typed evidence events + a derived
   read (the full promises/favors/debts social ledger stays Gate 5).
3. **E4.3 — NarrativeCut v2, narrator integration, and soft canon.** The full §22.1
   contract replacing the Gate 3 deterministic subset: `speakerBeliefs` (E4.2),
   `perceptibleNow` as evidence views (E4.1), `creativeLicenses`, and per-field
   provenance refs; cut rows persisted immutable and addressable with the §22.3
   recompile-identity hash; the §23.1 `NarratorResult` trust boundary (`parseOr`, safe
   defaults); rerender re-reads the persisted cut and creates no events or memories;
   narrator failure retry from the same cut (ruling 8 formalized on the persisted row);
   the §23.2 presentation auditor — flags missing must-enact beats and forbidden claims,
   may request rerender or a deterministic bridge, cannot mutate truth; and §23.4 soft
   canon under ruling 14 — a bounded expiring store, proposals validated through
   conflict/privacy/scope/duplication/world-type checks, and **auto-promotion** once a
   key is reused across the ruled number of committed cuts, emitting an audited
   promotion event with a demotion path; every threshold versioned per world type and
   documented for tuning. The §19.3 deliberator admission seam joins here (bounded legal
   candidates, deterministic fallback + timeout, recorded rationale) — exercised with a
   stub in tests, zero live calls.
4. **E4.4 — RAG eligibility and memory linkage.** The §24 retrieval redesign:
   outbox-driven indexing of eligible representations (observations, active
   assertions/beliefs, participated dialogue episodes, authorized authored lore, bounded
   soft canon) with source id/kind, branch + sequence interval, viewpoint eligibility,
   validity/supersedence intervals, and schema/model versions on every document;
   the eligibility-before-similarity query pipeline (§24.1 — branch, viewpoint,
   validity, and privacy resolved relationally before vector ranking, provenance +
   epistemic label on every result); memory documents linked back to their source
   assertions/events; indexing failure degrades recall with lag diagnostics, never
   widens visibility.
5. **E4.5 — the Gate 4 exit corpus.** Deterministic scenarios closing the gate per the
   2026-07-18 ruling: cross-viewpoint leak sweeps (the §36.4 live-scene suite extended
   with knowledge asymmetry — a viewpoint that did not observe or learn a fact never
   receives it in cut, prompt, or retrieval), contradiction/retraction presentation
   (both claims never current), rerender-creates-nothing, retry-from-the-same-cut, and
   gossip-provenance chains. Zero model calls. The live paired voice/chemistry eval is
   recorded as an owner-gated spend item, not a gate blocker.

E4.2 consumes E4.1's observations; E4.3 consumes both; E4.4 consumes the E4.1–E4.3
ledgers and the persisted cuts; E4.5 closes the gate. Deferred design notes carried in:
pressure acknowledgment and the resumed-activity re-arm (E3.4 notes) slot into E4.3's
arbiter work if scenario pressure demands them, else they carry to Gate 5.

## Gate 5 — bodies, materials, households, and relationships

Rough effort: **15–35 developer-days**.

### G5.1 Unified body substrate

Move current-chat body learning behind the successor contracts:

- scalar and categorical substrate;
- analytical drift on story time;
- conditions, thresholds, recovery, and sources;
- a single modifier engine with stacking and expiry;
- derived reads that are pure, total, contextual, and perception-gated;
- path-dependent threshold outcomes captured as events.

### G5.2 Material life

Add typed containers, holdings, ownership, consumption, wear, cleanliness, household
stores, money at an appropriate LOD, reservations, and replacement. Keep a coarse means
read for low-detail actors while allowing promoted characters to own explicit assets.

### G5.3 Social life

Add commitments and consequences across relationships:

- promises, favors, debts, boundaries, trust evidence, attraction, resentment;
- relationship changes as ledger entries, not solely prose summaries;
- social observations and gossip with provenance;
- conflicts among goals, needs, roles, and commitments.

### Gate 5 exit

The engine can explain why a body, item, household, or relationship is in its current
state from causal records, while the narrator sees only what the viewpoint can perceive
or believe.

## Gate 6 — dual LOD and autonomous background life

Rough effort: **10–25 developer-days**.

Simulation detail and narrative attention are separate controls.

### Simulation LOD

- **Exact:** on-screen actors, contested actions, scarce items, hazards, and commitments
  near a boundary.
- **Event:** named off-screen actors resolved at material transitions.
- **Aggregate:** crowds, institutions, inventories, and economies updated by flows.
- **Dormant:** no work until an incoming dependency or promotion boundary.

### Inference LOD

- **No model:** deterministic routine or dominated choice.
- **Small model:** language classification or a close but low-risk ranking.
- **Deliberator:** rare, consequential, ambiguous choice among a bounded legal set.
- **Narrator:** one presentation call for the committed cut.

### Promotion and catch-up

Promotion must reconstruct the detail required by the arriving viewpoint without
inventing contradictions. Catch-up jumps between material triggers, integrates rates,
and samples only where an aggregate must become concrete. The seed and derivation version
are recorded when sampling affects history.

### Gate 6 exit

Increasing the off-screen population by an order of magnitude does not create a linear
increase in model calls or per-minute work, and promoted actors remain causally
consistent with their aggregate history.

## Gate 7 — optional institutions and macro simulation

This is not part of the initial 60–120+ day foundation. Admit packages only when a world
type and scenario corpus justify them.

Candidates include:

- employers, schools, households, landlords, and service providers;
- housing, labor, transport, and commodity flows;
- news, law, reputation, and institutional memory;
- weather, utilities, traffic, queues, and local hazards;
- factions, governance, cultural norms, and historical change.

Each package must declare:

- authoritative entities and events;
- required inputs and emitted pressures;
- simulation and inference LOD behavior;
- conservation or consistency laws;
- performance budget;
- observation and privacy rules;
- deterministic fallback;
- removal or disable path.

## One-developer dependency order

For one developer, the critical path is:

1. current invariant repair and baseline;
2. discriminating spikes;
3. minimum authority seam;
4. production identity and command/event foundation;
5. scheduler and projections;
6. space, actions, schedules, resources, journeys, access, and live-scene arbitration;
7. observation, knowledge, NarrativeCut, and RAG eligibility;
8. bodies, inventories, households, relationships, and material traces;
9. dual LOD and autonomous background behavior;
10. optional macro packages.

Meter-economy work may land in the current chat lane after Gate 0 because its owner ruling
is independent. It should later migrate through adapters after the relevant successor
interfaces exist.

## Cost envelope

These are order-of-magnitude engineering estimates, not commitments. They assume one
developer familiar with the repository and exclude content, UI tooling, balancing,
production polish, and broad migration.

| Work | Rough effort | Confidence |
| --- | ---: | --- |
| Group-retake snapshot repair | 0.5–1.5 days | Medium |
| Baseline transcript and performance harness | 1–2 days | Medium |
| Each discriminating spike | 0.5–1 day | Medium |
| Queued current-lane meter economy | 3–7 days | Low–medium |
| Minimum authority seam | 5–10 days | Low |
| Identity, kernel, scheduler, projections | 15–30 days | Low |
| Space, action, schedule, resource, journey, access, live-scene layer | 15–35 days | Low |
| Perspective ledger, NarrativeCut, and RAG eligibility | 10–25 days | Low |
| Bodies, material life, relationships, and chat migration | 15–35 days | Very low |
| Dual LOD and background autonomy | 10–25 days | Very low |

The north-star foundation remains plausibly **60–120+ focused developer-days**. Re-estimate
after every gate. A second developer helps only after contracts stabilize; before then,
the branch sequencer, event envelope, and projection boundaries are coordination-heavy.

## Quality evaluation

Architecture is not the outcome. Use 12–20 paired scenarios, multiple samples per
condition, and blinded review of baseline versus treatment.

### Human-scored dimensions

- voice fidelity;
- chemistry and emotional specificity;
- continuity;
- pacing;
- causal enactment;
- contradiction rate;
- exposition burden;
- perspective leakage;
- player and NPC agency.

### Instrumented dimensions

- p50 and p95 turn latency;
- model calls and tokens per turn;
- deterministic resolver time;
- scheduler queue depth and lag;
- projection rebuild time and hash;
- degraded legs and retries;
- hard-effect repair attempts;
- invalid command and stale-version rates;
- context size by provenance class.

### Initial advancement thresholds

- zero deterministic perspective leaks in the fixed corpus;
- at least 80 percent relevant enactment of must-enact beats;
- no forced mention of irrelevant state;
- no decline in median voice or chemistry;
- no material p95 latency increase without a measured quality gain;
- routine world progress requires no additional LLM call;
- replay and skip-partition property tests pass for every supported domain.

Thresholds should be revisited with data, but never after seeing a result solely to make
that result pass.

## Latency and model-call budget

The default turn budget is:

- deterministic reconciliation and context compilation;
- one narrator call;
- zero routine state-agent calls;
- optional existing extraction only for information code could not know;
- at most one deliberator call when a consequential choice is genuinely close.

The deliberator must receive:

- the legal candidate list;
- compact goals, beliefs, commitments, and relationship factors;
- no capability to invent an action or bypass access;
- a deterministic fallback and timeout;
- a recorded rationale summary that is not treated as private chain of thought.

If a feature requires a permanent new model leg, it needs a measured quality gain,
failure behavior, and budget owner.

## Migration and rollout

### Feature flags

Assign authority per world or branch, never per row by accident:

- legacy_chat;
- successor_shadow;
- successor_authoritative;
- successor_narrative_view;
- successor_rag_eligibility.

### Rollout sequence

1. run successor calculations in shadow mode with no effects;
2. compare events and projections to fixed fixtures;
3. enable one internal test world;
4. enable presentation-only use of NarrativeCut;
5. migrate one domain at a time;
6. stop dual writes after its invariant and rollback window close;
7. remove obsolete adapters rather than preserving indefinite compatibility.

### Retakes and history

- rerender means new prose from the same committed NarrativeCut;
- retake means fork from the pre-turn sequence and resolve a new branch;
- reach-back edit always forks;
- no in-place rewind may leave later events, beliefs, embeddings, or member state behind.

### Rollback

Rollback selects the previous authority flag or branch. Events remain immutable for
audit. Rebuildable projections and embeddings may be dropped and regenerated. A schema
migration must provide an event upcaster or explicitly declare the old branch frozen.

## TypeScript decision and exit conditions

Keep the deterministic kernel in a package with:

- no database, network, clock, model, or global-random access;
- integer story time and fixed-point values where rounding affects outcomes;
- explicit seeds and stable iteration order;
- exhaustive command results;
- property tests, replay hashes, and benchmarks;
- serializable contracts that do not depend on TypeScript class identity.

Consider Rust or WASM only when profiling repeatedly shows a stable pure workload—such
as route search, large-population analytical integration, or spatial indexing—consuming
a material share of the latency budget. A rewrite is not justified by expected future
complexity alone.

## RAG decision

Keep pgvector or another vector index as the final ranking stage for prose-scale recall.
Redesign the pipeline around it:

1. resolve branch, viewpoint, time, validity, and knowledge eligibility in relational
   data;
2. select eligible assertions, observations, episodes, and authored lore;
3. rank semantically within that set;
4. diversify and budget results;
5. pass provenance and epistemic labels to the context compiler.

Do not embed transient projections as though they were canon, and do not use top-k
similarity to infer witness, truth, supersedence, or current validity.

## Major risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Event-sourcing scope expands without player value | Gate on one cheap seam and paired quality evaluation |
| Narration becomes mechanical | Separate must-enact facts from creative licenses; score voice and chemistry |
| World rules create excessive refusals | Return legal alternatives and public reasons, not a bare denial |
| Scheduler creates hidden teleports | Schedule only evaluation triggers; movement requires action and journey events |
| Privacy rules leak causes | Separate private cause from public failure presentation |
| LLM choice destabilizes replay | Give it legal candidates, record selected result and model metadata, keep fallback |
| Projection and event schemas drift | Version payloads, upcast, rebuild in CI, hash projections |
| Too many agents increase latency | Deterministic policy by default; sparse deliberation only on measured ambiguity |
| Text inference becomes permanent authority | Shadow, type new data, migrate, instrument, delete adapter |
| TypeScript hot path becomes slow | Benchmark first; move only pure measured kernels |
| Retakes corrupt state | Presentation rerender is state-free; alternative outcome is a branch |

## Product rulings — RESOLVED 2026-07-17

All 10 blocking rulings (plus spec rulings 11 and 13, which Gate 3's sleep and shower
scenarios also need) were **resolved by the owner on 2026-07-17**. The normative record
with full wording lives in [engine.spec.md](engine.spec.md) §39. In brief:

1. **Ordinary dialogue** → a fixed per-exchange story-time span (current ~1 min),
   world-type versioned; explicit actions carry their own durations.
2. **Shifts** → per-commitment firmness (`Commitment.flexibility`), not a global switch.
3. **Transgression** → modeled explicit attempts that never auto-succeed or override
   agency; a world type MAY disallow and reject at admission. Spatial only — intimate
   consent stays an independent precondition.
4. **Storyteller override** → admin principals in an explicit mode only; always audited.
5. **Obligation disclosure** → relationship/personality-driven NPC-policy output.
6. **Missed-obligation consequences** → deterministic rules for the first build (no model
   call); authored tables / director are later layers.
7. **Player concurrency** → one physical locus; at most one co-present Engagement, any
   others remote.
8. **Failed narration** → hidden and retryable; the committed advance is withheld from the
   player until a render succeeds; hard state is never reverted.
9. **Armed speech acts** → all §23.3 acts use ArmedEffect; recorded only when enacted.
10. **First performance target** → 2–8 exact-LOD actors, hours-to-days off-screen horizon.
11. **Waking sleepers** → remote messages queue unread by default; no wake.
13. **Private-denial cover story** → allowed in-character; the true cause is still redacted.
14. **Soft-canon promotion** → **resolved 2026-07-18 (the Gate 4 unblock pass):** a
    **safe, documented auto-promotion** — repeatedly-reused soft canon auto-promotes
    through the §23.4 checks with an audit event and a demotion path; every threshold is
    a versioned world-type value documented for post-build tuning. Full wording in
    [engine.spec.md](engine.spec.md) §39.

Still open: spec ruling 12 only (route-estimate uncertainty exposure — travel polish,
no gate blocked on it).

### Gate 3 build order

Like Gate 2, Gate 3 splits into dependency-ordered targets. The IDs describe order, not
GitHub PR numbers; each stays reviewable on its own and ships to the long-lived `engine`
branch.

1. **E3.1 — authoritative space.** Status: **shipped — 2026-07-17.** `sim_locations`,
   `sim_zones`, `sim_links`, `sim_physical_loci`, and `sim_journeys` (migration 0058);
   the topology and route contracts (§13); `MoveActor` resolving to journey_planned +
   actor_departed + a durable arrival trigger atomically, with `arrive_journey`
   re-validated at fire time through the E2.4 scheduler drain; one active locus per actor
   per branch enforced as the primary key + shape checks; the pure `planRoute` kernel
   (duration-cost, deterministic tie-breaks, relax-one-constraint failure diagnosis);
   fork/replay parity for space state (mid-journey forks re-arm the arrival, post-arrival
   forks record it completed; rebuild-from-zero matches the live hash). Delivery notes:
   link-level access only (state open + public policy) — the six-layer zone/property
   checks stay in E3.5; links traverse bidirectionally (one-way semantics join the
   contract when a scenario demands them); journeys are one in-transit span on their
   first link (per-link progression events come with E3.5 hazards); route uncertainty is
   zero pending open ruling 12; movement emits no outbox rows until a consumer exists.
   The `journey_delayed` / `journey_interrupted` / `journey_abandoned` event vocabulary
   and appliers exist but no command emits them yet — E3.5's hazard/access work does.
2. **E3.2 — typed actions, activities, and claims.** Status: **shipped — 2026-07-17.**
   Authored `SimulationActionDefinition`s (`sim_action_definitions`) and `ActivityInstance`
   rows (`sim_activities`, migration 0059) with the full §16.3 phase machine; body/attention
   claims projected from activity state (§16.3 — no orphanable claim rows);
   `start_activity` emitting the started event + durable completion trigger atomically;
   fire-time re-validated `complete_activity` on the scheduler drain; `cancel_activity`
   releasing claims and retiring the pending completion trigger transactionally; claim law
   wired into movement (`MoveActor` rejects `activity_conflict` on a held body claim;
   starting in transit is refused); co-located witness capture per the noticeability
   profile; fork/replay parity incl. a replay retirement ledger recognizing
   cancelled-activity triggers. Also the shared `runSimulationCommand` §11.1 transaction
   shell (earlier stores keep their inlined copies until a dedicated cleanup). Delivery
   notes: resource costs join with Gate 5 materials; privacy/consent preconditions join
   with E3.5; the §16.4 graded compatibility matrix (conversation-while-cooking, walking
   chats) joins with E3.4 engagements — in this slice every body-claiming activity is
   stationary and blocks departure outright; `activity_interrupted`/`activity_resumed`
   are vocabulary + appliers whose emitting path is E3.4's interruption; pause is not yet
   a command, and a resumed activity's completion re-arm is recorded as an E3.4 design
   note (the retired trigger's uniqueness key must version by attempt).
3. **E3.3 — commitments and temporal pressure.** Status: **shipped — 2026-07-17.**
   `Commitment` with the ruled `flexibility` dial and the §15.4 status machine
   (`sim_commitments`) plus `TemporalPressure` (`sim_temporal_pressures`), migration 0060;
   the §15.2 derivation (noticeAt/decideBy/actBy from E3.1 route + preparation + buffer)
   captured on the creating event; a notice trigger raising pressure with
   flexibility-derived severity, gated on knowledge availability; a deadline trigger
   deterministically evaluating the actor's actual locus into kept / late (inbound) /
   missed with the basis captured (ruling 6) — never moving anyone (§3.1 inv. 5);
   fork/replay parity. Delivery notes: the knowledge source has one live member
   (`authored`) — Gate 4's observation/assertion/belief members tighten the gate without a
   schema change; every E3.3 commitment names a destination zone (destinationless promises
   join with the Gate 5 social ledger); route assumptions are captured at creation —
   recomputation on material change, `late → kept` repair on subsequent arrival,
   acknowledgment, and the warn/negotiate/depart decision behavior are E3.4 arbiter work;
   `accepted`/`declined`/`in_progress` statuses are machine-legal but no command drives
   them yet (E3.4).
4. **E3.4 — engagements and the live-scene arbiter.** Status: **shipped — 2026-07-18**
   (slice 1 on 2026-07-17). Slice 1 (the engagement substrate): `Engagement`
   (`sim_engagements`, migration 0061) with the §18.2 state machine; attention reserved
   through the E3.2 claim arithmetic (full for co-present, partial for remote); one body,
   one physical scene enforced at open (§11.3 — co-located at-loci, no second co-present);
   presence-of-mind rule (a held full-attention claim blocks joining any channel — sleep
   keeps the ruled no-wake default because delivery is not an engagement); conversations
   and body-claiming activities mutually exclude; departures interrupt the mover's open
   co-present scene atomically; fork/replay parity. Slice 2 (the deterministic turn seam):
   `prepareEngagementTurn` runs the §18.3 spine — drain due world work through the fixed
   turn span (ruling 1), look ahead at participant pressure through the horizon, decide
   departures by deterministic policy (`decideDepartures` — earliest actBy per actor,
   stay requests defer to the last moment per §15.3, player-controlled actors never
   policy-moved), commit them as `npc_policy` move commands that interrupt the scene
   through slice-1 machinery, and compile one immutable perspective-safe
   `Gate3NarrativeCut` (§22 trimmed to the deterministic subset: witnessed beats only,
   the viewpoint's OWN pressures only, forbidden teleport claims, armed effects filtered
   to participants). Cuts are derived, not stored — a failed narrator render re-reads the
   same cut (ruling 8; the corpus proves recompile-identity mid-journey). ArmedEffect
   confirmation (ruling 9): `confirm_narrator_result` (system principal only) emits one
   `speech_act_delivered` per validated enacted effect from the closed §23.3 vocabulary;
   effects naming non-participants are dropped, replays return the cached result, id
   reuse rejects. Slice 2 boundaries: engagements still open straight to `active`
   (`opening` handshake and `winding_down` choreography deferred); confirm is called only
   when ≥1 effect landed (min-1 contract — a zero-effect render records nothing);
   persisted cut rows and the LLM deliberator join with Gate 4's narrator integration;
   pressure acknowledgment and the resumed-activity re-arm design note remain open.
5. **E3.5 — access, privacy, consent, and the scenario corpus.** Status: **shipped —
   2026-07-18.** `AccessGrant` rows (`sim_access_grants`, migration 0062, with
   `permits_trespass` on `sim_worlds`) checked fail-closed — a malformed grant row admits
   no one (§13.1); `attempt_entry` resolves the one private last hop routes refuse
   (§14.1: doorstep → interior by `public` | `granted` | explicit `forced` basis), with
   witness capture at both threshold zones and the same atomic scene-interrupt as any
   departure; forced entry requires the world's `permitsTrespass` and is refused as a
   stated rule, never disguised physics (§14.3); denial reasons name no private cause
   (§14.4 — redaction by omission); `storyteller_relocate_actor` is the one privileged
   bypass (ruling 4) — storyteller principals only, audited as a distinct
   `storyteller_relocation` event, abandoning any in-flight journey (`journey_abandoned`
   first, arrival trigger retired). Closed the gate by running the §"Gate 3 scenario
   corpus" (`gate3-corpus.int.test.ts`, 5 scenarios, zero model calls — gate evidence
   2026-07-18: 2 709 pure + 351 integration tests green). The corpus caught and fixed two
   real defects: `resolveRaisePressure` stamped `actBy = latestArrival` instead of the
   §15.2 `latestDeparture` (now recomputed from the fire-time route, clamped forward for
   tight windows), and the arbiter's derived move-command id stacked derived ids past the
   256-char compact-id cap (now hash-compacted). Delivery boundaries: the interim witness
   rule (participant / captured observer / shared location) holds until Gate 4's
   perception engine; no command emits `journey_delayed` yet (hazards deferred); trespass
   has no duration/noise depth yet (ruling 3's time-consuming, noisy texture joins later
   gates); interpersonal-consent preconditions beyond privacy zones join Gate 5's social
   layer. **Verdict: ADVANCE (owner, 2026-07-18) — Gate 3 is closed; the Gate 4 build
   order lives in §"Gate 4" above.**

E3.2 and E3.3 both consume E3.1; E3.4 consumes E3.1–E3.3; E3.5 layers access and privacy
over all of them and runs the exit corpus.

## Graduation scenario

This is deliberately late. It should exercise nearly every foundation only after each
smaller seam has passed.

A named NPC wakes with body state and household resources, prepares for a 4pm shift,
remembers a promise to the player, receives a message while showering, decides when and
how to respond, protects private knowledge, dresses from owned items, leaves with enough
travel time, encounters a delay, arrives late or on time, is witnessed by some actors
but not others, accrues workplace and relationship consequences, and later recalls the
day from their own perspective. A rerender changes only prose; a retake creates a clean
branch; a long skip produces the same material result as equivalent smaller skips.

The graduation verdict must include quality, latency, model cost, replay, and invariant
results. Merely completing the scenario is not success.

## Definition of done for the foundation

- one authoritative command/event stream per branch;
- deterministic replay and projection rebuild;
- event-driven time with no global minute loop;
- causal movement, travel, access, activity, and commitment resolution;
- live conversations reconciled with world pressure before narration;
- one physical locus and actor-control enforcement;
- truth, observation, belief, memory, and presentation separation;
- perspective filtering before semantic retrieval;
- narrator hard-state authority removed;
- rerender and retake semantics that cannot corrupt history;
- bounded model-call budget with deterministic degradation;
- measured quality no worse than the current lane on voice and chemistry;
- documented paths to add, disable, migrate, and test a simulation package.
