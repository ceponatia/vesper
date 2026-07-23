# Location builder — authored locations beyond the entity library

Status: draft (stub — parked 2026-07-23, owner request recorded alongside
[travel-duration-authoring.plan.md](travel-duration-authoring.plan.md);
promote per [CLAUDE.md](CLAUDE.md) before building)

## What

Owner direction (2026-07-23): a system to **build locations** as world
configuration. Similar in spirit to the legacy world model's location entities
(deleted with R6), but explicitly **NOT part of the entity library** —
locations are authored world structure carrying technical fields the library
never had:

- **travel time to connected locations** — the sibling stub
  [travel-duration-authoring.plan.md](travel-duration-authoring.plan.md); the
  two may fold into one world-authoring plan at promotion;
- **furniture and items the location contains** at authoring time;
- **a spatial model within the location**: where characters/the player are in
  the space and **which way they're facing**;
- **item positions and obstacle flags**, feeding **movement and line-of-sight
  tracking**;
- **owners (household)** and **residents** where applicable;
- **upkeep cost** (economy hook);
- **function typing** — workplace, shop, home, etc.

## What the engine already models (evidence 2026-07-23 — re-verify at promotion)

Runtime state exists for much of this but has **no authoring surface** and
stops at **zone granularity**:

- `sim_locations` (kind, map x/y, access policy), `sim_zones` (kind, parent
  zone, occupancy limit, privacy), `sim_links` (modes, minimum duration,
  schedule windows, open/closed/locked/blocked state) — `schema.ts:1615-1700`;
- items already sit in zones and containers (`locusKind`:
  held/worn/container/zone/gone — `schema.ts:1273`) but have **no within-zone
  position and no obstacle semantics**;
- households already model ownership and residency (`sim_households`
  `residenceZoneIds` + members with roles, stock access policies —
  `schema.ts:2620+`) — authoring **wires** them, it doesn't invent them;
- currency already exists as a reserved household material kind with unit
  prices on purchases (`contracts/simulation/households.ts:103-118, 222-223`)
  — an upkeep cost has a real charging hook, but no recurring-charge mechanism
  exists;
- actor position is zone-granular (`physicalLocus` at/in_transit —
  `contracts/simulation/space.ts:139-151`): **no facing, no within-zone
  coordinates**;
- perception/witnessing grades by zone/location co-presence
  (`lib/simulation/perception.ts:118-145`) — line of sight would refine an
  existing system, not create one.

So the genuinely new ground is: the **authoring/builder surface itself**, the
**sub-zone spatial model** (positions, facing, obstacles, line of sight),
**furniture** as a first-class placed-thing, **function typing** as a
registry, and **recurring upkeep**.

## Owner rulings (2026-07-23 — copy into engine.spec §39 at promotion)

1. **Spatial model: named spots now, 3D later.** v1 is named spots ("by the
   hearth", "behind the counter") designed from day one as the top layer of a
   future 3D space: stable spot IDs, **optional coordinate fields left empty**,
   and hand-authored spot-to-spot sight/adjacency rules. Going 3D later means
   filling in geometry **underneath** existing spots and computing visibility
   instead of hand-authoring it — an enrichment, not a rewrite.
2. **Long-term destination is a graphical game.** The prose era has a horizon:
   if models get fast enough, the product may be promoted to a **graphical
   game with AI control of NPCs**. 3D space is the destination; named spots
   are the on-ramp and the prose-facing vocabulary while the game is
   prose-led — not a permanent ceiling.
3. **Spatial translation is split by direction, on latency grounds**
   (refined 2026-07-23 from "an agent parses coordinates for the narrator").
   The narrator never parses coordinates in either era. **Outgoing** —
   spots/coordinates → narrator-usable terms (nearest spot, distance bands,
   relative facing, occlusion) — is **deterministic code** on the pre-turn
   path: pre-turn work sits between user input and narrator output, so it
   must be instant; code is also replayable and cannot hallucinate geometry.
   **Incoming** — narrative prose → position updates and their legality —
   is **post-turn agent work**: post-turn agents run asynchronously and are
   allowed to be slow because they don't meaningfully delay the chat.
   Consequence to design for at promotion: positions settle one turn behind
   the prose that moved them, so a post-turn legality rejection surfaces as
   next-turn correction/drift-repair, not an in-turn refusal.
4. **When to go 3D:** when something real consumes the precision — a rendered
   map view, true pathfinding, distance-based mechanics, or the
   graphical-game promotion itself.

Context for ruling 1 (assessment behind the recommendation, kept for
reference): nothing consumes coordinates today (no renderer, no pathfinding —
the consumers are the narrator, movement legality, and zone-granular
witnessing, all served by spots + authored visibility rules); 3D's real cost
is **geometry authoring** for every location in every world, falling hardest
on player world-builders; and the legacy world model's failure mode was
mechanical ambition outrunning the narrative — spots keep spatial fidelity in
service of the story until ruling 4's trigger arrives.

## Why it matters

The location builder is the backbone of the bespoke + player-built worlds
direction: every other authoring idea (travel durations, seeded life,
households, shops/workplaces, economy) hangs off having locations someone
actually built. The sub-zone spatial model is also the engine's next fidelity
jump — perception, movement, and staging all sharpen once "where in the room,
facing what" exists.

## Sketch

- **Authoring surface, not entity library:** config/seed data for bespoke
  first-party worlds first; a builder UI later for player-built worlds (same
  two-source framing as the sibling stub).
- **Vocabulary as registries, not migrations** (project rule): location
  function types (home/shop/workplace/…), furniture kinds, and obstacle flags
  should be registry data edits; schema fields modeled with headroom for the
  known-future capabilities listed above even where v1 uses one case.
- **Sub-zone space per ruling 1:** named spots with stable IDs, optional
  coordinate fields, and hand-authored sight/adjacency rules; facing and
  obstacles are expressed against spots in v1 and against geometry after the
  ruling-4 trigger. The engine owns position authoritatively; the ruling-3
  seam — deterministic read-out pre-turn, async agent write-back post-turn —
  is the narrator's window into it.
- **Ownership/residency/upkeep** wire into the existing household + currency
  machinery; upkeep needs a recurring-charge mechanism (trigger-scheduled, like
  arrivals) that doesn't exist yet.
- **Tripwire inherited from the sibling:** authored travel durations with
  nonzero uncertainty require the drain-hardening bundle (A5+A6+A7 —
  [arrival-target-mismatch.plan.md](arrival-target-mismatch.plan.md) ruling 4)
  to promote first.

## Open questions

_(Spatial fidelity, geometry-vs-rules line of sight, and engine-vs-narrator
position ownership were resolved by the 2026-07-23 rulings above.)_

- **Chat-lane proving ground:** new patterns prove out in the chat lane first
  (product direction) — what's the smallest chat-lane surface for named spots
  (staging in the state strip? spot mentions in beats?)
- **Furniture:** items with an immovable/obstacle flag, or a distinct
  furniture registry with its own placement rules (containers, surfaces,
  seats)?
- **Upkeep:** what does it charge (household currency stock?), on what cadence
  (story-time trigger?), and what happens on failure to pay — is that a
  commitment/consequence hook?
- **Fold or split:** do this and
  [travel-duration-authoring.plan.md](travel-duration-authoring.plan.md)
  graduate as ONE world-authoring plan, or does travel-duration ship first as
  the thin end?
- **Starter worlds:** does the builder replace the hand-seeded starter world
  (and B8 [starter-world-seeds.plan.md](starter-world-seeds.plan.md)'s seeds
  become its first authored content), or do seeds stay a separate lane?

## Slices

_(Defined at promotion.)_
