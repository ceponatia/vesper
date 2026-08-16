# Engine plan — Gate 6: dual LOD and autonomous background life

Status: **CLOSED — 2026-07-21** (opened 2026-07-20 on the owner's go; E6.1–E6.5 all
shipped within two days). Closed per the Gate 4/5 exit-scope precedent: the
deterministic exit corpus plus the instrumented scaling proof (`test:engine-e6-5`,
detail under E6.5 below) — any live-model quality check rides the owner-gated spend
list in [deferred.plan.md](../../deferred.plan.md). **With Gate 6 closed, every committed
foundation gate (0–6) is closed; Gate 7 remains optional/post-foundation and its
opening is the owner's call.** No blocking product rulings were identified at
opening: every product-flavored knob in this gate (LOD defaults, utility weights,
promotion sampling) lands as versioned world-type or registry data with documented
defaults, per the ruling-14/15 precedent — tunable post-build, never a schema
migration. The build order lives in §"Gate 6 build order" below.

Part of the [engine.plan.md](engine.plan.md) gate set (split 2026-07-21; one doc per
gate — see the hub's gate index). Sequencing and current status live in
[roadmap.md](../../roadmap.md) and the hub; normative contracts live in the
[engine.spec.md](../../engine.spec.md) §-index.

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

Per the Gate 4/5 precedent (the 2026-07-18 exit-scope ruling), the deterministic exit
corpus plus the instrumented scaling proof close the gate; any live-model quality check
rides the owner-gated spend list in [deferred.plan.md](../../deferred.plan.md) §Owner-gated
live eval runs.

### Gate 6 build order

Like Gates 2–5, Gate 6 splits into dependency-ordered targets. The IDs describe order,
not GitHub PR numbers; each stays reviewable on its own and ships to the long-lived
`engine` branch. Leftovers carried into this gate: the E5.5 §19.3 call-site LOD stub
(`social-store.ts` — "every NPC defaults to deliberator LOD … until Gate 6's real
per-actor LOD field exists" — E6.1 deletes it), and the two E5.6-recorded known limits
that this gate's work naturally exercises where its scenarios touch them (post-fork
rhythm reconfiguration has no mutation command yet; one exit-corpus self-view literal is
seed-pinned).

1. **E6.1 — the LOD ledger: per-actor simulation and inference LOD.** Status:
   **shipped — 2026-07-20.** The §27.1 simulation-LOD vocabulary (`exact | event |
   aggregate | dormant`, index order IS the resolution ranking) joins the existing
   §28 inference-LOD vocabulary as independent axes on one sparse per-actor ledger
   row (`sim_actor_lods`, migration 0079; the composite actor FK is DEFERRABLE per
   the 0069 precedent): branch-scoped, fully evented (`actor_lod_assigned`, whose
   payload captures the replaced effective values + `previousWasDefault` for
   audit-without-reads), assigned by `assign_actor_lod` (storyteller/system
   principals only) on the shared §11.1 shell. An UNASSIGNED actor reads the
   versioned registry defaults (`actor-lod-v1`: exact + deliberator — exactly what
   both pre-Gate-6 §19.3 call sites hardcoded), so shipping the ledger changed no
   outcome and background casts stay row-free. The §27.3 demotion guards are
   evaluated fail-closed inside the command transaction, in fixed order (the
   actor's claim-holding activities → unresolved temporal pressures →
   claim-holding engagements), each with a structured rejection naming the
   blocker; the inference axis never guards (a model-budget dial), and neither
   does a simulation promotion — for a named actor whose full state exists,
   raising resolution is bookkeeping (real aggregate promotion is E6.4). Both
   §19.3 call sites now read the real field through the one `readEffectiveActorLod`
   seam: the arbiter reads the ACTING NPC per departure actor (the caller-supplied
   `PrepareTurnDeliberation.inferenceLod` field is DELETED), and the consent-
   escalation pre-pass reads the deciding TARGET (the documented "§11 decision 4"
   stub is deleted). Cross-domain threading: every exhaustive event switch gained
   the type with a recorded ruling — perception derives nothing, no beat, no
   memory document, every domain applier boundary-bumps. Fork parity:
   `replayActorLodHistory` (fold from the empty seed) wired into `forkBranch`;
   the child's rows replay bit-identical and unassigned actors read defaults on
   both sides, proven in the int suite alongside idempotency and authorization.
   Also fixed in passing: ci.yml had silently drifted — the documented
   E5.4/E5.5/E5.6 steps were never added; they now run, plus `test:engine-e6-1`.
   15 new pure + 2 new int cases; 3 063 pure + 456 int green across all suites.
   Next: **E6.2**.
2. **E6.2 — routine policy at event LOD: the background-life controller.** Status:
   **shipped — 2026-07-20 (slices 1–2; E6.2 complete).** The §19.1/§19.2 deterministic routine
   controller (normative wording authored as spec §19.2.1), LOD-gated end to end:
   a new `routine_policy_due` trigger kind (sequence-versioned uniqueness keys,
   the restock re-arm/retire idiom; `sim_triggers.kind` now types off the
   contract's kind list verbatim so a new kind can never drift out of the column)
   arms when an actor with a tracked body enters `event` LOD — `assign_actor_lod`'s
   resolver emits the arm in its own event train and the store retires prior
   armings unconditionally (pending+processing, the E5.6 lesson) — and re-arms on
   every resolution, so the cycle sustains itself with no per-minute work and no
   model calls (the §19.3 deliberator is structurally never consulted).
   `run_routine_policy` (system-only, fire-time re-validated to the structured
   `routine_stale`) scores the closed v1 candidate set — `begin_sleep` by the
   actor's own circadian pressure (`deriveCircadianPressure`, escalation
   included), `hold` at the versioned 10 000 weight when an unresolved pressure's
   actBy falls inside the would-be sleep (above the whole periodic circadian
   range; deep sleep debt eventually outranks it, emergently) — with claim/
   engagement legality gates captured by name on the `routine_policy_resolved`
   decision event (a §6.4 capture: every scored candidate + the admitting LOD;
   not perceptible, not a beat, not memory-eligible). A chosen sleep commits
   atomically through `buildSleepConditionTrain` — EXTRACTED from
   `resolveBodyCollapse` so forced and chosen sleep are byte-identical machinery
   (the applySourceToMeter precedent) — landing the asleep condition, energy
   suspend, and self-expiry at the scheduled wake; the wake credit, threshold
   re-arms, and collapse arming all follow from existing law. A hold re-arms the
   next bedtime (a skipped night self-heals a day later). Fork/replay parity:
   arming registration + retirement recognition in the replay trigger ledger
   (resolution and LOD assignment both retire; re-arms follow as fresh
   trigger_scheduled), proven by a mid-sleep fork carrying the active condition
   and both alarms. The int arc runs assign → bedtime sleep → expiry wake with
   sleep credit → self-sustained second cycle → fork, plus the engagement hold.
   10 new pure + 2 new int cases (+2 pure on the lod suite); 3 075 pure +
   458 int green across all suites; CI runs `test:engine-e6-2`. Slice
   boundaries: wash stays §25.5 window-crossing law
   (already deterministic); **meals join the candidate set in slice 2** with the
   §26 consumption path; the §21.3 ledger terms in the general scorer stay the
   noted later slice.
   **Slice 2 (2026-07-20): `eat_meal` joins the candidate set** (spec §19.2.1
   updated as the normative wording; weights version `routine-policy-v2`, with
   persisted v1 decisions parseable via the versioned weights list). The `meal`
   rhythm kind lands as the anticipated data edit (contract + drizzle text
   enum — no DB constraint, no migration), and the one boundary law
   (`nextRoutineBoundarySecond`: earliest of bedtime and meal-window starts)
   now drives both the E6.1 arm and every re-arm. Two scoring corrections the
   extension forced, both behavior-preserving at bedtime: candidates are DUE
   only inside their own windows (sleep scores 0 elsewhere — a bare-pantry
   midday hold can no longer become a nap off the daytime circadian floor;
   forced daytime sleep stays the §25.4 collapse law's job), and the v1
   obligation weight moved from `hold`'s score onto sleep as a penalty
   (identical sleep-vs-hold boundary; an evening obligation no longer starves
   an instant midday meal). A chosen meal commits the §26.6 train byte-for-byte
   as `consume_item` does — the shared `buildItemConsumedEvent` /
   `buildConsumptionBodyEffects` builders, causation-chained decision →
   item_consumed → body effects, the material feed obligation, per-meter
   threshold retire/re-arm — via the exported material-store
   loaders/appliers, so no projection or replay fold changed (no new event
   types). Item eligibility is §26.5 adapted: meal-source consumption effect
   required, never against ownership, unreserved, container-access
   fail-closed, actor-rooted before zone-rooted with lexicographic tie-break —
   else the captured `no_eligible_item` and the boundary self-heals at the
   next window. The int arc runs assign → lunch eat (item gone, feed
   obligation, chain re-read from rows) → same-cycle bedtime sleep → fork
   carrying the consumed loaf; the bare-pantry hold proves the ownership gate
   end to end. 13 new pure + 2 new int cases; 3 086 pure + 460 int green
   across all suites. Leftovers: aggregate-stock feeding (no concrete item)
   is E6.3's lane; the §21.3 ledger terms in the general scorer remain §9's
   open decision 6.
3. **E6.3 — aggregate and dormant lanes.** Status: **shipped — 2026-07-21
   (slice 1 2026-07-20, slice 2 2026-07-21; E6.3 complete).** Population cohorts and institutions as flow-updated aggregates
   (extending §26.9 means bands and the §26.11 restock pattern): analytic updates
   on demand at read or dependency time, never on a tick; dormant actors provably
   arm no triggers and write no rows until an incoming dependency or promotion
   boundary wakes them.
   **Slice 1 (2026-07-20): the dormant lane** (spec §27.5 authored as the
   normative wording). Below `event`, an actor performs no scheduled work:
   any simulation-axis move retires the actor's full body-alarm set
   (thresholds + collapse, the restock-reconfigure idiom) and landing at
   `event`/`exact` re-arms it fresh from re-solved law via the new pure
   `buildActorBodyAlarmRearms` (the same command's events; inference-only
   changes touch nothing). Landing below `event` is guarded fail-closed on
   active body conditions (`demotion_blocked_active_condition` — a live
   expiry alarm can't survive the no-work law), `initialize_actor_body`
   arms nothing for an already-below-event actor, and replay mirrors the
   retirement so forked children carry no phantom alarms. The int proof
   advances three story-days over a dormant actor — across two would-be
   bedtimes and both meters' would-be crossings — asserting zero events,
   zero conditions, zero pending triggers, and untouched meter rows, then
   wakes them by promotion and watches ordinary bedtime law resume; the
   asleep-actor tuck-away rejection and the init-under-dormant path are
   covered alongside. 4 new pure + 1 new int case; 3 090 pure + 461 int
   green; CI runs `test:engine-e6-3`. Waking on an incoming dependency
   (vs. explicit promotion) is deliberately deferred to E6.4's
   promotion/catch-up contract.
   **Slice 2 (2026-07-21): the aggregate lane** (spec §27.6 authored as the
   normative wording; §26.10's means-subject vocabulary widened to
   actor | household | cohort). Population cohorts land as branch-scoped
   conserved counts — one `sim_cohorts` row (migration 0080) no matter how
   many people it holds — existing only through `cohort_created`
   (storyteller/system; presence-window zones validated fail-closed) and
   moving only through `cohort_adjusted` (integer deltas, the closed
   `authoring | influx | attrition | promotion_reservation` reason
   vocabulary with headroom for E6.4, both counts captured
   audit-without-reads; below-zero is the structured
   `insufficient_population`, never a clamp). Presence is fully analytic:
   authored minute-of-day windows (half-open, wrapping, earliest-triple
   overlap rule) place `floor(population × share / 10 000)` people at a
   zone as a pure read — zero rows, zero triggers, zero model calls, proven
   in the int arc alongside the no-trigger assertion. Cohort events are not
   perceptible (no observation, no beat, no memory — the crowd's ebb
   reaches viewpoints through the read), threaded through every exhaustive
   fold. A cohort wears a means band through the ordinary `set_means_band`
   (subject existence fail-closed; new `cohort_id` band column) and is
   band-tracked-or-unknown by construction. Fork children rebuild rows from
   inherited events (`replayCohortHistory` wired into `forkBranch`, proven
   with a presence-parity read). Institutions stay households + restock
   (§26.8–26.11) in v1 — recorded ruling — and zone-shop restock
   generalization is deferred until a scenario demands it. 9 new pure +
   1 new int case; 3 099 pure + 462 int green; `test:engine-e6-3` carries
   the cohort suites. Leftover to E6.4: the `promotion_reservation` debit
   is vocabulary today — the promoting command that emits it (and
   dependency-wake) is E6.4's contract.
4. **E6.4 — actor promotion and catch-up.** Status: **shipped — 2026-07-21**
   (spec §27.7 authored as the normative wording; §27.2's concretization line
   and §27.5's wake pointer updated). §27.2's five steps generalized from the
   §26.10 item case to actors: `promote_actor_from_cohort` (storyteller/system —
   the cohort authoring bar) is now the ONLY path a named actor comes to exist
   mid-branch, committing one causation-chained train — `cohort_adjusted`
   (`-1`, `promotion_reservation`: the step-2 conserved debit, so an actor
   exists only because the aggregate provably gave one up) →
   `actor_materialized_from_aggregate` (the one event creating a
   `sim_characters` row + the actor's first physical locus; actor id derived
   from the command id per the promoted-item precedent; name supplied or
   sampled via `deterministicDrawUnit` with stream + draw captured on the
   event — and `name_required` fail-closed, since no pool is authored yet,
   §26.10 parity) → `actor_lod_assigned` (the landing pin,
   schema-narrowed to `event | exact`; `previousWasDefault` structurally
   true). The step-5 no-contradiction law is DETERMINISTIC: materialization is
   legal only where the analytic presence read admits a person (windowed
   `presentCount ≥ 1` there, or a dispersed remainder ≥ 1 elsewhere) — a
   floored-to-zero zone is a real empty read and rejects `cohort_not_present`,
   proven end to end at share 10 000 (49 aggregate + 1 named = the original
   50). Materialization is LOD bookkeeping under the §27.4 rule — no
   observation, no beat, no memory document — threaded through every
   exhaustive fold with recorded rulings. **Dependency-wake** (the carried
   E6.3 deferral): `open_engagement` reaching a below-event participant wakes
   them inside its own transaction — prepare/commit two-phase, wake events
   preceding the open event, a rejected open waking no one; landing `event`
   with the inference axis preserved; the assignment train EXTRACTED
   (`buildLodAssignmentTrain`, the buildSleepConditionTrain precedent) so
   explicit assign and wake are byte-identical machinery, sharing one
   store-side retirement helper. Recorded v1 scope ruling: engagements are
   the one waking dependency (they claim attention); every other command on a
   below-event actor keeps §27.5's promote-first law. **Catch-up** is the
   already-partition-invariant lazy integration plus fresh alarm re-solve at
   wake; the one real gap found and closed: `initialize_actor_body` for an
   actor already AT `event` now also arms the routine alarm (before, only
   `assign_actor_lod` armed it, so the promote-then-embody canonical order —
   and any assign-event-then-init order since E6.2 — left an event-LOD actor
   with a tracked body and no background life). **Demotion compaction**:
   recorded v1 ruling in §27.7 — satisfied vacuously (the demotion guards
   close everything compactable before the axis moves; persisted rows ARE the
   summary; immutable events remain); return-to-cohort deferred until a
   scenario demands it (the adjustment-reason vocabulary has headroom). Fork
   parity mirrors promoted items on BOTH seeds: materialized actors are
   excluded from the materials seed and the space seed (a
   materialized-then-moved actor would otherwise reverse-derive a phantom
   origin locus) and re-added by the forward folds' double-materialization-
   guarded cases; a pre-promotion fork carries neither actor nor locus nor
   count change, a post-promotion fork rebuilds all four surfaces from
   inherited events — both proven in the int arc alongside idempotency,
   authorization, and the rejected-open no-wake proof. No migration — the
   first Gate 6 slice that needed none. 10 new pure + 2 new int cases;
   3 109 pure + 464 int green across all suites; CI runs `test:engine-e6-4`.
   Next: **E6.5**.
5. **E6.5 — the Gate 6 exit corpus and scaling proof.** Status: **shipped —
   2026-07-21; GATE 6 CLOSED.** Three deterministic scenarios, zero model calls
   (`gate6-corpus.int.test.ts`, `test:engine-e6-5`). **EXIT 1** walks a promoted
   actor's whole existence hop-by-hop from events alone: asleep condition →
   same-command routine decision (`begin_sleep` at event LOD) → the routine alarm
   armed by embodiment → `body_initialized` → the one
   `actor_materialized_from_aggregate` → its causation-chained
   `promotion_reservation` debit → the cohort's full count history verified
   link-by-link (`populationBefore`ᵢ₊₁ = `populationAfter`ᵢ from creation
   forward); conservation summed from events (51 aggregate + 1 named = the 52 who
   ever existed after 50 + 5 influx − 3 attrition), replay/live/analytic-presence
   parity, headcount continuity at share 10 000. **EXIT 2** is the instrumented
   scaling run: two worlds, identical one-actor active cast living three
   story-days of routine (3 sleeps, 12 triggers fired), background 3 003 vs
   **300 030** people (10× cohort rows AND 10× per-cohort count, plus 10× dormant
   embodied actors — 100× people): life-phase work is asserted EQUAL, not merely
   sublinear — same fired triggers, same appended events, identical row deltas
   across a 12-table footprint, zero model calls (structurally — no model client
   exists), wall time flat (measured ~121ms → ~116ms; authoring cost scales and
   is reported as such). **EXIT 3** proves partition invariance across the
   routine and dormant lanes: one three-day jump equals four smaller jumps —
   bit-identical meters/conditions/modifiers (branch-derived ids scrubbed),
   identical re-armed alarm schedules — ending with a dependency wake whose
   catch-up lands the same state either way. **The corpus caught and fixed a
   real defect** (the gate-corpus tradition): triggers armed MID-DRAIN by fired
   work — sleep arming its own expiry — were invisible to the rest of that
   drain call (wall-clock `available_at` default vs the call's entry-captured
   eligibility clock), so one long skip silently deferred chained alarms to the
   next drain, which stamped them at too-late story seconds — a genuine §12.4
   partition-invariance break in the routine lane that every earlier short-hop
   test masked. Fix: a fresh arm is born eligible (`available_at` pinned to
   epoch at the one projector insert; retry backoff still pushes it forward),
   falsified against the unfixed code by EXIT 3. Recorded ruling in-corpus:
   perception is deliberately NOT LOD-gated (§27.4 — a co-present dormant
   actor must capture truth or promotion would contradict what they plainly
   saw); off-screen background belongs off-scene, and unnamed crowds inside a
   scene are what cohorts are for. 3 new int cases; 3 109 pure + 467 int green
   across all suites; CI runs `test:engine-e6-5`. **Gate 6 closed per the
   exit-scope precedent.**

E6.2 consumes E6.1's ledger (the controller is LOD-gated); E6.3 consumes E6.1's
vocabulary; E6.4 consumes E6.1 + E6.3 (something must exist to promote from); E6.5
closes the gate.

