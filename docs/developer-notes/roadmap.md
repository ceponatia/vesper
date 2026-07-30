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

_(Nothing active — pick up the top of Next.)_

## Next (queued)

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

- **Body-attribute visual affordances — remainder: image decision,
  successor adapter, companion rulings** —
  [body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
  (**slices 0–4, slice 5 wiring, and slice 6 garment second domain +
  developer preview shipped 2026-07-28; slice 7 recognizable features +
  observer visual memory shipped 2026-07-29; slice 5 closed 2026-07-29** —
  the live comparison plus a three-round rematch campaign reached the frozen
  protocol's terminal state (two consecutive valid fails: cues never reduced
  contradictions because concrete cues make more checkable claims), so
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
- **Constraint-first narrator physical guidance — constraints, premise correction,
  and resolved action outcomes** —
  [narrator-physical-guidance.plan.md](narrator-physical-guidance.plan.md)
  (next; planned 2026-07-29 from the closed positive-cue trial and sequenced
  directly before romantic contact). Keeps the affordance calculations but
  replaces always-on descriptive suggestions with scoped consistency
  constraints, high-confidence false-premise fences, and mandatory resolved
  action outcomes. Positive state-change details get a separate flag and trial;
  generic ambient opportunities stay parked. No extra model leg. The hair
  proving slice leads, then the foot-contact resolver consumes the shared
  action-outcome seam. `CHAT_AFFORDANCE_CUES` remains off.

- **Romantic contact affordances — foot-first grounded contact** —
  [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md) ·
  [spec index](romantic-contact-affordances.spec.md) (next; promoted from deferred
  2026-07-28, sequenced directly behind the body-attribute plan whose core it
  consumes). Committed scope is slices 0–4: the truth-source audit, the shared
  attempted-versus-active contact lifecycle with actor-control/permission gates,
  the foot domain (surface map, footwear filtering, pressure/texture and
  substance-specific glide; warmth only with an authoritative source),
  legacy-romantic-chat cue evaluation behind a flag, and atomic/idempotent
  contact-caused effects. Successor parity waits for regional pose/contact and
  clothing adapters. Intimate regions stay behind the foot proof plus explicit
  adult-eligibility, consent, exposure, and physiology prerequisites. The active
  doc family archives together only after the plan ships.
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
