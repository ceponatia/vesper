[← Contracts index](README.md)

# Items and wardrobe

Items cover clothing, objects, and containers. An `ItemDefinition` is the reusable template; placed copies (worn, held, on the floor, in a box) are *instances*.

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
  sensory?: { appearance?: string; scent?: string; tactile?: string };
  attentionHint?: "absorbing" | "faces_away" | "outward";
  fields?: Record<string, unknown>;            // kind-specific extras
  tags: string[];
};
```

| Field | Meaning |
| --- | --- |
| `kind` | `clothing`, `object`, or `container`. Embedded in item rows / instance snapshots, not self-identified. |
| `name` / `description` | Display text. |
| `coverage` | Body-location ids the garment covers (clothing only). |
| `category` | Clothing only: the coverage-template id this item started from. **Editor display only** — never serialized into gameplay prompts (see [Clothing categories](#clothing-categories)). |
| `subtype` | Objects: the object-subtype id (see [Object subtypes](#object-subtypes)). Clothing: the accessory-type id for subtyped categories (see [Clothing subtypes](#clothing-subtypes)) — **prompt-bearing**, unlike `category`. |
| `wearer` | Clothing only: wearer-target id — `feminine`/`masculine`/`unisex` (see [Wearer](#wearer)). Absent = unspecified, matched as unisex. |
| `color` | Primary color: `family`/`accent` are color-family ids, `shade` is free text (see [Color](#color)). Any kind may carry one; clothing is the primary surface. |
| `layer` | `0` underwear → `3` outerwear. |
| `opacity` | `opaque` or `sheer`. |
| `sensory` | Optional `appearance` / `scent` / `tactile` notes. |
| `attentionHint` | `absorbing` / `faces_away` / `outward` — a perception hint for `deriveAttention` (see [perception.md](perception.md)). |
| `fields` | Kind-specific extras (capacity, wearable container, …). |
| `tags` | Free-form labels. |

## Visibility

An instance's placement is **exactly one of**: worn by a participant · held by a participant · in a location · in a container instance.

The **visibility rule** (which replaces the old occlusion stack depths) is per body location:

| State | When |
| --- | --- |
| visible | The highest-layer item covering that location. |
| hidden | Any item beneath a covering one. |
| hinted | A hidden item where *everything* above it is sheer. |

Implemented once in `items/visibility.ts`, and used by prompts, the simulant grounding, and the UI.

## Clothing categories

`items/clothing-categories.ts` holds authoring-time **coverage templates**:

> top · outerwear · dress · pants · shorts · skirt · bra · underwear · socks · footwear · gloves · headwear · eyewear · jewelry

Picking one pre-fills coverage + layer in the item editor, and the forges may emit one per garment to anchor coverage; everything stays editable afterward. The chosen id is stored as `ItemDefinition.category` for **editor display only** — **category names never enter gameplay prompts** (`docs/prompts.md`). The engine reads the resolved coverage set, so a "top" with arm coverage removed simply plays as a tank top.

Templates deliberately avoid parent ids that over-imply:

| Template | Uses | Avoids (and why) |
| --- | --- | --- |
| top | torso-parts + `upper_arms` | `arms` — would cover hands |
| pants | `pelvis` + leg parts | `legs` — would cover feet |
| headwear | `hair` | `head` |

Expanding the set is a one-file data edit.

## Clothing subtypes

`items/subtypes/` holds per-category **accessory vocabularies** — one data file per category (`jewelry.ts`, `headwear.ts`, `eyewear.ts`), aggregated by `subtypes/index.ts` (`clothingSubtypesForCategory`, `clothingSubtypeById`, `clothingSubtypeLabel`). They reuse the `ItemDefinition.subtype` field objects already carry; the item editor shows a **Type** select whenever the picked category has a vocabulary, and the classify backfill fills absent ones.

> jewelry: earring · nose ring · nose stud · septum ring · lip ring · lip stud · eyebrow ring · necklace · choker · bracelet · ring · anklet · belly ring · brooch
> headwear: hat · cap · beanie · hood · headband · hairpin · ribbon · tiara · crown · veil · headscarf · helmet
> eyewear: glasses · sunglasses · monocle · goggles · eyepatch · blindfold · masquerade mask

Two deliberate differences from categories:

- **Subtype labels ARE prompt-bearing.** Image prompts and the narrator's Visible-wardrobe block lead the garment phrase with the label ("nose ring: thin gold hoop") — a bare jewelry name gave the image model too little to place the piece (face-jewelry plan). The category HARD RULE (names never in prompts) is unchanged.
- **Subtypes may carry a coverage template** (a lip ring → `["lips"]`, a choker → `["neck"]`; a brooch has none — it pins to clothing). Picking one pre-fills coverage like a category template; the `lips`/`nose` body locations under `face` exist for exactly these anchors.

Extending a vocabulary is a one-line edit in that category's file; adding a vocabulary to another category is a new file + one map entry in `subtypes/index.ts`.

## Object subtypes

`items/object-subtypes.ts` is the vocabulary for `kind: "object"` items, stored as an optional `ItemDefinition.subtype`:

> furniture · vehicle · weapon · tool · device · book · food · beverage · decoration · instrument

The only capability so far is **`holdable`** — the item *can* be carried in a hand. Holdable is a capability, never a slot binding: where a holdable item currently sits (a hand, a container, a location) is session state, so holdables stay container-storable by construction.

Subtype *behavior* (vehicles moving characters, weapons in combat) is future work — each behavior gets its own design doc before any engine code, and the planned first is hand-equippable items.

## Wearer

`items/wearer.ts` is the vocabulary behind clothing's optional `wearer` field — who a garment is cut for:

> feminine (Women's) · masculine (Men's) · unisex (Unisex)

Filter semantics live with the registry so every surface agrees (`wearerMatchesFilter`): **absent = unspecified, treated as unisex** — a garment with no `wearer` matches every wearer filter, and `unisex` is additive (the "Women's" filter shows feminine + unisex + unspecified), never a third silo. This is what makes the facet work for gender-neutral characters out of the box. Extensible the usual way (add a row, e.g. a future per-species fit), never a migration.

## Color

`items/colors.ts` is the color-family vocabulary behind an item's optional `color` (`{ family, shade?, accent? }`). `family`/`accent` are family ids; `shade` is free text ("aqua", "olive") kept for display and image prompts:

> black · white · grey · cream · brown · red · orange · yellow · green · blue · purple · pink · gold · silver · multicolor

Families drive filtering, sorting, and swatch chips in the library UI (`colorFamilySortIndex` sets the sort order — neutrals first, then the hue wheel, metallics/multicolor last). Each family's `swatch` hex is **UI-only** — it never enters gameplay or image prompts (those read name/description/shade). Any item kind may carry a color (a red car sorts too); clothing is the primary surface.

## Coverage editing

Coverage editing (`items/coverage.ts`) uses a **select-all cascade**:

- Checking a location covers it **plus all its descendants**.
- Unchecking a descendant carves it out.

Edited sets are stored **exploded** (every covered id explicit) so carve-outs keep their siblings — `registry.expand` is per-id, so exploded and minimal sets evaluate identically. Carving out a child also drops its ancestors' own ids (otherwise an ancestor would re-imply the child).

Carve-out precision is bounded by tree granularity: add child locations when a region needs finer holes. A ski mask is "head minus eyes"; "face minus eyes" needs face sub-parts to keep any face coverage at all. Footwear works the same way — `feet` splits into `toes` · `top of foot` · `sole` · `heel`, so a peep-toe shoe is "feet minus toes" and a strapped sandal is "feet minus toes and top of foot" (keeping sole+heel); a bare `feet` shoe still covers all four via expand.
