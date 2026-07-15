# Multi-character (the ensemble)

A conversation holding up to four full characters: the roster, narrative presence,
the ensemble prompt frame, and the per-conversation relationship matrix.

## Multi-character (the ensemble)

A conversation holds up to **4 full characters**
([developer-notes/multi-character-chat.plan.md](../developer-notes/finished/multi-character-chat.plan.md) +
the matrix slice of
[developer-notes/relationship-model.plan.md](../developer-notes/finished/relationship-model.plan.md),
both shipped 2026-07-12). A roster of one is byte-identical to the classic 1-on-1
(asserted in `prompts/character-chat.test.ts`); everything below arms only at roster > 1.

- **Roster** (`chat_participants`, sort 0 = primary): created multi-select or grown later —
  `POST /api/chats/:id/participants` (cap 4, D7 memory choice per joiner),
  `DELETE …/participants/:characterId` (never the last member; a removed primary's heir
  promotes via sort renumber — state + memory stay), `PATCH …/participants/:characterId`
  `{presence}`. The roster panel (`chat-roster-panel.tsx`, desktop aside + the menu's
  Roster sheet) is the manual present/away override and add/remove surface.
- **Presence, not location** (`character_chat_state.presence`): *present* shares the
  player's scene, *away* is offstage living their life — meters **freeze** (presence gates
  the drift tick; no catch-up), no memory legs, reachable by text/call, never teleported
  in. The archivist's roster-gated 9th field confirms transitions the fiction actually
  played; `quiet_exchanges` counts activity recency (deterministic stamping —
  `mentionsCharacter`/`spokeInReply` in `chat-intent.ts` — reset by a name/alias mention
  or a tagged spoken line), and for away members it doubles as the tier-3 salience window.
- **Ensemble prompt** (`buildChatPromptPartsForRoster` → `buildEnsembleChatPromptParts`):
  one continuous narrative, the narrator omniscient over the roster; THIRD-person member
  sheets (full / quiet-compressed at `ENSEMBLE_QUIET_EXCHANGES` / away-dropped while
  anyone is present, cutaway sheets when nobody is), `ENSEMBLE_CHAT_RULES` (universal
  `[Name]` tag discipline — nothing auto-attributes in a group; characters alive to each
  other; presence law), and the ruling-3 authority block: the player is never written, and
  with no character present the reply is a **cutaway**. The §9 prefix/tail cache split
  survives (sheets re-render on roster/presence/tier/band change).
- **Scoped dynamics**: the reaction pulse runs **referenced-only** (members the player's
  turn names; the primary as anchor fallback when nobody is), resolving reactions against
  the SCENARIO's setting-wide card set (ruling 9); tier-1 **memory legs** run per
  present + recently-active member against their OWN group with per-leg k tightened by
  the active count; the ONE archivist extraction files to **every present witness's**
  group.
- **Per-member note-takers + folds** (rulings 10–11): the shared archivist keeps the
  scene-level reads (episode, facts, queries, scene, presence); every PRESENT member gets
  a small **personal pass** (`runChatPersonalNotes`, `prompts/chat-personal-notes.ts` —
  openLoops / outfit / attributeChanges / driveUpdates) folded into their own row, and
  everyone who **pulsed** gets the deterministic folds (relationship-arc samples,
  milestones, weather via the pulse) through the pure `settleEnsembleMember`. The classic
  1-on-1 keeps the single combined archivist call — no cost regression.
- **Group perks** (ruling 12): a selfie request routes to the member the message
  **addresses by name** (unaddressed falls to the lead; offers stay lead-gated) — their
  ring burns, their identity renders; the remember-when **callback** draws from ONE
  member's own group (addressed else most-recently-active present), gated on their ring
  and toned by their regard; **sensory focus** aims at the member the message studies;
  disinhibition + condition-driven transient appearance render **per present member** in
  the ensemble tail. The `turn_context` layout stays 1-on-1-only.
- **Per-character sheets** (ruling 13): tapping a roster member opens THEIR Character
  sheet (axes/texture toward the player, meters, conditions, mind note, loops, outfit +
  exposure, presence toggle); the state routes take `?characterId=` targeting. The
  Scenario modal holds only the chat-wide fields (premise, presets, house rules,
  auto-scene + scene model).
- **Plan-driven arrivals & exits** (chat-plans-promises.plan.md Slice 3): a chat-wide plan
  ([state.md](state.md) §Plans & promises) that is DUE/imminent is the fiction's own reason
  to move a character — `buildPlanPresenceLicense` (ensemble tail) grants the presence law's
  ONE principled exception to the don't-teleport guard: a plan involving an **away** roster
  member licenses their narrated **arrival** (the plan is why they show up), and a plan
  happening now that does NOT involve the player, involving a **present** member, licenses
  their **exit** ("her shift starts"). Group plans share due-ness + directives; consequences
  stay **per-character** (each stood-up participant reacts through their own state row).
  NPC↔NPC plans skipped past default to assumed-kept (ruling E, until the meanwhile pass) and
  reach the story as conversation material / relationship facts.
- **Relationship matrix** (`character_chat_relationships`, directed rows): per-conversation
  NPC↔NPC records seeded at creation/join from the library defaults
  (`character_relationships` — the character editor's **Relationships tab**), edited
  per-pair in the Roster sheet (`chat-relationships-editor.tsx`: kind/history shared-cell,
  stances mirrored behind an Asymmetric toggle). Injection follows the presence × salience
  tiers: present×present pairs render prefix law lines; a **salient** away member
  (mentioned in-window or edge-flagged *looming*) gets a volatile conditional block under
  the don't-teleport guard; silent away members render nothing. NPC↔NPC records are static
  authored texture in v2 — lived shifts reach the narrator through archivist relationship
  facts.

