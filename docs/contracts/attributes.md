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
  coreVisual?: boolean;
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
| `coreVisual` | Always filled at character creation — first by forge inference, then a seeded default from `allowedValues` (enum only). |
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
| `inherent` | Only a human (`manual`) or a supernatural transformation (`magic`). Narrative drift is rejected at the merge write boundary (`overlaySourceMayChange`) and surfaced as a `droppedEvents` correction. |
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

The starter set is roughly 50 attributes. (Expansion toward aionchat's per-anatomy granularity is expected — the group mechanism is the contract, the vocabulary is not.)

| Category group | Attributes |
| --- | --- |
| identity | gender, apparent_age, heritage |
| build | height, frame, musculature, weight_presentation |
| skin | tone, undertone, texture, markings |
| hair | color, length, texture, style |
| eyes | color, shape, pupil, luminosity |
| face | shape, freckles, expression_default |
| brows, lips, teeth, ears | brows; lips; teeth (shape — even … sharp_canines / fanged / serrated — condition); ears |
| horns | shape, length, count, texture, color |
| neck, shoulders, chest | neck (length, throat_prominence); shoulders (width, slope); chest (size, hair) |
| wings | type, span, color, carriage |
| waist, hips | waist (definition); hips (width) |
| tail | type, length, tip, color |
| arms, hands, legs, feet | arms (build, hair); hands (size, texture, nails); legs (build, length, hair); feet (size, arch, nails, smell, toes) |
| voice | pitch, timbre, accent, cadence |
| presentation | style, grooming, scent_baseline |
| movement | gait, posture_default |

A few notes on this vocabulary:

- **Identity is free text where it must be.** `gender`, `apparent_age`, and `heritage` are all flagged `identityAnchor`. `heritage` is free text because real-world ethnicities and fantasy ancestries can't share a closed list. Structural **species** is *not* an attribute — it's `CharacterProfile.speciesId` ([body.md](body.md)).
- **Supernatural / non-human palettes are first-class.** `skin.tone`, `eyes.color`, and `hair.color` carry unnatural options (ashen / grey / blue skin, gold / red / solid-black / glowing eyes, fae hair), and `eyes.pupil` (vertical-slit, goat) reads non-human. All of these are flagged `autoDefaultExcludes`, so a human is never *auto*-assigned one — the forge or editor may still pick them, and a species rule can require them.

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
