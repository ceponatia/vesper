# Engine plan — Gate 3: space, action, schedules, and live-scene arbitration

Status: **ADVANCE — closed 2026-07-18.** E3.1–E3.5 shipped in dependency order
(2026-07-17/18, see §"Gate 3 build order"), the scenario corpus ran green (5 scenarios,
zero model calls, 2 709 pure + 351 integration tests), and the owner ruled advance on
2026-07-18. Open leftovers carried into later gates are recorded per-target in the build
order below (interim witness rule → Gate 4; hazards/`journey_delayed`, trespass texture,
route-uncertainty ruling 12 → travel polish; interpersonal consent → Gate 5).

Part of the [engine.plan.md](engine.plan.md) gate set (split 2026-07-21; one doc per
gate — see the hub's gate index). Sequencing and current status live in
[roadmap.md](../../roadmap.md) and the hub; normative contracts live in the
[engine.spec.md](../../engine.spec.md) §-index.

## Gate 3 — space, action, schedules, and live-scene arbitration

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

### Gate 3 build order

Like Gate 2, Gate 3 split into dependency-ordered targets. The IDs describe order, not
GitHub PR numbers; each stayed reviewable on its own and shipped to the long-lived
`engine` branch.

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
   order lives in
   [engine.gate4.perception-narration.md](engine.gate4.perception-narration.md).**

E3.2 and E3.3 both consume E3.1; E3.4 consumes E3.1–E3.3; E3.5 layers access and privacy
over all of them and runs the exit corpus.

