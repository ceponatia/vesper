# Items and wardrobe

```ts
type ItemDefinition = {
  kind: "clothing" | "object" | "container";   // embedded in item rows / instance snapshots, not self-identified
  name: string; description: string;
  coverage?: BodyLocationId[];      // clothing
  layer?: 0 | 1 | 2 | 3;            // 0 underwear … 3 outerwear
  opacity?: "opaque" | "sheer";
  sensory?: { appearance?: string; scent?: string; tactile?: string };
  attentionHint?: "absorbing" | "faces_away" | "outward";  // perception hint for deriveAttention (see Perception)
  fields?: Record<string, unknown>; // kind-specific extras (capacity, wearable container…)
  tags: string[];
};
```

Instance placement is exactly one of: worn by participant / held by participant / in location / in container instance. **Visibility rule** (replaces occlusion stack depths): per body location, the highest-layer covering item is *visible*; items beneath are *hidden*, or *hinted* when everything above them is sheer. Implemented once in `items/visibility.ts`, used by prompts, the simulant grounding, and the UI.

## Clothing categories

`items/clothing-categories.ts`: authoring-time coverage templates (`top`, `outerwear`, `dress`, `pants`, `shorts`, `skirt`, `bra`, `underwear`, `socks`, `footwear`, `gloves`, `headwear`, `eyewear`, `jewelry`). Picking one pre-fills coverage + layer in the item editor, and the forges may emit one per garment to anchor coverage; everything stays editable after. The chosen id is stored as `ItemDefinition.category` for editor display only — **category names never enter gameplay prompts** (docs/prompts.md): the engine reads the resolved coverage set, so a "top" with arm coverage removed plays as a tank top. Templates deliberately avoid parent ids that over-imply (`top` lists torso-parts + `upper_arms`, never `arms`, which would cover hands; `pants` is `pelvis` + leg parts, not `legs`, which would cover feet; `headwear` is `hair`, not `head`). Expanding the set is a one-file data edit.

## Object subtypes

`items/object-subtypes.ts`: vocabulary for `kind: "object"` items (furniture, vehicle, weapon, tool, device, book, food, beverage, decoration, instrument), stored as optional `ItemDefinition.subtype`. The only capability so far is `holdable` — the item *can* be carried in a hand. Holdable is a capability, never a slot binding: where a holdable item currently sits (a hand, a container, a location) is session state, so holdables stay container-storable by construction. Subtype *behavior* (vehicles moving characters, weapons in combat) is future work — each behavior gets its own design doc before engine code; the planned first is hand-equippable items.

## Coverage editing

Coverage editing (`items/coverage.ts`) uses a select-all cascade: checking a location covers it plus all descendants, unchecking a descendant carves it out. Edited sets are stored **exploded** (every covered id explicit) so carve-outs keep their siblings — `registry.expand` is per-id, so exploded and minimal sets evaluate identically. Carving out a child also drops its ancestors' own ids (an ancestor would re-imply the child); carve-out precision is bounded by tree granularity — add child locations when a region needs finer holes (a ski mask is "head minus eyes"; "face minus eyes" needs face sub-parts to keep any face coverage).
