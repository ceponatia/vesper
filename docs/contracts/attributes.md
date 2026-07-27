[← Contracts index](README.md)

# Attribute system

Attributes are the individual descriptive facts about a character — eye color, hair length, height, and so on. They are defined as data in a registry, so the vocabulary can grow without touching code or the database.

## Ids and definitions

Every attribute id is `category.name` — e.g. `eyes.color`, `hair.length`, `build.height`. Categories are a closed list in `attributes/category-ids.ts`; you extend it by adding to the array.

Each attribute is described by an `AttributeDefinition`:

```ts
type AttributeDefinition = {
  id: `${AttributeCategory}.${string}`;
  label: string;
  kind: "physical" | "biological" | "presentation" | "cultural" | "condition" | "sensory";
  category: AttributeCategory;
  valueType: "enum" | "enum_list" | "number" | "text" | "flag";
  description: string;
  mutability: "inherent" | "mutable";
  allowedValues?: readonly string[];                       // enum / enum_list
  min?: number; max?: number; unit?: string;               // number
  bodyLocationId?: string;
  appliesToBodyPlans?: readonly string[];
  excludesBodyPlans?: readonly string[];
  appliesToEntityKinds?: readonly ("character" | "item" | "location")[];
  aliases?: readonly string[];
  promptHints?: readonly string[];
  narratorGuidance?: Record<string, string>;               // enum member → gloss
  excludeFromPrompts?: boolean;
  renderNoneInPrompts?: boolean;
  coreVisual?: boolean;
  defaultValue?: string | string[] | number | boolean;
  imageReveal?: "shape" | "skin";
  identityAnchor?: boolean;
  autoDefaultExcludes?: readonly string[];
  activatesGroups?: Record<string,
    { intimateRegions?: readonly string[]; bodyFeatures?: readonly string[] }>;
};
```

### What each field means

| Field | Meaning |
| --- | --- |
| `id` | `category.name`, e.g. `eyes.color`. |
| `label` | Human-readable name shown in editors. |
| `kind` | Which family the attribute belongs to (see below). |
| `category` | The attribute's category, from the closed list (`category-ids.ts`). |
| `valueType` | The shape of the value (see below). |
| `description` | Plain-language explanation of the attribute. |
| `mutability` | `inherent` or `mutable` — who is allowed to change it (see below). |
| `allowedValues` | The legal choices, for `enum` / `enum_list` attributes. |
| `min` / `max` / `unit` | Range and unit, for `number` attributes. |
| `bodyLocationId` | Links the attribute to a node in the body tree ([body.md](body.md)). |
| `appliesToBodyPlans` | Body plans this attribute applies to (default: all). |
| `excludesBodyPlans` | Body plans this attribute is excluded from. |
| `appliesToEntityKinds` | `character`, `item`, or `location` (default: character only). |
| `aliases` | Words that resolve to this attribute when mentioned in text — e.g. "ginger" → `hair.color`. |
| `promptHints` | Phrasing guidance for the prompt builders. |
| `narratorGuidance` | **Per-value** gloss: a partial map from enum member to a short authored meaning ("cheesy" → "dense fermented funk, like aged cheese …"), rendered inline as a parenthetical wherever a read-side prompt states the resolved value (chat + session `attributePhrase`) and on each listed choice write-side (`describeConstraint`, picker tooltips). Image prompts never render it. **Sparse by design** — gloss only ambiguous or game-calibrated members. **Orthogonality rule:** a gloss describes only its own attribute's dimension (in-dimension ordinal context is fine; another attribute's dimension — e.g. height words in a `frame` gloss — is an entangled-vocabulary bug to fix in `allowedValues`, not to launder through the gloss). Keys must be `allowedValues` members, enum/enum_list only — enforced at group-definition time + registry tests. See `attribute-narrator-guidance.plan.md`. |
| `excludeFromPrompts` | Stored, authored, and editable, but omitted from **every** generated prompt (image, narrator, chat) — a scaffold field not yet wired in (e.g. `identity.natal_sex`). Drop the flag when the render logic lands. |
| `renderNoneInPrompts` | Opt-in to render a resolved `"none"` in generated prompts. By default every prompt builder **elides** a `"none"` value (`promptValueWithNoneElided` in `value.ts`, applied in the image builders' `formatAttributeValue` and chat's `attributePhrase`; enum_lists have their `"none"` members filtered): "nose piercings: none" spends tokens to plant the very noun we don't want, and image models sometimes paint the mentioned feature anyway. Set only where the absence IS the appearance fact the model would otherwise invent around — today `vulva.pubic_hair_density` (fully bare) and `vulva.swelling` (doesn't swell when aroused), both with a `narratorGuidance` gloss turning the bare token into an explicit negative. Requires `"none"` in `allowedValues` (enforced at group-definition time). Storage/editing never affected — a stored `"none"` still pins the value down in the editor, unlike *unset*, which invites forge/narrator inference. |
| `coreVisual` | Always filled at character creation — first by forge inference, then a seeded default from `allowedValues` (enum only). |
| `renderVisual` | The second always-filled tier (forge-gaps.plan.md): silhouette/face-structure enums a scene render re-invents per image when unset (face/nose/brow/lip shape, hair length/texture, chest/waist/hips, limb builds …). Same forge range-emission + seeded fill as `coreVisual` (`fillVisualDefaults`). Enum-only; mark sparingly. |
| `defaultValue` | Curated registry default (female-leaning where gendered — owner ruling 2026-07-11). `seedRegistryDefaultValues` stores these on a **truly blank** character at create time (plus the body-config the seeded gender implies); the editor's `defaultValueFor` prefers it when materializing a row. The forge does NOT use it for unconstrained fills — its concept-hashed variety is deliberate. Enum defaults are validated against `allowedValues` at group-definition time. |
| `imageReveal` | Whether/when this attribute appears in a full-body image (see **Image reveal tiers** below). |
| `identityAnchor` | A defining physical trait inferred first at forge time; it conditions the plausible ranges for unset core visuals (`docs/authoring.md` §Character forge). **Physical attributes only** — never personality, voice, behavior, or role. New anchors are one-line registry edits. |
| `autoDefaultExcludes` | Enum members that are valid to pick but never chosen as an *automatic* default (forge fallback fill / picker add). E.g. minor apparent ages exist for background characters, but no one defaults to one. |
| `activatesGroups` | A creation-time body-config **seed** keyed by enum value (never a lock). E.g. `identity.gender = "female"` seeds the intimate regions `vulva` + `breasts`. Read by `seedBodyConfigFromAttributes`; the editor stays authoritative. |

### Attribute kinds

`physical` · `biological` · `presentation` · `cultural` · `condition` · `sensory`

### Value types

| Type | Holds |
| --- | --- |
| `enum` | One value from `allowedValues`. |
| `enum_list` | Several values from `allowedValues`. |
| `number` | A number within `min`–`max` (with optional `unit`). |
| `text` | Free text. |
| `flag` | A simple on/off. |

### Mutability

| Value | Who can change it |
| --- | --- |
| `inherent` | Only a human (`manual`) or a supernatural transformation (`magic`). Narrative drift is rejected at the overlay write boundary (`overlaySourceMayChange`). |
| `mutable` | Any source. |

### Image reveal tiers

`imageReveal` controls whether an attribute appears in a full-body image (`docs/images.md` §Scene images):

| Value | When it's described |
| --- | --- |
| `shape` | Reads *through* clothing — breast size, waist, hips, leg build — so it is **always** described. |
| `skin` | Only when the region is bare or sheer — nipples, leg hair, toenails. |
| *absent* | Not part of the scene subject's reveal line. |

Consumed by the scene render.

## Groups and the central registry

Each category lives in one file under `attributes/categories/` (`eyes.ts`, `hair.ts`, …) and exports its **definition bundle** via `defineAttributeGroup`. The closed list of category ids is in `attributes/category-ids.ts`.

> A "group" is a category's bundle of definitions — **not** a body section. Anatomical sections are body **locations** ([body.md](body.md)).

`attributes/registry.ts` derives everything — including each id's value schema — from the bundle list:

```ts
export const attributeRegistry = buildRegistry(attributeGroups);
// .definitions, .byId(id), .parseValue(id, raw) → typed value or issue list,
// .resolveAlias(text), .forCategory(cat), .forBodyLocation(loc)
```

**To add attributes:** edit or create one file under `attributes/categories/` and add it to the `attributeGroups` array. Types, validation, alias resolution, and prompt hints all follow automatically. A registry test asserts that ids are unique, every enum has ≥2 values, and aliases don't collide.

## The shared registry spine

The index + value-parser machinery is **shared**. `contracts/registry` exposes a generic `buildRegistryCore({ definitions, valueSchemaFor, validate, idLabel })` — a duplicate-id guard plus a per-id `parseValue` — that two registries build on:

- the **attribute** registry (adds category / body-location / alias lookups), and
- the personality **trait** registry (adds band readout + lexicon — [relationships.md](relationships.md) §Disposition).

One spine, two registries, so traits inherit the same machinery without duplication.

## Starter vocabulary

The starter set is roughly 120 attributes across all categories (the table below lists the everyday + morphology groups; the intimate-anatomy groups add the rest). (Expansion toward aionchat's per-anatomy granularity is expected — the group mechanism is the contract, the vocabulary is not.)

| Category group | Attributes |
| --- | --- |
| identity | gender, natal_sex, apparent_age, heritage |
| build | height, frame, musculature, weight_presentation |
| skin | tone, undertone, texture, markings |
| hair | color, length, texture, quality, style |
| eyes | color, shape, pupil, luminosity |
| face | shape, freckles, expression_default |
| nose | shape, size, piercings |
| brows, lips, teeth, ears | brows; lips (fullness, shape, piercings); teeth (shape — even … sharp_canines / fanged / serrated — condition); ears |
| horns | shape, length, count, texture, color |
| neck, shoulders, chest | neck (length, throat_prominence); shoulders (width, slope); chest (size, hair) |
| wings | type, shape, span, color, carriage |
| waist, hips, buttocks | waist (definition); hips (width); buttocks (size, shape, firmness, cheek_separation, dimples, texture, hair, sensitivity) |
| anus, perineum | Universal but **moderation-gated** below-waist anatomy (present on every body, like buttocks, but in `INTIMATE_ATTRIBUTE_CATEGORIES`). anus (appearance, color, tightness, texture, hair, sensitivity, lubrication, scent); perineum (texture, sensitivity, hair) |
| tail | type, length, tip, color |
| arms, hands, legs, feet | arms (build, hair); hands (size, texture, nails); legs (build, length, hair); feet (size, arch, nails, smell, toes) |
| voice | pitch, timbre, accent, cadence |
| presentation | style, grooming, scent_baseline |
| movement | gait, posture_default |

A few notes on this vocabulary:

- **Identity is free text where it must be.** `gender`, `apparent_age`, and `heritage` are all flagged `identityAnchor`. `heritage` is free text because real-world ethnicities and fantasy ancestries can't share a closed list. Structural **species** is *not* an attribute — it's `CharacterProfile.speciesId` ([body.md](body.md)).
- **`gender` encodes natal sex for ambiguous presentations.** The androgynous and nonbinary presentations are split by sex at birth — `androgynous_born_female` / `androgynous_born_male` / `nonbinary_born_female` / `nonbinary_born_male` (alongside plain `female` / `male`) — so image generation renders the right underlying build (an androgynous look reads very differently on a natal-female vs natal-male frame), and so each born-variant seeds the matching natal anatomy via `activatesGroups` (overridable in the editor). The value humanizes straight into the image subject phrase ("androgynous born female").
- **`natal_sex` is a forward-looking scaffold** (`identity.natal_sex`, enum `female`/`male`): a structured sex-at-birth field, distinct from presented `gender`. It is flagged **`excludeFromPrompts`** — stored, authored, and editable, but **not yet surfaced in any generated prompt** (image, narrator, or chat); the gender born-variant carries natal sex into rendering for now. The editor surfaces it **only for an androgynous / nonbinary presentation** (it's redundant for plain `female` / `male`). The planned expansion — intersex/trans handling, a model-facing definition of what each gender means in-game, and possibly superseding the gender born-variants — lives in [deferred.plan.md](../developer-notes/deferred.plan.md) §Natal sex. When wiring it into prompts later, drop `excludeFromPrompts` and add the render logic to the attribute-iterating builders that currently skip it.
- **Supernatural / non-human palettes are first-class.** `skin.tone`, `eyes.color`, and `hair.color` carry unnatural options (ashen / grey / blue skin, gold / red / solid-black / glowing eyes, fae hair), and `eyes.pupil` (vertical-slit, goat) reads non-human. All of these are flagged `autoDefaultExcludes`, so a human is never *auto*-assigned one — the forge or editor may still pick them, and a species rule can require them.
- **Piercings are attributes; the jewelry is wardrobe.** `ears.piercings`, `nose.piercings`, and `lips.piercings` describe the piercing *holes* (permanent/presentation body detail); the removable pieces worn in them are clothing items with a jewelry subtype ([items.md](items.md) §Clothing subtypes). Prompts mention both when present.

## Values with provenance

A character never stores a bare value. Every attribute value carries where it came from:

```ts
type AttributeValue = {
  id: AttributeId;
  value: unknown;          // validated via registry.parseValue
  source: "base" | "creation" | "condition" | "injury" | "item"
        | "magic" | "environment" | "narrative" | "manual";
  sourceId?: string;       // e.g. the condition id
  note?: string;
};
```

The `source` enum is extensible by design: add the value, slot it into the precedence list, and update this doc.

**Where values live:** base values live on the character **profile**; runtime overlays (a haircut, a sunburn) live in participant **state** and shadow the base value by id.

**How conflicts resolve:** `resolveAttributes(profile, state)` returns the effective view, last-write-wins by source precedence (highest first):

```
manual  >  condition / injury / item / magic / environment  >  narrative  >  creation  >  base
```

The sources, the precedence order, and the last-write-wins resolver are the shared `contracts/registry` provenance spine (`provenanceSources`, `SOURCE_PRECEDENCE`, `resolveProvenance`). `resolveAttributes` and the traits' `resolveTraits` are thin aliases over it.

## Renaming vocabulary (data edit + one-off sweep)

Vocabulary changes are **data edits in the registry, never schema migrations** — but renaming an enum member (or re-scoping an attribute's `allowedValues`) is the one edit that can *invalidate stored values*: a value no longer in `allowedValues` fails `parseValue` and degrades away on read, silently losing authored detail. Adding values is always safe; renaming/removing them takes the two-part pattern:

1. **Freeform still maps.** If the old word is a useful free-text mention, keep it as an `aliases` entry on whichever attribute it now belongs to (definition-level text→attribute-id resolution — e.g. `curvy` moved from a dead `build.frame` value to `hips.width`'s aliases). This does **not** re-map a stored value; it only keeps authoring text resolving.
2. **Stored rows get swept.** A one-off, idempotent script maps each old stored value to its canonical successor across **every** attribute-value storage site, so no pre-rename row survives to fail validation. The template is `scripts/sweep-renamed-attribute-values.ts` (the attribute-narrator-guidance slice-3 sweep): remaps keyed **by attribute id** (the same word can stay valid on another attribute), covering `characters.profile.attributes` and `character_chat_state` overlays + conditions. It is deliberately **not** `parseOr`-based — a migration must never drop an element it can't recognize, so unknown-shaped entries pass through and only the `{id,value}` pair is rewritten. Run it once per environment after shipping the rename.
