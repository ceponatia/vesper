# developer-notes — legacy holding area

Work state left this folder for GitHub on 2026-08-26 (issue #206): the
[Vesper Development board](https://github.com/users/ceponatia/projects/7) and
its issues own plans, status, sequencing, dependencies, and open questions.
What remains here is awaiting issue #280's restructure into
`docs/architecture/`, `docs/systems/<area>/`, and `docs/decisions/`.

Invoke the `vesper-docs` skill before any edit here. Rules while this folder
exists:

- **Create nothing here.** New work of any size is a parent issue on the board;
  new durable law is a reference page under `docs/` (skill template
  `reference-doc.md`).
- **Never update a `*.plan.md`.** Plan files are frozen artifacts; the issues
  seeded from them (#207–#232) own their live state, and recording progress in
  a plan re-creates the drift the migration removed. They are retired wholesale
  by #280, not edited or deleted piecemeal.
- **Specs here are still live technical contracts.** Edit them when behavior
  changes, applying the no-dynamic-state rule to every section you touch:
  strip `Status:` lines, slice numbers, "remaining work", and blocker notes
  from what you edit, and add none.
- **Trial and evidence docs stay intact** until #280 rules on their durable
  home.

## App Development State

Vesper is a fork of Reverie, a role playing game. Vesper is more romance
focused while Reverie is general.

Vesper began with a "World Model" system which had characters, locations,
items, etc. and attempted to use map locations and schedules to have NPCs move
around the world. This system became somewhat _broken_ and we weren't able to
get characters to move to locations in a timely fashion to keep the story
going, which broke the narrative aspect of the game.

Because of this, we stepped back and created a 1-on-1 character chat which was
initially run from within Character forms in the library. This worked quite
well and after further development, we broke it out into its own flow and added
multiple character chats to it. It lacks some features the World Model had such
as locations-as-entities and map navigation, but narratively it is greatly
expanded over the World Model.

The World Model system is now fully retired. Its successor — the simulation
engine built gate-by-gate through gates 0–6 — rolled out through releases
R0–R6, and R6 (2026-07-22) deleted the legacy world/session-model code and
database tables outright.

Two lanes remain: legacy character chat (the live product for ordinary chats)
and successor chats — a character chat bound to its own simulated world,
created from the `/worlds` front door, with the engine authoritative per the
`engine_authority` flag. New patterns still prove out in the chat lane first.
