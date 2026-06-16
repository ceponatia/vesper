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
2. **Non-human species & body features** —
   [non-human-species.plan.md](non-human-species.plan.md) · spec
   [non-human-species.spec.md](non-human-species.spec.md). Catalog + morphology
   shipped; remaining: image-gen feature surfacing, richer species rules, wardrobe,
   lore.

## Next (queued — proposed order)

3. **Visual world map** — [world-map.plan.md](world-map.plan.md). Flagged a
   potential priority. Read-only force-directed graph of locations first.
4. **World simulation ("the world moves")** — the former "phase 5" cluster, not yet
   started; specs drafted: [movement-authority.spec.md](movement-authority.spec.md),
   [scheduled-arrivals.spec.md](scheduled-arrivals.spec.md),
   [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md). Needs a
   `world-simulation.plan.md` when it becomes active.
5. **RAG improvements** — [RAG-improvements.plan.md](RAG-improvements.plan.md)
   (draft; seven retrieval ideas under evaluation).

## Someday / parking lot

Unpromoted ideas live in [deferred.plan.md](deferred.plan.md): comms expansions,
item acquisition during play, monorepo split (permanently deferred), observer /
god-mode POV, companion-role-as-romance-eligibility (park, don't build).

## Shipped (historical record — `phase-N` docs left as-is)

- **Phase 4 — the body model** (intimate anatomy, sensory, species scaffolding) —
  [phase-4-plan.md](phase-4-plan.md), shipped 2026-06-14.
- **Phase 3 — presence & perception v1** — [phase-3-plan.md](phase-3-plan.md).
- **Phase 2** — [phase-2-plan.md](phase-2-plan.md).
- **Phase 1 — foundation** — [phase-1-plan.md](phase-1-plan.md) (+
  [multi-character-phase-1-plan.md](multi-character-phase-1-plan.md)).
