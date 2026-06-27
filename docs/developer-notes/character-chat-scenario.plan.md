# Character chat — scenario setup modal

Status: **shipped — 2026-06-27**

Bundle the character-chat tab's scattered scenario controls into one **Scenario setup**
modal (a sibling of **State tools**), and grow it into a no-session test harness: pick
the **social cards** active in this chat, and describe a free-text **starting outfit** that
drives scene images — replacing the structured clothing items the chat can't equip/unequip.

## Completion note (2026-06-27)

Shipped as planned, with the recommended rulings on every open question:
- **Active cards = seed-then-replace.** `seedChatState` copies `profile.socialCards` into the new
  `character_chat_state.active_social_cards`; the pulse (`applyChatPulse`) resolves against
  `state.activeSocialCards` (no longer `profile.socialCards`), so the modal's set is authoritative.
- **Intimate reveal = explicit toggle.** A new `outfit_exposed` boolean gates anatomy reveal in chat
  scene images (`buildCharacterSceneContext`: `exposedRegions([])` when on, fully-covered otherwise) —
  there is no structured wardrobe to derive coverage from.
- **Save split kept.** Starting Relationship writes through to the profile draft (editor SaveBar);
  Scenario / outfit / exposed / cards `PATCH` chat-state from the modal's Save, with explicit labels.
  The shipped strip-chip preview still tracks the dropdown live.
- **Outfit source swap.** `images/character-scene.ts` stops reading `profile.defaultOutfit`; the scene
  route threads the chat-state `outfit` + `outfit_exposed` into a free-text `outfitDescription` that
  overrides the (empty) wardrobe summary in `prompts.ts` `characterSpec`. `defaultOutfit` is untouched
  on the record (avatar/portrait/sessions still use it).
- **Prompt Character** moved to the conversation header (next to Scenario setup / State tools); the
  inline `PremiseBar` and the editor chat-tab Starting Relationship field were removed.
- Migration `drizzle/0015_*.sql` (three additive columns). Verified end-to-end locally (chip preview,
  PATCH round-trip for outfit/exposed/premise/active cards) + unit tests (pulse vs active cards;
  free-text outfit override). **Deferred:** seeding the outfit from a `defaultOutfit` summary, and
  surfacing outfit/active-cards to the chat *narrator* (images-only for v1).

## Motivation

The character chat is the place to tune a character before committing to a world/session,
but two things make it awkward today:

1. **No way to test social cards without a full session.** Chat resolves reactions only
   against the character's own `profile.socialCards` (`chat-state.ts:234`). To see how a
   world taboo or an imported card plays, you must spin up a world + session.
2. **Clothing is structured, but chat has no wardrobe UI — and won't.** Scene images source
   the outfit from `profile.defaultOutfit` via `loadDefaultWardrobe`
   (`character-scene.ts:67`), but there is no equip/unequip surface in chat (and per the user
   it's deliberately out of scope). So the only way to change what a character "wears" in a
   chat scene is to edit the saved character — clumsy for quick scenario testing.

A free-text outfit + a chat-scoped card set turn the chat into a proper scenario sandbox.

## Scope (the four changes)

### 1. Move Starting Relationship + Scenario into a modal

A new **Scenario setup** button next to **State tools** (`character-chat.tsx` ~`:287`) opens a
modal mirroring `ChatStateToolsModal` (`chat-state-tools.tsx`). It hosts:

- **Starting Relationship** — relocated from the editor chat tab
  (`character-editor.tsx:282-311`). **Stays a profile field** (`playerRelationship.stage`);
  the dropdown patches the profile draft via a passed-in callback, persisted by the editor's
  existing `SaveBar` (unchanged). The just-shipped strip-chip preview keeps working — it reads
  the same draft stage (see `character-chat-state` follow-up / the `persisted` flag).
- **Scenario (premise)** — relocated from the inline `PremiseBar` (`character-chat.tsx:486`).
  **Stays chat-state** (`character_chat_state.premise`), PATCHed via the chat/state API.

The modal makes the profile-vs-chat split explicit with a one-line label on each
("saved with the character" vs "this chat only") so the dual-save isn't surprising.

### 2. Active social cards (the test feature)

A card picker in the modal selects the social cards live in **this chat**, so taboos/rules
can be exercised without a session.

- **Storage:** a new `character_chat_state.activeSocialCards` jsonb — **snapshot copies** of
  `SocialReactionCard` (the copy-at-every-layer rule; same shape as `world.style.socialCards`
  / `profile.socialCards`). Import snapshots a `social_cards` library row via
  `cardFromLibraryParts` (`contracts/personality/cards.ts`), reusing `LibraryPickerDialog`.
- **Resolution:** `applyChatPulse` (`chat-state.ts:217`) passes this set as the `cards`
  argument to `resolveSocialReaction` (replacing the hard-coded `profile.socialCards` at
  `:234`). Precedence stays "first card whose triggers include the concept governs."
- **Seed:** on first open, pre-populate the picker from the character's own
  `profile.socialCards` so the chat starts from the authored set and the user prunes/adds.

### 3. Detach clothing → free-text starting outfit

- A new `character_chat_state.outfit` text field, edited in the modal.
- **Scene images** (`character-scene.ts` `buildCharacterSceneContext`) stop calling
  `loadDefaultWardrobe(profile.defaultOutfit)`; instead the chat-state `outfit` text becomes
  the focal character's `outfitSummary`. The scene route
  (`chat/scene/route.ts`) loads the chat-state row and threads `outfit` into
  `renderCharacterSceneImage`.
- `profile.defaultOutfit` is **untouched** on the character record — it still drives the
  avatar/portrait and real sessions. Only the **chat** scene path stops reading it.

### 4. (Consequence) chat scenes lose the structured occlusion/exposure model

With no wardrobe items there is no `resolveWardrobeVisibility` / `exposedRegions` to gate
intimate-anatomy reveal in the image. v1: default to clothed (no exposed regions); the
outfit text describes the look. Intimate reveal gating without structured wardrobe is an
**open question** below.

## Data model

`character_chat_state` (schema.ts:220) gains:

| Column | Type | Notes |
| --- | --- | --- |
| `outfit` | `text` not null default `''` | Free-text starting outfit for scene images. |
| `active_social_cards` | `jsonb` not null default `[]` | Snapshot `SocialReactionCard[]` live in this chat. |

DB workflow per `CLAUDE.md`: edit `schema.ts` → `pnpm db:generate` (human-run if it prompts)
→ review SQL → `pnpm db:migrate`. The GET/PATCH snapshot (`chatStateSnapshot`,
`ChatStateSnapshot` on both server `chat-state.ts` and client `lib/client/api.ts`) and the
`editChatState` patch (`ChatStateEdit`) carry the two new fields. Both `parseOr` at the
boundary; degraded defaults are `''` / `[]`.

## Reset semantics

The existing three resets extend naturally: **Reset state / Reset all** clear `outfit` +
`active_social_cards` (re-seeding the cards from `profile.socialCards`, outfit to empty/seed);
**Reset chat** preserves them (it keeps disposition).

## Build order (when this goes active)

1. **Schema + migration** — the two columns; thread through `loadChatState`,
   `seedChatState`, `persistChatState`, `editChatState`, `chatStateSnapshot`, and the client
   `chatStateSnapshotSchema` / `ChatStateEdit`. `parseOr` everywhere.
2. **Pulse wiring** — `applyChatPulse` resolves against `state.activeSocialCards` (degrade to
   `profile.socialCards` when empty/seed). Unit tests: a selected card fires; an empty set
   falls back.
3. **Scene-image outfit** — `buildCharacterSceneContext` sources `outfitSummary` from the
   chat-state `outfit`; scene route loads + passes it. Drop the `loadDefaultWardrobe` call on
   the chat path. Int test the prompt carries the text.
4. **Modal UI** — new `ChatScenarioModal` (mirror `chat-state-tools.tsx`): Starting
   Relationship (profile callback) + Scenario + outfit + the card picker (`LibraryPickerDialog`
   + snapshot helper). Button next to State tools.
5. **Removals** — delete the inline `PremiseBar` and the editor chat-tab Starting Relationship
   `Field`; relocate the "Prompt {who}" opening-beat action (see Open questions).
6. **Docs + tests** — update `character-chat-state` docs, `database.md` (new columns),
   `authoring.md` if it covers chat; int tests for the PATCH + scene prompt.

## Open questions

- **Save coordination.** Starting Relationship (profile, editor SaveBar) vs
  Scenario/cards/outfit (chat-state, modal Save) — keep the split with clear labels
  (recommended), or move a per-chat **affinity seed** onto chat-state so the whole modal saves
  as one? The split reuses existing flows and the shipped chip-preview; a chat-scoped seed
  would decouple from the authored default but duplicate state.
- **Active cards: union or replace?** Does the chat resolve **only** the selected set, or the
  union of selected + `profile.socialCards`? Recommend the picker is **seeded from**
  `profile.socialCards` and is then authoritative (replace) — what you see is what fires.
- **Intimate reveal without wardrobe.** Free-text outfit can't drive `exposedRegions`. Gate
  intimate-anatomy reveal off (a) keyword parse of the outfit text, (b) an explicit
  "exposed/nude" toggle in the modal, or (c) off by default (text-only). Recommend (b) — an
  explicit toggle is honest and testable.
- **Outfit default/seed.** Empty by default (existing characters render in whatever the
  composer infers), or one-time seed a text summary of `profile.defaultOutfit` so they're not
  unexpectedly underdressed? Recommend seed-once from a summary.
- **"Prompt Character" placement.** The opening-beat button lives in `PremiseBar` today. Move
  it into the modal, or keep it on the main chat surface next to Send? Recommend main surface
  (it's an action, not setup).
- **Narrator awareness of outfit/cards.** The user scoped outfit to **scene images only**.
  Should the chat *narrator* also see the outfit text and active cards (parity with a session's
  scene guidance)? Defer to a follow-up; v1 keeps narration as-is (the pulse applies cards
  deterministically; images use the outfit).

## Not in scope

- Equip/unequip / structured wardrobe in chat — explicitly out (the reason this exists).
- Changing `profile.defaultOutfit` or the avatar/portrait/session image paths.
- Surfacing active cards to the chat narrator prompt (deferred — see Open questions).
