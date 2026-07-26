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
([deferred/CLAUDE.md](deferred/CLAUDE.md) — 16 reviewed items parked
2026-07-23 + 11 more from the 2026-07-24 successor-chat product review, all
draft-plan stubs promoted one-by-one into real plans/specs as discussed),
the relationship &
meter timeline (UX-audit #4), the full **NPC-puppeting** system
([npc-puppeting.deferred.md](npc-puppeting.deferred.md) — only Slice 2's deflection
directive shipped), comms expansions, item acquisition during play, the remaining
UX-audit deferrals (transcript export #8, scene-image pin #9, first-run tour #10,
production-build perf pass §5), observer / god-mode POV, monorepo split (permanently
deferred), and companion-role-as-romance-eligibility (park, don't build).

## Shipped (historical record)

Moved to its own file to keep this index short — see **[roadmap.shipped.md](roadmap.shipped.md)** (newest-first).
