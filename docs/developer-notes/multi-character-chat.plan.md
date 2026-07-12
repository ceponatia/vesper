# Multi-character chat — the substrate

Status: **shipped — 2026-07-12** (all four slices, same-day as the promotion:
roster routes + panel + per-character state/presence/recency (migration 0037),
the one-block ensemble frame with byte-identical roster-of-1
(`buildChatPromptPartsForRoster`), deterministic mention stamping + the
archivist's roster-gated presence field, and the scoped dynamics —
away-freeze, referenced-only pulse, tier-1 memory legs with tightened k,
witness memory writes. The relationship matrix slice shipped with it (see
relationship-model.plan.md). Docs: character-chat.md §Multi-character.
**Substrate simplifications — CLOSED 2026-07-12** by the owner-rulings
wrap-up ([multi-character-chat.followups.md](multi-character-chat.followups.md)):
per-member note-takers + deterministic folds (rulings 10–11), group-scene
selfies/callbacks/sensory-focus/enactment (12), the full third-person pair law
for present pairs (6), the chat-wide scenario split with setting-wide house
rules (8–9), and per-character sheets (13). Still open: the `turn_context`
layout stays 1-on-1-only, and multi-character eval fixtures ride the queued
enactment measurement run (ruling 7 — deferred).)

## Problem

Chat is deliberately 1-on-1 today ([docs/character-chat.md](../character-chat.md) —
its "no multi-character cast" line gets amended when this ships). The
relationship matrix needs conversations that hold 2–4 full characters, and the
owner wants group scenes in the chat lane in their own right: characters with
lives of their own, entering and leaving the player's scene.

## Rulings (2026-07-07, owner — settled)

1. **Full characters, no hierarchy.** Everyone in the roster is a complete
   character, not a "supporting NPC". Not everything sessions track — no
   locations, inventory, or exposure — just narrative presence and recency.
2. **Prompt frame: one narrative block.** Each reply is a single continuous
   narrative (not per-character bubbles); within it, characters speak, think,
   and act in their own paragraphs. The narrator is omniscient over the
   roster's interiority. Roster-of-1 keeps today's prompt **byte-identical**.
3. **The player owns himself.** The narrator never writes the player's actions
   or location. When no character is present, the reply is a cutaway — only
   what the away characters are doing. Player: _"I'm in my bedroom getting
   changed for our date"_ → narrator: _"Sabrina stands in front of her mirror,
   fussing over her hair…"_.
4. **Reaction pulse: referenced-only.** The pulse runs only for characters the
   player's input addresses or acts toward; everyone else's regard is untouched
   that exchange. Cost tracks the action, not the roster.
5. **Memory retrieval: tier-1 legs only** (owner delegated). Per-character RAG
   legs run only for present + recently-active characters, with per-character k
   tightened as the active count grows; away/quiet characters get no legs —
   their memory comes back when they re-enter. Union-retrieval was rejected: it
   muddles attribution, and memory groups are per-participant by design ("each
   character's memory their own").
6. **Away characters freeze.** Meters stop decaying while a character is away;
   drift resumes from re-entry on the chat clock, with no catch-up.

## Design

- **Roster.** A conversation holds N library characters (2–4 typical, cap 4).
  Each gets its own `character_chat_state` row — the `(chat_id, character_id)`
  PK was keyed for exactly this. A roster panel adds/removes characters after
  creation and exposes manual present/away toggles (dev-override philosophy).
- **Presence, not location.** One narrative flag per character: **present**
  (sharing the player's scene) or **away** (offstage, living their life). That
  is the only "location" tracked; NPC↔NPC co-presence away from the player is
  narrative flavor, not state.
- **Activity recency.** Per character, the last exchange in which they were
  _mentioned, acted, or were spoken to_. This drives the per-character detail
  budget: recently-active present characters get full identity/state blocks;
  quiet ones compress; away ones drop to the salience rules in
  [relationship-model.plan.md](relationship-model.plan.md) §"What the narrator
  sees when" (the relationship-injection half of the same budget).
- **Tracking is deterministic-first.** Display-name + `profile.aliases` regex
  over the player input and the reply stamps mention/spoken-to (the
  `chat-intent.ts` pattern); the chat archivist confirms presence transitions
  post-turn; the roster panel is the manual override.
- **Prompt build.** Roster > 1 shifts the prompt from "you are X" to the
  one-block ensemble frame (ruling 2): per-character identity/state blocks
  scaled by tier, shared-scene craft rules, the narration-authority rule
  (ruling 3), and the relationship pair blocks from the matrix plan. The
  prefix/tail cache split survives: present-pair and identity blocks sit in the
  stable prefix re-rendering on roster/presence/band change; recency-driven
  compression and salience lines ride the volatile tail.

## Shipped groundwork (2026-07-07)

The New-conversation dialog multi-selects up to 4 characters (selection-order
badges, primary hint); `POST /api/chats` takes `characterIds` — one
`chat_participants` row per character (sort 0 = primary), per-character
shared-memory-group resolution, auto-title "A & B". The list GET joins the
primary only and filters membership via EXISTS; `loadOwnedChat` and the summary
fold resolve the primary by sort. The exchange pipeline still runs 1-on-1
against the primary — extra participants are inert until slice 1 below.

## Slices (rough)

1. **Roster & state**: per-character `character_chat_state` rows (seeded from
   authored defaults on join), presence flag + recency columns, roster panel
   (add/remove, present/away toggles), scenario/preset semantics for N
   participants.
2. **Prompt reframe**: the one-block ensemble frame for roster > 1 — tiered
   identity/state blocks, narration-authority rule, craft-rule port; a
   prefix-byte-stability case asserting roster-of-1 stays byte-identical.
3. **Presence & recency tracking**: regex mention/spoken-to stamping, archivist
   presence confirmation, tier transitions.
4. **Scoped dynamics**: referenced-only reaction pulse, tier-1 memory legs,
   away-freeze in `driftChatState`.

Depends on relationship-model slices 1–3 (the pair record + composed law
builder); the matrix slice there builds on this plan.

**Eval tie-in** (shared harness): the multi-character fixtures listed in
[relationship-model.plan.md](relationship-model.plan.md) §Eval — asymmetric-mask
pair scene, away-mention gossip, alone-player cutaway authority.

## Open questions

None currently — the 2026-07-07 rulings above settled the frame, pulse scope,
memory fan-out, and away-freeze. New questions raised during build land here.
