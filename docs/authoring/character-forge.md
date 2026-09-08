# Character forge

`POST /api/characters/forge` with a prose prompt ("a weary harbor-master in her forties, dry
humor, bad knee…") returns a **draft** and never auto-saves. Three agent legs run in parallel:
the profile leg ([profile-leg.md](profile-leg.md)), the attribute leg, and the outfit leg.

The Forge and manual New entry points share one character draft. An initial Forge of a blank
draft opens an editable preview. Subsequent generated changes enter the explicit proposal review
described in [manual-editing.md](manual-editing.md); saving writes the authored draft and does not
accept pending suggestions.

## Owns / does not own

This page owns character generation and creation-draft persistence. Manual form placement,
autosave and proposal acceptance belong to [manual-editing.md](manual-editing.md). Portrait
creation and reference approval belong to [../ui/library.md](../ui/library.md).

## Resumable creation

- New and Forge open the same draft for the signed-in account on this browser. The draft stores
  authored values, the original brief, active section and pending proposals. Resume never starts
  generation or incurs model spend.
- **Start a new draft** records durable abandonment for every running, failed or unresolved run
  associated with that exact draft id. The browser resets only after those decisions succeed;
  late job completion cannot reclaim the replacement draft.
- The original brief is stored in the existing profile JSON as `creationBrief`, with an empty
  default for legacy records. It remains private in public profile projections. A prompt-based
  draft preserves the original prompt after its first successful full Forge that adds details.
  A failed or empty first response leaves the brief editable. The first Forge remains unresolved on
  the server while it runs. A successful response becomes the editable preview only after the
  browser proves that the draft and prompt still equal the request snapshot and records acceptance.
  Otherwise it preserves concurrent edits and stages suggestions for explicit review. Before the first AI action on a manual or legacy saved
  character, the editor captures the original authored details if there is no brief. The durable
  brief shares the Forge request's 4,000-character limit. Manual capture reserves space for
  identity, appearance and outfit before bounded biography, personality, voice and traits.
  Oversized existing briefs retain their opening and closing constraints within that limit.
- Revisions do not replace the original brief. Fill and rewrite receive it alongside the current
  sheet, whose later authored values remain authoritative when they disagree with the original.
- An ordinary successful first save opens the persisted character at the creation draft's active
  section. Save and open Portrait Studio or Chat opens the persisted destination directly. Pending
  proposals carry into the saved character's review storage without acceptance. Repeated saves replace
  that creation draft's pending contribution and preserve decisions made on either surface,
  without removing proposals created independently on the saved character. A failed review
  transfer retains the creation draft and a link to the requested Portrait Studio or Chat destination.
- A successful save clears only the browser version it saved. A completed generation receipt that
  is already represented in the durable draft or review does not delay the transition. If newer
  edits exist, the saved character remains linked and the newer draft stays available. Subsequent saves of that draft
  update the linked character rather than creating another character.
- The first save freezes an `initialSaveDraft` and sends the creation draft's UUID as
  `creationRequestId`. The server commits the character, its materialized items and a replayable
  response receipt in one transaction. A lost-response retry with the same request and payload
  returns that original character, version and item receipt; reuse of the UUID with different
  content never creates or overwrites another row. That refusal carries the owner-scoped original
  receipt and current character when both remain valid, so the browser binds the retained draft
  to the existing character and presents their differences for explicit recovery. An
  acknowledgment never clears newer authored changes.
- A linked creation draft retains the last saved server snapshot and `updatedAt` token. Later
  writes use that token for compare-and-set recovery: authored conflicts require explicit review,
  while a metadata-only server change advances the token without hiding local edits.
- Failed saves retain the entire draft. Browser storage failures surface a notice and keep the
  in-memory draft available. Corrupt records stay retained until an explicit replacement.
- Browser writes compare versions and use a per-draft Web Lock where available. A conflicting
  tab keeps its changes in a separate recovery copy. Selecting a recovery preserves the displaced
  version; queued writes from a version being left cannot overwrite the resumed version. Recovery
  promotion consumes the exact selected copy only after the shared write succeeds. Displaced
  shared versions use stable recovery keys rather than multiplying copies on repeated recovery.
- Browser drafts are scoped to the authenticated account, remain on this device between visits,
  and are not cloud drafts. Switching accounts remounts the authoring state and never loads the
  previous account's draft into the new account.
- Creation-run queries, browser caches and completion projection require the exact creation draft
  id. A run from an abandoned draft cannot attach itself to a pristine replacement.

## Species matching runs first

Before the parallel sections run, the forge deterministically matches species ids, labels and
aliases from the prompt against `speciesCatalog` — exact token or phrase first, then conservative
edit-distance matching for longer single-token terms — and then resolves an explicit heritage or
subtype phrase.

A match seeds structural profile fields (`speciesId`, `heritageId`, `bodyPlanId`, and
species/subtype-default `bodyFeatures`) for every section; no match keeps the normal human
default. A species with `defaultHeritageId` uses it when the prompt names only the species, so
bare "android" means Synthetic Android while "organic android" selects the clone-body subtype.

## The attribute agent

The attribute agent emits `AttributeValue[]` against the **registry**: the schema enumerates
allowed ids and values, so output is validated vocabulary rather than free text.

The forge vocabulary excludes intimate anatomy — the body-config that realizes it is seeded from
the answer itself — with one exception: an intimate definition flagged `renderVisual`
(`breasts.size`) is admitted, named plainly, so the model may state the size a concept gives
rather than have the fill invent one. The prompt says the anatomy-gated ids apply only to a body
that carries the anatomy; grounding validates the value against the registry, and the conform step
below drops it when the breasts region ends up off. The vocabulary includes additive feature
morphology only when the prompt or current draft resolves a feature-bearing species or body
config. A prompt that names no species realizes the default species' body, so the anatomy gating
holds for a plain human concept. It is also
**species-narrowed**: an attribute with a species rule shows only its narrowed allowed values, and
a `required` rule is tagged `[SPECIES]` with its default in the prompt
(`realizeBody.allowedValuesFor` / `isAttributeRequired` / `defaultValueFor`). A definite value the
model emits outside the species' set is dropped at grounding
(`forge.character.attributes.species_disallowed_value`) and refilled below, so an elf is always
pointed-eared.

The system prompt carries a **mood-word guardrail**: scene and life-circumstance adjectives (a
weathered town, a hard year) never map onto skin, hair, or build unless the text says it of the
body itself.

### The three-tier fill

Attributes flagged `coreVisual` in the registry (gender, hair and eye color, skin tone, height,
frame, apparent age) **or `renderVisual`** — the render-consistency tier of ~19 silhouette and
face-structure enums (face, nose, brow and lip shape, hair length and texture, chest build or
breast size, waist, hips, arm and leg build…) that a scene render would otherwise re-invent per
image — are always filled. Leaving them sparse is not sparseness, it is cross-scene drift. The
fill runs against the body the draft will carry — its body-config seeded from the grounded gender
(`activatesGroups`), then realized once more after the fill in case the fill invented the gender
— so an anatomy-gated pair fills for the owner that body applies: a body with the breasts region
receives `breasts.size`, one without receives `chest.size`, never both. Before each fill the values
are **conformed to that body** (`conformAttributesToBody`): a value the body does not apply is never
stored. A `chest.size` the breasts region supersedes becomes `breasts.size` through the contract's
bust-scale table (`BUST_SCALE_TO_BREAST_SIZE`, the same table the stored-value sweep uses) when it
is the only size given (`forge.character.attributes.size_translated`); with a `breasts.size` already
stated it drops, as does a structural `broad` / `barrel`, and every other inapplicable value drops
(`forge.character.attributes.inapplicable_for_body`). A forged draft therefore stores exactly one
applicable size, and a concept-stated `breasts.size` survives the fills unchanged.

1. **Definite values** — where the concept states or strongly implies a value, the model emits it
   directly. A definite value always beats a range or a species default for the same id.
2. **Plausible ranges** — for each `[CORE]`/`[RENDER]` enum attribute it cannot pin down, the
   model emits `ranges: [{ id, plausible: string[] }]`, a subset of `allowedValues` conditioned on
   the **identity anchors** it inferred first (attributes flagged `identityAnchor` in the registry:
   gender, apparent age, heritage). Structural species is not an attribute — it is
   `CharacterProfile.speciesId`, picked from the species registry. Grounding mirrors values: ranges
   on unknown ids or non-enum attributes and out-of-vocabulary members drop with
   `forge.character.attributes.invalid_range_member`, and a range emptied by grounding drops
   entirely. Guardrails live verbatim in the attributes system prompt: anchors constrain physical
   attributes only (never personality, voice, behavior, or role), explicit text always overrides a
   prior (a definite value, no range), and weak identity signal means wide ranges or none.
3. **Seeded pick** — anything still unset gets a default drawn from its surviving range
   (`fillVisualDefaults`; FNV-1a over concept + id, so different concepts vary while the same input
   forges the same draft). The pick is taken from the **species-narrowed** value set, so a
   core-visual default like orc `build.height` stays in the species band and a model range is
   intersected with that band first. No range means the pick falls through to the narrowed
   `allowedValues` minus any `autoDefaultExcludes` members — minor apparent ages, for example,
   which exist as vocabulary but are never auto-assigned — plus an info diagnostic
   (`forge.character.attributes.unconstrained_default`).

A **species-required pass** (`fillSpeciesRequiredDefaults`) then seeds any `required` species
attribute the model left unset to its rule default, even when it is not visual-flagged
(`forge.character.attributes.species_defaults`).

Everything else stays sparse-is-correct: unfillable attributes are simply omitted.

## The outfit agent

The outfit agent suggests a default outfit as item drafts — clothing kind, coverage, layer, plus
the library facets: a `wearer` target matched to the character's presentation and a `color` family
and shade, both grounded against their registries (unknown values drop with
`forge.character.outfit.unknown_wearer` / `unknown_color`).

It is shown the caller's existing clothing as **reuse candidates** (`listClothingCandidates`:
most-recently-updated first, capped at `CANDIDATE_LIMIT`) and may set a garment's `reuseId` to one
of them instead of inventing it. The prompt's policy is *reuse generic basics — any t-shirt,
jeans or sweater, colour differences do not matter — and define a new garment for a signature,
character-defining piece*; per-garment judgment lives with the model, not a fixed threshold.

A hallucinated `reuseId` degrades to a fresh garment
(`forge.character.outfit.unknown_reuse`); the remaining new garments are still name-matched
against the library, and unmatched ones become new item drafts flagged `suggested`.

## Saving a draft

On save, `suggestedItems` in the body are materialized as real library items
(`materializeSuggestedItems` in `server/api/library.ts`) — on **create and on PATCH alike**,
because the in-sheet forge and the per-tab re-draft draft suggestions on characters that already
exist, and the editor's Save is a PATCH.

A suggestion whose name matches an existing item reuses it, never duplicating. Failing an exact
name match, a **conservative embedding backstop** (`fuzzyResolve` at `ITEM_DEDUPE_MIN_SCORE`, same
item kind) collapses a near-identical garment the agent missed
(`api.library.suggested_item.fuzzy_reused`); an embedding failure degrades to a fresh insert.
Suggestion embeddings are batched before the character transaction. After the character row is
locked and its version is rechecked, exact and fuzzy candidates are queried again through that
transaction before any item is inserted. A stale save creates no items, and embedding refreshes
are queued only after commit.

New rows keep the `suggested` tag, and the resulting ids are appended to the default outfit preset.
A bad suggestion degrades — invalid coverage ids are dropped with a diagnostic — and never fails
the save. POST and PATCH return the full saved character plus an index-to-item-id receipt for the
exact suggestion array they received. The editor adds ids only for sent suggestions that are still
present when the acknowledgment arrives; a suggestion the author discarded stays discarded.
Newer prose, outfit edits and suggestions survive.
