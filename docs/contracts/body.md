[← Contracts index](index.md)

# Body model

The body model describes *where* things are on a character — the anatomy that clothing covers, that attributes attach to, and that the narrator and image prompts read from. It's a tree of body locations, refined per character by their species, heritage, and body-config.

## The body-location tree

`body/locations/` is a tree registry of body locations, split by region across `everyday.ts` · `features.ts` · `intimate.ts` · `index.ts`. Each location carries:

```ts
{ id, label, parentId?, side?, coverageRelevant?, intimateGroup?, featureGroup?, promptHints? }
```

The **everyday humanoid tree** has five roots, at coverage-useful granularity (~27 nodes). The roots double as the coverage editor's column groups:

| Root | Children |
| --- | --- |
| head | hair, face (→ eyes), ears |
| torso | neck, shoulders, chest, back, waist |
| arms | upper_arms, forearms, wrists, hands (→ fingers) |
| pelvis | hips, groin, buttocks |
| legs | thighs, calves, ankles, feet (→ toes) |

**Additive feature locations** are default-absent and tagged with a `featureGroup`:

| Feature | Hangs under | Note |
| --- | --- | --- |
| horns | head | |
| wings | back | `back` already exists under torso |
| tail | pelvis | attached near the pelvis, **not** `groin` — it is not genital anatomy |

> ⚠️ **Beware bare parent ids in coverage data.** `arms` implies hands and fingers, `torso` implies the neck, and `legs` implies feet. Garments should always use the specific parts — a t-shirt is `torso`-parts + `upper_arms`, never `arms`.

## Body plans

`body/plans.ts`: a body plan (only `humanoid` is seeded) is a set of location ids plus the applicable attribute rules. Characters reference a `bodyPlanId`. Non-humanoid plans are future *data* additions, not refactors.

Everything that targets the body — wardrobe coverage, exposure, attribute targeting — references body-location **ids**, never hardcoded strings. Garment coverage templates and the coverage editor live in [items.md](items.md) §Coverage editing.

## Intimate anatomy

Explicit anatomy (`intimate.ts`) hangs off the everyday tree under `groin` / `pelvis` / `chest`:

| Region | Parts |
| --- | --- |
| vulva | + labia, clitoris, vestibule, vagina, mons |
| penis | |
| testicles | |
| anus | |
| breasts | + nipples |

These are all `coverageRelevant: false` — a garment over `pelvis` / `chest` already covers them via `expand`, so they aren't garment slots of their own.

**Which intimate anatomy is configurable** is controlled by `intimateGroup`:

- The *configurable* parts each carry an `intimateGroup` (`INTIMATE_REGION_GROUPS = breasts · vulva · penis · testicles`), so the realized-body filter can include or omit that sub-tree per character.
- The **anus is the exception**: it carries **no** `intimateGroup`, so it is **universal** — present on every realized body (everyone has one), never a body-config toggle. It still lives in the fenced intimate subfolder and is exposure-gated like any below-waist region.

**Where intimate attributes live:** `attributes/categories/intimate/` — a fenced subfolder, easy to find and to withhold from moderation-prone routes. Its categories are `INTIMATE_ATTRIBUTE_CATEGORIES = breasts · vulva · penis · testicles` (the anus is a touchable region with no descriptive attributes yet).

The full aionchat anatomy vocabulary that didn't port in T1 (buttocks, groin, abdomen, nose, …) is catalogued in `docs/developer-notes/supplemental-anatomy.phase4.md`.

## Body-config: which anatomy a character has

A character's body-config is the set of intimate regions and additive features they actually have. Two profile fields hold it, both riding the profile JSONB (no migration):

| Field | Holds | Default / absence behavior |
| --- | --- | --- |
| `CharacterProfile.intimateRegions` | Present intimate region groups, e.g. `["vulva", "breasts"]` | `[]` = no intimate anatomy (the engine's pre-existing behavior) |
| `CharacterProfile.bodyFeatures` | Additive feature groups, e.g. `["wings", "horns", "tail"]` | *absent* ⇒ species `defaultFeatureGroups` seed it; `[]` ⇒ explicit per-character "none" |

**How `intimateRegions` is seeded.** At forge time it's filled declaratively from the attribute values' `activatesGroups` (`seedBodyConfigFromAttributes`) — e.g. `identity.gender = "female"` seeds `["vulva", "breasts"]`. Because `identity.gender` is `coreVisual`, it is always present, so the seed is reliable. It is fully overridable in the editor — a **seed, never a lock** — so a "male" character can still be given a vulva. The body-config starts empty, so "deactivate X" is simply "no value activates X".

## The realized body

`species/realize.ts` exposes `realizeBody(...)` — the single gating filter that turns the full body plan into one character's actual body:

```ts
realizeBody({ bodyPlanId, speciesId, heritageId, intimateRegions, bodyFeatures })
```

It applies four stages in order:

| Stage | What it does |
| --- | --- |
| 1. Body plan | The superset of locations. |
| 2. Species | `allowedBodyLocationIds` / `disallowedBodyLocationIds` + `defaultFeatureGroups` + attribute rules. |
| 3. Heritage | *Optional* refinement within the species — adds feature groups and overrides attribute rules per `attributeId`. Never touches the body plan or locations. |
| 4. Body-config | Which intimate groups and additive features are present. |

**What it answers:**

- Presence checks — `isLocationPresent(id)`, `hasIntimateRegion(group)`, `hasFeature(group)`, `isAttributeApplicable(def)`.
- The per-attribute **rule view** — `attributeRuleFor(id)`, `isAttributeRequired(def)`, `allowedValuesFor(def)` (the definition's values intersected with the rule's `allowedValues`, minus its `disallowedValues`), and `defaultValueFor(def)`.

All three `AttributeRule` applicabilities are live:

| Applicability | Effect |
| --- | --- |
| `forbidden` | Drops the attribute entirely. |
| `required` / `optional` | Keeps the attribute. A `required` rule with a `defaultValue` is seeded at creation — e.g. an elf's `ears.shape` → `"pointed"`. |
| `allowedValues` / `disallowedValues` | Narrows the value set per species. |

**Consumers:** the attribute editor, the narrator impression block (exposure-gated), image-prompt assembly, and the forge attribute vocabulary — so stale or gated attribute values never surface and species traits hold.

### Forge species inference

Before the forge's parallel sections run, it infers the species from text (`inferSpeciesFromText`) using registry id / label / alias matching plus a conservative token-level fuzzy fallback. A feature-bearing match seeds `speciesId`, `bodyPlanId`, and the species-default `bodyFeatures`, then unlocks the realized feature attributes for the attribute agent.

### The species catalog

Species live **one file per species** under `species/catalog/` — parity with attribute categories: a `defineSpecies(...)` per file, listed in `catalog/index.ts`. `registry.ts` derives everything from that array (`speciesById`, `isSpeciesId`, `inferSpeciesFromText`, `speciesAppearancePhrase`, `speciesLorePhrase`, `heritageFor`, `heritagesForSpecies`, `inferHeritageFromText`), so **adding a species is a single new file.**

What ships:

| Species | Default features |
| --- | --- |
| human | — (unmarked default) |
| succubus | wings, horns, tail |
| faerie | wings |
| elf, dwarf, gnome, orc, goblin | baseline humanoid records |

A further humanoid variant is a data add once its feature groups exist; true non-humanoid body plans stay future work.

### Model-facing notes: appearance vs. lore

Each species carries two optional, **model-facing** notes — both empty by default, both distinct from the internal `description`:

| Note | Audience | Contents | Surfaced via | Feeds |
| --- | --- | --- | --- | --- |
| `appearance` | image | A generic, image-safe description of the species' default morphology (pointed ears, a greenish skin cast, wings/horns/tail, broad stature) — **not** any one character's specific attribute values. | `speciesAppearancePhrase(speciesId)` | Avatar/scene image prompts (`images/prompts.ts`) and the character forge (`authoring/character-forge.ts`), which turns the generic look into concrete per-character attribute values. |
| `lore` | narrator | Cultural / identity backstory — temperament, standing, relations. | `speciesLorePhrase(speciesId)` | The narrator's canonical-facts block (`engine/scene.ts`). |

The narrator's *physical* detail comes from per-character attributes (`buildGlanceImpressions`), so via `lore` it gets culture here, not looks. Both notes surface only for **non-human** casts (label-only when the field is unauthored); the unmarked `human` default surfaces nothing.

### Heritages

A species may also carry **`heritages`** — optional sub-groups within it (e.g. `dark_elf` inside `elf`, which ships as the worked example). A heritage is a pure **overlay**:

- adds feature groups,
- **overrides** the species attribute rule for any shared `attributeId` (last-wins),
- carries its own `appearance` (**combined** with the species look) and `lore` (**replaces** the species culture note, falling back to it when absent).

The character stores an optional `profile.heritageId`. `realizeBody`'s `heritageId` composes the overlay, the phrase helpers take it as a second argument, and the forge infers it (`inferHeritageFromText`, scoped to the resolved species — heritage names like "drow" also resolve the parent species). Heritage never changes the body plan, so structural non-humanoids stay future work.

(`appliesToBodyPlans` / `excludesBodyPlans` on attributes — previously inert — are now consumed here.)

## Colloquial body references

`species/targets.ts` resolves a player's colloquial body reference to the *set* of attributes it covers — "look at her **face**" means `face` + `eyes` + `brows` + `lips` here, not just `face.*`.

It is **deterministic and pure** (not an attribute-fetch agent). A term resolves either:

- through the body-location tree — `expand` the subtree, then gather every attribute bound to those locations via `bodyLocationId`, or
- as a category id,

with a small synonym map for colloquialisms that match neither (`mouth` → lips, `figure` / `physique` → build).

| Function | Returns |
| --- | --- |
| `resolveBodyTarget(term)` | The structural expansion. |
| `expandBodyTarget(term, isApplicable)` | The expansion filtered through a character's realized body — pass `realizeBody(...).isAttributeApplicable`, so "chest" on a flat-chested character omits breast attributes. |
| `detectBodyTargets(text)` | Scans free prose (whole-word, longest-phrase-first). |

The intended consumer is the look/touch attribute surfacing for the narrator; that wiring is pending (it lives in the turn pipeline / scene assembly).
