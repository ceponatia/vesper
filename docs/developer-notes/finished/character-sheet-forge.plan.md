# Character sheet forge — in-sheet completion, per-tab re-drafts, portrait-derived attributes — plan

Status: **shipped — 2026-07-12** (slices 1–3 built, merged to main, and
deployed to Fly 2026-07-09; the owner's live review — the on-Fly UI drive and
the live prompt-quality pass — **passed 2026-07-12**, closing the last gate.
Owner ruling 2026-07-09: **the `/characters/forge` page stays** — it creates
whole characters from a prompt; the in-sheet tools build parts of an existing
sheet, so the in-sheet Forge is **sheet-only, no guidance text box**.
Leftovers: the two conflict-handling flips in §Open questions were RULED and
built 2026-07-12 — see that section.)

Builds directly on the shipped character forge
(`server/authoring/character-forge.ts`, docs/authoring.md §Character forge) and
its per-section regenerate seam. No spec yet; design detail lives inline here
and splits out to `character-sheet-forge.spec.md` if it grows.

## Goal

Let a player partially fill the character sheet and have the LLM do the rest —
three tools, escalating in scope:

1. **Forge (sheet-level, "finish my character")** — one button in the editor:
   completes every empty part of the sheet from what the player entered.
   **Never overwrites player-authored content.** If unsaved edits exist, Forge
   saves them first, then runs.
2. **Re-draft (per-tab)** — a button on each content tab: rewrites *that tab's*
   content from the whole sheet, formatted for the narrator. Explicitly allowed
   to reorganize the player's own text (e.g. move personality prose out of the
   Profile bio into the personality field, and vice versa); the Attributes
   tab's button derives/fills attributes from what the other tabs say.
3. **Portrait-derived attributes** — a vision model looks at the character's
   generated portrait and proposes *appearance attributes only* (you can't read
   disposition or backstory off a picture). Fills blanks; never overwrites.

## What already exists (the seams)

- **Per-section forge**: `POST /api/characters/forge` takes `{prompt, section?,
  draft?}`; `forgeCharacterSection` runs one LLM leg per section
  (`characterForgeSections = ["profile","attributes","outfit"]`), returns a
  `CharacterSectionPatch`, and the route replies with the merged full draft.
  The editor already renders a per-section "↻ Regenerate" button when
  `onRegenerate` is passed (`character-editor.tsx` `sectionFor` map) — today
  only the forge page passes it.
- **Player-vs-AI provenance is already stored**: manual edits stamp
  `source: "manual"` on attribute values (`attribute-helpers.ts setAttribute` —
  "touching an AI value claims it") and trait values
  (`disposition-editor.tsx`); forge output stamps `"creation"`. `isAiSourced()`
  already drives the picker's AI chip. So "player-authored" is a *stored fact*
  for attributes and traits, not a heuristic.
- **Save flow**: "New" creates a blank row immediately (`createBlank` →
  `/characters/[id]`), so in the editor the character always exists; unsaved
  work is the dirty draft behind the SaveBar, flushed by `PATCH
  /api/characters/:id`. The `/characters/forge` page holds its draft in React
  state only.
- **Structured output discipline**: `generateChecked`
  (`server/ai/generate-checked.ts`) — schema-in-prompt, parse, one repair
  round-trip, degrade to fallback + diagnostic; never throws. Attribute output
  is already a closed vocabulary (zod enum of registry-valid ids).
- **No image understanding exists anywhere** — Venice is generate/edit only,
  OpenRouter usage is text-only, no curated vision model. Slice 3 is the only
  slice needing new plumbing.

## Design

### Two operations, two contracts

|                     | Forge (sheet)                          | Re-draft (tab)                                        |
| ------------------- | -------------------------------------- | ----------------------------------------------------- |
| Trigger             | One button, whole sheet                | One button per content tab                            |
| Reads               | Whole sheet (+ optional guidance?)     | Whole sheet                                           |
| Writes              | Only empty/unset fields, all sections  | That tab's fields, rewritten wholesale                |
| Player text         | Untouched (non-empty scalar = fixed)   | May be rewritten/reorganized — that's the point       |
| `manual` attr/trait | Untouched                              | Untouched (proposed default; see open questions)      |
| `creation` values   | Untouched (fill only adds missing ids) | Fair game — AI may revise its own prior output        |
| Lists (tags, prefs) | Additive only — may add, never remove  | May rewrite, but `manual`-stamped entries survive     |

Distinct names and button styling in the UI so nobody clicks a tab Re-draft
expecting fill-only behavior.

### "Player-authored" definition

- **Attributes / traits**: `source === "manual"`. Everything else (`creation`,
  seeded species defaults) is AI-owned.
- **Free-text scalars** (bio, personality, voice, age, name,
  playerRelationship): non-empty ⇒ fixed for Forge-fill (whoever wrote it —
  predictable beats clever). Re-draft is the tool that rewrites them.
- **Species / heritage / body plan**: Forge-fill may set them only when still
  at the blank-create default; Re-draft never changes them (the species cascade
  resets attributes/features — too destructive for a formatting pass).

Enforcement is **server-side post-filter, not prompt trust**: the prompt says
"these are fixed", and then a pure merge function (`fillCharacterDraft` /
`redraftSectionMerge` in `server/authoring/`) reinstates protected values over
whatever the model returned. Prompt discipline is an optimization; the merge is
the guarantee.

### Save + review flow

1. Button click → if the draft is dirty, flush the existing `PATCH` first
   (player work is committed before any LLM spend; a failed generation can
   never cost typed content). On PATCH failure: stop, surface the error, no
   LLM call.
2. Run the forge call with the (now-saved) draft in the request body — same
   pattern as today's section regenerate.
3. The result lands as an **unsaved dirty draft**: the SaveBar becomes the
   review/undo step. Nothing the LLM writes is persisted until the player
   saves. Degradations surface via the existing `DiagnosticList`.

### Tab ↔ scope remap (slice 2)

Today's three sections don't align with the five content tabs: `profile`
carries the disposition fields, and `attributes` spans both the Attributes and
Personality tabs. Extend `characterForgeSections` to five tab-aligned scopes:

- `profile` — name (only if empty), bio, personality, voice, age, aliases,
  library tags. No species/body fields.
- `attributes` — attribute values *excluding* `PERSONALITY_CATEGORIES`.
- `personality` — attribute values in `PERSONALITY_CATEGORIES`
  (voice/presentation/movement).
- `disposition` — traits, disposition tags, preferences, social cards.
- `outfit` — unchanged.

`sectionFor` in the editor then covers all five content tabs;
`mergeCharacterSection` (`components/forge/draft-merge.ts`) gains the new
scopes. The full-forge path (`forgeCharacter`) keeps its three-leg parallel
shape internally — scopes are a request-level concept mapped onto the legs, not
necessarily five separate LLM calls.

### Vision (slice 3)

- **Provider**: OpenRouter vision-capable model, new curated entry +
  `visionModelId()` resolver in `server/ai/provider.ts` (gateway rule keeps
  `@openrouter` inside `server/ai`). Venice has no describe capability in our
  integration.
- **Plumbing**: extend `generateChecked` (or a sibling
  `generateCheckedVision`) to accept image parts; feed the stored avatar webp
  (`data/images/...`) as a base64 part. Same parse/repair/degrade ladder.
- **Route**: `POST /api/characters/:id/attributes/from-portrait` — needs a
  saved character with an avatar; reuses `FORGE_RATE_LIMIT`.
- **Output**: closed vocabulary only — the schema is built from registry ids in
  visually-derivable body-scope categories (candidate gate: the body-region
  categories the avatar prompt itself is built from, i.e. what
  `buildAvatarPrompt` renders; `coreVisual` / `imageReveal` flags are the
  starting filter — settle the exact category list at build time). Never
  free-text, never number guesses beyond registry enums.
- **Merge**: fill-blanks only (unset ids), stamped `source: "creation"`.
  Conflicts with existing values are *reported* (diagnostic list in the UI:
  "portrait shows long hair; sheet says short"), not applied — see open
  questions.
- **UI**: "From portrait" button on the Attributes tab, enabled when an avatar
  exists.

## Build order

1. **Slice 1 — sheet-level Forge (fill mode).**
   - `fillCharacterDraft` pure merge policy + tests (the contract table above).
   - Forge route gains `mode: "create" | "fill"` (`prompt` optional outside
     `create`); fill mode runs the three legs with fill-aware prompts (the
     sheet rendered as fixed context) + server-side post-filter.
   - Editor: Forge button (edit page, not just forge page), auto-save-first,
     busy state, result → dirty draft, diagnostics surfaced.
   - Int test: fill mode over a half-filled draft — player fields byte-stable,
     empties populated, degradation path emits diagnostic + no-op patch.
2. **Slice 2 — per-tab Re-draft.**
   - Scope remap (five sections), `mergeCharacterSection` + `sectionFor`
     extensions, `redraft` mode with reorganize-for-the-narrator prompts
     (content may move between fields within the scope's tab; `manual` values
     reinstated post-generation).
   - Per-tab buttons on the edit page via the existing `onRegenerate` seam;
     distinct copy ("Re-draft this tab") vs the sheet Forge.
3. **Slice 3 — portrait-derived attributes.**
   - Vision model entry + image-part generation helper; the route, merge, and
     conflict report; Attributes-tab button.
4. **Docs.** `authoring.md` (modes + per-tab re-draft + provenance contract),
   `images.md` (first image-understanding capability), `ui.md` (editor
   buttons), `guide/creating-characters.md`. Update in the same change as each
   slice.

## As built (2026-07-09; deviations and refinements from the design above)

- Server modules: `authoring/character-fill.ts` (fill orchestration + sheet
  render), `authoring/character-redraft.ts` (scope→leg map + directives),
  `authoring/portrait-attributes.ts` (vision pass). Pure policy shared client
  and server: `lib/character-fill.ts` (fill merge), `lib/character-scopes.ts`
  (scope merge + manual reinstatement). One route change (`forge` gains
  `mode: create|fill|redraft` + `scope`) plus
  `POST /api/characters/:id/attributes/from-portrait`.
- **Re-draft on non-provenance lists** (disposition tags, preferences, library
  tags): replaced wholesale — those lists carry no `manual` stamp, and the
  unsaved-draft review is the safety net. Provenance-carrying values keep the
  designed guarantee (manual survives; conflicts reported as
  `forge.character.redraft.<scope>.kept_manual`).
- **Scopes ride the three legs** as designed (profile+disposition → profile
  leg, attributes+personality → attributes leg); `PERSONALITY_CATEGORIES`
  moved from the attribute picker into contracts
  (`PERSONALITY_ATTRIBUTE_CATEGORIES` + predicates) so both sides share it.
- **Vision**: `generateChecked` gained an `images` option (messages form);
  code-default `qwen/qwen3-vl-235b-a22b-instruct` via `visionModelId()`
  (checked vision-capable + cheap on the live OpenRouter catalog 2026-07-09).
  The portrait pass has **no demo fallback** by design — keyless mode is a
  no-op with a diagnostic, never an invented reading of an unseen image.
- **Fill-mode int coverage** lives at the module layer
  (`character-fill.test.ts` runs `forgeCharacterFill` end-to-end on the
  keyless demo ladder); the route glue is three lines on the create path's
  existing `withUser`/rate-limit plumbing, so no separate route int test.
- Live UI verification on Fly and the live (spend) quality pass of the three
  new prompt shapes: **owner review passed 2026-07-12** — nothing remains.

## Open questions

None — both conflict flips were ruled and built 2026-07-12
(../multi-character-chat.followups.md rulings 1–2, commit `d19c467`):

- **Re-draft vs `manual` conflicts** — RULED: re-draft is a full re-sync;
  `manual` values are revisable (the reinstatement in
  `lib/character-scopes.ts` was dropped; the unsaved-draft review is the net).
  The Profile scope narrowed to bio/personality/voice at the same time.
- **Vision conflict handling** — RULED: structured conflicts
  (`{attributeId, label, current, proposed}`) + the "Review portrait changes"
  dialog — pre-checked `current → proposed` rows, auto-fills listed read-only;
  Apply overwrites the checked values on the draft.
## Not in scope (this plan)

The world forge and its cast generation (same module — it inherits the merge
helpers but gets no new modes here), portrait *generation* changes, outfit item
library generation beyond the existing outfit section, and any narrative-time
attribute writes (that's the merge engine's territory —
`attribute-mutability.plan.md`).
