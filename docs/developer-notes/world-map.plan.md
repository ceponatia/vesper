# Visual world map — plan

Status: **next** (flagged a potential priority; not started) — graduated from
[deferred.plan.md](deferred.plan.md) 2026-06-16.

## Goal

Replace the flat location-card column on `/worlds/:id` (and the editor's map tab)
with a **graph**: locations as nodes, their undirected links as edges, so
adjacency is read at a glance. The data already exists (locations + links) — this
is largely a client-side render, not a model change.

The 2026-06-17 UX audit independently flagged this (feature #5) as the thing that
would have made **M2** obvious at a glance — a hot-spring world forged with **no
bath**, three location links pointing at a non-existent "The Grand Onsen Bath" that
went unnoticed in the flat card list. The audit recommends bumping this plan's
priority alongside the forge-canon reconciler
([ux-audit.plan.md](ux-audit.plan.md) §2, which fixes the *cause*; this view
surfaces the *symptom*).

## Current state

The detail-page Map section lists location cards in a flat column (collapsed by
default because it grows unwieldy — `world-detail-page.tsx`), with adjacency shown
as per-card "↔ …" lists.

## Build slices

1. **Read-only, auto-laid-out graph** (force-directed) — proves the value with no
   schema change; positions are computed, not stored. Smallest first slice.
2. **Editable layout** (optional, later) — drag nodes; needs persisted positions.
3. **Play-screen minimap** (optional, later) — reuse the graph as an in-session
   minimap.

## Open questions

- **Read-only vs editable** layout (slice 1 vs 2).
- **Where node `x/y` live** — new per-location columns (a DB migration) vs
  auto-layout only (no storage). Slice 1 needs no storage; defer this until
  editable layout is actually wanted.
- **Minimap reuse** — does the play screen share this component?
