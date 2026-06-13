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

## Companion role as romance eligibility

*Raised 2026-06-13, brainstorm from the cast-tiers investigation.* Use the
existing cast **`role`** field (not tier) to designate romance targets:
**`role: companion` characters are the session's valid romance targets;
`role: npc` are not.** `npc`s stay fully fleshed (forge, facts, schedule,
presence) but are background flavor — the narrator deflects or gently redirects
romance gestures aimed at them. This keeps `tier` (`major`/`minor`/`extra`)
free for its existing job — *simulation/narration depth* — orthogonal to who
can be romanced.

It rides machinery that already exists: `spawnTier` auto-promotes a `companion`
authored `minor` to `major` (`cast-tiers.ts`), so romance leads already get the
deepest simulation — wardrobe, meters, per-character memory, perspective
memories — for free, while a background `npc` sits at whatever tier its world
texture needs. Romance would still gate on the **affinity edge**, not the role
alone — the `close`/`devoted` stages and the perceived-affinity model are the
mechanical substrate; the `companion` role just decides *who is eligible to
climb that ladder at all*.

Note this gives `role` a concrete gameplay meaning. The cast-tiers spec today
calls `role: companion | npc` "an authoring/POV distinction, not a simulation
one" — this would make it the **first behavior to branch on `role` at runtime**
(nothing branches on role *or* tier today). Tradeoff to weigh: a non-companion
you later want romanceable must be re-cast as a `companion` (or we add a
separate `romanceable` flag); coupling to the existing role is cheapest and
matches the framing.

See [cast-tiers-and-affinity-spec.phase3.md](cast-tiers-and-affinity-spec.phase3.md)
§Problem (role definition) and §Design: tiers.
