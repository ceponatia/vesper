[← Contracts index](README.md)

# Body model

The body model describes *where* things are on a character — the anatomy that clothing covers, that attributes attach to, and that the narrator and image prompts read from. It's a tree of body locations, refined per character by their species, heritage, and body-config.

## The body-location tree

`body/locations/` is a tree registry of body locations, split by region across `everyday.ts` · `features.ts` · `intimate.ts` · `index.ts`. Each location carries:

```ts
{ id, label, parentId?, side?, coverageRelevant?, intimateGroup?, featureGroup?, promptHints? }
```

The **everyday humanoid tree** has five roots, at coverage-useful granularity (~32 nodes). The roots double as the coverage editor's column groups:

| Root   | Children                                                       |
| ------ | -------------------------------------------------------------- |
| head   | hair, face (→ eyes, nose, lips), ears                          |
| torso  | neck, shoulders, chest, back, waist                            |
| arms   | upper_arms, forearms, wrists, hands (→ fingers)                |
| pelvis | hips, groin, buttocks                                          |
| legs   | thighs, calves, ankles, feet (→ toes, top of foot, sole, heel) |

**Additive feature locations** are default-absent and tagged with a `featureGroup`:

| Feature | Hangs under | Note                                                                  |
| ------- | ----------- | --------------------------------------------------------------------- |
| horns   | head        |                                                                       |
| wings   | back        | `back` already exists under torso                                     |
| tail    | pelvis      | attached near the pelvis, **not** `groin` — it is not genital anatomy |

> ⚠️ **Beware bare parent ids in coverage data.** `arms` implies hands and fingers, `torso` implies the neck, and `legs` implies feet. Garments should always use the specific parts — a t-shirt is `torso`-parts + `upper_arms`, never `arms`.

## Body plans

`body/plans.ts`: a body plan (only `humanoid` is seeded) is a set of location ids plus the applicable attribute rules. Characters reference a `bodyPlanId`. Non-humanoid plans are future *data* additions, not refactors.

Everything that targets the body — wardrobe coverage, exposure, attribute targeting — references body-location **ids**, never hardcoded strings. Garment coverage templates and the coverage editor live in [items.md](items.md) §Coverage editing.

## Intimate anatomy

Explicit anatomy (`intimate.ts`) hangs off the everyday tree under `groin` / `pelvis` / `chest`:

| Region    | Parts                                      |
| --------- | ------------------------------------------ |
| vulva     | + labia, clitoris, vestibule, vagina, mons |
| penis     |                                            |
| testicles |                                            |
| anus      |                                            |
| perineum  |                                            |
| breasts   | + nipples                                  |

These are all `coverageRelevant: false` — a garment over `pelvis` / `chest` already covers them via `expand`, so they aren't garment slots of their own.

**Which intimate anatomy is configurable** is controlled by `intimateGroup`:

- The *configurable* parts each carry an `intimateGroup` (`INTIMATE_REGION_GROUPS = breasts · vulva · penis · testicles`), so the realized-body filter can include or omit that sub-tree per character.
- The **anus and perineum are the exception**: they carry **no** `intimateGroup`, so they are **universal** — present on every realized body (everyone has them), never a body-config toggle. They are still exposure-gated like any below-waist region.

**Where intimate attributes live:** the four *configurable* region groups live in the fenced `attributes/categories/intimate/` subfolder (easy to find and to withhold from moderation-prone routes); the two *universal* moderation-sensitive categories — `anus` and `perineum` — are top-level category files (`categories/anus.ts`, `categories/perineum.ts`), alongside `buttocks`, since they aren't body-config-gated.

**Two distinct sets, one superset relationship** (see `body/locations/intimate.ts`):

- `INTIMATE_REGION_GROUPS = breasts · vulva · penis · testicles` — the **toggleable** regions. Body-config gating (`species/realize.ts`) keys on membership here (via `isIntimateRegionGroup`), so only these can be switched off.
- `INTIMATE_ATTRIBUTE_CATEGORIES = breasts · vulva · penis · testicles · anus · perineum` — the **moderation/exposure** set (a superset). A category here is withheld from chat unless the turn's focus targets the region and from images unless the caller opts in and the region reads exposed. The two extras (anus · perineum) are universal but still exposure-sensitive.

The full aionchat anatomy vocabulary that didn't port in T1 (buttocks, groin, abdomen, nose, …) is catalogued in `docs/developer-notes/supplemental-anatomy.phase4.md`.

## Body-config: which anatomy a character has

A character's body-config is the set of intimate regions and additive features they actually have. Two profile fields hold it, both riding the profile JSONB (no migration):

| Field                              | Holds                                                       | Default / absence behavior                                                              |
| ---------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `CharacterProfile.intimateRegions` | Present intimate region groups, e.g. `["vulva", "breasts"]` | `[]` = no intimate anatomy (the engine's pre-existing behavior)                         |
| `CharacterProfile.bodyFeatures`    | Additive feature groups, e.g. `["wings", "horns", "tail"]`  | *absent* ⇒ species `defaultFeatureGroups` seed it; `[]` ⇒ explicit per-character "none" |

**How `intimateRegions` is seeded.** It's filled declaratively from the attribute values' `activatesGroups` (`seedBodyConfigFromAttributes`) — e.g. `identity.gender = "female"` seeds `["vulva", "breasts"]`. Because `identity.gender` is `coreVisual`, it is always present, so the seed is reliable. It is fully overridable in the editor — a **seed, never a lock** — so a "male" character can still be given a vulva. The body-config starts empty, so "deactivate X" is simply "no value activates X".

Three paths seed it, and each seeds **once, at creation** — nothing re-derives the body-config afterwards, so an author who changes gender in the editor changes the anatomy toggles themselves:

| Path                          | Seeds when                                          |
| ----------------------------- | --------------------------------------------------- |
| Character forge               | Always, from the grounded draft's attribute values   |
| `POST /api/characters`        | The incoming profile carries no attributes at all    |
| `POST /api/personas`          | The incoming profile carries no body-config          |

The persona gate is the body-config rather than the whole profile because a persona has no forge and no clone: its only non-blank creator is an API client, and one sending `identity.gender` with no anatomy wants the anatomy that gender activates (`seedNewPersonaProfile`, `contracts/players/persona-profile.ts`). A supplied config always wins on every path.

**A seed never writes an empty `bodyFeatures`.** Per the table above, absent means "use the species and heritage defaults" while `[]` is an explicit "none" — so a seed that activates no feature group leaves the field alone rather than writing `[]`, which would strip a succubus of its wings, horns, and tail.

## The realized body

`species/realize.ts` exposes `realizeBody(...)` — the single gating filter that turns the full body plan into one character's actual body:

```ts
realizeBody({ bodyPlanId, speciesId, heritageId, intimateRegions, bodyFeatures })
```

It applies four stages in order:

| Stage               | What it does                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Body plan        | The superset of locations.                                                                                                                                                                                                  |
| 2. Species          | `allowedBodyLocationIds` / `disallowedBodyLocationIds` + `defaultFeatureGroups` + attribute rules.                                                                                                                          |
| 3. Heritage/subtype | Refinement within the species — adds feature groups and overrides attribute rules per `attributeId`. Usually optional; a species may declare a degraded-safe `defaultHeritageId`. Never touches the body plan or locations. |
| 4. Body-config      | Which intimate groups and additive features are present.                                                                                                                                                                    |

**What it answers:**

- Presence checks — `isLocationPresent(id)`, `hasIntimateRegion(group)`, `hasFeature(group)`, `isAttributeApplicable(def)`.
- The per-attribute **rule view** — `attributeRuleFor(id)`, `isAttributeRequired(def)`, `allowedValuesFor(def)` (the definition's values intersected with the rule's `allowedValues`, minus its `disallowedValues`), and `defaultValueFor(def)`.

All three `AttributeRule` applicabilities are live:

| Applicability                        | Effect                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `forbidden`                          | Drops the attribute entirely.                                                                                                  |
| `required` / `optional`              | Keeps the attribute. A `required` rule with a `defaultValue` is seeded at creation — e.g. an elf's `ears.shape` → `"pointed"`. |
| `allowedValues` / `disallowedValues` | Narrows the value set per species.                                                                                             |

**Consumers:** the attribute editor, the narrator impression block (exposure-gated), image-prompt assembly, and the forge attribute vocabulary — so stale or gated attribute values never surface and species traits hold.

### Forge species inference

Before the forge's parallel sections run, it infers the species from text (`inferSpeciesFromText`) using registry id / label / alias matching plus a conservative token-level fuzzy fallback, then resolves a named heritage/subtype or the species default. A match seeds `speciesId`, `heritageId`, `bodyPlanId`, and the resolved species/subtype `bodyFeatures`, then unlocks the realized attributes for the attribute agent.

### The species catalog

Species live **one file per species** under `species/catalog/` — parity with attribute categories: a `defineSpecies(...)` per file, listed in `catalog/index.ts`. `registry.ts` derives everything from that array (`speciesById`, `isSpeciesId`, `inferSpeciesFromText`, `speciesAppearancePhrase`, `speciesLorePhrase`, `heritageFor`, `heritagesForSpecies`, `inferHeritageFromText`), so **adding a species is normally a single new file.** Android is the first species with a default subtype: an absent/unknown `heritageId` resolves to Synthetic Android; Organic Android is an explicit overlay. Both use the complete humanoid plan, while species rules keep synthetic-only sensory enum members out of every biological humanoid's vocabulary.

What ships:

| Species                        | Default features                                |
| ------------------------------ | ----------------------------------------------- |
| human                          | — (unmarked default)                            |
| android                        | — (Synthetic default subtype; Organic explicit) |
| succubus                       | wings, horns, tail                              |
| faerie                         | wings                                           |
| elf, dwarf, gnome, orc, goblin | baseline humanoid records                       |

A further humanoid variant is a data add once its feature groups exist; true non-humanoid body plans stay future work.

### Model-facing notes: appearance, lore, intimacy

Each species carries three optional, **model-facing** notes — all empty by default, all distinct from the internal `description`. Each has one audience and one surfacing rule:

- **`appearance`** — audience: image.
  - *Contents:* A generic, image-safe description of the species' default morphology (pointed ears, a greenish skin cast, wings/horns/tail, broad stature) — **not** any one character's specific attribute values.
  - *Surfaced via:* `speciesForgeDescriptor` (forge), reading `species.appearance` directly — `speciesAppearancePhrase(speciesId)` is retained but **currently unused**.
  - *Feeds:* The character forge's species-context prompt (`authoring/character-forge.ts`), which folds the generic look into the prompt to guide per-character attribute inference. **Not** sent to image prompts — those name the species via `speciesLabelPhrase` (name only) and let the character's feature attributes carry the morphology; `speciesAppearancePhrase` is kept for a possible re-enable.
- **`lore`** — audience: narrator (**always**).
  - *Contents:* Cultural / identity backstory — temperament, standing, relations.
  - *Surfaced via:* `speciesLorePhrase(speciesId)`.
  - *Feeds:* The narrator's canonical-facts block (`engine/scene.ts`).
- **`intimacy`** — audience: narrator (**intimate-tier only**).
  - *Contents:* How that kind of being tends to read as a lover — innate temperament, instincts, quirks. Bare text (no `Label —` prefix).
  - *Surfaced via:* `speciesIntimacyNote(speciesId, heritageId)`.
  - *Feeds:* The **exposure-gated** intimate-disposition block (`engine/scene.ts` `buildIntimateDispositionBlock`), appended with the per-character `profile.intimacy` and surfaced to the narrator **only when the turn's `ExposureMask` reaches the intimate tier on any axis** (appearance/touch/taste — ruled 2026-07-13). Zero tokens in every ordinary scene. See [intimacy-notes.spec.md](../developer-notes/finished/intimacy-notes.spec.md).

The narrator's *physical* detail comes from per-character attributes (`buildGlanceImpressions`), so via `lore` it gets culture here, not looks. `appearance` and `lore` surface only for **non-human** casts (label-only when the field is unauthored); the unmarked `human` default surfaces nothing. `intimacy` is the odd one out on merge — it returns **bare** text and is gated by the exposure mask, not by presence alone; a human character with no species archetype still contributes its own `profile.intimacy` at the gate.

### Heritages

A species may also carry **`heritages`** — sub-groups within it (e.g. `dark_elf` inside `elf`). The same overlay represents Android's mechanical **subtypes**; `subtypeLabel` changes the editor label and `defaultHeritageId` supplies a required/default choice without a new profile field. A heritage/subtype is a pure **overlay**:

- adds feature groups,
- **overrides** the species attribute rule for any shared `attributeId` (last-wins),
- carries its own `appearance` (**combined** with the species look), `lore` (**replaces** the species culture note, falling back to it when absent), and `intimacy` (**replaces** the species intimate-disposition note, falling back to it when absent — same rule as `lore`; the sprite/faerie pair is the worked example).

The character stores an optional `profile.heritageId`. When absent or invalid, `realizeBody` composes the species' `defaultHeritageId` if one exists (otherwise the bare species); the phrase helpers take the stored id as a second argument, and the forge infers it (`inferHeritageFromText`, scoped to the resolved species — heritage names like "drow" also resolve the parent species). Heritage never changes the body plan, so a heritage cannot make a structural non-humanoid.

(`appliesToBodyPlans` / `excludesBodyPlans` on attributes are consumed here.)

## Colloquial body references

`species/targets.ts` resolves a player's colloquial body reference to the *set* of attributes it covers — "look at her **face**" means `face` + `eyes` + `nose` + `lips` (+ `brows`) here, not just `face.*`.

It is **deterministic and pure** (not an attribute-fetch agent). A term resolves either:

- through the body-location tree — `expand` the subtree, then gather every attribute bound to those locations via `bodyLocationId`, or
- as a category id,

with a small synonym map for colloquialisms that match neither (`mouth` → lips + teeth, `figure` / `physique` → build).

| Function                               | Returns                                                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveBodyTarget(term)`              | The structural expansion.                                                                                                                                                   |
| `expandBodyTarget(term, isApplicable)` | The expansion filtered through a character's realized body — pass `realizeBody(...).isAttributeApplicable`, so "chest" on a flat-chested character omits breast attributes. |
| `detectBodyTargets(text)`              | Scans free prose (whole-word, longest-phrase-first).                                                                                                                        |

Consumers: the **chat lane's Sensory-focus block** (`buildSensoryFocusSection`, prompts/character-chat.ts — `expandBodyTarget` over the detected focus `region` surfaces the target's own attributes, sensory-grounding 2026-07-12; the resolver also handles **singular forms** of plural locations — "foot" → `feet` — for exactly this).
