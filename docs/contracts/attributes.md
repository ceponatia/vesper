# Attribute system

## Ids and definitions

Attribute ids are `category.name` (e.g. `eyes.color`, `hair.length`, `build.height`). Categories are a closed enum in `attributes/categories.ts` — extend by adding to the array. Definitions:

```ts
type AttributeDefinition = {
  id: `${AttributeCategory}.${string}`;
  label: string;
  kind: "physical" | "biological" | "presentation" | "cultural" | "condition" | "sensory";
  valueType: "enum" | "enum_list" | "number" | "text" | "flag";
  description: string;
  mutability: "inherent" | "mutable";   // inherent: only a human (manual) or a supernatural
                                         // transformation (magic) may change it — narrative drift is
                                         // rejected at the merge write boundary (overlaySourceMayChange)
                                         // with a droppedEvents correction. mutable: any source.
  allowedValues?: readonly string[];                   // enum/enum_list
  min?: number; max?: number; unit?: string;           // number
  bodyLocationId?: string;                             // links to the body tree
  appliesToBodyPlans?: readonly string[];              // default: all plans
  excludesBodyPlans?: readonly string[];
  appliesToEntityKinds?: readonly ("character" | "item" | "location")[];  // default: character
  aliases?: readonly string[];                         // NLP mention resolution ("ginger" → hair.color)
  promptHints?: readonly string[];                     // phrasing guidance for prompt builders
  coreVisual?: boolean;                                // always filled at character creation (forge inference,
                                                       // then seeded default from allowedValues; enum only)
  imageReveal?: "shape" | "skin";                      // full-body image reveal tier (docs/images.md §Scene images):
                                                       // "shape" reads through clothing (breast size, waist, hips, leg
                                                       // build) → always described; "skin" only when the region is
                                                       // bare/sheer (nipples, leg hair, toenails). Absent ⇒ not part of
                                                       // the scene subject's reveal line. Consumed by the scene render.
  identityAnchor?: boolean;                            // inferred first at forge time; conditions the plausible
                                                       // ranges for unset core visuals (docs/authoring.md §Character
                                                       // forge). Physical attributes only — never personality/voice/
                                                       // behavior/role. New anchors are one-line registry edits.
  autoDefaultExcludes?: readonly string[];             // enum members valid to pick but never chosen as an *automatic*
                                                       // default (forge fallback fill / picker add). e.g. minor apparent
                                                       // ages exist for background characters; no one defaults to one.
  activatesGroups?: Record<string,                     // creation-time body-config SEED keyed by enum value (never a lock):
    { intimateRegions?: readonly string[];             //   identity.gender "female" → seed intimate regions vulva+breasts.
      bodyFeatures?: readonly string[]; }>;            //   read by seedBodyConfigFromAttributes; editor stays authoritative.
};
```

## Groups and the central registry

Each category lives in one file under `attributes/categories/` (`eyes.ts`, `hair.ts`, …) exporting its **definition bundle** via `defineAttributeGroup`. The closed list of category ids is `attributes/category-ids.ts`. ("Group" = a category's bundle of definitions, *not* a body section — anatomical sections are body **locations**, [body.md](body.md).) `attributes/registry.ts` derives everything — including each id's value schema — from the bundle list:

```ts
export const attributeRegistry = buildRegistry(attributeGroups);
// .definitions, .byId(id), .parseValue(id, raw) → typed value or issue list,
// .resolveAlias(text), .forCategory(cat), .forBodyLocation(loc)
```

**To add attributes: edit/create one file under `attributes/categories/` and add it to the `attributeGroups` array.** Types, validation, alias resolution, and prompt hints all follow. A registry test asserts ids are unique, every enum has ≥2 values, aliases don't collide.

## The shared registry spine

The index + value-parser spine is **shared**: `contracts/registry` exposes a generic `buildRegistryCore({ definitions, valueSchemaFor, validate, idLabel })` (dup-id guard + per-id `parseValue`) that both the attribute registry and the personality **trait** registry ([relationships.md](relationships.md) §Disposition) instantiate, layering their own lookups on top (attributes add category/body-location/alias; traits add band readout + lexicon). One spine, two registries — so traits inherit the same machinery without duplication.

## Starter vocabulary

Starter vocabulary (~50 attributes): identity (gender, apparent_age, heritage — free text, since real-world ethnicities and fantasy ancestries can't share a closed list; all three flagged `identityAnchor`; structural species is **not** an attribute — it is `CharacterProfile.speciesId`, [body.md](body.md)), build (height, frame, musculature, weight_presentation), skin (tone, undertone, texture, markings), hair (color, length, texture, style), eyes (color, shape, pupil, luminosity), face (shape, freckles, expression_default), brows, lips, teeth (shape — even…sharp_canines/fanged/serrated — condition), ears, horns (shape, length, count, texture, color), neck, shoulders, chest, wings (type, span, color, carriage), waist, hips, tail (type, length, tip, color), arms, hands, legs, feet, voice (pitch, timbre, accent, cadence), presentation (style, grooming, scent_baseline), movement (gait, posture_default). Supernatural/non-human palettes are first-class: `skin.tone`, `eyes.color`, and `hair.color` carry unnatural options (ashen/grey/blue skin, gold/red/solid-black/glowing eyes, fae hair), and `eyes.pupil` (vertical-slit, goat) reads non-human — all flagged `autoDefaultExcludes` so a human is never auto-assigned one (the forge/editor may still pick them, or a species rule can require them). Expansion toward aionchat's per-anatomy granularity is expected; the group mechanism is the contract, the vocabulary is not.

## Values with provenance

A character never stores bare values — always:

```ts
type AttributeValue = {
  id: AttributeId;
  value: unknown;          // validated via registry.parseValue
  source: "base" | "creation" | "condition" | "injury" | "item" | "magic" | "environment" | "narrative" | "manual";
  sourceId?: string;       // e.g. condition id
  note?: string;
};
```

The source enum is extensible by design: add the value, slot it into the precedence list, update this doc. The sources + precedence + the last-write-wins resolver are the shared `contracts/registry` provenance spine (`provenanceSources`, `SOURCE_PRECEDENCE`, `resolveProvenance`); `resolveAttributes` and the traits' `resolveTraits` are thin aliases over it. Base values live in the character **profile**; runtime overlays (a haircut, a sunburn) live in participant **state** and shadow the base by id. `resolveAttributes(profile, state)` returns the effective view, last-write-wins by source precedence: `manual > condition/injury/item/magic/environment > narrative > creation > base`.
