# Creating locations

A location is a place the story happens in: a room, a street, a beach. Locations
are library entities like characters and items — build one once, reuse it across
worlds — but most of the time you'll author them inside a world's **map**.

## Two ways in

- **Locations library** (`Locations → New` / open one to edit) — a standalone
  place you can reuse and share. Good for a signature setting you want in several
  worlds.
- **Inside a world** — the world forge drafts a map for you, and the world
  editor's **Map** tab is where you'll do most location work (the forge review UI
  *is* that editor). A world keeps its own copy of every location, so editing a
  location inside one world never touches the library row or any other world.

## Fields

- **Name** — the identifier shown on the map and in the story. Names are never
  rewritten by the engine (a `{{player}}` token in a name stays literal); keep
  them stable, because links and start-locations point at them by name.
- **Description** — the prose the narrator sees. `{{player}}` *is* resolved here.
- **Ambient** — three optional sensory lines: **scent**, **sound**, **light**.
  These seed the atmosphere without you having to repeat them in the description.
- **Tags** — lowercase search/grouping labels.
- **Scale** — how big the space is: **intimate** (closet, car), **room**,
  **hall** (warehouse, great hall), **open** (street, plaza), **expanse** (beach,
  fields). Scale sets how far apart two people start when they share the room —
  only **open**/**expanse** let someone be a distant silhouette; everywhere else
  co-located means within reach.
- **Area** — an optional grouping label (e.g. `harbor-inn`). Locations in the
  same area are treated as ~1 minute apart; crossing to a different area defaults
  to ~10 minutes. Use it for rooms inside one building.

## Connections

Locations are joined by an **undirected** graph — a link works both ways. In the
editor, "Connects to" shows current links as removable tags; add one from the
dropdown (it only offers places not already linked, and never itself). If you add
the reverse of an existing link, the editor tells you they're already connected.

Every location should be reachable from the others. The map view flags an
**orphan** (a place with no links) in red, and the forge refuses to leave the map
disconnected — a stranded cluster gets auto-joined to the main map with an amber
notice you can then rewire.

## Forging a map

In the world forge, the **Locations** agent drafts the number of locations you
asked for (0–5) with descriptions, ambient, scale, tags, and a connection graph,
plus a suggested player start. If it links to a place it never created, that link
is dropped with an actionable diagnostic — and the review UI offers a one-click
**"Create location"** that mints the missing place and reconnects whatever pointed
at it. Each location can be edited or the whole map regenerated.

## Library → world

When you add a library location to a world, the world **copies** it: your edits
in the world become world-local overrides baked into the world's own snapshot.
The link back to the library row is kept only as provenance — so the source can
be edited or deleted without breaking any world that used it. (One limitation:
container-nesting between world items isn't carried through a world edit-save.)

## On the world page

The world detail page draws the map as a force-directed graph (orphans in red),
with a collapsible location list underneath. From there, **Edit** reopens the Map
tab.
