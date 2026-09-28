# Character forge

`POST /api/characters/forge` with a prose prompt ("a weary harbor-master in her forties, dry
humor, bad knee…") returns a **draft** and never auto-saves; it is a stateless preview, not part of
character creation. Three agent legs run in parallel: the profile leg
([profile-leg.md](profile-leg.md)), the attribute leg, and the outfit leg.

**New** creates a blank character (create-on-new: `POST /api/characters` with a randomized
placeholder name) and opens its editing page. **Forge** does the same and opens the page with the
creation-brief panel expanded (`?forge=1`). Save and autosave on the character page
([manual-editing.md](manual-editing.md)) are the only save paths; there is no separate creation
draft.

## Owns / does not own

This page owns character generation, the creation-brief panel and the first-Forge auto-apply rule.
Manual form placement, autosave and proposal acceptance belong to
[manual-editing.md](manual-editing.md). Portrait creation and reference approval belong to
[../ui/library.md](../ui/library.md).

## The creation brief

- The character page's creation-brief panel opens expanded when reached with `?forge=1`, collapsed
  otherwise. With no saved brief, it holds an editable textarea and **Forge character**. With a
  saved brief, it shows the brief read-only as **Original brief** and offers **Regenerate character
  suggestions** instead.
- A `create` authoring run targets a saved character (`{ kind: "character", id }`). The server
  rebuilds the generation base and the creation snapshot from the saved row: it uses the row's
  saved brief when present, else the submitted prompt, and refuses a run whose effective brief is
  empty. The brief is written to the character only when the resulting proposal is accepted, never
  on an unresolved or rejected run.
- The brief is stored in the existing profile JSON as `creationBrief`, with an empty default for
  legacy records, and stays private in public profile projections. Before the first AI action on a
  manual or legacy saved character with no brief, the editor captures the original authored details
  as the brief so later Fill and Re-draft have context to work from. The durable brief shares the
  Forge request's 4,000-character limit; manual capture reserves space for identity, appearance and
  outfit before bounded biography, personality, voice and traits, and an oversized existing brief
  retains its opening and closing constraints within that limit.
- Revisions never replace the original brief. Fill and rewrite receive it alongside the current
  sheet, whose later authored values remain authoritative when they disagree with the original.

## The first Forge applies directly

- The server computes `initialPreview` for every `create` run: true only while the character
  remains exactly as created — authoring revision 1, profile and tags equal to a freshly created
  blank, compared without key-order sensitivity. The client never computes it.
- When a completed run's `initialPreview` is true, its proposal is unresolved, and the browser is
  receiving it for the first time, the character page accepts it immediately, with no review step,
  and refreshes the saved character and its editor. The accept carries the run's source authoring
  revision, so any edit made meanwhile — including one made while the run was still in flight —
  turns that same run into an ordinary proposal for [manual review](manual-editing.md) instead
  (#517: AI output never silently replaces authored values).
- A refused auto-accept (the character changed underneath the run) leaves the run as an ordinary
  pending proposal; nothing else happens automatically.
- A failed or empty first response leaves the brief editable and unsaved. The panel may prefill
  the textarea from the failed attempt's prompt so a retry does not start from a blank field.

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
