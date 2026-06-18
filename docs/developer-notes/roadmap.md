# Roadmap

The single ordered index of development plans. **Order here is the only place
priority lives** — reprioritizing is a one-line move, never a file rename (see
`CLAUDE.md` → working-docs convention, and [deferred.plan.md](deferred.plan.md)
§"Plan docs: drop hard phase numbers").

Status legend: **draft** (not settled) · **next** (queued) · **active** (in
progress) · **shipped — <date>** · **parked**.

> The ordering below is a starting proposal — **reorder it to match your real
> priorities.** Each entry links its plan; the plan links its spec/detail.

## Active (building now)

1. **Scene images — multi-reference & providers** —
   [scene-images.plan.md](scene-images.plan.md) · spec
   [scene-images.spec.md](scene-images.spec.md). Provider-capability layer +
   `image_references` join table; SFW + intimate multi-ref lanes; ComfyUI research.
2. **Character chat — sessionless 1-on-1** —
   [character-chat.plan.md](finished/character-chat.plan.md). Talk to a saved library
   character directly (no world/session/RAG) to tune how it voices its attributes.
   Route → client → Chat tab + manual scene button + Gallery surfacing wired;
   remaining: live smoke test + deferred model picker / auto-scene.

## Next (queued — proposed order)

- **UX-audit remediation** — [ux-audit.plan.md](ux-audit.plan.md). Triage + dispatch of
  the 2026-06-17 end-to-end audit. Headline net-new item: PM's **world-forge intake fields**
  (player-character pick / inline-forge / observer default + auto-generate counts). Also:
  forge-canon reconciler (M1/M2), artwork-progress surface (M7), contrast/high-contrast theme
  (M6), the post-`done` session-lock window (M3), intake-budget + dev turn HUD (M5), and a
  quick-wins polish batch. Routes the map view → world-map, M4 → movement-authority, and the
  meter/affinity timeline + transcript-export / scene-cover / first-run-tour →
  deferred.plan.md. **Reorder this slot to taste.**

3. **Visual world map** — [world-map.plan.md](world-map.plan.md). Flagged a
   potential priority. Read-only force-directed graph of locations first.
4. **World simulation ("the world moves")** — the former "phase 5" cluster, not yet
   started; specs drafted: [movement-authority.spec.md](movement-authority.spec.md),
   [scheduled-arrivals.spec.md](scheduled-arrivals.spec.md),
   [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md). Needs a
   `world-simulation.plan.md` when it becomes active.
5. **RAG improvements** — [RAG-improvements.plan.md](RAG-improvements.plan.md)
   (draft; seven retrieval ideas under evaluation).
6. **Intimacy notes** — [intimacy-notes.plan.md](intimacy-notes.plan.md) · spec
   [intimacy-notes.spec.md](intimacy-notes.spec.md) (draft). Third species/heritage
   note (`intimacy`) + per-character disposition, surfaced to the narrator only at
   the intimate exposure tier.
7. **Personality & evolving state** — plan
   [personality-and-state.plan.md](personality-and-state.plan.md) · spec
   [personality-and-state.spec.md](personality-and-state.spec.md) (plan **next** — v1
   fully spec'd, all gating questions resolved). v1 is the
   **authored likes/dislikes loop** (spec §6) — the intake agent concept-tags a
   player's act and a deterministic, **affinity-aware** curve decides the reaction, so
   the narrator is *told* the verdict instead of improvising it. Later slices add
   atomic personality **traits** (a registry parallel to attributes) and a new `mood`
   state that parameterise how each character's transient states (`affinity`/`arousal`/
   `stress`) drift and react over time. Subsumes the affinity trait-coupling and likely
   folds in Intimacy notes (intimate traits).
8. **Social-reaction cards** — plan
   [social-reaction-cards.plan.md](social-reaction-cards.plan.md) (draft). Importable
   **taboo / social-rule cards** (library content, reusable across worlds like items) that
   resolve deterministically with per-character **tag overrides**, feeding the personality
   §6 reaction seam and the witnessed-breach reactions. Replaces today's freeform
   `world.style.norms`. Sequenced **after** the personality §6 seam (#7 Slice 1); can run
   in parallel with its later slices.

## Someday / parking lot

Unpromoted ideas live in [deferred.plan.md](deferred.plan.md): comms expansions,
item acquisition during play, monorepo split (permanently deferred), observer /
god-mode POV, companion-role-as-romance-eligibility (park, don't build).

## Shipped (historical record — `phase-N` docs left as-is)

- **Non-human species & body features** —
  [non-human-species.plan.md](finished/non-human-species.plan.md) · spec
  [non-human-species.spec.md](finished/non-human-species.spec.md), shipped 2026-06-18.
  8-species catalog + wings/horns/tail morphology, image-gen feature surfacing on
  every route, species/heritage editor controls + forge inference. Leftovers
  (wardrobe accommodation, incremental species-rule data) tracked in the plan.
- **Phase 4 — the body model** (intimate anatomy, sensory, species scaffolding) —
  [phase-4-plan.md](finished/phase-4-plan.md), shipped 2026-06-14.
- **Phase 3 — presence & perception v1** — [phase-3-plan.md](finished/phase-3-plan.md).
- **Phase 2** — [phase-2-plan.md](finished/phase-2-plan.md).
- **Phase 1 — foundation** — [phase-1-plan.md](finished/phase-1-plan.md) (+
  [multi-character-phase-1-plan.md](finished/multi-character-phase-1-plan.md)).
