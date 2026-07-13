# UX improvements — chat, item library, character form

Status: **next** (planned 2026-07-12 from an owner-requested review; open
questions ruled 2026-07-13; no code yet).

Source: a three-surface review (character chat, clothing/item library, character
form) run 2026-07-12 against the code and the live Fly build. Every finding below
was verified against the source (file:line pointers inline). No spec — each slice
is small enough to carry its own decisions; the owner rulings are recorded in
§Rulings and folded into the slices.

## Goal

A batch of improvements that makes the three most-touched surfaces play better: the chat
lane inherits the conveniences the session lane already solved, wardrobe state
becomes visible (and eventually structured) during play, authoring gets
clone/AI-assist parity, and the character form stops silently losing work.
Ordered so the trivial fixes land first and the one real gameplay feature
(outfit presets) lands last, informed by the wardrobe work before it.

## Build order

### Slice 1 — quick wins (no design decisions)

1. **Fix the stale multi-character copy.** `new-chat-dialog.tsx:180-185` still
   says extra character picks are "groundwork… the others join fully when
   multi-character chat lands" — multi-character chat shipped 2026-07-12
   ([finished/multi-character-chat.plan.md](finished/multi-character-chat.plan.md)).
   Rewrite the helper text to describe the shipped behavior (all picks join as
   full roster members; the first pick is the primary). Also sweep the stale
   comment at `new-chat-dialog.tsx:26`.
2. **Wire the existing clone endpoints into the UI.** `POST /api/characters/:id/clone`
   and `POST /api/items/:id/clone` + their client wrappers (`lib/client/api.ts`
   `charactersApi.clone` / `itemsApi.clone`) are fully built but called from no
   component — only social cards have the button
   (`social-card-editor-page.tsx:107`). Add **Duplicate** to the character edit
   page header and the item editor footer, and a clone affordance on library
   cards (kebab or hover action) for both kinds. Route to the clone's edit page
   on success. Wardrobe authoring is dominated by near-variants ("same top in
   three colors"); characters clone as archetype starting points.

### Slice 2 — chat history: pagination + jump-to-latest

The chat GET returns a flat most-recent `TRANSCRIPT_LIMIT = 500` rows with no
cursor (`app/api/chats/[chatId]/route.ts:32,104`), so a long-running chat
silently loses its own beginning — in a game whose product *is* accumulated
history. The session feed already solved both halves; backport them.

1. `?before` keyset cursor on the chat transcript GET (mirror the session
   feed's contract), page size well under 500.
2. "Load earlier" affordance at the top of `chat-conversation.tsx`'s scroll
   column; preserve scroll position on prepend (the `ResizeObserver` re-pin in
   there must not fire on history prepends).
3. "Jump to latest" pill when scrolled up and new content lands — lift the
   pattern from `components/play/feed.tsx:399-407`.
4. Tests: cursor pagination int test; a pure test for the pin/prepend guard.

### Slice 3 — wardrobe visibility in chat (read side)

Wardrobe is a flagship system, yet in chat the outfit is invisible unless the
player opens the Character-sheet modal, where it's one free-text field
(`chat-state-tools.tsx:343-360`). Read side first; the structured write side is
slice 7's dependency and stays there.

1. Add an outfit chip/line to the status strip (`chat-status.tsx`) next to
   mood/regard — compact (e.g. first 2–3 garments), expands to the full
   phrase on tap; hidden when the outfit text is empty.
2. Roster variant: per-character outfit line in the roster panel for
   multi-character chats (state is already per-member).
3. Keep it read-only here — editing stays in the Character sheet until slice 7.

### Slice 4 — separate the player surface from the engine surface

Two engine leaks ship to every user:

1. **Character-sheet debug block.** The modal mixes player controls (outfit,
   regard sliders, mind note) with raw pulse traces, cue-splits, memory traces,
   and attribute overlays (`chat-state-tools.tsx`). Gate the trace/debug
   sections behind the admin role (the `/chat/[chatId]/inspector` page already
   404s for non-admins — same check), keeping the editable fields for everyone.
2. **Action chips — ruled out of this plan (2026-07-13): promote to narrated
   beats.** "Offer a drink / Freshen up / Take a breather / Heat things up" are
   test-bed deterministic state nudges (`contracts/turns/chat-pulse.ts:33`)
   rendered with no explanation (`chat-status.tsx` `ActionChips`). The owner
   ruled they become real narrated beats, which is its own small plan —
   [chat-action-beats.plan.md](chat-action-beats.plan.md) (queued right after
   this batch). This plan does not touch the chips; no interim tooltip pass.

### Slice 5 — item authoring assist (AI draft from description)

Characters get Forge ✦ / Forge-the-rest / per-tab re-drafts; items are 100%
manual across name, category, layer, coverage tree, and three sensory fields.
The classify pass behind the library's **Organize** button
(`app/api/items/classify/route.ts`) already infers category/wearer/layer/color
from name+description — extend that seam into the editor:

1. A **✦ Draft from description** button in `item-editor-page.tsx`: from
   name+description (require at least one), propose category, layer, opacity,
   wearer, color/shade, coverage (including carve-outs — a sandal proposal
   should demonstrate `feet` minus `toes`/`top of foot`), and the three sensory
   lines. Fill-empty-only, same review discipline as Forge-the-rest: result
   lands unsaved in the form for the SaveBar to accept/discard.
2. Reuse/extend the classify prompt + `parseOr` contract; add the coverage and
   sensory fields to its schema.
3. Tests: pure schema-parse degradation test; prompt fixture with a carve-out
   garment.

### Slice 6 — library referential integrity

1. **In-use warning on item delete.** The confirm dialog only mentions session
   snapshots; deleting an item referenced by a character `defaultOutfit` or a
   world placement breaks silently (surfaces later as the red "not in library"
   tag, `outfit-editor.tsx:147`). Count references server-side at delete time
   and name them in the dialog ("Worn by Sabrina Vale's default outfit; placed
   in Corner Café") — warn, not block.
2. **Read-only view for public items you don't own.** `itemDetailSchema` has no
   `mine` field, so another owner's public item renders the full editable form
   whose Save 404s server-side. Copy the social-card pattern
   (`social-card-editor-page.tsx` — `detail.mine` → read-only + "Clone to my
   library" CTA, which slice 1's clone button provides). Audit locations for
   the same gap while in there.

### Slice 7 — editor autosave refactor + scannability

1. **Autosave refactor (ruled 2026-07-13 — supersedes the dirty-navigation
   guard the review proposed).** `dirty` is tracked (`character-edit-page.tsx:42`)
   but nothing guards navigation; rather than warn, fix the root cause — drafts
   should never be losable:
   - **Create-on-new:** "New" immediately persists the entity with placeholder
     required values (randomized so concurrent drafts don't dupe) and routes to
     its editor — there is no unsaved-new limbo.
   - **Autosave on change:** structured fields (selects, toggles, sliders,
     pickers) save on change; free-text fields save when the user leaves the
     field (blur).
   - **The Save button stays** as a manual flush and visual reassurance.
   - Scope: character edit page, item editor, world editor. What remains of
     the guard idea: warn on navigation only while a write is in flight or has
     failed.
   - **Forge-draft discipline is preserved:** ✦ output (Forge-the-rest,
     per-tab re-drafts, slice 5's item assist) still lands as *staged, unsaved*
     proposals for explicit accept/discard — autosave never commits staged
     forge results.
2. **Minimal validation.** The `Field` `error` prop (`components/ui/field.tsx`)
   is dead code across this surface. Add inline errors for the real cases:
   empty Name (warns — a placeholder name now exists from create-on-new), a
   drive with a blank "want", a schedule row with a blank activity (both are
   silently dropped server-side today — the warning explains that). Advisory
   only; nothing gates the autosave writes.
3. **Attribute accordion summaries.** Every one of the 23 section headers shows
   a bare "—" until expanded (`attribute-picker.tsx` — observed live on a
   seeded character: nothing distinguishes a fully-authored section from an
   empty one, and the accordion is single-open so you can't compare). Render a
   set-value summary in the header ("auburn, shoulder-length, wavy" or "3 set"),
   and a distinct affordance for all-empty. This is also what makes
   Forge-the-rest / From-portrait output reviewable at a glance. Extends the
   accordion shipped in
   [finished/face-jewelry-and-attribute-form.plan.md](finished/face-jewelry-and-attribute-form.plan.md).

### Slice 8 — named outfit presets (the gameplay feature)

Characters hold exactly one `defaultOutfit`. For a game with daily rhythms,
scene changes, and intimacy staging, named presets ("casual / work / date
night / sleep") are gameplay: pickup skips and schedule day-parts can dress the
character appropriately, and chat wardrobe changes get something concrete to
swap between. Biggest slice; do last.

1. **Schema (ruled 2026-07-13: replace, don't keep both).**
   `profile.outfits: [{ id, name, items: string[] }]` **replaces**
   `defaultOutfit` — the field migrates into the first preset (the designated
   default) and is removed, with every consumer (forge suggestions, avatar/
   portrait routes, the chat seed `resolveSeededOutfit`, session wardrobe
   seeding) repointed in the same change. Registry-style: no new tables, rides
   the profile jsonb.
2. **Editor.** The Outfit tab (`outfit-editor.tsx`) grows a preset switcher
   (add/rename/duplicate/delete); the slot-based editor edits the selected
   preset. Forge suggestions keep targeting the default.
3. **Chat integration.** The chat outfit seed (`engine/chat-state.ts`
   `resolveSeededOutfit`) can resolve any preset; the archivist's
   outfit-change tracking may name a preset ("changes into her work clothes")
   and the state editor offers preset quick-picks alongside free text — the
   first structured step for the slice-3 read side. This is deliberately the
   **stepping stone**: the ruled long-term target is full session-parity
   wardrobe state in chat — its own plan,
   [chat-wardrobe-parity.plan.md](chat-wardrobe-parity.plan.md).
4. **Rhythm hook (ruled 2026-07-13: build with this slice).** Schedule
   day-part rows (`schedule-editor.tsx`) may optionally reference a preset so
   openers/skips dress by time of day.
5. Tests: seed-resolution (preset → phrase), degradation (missing preset id ⇒
   default), archivist preset-name matching.

### Slice 9 — small polish batch

Bundled leftovers from the review, each tiny:

1. Animated typing indicator — the pending bubble is a static `…`
   (`chat-message.tsx:218`) even during the deliberate reveal-hold
   (`lib/chat-pacing.ts`, up to ~1.2s); pulse it so "thinking" reads as alive.
2. Relationship-panel chart legibility (`chat-relationship-panel.tsx`) — the
   familiarity×regard plot renders too small to read; give it labeled axes and
   a sensible min size.
3. Mood intensity is tooltip-only (`mood-chip.tsx`) — invisible on touch;
   surface it (ring fill, or intensity in the expanded chip).
4. World item placement quantity — schema supports 1–20
   (`lib/client/api.ts` `worldDraftItemPlacementSchema`), the form hardcodes 1
   (`world-editor.tsx` ItemsTab); expose a small stepper.
5. Footwear carve-out discoverability — the Footwear template fills the whole
   foot (`contracts/items/clothing-categories.ts:50`); add a one-line hint
   under the category select when Footwear is chosen ("sandal? uncheck toes /
   top of foot"), pairing with slice 5's AI proposals.

## Docs to update (in the same changes)

- `docs/ui.md` — status strip outfit chip, jump-to-latest, clone buttons,
  accordion summaries, preset switcher.
- `docs/character-chat.md` — transcript pagination contract, outfit surfacing,
  admin-gated debug block.
- `docs/contracts/items.md` + `docs/guide/creating-items.md` — draft-from-
  description, delete warnings, read-only public view.
- `docs/authoring.md` — item assist, outfit presets, validation behavior.
- `docs/streaming-api.md` — the `?before` cursor on the chat GET.

## Rulings (owner, 2026-07-13)

All six open questions ruled; folded into the slices above:

- **Action chips** — promote to narrated beats; spun out to
  [chat-action-beats.plan.md](chat-action-beats.plan.md) (this plan no longer
  touches the chips).
- **Debug visibility** — hide the trace/debug sections entirely from
  non-admins (admin role check; no reduced summary).
- **Form persistence** — don't just warn on unsaved changes: refactor to
  autosave (create-on-new with randomized placeholder required values,
  save-on-change, blur-save for free text; Save button kept as manual flush).
  Validation is advisory inline warnings, never a gate.
- **Preset storage** — replace `defaultOutfit` with `outfits[]` (migrate +
  repoint every consumer in one change).
- **Rhythm auto-dress** — build with slice 8, not deferred to world-sim.
- **Chat structured outfit** — slice 8.3 stays the stepping stone (quick-picks
  + archivist preset names); the eventual target is **full session parity** in
  chat, planned separately in
  [chat-wardrobe-parity.plan.md](chat-wardrobe-parity.plan.md).

## Not in scope (this plan)

- Library keyset pagination past the 100-row cap — explicitly deferred until
  real catalog scale ([finished/library-ux.plan.md](finished/library-ux.plan.md)).
- Item image upload/variants (AI-generate only today) — separate idea, park in
  [deferred.plan.md](deferred.plan.md) if wanted.
- Full per-body-location worn-state UI inside standalone chat — out of scope
  *of this plan*, but no longer rejected: ruled 2026-07-13 that chat wardrobe
  eventually reaches full session parity —
  [chat-wardrobe-parity.plan.md](chat-wardrobe-parity.plan.md) owns that arc
  (part of the chat-as-test-bed direction; see `CLAUDE.md`).
- In-transcript search / jump-to-date — real gap, but bigger than this batch;
  candidates for a future chat-history plan alongside the relationship/meter
  timeline ([deferred.plan.md](deferred.plan.md) #4).
- Merging the three personality-ish tabs (Profile prose / Personality
  attributes / Disposition) — the split is load-bearing for forge legs and
  re-draft scopes; revisit only with a concrete design.
- Character export/import (character cards) — park in
  [deferred.plan.md](deferred.plan.md) if wanted.
