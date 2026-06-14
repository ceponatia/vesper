# Authoring (AI-first, human-final)

`src/server/authoring/` + the forge pages. Principle: **the AI drafts, the human owns.** Every field an agent fills is editable before and after save; nothing is locked behind generation.

## Character forge

`POST /api/characters/forge` with a prose prompt ("a weary harbor-master in her forties, dry humor, bad knee…"):

1. **Profile agent** (`generateChecked`): bio, personality, voice notes, tags, suggested display name.
2. **Attribute agent**: emits `AttributeValue[]` against the **registry** — the schema enumerates allowed ids/values, so output is validated vocabulary, not free text. Three-tier fill for attributes flagged `coreVisual` in the registry (hair/eye color, skin tone, height, frame, apparent age), which are always filled:
   1. **Definite values** — where the concept states or strongly implies a value, the model emits it directly. A definite value always beats a range for the same id.
   2. **Plausible ranges** — for each `[CORE]` enum attribute it can't pin down, the model emits `ranges: [{ id, plausible: string[] }]`, a subset of `allowedValues` conditioned on the **identity anchors** it inferred first (attributes flagged `identityAnchor` in the registry: gender, apparent age, heritage, species presentation). Grounding mirrors values: ranges on unknown ids / non-enum attributes and out-of-vocabulary members drop with `forge.character.attributes.invalid_range_member`; a range emptied by grounding drops entirely. Guardrails live verbatim in the attributes system prompt: anchors constrain physical attributes only (never personality, voice, behavior, or role), explicit text always overrides a prior (definite value, no range), weak identity signal ⇒ wide ranges or none.
   3. **Seeded pick** — anything still unset gets a default drawn from its surviving range (`fillCoreVisualDefaults`; FNV-1a over concept+id, so different concepts vary while the same input forges the same draft). No range ⇒ the pick falls through to the full `allowedValues` (minus any `autoDefaultExcludes` members — e.g. minor apparent ages, which exist as vocabulary but are never auto-assigned) plus an info diagnostic (`forge.character.attributes.unconstrained_default`).

   Everything else stays sparse-is-correct: unfillable attributes are simply omitted.
3. **Outfit agent**: suggests a default outfit as item drafts (clothing kind, coverage, layer). It is shown the caller's existing clothing as **reuse candidates** (`listClothingCandidates`: most-recently-updated first, capped at `CANDIDATE_LIMIT`) and may set a garment's `reuseId` to one of them instead of inventing it. The prompt's policy is *reuse generic basics (any t-shirt/jeans/sweater — colour differences don't matter), define a new garment for a signature/character-defining piece*; per-garment judgment lives with the model, not a fixed threshold. A hallucinated `reuseId` degrades to a fresh garment (`forge.character.outfit.unknown_reuse`); the remaining new garments are still name-matched against the library, and unmatched ones become new item drafts flagged `suggested`.

The forge returns a **draft** (never auto-saves). The forge UI renders it as the same form used for manual editing — accept, tweak any field, regenerate any single section (each agent can re-run independently), then save. After save, the avatar pipeline can run from the attributes.

On save, `suggestedItems` in the create body are materialized as real library items (`materializeSuggestedItems` in `server/api/library.ts`): a suggestion whose name matches an existing item reuses it — never a duplicate. Failing an exact-name match, a **conservative embedding backstop** (`fuzzyResolve` at `ITEM_DEDUPE_MIN_SCORE`, same item kind) collapses a near-identical garment the agent missed (`api.library.suggested_item.fuzzy_reused`); an embedding failure degrades to a fresh insert. New rows keep the `suggested` tag; the resulting ids are appended to `profile.defaultOutfit`. A bad suggestion degrades (invalid coverage ids dropped with a diagnostic) and never fails the save.

## World forge

`POST /api/worlds/forge` with a prose premise. Agents (parallel where independent):

1. **Premise agent**: name, synopsis, style directives (tone, era, pacing, content notes), narrator guidance, calendar start.
2. **Locations agent**: 4–10 locations with descriptions, ambient sensory, tags, and a connection graph (validated: connected, no orphans).
3. **Lore agent**: 8–20 lore chunks across categories with tiers/visibility — including 2–3 `secret` chunks wired to `unlock_tags` (gives every forged world a discovery arc).
4. **Cast agent**: suggests existing library characters (embedding match against the premise) and 1–3 new character stubs (which route through the character forge flow). Suggestions may carry **relationship entries** — `toward` (another suggested name or the literal `player`) + a registry stage (the prompt carries the stage vocabulary) — only where the premise/concepts support a bond; sparse is correct (no entry = strangers, `stranger` is never written). The prompt requires that a suggestion with a relationship **name the bond kind in its conceptNote** in plain words ("her brother", "a coworker at the cannery", "they have never met") — that text is what the deterministic bond classifier reads at spawn to seed the NPC's `perceived` player edge ([contracts.md](contracts.md)). Grounding after generation: `toward` resolves through the same `fuzzyResolveName` machinery as location links (resolved entries keep the canonical casing); unresolved or self-targeted entries drop with `forge.world.cast.unresolved_toward`, duplicate targets keep the first, and unknown stage ids self-heal to `stranger` via the contract schema's `.catch`.
5. **Items agent**: world item placements (furniture, containers with contents) per location.

Draft → review UI (tabbed: premise / map / lore / cast / items) → edit anything → save posts the draft to `POST /api/worlds/from-draft`, which converts it and materializes worlds + world_* rows + embedded lore chunks.

## Saving drafts (draft → create-input)

A forge **draft** and a create endpoint's **input** are different shapes by design (drafts use names and suggestions; inputs use ids and definitions). Every forge ships a typed conversion, and the create endpoints use `.strict()` bodies — a draft posted to a create route is a loud 400 (`invalid_body`), never a silently empty save. Don't add a forge without its conversion path.

- **Character**: the create body carries `suggestedItems`; `materializeSuggestedItems` (server/api/library.ts) turns them into library items (reuse-by-name, then a conservative embedding backstop, `suggested` tag) and appends ids to `profile.defaultOutfit`.
- **World**: `createWorldFromDraft` (server/api/world-from-draft.ts) resolves the draft server-side:
  - Cast suggestions with `existingCharacterId` link directly; unlinked names are re-matched against the library (existing characters are never regenerated); the rest are **forged into real character rows** at save time, capped at `MAX_GENERATED_CAST` (3).
  - Cast generation runs with `useFallbacks: false` — persisted rows must never get demo sample content. A failed generation degrades to a skeletal stub (conceptNote as bio, tagged `stub`) with a diagnostic; the save itself never fails on a bad generation. Recovery is post-save: edit/regenerate from the library, or relink from the world editor.
  - Cast relationship entries (`toward` + a stage id, [contracts.md](contracts.md) §Relationships) ride each suggestion into `world_cast.relationships` as-is — `toward` names resolve at **spawn** (case-insensitively, against cast display names or the literal `player`), where unresolved names degrade with a `spawn.relationship.unresolved_toward` diagnostic, never a failed save or spawn.
  - Item placements reuse library items by name before defining new ones; `castName`/`locationName` resolve to ids; `worn` only sticks when the holder resolved.
  - All conversion losses are diagnostics (`api.world.from_draft.*`), returned with the created world id.
- **World edits** save through the same conversion: `POST /api/worlds/:id/from-draft` → `updateWorldFromDraft`, which sends all four nested families together (PATCH full-replace semantics). Draft locations carry `locationId` when they mirror a saved library location — edited values become world-local **overrides**, never duplicate or mutate the base row. Known limitation: container nesting between world items isn't representable in the draft, so an edit-page save flattens it.

## Manual editing

Every entity has a full manual editor (the forge review UI *is* the editor):
- Character: profile fields, attribute picker (registry-driven: category → attribute → allowed values), outfit builder, portrait studio.
- World: style/lore text panes, location graph editor (add/remove links, per-location scale + area label), cast & placement tables (role, tier, start location, relationship rows), lore chunk list with tier/visibility/unlock-tag controls, and a world-level "player starts at" pick (unset ⇒ the player starts with the companion).
- Cast relationships: per cast member, directed rows of `toward` (another cast member or the player) + a stage from the registry (stages, never numbers). Sessions seed `participant_relationships` at the stage midpoint; an authored A→B also seeds B→A at the same midpoint unless that direction is itself authored (write both sides for unrequited bonds); `stranger` writes no row (sparse = stranger). Player edges also seed the NPC's `perceived` read from its concept/bio text via the bond classifier ([contracts.md](contracts.md)): mutual-knowledge kinds and indeterminate text mirror the midpoint, explicit first-meeting phrasing seeds nothing.
- AI-entered values are visually marked (`source: "creation"` vs `"manual"`) until touched — provenance is already in the data model.

## The `{{player}}` token

Authored free text may name the player character with `{{player}}` (case-insensitive, optional inner spaces: `{{ Player }}`) instead of committing to who will embody the world. It resolves **once per session load**, server-side, in the session bundle (`server/engine/bundle.ts` `fillBundlePlayerToken`; pure helpers in `src/lib/player-token.ts`) — prompts, post-turn agents, and the status payload all see identical substituted text, and content without the token behaves exactly as before.

- **Embodied sessions** fill the player participant's display name. **Observer sessions** spawn no player row, so the token fills the fixed phrase `the protagonist` — it names the story role without asserting a present character.
- **Where it works** (the substitution contract, applied field-by-field): world description, lore synopsis, style directives, narrator guidance, norm rule/consequence text, lore chunk titles and bodies (all tiers — retrieval-tier hits are filled at their one prompt entry in the turn pipeline), location descriptions, cast snapshot bio/personality/voice, and item definition descriptions + sensory text.
- **Names are identifiers, not prose**: location names, item names, character display names, and schedule `locationName` ground cross-references (movement targets, wardrobe, schedules) and are **never** substituted — a token in a name stays literal.
- Library and editor views always show the raw token (resolution is per-session); runtime-generated text (briefs, threads, episodes, narration) can never contain it, because no agent ever sees the unsubstituted form.

## Guardrails

- **All** forge agent outputs validate against registry/contract schemas — attribute ids, body locations, lore tiers/visibility, cast roles, norm severities. A failed field or section is omitted from the draft with a diagnostic shown inline ("couldn't draft lore — regenerate or write manually"), never a broken draft. Each section regenerates independently via `generateChecked` (validate → one repair → omit).
- Diagnostics render severity-aware (`components/forge/diagnostic-list.tsx`): **error** = a failure with the regenerate call-to-action, **warn** = a degradation already applied (dropped/cleared value), **info** = muted notice (forge pages hide info entirely). A successful repair round-trip is info — recovery is not a problem to report loudly.
- Model-written cross-references (location links, item `castName`/`locationName`) resolve through `fuzzyResolveName` (exact → punctuation-normalized → unique containment); genuine misses are dropped with a "did you mean" hint in the diagnostic.
- Drafts are plain JSON in component state until save; an abandoned forge writes nothing.
- Forge calls are rate-limited per user (cheap insurance; they're the most expensive non-play operations).
