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
- **Sub-zone space is the big new subsystem** — representation is the core
  promotion-time decision: named anchors/waypoints ("by the hearth", "behind
  the counter") vs coordinates/grid, and what movement + line of sight consume
  from it. Facing and obstacles only mean something once that choice lands.
- **Ownership/residency/upkeep** wire into the existing household + currency
  machinery; upkeep needs a recurring-charge mechanism (trigger-scheduled, like
  arrivals) that doesn't exist yet.
- **Tripwire inherited from the sibling:** authored travel durations with
  nonzero uncertainty require the drain-hardening bundle (A5+A6+A7 —
  [arrival-target-mismatch.plan.md](arrival-target-mismatch.plan.md) ruling 4)
  to promote first.

## Open questions

- **Spatial fidelity:** how precise is "where in the room + facing"? Named
  anchors vs a coordinate grid; does line of sight consume geometry or
  anchor-to-anchor visibility rules?
- **Who owns within-zone position** — the engine (authoritative, replayable)
  or the narrator (prose-level staging)? New patterns prove out in the chat
  lane first (product direction), so what's the chat-lane proving ground for
  this?
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
