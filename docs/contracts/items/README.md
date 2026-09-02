[← Contracts index](../README.md)

# Items and wardrobe

Items cover clothing, objects, and containers. An `ItemDefinition` is the reusable template;
placed copies — worn, held, on the floor, in a box — are *instances*.

## Reading order

| Doc                                  | What it covers                                                           |
| ------------------------------------ | ------------------------------------------------------------------------ |
| [visibility.md](visibility.md)       | The occlusion rule, `exposedRegions`, and the effective-coverage read    |
| [garment-nouns.md](garment-nouns.md) | How free-text prose resolves to coverage: hinges, negation, comparatives |

The vocabularies — clothing categories and subtypes, object subtypes, wearer, color — and
coverage editing are on this page.

## `ItemDefinition`

```ts
type ItemDefinition = {
  kind: "clothing" | "object" | "container";
  name: string; description: string;
  coverage?: BodyLocationId[];                 // clothing
  category?: string;                           // clothing — editor template id (never in prompts)
  subtype?: string;                            // object — object subtype id (vocabulary)
  wearer?: string;                             // clothing — wearer-target id (feminine/masculine/unisex)
  color?: { family: string; shade?: string; accent?: string };  // color-family id + free-text shade
  layer?: 0 | 1 | 2 | 3;                        // 0 underwear … 3 outerwear
  opacity?: "opaque" | "sheer";
  hairOcclusion?: "none" | "partial" | "full"; // clothing (headwear) — overrides the subtype default
  sensory?: { appearance?: string; scent?: string; tactile?: string };
  attentionHint?: "absorbing" | "faces_away" | "outward";
  fields?: Record<string, unknown>;            // kind-specific extras
  tags: string[];
};
```

| Field                  | Meaning                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`                 | `clothing`, `object`, or `container`. Embedded in item rows / instance snapshots, not self-identified.                                                                                                                   |
| `name` / `description` | Display text.                                                                                                                                                                                                            |
| `coverage`             | Body-location ids the garment covers (clothing only).                                                                                                                                                                    |
| `category`             | Clothing only: the coverage-template id this item started from. **Editor display only** — never serialized into gameplay prompts (see [Clothing categories](#clothing-categories)).                                      |
| `subtype`              | Objects: the object-subtype id (see [Object subtypes](#object-subtypes)). Clothing: the accessory-type id for subtyped categories (see [Clothing subtypes](#clothing-subtypes)) — **prompt-bearing**, unlike `category`. |
| `wearer`               | Clothing only: wearer-target id — `feminine`/`masculine`/`unisex` (see [Wearer](#wearer)). Absent = unspecified, matched as unisex.                                                                                      |
| `color`                | Primary color: `family`/`accent` are color-family ids, `shade` is free text (see [Color](#color)). Any kind may carry one; clothing is the primary surface.                                                              |
| `layer`                | `0` underwear → `3` outerwear.                                                                                                                                                                                           |
| `opacity`              | `opaque` or `sheer`.                                                                                                                                                                                                     |
| `hairOcclusion`        | Headwear only: how much hair the item hides — `none` / `partial` / `full`. Overrides the subtype default (see [Hair occlusion](#hair-occlusion)). Optional; absent keeps the default.                                    |
| `sensory`              | Optional `appearance` / `scent` / `tactile` notes.                                                                                                                                                                       |
| `attentionHint`        | `absorbing` / `faces_away` / `outward` — reserved perception hint; no lane reads it.                                                                                                                                     |
| `fields`               | Kind-specific extras (capacity, wearable container, …).                                                                                                                                                                  |
| `tags`                 | Free-form labels.                                                                                                                                                                                                        |

An instance's placement is **exactly one of**: worn by a participant · held by a participant ·
in a location · in a container instance.

## Clothing categories

`items/clothing-categories.ts` holds authoring-time **coverage templates**:

> top · outerwear · dress · pants · shorts · skirt · bra · underwear · socks · footwear · gloves · headwear · eyewear · jewelry

Picking one pre-fills coverage and layer in the item editor, and the forges may emit one per
garment to anchor coverage; everything stays editable afterward. The chosen id is stored as
`ItemDefinition.category` for **editor display only** — **category names never enter gameplay
prompts** ([../../character-chat/prompts.md](../../character-chat/prompts.md) §Style rules for
prompt text). The engine reads the resolved coverage set, so a "top" with arm coverage removed
simply plays as a tank top.

Templates deliberately avoid parent ids that over-imply:

| Template | Uses                       | Avoids (and why)           |
| -------- | -------------------------- | -------------------------- |
| top      | torso-parts + `upper_arms` | `arms` — would cover hands |
| pants    | `pelvis` + leg parts       | `legs` — would cover feet  |
| headwear | `hair`                     | `head`                     |

Expanding the set is a one-file data edit.

## Clothing subtypes

`items/subtypes/` holds per-category **accessory vocabularies** — one data file per category
(`jewelry.ts`, `headwear.ts`, `eyewear.ts`), aggregated by `subtypes/index.ts`
(`clothingSubtypesForCategory`, `clothingSubtypeById`, `clothingSubtypeLabel`). They reuse the
`ItemDefinition.subtype` field objects already carry; the item editor shows a **Type** select
whenever the picked category has a vocabulary, and the classify backfill fills absent ones.

> jewelry: earring · nose ring · nose stud · septum ring · lip ring · lip stud · eyebrow ring · necklace · choker · bracelet · ring · anklet · belly ring · brooch
> headwear: hat · cap · beanie · hood · bandana · headband · hairpin · ribbon · tiara · crown · veil · visor · headscarf · hijab · turban · wimple · snood · swim cap · helmet
> eyewear: glasses · sunglasses · monocle · goggles · eyepatch · blindfold · masquerade mask

Two deliberate differences from categories:

- **Subtype labels ARE prompt-bearing.** Image prompts and the narrator's Visible-wardrobe block
  lead the garment phrase with the label ("nose ring: thin gold hoop") — a bare jewelry name gave
  the image model too little to place the piece. The category HARD RULE (names never in prompts)
  is unchanged.
- **Subtypes may carry a coverage template** (a lip ring → `["lips"]`, a choker → `["neck"]`; a
  brooch has none — it pins to clothing). Picking one pre-fills coverage like a category template;
  the `lips` and `nose` body locations under `face` exist for exactly these anchors.

Extending a vocabulary is a one-line edit in that category's file; adding a vocabulary to another
category is a new file plus one map entry in `subtypes/index.ts`.

## Hair occlusion

`items/hair-occlusion.ts` is the band that says how much of a wearer's hair their worn headwear
hides: `none` (rests in or on the hair), `partial` (hides some; the hair attributes stay relevant),
`full` (encloses it; no hair is visible). It is separate from coverage and layering — a cap and a
hijab both cover `hair`, and only the band tells them apart — and it never changes what a garment
covers, what it occludes, or how it layers.

- **Defaults come from the headwear subtype** (`ClothingSubtype.hairOcclusion`):

  | Band      | Headwear types                                            |
  | --------- | --------------------------------------------------------- |
  | `none`    | headband · hairpin · ribbon · tiara · crown · veil · visor |
  | `partial` | hat · cap · beanie · hood · bandana · helmet              |
  | `full`    | headscarf · hijab · turban · wimple · snood · swim cap    |

- **An item overrides its default** through the optional `ItemDefinition.hairOcclusion` — a
  headscarf worn with the fringe out is `partial`, a fully enclosing helmet is `full`.
  `hairOcclusionForItem(subtypeId, override)` (`subtypes/index.ts`) is the one per-item rule: a
  valid override wins, else the subtype default, else `none`; a value that is not a band is
  ignored rather than trusted. The item editor authors it for headwear only — a **Hair occlusion**
  select whose "Use type default" choice names the resolved band and clears the override
  (`hairOcclusion: null`), while ✦ Draft from description proposes one only when the description
  clearly departs from the type default and never when it equals it (`groundItemDraft`). The
  override is stale on any other category: the item create and patch routes drop it at the trust
  boundary (`withoutStaleHairOcclusion`, `server/api/schemas.ts`) instead of storing a value no
  loader reads, and a category change in the editor clears it with the subtype.
- **The subject's band is resolved once over their worn rows** (`resolveHairOcclusion`): only
  worn pieces count — held, stored and scene-placed items hide nothing — the strongest band wins
  (`full` over `partial` over `none`), and a missing or unknown value is `none`. Bad data resolves
  toward showing hair, never toward erasing it.
- **Carried, never re-derived.** The wardrobe loader resolves each item's band onto the loaded row
  (`AvatarWardrobeItem.hairOcclusion`, sparse at `none`) and onto every worn row it expands to
  (`WornItemInput.hairOcclusion`). The chat resolve seam
  ([../../character-chat/wardrobe.md](../../character-chat/wardrobe.md)) resolves the subject's
  band beside its exposure (`ResolvedChatWardrobe.hairOcclusion`, `none` on the free-text path),
  and the image subject cut (`CharacterPromptSubjectCut.hairOcclusion`), the narrator prompt state
  (`state.hairOcclusion`) and the hair-affordance wardrobe input
  (`ChatAffordanceWardrobe.hairOcclusion`) each carry that one value. No consumer reads item rows
  or infers the band from a garment's name.
- **The narrator withholds fully covered hair.** At `full` the chat prompt drops every
  `hair`-anchored attribute before its blocks are built and states a binding covered-hair line
  instead, and the hair affordance read is `hidden`
  ([../../character-chat/prompts.md](../../character-chat/prompts.md) §Character-chat state as a
  narration system, [../../character-chat/affordance-cues.md](../../character-chat/affordance-cues.md)).
- `partial` and `none` are distinct values even where a consumer treats them alike.
- **Image prompts:** at `full` the character projection withholds every authored hair fact and
  states one required fact that the hair is fully covered and none is visible; `partial` and
  `none` leave the hair as selected ([../../images/character-prompts.md](../../images/character-prompts.md)
  §Hair the headwear conceals).
- **Reference-anchored renders:** at `full` the identity lock and the turned-away adaptation
  preserve the face, skin tone, build and apparent age from the reference but never its hair;
  the no-rotation instruction is unchanged
  ([../../images/character-prompts.md](../../images/character-prompts.md) §Identity on a
  reference-anchored render).

## Object subtypes

`items/object-subtypes.ts` is the vocabulary for `kind: "object"` items, stored as an optional
`ItemDefinition.subtype`:

> furniture · vehicle · weapon · tool · device · book · food · beverage · decoration · instrument

The only capability a subtype carries is **`holdable`** — the item *can* be carried in a hand.
Holdable is a capability, never a slot binding: where a holdable item sits (a hand, a container, a
location) is runtime state, so holdables stay container-storable by construction.

No subtype carries behavior beyond that: a vehicle does not move characters and a weapon does not
fight. Adding subtype behavior means a design decision per behavior before any engine code.

## Wearer

`items/wearer.ts` is the vocabulary behind clothing's optional `wearer` field — who a garment is
cut for:

> feminine (Women's) · masculine (Men's) · unisex (Unisex)

Filter semantics live with the registry so every surface agrees (`wearerMatchesFilter`): **absent
= unspecified, treated as unisex** — a garment with no `wearer` matches every wearer filter, and
`unisex` is additive (the "Women's" filter shows feminine + unisex + unspecified), never a third
silo. That is what makes the facet work for gender-neutral characters out of the box. Extensible
the usual way — add a row, for example a per-species fit — never a migration.

## Color

`items/colors.ts` is the color-family vocabulary behind an item's optional `color`
(`{ family, shade?, accent? }`). `family` and `accent` are family ids; `shade` is free text
("aqua", "olive") kept for display and image prompts:

> black · white · grey · cream · brown · red · orange · yellow · green · blue · purple · pink · gold · silver · multicolor

Families drive filtering, sorting, and swatch chips in the library UI (`colorFamilySortIndex` sets
the sort order — neutrals first, then the hue wheel, metallics and multicolor last). Each family's
`swatch` hex is **UI-only**: it never enters gameplay or image prompts, which read name,
description and shade. Any item kind may carry a color — a red car sorts too — and clothing is the
primary surface.

## Coverage editing

Coverage editing (`items/coverage.ts`) uses a **select-all cascade**:

- Checking a location covers it **plus all its descendants**.
- Unchecking a descendant carves it out.

Edited sets are stored **exploded** (every covered id explicit) so carve-outs keep their siblings —
`registry.expand` is per-id, so exploded and minimal sets evaluate identically. Carving out a child
also drops its ancestors' own ids, since otherwise an ancestor would re-imply the child.

Carve-out precision is bounded by tree granularity: add child locations when a region needs finer
holes. A ski mask is "head minus eyes"; "face minus eyes" needs face sub-parts to keep any face
coverage at all. Footwear works the same way — `feet` splits into `toes` · `top of foot` · `sole` ·
`heel`, so a peep-toe shoe is "feet minus toes" and a strapped sandal is "feet minus toes and top
of foot", keeping sole and heel; a bare `feet` shoe still covers all four via expand.
