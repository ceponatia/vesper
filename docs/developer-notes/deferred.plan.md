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
