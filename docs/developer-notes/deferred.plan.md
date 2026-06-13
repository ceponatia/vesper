# Deferred — unplanned-but-good ideas

Status: **parking lot** — ideas worth keeping that don't belong to a phase
yet. Not a commitment, not priority-ordered. When an idea graduates, move it
into the relevant phase plan and delete it from here. This file is the anchor;
supporting detail files named `*.deferred.md` nest under it in the VS Code
workspace (the same nesting idea as `phase-N-plan.md`).

## Comms expansions

*Raised 2026-06-13, from the phase-3 presence open questions.* Phase-3 comms
ships single-pair only. Deferred, none designed:

- **Group calls / group texts.**
- **Voicemail content** — a missed call carrying a message that becomes a
  told-fact.
- **Persistent text-thread history** the player can reread — the first thing
  players will ask for, and a natural UI surface for the pending-messages
  mechanic.

See
[presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md)
§Gaps & opportunities.

## Item acquisition during play

*Raised 2026-06-13, from the location-design ownership ruling.* Spawn-time item
ownership ships with the location/ownership work (`owner_participant_id`,
written only at spawn). Deferred — needs its own design: characters **acquire**
items in play (purchases, gifts) that become owned at acquisition time, a
second provenance path the items model doesn't have yet.

See [location-design-spec.phase3.md](location-design-spec.phase3.md)
§Ownership.

## Visual world map (node/path graph)

*Raised 2026-06-13, from the `/worlds/:id` Map section.* The Map section on
the world detail page (and the editor's map tab) lists location **cards** in a
flat column. Production worlds will have many locations, so the column grows
unwieldy — for now the detail-page Map section is collapsed by default
(`world-detail-page.tsx`). The real fix is a **visual map**: render locations
as nodes and the undirected links between them as edges (a force-directed or
hand-layout graph), so adjacency is read at a glance instead of from
per-card "↔ …" lists. Open questions: read-only vs. editable layout, where
node positions are stored (new per-location `x/y`, or auto-layout only),
and whether the play screen reuses it as a minimap. Replaces the flat list,
not just decorates it.

## Observer / god-mode session POV

*Raised 2026-06-13, from the phase-3 presence open questions.* The
presence/perception design assumes a player POV; observer / god-mode
("omniscient") sessions have no player participant to anchor awareness
blocks to (followups.phase2.md #10). Omniscient mode is **less relevant
to this fork's romance scope**, but the user wants to support it
eventually. Needs its own think — likely narrator-omniscient with no
awareness blocks, but deferred rather than ruled. Phase 3 takes no
stance for observer sessions.

See [presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md).

## Tier as romance eligibility

*Raised 2026-06-13, brainstorm from the cast-tiers investigation.* Give the
`major` tier a second, gameplay meaning: **major-tier characters are the
session's valid romance targets.** `minor`/`extra` stay fully fleshed (forge,
facts, schedule, presence) but are background flavor — the narrator deflects or
gently redirects romance gestures aimed at them. Fits the romance-first fork:
romance leads already need the deepest simulation — wardrobe, meters,
per-character memory, perspective memories — that `major` alone grants, and the
~6-major soft cap doubles as a sane ceiling on romanceable cast. Companions
auto-promote to major (`cast-tiers.ts` `spawnTier`), so the obvious leads
qualify for free.

Romance would still gate on the **affinity edge**, not tier alone — the
`close`/`devoted` stages and the perceived-affinity model are the mechanical
substrate; tier just decides *who is eligible to climb that ladder at all*.

Open question worth resolving before tier grows runtime behavior: ride
eligibility on `tier`, or split a separate `romanceable` flag? Overloading tier
is cheap and matches the framing, but couples a *simulation-depth* ceiling to a
*gameplay-eligibility* gate — a deeply-simulated rival or relative you
deliberately can't romance becomes unrepresentable without demoting them. Note
this is the **first proposed behavior to branch on character tier at runtime**;
today nothing does (it is stored and displayed only).

See [cast-tiers-and-affinity-spec.phase3.md](cast-tiers-and-affinity-spec.phase3.md)
§Design: tiers.
