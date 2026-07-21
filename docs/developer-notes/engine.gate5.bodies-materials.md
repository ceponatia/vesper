# Engine plan — Gate 5: bodies, materials, households, and relationships

Part of the [engine.plan.md](engine.plan.md) gate set (split 2026-07-21; one doc per
gate — see the hub's gate index). Sequencing and current status live in
[roadmap.md](roadmap.md) and the hub; normative contracts live in the
[engine.spec.md](engine.spec.md) §-index.

## Gate 5 — bodies, materials, households, and relationships

Status: **CLOSED — 2026-07-20** (opened 2026-07-19; both opening rulings resolved by
the owner the same day: ruling 15 — v1 body meters = **full chat parity**, with
[chat-meter-economy.spec.md](chat-meter-economy.spec.md) OQ1–OQ3 as the normative
semantics source; ruling 16 — interpersonal consent = **ledger-gated fail-closed
preconditions + a §19.3 policy escalation path**; normative wording in
[engine.spec.md](engine.spec.md) §39). The build order lives in §"Gate 5 build order"
below; **E5.1–E5.3 shipped 2026-07-19; E5.4, E5.5, and E5.6 shipped 2026-07-20 —
the green deterministic exit corpus closes the gate per the Gate 4 exit-scope
precedent** (any live-model quality check rides
[deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs). Opening Gate 6
is an owner call, as every gate opening has been.

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

Per the Gate 4 precedent (the 2026-07-18 exit-scope ruling), the deterministic exit
corpus closes the gate; any live-model quality check rides the owner-gated spend list
in [deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs.

### Gate 5 build order

Like Gates 2–4, Gate 5 splits into dependency-ordered targets. The IDs describe order,
not GitHub PR numbers; each stays reviewable on its own and ships to the long-lived
`engine` branch. Leftovers carried into this gate from earlier slices: E2.4's deferred
analytical rate integration (E5.1), E3.2's action resource costs (E5.3), E3.3's
destinationless promises (E5.5), E3.4's pressure acknowledgment (E5.5) and
resumed-activity completion re-arm (E5.2), E3.5's interpersonal-consent preconditions
(E5.5, ruling 16), and E4.2's persisted §21.3 relationship ledger (E5.5).

1. **E5.1 — body substrate: meters, conditions, and the modifier engine.** Status:
   **shipped — 2026-07-19.** The §25.1–25.3 generic machinery, meter-agnostic: a
   versioned `BodyMeterDefinition` registry (class vocabulary `reserve | load |
   valence | rate | phase` from the chat taxonomy; analytic drift laws —
   linear-toward-target and proportional-decay (half-life) — in fixed-point units
   (10 000 ≡ 1.0); thresholds as registry data; the ruling-15 v1 entries: energy as a
   proportional-decay reserve (half-life ≈ 11.1h = τ 16h·ln2), hygiene as linear
   clock-keyed drain, arousal as a load meter decaying to a per-actor baseline),
   `sim_body_meters` / `sim_body_conditions` / `sim_body_modifiers` (migration 0067)
   under the one §25.3 modifier contract (operation `rate_multiplier | rate_add |
   suspend`, stacking group + priority — highest-priority-per-group then compose —
   valid interval, visibility, condition ownership, provenance). The pure kernel
   (`lib/simulation/bodies.ts`) integrates analytically and piecewise across modifier
   boundaries with **queries never persisting** — only material transitions (source
   applications, modifier boundaries, condition onset/end, threshold crossings) write,
   so partition invariance holds by construction; proportional decay uses a
   deterministic fixed-point exp2 (bit-walk constants, no libm transcendentals), and
   thresholds are solved by per-piece binary search against the kernel's own
   integration function, so the scheduled second and the fire-time evaluation can
   never disagree. Two new trigger kinds (`body_threshold_due`,
   `body_condition_expiry_due`) arm through the E2.4 scheduler as trigger_scheduled
   events, fire-time re-validated (the deferred E2.4 analytical-rate integration) and
   retired-and-re-armed under sequence-versioned uniqueness keys on every material
   event — the E3.4 re-arm design note answered; §6.4 derivation blocks (from-value,
   from-second, active modifier ids, registry version) are captured on every
   integration-bearing event. Commands: `initialize_actor_body`, `apply_body_source`,
   `apply_body_modifier`, `apply_body_condition`, `end_body_condition` (clear and
   trigger-dispatched expiry through one basis-carrying command),
   `resolve_body_threshold`. Perception rulings: source/condition-end events are
   interoception (subject-only); condition-onset and threshold events carry a trusted
   witness capture (co-located, only when the registry marks the threshold
   noticeable); initialization and modifier bookkeeping derive nothing. Fork/replay
   parity end-to-end (`replayBodiesHistory` wired into `forkBranch`; pending alarms
   re-arm on children through the shared trigger ledger). 19 pure + 5 integration
   cases; CI runs `test:engine-e5-1` (2 790 pure + 377 int green). Delivery notes: modifier expiry needs no
   trigger (validity boundaries are integration boundaries the solver already sees);
   a standalone remove-modifier command is deferred until a scenario needs one;
   `rate_add` is contract-limited to linear-law meters so every integration piece
   stays closed-form and monotone; derived condition/modifier ids hash-compact their
   command id (the E3.5 id-stacking lesson) so the threshold→condition→expiry
   derivation chain stays inside the compact-id cap. Next: **E5.2**.
2. **E5.2 — chat-parity resolution and perception-gated reads (ruling 15).** Status:
   **shipped — 2026-07-19 (slices 1, 2a, 2b).** The ruled meter set on the E5.1
   substrate, semantics per [chat-meter-economy.spec.md](chat-meter-economy.spec.md).
   **Slice 1 (shipped)** — the OQ1/OQ3 core: authored `sim_body_rhythms` rows
   (migration 0068; sleep + wash windows in minutes-of-day, seeded like action
   definitions, copied to fork children); circadian pressure as a pure function of
   the story clock against the actor's own sleep window (`circadianCurveV1` —
   piecewise-linear anchors relative to wake/bed with a post-normal-waking-span
   escalation term, every knob a versioned documented value; the curve reproduces the
   spec's verified 7am/11pm table, the zero IS bedtime, and the −1 floor lands at
   ~40h emergently); the generalized **deficit read** seam
   (`deriveDeficitRead`/`deriveEnergyRead`, signed and saturating, band vocabulary
   owned by the read — energy joins mood with no registry thresholds); the §25.4
   sleep coupling both ways (an `asleep` condition auto-attaches the energy suspend;
   waking emits a real `sleep_credit` source — +0.09/h capped 0.95, so a full night
   refills and a post-bender night reaches only 0.80, debt with no debt mechanic);
   and §25.5 window-crossing self-care as **scheduled adjustments** — wash crossings
   are deterministic clock points folded into the E5.1 piecewise integration and the
   threshold solver (landing at 6am vs 8am genuinely differs, a daily wash can
   suppress or preempt the grimy alarm outright, and no per-day tick or trigger
   exists anywhere). Conditions now record `endedAtStorySecond`, and
   `readDurableBodyReads` is the layer-3 store surface (reserve integrated purely +
   pressure + signed read, raw meters never leaving the seam). 12 new pure + 2 new
   int cases; CI runs `test:engine-e5-2` (2 802 pure + 379 int green).
   **Slice 2a (shipped — 2026-07-19)** — the intimate parity and the cut surface:
   arousal regraded to the OQ2 physiological vocabulary (`deriveIntimacyRead` —
   quiescent/kindled/flushed/wound-tight/cresting with afterglow as its own phase,
   never "low arousal"); `deriveVisibleBodySigns` as the perception gate over a
   CLOSED sign registry (tier ≤1 nothing, tier 2 skin/posture, tier 3 breath/focus —
   contact- and exposure-gated signs have no vocabulary members at all until
   G5.2 wear + G5.3 consent exist to gate them, so leaking them is structurally
   impossible); the §25.4 couplings — climax (`reset_to_baseline`, a new source
   operation) lands the actor on their per-actor baseline and installs a
   self-expiring afterglow condition through the normal expiry machinery, and
   exertion on energy drains hygiene at half the cost with its own causal record
   and re-arm; and the §22.1 cut gains `bodilyReads` (compiler bumped to cut-v3,
   field defaulted so pre-v3 rows parse): the viewpoint's OWN signed energy read +
   intimacy phase, co-present actors only as visible signs, raw meters structurally
   absent — computed by `computeEngagementBodilyReads` and wired into
   `prepareEngagementTurn`, empty for worlds without initialized bodies so
   pre-Gate-5 scenarios compile identical cuts. 5 new pure + 1 int case
   (2 807 pure + 380 int green).
   **Slice 2b (shipped — 2026-07-19)** — collapse at the saturated read floor, the
   OQ1 −1 pole made durable: `solveCollapseCrossing` scans the read (reserve minus
   the time-varying anchors + escalation pressure) at minute resolution with
   second-level refinement, so the ~40h crossing stays emergent and exact at the
   armed second; the `body_collapse_due` alarm **arms only at a real wake**
   (assumed-rhythm actors never escalate, so background casts arm nothing), retires
   on any energy material event or sleep onset, and re-arms with fresh history on
   every wake. `resolve_body_collapse` re-validates the floor at fire time and
   commits, atomically: the witnessed `body_collapsed` event (a HARD narrative
   beat), interruption of every claim-holding activity (`activity_interrupted`,
   reason `collapse`, progress captured) and open co-present engagement
   (`participant_collapsed`), and the denied sleep forced as a self-expiring asleep
   condition through the ordinary machinery — so the wake credit, the re-arms, and
   the next collapse alarm all follow from existing law. The carried E3.4 note
   lands: `resume_activity` re-arms completion under an **attempt-versioned
   uniqueness key** (the un-versioned key is a strict prefix, so cancel/complete
   retirement sweeps both), computes remaining time from captured progress, and
   rebases the activity window so repeated interruptions stay consistent; replay
   recognizes interruption-retirement and the versioned re-arm. 6 new pure + 1 int
   case (2 813 pure + 381 int green) — the int arc runs wake → arm → drain-fired
   collapse mid-vigil → interruption → forced sleep → wake re-arm → resume →
   completion through the drain.
3. **E5.3 — material life: containers, ownership, wear, and consumption.** Status:
   **shipped — 2026-07-19 (slices 1–3).**
   **Slice 1 (shipped) — the honest material lane.** §26.1–26.4 replace the Gate 1
   stand-ins wholesale: typed holding loci (held / worn-in-slot / in-container /
   at-zone / gone with a terminal basis) as the `sim_item_holdings` row itself
   (per-kind shape CHECKs; the one-locus invariant stays the primary key;
   migrations 0069+0070 drop `sim_holding_containers` and the Gate 1
   `observed_container_ids` perception stand-in), containers as items (capacity +
   fail-closed open/holder_only/allow_list access on the item row), ownership
   distinct from holding (`item_ownership_set`; a non-owner transfer stamps
   `againstOwnership` — social fact for the E5.5 ledger, never a physical block),
   and the §26.4 transfer law in one pure resolver (root-locus resolution with
   depth cap + cycle rejection, root co-location, person-sovereignty — no taking
   from another's person; giving allowed — self-dressing, capacity, staleness
   defense) shared by `transfer_item` v2 / `destroy_item` / scheduled transfers.
   The lane moved onto the shared `runSimulationCommand` shell (the last store off
   it — §20/§21/§23.4/§24 folds now run for material events; the Gate-1-local
   NarrativeCut bridge is deleted, `beatDisposition` in the live §22 pipeline is
   the only cut surface), material events carry `derivationVersion` (caught by the
   Gate 2 P5 proof), and the Gate 1 exit benchmark re-runs over the new lane
   (p95 0.031 ms, budget 5 ms, zero model calls). Fork/replay parity via
   locus-based reverse derivation; soak + both gate corpora reworked and green.
   28 new pure + 11 new int cases; CI runs `test:engine-e5-3` (2 831 pure +
   376 int green — the old Gate 1 store suite retired with its store).
   **Slice 2 (shipped — 2026-07-19) — resource costs, reservations, consumption**
   (§26.5–26.6, the carried E3.2 leftover landed): `resourceCosts` on the action
   definition (materialKindKey × quantity × consume|use), deterministic
   reservation at start (eligible = matching-kind extant items rooted with the
   starting actor or their zone, held-first then lexicographic; shortfall rejects
   `material_unavailable`; the pick captured on `activity_started` and the
   instance — migration 0071), reservations projected from live activity state
   exactly like claims (phase-derived, released terminally, interruption/resume
   keep them, no separate store), `item_reserved` rejections on
   transfer/destroy/consume via one jsonb-containment reservation scan,
   `consume_item` + the completion consume path both emitting `item_consumed` +
   causation-chained `body_source_applied` trains through a shared §25 kernel
   helper (`applySourceToMeter` extracted with `resolveApplyBodySource`
   byte-identical; meal/drink source kinds first exercised; migration 0072
   persists authored `consumptionEffects`; body-less worlds consume with zero
   body events), completion re-validating reserved items at fire time, alarms
   retiring/re-arming as on any body material event, and the feed at v3 carrying
   consumed rows. Delivery note: a pre-existing `body-store → activity-store`
   import edge means activity-store builds its own consumption-body-view/feed
   helpers rather than importing them (commented in-code; moving `activityFromRow`
   out of activity-store would let the three stores share one implementation —
   a candidate cleanup for E5.6). 25 new pure + 12 new int cases across the two
   suites; `test:engine-e5-3` now spans both lanes (2 853 pure + 388 int green).
   **Slice 3 (shipped — 2026-07-19) — item condition** (§26.7): wear + cleanliness
   as item meters on the §25 kernel under an item-scoped registry
   (`item-condition-v1`; bodies' `integrateMeterValue`/`solveNextThresholdCrossing`
   reused verbatim — subject-agnostic by design; delivery note: the authored
   cleanliness parameters were re-derived to target-0/+250-per-hour because the
   drafted target-10000 form was analytically inert). `conditionTracked` items
   lazily initialize meters on first touch; donning applies the worn-window
   cleanliness modifier and doffing ends it (transfer resolution now returns an
   event train, and a doffed item's stale alarm retires unconditionally);
   `use`-disposition costs apply authored `useConditionDeltas` at completion;
   `apply_item_condition_source` (clean/adjust) validates under the material
   source law; driftless wear crosses thresholds via synchronous instant-crossing
   detection (no alarm is solvable for a none-law meter — asserted in test);
   `item_condition_threshold_due` alarms are solved at the exact second,
   fire-time re-validated, and witnessed via root-locus co-location (grimy /
   worn-out are hard beats). `sim_item_condition_meters` /
   `sim_item_condition_modifiers` + `sim_items.condition_tracked` (migration
   0073, deferrable FK per the 0069 precedent); fork/replay parity — a child
   forked mid-worn-window carries meters, the live modifier, and a re-armed
   alarm that fires independently. New lib module `material-locus.ts` breaks a
   genuine materials↔condition import cycle. Follow-up noted: an int test for an
   instant crossing driven through `apply_item_condition_source` (the pure path
   is covered). 21 new pure + 10 new int cases; final E5.3 totals: 2 874 pure +
   398 int green, Gate 1 benchmark p95 0.028 ms.
   Original slice charter: §26 over
   the Gate 1/2 item lane: every material object has one holding locus (held / worn in
   slot / inside container / at zone / consumed-destroyed-lost); typed containers with
   capacity and access; ownership distinct from holding; exclusive reservations wired
   into E3.2 action resource costs (the carried leftover — an activity can now consume
   and require materials); consumption events feeding E5.1 body sources (a meal is a
   material event with a body effect); wear and cleanliness as item condition drifting
   on use through the same modifier machinery. Transfers validate source holding,
   destination capacity, access, capability, and reservation. Fork/replay parity and
   rebuild-from-zero over the widened lane.
4. **E5.4 — households, means, and money at LOD.** Status: **shipped — 2026-07-20
   (slices 1–2).**
   **Slice 1 (shipped) — households, lots, conservation, and means bands.**
   §26.8–§26.11 authored (households & membership, fungible lots & the conservation
   law, means bands & the promotion contract, the restock routine); `sim_households`
   / `sim_household_members` / `sim_material_lots` / `sim_means_bands` (migration
   0074, seven deferrable FKs per the 0069 precedent; lots and means-band subjects
   carry a synthetic persistence-layer row key because a discriminated nullable
   locus/subject tuple cannot be a Postgres primary key — contracts and events
   address both by natural key only). The pure kernel: lot arithmetic rejecting
   below zero before any event builds (the DB CHECK is the independent backstop,
   proven by a raw-SQL probe), fail-closed `members_only`/`allow_list` stock
   access, flat-locus reachability (no chain walk exists in this lane by design),
   and `deriveMeansRead` with structural lot-over-band precedence and an explicit
   `unknown` degraded default. Five commands on the shared shell
   (`create_household`, `set_household_membership`, `adjust_material_lot` with
   lazy lot init that persists only after the resolver accepts,
   `transfer_lot_quantity` under the §26.8 three-step access law,
   `set_means_band`); forkBranch rebuilds all four row kinds from the inherited
   stream (fully evented, empty seed — no reverse derivation needed); six event
   types through every exhaustive switch with real memory/perception rulings.
   35 new pure + 7 new int cases.
   **Slice 2 (shipped — 2026-07-20) — promotion, restock routine, and money at
   LOD.** `promote_item_from_stock` (§26.10/§27.2): stock- or purchase-funded,
   the §26.8 access law applied to household funding loci, name sampling through
   `deterministicDrawUnit` keyed by the command id with the drawn detail captured
   on the event so replay never resamples, and the causation-chained
   `material_lot_adjusted` → `item_instantiated_from_promotion` train — the
   materials fold gains its first item-CREATING case (double-instantiation
   guarded). `configure_restock_routine` + the `household_restock_due` alarm
   (fixed cadence, uniqueness-keyed by arming sequence, unconditional retirement
   on reconfigure) and the trigger-dispatched `run_household_restock` (fire-time
   re-validation; `already_stocked`/`insufficient_funds` deferrals that still
   re-arm; the lot-funded debit→credit causally-linked pair vs the ONE
   sanctioned unconserved means-band top-up). `sim_household_restock_routines`
   plus the slice-1 `sim_household_members` branch-cascade FK gap closed
   (migration 0075). Fork/replay: `seedProjectionForReplay` excludes promoted
   items from the reverse-derived origin seed, `lastPlacedSequence` stamps them
   from their instantiation event, and replay recognizes restock alarm
   retirement/re-arm. A three-lens adversarial review + refutation pass
   confirmed 3 major findings, all fixed: the no-name/no-pool promotion path
   rejects `name_required` (structured, resilience-conform) instead of
   throwing, and a real claim/dispatch-window race (a reconfigure between a
   worker's trigger claim and its dispatch left two live alarms) closed by
   retiring `processing` rows too — the stale dispatch fails closed through
   `threshold_stale`, and the scheduler's fenced completion write no-ops to
   `lease_lost`. Follow-up noted: the same pending-only retirement gap may
   exist for the body and item-condition trigger kinds — audit sweep candidate
   for E5.6. 18 new pure + 9 new int cases. Final E5.4 totals: 2 927 pure +
   414 int green; CI runs `test:engine-e5-4` (121 cases across four suites).
5. **E5.5 — the social ledger: promises, favors, debts, boundaries, and consent
   (ruling 16).** Status: **shipped — 2026-07-20 (slices 1–3).** All four carried
   Gate-5 leftovers for this slice landed: E3.3's destinationless promises,
   E3.4's pressure acknowledgment, E4.2's persisted §21.3 ledger, and E3.5's
   ruling-16 consent preconditions.
   **Slice 1 (shipped) — the ledger substrate: derived entries, authored entries,
   reads.** The whole-feature spec landed first (§21.3 replaced wholesale, new
   §21.4 consent, §15.1/§15.4/§16.1/§19.2/§9.2 amendments — the E5.3/E5.4
   one-spec-edit precedent). `sim_relationship_ledger` (migration 0076) under a
   closed, versioned entry-kind vocabulary with an explicit derived-vs-authored
   split: speech acts (including the two new `permission_granted` /
   `permission_withdrawn` types with `consentScopeKey` required exactly on
   consent effects), disclosures (retraction split), `engagement_ended`
   shared-scene fan-out, authored priors/help/betrayal/etc. via
   `record_relationship_entry`, and explicit `record_relationship_change` —
   relationship change is a ledger entry, never prose. The pure kernel
   (`lib/simulation/social.ts`): hash-stable entry ids, the fold over all
   slice-1 source events, `deriveRelationshipRead` (fixed-point half-life
   decay, banded trust/attraction/resentment with one-directional resentment
   bands, diagnostics for missing authored-prior weights, explicit empty-ledger
   degraded default), and `resolveConsentCoverage` (pure; unconsumed until the
   slice-2 gate). `social-recorder.ts` commits ledger rows atomically inside
   the command transaction (wired into the shared runner); the superseded E4.2
   derived seam (`deriveRelationshipEvidence`/`summarizeRelationshipDyads`) is
   DELETED both layers, call sites migrated. Fork parity via
   `replaySocialLedgerHistory`. Testing found and fixed a real cross-domain
   Stage A/B defect: `compileNarrativeCut` AND the arbiter's
   `confirm_narrator_result` arming both dropped `consentScopeKey`, so no
   boundary/permission speech act could ever arm — the §21.4 gate would have
   been unreachable. Adversarial review confirmed 1 major (entry-id composition
   could legally exceed its 256-char id tier, breaking future forks): fixed by
   widening to the 2048 tier per the `assertionId` precedent, with the
   worst-case legal composition proven bounded (~1 606 chars) and a regression
   test at schema maxima. 100 cases in `test:engine-e5-5` (77 pure + int);
   full suite 3 005 pure + `test:engine-e5-4` unbroken at 121.
   **Slice 2 (shipped — 2026-07-20) — the consent gate: preconditions, activity
   wiring, destinationless commitments.** `consent_covered` as an enforced
   action-definition precondition — schema-constrained to at most ONE per
   definition (the compound-scope gap a reviewer proved would silently check
   only the first scope; constraint made normative in §16.1), `targetActorId`
   + three rejection codes, the gate evaluated fail-closed inside the start
   transaction (`resolveConsentCoverage` over the dyad's ledger slice — no
   TOCTOU window past the branch lock), and `consentGrant` captured on
   `activity_started` only when coverage came from a permission entry, feeding
   the ledger's grant-consumption fold arm. Destinationless commitments
   (the carried E3.3 leftover lands): `destinationZoneId` optional under the
   §15.1 guards, `promisedToActorId` (a self-promise is a structured
   `promised_to_self` rejection — the review's critical find: it previously
   crashed with a raw ZodError, the exact E5.4 `name_required` lesson),
   `repairsCommitmentId` under §15.4 validation (same actor, same kind, target
   status `missed`), `fulfill_commitment` with the `self_reported` evaluation
   basis (destination-bearing commitments reject `commitment_has_destination`),
   and destinationless deadlines falling through to `missed` with no location
   evaluation. Social fold arms for activity/commitment sources;
   `commitmentById` wired for real in fork replay; recorder widened; migration
   0077 (nullable ALTERs on `sim_commitments` + the self-referential repair
   FK). Adversarial review confirmed 2 findings (1 critical, 1 major), both
   fixed as above. `test:engine-e5-5` 100 → 195; full suite 3 038 pure;
   `test:engine-e5-4` (121) and `test:engine-e5-3` (117) unbroken.
   **Slice 3 (shipped — 2026-07-20) — consent escalation, pressure
   acknowledgment, full-corpus parity.** `attempt_consent_escalation` through
   the §19.3 deliberator seam, restructured two-phase after the review's
   CRITICAL find (the first cut awaited the model call inside the branch-row
   lock, violating the command-runner's own documented invariant): pre-lock
   deliberation (unlocked dyad-ledger read, an idempotency dedupe so a retry
   never re-spends model budget) and a locked authoritative re-check feeding
   the pre-computed outcome into the event — the `prepareEngagementTurn`
   precedent. Decline is pinned unconditionally across all five fallback
   paths (not-admitted / refusal / timeout / unparseable / unknown-id),
   regression-tested per path with a grant-scores-higher stub; a
   player-controlled target hard-rejects before any deliberation (asserted
   `deliberate()` called zero times); the versioned
   `CONSENT_ESCALATION_SCORE_GAP_THRESHOLD_FIXED_POINT` gates admission; both
   grant AND decline land as ledger entries. `acknowledge_pressure` as a
   social act: `acknowledgedSeverity` on pressures + `acknowledgedPressureIds`
   on engagements (migration 0078, nullable ALTERs), the cut's
   acknowledgment-aware filter (suppressed at unchanged severity, re-surfaced
   on escalation past it), and the arbiter emitting from the pre-filter
   pressure load so destinationless-commitment pressures are acknowledgeable.
   Fork parity: the review's major find (pressure `updatedSequence`
   under-stamped when the last touch was an acknowledgment) fixed with a
   max-merge of the two per-id sequence maps; full-corpus fork-hash parity
   across every E5.5 event type. A follow-on **Opus verification pass** on the
   critical restructure proved the defensive throw unreachable path-by-path,
   confirmed dedupe/concurrency safety, and caught two more: the relationship
   read's data-integrity diagnostics were silently dropped (now merged into
   the persisted outcome) and a false unlocked-call doc comment (reverted);
   the `admitAtLockedVersion` staleness caveat is documented on the option.
   `test:engine-e5-5` 195 → 223; 3 048 pure + 443 int green; E5.4/E5.3 suites
   unbroken.
   Original charter: The persisted §21.3 evidence ledger the E4.2 derived seam was built
   to feed: typed entries for promises made/kept/missed/repaired, boundaries
   stated/respected/violated, help, neglect, betrayal, disclosure, affection, conflict,
   shared activities, authored priors, and explicit relationship changes — relationship
   change is a ledger entry, never solely prose. Destinationless commitments (the
   carried E3.3 leftover) join the commitment contract with social consequences in
   place of location evaluation; pressure acknowledgment (the carried E3.4 note) lands
   as a social act. Consent per ruling 16: boundary/permission entries checked
   fail-closed as intimate-action preconditions, uncovered escalations routed through
   the §19.3 deliberator seam (deterministic fallback = decline) with the outcome
   landing back as a ledger entry. Trust, attraction, and resentment ship as derived
   projection reads over the ledger; conflicts among goals, needs, roles, and
   commitments become NPC-policy utility inputs (§19.2 widened with ledger and needs
   terms). Fork/replay parity.
6. **E5.6 — the Gate 5 exit corpus.** Status: **shipped — 2026-07-20. GATE 5
   CLOSED.** Two deliverables, both Opus-built per the owner's 2026-07-20 model
   ruling.
   **The carried trigger-retirement audit** (the E5.4 follow-up): all ten trigger
   kinds traced against the scheduler's real claim/dispatch transaction
   boundaries. Nine proven immune with recorded per-kind reasons (fresh-state
   re-derivation + self-sweeping dispatches for the threshold kinds; one-shot arms
   with terminal statuses for expiry/notice/deadline/arrival/transfer; no
   reconfigure command existing at all for the commitment/journey kinds). ONE
   real gap confirmed: `activity_completion_due` at the collapse-interrupt site —
   the only kind whose guard can legally cycle back (`active → interrupted →
   active` via `resume_activity`), where a completion trigger claimed into
   `processing` just before a collapse survived the pending-only sweep and later
   hit a raw invariant throw on the resumed activity. Fixed both halves: the
   throw became the structured `completion_not_due` rejection (fail-closed,
   phase/time-based) and the collapse-interrupt retirement widened to
   `pending`+`processing` per the household precedent; the regression test was
   falsified against the unfixed code (stash → fail → restore → pass).
   `cancel_activity`'s own pending-only miss is recorded harmless (`cancelled`
   is terminal; the stale claim hits `activity_not_active` cleanly).
   **The exit corpus** — `gate5-corpus.int.test.ts` (10 scenarios, zero model
   calls, every arc through real commands): the four explain-why causal chains
   (wake→escalation→collapse walked hop-by-hop through §6.4 derivations with the
   read recomputed against the persisted beat; stock→promotion→held→consumed→
   body-source with lot conservation summed from events; the means-band
   unconserved top-up vs the causation-linked cross-kind purchase pair across two
   restock cycles; promise missed→ledger→trust drop→repair→recovery with every
   sourceEventId resolvable); the per-viewpoint narrator-boundary sweep (raw
   meters structurally absent, exact sign vocabulary in deterministic order,
   exact self-view fixed-point values); partition invariance across material
   thresholds over a 22-table row-count footprint; rerender/retry invariance
   over every E5.1–E5.5 persistence surface; and adversarial-boundary fork
   sweeps (mid-armed-restock, mid-worn-window, pre/post promotion,
   post-acknowledgment, plus the E5.3-noted instant-crossing case). Adversarial
   review confirmed 1 major — the footprint sweep was silently missing
   `sim_body_rhythms`, exactly the false-confidence class the lens targeted —
   fixed with a fork-parity comparison added; two advisory assertions tightened
   to exact values. Known limits recorded: post-fork rhythm reconfiguration is
   unexercised (no mutation command exists yet), and one self-view literal is
   pinned to the scenario's seed constants. CI runs `test:engine-e5-6` (10);
   final Gate 5 totals 3 048 pure + 454 int green across all suites.

E5.2 consumes E5.1; E5.3 consumes E5.1 (consumption sources); E5.4 consumes E5.3;
E5.5 is independent of materials but consumes E3.3/E4.2; E5.6 closes the gate.

