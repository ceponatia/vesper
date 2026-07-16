# Intimacy notes — plan

Status: **shipped — 2026-07-14** (session lane, end to end). See §Completion.

Design/decisions: [intimacy-notes.spec.md](intimacy-notes.spec.md) — read it
first; it is the truth. This plan is the task list and build order. Builds on the
shipped species note split (`appearance`/`lore`, see
[non-human-species.plan.md](finished/non-human-species.plan.md)) and the phase-4 exposure
mask.

## Goal

A third model-facing species/heritage note — **`intimacy`** — plus a per-character
`profile.intimacy`, **merged and surfaced to the narrator only when the turn's
exposure mask reaches the intimate tier**. Completes the `appearance` (image) /
`lore` (narrator, always) / `intimacy` (narrator, intimate-only) trio.

## Build order

1. **Schema.** `intimacy: z.string().default("")` on `heritageDefinitionSchema`
   and `speciesDefinitionSchema` (`contracts/species/types.ts`);
   `intimacy?: string` on `characterProfileSchema` (`contracts/world/profile.ts`).
   Add `speciesIntimacyNote(speciesId, heritageId)` to `species/registry.ts`
   (heritage **replaces** species; bare text; "" for human/unknown/unauthored).
2. **Gate + narrator block.** `buildIntimateDispositionBlock(bundle, exposure)` in
   `engine/scene.ts` (sight-present NPCs; archetype note + character note
   appended; "" below the gate — the gate is **any axis `intimate`**, ruled). Thread through `engine/pipeline.ts` (effective mask) into
   `buildTurnContext` (`engine/prompts/narrative.ts`).
3. **Forge.** `intimacy` line in the profile section
   (`authoring/character-forge.ts`) — short, tasteful, always generated
   (ruled — the gate lives at surfacing).
4. **Editor.** "Intimate disposition" textarea on the profile tab
   (`components/characters/character-editor.tsx`), with a "surfaces only in
   intimate scenes" hint.
5. **Authoring.** Write `intimacy` notes for the species/heritages that warrant
   them (succubus, sprite, …); humans/baseline stay empty.
6. **Tests.** Gate on/off (no block below the tier), merge semantics
   (heritage-replaces, archetype+character append), `speciesIntimacyNote`,
   degradation (all-empty ⇒ ""). Reuse the exposure-mask test fixtures.
7. **Docs.** `contracts/body.md` (the third note axis + gate), `prompts.md` (the new
   block + its place in `exposureRules`), `authoring.md` (forge field + editor).

## Open questions

None — all seven ruled by the owner 2026-07-13; see
[intimacy-notes.spec.md §Rulings](intimacy-notes.spec.md#rulings-owner-2026-07-13)
(any-axis gate, append merge, always-forge, NPC-only, `intimacy`, bare text,
no independent content-rating suppression).

## Completion (2026-07-14)

Shipped end to end in the **session lane** (all seven build-order steps):

- **Schema.** `intimacy: z.string().default("")` on `speciesDefinitionSchema` +
  `heritageDefinitionSchema` (`contracts/species/types.ts`); `intimacy?: string` on
  `characterProfileObjectSchema` (`contracts/world/profile.ts`). No migration (data).
- **Registry.** `speciesIntimacyNote(speciesId, heritageId)` — heritage-replaces-species,
  **bare** text, "" for human/unknown/unauthored (`contracts/species/registry.ts`).
- **Gate + block.** `buildIntimateDispositionBlock(bundle, channels, exposure)`
  (`engine/scene.ts`) — sight-present NPCs, archetype **appended** with `profile.intimacy`,
  minor-fenced, gated on **any** axis `intimate` (appearance/touch/taste). Wired into the
  `stateBlock` beside `buildIntimateDispositionLine` in `engine/pipeline.ts` (effective mask
  = `raiseExposureForIntent(brief.exposure, intent)`), so it reaches `buildTurnContext`.
- **Forge / editor / fill / redraft.** Profile leg always drafts `intimacy`
  (`character-forge.ts` + demo fallback); "Intimate disposition" textarea on the Profile tab
  (`character-editor.tsx`); `mergeFillDraft` fills-if-blank and `mergeRedraftScope` profile
  scope rewrites it (`lib/character-fill.ts`, `lib/character-scopes.ts`, `character-redraft.ts`,
  `character-fill.ts renderSheetLines`).
- **Authoring.** Notes written for **succubus, faerie (base), sprite (heritage), elf (base),
  dark_elf (heritage), orc**; human/dwarf/gnome/goblin stay empty. The originating sprite
  `TBD:` comment in `catalog/faerie.ts` is now the authored note.
- **Tests.** Gate on/off + any-axis, heritage-replaces + archetype-append, sight-present-only,
  minor fence, all-empty ⇒ "" (`scene.test.ts`); `speciesIntimacyNote` bare/replace/fallback
  (`registry.test.ts`); fill-if-blank (`character-fill.test.ts`).
- **Docs.** `contracts/body.md` (the note trio + gate), `prompts.md` (the block + Exposure
  gating), `authoring.md` (forge field + editor + redraft scope).

**~~Leftover — chat lane (the test bed).~~ CLOSED 2026-07-16** — see below. As shipped
2026-07-14 the feature was **session-lane only**: the chat lane had no four-axis
`ExposureMask`, so `profile.intimacy` and the species `intimacy` note were authored,
forge-drafted, editable — and silently never read in chat. This plan captured the port as
the natural follow-up, under the existing soft "when the moment turns intimate" framing.

### Chat-lane port (2026-07-16, owner ask)

Built **with a real gate rather than the soft framing** this plan suggested — the framing
means the model reads intimate prose every turn and is asked to ignore it, which is the
always-on dump the notes exist to avoid. The chat lane now has its own gate,
`chatSceneIsIntimate` (`contracts/turns/chat-intimacy.ts`), built from the three signals
the lane actually has rather than a faked `ExposureMask` (whose axes describe a spatial
scene chat doesn't model):

1. the **character's** coverage-computed bare state (`intimateRegionsBare`),
2. the **player's** — newly possible: the player only got a real wardrobe with
   [persona-library.plan.md](persona-library.plan.md) slice 8, so this half of the scene
   was invisible to any gate before it,
3. **arousal** ≥ `CHAT_INTIMATE_AROUSAL_AT` (0.55) — held as its own constant rather than
   read off the meter registry, so retuning a *narrator hint* can't silently move a
   content gate.

Any one signal opens it (the session lane's "any axis" ruling, transposed); it defaults
**shut** on missing input. `buildChatIntimateSection` then renders the same merged note
(archetype **appended** with `profile.intimacy`, heritage-replaces-species) plus the
player persona's own `intimacy` — which carries **inverted semantics** (what they *respond
to*, not how they behave), so it gets its own wording and is rendered once. Per-member in
an ensemble, so one couple in the room doesn't hand everyone an intimate disposition;
minor-fenced per member; and in the **volatile tail**, never the cached prefix — the gate
flips with state, so a prefix block would bust the cache on every flip.

**Still soft-framed (deliberate):** the intimate *trait bands*
(`dispositionBands(..., {intimateOnly: true})`) keep their "when the moment turns intimate"
wording. They are milder content than authored prose, and `buildDisinhibitionSection`
consumes them as its dedupe baseline — gating them is a separate, entangled change. The
session lane gates both (`buildIntimateDispositionLine` is its sibling), so bringing the
bands behind this gate is the obvious next step if wanted.

## Not in scope (this plan)

Per-relationship intimacy, any meter/mechanic, and player-disposition surfacing —
see [spec §Out of scope](intimacy-notes.spec.md#out-of-scope).
