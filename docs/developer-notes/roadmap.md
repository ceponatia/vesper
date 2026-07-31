# Roadmap

The single ordered index of development plans. **Order here is the only place
priority lives** — reprioritizing is a one-line move, never a file rename (see
`CLAUDE.md` → working-docs convention).

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

- **Constraint-first narrator physical guidance — constraints, premise correction,
  and resolved action outcomes** —
  [narrator-physical-guidance.plan.md](narrator-physical-guidance.plan.md)
  (active; **slices 0–2 shipped 2026-07-30, owner-review corrective pass applied
  same day** — the closed cue path is frozen, the shared guidance contracts +
  compiler are in `contracts/affordances/guidance/`, and the hair
  constraint/correction path ships behind `CHAT_PHYSICAL_CONSTRAINTS`, default
  off; review verdict: slices 0–1 accepted, slice 2 safe behind the flag but
  not paid-trial-ready until slice 5 generalizes the trial-record format.
  Remaining: slice 3 romantic-contact action results, slice 4 change-gated
  positive detail, slice 5 the trials, slice 6 the successor adapter). Keeps
  the affordance calculations but replaces always-on descriptive suggestions
  with scoped consistency constraints, high-confidence false-premise fences,
  and mandatory resolved action outcomes. Positive state-change details get a
  separate flag and trial; generic ambient opportunities stay parked. No extra
  model leg. The hair proving slice leads, then the foot-contact resolver
  consumes the shared action-outcome seam. `CHAT_AFFORDANCE_CUES` remains off.
- **Romantic contact affordances — foot-first grounded contact** —
  [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md) ·
  [spec index](romantic-contact-affordances.spec.md) (active; **slices 0–2
  shipped 2026-07-30** — the truth-source audit/capability matrix, the
  lane-neutral attempted-versus-active contact lifecycle contracts, and the
  foot domain proof (surface map + three registry loci, profile inheritance,
  zero-preserving condition distribution, footwear filtering,
  pressure/texture/glide phenomena — fixture-driven, unregistered until
  slice 3 wires it; warmth and scent recorded deferred, no owners exist);
  promoted from deferred 2026-07-28 and sequenced directly behind the
  narrator-guidance plan whose action-outcome seam its slice 3 consumes).
  **Slice 3A — authority and persistence hardening — landed 2026-07-31**: the
  owner's post-review verdict was that slice 3 was ready to begin as an opening
  hardening/design phase, **not** ready to proceed directly into production lane
  wiring unchanged. 3A delivered actor/source + per-participant agency binding,
  lifecycle clearing/orientation/capacity/state cross-validation, the
  post-persistence outcome adapter with **no partial status** (contact emits only
  committed / explicit_transition_required / rejected / unresolved), a minimal
  scene/body-relations owner
  ([scene spec](romantic-contact-affordances.spec.scene.md)), the final foot
  side/unsided regressions, and four carried-forward corrections (required access
  discriminator on the eligibility entity descriptor, non-owner blocker-routing
  regression, clone-policy disclosure on publish, and this docs pass).
  All prerequisites are **done and archived**: the slice-2
  [hardening pass / follow-ups](finished/romantic-contact-affordances.followups.md)
  (complete 2026-07-31), the
  [adult declaration](finished/adult-eligibility.plan.md) (shipped 2026-07-30),
  and the pre-slice-3 foot facts + registration hardening (2026-07-30). Foot
  registry defaults, the Neon backfill, and deployment are **complete**, so
  production registration is no longer gated on corrections or data migration —
  only on reaching its place in the wiring order.
  Continuation order: affectionate integration proof with durable retake-safe
  persistence → actor control through the live lane → the explicit
  `romantic_touch` permission owner (**spec before implementation**; eight design
  decisions need owner rulings) → eligibility + blocker-link UI wiring → the
  romantic proof → channel-aware foot registration with positive texture/glide
  **last** (blocked on explicit visual/tactile perception channels, perceiver
  binding, structured path/cross-locus info, per-surface footwear friction).
  Then slice 4's atomic/idempotent contact-caused effects. Successor parity waits
  for regional pose/contact and clothing adapters. Intimate regions stay behind
  the foot proof plus explicit adult-eligibility, consent, exposure, and
  physiology prerequisites. The active doc family archives together only after
  the plan ships.

## Next (queued)

- **Data lifecycle — chat-scoped deletion, retention sweeps, intentional
  image orphans** — [data-lifecycle.plan.md](data-lifecycle.plan.md) ·
  [audit](data-lifecycle.audit.md) (next; planned 2026-07-29 from the live
  Neon + Fly orphaned-data audit, placed at the top as the security/privacy
  follow-through the owner asked to start with). Owner ruling: chat-flow data
  carries a real `chat_id` FK and dies with its chat; **images are the one
  deliberate exception** (rows/files survive chat *and* character deletion so
  the Gallery keeps them). Slices: one-time purge of the audited orphans
  (792 stale jobs, scope-less R6 memory rows, stale provisioning records…),
  `chat_id` FK columns on `jobs`/`events`/provisioning + backfill, deletion-path
  changes (drop `deleteEntityImages` on character delete), an in-process daily
  retention sweep (events/jobs/expired sessions + finally wiring the phantom
  `image_sweep`), and prod telemetry content minimization (retrieval queries
  are stored verbatim today). All four open questions ruled 2026-07-29
  (audit doc §Rulings): hidden chat-image kinds keep their hard-delete,
  events 30d / jobs 7d, prod telemetry ids+counts only, account deletion
  parked → deferred.plan.md.

**Successor world engine (`engine.plan.md`) — foundation AND rollout COMPLETE.**
All committed gates (0–6) closed 2026-07-16 → 2026-07-21, and the migration &
rollout plan (R0–R6) shipped 2026-07-21/22 — the engine is the live world
authority for successor chats and **the legacy world/session model is deleted**
(see the top of [roadmap.shipped.md](roadmap.shipped.md)). What remains on this
track: optional Gate 7 (below,
owner-gated), the owner-gated live eval spend (parked in
[deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs), and the
chat-lane meter-economy/body-needs ports through the Gate 5 contracts (queued
below). Full plan [engine.plan.md](engine.plan.md) · contract
[engine.spec.md](engine.spec.md). (Distinct build from the chat-lane
[world-engine-refactor.plan.md](world-engine-refactor.plan.md) north-star
umbrella further down.)

- **Codebase efficiency — correctness and measured-response tranche** —
  [audit](codebase-efficiency.audit.md) ·
  [resilience](resilience-closures.plan.md) ·
  [command hot path](sim-command-shell.plan.md) ·
  [contract lookups](contracts-hygiene.plan.md) ·
  [chat latency](chat-reply-latency.plan.md)
  (**next after the active narrator-physical-guidance files are quiet; selectively
  queued, not an eleven-plan cleanup epic**). Ordered: (1) resilience closures,
  including production garment-graph validation; (2) the cheap hot-path set —
  A11's single recorder-window read and E13/E14's immutable registry indexes
  (F2's missing `lint:authz` instruction already landed in `66ecd3b`); then
  (3) chat pre-reply latency after a repeated timing baseline. Each slice must
  preserve narrator output and committed state, except the explicitly approved
  diagnostic/degraded-validation behavior.

- **Body-attribute visual affordances — remainder: image decision,
  successor adapter, companion rulings** —
  [body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
  (**slices 0–4, slice 5 wiring, and slice 6 garment second domain +
  developer preview shipped 2026-07-28; slice 7 recognizable features +
  observer visual memory shipped 2026-07-29; slice 5 closed 2026-07-29** —
  the live comparison plus a three-round rematch campaign reached the frozen
  protocol's terminal state (two consecutive valid fails: cues never reduced
  contradictions — the working hypothesis, to be measured explicitly in the
  constraint-first follow-up, is that concrete cues make more checkable
  claims), so
  `CHAT_AFFORDANCE_CUES` **parks OFF, finally** — history in the
  [trial report](body-attribute-affordances.trial.md) §Rematch log; see
  [roadmap.shipped.md](roadmap.shipped.md); plan stays open until the release
  contract closes). **Slice 8 closed 2026-07-29 with a follow-up decision**:
  the general image consumer waits for the shared scene/body-relations owner;
  its promotion gate is a small paired trial, parked in
  [deferred.plan.md](deferred.plan.md#body-affordance-scene-image-consumer).
  What remains here: the successor-lane adapter follow-up named in the
  [audit source map](body-attribute-affordances.audit.md), and an explicit
  implemented/follow-up/parked ruling per companion spec before the plan
  closes. **Slice 7 ships production-inert**: chat asserts exposure only for
  garment-covered locations and hair, so bare skin reads unknown and
  recognition fails closed — a body-exposure owner (or an adapter overlay) is
  the prerequisite for the trial, and the attribute priors need a calibration
  pass behind it (plan §Open questions). The 2026-07-28 owner review settled
  nearly every open question
  (plan §"Rulings snapshot" — including the same-day "cues win"
  sensory-allowance ruling), headlined by a ruled **shared
  scene/body-relations owner** (pose · support · surface level · contacts ·
  impulses; chat ships it first) that unblocks hair adhesion, garment
  cling/drape, appendages, soft tissue, relative geometry, and the
  romantic-contact plan — it needs its own plan when scheduled. Wardrobe
  gap flagged by slice 6: nothing records garment fit (loose/fitted), which
  is the one change that lights up wet cling in production.
- **Clothing state graph — remainder: the `CHAT_GARMENT_CUES` tuning run, then slices
  7–8 (successor adapter, affordance integration)** —
  [clothing-state-graph.plan.md](clothing-state-graph.plan.md) (active; **slices 0–6
  shipped 2026-07-27**, see [roadmap.shipped.md](roadmap.shipped.md)). What remains:
  the owner-gated live-model comparison run that decides whether `CHAT_GARMENT_CUES`
  (narrator digest + garment cues, env flag, default OFF) flips on — tune
  contradiction/repetition/concrete-detail/extraction accuracy against the garment-name
  baseline first; the small pipeline change widening the extraction lane to ensemble
  members (they still mutate via the legacy bridge); slice 7 mapping the contracts onto
  successor items via `item-condition-v1`; and slice 8 integrating with body affordances
  (promoted 2026-07-28 — queued above).

- **Successor world engine — Gate 7: optional institutions & macro simulation** —
  [engine.gate7.institutions.md](engine.gate7.institutions.md) (draft). **Explicitly
  optional** (owner ruling 2026-07-21 — recorded in
  [finished/engine.rollout.plan.md](finished/engine.rollout.plan.md) §After
  completion). Its precondition — rollout R6 exited — was met 2026-07-22, so it
  is now unblocked but still opens only on the owner's call. Admit a package
  (employers, schools, housing, labor, markets, news, law, weather, factions…)
  only when a world type + scenario corpus justifies it and it declares its
  authority, LOD, laws, budget, and disable path.

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
- **Character schema improvements — facial realism + engine-shaped contracts** —
  [character-schema.plan.md](character-schema.plan.md) (draft; planned 2026-07-20 from an
  owner ask; position here is provisional). Two threads: the portrait studio's hardcoded
  beauty bias replaced by a descriptive `face.attractiveness` attribute (grotesque →
  stunning, per-value `imageGuidance` phrases — evaluative one-worders don't steer image
  models; descriptive vocabulary does) with the forge's identity-anchor machinery pulling
  structural fills toward the authored band; and the template-side fields the engine
  branch's shipped substrate can consume at migration while the chat lane uses them now —
  typed schedule `kind`s (retiring `inferScheduleKind`), `birthday`, the reserved
  `attraction` relationship axis, an authored `means` band, and consent-scope
  scaffolding (rulings 15/16).
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
- **Spatially controlled scene images — pose, depth, and character identity** —
  [spatial-scene-images.plan.md](spatial-scene-images.plan.md) (draft; planned
  2026-07-20 from the owner's exploration of procedural OpenPose/depth and
  consistent character rendering). Chat-first, detached image pipeline: one
  validated 3D spatial frame produces pose/depth/segmentation controls;
  Qwen/ComfyUI establishes structure, identity packs and masked repair preserve
  characters, and the same frame can later feed narrator reachability and motion.
  Graduates the self-hosted ComfyUI follow-up; Gate 0 is a measured
  workflow/license/cost spike.
- **RAG improvements** — [RAG-improvements.plan.md](RAG-improvements.plan.md)
  (draft; seven retrieval ideas under evaluation — the least-settled item here).
- **At-rest encryption — user chat content unreadable on Neon** —
  [at-rest-encryption.plan.md](at-rest-encryption.plan.md) (draft — planned
  2026-07-11 from an owner question; position here is provisional). App-side
  AES-256-GCM envelopes over both lanes' transcripts, memory rows, and derived
  sinks so Neon holds only ciphertext (key in Fly secrets); the load-bearing
  open ruling is D1 — encrypt fact/episode embeddings and move scoped
  similarity ranking app-side, since plaintext embeddings are invertible.
- **Codebase efficiency — later consolidation sequence** —
  [audit disposition](codebase-efficiency.audit.md#review-disposition-and-owner-rulings--2026-07-30)
  · [command shell](sim-command-shell.plan.md) ·
  [fork registry](sim-fork-registry.plan.md) ·
  [image pipeline](image-pipeline-consolidation.plan.md) ·
  [client safety](client-type-safety.plan.md) ·
  [library routes](library-route-registry.plan.md) ·
  [editor scaffold](editor-scaffold.plan.md) ·
  [contracts](contracts-hygiene.plan.md) ·
  [dead exports](dead-export-sweep.plan.md) ·
  [tooling](tooling-gates.plan.md)
  (draft; dependency order only, **not all promoted to next**). After the approved
  near-term tranche and the feature work above: command-shell consolidation →
  fork registry → image pipeline → client D10/D11/D12 → library registry/routes →
  `ConfirmDialog`, followed by a go/no-go on the full editor scaffold → broad
  contracts/dead-export/eval-tooling hygiene. Settled exclusions: no expanded
  snapshots without measurements, no suggested-item write batching, no D14 client
  cache, and no removal of `travel_minutes`. This replaces the stale 2026-07-02
  session-side follow-on line; surviving forge work is already owned by
  [character-schema.plan.md](character-schema.plan.md).

## Someday / parking lot

Unpromoted ideas live in [deferred.plan.md](deferred.plan.md): the
**successor-engine improvement backlog**
([deferred/CLAUDE.md](deferred/CLAUDE.md) — the still-parked remainder of the
2026-07-23/24 review batches, draft-plan stubs promoted one-by-one into real
plans/specs as discussed),
the **body-affordance scene-image consumer** (Slice 8's 2026-07-29 follow-up,
after the shared scene/body-relations owner or an explicitly scheduled narrow
paired trial),
the relationship &
meter timeline (UX-audit #4), the full **NPC-puppeting** system
([npc-puppeting.deferred.md](npc-puppeting.deferred.md) — only Slice 2's deflection
directive shipped), comms expansions, item acquisition during play, the remaining
UX-audit deferrals (transcript export #8, scene-image pin #9, first-run tour #10,
production-build perf pass §5), observer / god-mode POV, monorepo split (permanently
deferred), and companion-role-as-romance-eligibility (park, don't build).

## Shipped (historical record)

Moved to its own file to keep this index short — see **[roadmap.shipped.md](roadmap.shipped.md)** (newest-first).
