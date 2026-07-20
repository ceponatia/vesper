# Roadmap

The single ordered index of development plans. **Order here is the only place
priority lives** — reprioritizing is a one-line move, never a file rename (see
`CLAUDE.md` → working-docs convention, and [deferred.plan.md](deferred.plan.md)
§"Plan docs: drop hard phase numbers").

Status legend: **draft** (not settled) · **next** (queued) · **active** (in
progress) · **shipped — <date>** · **parked**.

> Order is priority, top-down. Each entry links its plan; the plan links its
> spec/detail.

## To be Planned

This section is for the product owner to add ideas for features and improvements. AI agents
must _not_ add anything to this section. AI agents _may_ remove items from this section once
they have incorporated them into the roadmap below and either created a new plan or updated
an existing plan that will include this work.

_(Currently empty — the two character-chat ideas that were here graduated to plans on
2026-06-30; see the top of **Next** below.)_

## Active (building now)

- **Successor world engine — Gate 5: bodies, materials, households & relationships** —
  [engine.plan.md](engine.plan.md) §"Gate 5" (**opened 2026-07-19**; ~15–35 dev-days).
  Both opening rulings resolved same-day (ruling 15: v1 body meters = **full chat
  parity**, semantics per [chat-meter-economy.spec.md](chat-meter-economy.spec.md);
  ruling 16: interpersonal consent = ledger-gated fail-closed + §19.3 policy
  escalation — normative wording [engine.spec.md](engine.spec.md) §39). Build order
  E5.1–E5.6 authored: body substrate + modifier engine → chat-parity meters &
  perception-gated reads → material life → households/means/money-at-LOD → the social
  ledger & consent → the deterministic exit corpus. **E5.1–E5.3 shipped 2026-07-19;
  E5.4 (both slices) shipped 2026-07-20** — see Shipped below.
  **E5.5 (the social ledger & consent, ruling 16) is in-gate now — slices 1–2
  (the ledger substrate; the fail-closed consent gate + destinationless
  commitments) shipped 2026-07-20**; remaining: slice 3 (the §19.3 deliberator
  escalation pinned to a deterministic decline fallback, pressure
  acknowledgment as a social act — the carried E3.4 note, full-corpus parity).
  Then E5.6 (the deterministic exit corpus) closes the gate.
  This is where current-chat body learning migrates behind the successor
  contracts — the meter-economy and body-needs plans in Next port through here
  later.

## Next (queued)

**Successor world engine (`engine.plan.md`) — remaining gates.** The gated event-kernel
track, in sequence — each gate's exit criteria gate the next. Gates 0–4 are closed
(E2.1–E2.6 + E3.1–E3.5 + E4.1–E4.5 shipped; Gate 2 verdict: **advance**, 2026-07-17;
Gate 3 verdict: **advance**, 2026-07-18; Gate 4 closed **2026-07-19** by its
deterministic exit corpus per the owner's 2026-07-18 exit-scope ruling — the live
paired voice/chemistry eval is the one deferred human-in-the-loop check, parked in
[deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs). **Gate 5 opened
2026-07-19 and is in Active above.** Full plan [engine.plan.md](engine.plan.md) ·
contract [engine.spec.md](engine.spec.md). (Distinct build from the chat-lane
[world-engine-refactor.plan.md](world-engine-refactor.plan.md) north-star umbrella
further down.)

- **Successor world engine — Gate 6: dual LOD & autonomous background life** —
  [engine.plan.md](engine.plan.md) §"Gate 6" (draft; ~10–25 dev-days). Separate simulation
  LOD (exact · event · aggregate · dormant) and inference LOD (no-model · small-model ·
  deliberator · narrator) controls, plus promotion + event-driven catch-up. Exit: an
  order-of-magnitude more off-screen actors does **not** grow model calls or per-minute work
  linearly.
- **Successor world engine — Gate 7: optional institutions & macro simulation** —
  [engine.plan.md](engine.plan.md) §"Gate 7" (draft). **Explicitly post-foundation and
  optional** — not part of the initial 60–120+ day build; admit a package (employers,
  schools, housing, labor, markets, news, law, weather, factions…) only when a world type +
  scenario corpus justifies it and it declares its authority, LOD, laws, budget, and disable
  path. Listed for tracking, not committed near-term work.

- **Chat meter economy — the body on the story clock** —
  [chat-meter-economy.plan.md](chat-meter-economy.plan.md) ·
  [spec](chat-meter-economy.spec.md) (planned 2026-07-15 from an owner report after the
  clock change: hygiene never visibly decays, arousal never resolves after intimacy
  completes, and flavor-only skips (D14) no longer fit a world where skips are the primary
  time mover; **re-scoped 2026-07-16** on the owner's OQ1–OQ3 rulings and the world-model
  deprecation license). Drift moves off exchange-counting onto the **story clock** at
  retuned rates — which also deletes the `advance` flag, the away-freeze, and the skip's
  meter code — plus an energy sleep model read as a **bidirectional axis** (positive = fuel
  in the tank, negative = past wanting sleep, both poles saturating; the afternoon dip,
  second wind, and collapse at ~40h all emerge, with no hardcoded hour), a pulse `intimacy`
  read with a climax reset + afterglow, arousal regraded to body facts rather than a
  talk-switch, and rhythm-driven off-screen self-care that retires D14. Carries migration
  0052 (+ a backfill).
- **Chat body needs — satiation, hydration, and needs that push** —
  [chat-body-needs.plan.md](chat-body-needs.plan.md) (draft; planned 2026-07-16 from the
  owner's PM notes on the meter-economy plan). The three asked-for meters plus the
  needs → initiative channel that makes them worth having, and the collapse of the
  chat-chip / registered-action fork that currently leaves `meal` and `snack` with no
  meter effects. **Depends on the meter economy landing first** — it is the second use of
  that plan's clock-keyed drift, rhythm `kind`s, and read seam.
- **World engine refactor — a simulated world under the chat lane** —
  [world-engine-refactor.plan.md](world-engine-refactor.plan.md) (draft; written 2026-07-16
  from an owner brainstorm ask). **An umbrella / north-star doc, not a build item** — it is
  the `world-simulation.plan.md` that [deferred.plan.md](deferred.plan.md) §"Old World-Model
  Plans" anticipated, re-derived as the chat successor rather than a session-model revival.
  Nothing is built _as_ this plan; its buildable pieces promote out into their own
  `<topic>.plan.md`, and the two entries above it are already its first two sequencing
  steps. Sits here so it stays discoverable next to them. Thesis: **derive the world,
  remember the people** — weather, season, daylight, ambient temperature, circadian
  pressure, aging and sleep debt are all pure functions of the story clock, so a derived
  world needs no tick, no storage, and (the whole point) **no new agent legs** — the
  catalog is almost entirely deterministic code plus fields on legs that already run. Also
  names the seams the queued plans keep circling: the salience bus (nobody owns
  `buildInitiativeCue`'s budget), meter law by class, `SceneFrame`, and LOD as a way to
  ration the _settle_ — which is what actually scales with roster size, not the sim.
- **RAG improvements** — [RAG-improvements.plan.md](RAG-improvements.plan.md)
  (draft; seven retrieval ideas under evaluation — the least-settled item here).
- **At-rest encryption — user chat content unreadable on Neon** —
  [at-rest-encryption.plan.md](at-rest-encryption.plan.md) (draft — planned
  2026-07-11 from an owner question; position here is provisional). App-side
  AES-256-GCM envelopes over both lanes' transcripts, memory rows, and derived
  sinks so Neon holds only ciphertext (key in Fly secrets); the load-bearing
  open ruling is D1 — encrypt fact/episode embeddings and move scoped
  similarity ranking app-side, since plaintext embeddings are invertible.
- **Codebase-review follow-on batches (2 & 4, session-side remainder)** — findings
  [codebase-review.md](finished/codebase-review.md) §C–E; no plans yet (each needs its
  `<topic>.plan.md` when it becomes active): **prompt intelligence** (§C — session-lane
  cast voices, content-framing/no-refusal port, intimate + dialogue craft rules for the
  session lane, forge upgrades), **dedup & cleanup sweep** (§E — non-chat items).
  **Batch 3 (§D chat-lane consolidation) and the chat-side items of §C/§E are absorbed
  into [finished/character-chat-standalone.plan.md](finished/character-chat-standalone.plan.md)** (top of
  this list). Sequenced after batch 1 per the 2026-07-02 agreement; where the remainder
  slots versus the feature work above is the author's call.

## Someday / parking lot

Unpromoted ideas live in [deferred.plan.md](deferred.plan.md): the relationship &
meter timeline (UX-audit #4), the full **NPC-puppeting** system
([npc-puppeting.deferred.md](npc-puppeting.deferred.md) — only Slice 2's deflection
directive shipped), comms expansions, item acquisition during play, the remaining
UX-audit deferrals (transcript export #8, scene-image pin #9, first-run tour #10,
production-build perf pass §5), observer / god-mode POV, monorepo split (permanently
deferred), and companion-role-as-romance-eligibility (park, don't build).

## Shipped (historical record — newest first; see each plan for detail)

- **World-engine consent gate & destinationless commitments (E5.5, slice 2)** —
  [engine.plan.md](engine.plan.md) §"Gate 5 build order" · contract
  [engine.spec.md](engine.spec.md) §21.4/§15.1/§15.4/§16.1 — 2026-07-20 — ruling 16
  becomes enforceable: `consent_covered` as a fail-closed action-definition
  precondition (schema-constrained to one scope per definition, §16.1) evaluated
  inside the start transaction over the dyad's ledger slice, `consentGrant`
  captured only on permission-entry coverage and fed back into the ledger;
  destinationless commitments land the carried E3.3 leftover — optional
  destination, `promisedToActorId` (self-promise = structured rejection),
  §15.4 repair chains, `fulfill_commitment` with `self_reported` basis,
  location-free deadlines. Migration 0077. Review confirmed + fixed 1 critical
  (self-promise raw-ZodError crash) + 1 major (compound-scope gate checked only
  the first scope). `test:engine-e5-5` at 195; 3 038 pure, E5.4/E5.3 suites
  unbroken. Next: **E5.5 slice 3**.
- **World-engine social ledger substrate (E5.5, slice 1)** —
  [engine.plan.md](engine.plan.md) §"Gate 5 build order" · contract
  [engine.spec.md](engine.spec.md) §21.3–§21.4 (authored this work, whole-feature) —
  2026-07-20 — the persisted relationship ledger the E4.2 derived seam was built to
  feed (that seam now deleted): `sim_relationship_ledger` (migration 0076) under a
  closed versioned entry-kind vocabulary with an explicit derived-vs-authored
  split — speech acts (incl. new `permission_granted`/`permission_withdrawn` with
  required `consentScopeKey`), disclosures, shared scenes, authored priors, and
  `record_relationship_change` (change is a ledger entry, never prose); ledger rows
  commit atomically inside the command transaction; trust/attraction/resentment as
  fixed-point half-life-decayed banded reads; `resolveConsentCoverage` ready for the
  slice-2 gate; fork parity. Caught in-slice: both cut compile and arbiter arming
  dropped `consentScopeKey` (the §21.4 gate would have been unreachable); review
  confirmed + fixed an entry-id tier overflow that could have broken future forks.
  100 cases (`test:engine-e5-5`); 3 005 pure green, E5.4 unbroken. Slices 2–3
  remain in Active. Next: **E5.5 slice 2**.
- **World-engine households, means, and money at LOD (E5.4, slices 1–2)** —
  [engine.plan.md](engine.plan.md) §"Gate 5 build order" · contract
  [engine.spec.md](engine.spec.md) §26.8–§26.11 (authored this work) — 2026-07-20 —
  households as first-class evented entities with fail-closed shared-store access;
  fungible lots with fixed-point conserved quantities (same-kind transfers conserve
  by construction, cross-kind exchanges are causally-linked adjustment pairs, the
  means-band restock top-up is the one sanctioned unconserved credit); means bands
  with structural lot-over-band precedence and an explicit `unknown` degraded
  default; §27.2 promotion — an explicit item exists only through
  `promote_item_from_stock`'s recorded, deterministically-sampled,
  allowance-consuming event train; restock as fixed-cadence household routine
  through the E2.4 scheduler with fire-time re-validation; money as the reserved
  fixed-point `currency` kind for promoted actors. Migrations 0074/0075.
  Adversarial three-lens review confirmed and fixed 3 major findings (incl. a
  real trigger claim/dispatch race — `processing` rows now retire on reconfigure).
  53 new pure + 16 new int cases; CI runs `test:engine-e5-4` (2 927 pure +
  414 int green). Next: **E5.5**.
- **World-engine material life (E5.3, slices 1–3)** — [engine.plan.md](engine.plan.md)
  §"Gate 5 build order" · contract [engine.spec.md](engine.spec.md) §26 (expanded
  this work) — 2026-07-19 — §26 over the Gate 1/2 item lane, replacing the stand-ins
  wholesale. Slice 1, the honest material lane: typed holding loci (held / worn /
  container / zone / gone) as the holdings row itself, containers-as-items with
  capacity + fail-closed access, ownership distinct from holding (`againstOwnership`
  as social fact for the E5.5 ledger), the §26.4 transfer law in one pure resolver,
  the lane migrated onto the shared command shell + §20 perception + the live §22
  cut (Gate-1 bridge and `observed_container_ids` deleted), migrations 0069/0070.
  Slice 2, the carried E3.2 leftover: `resourceCosts` on action definitions,
  deterministic held-first reservations captured on `activity_started` and projected
  from activity state like claims, `item_reserved` on every material command, and
  `consume_item` + completion consumption emitting causation-chained body-source
  trains through the §25 kernel — a meal is a material event with a body effect
  (migrations 0071/0072). Slice 3, item condition: wear + cleanliness meters on the
  §25 kernel under `item-condition-v1`, worn-window cleanliness drift via a standard
  modifier, use-deltas at completion, instant crossings for driftless wear, the
  `item_condition_threshold_due` alarm, witnessed grimy/worn-out beats, fork/replay
  parity (migration 0073). 74 new pure + 33 new int cases across the slices; CI runs
  `test:engine-e5-3` (2 874 pure + 398 int green; Gate 1 benchmark re-passing at
  p95 0.028 ms over the new lane). Next: **E5.4**.
- **World-engine chat-parity meters & perception-gated reads (E5.2, slices 1 + 2a + 2b)** —
  [engine.plan.md](engine.plan.md) §"Gate 5 build order" · contract
  [engine.spec.md](engine.spec.md) §25 — 2026-07-19 — the ruling-15 meter set on the
  E5.1 substrate, semantics per [chat-meter-economy.spec.md](chat-meter-economy.spec.md).
  Slice 1: authored `sim_body_rhythms` (migration 0068), circadian pressure as a pure
  clock function reproducing the chat spec's verified 7am/11pm table (the −1 floor
  lands at ~40h emergently), the signed saturating bidirectional energy read, sleep
  suspend + wake `sleep_credit` both ways, and §25.5 wash window-crossings folded
  into the piecewise integration and the alarm solver (no per-day tick anywhere).
  Slice 2a: arousal regraded to the OQ2 intimacy pulse (quiescent→cresting +
  afterglow, never "low arousal"), the CLOSED visible-sign registry gated by
  perception tier, climax `reset_to_baseline` + self-expiring afterglow, exertion →
  hygiene coupling, and `bodilyReads` in the cut-v3 NarrativeCut — raw meters
  structurally absent. Slice 2b: collapse at the saturated read floor — the
  wake-armed `body_collapse_due` alarm, drain-fired witnessed collapse interrupting
  every claim-holding activity and open scene, forced sleep through the ordinary
  condition machinery, and `resume_activity` with the attempt-versioned completion
  re-arm (the carried E3.4 note landed). 23 pure + 4 int cases across the slices;
  CI runs `test:engine-e5-2` (2 813 pure + 381 int green). Next: **E5.3**.
- **World-engine body substrate (E5.1) — GATE 5 OPENED** —
  [engine.plan.md](engine.plan.md) §"Gate 5 build order" · contract
  [engine.spec.md](engine.spec.md) §25 — 2026-07-19 — Gate 5 opened with both
  rulings resolved same-day (15: full chat parity; 16: ledger-gated fail-closed
  consent) and its first slice shipped: the §25.1–25.3 meter-agnostic machinery — a
  versioned `BodyMeterDefinition` registry (reserve/load/valence/rate/phase classes,
  analytic linear + half-life drift laws in fixed-point units, thresholds as
  registry data, the ruling-15 energy/hygiene/arousal entries),
  `sim_body_meters`/`sim_body_conditions`/`sim_body_modifiers` (migration 0067)
  under the one §25.3 modifier contract, and a pure kernel integrating analytically
  and piecewise across modifier boundaries with queries never persisting (partition
  invariance by construction; deterministic fixed-point exp2, thresholds solved by
  per-piece binary search so the scheduled second and fire-time evaluation cannot
  disagree). Two new trigger kinds arm through the E2.4 scheduler (the deferred
  analytical-rate integration landed); six body commands; interoception vs witnessed
  perception per ruling; fork/replay parity end-to-end. 19 pure + 5 int cases; CI
  runs `test:engine-e5-1` (2 790 pure + 377 int green). Next: **E5.2**.
- **World-engine Gate 4 exit corpus (E4.5) — GATE 4 CLOSED** —
  [engine.plan.md](engine.plan.md) §"Gate 4 exit" + §"Gate 4 build order" — 2026-07-19 —
  four deterministic scenarios, zero model calls (`test:engine-e4-5`; 2 771 pure +
  372 int green): cross-viewpoint leak sweep under knowledge asymmetry across cut,
  serialized prompt input, and retrieval (querying for the secret widens nothing);
  contradiction/retraction leaving neither claim presented as current truth;
  rerender-creates-nothing as row-count invariance over all eight persistence
  surfaces; retry-from-the-same-cut bit-identical; and a 3-hop gossip-provenance
  chain (decay 9 000→8 000→7 000, route reconstructible, retraction reaches only
  earshot). Closes Gate 4 per the 2026-07-18 exit-scope ruling; the live paired
  voice/chemistry eval (the only human-in-the-loop check) is deferred to
  [deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs. Next gate:
  **Gate 5** (queued in Next).
- **World-engine RAG eligibility & memory linkage (E4.4)** —
  [engine.plan.md](engine.plan.md) §"Gate 4 build order" · contract
  [engine.spec.md](engine.spec.md) §24 — 2026-07-19 — redacted memory documents
  (`sim_memory_documents`, migration 0066) with source links, sequence intervals,
  eligibility surfaces, validity/supersedence, and schema/model versions; outbox-driven
  indexing through a generalized claim/release lane with visible lag and an injected
  embedding seam that degrades to text-only recall; the §24.1 pipeline resolves branch
  ancestry (nearest-branch dedupe), viewpoint eligibility (fixed actors or live-belief
  joins), and per-kind relational validity against the query branch's ledgers before
  any similarity ranking — so retraction, demotion, and fork divergence narrow recall
  and no query text or embedding ever widens it; provenance + epistemic label on every
  result; authored lore seeded with explicit visibility. 8 pure + 4 int cases; CI runs
  `test:engine-e4-4` (2 771 pure + 368 int green). Next: **E4.5**.
- **World-engine NarrativeCut v2, narrator boundary & soft canon (E4.3)** —
  [engine.plan.md](engine.plan.md) §"Gate 4 build order" · contract
  [engine.spec.md](engine.spec.md) §22–23 — 2026-07-19 — the full §22.1 cut
  (speaker beliefs, evidence views, activities, typed forbidden claims, failure
  presentations, creative licenses, per-field provenance) persisted immutable in
  `sim_narrative_cuts` (migration 0065) with the §22.3 recompile-identity hash;
  rerender/ruling-8 retry re-read the row and create nothing; §23.1 `parseNarratorResult`
  trust boundary + §23.2 structural auditor (bridge small omissions, rerender the rest);
  confirm-by-id v2 with cut supersedence and the armed-disclosure → §21 knowledge
  bridge; ruling-14 soft canon in `sim_soft_canon` — validated proposals, audited
  auto-promotion at the ruled reuse count, storyteller-only demotion, every threshold a
  versioned world-type value; §19.3 deliberator admission seam wired into departures,
  stub-exercised, zero live calls. 30 pure + 4 int cases; CI runs `test:engine-e4-3`
  (2 763 pure + 364 int green). Next: **E4.4**.
- **World-engine assertions, beliefs & gossip (E4.2)** — [engine.plan.md](engine.plan.md)
  §"Gate 4 build order" · contract [engine.spec.md](engine.spec.md) §21 — 2026-07-19 —
  the §21 knowledge substrate: `sim_assertions` + `sim_beliefs` (migration 0064) as
  derived ledgers with provenance and both status machines; the new `disclosure_made`
  event (claim / relay / retraction with §6.4 captured derivation) and `make_disclosure`
  command; listeners perceive content as the reserved `social`/`reported` class and the
  belief fold keys off exactly that — speaker and muffled bystanders form no belief;
  deterministic v1 gossip rules (hop decay, refresh-supersede, strictly-stronger flips
  else doubted, cross-source conflicts contradict both, retraction rejects only for
  those in earshot); fork replays the identical fold bit-for-bit; the E3.3 knowledge
  gate gains fail-closed `asserted`/`believed` members; §21.3 ships as the derived
  relationship-evidence read (persisted social ledger stays Gate 5). 13 pure + 5 int
  cases; CI runs `test:engine-e4-2` (2 733 pure + 360 int green). Next: **E4.3**.
- **World-engine perception & observation (E4.1)** — [engine.plan.md](engine.plan.md)
  §"Gate 4 build order" · contract [engine.spec.md](engine.spec.md) §20 — 2026-07-18 —
  the first Gate 4 slice, started the day Gate 3 closed (verdict: advance; rulings 14 +
  exit scope resolved the same day): typed `Observation` rows (`sim_observations`,
  migration 0063) derived by one pure, exhaustive rule table — participants embodied,
  same-zone sight, cross-zone sound, captured noticeability sets trusted (private stays
  private), engagement events by channel, overhearable co-present speech, glimpse-only
  storyteller relocation, bookkeeping derives nothing. Every command transaction commits
  perception atomically with truth (shell hook + the two pre-shell stores); replay grades
  per command against the group-final space — live/rebuilt rows identical, wired into
  `forkBranch`. The interim witness rule is deleted (`compileGate3Cut` consumes
  `viewpointObservations`; corpus green unchanged) and the commitment knowledge gate's
  `observed` member fires only on real perception, failing closed. 9 pure + 4 int cases;
  CI runs `test:engine-e4-1` (2 718 pure + 355 int green). Next: **E4.2**.
- **World-engine live-scene arbiter + access & Gate 3 corpus (E3.4 slice 2 + E3.5)** —
  [engine.plan.md](engine.plan.md) §"Gate 3 build order" · contract
  [engine.spec.md](engine.spec.md) — 2026-07-18 — the deterministic §18.3 turn seam
  (`prepareEngagementTurn`: drain → pressure look-ahead → policy departures that interrupt
  the scene → one perspective-safe `Gate3NarrativeCut`; rerender re-reads the same cut,
  ruling 8) with `confirm_narrator_result` speech-act arming (ruling 9); layered access
  (`sim_access_grants` + `permits_trespass`, migration 0062): fail-closed grants,
  `attempt_entry` for the private last hop (granted/forced, witnessed, stated-rule
  refusals, cause-free denials), audited `storyteller_relocate_actor` (ruling 4); Gate 3
  scenario corpus green (`test:engine-e3-5`, 5 scenarios, zero model calls; 2 709 pure +
  351 int tests) — corpus caught + fixed the E3.3 `actBy` derivation bug and an id-length
  stacking bug. **Gate 3 closed with the owner's advance verdict, 2026-07-18.**
- **World-engine engagement substrate (E3.4 slice 1)** —
  [engine.plan.md](engine.plan.md) §"Gate 3 build order" · contract
  [engine.spec.md](engine.spec.md) — 2026-07-17 — conversations become world activities
  (§18.1–18.2, §11.3): `Engagement` rows (`sim_engagements`, migration 0061) with the §18.2
  state machine, claiming **full** attention for a co-present scene and **partial** for a
  remote channel through the same E3.2 claim arithmetic; one body, one physical scene
  enforced at open (co-located at-loci required; a second co-present open rejects); any
  channel requires presence of mind (a napping mind can't join even a text thread — the
  ruled no-wake default intact, since message delivery is not an engagement); conversations
  block body-claiming activities and vice versa; **a departure interrupts the mover's open
  co-present scene atomically with the journey events**; ending releases claims and moves
  no one; fork/replay parity. 7 pure + 4 integration cases; CI runs `test:engine-e3-4`.
  Remaining for E3.4 slice 2: the §18.3 arbiter, NarrativeCut, ArmedEffects (ruling 9),
  narrator-failure presentation (ruling 8).
- **World-engine commitments & temporal pressure (E3.3)** —
  [engine.plan.md](engine.plan.md) §"Gate 3 build order" · contract
  [engine.spec.md](engine.spec.md) — 2026-07-17 — the third Gate 3 slice, and the one that
  makes the spec's 4pm-shift arc real: commitments with the ruled per-commitment firmness
  dial and the §15.4 status machine (`sim_commitments`, migration 0060), the §15.2
  derivation captured at creation (latestDeparture = latest − route − preparation −
  buffer, route from the E3.1 planner), a notice trigger raising `TemporalPressure`
  (`sim_temporal_pressures`) with flexibility-derived severity — gated on the commitment's
  knowledge source (one live `authored` member; Gate 4 tightens it to real
  observations/beliefs without a schema change) — and a deadline trigger that
  deterministically **evaluates** the actor's actual locus (ruling 6): at the destination →
  kept, inbound on a journey there → late (arrival still lands afterwards), anywhere else →
  missed, with the evaluation basis captured on the event. The schedule never sets location
  (§3.1 inv. 5 — asserted in test). Fork/replay parity: pre-deadline forks re-arm both
  triggers and resolve independently. 11 pure + 7 integration cases (kept/late/missed arcs
  end-to-end); CI runs `test:engine-e3-3`. Gate 3 continues: E3.4 engagements are next.
- **World-engine typed actions, activities & claims (E3.2)** —
  [engine.plan.md](engine.plan.md) §"Gate 3 build order" · contract
  [engine.spec.md](engine.spec.md) — 2026-07-17 — the second Gate 3 slice: authored
  `SimulationActionDefinition`s (versioned; typed enforced preconditions; body/attention
  claims; interruptibility; obvious/private noticeability) seeded per branch
  (`sim_action_definitions`, migration 0059), `ActivityInstance` rows (`sim_activities`)
  driving the full §16.3 phase machine with claims **projected from activity state** (never
  separately stored, so no orphaned claim is possible), `start_activity` → started event +
  durable completion trigger atomically, fire-time re-validated `complete_activity` through
  the scheduler drain, `cancel_activity` releasing claims **and retiring the pending
  completion trigger in the same transaction**, claim law wired into movement (`MoveActor`
  gains `activity_conflict`; starting while in transit is refused), co-located witness
  capture on activity events, and fork/replay parity — mid-activity forks re-arm the
  completion, post-cancel forks recognize the retirement through a new replay retirement
  ledger. Also extracts the shared `runSimulationCommand` transaction shell (§11.1) that
  later commands build on. 13 pure + 6 integration cases; CI runs `test:engine-e3-2`.
  Gate 3 continues: E3.3 commitments are next.
- **World-engine authoritative space (E3.1)** — [engine.plan.md](engine.plan.md) §"Gate 3
  build order" · contract [engine.spec.md](engine.spec.md) — 2026-07-17 — the first Gate 3
  slice: branch-scoped topology (`sim_locations`/`sim_zones`/`sim_links`, migration 0058),
  one-locus-per-actor `sim_physical_loci` (the §3.1 invariant enforced as the primary key +
  shape checks), the deterministic `planRoute` kernel (duration-cost, lexicographic
  tie-breaks, a relax-one-constraint diagnosis cascade naming the binding restriction),
  `MoveActor` resolving to journey_planned + actor_departed + a durable arrival trigger in
  one atomic transaction, fire-time re-validated `arrive_journey` through the E2.4
  scheduler drain (the arrival event stamped at its due second — the E2.6 stale-template
  caveat answered), the scheduler contract widened to a trigger-kind union, and fork/replay
  parity — mid-journey forks re-arm the pending arrival, post-arrival forks record it
  completed, and the space projection rebuilds from zero to the live hash. 16 pure + 17
  contract + 8 integration cases; CI runs `test:engine-e3-1` from a zero-state migration.
  Gate 3 continues: E3.2 actions are next.
- **World-engine Gate 2 soak and verdict (E2.6)** —
  [engine-gate2-soak.plan.md](finished/engine/engine-gate2-soak.plan.md) · contract
  [engine.spec.md](engine.spec.md) — 2026-07-17 — **Gate 2 closed with the owner's
  advance ruling.** Deterministic synthetic-month harness (`runGate2Soak`): 21/21 proof
  checks at the full profile — partition-invariant material hashes stable across runs
  (`80421ced`), no duplicate outcomes under 79 injected transaction crashes + 66 stale
  + 54 duplicate submissions, idempotent outbox crash-resume, rebuilds matching live on
  every branch, queues bounded and drained, structured diagnostics throughout; direct
  submit p95 4.1 ms. CI runs the small profile as `test:engine-e2-6`; the full month is
  `pnpm eval:engine-gate2-soak`. One accepted caveat for Gate 3 design: schedule-time
  trigger templates go stale under live load (457/600 fire-time rejections) —
  re-validation belongs at fire time, as the kernel already does. Next engine target:
  **Gate 3** (blocked on 10 owner rulings).
- **World-engine forks, snapshots, and audit (E2.5)** —
  [engine-forks-snapshots-audit.plan.md](finished/engine/engine-forks-snapshots-audit.plan.md) · contract
  [engine.spec.md](engine.spec.md) — 2026-07-17 — branch ancestry with the R4
  reference-not-copy bounded read, `forkBranch` rebuilding child state and pending alarms by
  replaying setting events ≤ N (already-fired alarms recorded completed, never re-armed),
  trigger creation moved behind a committed `trigger_scheduled` event, checksummed
  discardable `sim_snapshots` (auto-captured at fork), rebuild-from-zero/from-snapshot hash
  comparison, `explainItemPlacement` causal chains, and the E2.3 outbox claim-time
  quarantine fix. 10 new PostgreSQL cases + 7 pure replay cases green; CI runs
  `test:engine-e2-5` from a zero-state migration. Next engine target: **E2.6**.
- **World-engine durable scheduler and deterministic draws (E2.4)** —
  [engine-durable-scheduler.plan.md](finished/engine/engine-durable-scheduler.plan.md) · contract
  [engine.spec.md](engine.spec.md) — 2026-07-17 — durable triggers with derived identity,
  branch-unique scheduling, claim-time attempts, fenced leases, quarantine of exhausted
  work, and a bounded `advanceBranchStoryTime` drain seam with `catch_up_required`. Fixed
  four defects in the first attempt: an orphaned migration (the table was never created on
  a real database), a backoff cap the exponent clamp made unreachable, permanent trigger
  poisoning from an optimistic version pre-read under a permanent idempotency key, and
  cross-branch command dispatch. Draw integration deliberately defers to Gate 3; analytical
  rate integration to Gate 5 bodies. 13 PostgreSQL cases green from a zero-state migration.
- **World-engine outbox and rebuildable consumers (E2.3)** —
  [engine-outbox-rebuildable-consumers.plan.md](finished/engine/engine-outbox-rebuildable-consumers.plan.md)
  · contract [engine.spec.md](engine.spec.md) — 2026-07-16 — atomic outbox publication in
  the command transaction, lease- and sequence-safe consumption, idempotent checkpoints, a
  disposable item-transfer feed, retry diagnostics, terminal quarantine, and
  rebuild-from-zero hashing.
- **World-engine durable branch transaction (E2.2)** —
  [engine-durable-branch-transaction.plan.md](finished/engine/engine-durable-branch-transaction.plan.md) ·
  contract [engine.spec.md](engine.spec.md) — 2026-07-16 — the minimum PostgreSQL authority
  catalog and one atomic `transfer_item` path: branch row serialization, durable idempotent
  results, immutable events, typed exclusive item holdings, and injected crash proofs.
- **World-engine identity and causal envelopes (E2.1)** —
  [engine-identity-envelopes.plan.md](finished/engine/engine-identity-envelopes.plan.md) · contract
  [engine.spec.md](engine.spec.md) — 2026-07-16 — reusable branded identities, safe causal
  integers, the complete principal taxonomy, strict command/event factories, deterministic
  reference sets, and exhaustive accepted/rejected/conflict results now replace the
  Gate 1-local causal shapes. Item transfer migrated without changing its authority,
  replay, viewpoint, or NarrativeCut behavior; event identity includes branch identity;
  repository CI passed 2,518 tests and the deterministic path held a 0.400 ms p95 with
  zero model calls.
- **World-engine Gate 1 — item-transfer authority seam** —
  [engine-gate1-item-transfer.plan.md](finished/engine/engine-gate1-item-transfer.plan.md) · contract
  [engine.spec.md](engine.spec.md) — 2026-07-16 — one authorized item transfer now proves
  command → immutable event → synchronous projection → observer-filtered NarrativeCut →
  existing narrator, with optimistic versioning, idempotency, deterministic replay,
  state-free rerender, duplicate-command defense, zero model calls, and a 0.233 ms CI p95.
- **Persona library — the player as a first-class library entity** —
  [persona-library.plan.md](persona-library.plan.md) — 2026-07-16 — the player graduates
  from a single inline blob to a real library entity you pick per chat: `personas`
  (migration 0051, `(owner_id, title)` UNIQUE so `name` can repeat), a narrow
  `PersonaProfile` + the one `personaToCharacterProfile` adapter that buys the wardrobe
  seam, attribute picker, outfit editor and exposure classifier unforked, CRUD, the
  `/personas` tab + editor, the three-rung `resolveChatPersona` ladder (0052 backfills
  the blob into a real row, 0053 drops it), the "Playing as" pick, and a **player
  wardrobe the fiction can undress** — `playerOutfit` on the shared continuity leg folds
  through the existing `applyWornGarmentChanges` against the persona's pool, rides the
  "another take" rollback, and is structured-only so exposure is always coverage-computed.
  Title is barred from prompts *structurally* — it isn't a field on the resolver's shape.
  **Unblocks** [scene-pov-embodiment.plan.md](scene-pov-embodiment.plan.md) slices 2–4.
- **Scene POV embodiment — the player's own body in frame** —
  [scene-pov-embodiment.plan.md](scene-pov-embodiment.plan.md) — 2026-07-16 — chat-lane
  scene images stop pretending the player has no body: their hands/arms/lap/legs enter frame
  when the narration puts them there, and their genitals only when the shot already looks
  down their own body **and** coverage reads bare **and** the route is uncensored — three
  conditions, two of them code rather than judgment (`exposedRegions(playerWorn).pelvis`
  makes the part structurally unavailable; the composer has no intimate vocabulary at all).
  Third-person leakage is fought with a **positive person-count assertion + frame geometry**,
  never negatives, which anchor on exactly what they forbid (the "no camera" scar). Viewer
  parts are a closed registry — the phrasing *is* the feature. Also slice 0, the standalone
  **blush scrub**: "flushed" rendered as stage blusher, and `visualStateNote` said it in 3
  of 5 phrases; the narrator's arousal hint echoes it through the composer, so a rule **and**
  `scrubBlush` close it. Session lane untouched and byte-identical, pinned by test.
  **Unverified against a live model** — the eval sweep + third-person-contamination metric
  (plan §Testing) is the next step.
- **Chat off-screen life — the cast moves between visits** —
  [chat-offscreen-life.plan.md](chat-offscreen-life.plan.md) · spec
  [chat-offscreen-life.spec.md](chat-offscreen-life.spec.md) — 2026-07-15 — the chat lane's
  "world tick", D3-safe: a qualifying skip (cumulative ≥1 story day) fires ONE detached
  `chat_meanwhile` pass over the fenced ensemble dossier; ≤3 grounded developments fold
  into facts (routed to each involved member's OWN memory group — members know different
  things), drive notches, cast accretion, NPC↔NPC plan outcomes (replacing ruling E's
  assume-kept), away **whereabouts** (+ presence-read `where`, one-turn return license),
  and a one-shot meanwhile note beside the skip note. Grounded improvisation everywhere
  else: skip-note grounding, opener cast material + dedupe rule F, rhythm in ordinary
  turns. Migration 0050. *Returning after "two weeks" finally feels like two weeks.*
- **Chat clock & calendar — story time the player can see** —
  [chat-clock-calendar.plan.md](chat-clock-calendar.plan.md) — 2026-07-15 — the chat clock
  anchored to a real Date-backed calendar (`calendar_start`, migration 0049; default Jan 1
  8:00am, editable from the clock card); a **desktop right aside** with the Story-time card +
  skip chips whose tooltips and toast name the landing ("→ Friday evening"); ONE authoritative
  time — the binding Story-time tail line replaces the removed archivist `timeOfDay`; real
  weekdays in plan labels (render-derived, anchor-rebasable) and schedules; tick 4 → 1
  min/exchange with meter pacing preserved (`CHAT_METER_DRIFT_MINUTES`). *Skips stop being a
  leap in the dark — the off-screen-life prerequisite.*
- **Chat plans & promises — commitments that come due** —
  [chat-plans-promises.plan.md](chat-plans-promises.plan.md) · spec
  [chat-plans-promises.spec.md](chat-plans-promises.spec.md) — 2026-07-15 — all four slices:
  commitments the fiction strikes become tracked scenario state (`contracts/turns/chat-plans.ts`,
  `plans` column — migration 0048) that comes DUE on the story clock — archivist-recognized
  via a `plans` field on the character-tracker leg, resolved to an absolute target from a
  coarse day-offset + day-part, advanced **deterministically** (overdue player plan → missed,
  NPC↔NPC → assume-kept), surfaced only when imminent/happening/just-missed in a compact
  volatile-tail **Plans** block. Consequences land through existing machinery: the pulse's
  `commitmentsDue` (model-mediated hurt, no deterministic penalty), new callback-boosted
  `plan_kept`/`plan_missed` milestones, the hub marker + reopen-opener plan material, and the
  ensemble **arrival/exit license** (the presence law's one principled don't-teleport
  exception). Author surface: the **Plans** card + lightbox editor (`ChatStateEdit.plans`).
  Rulings A–F in the spec. The chat descendant of the retired scheduled-arrivals spec —
  *time skips finally have teeth*. Leftover: NPC↔NPC fact-filing rides
  [chat-offscreen-life.plan.md](chat-offscreen-life.plan.md)'s meanwhile pass.
- **Agent health — failed legs are visible instead of silent** —
  [chat-agent-improvements.plan.md](chat-agent-improvements.plan.md) §Agent health —
  2026-07-14 — the counter-measure to best-effort agents: a failed leg (timeout /
  provider error / bad output) now leaves a durable `events` record with a **suspected
  cause** (a provider class passes through; a JSON that stopped mid-object diagnoses an
  output cap that's too low; a timeout blames the prompt only when the prompt is big),
  tallied in the chat inspector's new **Agent health** panel — per-chat and across all
  chats. No migration (the `events` table is exactly this). Also fixes `generateChecked`
  mislabeling every transport failure (429/402/network) as `.parse_failed` — a recorded
  follow-up from [chat-reply-failures.plan.md](chat-reply-failures.plan.md). Prompted by
  finding that the pre-split archivist had been timing out in production for days,
  visible only in `fly logs`.
- **Chat agent improvements — the extraction field library + three parallel legs** —
  [chat-agent-improvements.plan.md](chat-agent-improvements.plan.md) — 2026-07-14 — all
  five slices: extraction fields became **data** (`prompts/chat-extractors.ts` — one module
  per field owning its instruction/context/rules/example; a leg is an ordered key list and
  its whole sheet is assembled), the 13-field archivist split into **memory scribe ‖
  continuity tracker ‖ character tracker** running in parallel in the same post-flush slot
  (no perceived latency; per-leg degradation so one failed leg costs only its own fields;
  the personal pass recomposed from the same modules, killing the copy-paste), the ensemble
  settle loop parallelized, **one query-embed per turn** shared by every retrieval leg +
  the callback picker (both lanes — the only pre-reply saving), the volatile tail's dozen
  one-turn notes gathered into a tiered **"Right now" digest** (binding → gate → license →
  flavor; crowded-turn deferral kept **pre-burn** in `chatCallbackEligible`, since an
  offered callback burns its ring), and the duplicate rule 8 folded into the Shaping block
  (rules renumbered 9–17 → 8–16). Unmeasured: the split's quality premise rides the
  owner-gated eval spend.
- **Attribute narrator guidance — audit + broader glosses (slices 3–4, plan complete)** —
  [attribute-narrator-guidance.plan.md](attribute-narrator-guidance.plan.md) — 2026-07-14 —
  the entangled-vocabulary audit found no new renames (prior sessions had already
  dissolved `build.frame` / `vulva.labia` / `feet.smell`; per-limb `legs`/`arms`
  build words are in-dimension and stay), so the slice's deliverable is the
  idempotent stored-value sweep `scripts/sweep-renamed-attribute-values.ts`
  (+ pure tests) mapping every already-renamed value across all seven
  attribute-value storage sites, and the broader gloss authoring pass (build,
  weight/musculature, voice, movement, skin). Data-only, **no migration**.
  Leftovers (both non-code, in the plan): the glosses **await owner review/trim**
  and the sweep **awaits a run against each live DB** (local + Fly SSH).
- **Intimacy notes** — [intimacy-notes.plan.md](intimacy-notes.plan.md) · spec
  [intimacy-notes.spec.md](intimacy-notes.spec.md) — 2026-07-14 — the third species/heritage
  note (`intimacy`, bare text) + a per-character `profile.intimacy`, merged (heritage-replaces,
  character-appends) and surfaced to the session narrator via `buildIntimateDispositionBlock`
  **only when the turn's exposure mask reaches the intimate tier on any axis**. Full trip: schema
  (no migration), `speciesIntimacyNote` resolver, gate wired into `buildTurnContext`, forge/editor/
  fill/redraft, authored notes for succubus·faerie·sprite·elf·dark_elf·orc. **Session-lane only** —
  the chat test bed has no four-axis mask yet, so a chat port is the noted follow-up (see plan
  §Completion).
- **Chat wardrobe parity** — [chat-wardrobe-parity.plan.md](chat-wardrobe-parity.plan.md) —
  2026-07-14 — the chat lane's one free-text `outfit` string + manual `outfit_exposed` toggle
  became structured worn state to session parity, all three rungs: chat state holds `wornItemIds`
  (seeded from the active preset) + `outfitPresetId`, with the free-text `outfit` repurposed as an
  overlay/legacy fallback (migration 0047). The narrator + scene image render the actual garments
  (reusing `wardrobeOutfitText`), exposure is COMPUTED from coverage via the session classifier
  (`exposedRegions`, the manual toggle superseded), the archivist proposes whole-outfit preset
  swaps AND garment-level add/remove (`applyWornGarmentChanges`, rollback-safe), and the chat
  Character sheet gains a per-slot equip/remove editor reusing the outfit-editor primitives. New
  `chat_look` key shape (worn ids + overlay + coverage fingerprint). First step of the
  **chat-as-test-bed direction** (`CLAUDE.md`).
- **Chat action beats** — [chat-action-beats.plan.md](chat-action-beats.plan.md) —
  2026-07-14 — the four status-strip chips stop being silent state pokes: a tap is now
  a narrated `action_beat` exchange (no player line, a register-aware server-built cue,
  the deterministic effect applied pre-narration so the reply reflects it — rollback-safe
  via the pre-exchange snapshot, the chip id on `meta.actionBeat` so "another take"
  reproduces it exactly once). Removed the dead POST `…/state {action}` endpoint; chips
  gained tooltip copy. Rulings: chip set fixed at four for v1, the beat targets the primary.
- **Character fidelity — anti-drift & field-impact remainder (slices 3–10)** —
  [character-fidelity.plan.md](character-fidelity.plan.md) — 2026-07-14 — the
  disposition/voice/evolution batch: regard-coloring cap (the high-regard
  homogenizer), preferences-to-narrator, inert-slider wiring
  (extraversion/dominance/confidence), per-character micro-exemplars, structured
  **voiceAnchors** (prefix block + tail re-anchor), the **voice-exemplar ring**
  past the summary horizon, the chat-lane **consistency check** (`characterSlip`
  → one-turn corrective tail), and **bounded personality evolution** (persisted
  `trait_overlays`, milestone-gated, clamped one band from authored, `developable`
  warmth/confidence/guardedness). Migration `0046`. Leftovers: the slice-4
  reaction-verdict line + slices 4/6 ensemble parity (both deferred, in-plan);
  slice 9's measurement is the owner-gated enactment eval.
- **Character fidelity — life-stage registry + minor fence (slices 1–2)** —
  [character-fidelity.plan.md](character-fidelity.plan.md) — 2026-07-13 —
  numeric age finally shapes prose: `contracts/world/life-stage.ts` bands
  (hint on the chat identity / ensemble id / session canonical-facts lines),
  binding child/teen/elder register rules (chat block + third-person ensemble
  line, rule 7 bound by heading), the minor fence (intimate disposition ×
  both lanes, disinhibition, intimate-craft rules, selfie license, escalation
  bullet via `composeRelationshipLaw` `omitEscalation`), and the scoped
  `CONTENT_FRAMING` (adult assertion attaches to intimate-content
  participants; minor-primary and minor-in-cast variants). Slices 3–10 shipped
  2026-07-14 (see the entry above).
- **Attribute narrator guidance — core + sensory glosses** —
  [attribute-narrator-guidance.plan.md](attribute-narrator-guidance.plan.md) —
  2026-07-13 — per-value `narratorGuidance` glosses shipped end-to-end (schema
  - invariants, both lanes' `attributePhrase` renderers, `describeConstraint`
  - picker tooltips) with the sensory palettes as the first authored batch
    (`feet.smell` + shared intimate scent/taste maps), alongside sensory-focus
    block fixes ([sensory-grounding.followups.md](sensory-grounding.followups.md):
    authored region scent is the current truth — no "clean skin" default beneath
    it, hygiene deepens instead of competing, the taste clause's hardcoded
    "salt" removed, character-preserving directive). Fixes "cheesy feet narrated
    as clean/salty". Remainder (vocabulary audit + sweep, broader authoring
    pass) stays in Next.
- **Chat reply-failure surfacing** —
  [chat-reply-failures.plan.md](chat-reply-failures.plan.md) — 2026-07-13 —
  the "didn't reply" popup names the real cause instead of guessing "usually a
  timeout": a closed failure vocabulary
  (`contracts/turns/chat-reply-failure.ts`), `classifyProviderError` reading
  OpenRouter status + body, a `character_chats.last_reply_failure` record read
  back by the post-exchange refetch, cause-specific toast copy, and the
  first-token watchdog dropped to 50s to beat Fly's ~60s proxy idle kill.
  Follow-ups (session-lane parity, `generateChecked` mislabeling, durable chat
  diagnostics) listed in the plan.
- **Chat supporting cast + narrator input** —
  [chat-supporting-cast.plan.md](chat-supporting-cast.plan.md) — 2026-07-13 —
  recurring named side characters as a lightweight scenario tier (scene-memory
  pattern applied to people: `supporting_cast` on the chat scenario, archivist
  field 10 with roster/player exclusion, the volatile-tail cast block + rule
  3/16 carve-outs, the Supporting Cast panel + lightbox editor), plus the
  composer **You ↔ Narrator** toggle (`inputMode: "narrator"` — story
  narration that never reads as the player's POV; pulse skipped,
  storyteller-labeled extraction). Deferred: cast images, promote-to-character.
- **UX improvements — chat, item library, character form** —
  [ux-improvements.plan.md](ux-improvements.plan.md) — 2026-07-13 — all nine
  slices in one day: clone wiring + stale-copy fix, chat transcript keyset
  pagination + jump-to-latest, the status-strip outfit chip + roster outfit
  lines, admin-gated sheet debug traces, the item ✦ draft-from-description
  assist (registry-grounded, carve-outs included), item delete in-use warnings
  - read-only public items/locations, the editor **autosave** refactor
    (create-on-new placeholders, save-on-change/blur, forge-draft review
    preserved; world editor exempt — its save forges) + attribute-accordion
    value summaries, **named outfit presets** replacing `defaultOutfit` (lazy
    lift, preset switcher, archivist preset matching, rhythm auto-dress on time
    skips), and the polish batch. Spawned: chat-action-beats +
    chat-wardrobe-parity (both shipped 2026-07-14).
- **Sensory grounding** — [sensory-grounding.plan.md](sensory-grounding.plan.md) —
  2026-07-12 — the chat Sensory-focus block now joins the player's targeted body
  region to that region's own authored attributes (sense-ranked — "I lick her foot"
  finally surfaces `feet.smell`), directs the narrator to OPEN the reply with the
  sensation itself, forbids verbatim value echoes, degrades an ungrounded focus to
  the close-range allowance, and sense-gates `.scent`/`.smell`/`.taste` id suffixes
  in the session lane whatever their category.
- **Forge gaps** — [forge-gaps.plan.md](forge-gaps.plan.md) — 2026-07-12 — the forge now
  drafts the starting relationship + personal social cards from the concept; a
  `renderVisual` attribute tier keeps scene renders consistent; secret reveal gates
  ceiling mid-arc; drive caps truncate (with editor counters) instead of clipping
  silently; the narrator stripper cuts trailing "Note for the parser" blocks.
- **Story-thread lifecycle guards** — no plan (two small fixes from the 2026-07-08
  docs-accuracy audit) — 2026-07-12 — the thread reducer now gates `resolve` to
  `investigation` kind (`merge.thread.resolve_blocked` diagnostic; ruled: the admin
  manual-close route archives ongoing threads instead) and touch/develop/propose
  only match live (open/cooling) threads by id or title, so a closed thread can
  never be revived (a same-title propose opens a fresh thread). See
  [../story-threads.md](../story-threads.md).
- **Chat initiative — the remainder slices (plan complete)** —
  [chat-initiative.plan.md](chat-initiative.plan.md) — 2026-07-12 — the §8.4 v2
  marker (unseen-milestone seen-cursor `milestones_seen_at`, migration 0043 —
  ruled: loops + milestones only, never real time), light `profile.schedule`
  authoring (day-part vocabulary, the Profile tab's Daily-rhythm card, the
  forge section, the opener's rhythm line), and the opener selfie (the
  "thinking of you" photo — register-conditional license + the opener-scoped
  pulse's `sentPhoto` read).
- **Character drives — the authoring surface (plan complete)** —
  [character-drives.plan.md](character-drives.plan.md) — 2026-07-12 — the forge
  profile leg drafts drives (concept-led ≤1 secret, band-validated reveal gates
  — rulings), the Disposition tab's "Desires & secrets" card, Forge-the-rest
  additive fill up to the 3-cap + Disposition re-draft coverage, and the
  `chat-secret-hold`/`-reveal` fixtures (`secretCue` metric; live judged run
  rides the owner-gated enactment measurement run —
  [deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs).
- **Foot coverage sub-parts** — registry data edit (no plan; direct owner request) —
  2026-07-12 — `feet` splits into `toes` · `top of foot` · `sole` · `heel` so
  footwear can carve holes (peep-toe, strapped sandal, flip-flop). Footwear's
  `["feet"]` template still auto-covers the whole foot via expand; the exposure
  classifier (`items/visibility.ts`) now reads any covered foot part as shod, so
  a sandal isn't mislabelled "barefoot". See `docs/contracts/body.md` +
  `items.md` §Coverage editing.
- **Multi-character & forge wrap-up — the owner-rulings pass (all 13 rulings)** —
  [multi-character-chat.followups.md](finished/multi-character-chat.followups.md) — 2026-07-12 —
  forge re-draft = full tab re-sync + the portrait review dialog; preset
  relationship records, the matrix player column, third-person pair law; the
  chat-wide/per-character schema split (scenario on the chat row — migrations
  0041/0042), per-member note-takers + deterministic folds, group-scene
  selfies/callbacks/sensory-focus/enactment, per-character sheets +
  `?characterId=` state targeting.
- **Multi-character chat — the substrate (all four slices)** —
  [multi-character-chat.plan.md](finished/multi-character-chat.plan.md) — 2026-07-12 —
  a conversation holds up to 4 full characters: roster routes + panel,
  per-character state with presence + activity recency (migration 0037), the
  one-block ensemble prompt frame (roster-of-1 byte-identical, asserted),
  player-owns-himself authority + cutaways, away-freeze, referenced-only pulse,
  tier-1 per-member memory legs, witness memory writes, archivist presence
  confirmation. Substrate simplifications recorded in the plan.
- **Relationship model v2 — familiarity × regard (complete; slice 6 matrix)** —
  [relationship-model.plan.md](finished/relationship-model.plan.md) — 2026-07-12 —
  the matrix: `character_chat_relationships` + library-default
  `character_relationships` (migration 0038), creation/join seeding, the
  in-chat pair editor (shared-cell, mirrored stances, asymmetric toggle), the
  character editor's Relationships tab, presence × salience tier injection
  with the don't-teleport guard. Slices 1–4 shipped 2026-07-07. Leftovers
  (preset band pickers, third-person pair-law port, multi-char eval fixtures)
  - the slice-7 sessions earmark are recorded in the plan.
- **Library UX — the follow-up pass** —
  [library-ux.plan.md](finished/library-ux.plan.md) — 2026-07-12 — facets for the other
  libraries (characters species/gender/world-usage, locations scale/world-usage,
  social-card tier/trigger), the tabbed Gallery image hub (scenes/portraits/
  entity art, view modes, avatar chip filters, favorites migration 0036,
  multi-select delete, keyset paging past the 500 cap), the Library nav hub
  (Chats · Worlds · Library · Gallery + shared collection tab strip), and the
  scope+sort fast-follow (every shareable list API honors `?scope`/`?sort` —
  both were silent no-ops). Leftover: list keyset pagination waits for real
  catalog scale (recorded in the plan). Core pass shipped 2026-07-08.
- **Character sheet forge — in-sheet completion, per-tab re-drafts,
  portrait-derived attributes** —
  [character-sheet-forge.plan.md](finished/character-sheet-forge.plan.md) —
  2026-07-12 — the editor's ✦ Forge-the-rest fills every empty field without
  touching player-authored content (save-first, result lands unsaved for
  review); per-tab ↻ Re-draft rewrites one tab narrator-formatted from the
  whole sheet (`manual` values kept, conflicts reported); ◉ From-portrait
  derives appearance attributes from the avatar via the codebase's first
  vision capability. Built + deployed 2026-07-09; owner live review passed
  2026-07-12. Leftovers: the two report-only conflict flips stay in the plan's
  §Open questions, flip on request.
- **Chat initiative — the reopen opener (core)** —
  [chat-initiative.plan.md](chat-initiative.plan.md) — 2026-07-12 — the pickup
  strip's "Let {who} start ✦" runs a continue exchange with a server-built cue
  (`chat-initiative.ts`): her own material (loops + non-secret wants), the "a
  life meanwhile" license folded in (no separate life-event agent — build
  decision, D8-safe), the comms-when-apart register, one-beat restraint. D3
  held: player-tapped only, marker stays loops-keyed. Remainder shipped later
  the same day — see the entry above.

- **Character drives — engine core (desires & secrets as gated inner life)** —
  [character-drives.plan.md](character-drives.plan.md) — 2026-07-11 — ≤3
  authored wants (`profile.drives` + runtime state, migration 0035) rendered
  as tail LAW: open steers, guarded withholds-until-asked, a secret below its
  gate (default familiarity ≥ familiar, ruled) is protected with the ruled
  full-but-scoped lie license and flips to an invited reveal at the gate;
  archivist `driveUpdates` (8th field) tracks progress/reveal/resolve, a
  reveal lands the new `secret_shared` milestone (❖, callback-boosted), and
  the panel lists open wants + revealed secrets only (ruled). The remainder
  (authoring surface + eval fixtures) shipped 2026-07-12 — see the entry above.
- **Chat scene references — current-look and place anchors** —
  [chat-scene-references.plan.md](finished/chat-scene-references.plan.md) — 2026-07-11 —
  chat renders anchor on an outfit-true `chat_look` (identity-locked edit,
  keyed by outfit+exposed+overlays, keep-latest, minted on archivist changes in
  image-active chats — rulings) instead of the always-dressed avatar; scene-
  memory places get lazily-minted `chat_place` establishing shots, and chat
  scenes go multi-reference (look + place) through the previously-unused
  multi-edit rung. Cache = the images table (`meta.lookKey`); no migrations.
  Docs: character-chat.md §Scene reference anchors, images.md.
- **Social-card tag-override editor + character editor re-tab** — no plan
  (owner one-off, 2026-07-11) — full override rows on `SocialCardFields`
  (free-form tag with canonical datalist, kind, optional intensity, hint) with
  `normalizeTag`-insensitive matching in `resolveCardForTags`; likes/dislikes
  (new `PreferencesEditor`) + the social-cards editor moved Disposition →
  Personality tab for room (the `disposition` re-draft scope still owns
  preferences — noted in `lib/character-scopes.ts`). Docs: authoring.md,
  guide/social-cards.md.
- **Chat selfies — character-sent photo messages** —
  [chat-selfies.plan.md](finished/chat-selfies.plan.md) — 2026-07-11 — the character
  sends photos back: `SELFIE_FRAMING` (the player-POV rule inverted), always
  the identity-locked reference route (ruled), player-request regex +
  apart-only unprompted offers (ruled — comms register = the texting signal;
  `selfie_history` cooldown ring, migration 0034), queue decided post-turn by
  the pulse's `sentPhoto` read so declines stay declines, and the ruled
  retry-once policy (content rejection retries sanitized; second failure = a
  "Failed" transcript placeholder enlarging to the sent prompt). Docs:
  character-chat.md §Selfies, images.md, prompts.md.
- **Chat image input — player-sent photos the character sees** —
  [chat-image-input.plan.md](finished/chat-image-input.plan.md) — 2026-07-11 — up to 4
  photos per message (owner ruling: multi-image now): composer attach + canvas
  downscale → `chat_upload` assets (input-only, Gallery-hidden, hard-deleted
  with message/chat), ONE batched vision read persisted on message meta
  (regenerate never re-spends; degraded reads retry), a fenced seen-channel
  tail block + static rule 17 (owner ruling), pulse/archivist see the reads,
  photo-only sends allowed. No migration. Docs: character-chat.md §Player
  photos, images.md, prompts.md.
- **Emotional weather — persistent feeling, regard momentum, reply pacing** —
  [emotional-weather.plan.md](finished/emotional-weather.plan.md) — 2026-07-11 — a
  pulse-proposed persistent `feeling` (curve-derived intensity, exchange-decayed,
  composed with the meter mood line — owner rulings: compose; ~10-exchange bruise;
  new `apologize` concept halves it; damped ±10% curve feedback), warmth-streak +
  bruise momentum on regard (`chat-feeling.ts`, migration 0033, trace `regardScale`),
  and the UI reveal-hold pacing (`lib/chat-pacing.ts`). Leftover: the live judged
  `mt-chat-feeling-hurt` run (owner-gated spend). Docs: character-chat.md
  §Emotional weather, prompts.md.
- **Memory callbacks — unprompted "remember when" beats** —
  [memory-callbacks.plan.md](finished/memory-callbacks.plan.md) — 2026-07-11 — a
  lull-gated, once-per-~10-exchanges tail cue offering one old, milestone-boosted,
  topic-distant episode, worded by regard band (warm nostalgia / plain / pointed —
  owner ruling); `callback_history` anti-repeat ring (migration 0032), degrades to
  a plain turn with `chat_memory.callback.failed`. Leftover: the live judged eval
  run (owner-gated spend). Docs: character-chat.md §Memory callbacks, prompts.md.
- **Chat scene-model picker — hot-swap dropdown on the scene strip** —
  `contracts chatSceneModels` + `character_chat_state.scene_model` (migration 0031)
  (no plan — owner request) — 2026-07-11 — a save-on-select dropdown left of
  Generate scene, persisted per conversation: "Avatar reference" keeps the
  identity-locked Qwen edit; picking a Venice t2i model (Chroma/Lustify/…)
  renders that scene text-to-image without the avatar (the only real model swap
  Venice offers — its edit family is Qwen-only). Docs: images.md §Scene images,
  character-chat.md §API, ui.md §Scene images.
- **Chat starting-outfit seed — garment phrase, not item ids** —
  `engine/chat-state.ts` + `images/avatar.ts`
  ([chat-scene-fidelity.plan.md](finished/chat-scene-fidelity.plan.md) §Seed fallback followup;
  owner report) — 2026-07-11 — the blank-Starting-Outfit fallback joined
  `profile.defaultOutfit` raw item ids into the scenario text, so the narrator ignored
  the outfit and the modal showed ids. The pure seed now writes the id-join as a marker
  and every IO-capable consumer resolves it to the readable phrase
  (`resolveSeededOutfit` → `defaultOutfitPhrase`: occlusion-filtered, subtype-led,
  description + sensory appearance); pre-fix stored rows self-heal on load, failed
  lookups degrade to composer inference.
- **Chat dialogue attribution — side-NPC quotes no longer wear the character's chip** —
  `lib/segmenter.ts` + chat rule 3 (no plan — small fix, owner report + screenshot) —
  2026-07-11 — a reply that uses a `[Name]` tag anywhere is tag-disciplined: its
  untagged whole-line quotes stay narrator prose (a side NPC's own quoted paragraph,
  the Amanda case) instead of auto-attributing to the sole character; tag-free replies
  keep the one-on-one auto-attribution. Prompt rule 3 now requires tagging every
  character line once any line is tagged, and in-prose attribution (never a bare
  quoted paragraph) for anyone else. Render-time only — stored transcripts re-render
  correctly. Docs: prompts.md §Dialogue tagging, character-chat.md §9.
- **Face jewelry, accessory subtypes & the attribute-form accordion** —
  [face-jewelry-and-attribute-form.plan.md](finished/face-jewelry-and-attribute-form.plan.md)
  — 2026-07-11 — lips/nose body locations; jewelry/headwear/eyewear subtype
  vocabularies (prompt-bearing, coverage templates) in the item form, classify
  pass and image/narrator prompts; nose + lip piercing attributes; registry
  defaults stored at blank creation; the attributes tab's single-open
  show-all-fields accordion.
- **Narrator tandem-repeat collapse** — `src/server/ai/narrator-repeats.ts` (no plan —
  small fix, owner report) — 2026-07-11 — Aion 3.0 sometimes re-emits its whole reply
  (or its trailing paragraphs) verbatim after a blank-line gap; both narrator lanes now
  compose `collapseRepeatedBlocksStream` after the wrapper-tag stripper, so the duplicate
  never reaches the live feed, the persisted row, or the history context. Deliberately
  narrow: paragraph-aligned, whitespace-insensitive verbatim suffix repeats only —
  paraphrased near-repeats and short stylistic echoes pass through.
- **Chat scene fidelity — outfit tracking, location sketches, identity anchors** —
  [chat-scene-fidelity.plan.md](finished/chat-scene-fidelity.plan.md) — 2026-07-10 — the
  archivist's 7th field tracks outfit changes into chat state (seeded from the character
  form when Starting Outfit is blank); scene memory + a background `chat_scene_sketch`
  agent replace the image's placeholder room; whitelisted identity anchors reinforce the
  reference-avatar lock.
- **Narrator prompt consolidation — external-review response, all six slices** —
  [narrator-prompt-consolidation.plan.md](finished/narrator-prompt-consolidation.plan.md) —
  2026-07-10 — the accepted points of the external GPT prompt review, implemented
  with rollback comments at every replaced line: per-shape chat length story
  (`chatLengthStory` — kills the aggressive_concise vs three-paragraph-baseline
  contradiction), NPC initiative licensed-not-mandated + trait/age quota softened
  (both lanes; validation rides the owner-gated enactment measurement run —
  [deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs),
  scene-consistent incidental people, the deterministic per-turn **chat sensory
  allowance** (`deriveChatSensoryAllowance` + one binding tail line; rules 11–12 and
  the cue-invite sensory arms collapsed into it), the intake `react_emotionally` →
  `acknowledge_emotional_beat` rename, the experimental `CHAT_PROMPT_LAYOUT=
turn_context` layout (default OFF pending eval A/B), and multi-turn `mt-chat-*`
  transcript eval scenarios with longitudinal metrics (q-end%, repeat 5-gram%,
  sensory-turn%, paragraph inflation). Declined with reasons: mature-content
  reframe, POV rewrite, reflex-license removal.
- **Chat rerun data-loss fix** — no plan doc (incident fix; forensics in
  conversation) — 2026-07-09 — Rerun clicked while a reply streamed deleted the
  prompt server-side then 409'd off the exchange lock (the flow predated the
  2026-07-02 lock and was never reconciled): rerun is now an atomic server-side
  exchange kind — stop the in-flight reply first, bounded-wait lock acquire
  (new `acquireKeyedLockWithin`), then one transaction that snips only
  successors (SQL-ordered, no ms-truncation) and reuses the prompt row as the
  guard; a 409 leaves the transcript byte-identical, and the client no longer
  issues deletes (optimistic snip restores on failure). Chat streams gained
  first-token (60s) + overall (300s) watchdogs so a hung model can't hold the
  chat lock, and the provisional Aion 3.0 reasoning knob was reverted pending
  verification. Six new int cases incl. transcript-untouched-on-409 +
  rollback-degradation diagnostics.
- **Chat reply discipline + scene memory** — no plan doc (built direct on owner
  instruction) — 2026-07-09 — the 1-on-1 chat turn grammar: a "Shaping each
  reply" prefix block (resolve-then-one-move with a worked example pair,
  ~three-paragraph baseline exceeded only for new scenes / major events,
  freshness rule — never re-describe unchanged setting/outfit/scent) + sparse
  intimate dialogue with the check-in refrain banned; an accumulating **chat
  scene memory** (`scene_memory` jsonb on `character_chat_state`, migration
  `0030` — capped places/details/connections, deterministic pre-turn movement
  switch + archivist `scene` proposals merged oldest-out, injected as a Scene
  tail block with establish-once / don't-recap directives, rollback-safe via
  `pre_exchange_state`); the deterministic **response-shape + mood-pin** tail
  line; **hook-cadence + check-in gates** over the last replies (span-parser
  question detection); **sense-targeted Sensory focus** blocks
  (smell/taste/touch/study × body region → scent baseline + hygiene band +
  outfit + conditions, bounded-imagination clause, intimate targets gated); and
  Aion 3.0's missing `NARRATOR_REASONING` knob (`effort: low`, provisional).
  Docs: `prompts.md`, `character-chat.md`, `testing.md`.
- **Dialogue attribution — render-owned speaker presentation** — no plan doc
  (built direct on owner instruction) — 2026-07-09 — the `[Name]` tag demoted
  from presentation to one attribution input: the session segmenter moved to
  pure `lib/segmenter.ts` (one parser for sessions, chat, and the eval
  harness) with an opt-in standalone-quote rule (a whole-line double-quoted
  utterance in a 1-on-1 attributes to the character; embedded quotes stay
  prose — flavor NPCs live in narration by design); chat replies render
  in-bubble per-speaker segments (tags hidden, small name labels, comms lines
  keep SMS styling without double-labels); chat rule 3 makes the tag optional
  and licenses flavor-NPC speech in prose; the session feed renders `*Name: …*`
  texted lines SMS-style (closes the perception plan's comms-styling
  follow-up). Transcripts stay byte-verbatim; session prompt contract
  unchanged. Docs: `prompts.md` §Dialogue tagging, `ui.md`,
  `character-chat.md`.
- **Player-input perception — markup lane, RAG fence, session port (slices 3–7)** —
  [player-input-perception.plan.md](finished/player-input-perception.plan.md) — 2026-07-09 —
  the plan's whole remainder in one multi-agent run: exemption lines in the
  pulse/archivist/intake prompts; the pure `lib/message-spans` parser + "Message
  notation" legend + comms/OOC tail notes + the round-trippable `*Name: …*`
  texted-reply grammar (eval variants + deterministic `commsReply` metric);
  transcript span rendering (sigils hidden, OOC amber aside) + the `((` composer
  auto-close/badge; the fact `channel` fence (migration `0029` — narrator-bound
  retrieval SQL-fenced to `perceived`; pulse + dev inspector unfenced; detail
  [../memory.md](../memory.md) §Fact channel); and the session-lane port (rulebook
  perception block + legend, recipient-resolved comms notes, session archivist
  channel filing, play-feed rendering). Left: slice 8 (semantic fallback) gated on
  the leak measurement; the live probe/eval runs are owner-gated spend; two small
  comms follow-ups recorded in the plan.
- **Chat narrator POV — player-POV story narration** —
  [chat-narrator-pov.plan.md](finished/chat-narrator-pov.plan.md) — 2026-07-08 — the chat model
  is now also the story's camera behind the player's eyes: the narrator-camera rule +
  player-body boundary (perception + light reflex writable; the player's actions,
  speech, and named emotions never), the attention/motion-gated visual rule (one
  detail, never an inventory), Attributes/outfit/sensory blocks reframed as what
  reaches the player's eye and senses, an `attention` arm on the chat cue invite, and
  `chat-pov-*` eval fixtures + `povCue` metric. Leftover: the live scored eval run
  (owner-gated spend).
- **Player-input perception — the prompt-only partition (slices 1–2)** —
  [player-input-perception.plan.md](finished/player-input-perception.plan.md) — 2026-07-08 —
  the chat narrator now reads the player's message in channels: quoted = heard,
  unquoted narration = seen if visible, interiority = invisible (no mind-reading,
  with a worked example and graceful no-quotes degradation); `chat-thought-leak`
  fixtures + a deterministic planted-token `thoughtLeak` metric. The markup lane, RAG
  visibility fence, and session port remain in **Next**.
- **Character chat — the standalone experience** —
  [finished/character-chat-standalone.plan.md](finished/character-chat-standalone.plan.md) · spec
  [finished/character-chat-standalone.spec.md](finished/character-chat-standalone.spec.md) — 2026-07-02 —
  all nine slices in one arc: chat became a product surface (/chat hub + full-screen
  conversation, conversations-plural on a re-keyed schema, presets, takes/go-on/stop),
  then slices 6–9 finished it — prompt-cache split + craft rules, the measured-floor
  RAG upgrade (fusion, pinned "remember this", open loops) + the complete dev
  inspector + retrieval eval harness, the relationship that governs behavior
  (stage law/history/milestones/panel/export/rebuild) + in-game-only time with player
  skips, and inline anchored scene moments with opt-in auto-at-big-moments. Post-ship
  review (2026-07-06) fixed four rollback/lock correctness bugs —
  [finished/character-chat-standalone.followups.md](finished/character-chat-standalone.followups.md).
  Leftover: the live enactment measurement run (owner-gated —
  [deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs).
- **Mood-reactive avatars — rollback** —
  [avatar-3d.plan.md](avatar-3d.plan.md) §Rollback, 2026-07-02. The emotion-image layer
  (slices 1–3 below) removed at the owner's request — the generated frames didn't work well.
  Gone: `avatar_seed` job + all enqueues, `avatar-expressions.ts`/`avatar-manifest.ts`, the
  lazy-gen + manifest routes, `contracts/avatar/`, the merge `ReactionBeat`, `avatarCue` on
  chat/status payloads, `SpriteAvatar` + its CSS; existing frames deleted via
  `scripts/delete-avatar-expression-frames.ts` (run per environment). Kept: `AvatarPanel` as
  a plain larger-portrait box in chat + the Scene tab. Plan parked; a better system will be
  planned fresh.
- **Review fixes — correctness & security (codebase-review batch 1)** —
  [codebase-review.plan.md](finished/codebase-review.plan.md) · findings
  [codebase-review.md](finished/codebase-review.md), 2026-07-02. All 17 items: the three
  silently-dead gameplay systems revived (condition→mood keys on the normalized label via
  `conditionKey`; the chat first-exchange upsert carries the outfit/cards columns through
  one shared `upsertChatState`; the director prompt surfaces the `taste` exposure axis),
  the race/data-loss edges closed (per-chat exchange lock → 409 `chat_busy` via new
  `engine/keyed-lock.ts`, serialized summary folds, fenced memory write, transactional
  Clear, batch-image 400s, provenance leaf-`.catch`), the security trio (production
  seed-credential guard, `BETTER_AUTH_SECRET` boot check, strict curated model-id
  resolvers), and four client fixes (registry-driven meter pips via threshold `pipLabel`s,
  debounce ref, lightbox focus trap, serialized chat-model PATCHes). No migration; verify
  - full int suite green. Batches 2–4 remain queued (bottom of Next).
- **Character chat as a primary feature** —
  [finished/character-chat-primary.plan.md](finished/character-chat-primary.plan.md) · spec
  [finished/character-chat-primary.spec.md](finished/character-chat-primary.spec.md), 2026-07-01. Chat now works like
  the session lane for a _single_ character (location via narration only): **RAG long-term memory**
  (per-chat facts + episodes) atop the window + rolling summary, **mutable attributes** that evolve
  over a chat, and a **dev memory inspector**. The load-bearing keying decision (D1) landed on
  **widening** `facts`/`episodes` to a nullable session + `(ownerId, characterId)` key via a
  `MemoryScope` union (migration `0018`); the post-turn fan-out is pulse ‖ archivist-lite (D2), the
  archivist also carries the attribute proposer (D3) and next-turn queries; the three resets
  collapsed to one **Clear Chat** (D4). Migrations `0018`–`0020`.
- **Character chat — state as a narration system** —
  [character-chat-state-narration.plan.md](finished/character-chat-state-narration.plan.md) · spec
  [character-chat-state-narration.spec.md](finished/character-chat-state-narration.spec.md), 2026-06-30.
  The chat narrator now **enacts** the tracked `character_chat_state` instead of listing it:
  condition→attribute overlays (a designed-but-unbuilt seam, guarded so a condition can't rewrite
  an inherent attribute), graded meter cues with a **band-change anti-repetition gate** (new
  `surfaced_cues` column, migration `0017`) so a state is marked once when it _shifts_ then rides as
  coloring, render-time **disinhibition** (intoxication lowers inhibition/guardedness/composure),
  soft social-card framing (theme not severity), a regex-first **one-turn intent cue**
  (`engine/chat-intent.ts`), a **state-aware chat scene image** (`visualStateNote` + overlays), and a
  "State → narration" debug readout. Owner decisions D1–D7 recorded in the spec; `pnpm verify` green
  (1620 tests). Graduated the deferred state-aware chat scene image.
- **Character-chat model persists per character** — docs [ui.md](../ui.md) (chat tab),
  2026-06-30. The Chat tab's narrator dropdown now saves the pick to a new
  `characters.chatModel` scalar on change (mirrors `worlds.narrativeModel`; migration
  `drizzle/0016`) — value hoisted to `character-edit-page.tsx` so it survives the tab
  unmounting, resolved through `resolveChatModelId` (unknown/empty ⇒ chat default), and
  kept off both the resettable `character_chat_state` row and the editor's profile draft.
- **Mood-reactive avatars — slice 3 (auto-asset gen + in-session play)** _(rolled back
  2026-07-02 — see the rollback entry above)_ —
  [avatar-3d.plan.md](avatar-3d.plan.md) §"Slice 3 — finalized design" · spec
  [avatar-3d.spec.md](avatar-3d.spec.md), 2026-06-30. Automated the per-character **expression
  frame set** (all 11 `EmotionLabel`s, seeded at avatar-ready via a new `avatar_seed` engine
  job + lazy-gen on demand through `POST …/avatar/expressions`, identity-locked Venice edits,
  cached forever) so the **whole unbounded cast** is expressive — `server/images/avatar-expressions.ts`
  (Venice concurrency semaphore + negative-cache that retries transient failures but tombstones
  content rejections; **Model-B** delete-on-face-change instead of a clone-breaking
  `sourceImageId` filter). Plus a **live standing companion avatar in session play** (Scene tab):
  per-participant `avatarCue` on the status payload, a **stable** focal (companion→tier→id), and a
  one-shot **reaction beat** sourced from the merge — `planReactionAffinity` now emits a
  `ReactionBeat` on both the carded branch **and** the un-carded **touch** branch (the romance
  beats), threaded additively to `agentResults.reaction` and fired once via a mount-baseline
  guard. Two adversarial workflows (design + impl review) gated it; no migration. **Deferred:**
  pose frames, touch reactions in the narrator line, a global detached-job recovery sweep. Decision-gated
  upgrade lanes remain (Rive rig, then R3F/VRM 3D; voice deferred).
- **Character chat — opportunistic sensory cues** —
  [character-chat-sensory.plan.md](finished/character-chat-sensory.plan.md), 2026-06-29. Prompt-only: a
  closeness-gated **"Sensory cues"** block surfaces `presentation.scent_baseline` (via `sensoryCues`
  in `prompts/character-chat.ts`) _only when the beat earns it_ — promoted out of the flat Attributes
  list, exposure-mask hint dropped, plus a `CHAT_RULES` rule (one cue on closeness/notice/intimacy,
  never forced or listed). Voice stays an always-on Attributes line; intimate scent/taste gated out
  (`isIntimateAttributeCategory`). Tests + a `chat-sensory-closeness` eval fixture + an opt-in
  `sensoryRelevant` deterministic metric. Escalation (one-turn chat "beat cue" wrapper) deferred.
- **Narrator prompt focus — Phase-3 focus A/B (planner does not earn its keep)** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md) · eval
  [narrator-prompt-focus.eval-results.md](finished/narrator-prompt-focus.eval-results.md) §Run 3, 2026-06-29. Ran the
  gated `--axis focus` A/B (fresh focus-on vs `--no-focus` pair, pairwise re-judge by
  `gemini-3.1-pro-preview`): the intake `focus` planner is a **53/47 wash** vs the free Phase-2 derivation
  (50/50 on byte-identical controls; it _lost_ `onBeat`/`noUnrequestedLogistics` and risked over-reaction on
  GLM). Ruling: **don't build the deferred character-chat focus analogue**; keep but don't grow the
  zero-cost session planner. (Live OpenRouter spend — 36 generations + 17 judge calls.)
- **Narrator prompt focus — eval rulings (profile + reasoning)** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md) · eval
  [narrator-prompt-focus.eval-results.md](finished/narrator-prompt-focus.eval-results.md), 2026-06-29. Turned eval
  Run 2 into code: the shape profile is now a **per-lane resting default** (`NARRATION_LANE_DEFAULTS` —
  session `concise_immersive`, chat `aggressive_concise`), resolving the global-vs-per-lane tension the
  per-model split exposed (the dev toggle still force-overrides both lanes); and `narrativeProviderOptions`
  gained a **per-model reasoning knob** (`NARRATOR_REASONING` — Aion 2.0 `effort:low`, GLM 5.2 `effort:low`,
  Owl Alpha `enabled:false`), applied to both lanes. Decision 1 re-ruled from "global-only"; tests + dev
  toggle ("Default (per-lane)" state) updated. No-spend (rulings already had the data).
- **Personality enactment — sliders & age drive dialogue/action** —
  [personality-enactment.plan.md](finished/personality-enactment.plan.md), 2026-06-28. Made the authored
  trait **sliders** (and the new real age) actually steer how characters talk and act: character-chat
  now **surfaces the sliders at all** (it never did) as a binding Disposition block; the session
  disposition block + a new Prose rule shift from "stay consistent" to **enact**; the **director**
  agent gets present-character disposition so its next-turn steer fits temperament. Shared
  `dispositionBands` renderer; age/life-stage characterization rule (the `character-age-field` follow-up).
- **Character real age vs apparent age** —
  [character-age-field.plan.md](finished/character-age-field.plan.md), 2026-06-28. New free-text
  `profile.age` (basic info) split from the visual `identity.apparent_age` attribute: the
  **narrator** reads real age (`formatAge` — canonical facts + character-chat identity), the
  **portrait studio** keeps apparent age, and **scene image generators drop it**
  (`characterAppearanceSummary` skips it) so renders lean on the avatar reference. Wired through
  editor, forge, fixtures + seed.
- **Narrator prompt focus & proportionate reaction — behavioral eval harness** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md), 2026-06-28. `pnpm eval:narration`
  (`scripts/eval/narration/`) — assembles **real** prompts (the shipped builders) for six golden
  scenarios, sweeps (scenario × model × shape profile × reasoning), streams via OpenRouter, and reports
  deterministic metrics (paragraphs / segments / distinct speakers / tokens / TTFT / latency / provider)
  - an LLM-judge rubric. `--no-focus` is a Phase-2-vs-Phase-3 A/B; `--dry-run` inspects prompts with no
    spend; conservative defaults. Never in `pnpm verify` / CI. Automates the interim eval + probes P1–P3.
- **Narrator prompt focus & proportionate reaction — Phase 3** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md), 2026-06-27. The structured
  narration-focus planner, built in the **preferred intake-schema-extension form** (no new LLM
  leg): an optional `focus` sub-object on `IntentBrief` (`primaryResponse` / `reactionScale` /
  `allowedNewTopic` / `suggestedShape`) the intake agent emits, consumed by `buildResponseShape` to
  enrich the "## Response shape" steers — finer beat verb, explicit new-topic license, an optional
  `Shape:` line. `.optional()` (absent ⇒ deterministic Phase-2 derivation); the **authored reaction
  band always overrides** the planner's `reactionScale`. Built ahead of the interim-eval gate on
  direct instruction.
- **Narrator prompt focus & proportionate reaction — Phase 2** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md), 2026-06-27. Added the
  deterministic, restatement-only **"Response shape"** line to the turn context (right after the
  digest): per-turn **current-beat** (stay on the input; new topic only via a Direction/thread),
  **reaction-scale** (absence of a strong band → "ordinary, don't escalate"; weak → "small";
  strong → defer to `## Reaction`), and **speaker-focus** (only addressed-and-present NPCs answer)
  steers. Pure `buildResponseShape` (no new LLM call); the primary-reaction verdict is evaluated
  **once** (`evaluatePrimaryReaction`) and shared with the `## Reaction` line so they can't
  disagree. Built ahead of the interim-eval gate on direct instruction.
- **Narrator prompt focus & proportionate reaction — Phase 1** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md), 2026-06-27. Killed the
  `3–5 paragraphs` floor for hot-swappable narration **shape profiles** (`concise_immersive`
  default + `aggressive_concise`, a global dev A/B knob with a dev-only `POST /api/dev/narration-shape`
  toggle in the Inspector); added response-first + proportionate-reaction + multi-party-restraint
  rules to the session rulebook and `CHAT_RULES` (both lanes), leaning on the existing `## Reaction`
  band; self-motivated NPC initiative kept for living-world texture; authored Style directives
  override. Phases 2–3 + eval remain in Next.
- **Mood-reactive avatars — slices 1–2 (cue contract + chat PoC)** _(rolled back
  2026-07-02 — see the rollback entry above)_ —
  [avatar-3d.plan.md](avatar-3d.plan.md) · spec [avatar-3d.spec.md](avatar-3d.spec.md), 2026-06-27.
  The renderer-neutral `contracts/avatar/` cue contract + pure `deriveAvatarCue` (read over the shipped
  Mood projection + social-reaction beat + posture + atmosphere, serialized onto the chat snapshot), and
  a CSS-keyframe `SpriteAvatarRenderer` + standing companion panel mounted in character-chat —
  breathing/drift/crossfade + one-shot reaction beats over the existing portrait, with ~5 hand-seeded
  Lysandra expression frames (`scripts/seed-avatar-expressions.ts`). Implementation deviated from the
  spec (no Zustand/XState/`motion` dep yet; manifest = `portrait_variant` rows tagged
  `meta.avatarExpression`; blink deferred) — recorded in the plan. **Slice 3** (auto-asset gen for the
  unbounded cast) stays in Next.
- **Merge reducer decomposition — all 5 slices** —
  [merge-decomposition.plan.md](finished/merge-decomposition.plan.md) · spec
  [merge-decomposition.spec.md](finished/merge-decomposition.spec.md), 2026-06-27. The 2655-line
  `engine/merge.ts` is fully decomposed: a `merge/` folder behind the `WorkingState` ADT
  (dirty-tracking owned internally, `no-restricted-syntax` gate), the pure resolution toolkit
  in `grounding.ts`, one `phases/*.ts` file per phase, the orchestrator (`PhaseContext` + an
  ordered `PHASES` list) in `plan.ts`, the lone DB-write transaction in `apply.ts`, and a
  narrowed public barrel. Behavior-preserving (MergePlan + every DB write byte-identical;
  189 pure + 13 integration tests green).
- **Character chat — scenario setup modal** —
  [character-chat-scenario.plan.md](finished/character-chat-scenario.plan.md), 2026-06-27. The chat tab's
  Starting Relationship + Scenario controls fold into one **Scenario setup** modal (sibling of State
  tools), grown into a no-session test harness: a per-chat **active social-card** set (seeded from the
  character's own cards, then authoritative — the pulse resolves against it) so taboos/rules are
  testable without a world/session, plus a free-text **starting outfit** + an **exposed** toggle that
  drive chat scene images — **detaching the structured clothing** the chat can't equip (`defaultOutfit`
  stays for avatar/portrait/sessions). Three new `character_chat_state` columns (`outfit`,
  `outfit_exposed`, `active_social_cards`; migration 0015). Also added the `foot_contact` interaction
  concept earlier the same arc so the foot-fetish card triggers precisely.
- **Social-reaction cards — library-reuse UI** —
  [social-reaction-cards.plan.md](finished/social-reaction-cards.plan.md) §"Deferred slice", 2026-06-26.
  The `social_cards` library finally gets its surface: `social_card` wired into the shared
  library machinery (`ShareableKind`/`LibraryKind`, clone, owner-or-public reads, semantic
  search), full CRUD at `/api/social-cards` (+ `/clone`), a `/social-cards` page + standalone
  **card builder** (with a live reaction preview, reusing the shared `SocialCardFields`),
  **Import from / Save to library** on the inline editor (snapshot-copy both ways via
  `cardFromLibraryParts`), and the **public discovery gallery** — the deferred `searchLibraryIds`
  `scope` query, debuted on cards (the auth.plan.md "public browse gallery + clone UI entry point"
  deferral graduates here; other shareable kinds pass `scope` through but their list API still
  ignores it — the fast-follow). Int-tested (scope/clone/visibility) + pure snapshot test.
- **Prod branch + promotion workflow** —
  [deployment.md](../deployment.md) §"Branch model & promotion", 2026-06-26. Long-lived
  protected `prod` branch on the existing `origin` remote (dev stays `main`). New CI
  (`.github/workflows/ci.yml`) runs `pnpm verify` on PRs/pushes to both branches; `prod`
  protection requires the `verify` check + a PR (force-push/delete blocked, enforced for
  admins). A `workflow_dispatch` "Promote dev → prod" button
  (`.github/workflows/promote.yml`) opens the `main → prod` PR. Prod **deploy** is
  intentionally not wired yet (needs a prod Fly app + Neon prod DB + `FLY_API_TOKEN`).
- **Social-reaction cards — engine + inline authoring** —
  [social-reaction-cards.plan.md](finished/social-reaction-cards.plan.md), 2026-06-25. Importable
  **taboo / social-rule cards** (`contracts/personality/cards.ts`) that resolve a classified
  social act to a `SocialReaction` riding the §6 curve — one `severity` → tier → ramped
  intensity, with per-tag override flips (the foot-fetish enjoy). Wired into all three
  reaction call sites (session merge, pre-narration line, world-less chat); **world cards**
  live inline on `worldStyle.socialCards`, **character cards** on `CharacterProfile.socialCards`
  (both snapshot arrays riding the live-read cascade — no join/instance tables). The
  continuity agent's freeform `normBreaches` was re-pointed to `cardBreaches`, with
  `planCardBreachReactions` folding **per-witness affinity** through the curve + directives —
  the freeform `world.style.norms` surface is fully removed. Forge proposes a starter card
  set; the world editor + character Disposition tab author cards inline. Deferred: the
  `social_cards` **library-reuse UI** (CRUD/page/import-picker/clone — table shipped, still
  in Next).
- **Scene atmosphere — scene-tone producer** —
  [scene-atmosphere.plan.md](finished/scene-atmosphere.plan.md) · spec
  [scene-atmosphere.spec.md](finished/scene-atmosphere.spec.md), 2026-06-24. Built the producer the mood
  core slice was missing: the **director** emits an optional `atmosphere` enum (one field, no
  new leg); `resolveAtmosphere` carries it onto the brief (sticky — director tone, else the
  prior, with an intimate-frame floor to `romantic`); the drift loop feeds it to the already-
  built `atmosphereMoodBaselineShift` for NPCs co-located with the player (a tense room settles
  a present character lower, composure-damped). Unblocks mood's last v1 input; later serves the
  avatar's `environment.atmosphere`. Deferred: authored location tone, status surfacing, a
  danger→`tense` floor.
- **Mood — app-wide emotional state** (complete) —
  [mood.plan.md](finished/mood.plan.md) · spec [mood.spec.md](finished/mood.spec.md),
  2026-06-24. A new `src/contracts/mood/` module: the locked **11-label `EmotionLabel`**,
  the pure/total **`deriveEmotionLabel`** projection (a derived activation axis × valence +
  affinity + conditions, with a transient reaction beat), and the **event→mood table** split
  into impulse (one-time) vs standing (baseline-shift) modes. **Welcome/unwelcome touch**
  (affinity-stage gated + preference override), the **condition→mood baseline shift**, and the
  **scene-atmosphere baseline shift** (its producer is the sibling Shipped entry above) are
  wired into the engine merge; a shared **`MoodChip`** surfaces the label on both the cast card
  and the character-chat strip. Mood's own scope is done; the two leftover ideas live in other
  plans — the relationship/meter timeline ([deferred.plan.md](deferred.plan.md) #4) and the
  avatar's projection consumption (Mood-reactive avatars, in Next).
- **Character chat — light state** —
  [character-chat-state.plan.md](finished/character-chat-state.plan.md) · spec
  [character-chat-state.spec.md](finished/character-chat-state.spec.md), 2026-06-24. The
  sessionless 1-on-1 chat is now state-aware: a `character_chat_state` row (full meter
  set, affinity, conditions, mindNote, premise, chat clock), a free time-drift spine
  (within-visit decay + between-visit recovery toward rested, **no affinity decay**),
  affinity seeded from a new authored `playerRelationship` profile field, a per-chat
  **premise** (chat-only scenario), and a cheap reaction pulse that reuses the
  personality §6 curve to move affinity/mood + refresh the mindNote (degrades to
  drift-only). Surfaced as a prompt "Current state" + scenario block, a `GET/PATCH/POST
…/chat/state` API, a status strip + stage-change toast + premise bar, and three
  reset scopes (all/chat/state). **Slice 4** added the texture (arousal-from-intimate,
  action chips, light conditions) and test-bed affordances (a **state-tools modal**
  with the last-turn debug trace, and the **Prompt Character** opening beat). Only the
  state-aware chat scene image was deferred → [deferred.plan.md](deferred.plan.md).
- **Default player character** — [player-character.plan.md](finished/player-character.plan.md),
  2026-06-23. A `/settings` page (reached from the nav account menu) where the user sets
  a light default player character — name + short persona on `users.playerPersona`,
  read through the single `resolvePlayerPersona` resolver and threaded into character
  chat so a character greets the player by name (closes the faceless-player UX-audit P1).
  Inline-blob storage; graduates to a real library character later via the same resolver.
- **Security hardening** — [security-hardening.plan.md](finished/security-hardening.plan.md),
  2026-06-23. Closed the full-surface scan: image-decode pixel/format/length limits
  (OOM fix), rate limits on every paid-model/heavy-write route, security headers +
  narrowed dev-origins, request-body caps, prompt-injection fencing, LLM-output array
  bounds, Postgres localhost bind + cred guard, and seven defense-in-depth lows.
  Deferred: origin/CSRF (covered by Better Auth); `script-src` nonce tightening.
- **Auth & entity visibility** — [auth.plan.md](finished/auth.plan.md) · ref
  [auth.md](../auth.md), 2026-06-23. Better Auth accounts (401 on no session, no
  auto-mint) + a private/public visibility seam with copy-on-use cloning. Also closed
  security cluster A + the auth migration. Deferred: the public browse gallery + clone
  UI entry point — **graduated 2026-06-26 for social cards** (the `searchLibraryIds` `scope`
  query + clone CTA; see the Social-reaction cards library-reuse entry above); characters /
  locations / items pass `scope` through but their list API still ignores it (fast-follow).
- **World instances — copy cascade** —
  [world-instances.plan.md](finished/world-instances.plan.md), 2026-06-23. Worlds hold
  snapshot copies of entities instead of live library FKs, so deletes never break copies.
- **Character chat — rolling background summary** —
  [character-chat-summary.plan.md](finished/character-chat-summary.plan.md), 2026-06-21. A
  watermark-anchored running summary gives the 1-on-1 chat memory past its 40-turn window.
- **Scene images — multi-reference & providers** —
  [scene-images.plan.md](finished/scene-images.plan.md) · spec
  [scene-images.spec.md](finished/scene-images.spec.md), 2026-06-19. Provider-capability
  layer + `image_references` table; Venice/Qwen multi-edit (Flux removed).
- **Attribute mutability & change-path integrity** —
  [attribute-mutability.plan.md](finished/attribute-mutability.plan.md) · spec
  [attribute-mutability.spec.md](finished/attribute-mutability.spec.md), 2026-06-19. Enforced the
  `mutability` invariant at the merge boundary + a shared value-vocabulary module.
- **Personality & evolving state** —
  [personality-and-state.plan.md](finished/personality-and-state.plan.md) · spec
  [personality-and-state.spec.md](finished/personality-and-state.spec.md), 2026-06-18.
  All five slices: the authored **likes/dislikes loop** (intake concept-tags a player's
  act; a deterministic affinity-aware curve decides the reaction), the puppet guardrail,
  atomic personality **traits** + scaling + lexicon, the **mood** valence meter +
  mood↔affinity coupling, and affinity trait-coupling + widened stages. Left as their own
  plans: the **event→mood table** (→ Mood), the **card layer** (→ Social-reaction cards),
  and the full NPC-puppeting system (deferred).
- **UX-audit remediation** — [ux-audit.plan.md](finished/ux-audit.plan.md), 2026-06-18. Triaged the
  end-to-end audit: world-forge intake fields, forge-canon reconciler, artwork progress,
  contrast theme, session-lock window.
- **Visual world map (Slice 1)** — [world-map.plan.md](world-map.plan.md), 2026-06-18.
  Read-only force-directed location graph (slices 2–3 still in Next).
- **Non-human species & body features** —
  [non-human-species.plan.md](finished/non-human-species.plan.md) · spec
  [non-human-species.spec.md](finished/non-human-species.spec.md), 2026-06-18. 8-species
  catalog + wings/horns/tail morphology across image-gen + editors.
- **Character chat — sessionless 1-on-1** —
  [character-chat.plan.md](finished/character-chat.plan.md), 2026-06-17. Talk to a library
  character directly (no world/session/RAG) to tune its voice; Chat tab + scene + Gallery.
- **Phase 4 — the body model** — [phase-4-plan.md](finished/phase-4-plan.md), 2026-06-14.
  Intimate anatomy, sensory, species scaffolding.
- **Phase 3 — presence & perception v1** — [phase-3-plan.md](finished/phase-3-plan.md).
- **Phase 2** — [phase-2-plan.md](finished/phase-2-plan.md).
- **Phase 1 — foundation** — [phase-1-plan.md](finished/phase-1-plan.md) (+
  [multi-character-phase-1-plan.md](finished/multi-character-phase-1-plan.md)).
