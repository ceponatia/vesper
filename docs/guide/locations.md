# Creating locations

A location is a place a story happens in: a room, a street, a beach. Locations
are library entities like characters and items — build one once, reuse it, and
optionally share it.

## Making one

**Locations → New** (or open one to edit) opens the lean editor (**Details ·
Image** tabs). Everything is hand-editable; nothing is locked.

## Fields

- **Name** — the identifier shown in the library and used to ground links.
- **Description** — the prose describing the place.
- **Ambient** — three optional sensory lines: **scent**, **sound**, **light**.
  These seed the atmosphere without you having to repeat them in the description.
- **Tags** — lowercase search/grouping labels.
- **Scale** — how big the space is: **intimate** (closet, car), **room**,
  **hall** (warehouse, great hall), **open** (street, plaza), **expanse** (beach,
  fields). Scale drives the generated **image** — `open`/`expanse` render as an
  outdoor landscape, everything else as an architectural interior.
- **Area** — an optional map-grouping label (e.g. `harbor-inn`), stored on the
  location for organizing related places.

## Connections

Locations are joined by an **undirected** graph — a link works both ways. In the
editor, "Connects to" shows current links as removable tags; add one from the
picker (it only offers places not already linked, and never itself). If you add
the reverse of an existing link, the editor tells you they're already connected.
Connections persist as `location_links` rows.

## Image

The **Image** tab generates an establishing shot from the location's fields (its
type follows the **scale** — landscape vs interior), with click-to-enlarge and a
Regenerate button. Generation runs as a background job, so leaving the page never
interrupts it.
