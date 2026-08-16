# Visual world map — plan

Status: **Superseded** (read-only force-directed graph); slices 2–3
(editable layout, play-screen minimap) deferred. Graduated from
[deferred.plan.md](../deferred.plan.md) 2026-06-16; bumped via the UX-audit (feature #5).

## Slice 1 — shipped (2026-06-18)

A read-only force-directed graph now replaces the flat Map list on `/worlds/:id`:

- **`src/lib/world-graph-layout.ts`** — a pure, dependency-free, **deterministic**
  Fruchterman–Reingold layout (circle seed → repulsion + edge springs → normalize into a
  fixed viewBox). Deterministic so renders are stable and the layout is unit-tested
  (`world-graph-layout.test.ts`). No stored positions ⇒ no schema change.
- **`src/components/worlds/world-map-graph.tsx`** — SVG render: locations as nodes, links as
  edges; a location with **no links renders in danger-red** with a count caption, so a
  stranded room is obvious at a glance (the audit-M2 motivation). Node hover (`<title>`)
  carries name + blurb; `role="img"` + a summary `aria-label`.
- **`world-detail-page.tsx`** — the Map section shows the graph; the old card list (with
  descriptions + adjacency) is preserved under a `<details>` "Location list" disclosure for
  accessibility/detail.

The editor map tab keeps its existing editable card UI (slice 1 is read-only; an editable
graph is slice 2).

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
([ux-audit.plan.md](../finished/ux-audit.plan.md) §2, which fixes the _cause_; this view
surfaces the _symptom_).

## Current state

The detail-page Map section lists location cards in a flat column (collapsed by
default because it grows unwieldy — `world-detail-page.tsx`), with adjacency shown
as per-card "↔ …" lists.

## Build slices

1. **Read-only, auto-laid-out graph** (force-directed) — proves the value with no
   schema change; positions are computed, not stored. Smallest first slice. **✓ shipped 2026-06-18.**
2. **Editable layout** (optional, later) — drag nodes; needs persisted positions.
3. **Play-screen minimap** (optional, later) — reuse the graph as an in-session
   minimap.

## Open questions

- **Read-only vs editable** layout — _resolved for slice 1_: shipped read-only (auto-layout).
  Editable layout is slice 2 if/when wanted.
- **Where node `x/y` live** — new per-location columns (a DB migration) vs
  auto-layout only (no storage). Slice 1 stores nothing (computed); revisit only when
  editable layout (slice 2) is actually wanted.
- **Minimap reuse** — does the play screen share this component? (Slice 3; `WorldMapGraph` is
  written generically — locations + links in — so the play screen could reuse it.)
