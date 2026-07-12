# Multi-character chat & forge — post-ship wrap-up (owner rulings 2026-07-12)

Status: **shipped — 2026-07-12** — the owner's leftover-closure pass over the
three 2026-07-12 ships
([multi-character-chat.plan.md](multi-character-chat.plan.md),
[relationship-model.plan.md](relationship-model.plan.md),
[finished/character-sheet-forge.plan.md](finished/character-sheet-forge.plan.md)).
All 13 rulings built: 1–2 (`d19c467`), 4 (`e9a02a8`), 5 (`ad91f4f`),
6 (`d9adbf5`), 8–9 (`1116f9c` — migrations 0041/0042), 10–11 (`a8c741a`),
12 (`0bb3d02`), 13 (`553fd3b`). Leftovers: only ruling 7's paid enactment/eval
run (with its multi-character fixtures), deliberately deferred — it rides the
owner-gated **enactment measurement run** already queued in roadmap §Next.

## Rulings

### Character sheet forge

1. **Re-draft is a full re-sync of the tab from the rest of the sheet** —
   including values the player set by hand (the unsaved-draft review is the
   safety net; "Forge the rest" remains the fill-only tool). Scope limits that
   stay: the **Profile** tab re-draft rewrites ONLY bio / personality / voice
   (never name, age, aliases, library tags); species/heritage/body-plan stay
   untouchable everywhere (the cascade is too destructive for a formatting
   pass). Implementation: drop the `manual` reinstatement in
   `lib/character-scopes.ts` redraft merge; narrow the profile scope's
   writable field set; prompts updated to match.
2. **Portrait conflicts get a review-and-accept flow**: a "Review portrait
   changes" button opens a dialog listing every conflict as `current → what
   the portrait shows` with a checkbox per row (pre-checked) plus a read-only
   list of the blanks that were auto-filled — the debugging window into what
   the vision pass read. Apply overwrites the checked values on the draft.
   Needs the from-portrait route to return **structured** conflicts
   (`{attributeId, label, current, proposed}`), not just diagnostic text.

### Library UX

3. **List pagination stays parked** until a library outgrows the 100-row page.

### Relationships & presets

4. **Scenario presets store the full starting-relationship record** (both
   band dropdowns + kind / history / mask / looming), replacing the legacy
   single `startingStage`. Migration backfills old presets through the
   stage→bands bridge, then the column drops.
5. **The matrix editor gains the player column**: per roster character one
   "them → you" row (bands + kind/history/mask/looming) editing their state
   record via `editChatState`. One direction only — the player's own feelings
   are deliberately never tracked.
6. **Character↔character pairs get the full composed law block**: port
   `composeRelationshipLaw` to third person (address rights, openness
   composition, initiative, escalation floor) and use it for present-pair
   prefix blocks. Full richness for every present pair (≤6 at the 4-cap);
   compress later only if prompts prove heavy.
7. **The paid enactment/eval run (and its multi-character fixtures) stays
   deferred until after this pass ships.**

### Multi-character architecture

8. **Chat-wide vs per-character split** (the "premise belongs to the chat"
   ruling generalized): move to the conversation level — `premise`,
   `active_social_cards` (see 9), `scene_auto`, `scene_model`, `scene_memory`,
   `clock_minutes`, `pending_skip_note`, `skip_history`. Data backfills from
   the primary's state row, then the columns drop from
   `character_chat_state`. The clock is ONE story timeline; the away-freeze
   keeps meaning "no meter decay for away members", never a forked clock.
   Everything personal stays per character: meters, conditions, regard /
   familiarity / relationship record, mind note, outfit/exposed, loops,
   drives, milestones, histories, rings, presence, recency, overlays, memory
   queries, traces.
9. **Social rules/taboos are SETTING-wide**: the active card set lives on the
   conversation and applies to every character; per-character divergence is
   expressed through that character's tags flipping the reaction
   (`reactionOverrides`, the foot-fetish-positive pattern) — never through
   per-character rule lists. The scenario editor is the one place cards are
   edited ("both layers" = the shared set + per-character tag overrides that
   already exist on the character).
10. **The note-taker runs one focused pass per present character** (owner
    pick: clean ownership over cost): the shared pass keeps the scene-level
    reads (episode summary, facts, next-turn queries, scene notes, presence
    transitions); each present character gets a small personal pass (open
    loops, outfit change, lasting attribute changes, drive movement) folded
    into their own row. The classic 1-on-1 keeps today's single combined call
    (no cost regression).
11. **Deterministic per-member folds extend to everyone who pulsed**:
    milestones, relationship-history samples, and emotional-weather state for
    every referenced member, not just the primary.
12. **Group scenes gain the solo perks — all three**: selfies (the character
    the message addresses by name sends it; unaddressed requests fall to the
    lead), remember-when callbacks (drawn from that character's own memory,
    same pacing gates), and sensory focus (aimed at whichever character the
    message studies). Drunkenness/arousal/state enactment (disinhibition,
    transient appearance) renders per present member in the ensemble tail.
13. **Per-character sheet UI**: tapping a roster member opens THEIR sheet —
    state tools content (meters, conditions, mind note, loops, drives…),
    outfit + exposed, their relationship record toward the player, presence —
    replacing the single central state-tools/scenario split. The scenario
    editor slims to what is genuinely chat-wide: premise, presets, house
    rules (9), auto-scene + scene-model. Better even for 1-on-1 (the whole
    character at a glance).

## Build order

1. Forge pass (rulings 1–2) — merge policy, prompts, structured conflicts,
   review dialog.
2. Preset record + matrix player column + third-person pair law (4–6).
3. The chat-wide/per-character schema split (8–9) — migration + backfill,
   engine/route/UI rewiring.
4. Per-character note-taker + deterministic folds (10–11).
5. Group perks (12) + the per-character sheet UI (13).
6. Docs, gates, deploy, live verify; then mark this doc shipped and close the
   leftover lists in the three parent plans.
