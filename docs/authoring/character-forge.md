# Character forge

`POST /api/characters/forge` with a prose prompt ("a weary harbor-master in her forties, dry
humor, bad knee…") returns a **draft** and never auto-saves. Three agent legs run in parallel:
the profile leg ([profile-leg.md](profile-leg.md)), the attribute leg, and the outfit leg.

The forge UI renders the draft as the same form used for manual editing — accept, tweak any
field, regenerate any single section (each agent re-runs independently), then save. After save,
the avatar pipeline can run from the attributes.

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

The forge vocabulary excludes intimate anatomy, and includes additive feature morphology only when
the prompt or current draft resolves a feature-bearing species or body config. It is also
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
receives `breasts.size`, one without receives `chest.size`, never both.

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

New rows keep the `suggested` tag, and the resulting ids are appended to `profile.defaultOutfit`.
A bad suggestion degrades — invalid coverage ids are dropped with a diagnostic — and never fails
the save. The PATCH response returns the saved profile so the sheet editor can adopt the new ids
and clear its suggestion rows: the outfit tab's "suggested" rows are pending until a save, and
Save is what creates them.
