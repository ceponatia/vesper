[← Contracts index](index.md)

# Items and wardrobe

Items cover clothing, objects, and containers. An `ItemDefinition` is the reusable template; placed copies (worn, held, on the floor, in a box) are *instances*.

```ts
type ItemDefinition = {
  kind: "clothing" | "object" | "container";
  name: string; description: string;
  coverage?: BodyLocationId[];                 // clothing
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

## Object subtypes

`items/object-subtypes.ts` is the vocabulary for `kind: "object"` items, stored as an optional `ItemDefinition.subtype`:

> furniture · vehicle · weapon · tool · device · book · food · beverage · decoration · instrument

The only capability so far is **`holdable`** — the item *can* be carried in a hand. Holdable is a capability, never a slot binding: where a holdable item currently sits (a hand, a container, a location) is session state, so holdables stay container-storable by construction.

Subtype *behavior* (vehicles moving characters, weapons in combat) is future work — each behavior gets its own design doc before any engine code, and the planned first is hand-equippable items.

## Coverage editing

Coverage editing (`items/coverage.ts`) uses a **select-all cascade**:

- Checking a location covers it **plus all its descendants**.
- Unchecking a descendant carves it out.

Edited sets are stored **exploded** (every covered id explicit) so carve-outs keep their siblings — `registry.expand` is per-id, so exploded and minimal sets evaluate identically. Carving out a child also drops its ancestors' own ids (otherwise an ancestor would re-imply the child).

Carve-out precision is bounded by tree granularity: add child locations when a region needs finer holes. A ski mask is "head minus eyes"; "face minus eyes" needs face sub-parts to keep any face coverage at all.
