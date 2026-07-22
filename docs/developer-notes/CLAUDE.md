# developer-notes folder instructions

This folder contains plan and spec files for development phases. Whenever possible, keep these documents up-to-date. When we develop something that conflicts with planned work, please update the planned work to reflect what has changed.
If a complete reanalysis and rewrite of the planned work is needed due to other changes in code, say so in the relevant document. Do not do this analysis unless asked to, but tell the user in your response that it is needed.

## Engine gate docs (split 2026-07-21)

The successor-engine plan and spec are split so no single file has to be read or
edited whole:

- **One doc per gate: `engine.gateN.<slug>.md`** (e.g. `engine.gate6.dual-lod.md`),
  where the slug names what the gate delivers. Each holds that gate's full plan
  section — scope, build order, and the shipped E-package histories.
  [engine.plan.md](engine.plan.md) stays the hub: goals, the gate index table
  (one-line status + link per gate), dependency order, and cost/quality material.
  **Future gates get their own file at planning time** (Gate 7 already has one) —
  never grow a new gate inline in the hub. Gate numbers in filenames are NOT the
  deprecated `phase-N` pattern: gate numbers are stable architectural identities
  (each gate's exit gates the next; they can never be resequenced), so the name
  encodes *what*, not a reorderable *when*.
- **The spec is split by §-cluster: `engine.spec.<cluster>.md`** (kernel / world /
  mind / bodies-materials / lod / operations). Section numbering is GLOBAL across
  the set and never renumbers; [engine.spec.md](engine.spec.md) is the
  authoritative § → file index. Keep citing sections as "engine.spec §N" in code
  and docs — the index resolves them. A new section joins the file owning its
  range; a genuinely new domain gets a new cluster file plus an index row. Owner
  rulings stay in §39 (engine.spec.operations.md).
- When finishing gate work, update: the gate doc (status + package history), the
  hub's gate index row, and roadmap.md — in that order of detail (full record in
  the gate doc, one line in each index).

## App Development State

Vesper is a fork of Reverie, a role playing game. Vesper is more romance focused while Reverie is general.
Vesper began with a "World Model" system which had characters, locations, items, etc. and attempted to use map locations and schedules to have NPCs move around the world. This system became somewhat _broken_ and we weren't able to get characters to move to locations in a timely fashion to keep the story going, which broke the narrative aspect of the game.
Because of this, we stepped back and created a 1-on-1 character chat which was initially run from within Character forms in the library. This worked quite well and after further development, we broke it out into its own flow and added multiple character chats to it. It lacks some features the World Model had such as locations-as-entitites and map navigation, but narratively it is greatly expanded over the World Model.
The World Model system is now fully retired. Its successor — the simulation engine built gate-by-gate under [engine.plan.md](engine.plan.md) (gates 0–6) — rolled out through [finished/engine.rollout.plan.md](finished/engine.rollout.plan.md) (R0–R6), and R6 (2026-07-22) deleted the legacy world/session-model code and database tables outright.
Two lanes remain: legacy character chat (the live product for ordinary chats) and successor chats — a character chat bound to its own simulated world, created from the `/worlds` front door, with the engine authoritative per the `engine_authority` flag. New patterns still prove out in the chat lane first.
