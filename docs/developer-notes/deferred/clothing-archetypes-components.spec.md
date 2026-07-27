# Clothing archetypes and component graph compilation

Status: draft (companion to
[clothing-state-graph.plan.md](clothing-state-graph.plan.md); promote with the
plan)

## Purpose

Define the authoring-time layer that turns recognizable garment classes such as
tees, polos, sweaters, pullover hoodies, and zip hoodies into normalized sparse
`GarmentBlueprint` graphs.

This spec owns:

- garment families and archetypes;
- reusable component graph fragments;
- optional component slots and variant constraints;
- blueprint compilation, namespacing, validation, and snapshot inputs;
- the structural capabilities exposed to wardrobe, interaction, coverage, and
  affordance consumers.

It does **not** own live garment instances, presentation state, condition,
placement, body pose, contact, perception, cue ranking, or narration. Those
remain with the owners defined by
[clothing-state-graph.plan.md](clothing-state-graph.plan.md) and the
[garment-affordance companion](body-attribute-affordances.spec.garment-interaction.md).

## Model levels

Keep the following levels distinct:

| Level | Meaning | Mutable at runtime? |
| --- | --- | --- |
| garment family | broad authoring/UI group such as top, outerwear, bottom, footwear | no |
| garment archetype | recognizable construction grammar such as tee, polo, pullover hoodie | no |
| component template | reusable typed graph fragment such as long sleeves, hood, zipper, graphic | no |
| compiled blueprint | complete validated sparse graph for one garment definition/revision | no |
| garment instance | one persistent copy with locus, presentation, and condition | yes |
| body-garment interaction | current relation such as a hand inserted into a pocket | yes, outside this spec |
| derived observation | current readable effect such as a pocket pulling around both hands | derived only |

The archetype and component layers exist to make authoring ordinary garments
simple. Runtime mechanics consume the explicit compiled graph rather than
hard-coding assumptions from an archetype name.

## Design rulings

### Composition, not class inheritance

Use declarative templates and graph-fragment composition. Do not build an OOP
inheritance tree where `ZipHoodie extends Hoodie extends Sweater extends Top`.
Garments routinely combine or omit features in ways that make inheritance
fragile.

A pullover hoodie may compose:

```text
upper-body base
+ long sleeve pair
+ ribbed cuff pair
+ hood
+ optional drawstring pair
+ kangaroo pocket
+ no front closure
```

A zip hoodie may compose:

```text
split upper-body base
+ long sleeve pair
+ ribbed cuff pair
+ hood
+ optional drawstring pair
+ full front zipper
+ left pocket
+ right pocket
```

### Archetypes provide defaults, not hidden mechanics

An archetype supplies default components, allowed substitutions, constraints,
and authoring labels. It must not become a runtime shortcut.

Forbidden runtime reasoning:

```ts
if (garment.archetypeId === "hoodie") {
  assumePocketExists();
}
```

Required runtime reasoning:

```ts
const pockets = blueprint.nodes.filter(
  node => node.role === "pocket_compartment"
);
```

This permits valid variations without special cases:

- a hoodie without drawstrings;
- a hoodie without pockets;
- a long-sleeve tee;
- a sleeveless sweater;
- a quarter-zip sweater;
- a cropped hoodie;
- a zip hoodie with a back graphic.

### The compiled graph is structural truth

`archetypeId` remains useful for classification, authoring, search, and display.
The expanded blueprint graph is the mechanical source of truth for components,
coverage, openings, closures, containers, adjustment relationships, material
slots, and behavior bindings.

Compilation produces a normalized deterministic result that can be validated,
hashed, revisioned, and snapshotted by garment instances.

### Parts use broad topology plus semantic roles

Avoid an ever-growing node `kind` union that mixes topology with every garment
noun. Use a small structural kind plus an extensible registry role.

```ts
interface GarmentPartNode {
  id: GarmentPartId;
  kind:
    | "root"
    | "structural_region"
    | "opening"
    | "closure"
    | "container"
    | "trim"
    | "decoration"
    | "hardware";
  role: GarmentPartRoleId;
  side?: "left" | "right" | "center";
  aliases: readonly string[];
  materialProfileId?: GarmentMaterialProfileId;
  baselineCoverage: readonly BodyLocationId[];
  layerOffset?: number;
  capabilities: readonly GarmentCapabilityId[];
}
```

Example roles include:

- `front_panel`, `back_panel`, `sleeve`, `cuff`, `collar`, `hem`;
- `hood`, `hood_opening`, `neck_opening`, `pocket_opening`;
- `pocket_compartment`, `zipper`, `button_placket`, `drawstring`;
- `screen_print`, `embroidery`, `patch`, `applique`, `lining`.

### Components are graph fragments

A component template may contribute nodes, edges, behavior bindings, material
slots, and constraints. It cannot contribute mutable state.

```ts
interface GarmentComponentTemplate {
  id: GarmentComponentTemplateId;
  version: number;
  nodes: readonly GarmentPartNodeTemplate[];
  edges: readonly GarmentEdgeTemplate[];
  behaviors: readonly GarmentBehaviorBindingTemplate[];
  materialSlots: readonly GarmentMaterialSlot[];
  constraints: readonly GarmentTemplateConstraint[];
}
```

Component-local ids are namespaced during compilation. A `long_sleeve_pair`
fragment may define `left_sleeve`, `right_sleeve`, `left_cuff`, and
`right_cuff`; the compiler maps them to stable blueprint ids without requiring
an author to edit raw graph JSON.

### Relationships are explicit

The graph needs typed relationships beyond `part_of`:

```ts
type GarmentEdge =
  | { kind: "part_of"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "fastens"; from: GarmentPartId; targets: readonly GarmentPartId[] }
  | { kind: "opens_into"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "adjusts"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "applied_to"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "mirrors"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "constrains"; from: GarmentPartId; to: GarmentPartId };
```

Examples:

```text
left pocket opening  --opens_into--> kangaroo pocket
right pocket opening --opens_into--> kangaroo pocket

drawstring --adjusts--> hood opening

chest graphic --applied_to--> front panel

front zipper --fastens--> left front panel + right front panel
```

## Contracts

### Archetype template

```ts
interface GarmentArchetypeTemplate {
  id: GarmentArchetypeId;
  version: number;
  familyId: GarmentFamilyId;
  displayName: string;
  defaultComponents: readonly GarmentComponentUse[];
  optionalSlots: readonly GarmentComponentSlot[];
  constraints: readonly GarmentTemplateConstraint[];
  defaultMaterialAssignments: Readonly<
    Record<GarmentMaterialSlotId, GarmentMaterialProfileId>
  >;
}

interface GarmentComponentUse {
  instanceKey: string;
  componentTemplateId: GarmentComponentTemplateId;
  variantId?: GarmentComponentVariantId;
  materialAssignments?: Readonly<
    Record<GarmentMaterialSlotId, GarmentMaterialProfileId>
  >;
}

interface GarmentComponentSlot {
  id: GarmentComponentSlotId;
  cardinality: "zero_or_one" | "exactly_one" | "zero_or_more";
  accepts: readonly GarmentComponentTemplateId[];
  defaultComponent?: GarmentComponentUse;
}
```

A garment definition selects an archetype, component options, material
assignments, and narrow authored overrides:

```ts
interface GarmentDefinitionInput {
  archetypeId: GarmentArchetypeId;
  archetypeVersion: number;
  componentSelections: readonly GarmentComponentSelection[];
  materialAssignments: Readonly<
    Record<GarmentMaterialSlotId, GarmentMaterialProfileId>
  >;
  overrides: readonly GarmentBlueprintOverride[];
}
```

Overrides may configure, add, remove, or replace explicit components within
validated constraints. They are not arbitrary graph patches from an LLM.

### Blueprint result

```ts
interface GarmentBlueprint {
  version: number;
  archetypeRef: {
    id: GarmentArchetypeId;
    version: number;
  };
  rootNodeId: GarmentPartId;
  nodes: readonly GarmentPartNode[];
  edges: readonly GarmentEdge[];
  behaviors: readonly GarmentBehaviorBinding[];
  structuralProfile: GarmentStructuralProfileSeed;
  sourceFingerprint: string;
}
```

`sourceFingerprint` covers the archetype revision, component revisions,
selections, material assignments, and overrides. Identical input must compile
to an identical normalized graph and fingerprint.

## Initial archetype grammar

Start with a deliberately small registry that proves meaningful differences.

| Archetype | Default sleeve | Neck/collar | Closure | Pocket | Common optional components |
| --- | --- | --- | --- | --- | --- |
| tee | short | neck opening; no collar | none | none | graphic, chest pocket, long-sleeve substitution |
| polo | short | collar | short button placket | optional chest pocket | graphic/embroidery, long-sleeve substitution |
| pullover sweater | long | neck opening | none | none | ribbed cuffs/hem, graphic, quarter-zip substitution |
| cardigan | long | optional collar | button or zipper front | optional front pockets | belt, embroidery |
| pullover hoodie | long | hood + hood opening | none | kangaroo pocket by default | drawstrings, graphic, no-pocket variant |
| zip hoodie | long | hood + hood opening | full front zipper | two front pockets by default | drawstrings, graphic, no-pocket variant |

These are authoring defaults rather than universal definitions. The registry
should expand by demonstrated narrative or interaction value, not by attempting
to encode every fashion term up front.

## Pocket topology and interaction capability

A pocket is not a boolean. Model at least:

- one or more access openings;
- the compartment each opening enters;
- accepted interaction classes such as hand insertion or small-item storage;
- capacity and opening-access bands;
- attachment to a structural region;
- whether closure or obstruction can make it inaccessible.

A pullover hoodie normally has one kangaroo compartment with two openings. A
zip hoodie normally has two compartments because the zipper divides the front.
That difference affects occupancy, deformation, storage, and narration.

The compiled blueprint may expose a structural capability:

```ts
interface GarmentContainerCapability {
  compartmentPartId: GarmentPartId;
  openingPartIds: readonly GarmentPartId[];
  accepts: readonly ("hand" | "small_item")[];
  capacityBand: "small" | "medium" | "large";
  stretchResponse: FixedUnit;
}
```

The capability means a hand **can** be inserted. It does not mean a hand is
currently present.

## Body-garment interaction boundary

Current relations such as “her hands are in the hoodie pocket” belong to the
pose/contact/interaction owner, not to the immutable blueprint and not to free
text.

A normalized read may look like:

```ts
type BodyGarmentInteractionRead =
  | {
      kind: "body_part_inserted";
      actorId: ActorId;
      bodyPartId: BodyPartId;
      garmentId: GarmentInstanceId;
      openingPartId: GarmentPartId;
      compartmentPartId: GarmentPartId;
    }
  | {
      kind: "body_part_grasping";
      actorId: ActorId;
      bodyPartId: BodyPartId;
      garmentId: GarmentInstanceId;
      partId: GarmentPartId;
    };
```

The interaction owner validates the relation against:

- the authoritative garment locus;
- explicit blueprint capabilities and relationships;
- opening accessibility and current closure/presentation;
- current pose and body-part availability;
- incompatible simultaneous actions.

The wardrobe and affordance layers consume the accepted read but do not create
it.

## Decorations and persistent condition

Surface decoration is an addressable component rather than a string embedded
in a garment description.

```ts
interface GarmentDecorationProfile {
  partId: GarmentPartId;
  process: "screen_print" | "embroidery" | "patch" | "applique" | "unknown";
  baselineContrast: FixedUnit;
  fadeResistance: FixedUnit;
  crackResistance: FixedUnit;
  peelResistance: FixedUnit;
}
```

Mutable fade, cracking, peeling, staining, or abrasion remain garment-owned
condition keyed to the decoration part. They may be authored at instantiation
or changed by care, exposure, and wear events.

The chain for “the tee's graphic is faded” is:

```text
screen-print component exists                 blueprint structure
fade condition is moderate                    persistent garment condition
graphic is visible from this observation      coverage/perception
feature is relevant or newly salient           cue ranking
faded graphic is realized in prose             narrator
```

The affordance layer may derive physical consequences from current condition,
but it must not invent the fade state.

## Affordance integration

Keep capability, current relation, physical effect, and narration separate:

```text
STRUCTURE
The hoodie has a kangaroo pocket.

CURRENT RELATION
Both hands are inserted through its openings.

DERIVED EFFECT
The pouch sags and pulls around the wrists.

NARRATIVE OBSERVATION
She keeps both hands buried in the hoodie's front pocket.
```

The garment-affordance frame may consume narrowed structural capabilities,
current garment state, and asserted body-garment interactions to derive effects
such as:

- pocket sag, bulge, or tautness from occupancy;
- hood shape or opening tension from drawstring adjustment;
- fabric deformation around a grasped cuff or hem;
- motion suppression when a component is held;
- coverage/occlusion changes when a hood is raised.

The static fact “graphic is faded” generally enters perception directly from
condition. A new effect such as cracking spreading while fabric stretches may
be affordance-derived if the required mechanics and current force are present.

## Compilation pipeline

```text
garment definition input
        ↓ resolve exact archetype revision
archetype defaults + selected component variants
        ↓ apply validated authored overrides
namespaced component graph fragments
        ↓ merge and normalize
complete sparse blueprint graph
        ↓ validate relationships, behaviors, materials, and coverage
immutable revision/hash input
        ↓ instantiate
persistent garment instance
```

Compilation must be pure and deterministic. It must not depend on current
scene, wearer, pose, weather, condition, or narrator context.

### Validation

Reject or diagnose:

- unknown archetype/component/material revisions;
- duplicate namespaced part ids;
- missing or multiple roots;
- cyclic `part_of` ownership;
- edge endpoints that do not exist;
- `opens_into` targeting a non-container;
- closures without valid targets;
- behavior bindings on incompatible roles/capabilities;
- required archetype slots left empty;
- mutually exclusive components selected together;
- material assignments missing for required slots;
- coverage locations outside the body registry;
- overrides that remove a component still referenced by another component.

A degraded `unknown_top` archetype may exist for imported/legacy items, but it
must expose conservative coverage and no interaction capability that was not
explicitly established.

## Authoring experience

Ordinary item authoring should ask for recognizable choices, not raw graph
editing:

```text
Archetype: Pullover hoodie
Fit: Oversized
Body material: Gray cotton fleece
Hood: Standard
Drawstrings: Black round cords
Pocket: Kangaroo pocket
Decoration: Screen-printed chest graphic
Initial condition: Graphic moderately faded; left cuff lightly frayed
```

The UI then shows a generated component summary and validation warnings. An
advanced graph inspector may expose normalized nodes and edges for debugging or
rare custom garments.

“Draft from description” may propose an archetype, component choices, and
materials. It remains fill-empty-only and human-reviewed. It must not emit
unvalidated graph patches or silently infer exposure-sensitive components.

## Worked cases

### Hands in a pullover hoodie pocket

- the archetype compiles one kangaroo compartment and two openings;
- the interaction owner accepts left- and right-hand insertion relations;
- hand visibility and manipulation availability update from the pose/contact
  read;
- garment affordances may derive pouch sag or tension from occupancy, material,
  fit, and pose;
- the narrator receives one semantic observation rather than reconstructing the
  graph.

### Faded tee graphic

- the tee definition includes a `screen_print` decoration applied to the front
  panel;
- the garment instance owns moderate fade and light cracking on that part;
- coverage/perception decides whether the graphic is currently visible;
- cue ranking suppresses repetitive mentions;
- the narrator may realize “a faded graphic across her tee.”

### Hood raised over hair

- the blueprint contains hood and hood-opening components plus an adjustable or
  positionable behavior;
- wardrobe presentation owns hood-up/down state;
- coverage derives current head/hair occlusion;
- hair affordances consume the final coverage/contact read rather than assuming
  all hair remains visible;
- the narrator receives the resolved effect.

### Zip hoodie versus pullover hoodie

- a zip hoodie has two front panels, a full front closure, and normally two
  pocket compartments;
- a pullover hoodie has an uninterrupted front panel and normally one kangaroo
  compartment;
- opening the zipper can change torso coverage and pocket topology remains
  explicit;
- no runtime system branches on the English garment name.

## Acceptance tests

- compiling the same definition twice produces byte-equivalent normalized
  blueprints and the same fingerprint;
- a standard tee has no collar, closure, or pocket unless components explicitly
  add them;
- a polo has a collar and short placket by default;
- pullover and zip hoodies compile different front-panel, closure, and pocket
  topology;
- a no-pocket hoodie variant is valid and exposes no pocket interaction
  capability;
- a long-sleeve tee works through component substitution without a bespoke
  runtime code path;
- a graphic is independently addressable and can carry localized fade/cracking
  condition;
- a hand-in-pocket observation requires an authoritative interaction relation;
- a pocket capability alone never creates occupancy;
- runtime coverage, interaction, and affordance code inspects explicit graph
  structure rather than `archetypeId` assumptions;
- invalid component combinations fail with stable diagnostics;
- an active garment instance remains pinned to its blueprint snapshot/revision
  after archetype or component registries change.

## Not in scope

- cloth meshes, sewing patterns, manufacturing construction, or CAD topology;
- simulating every seam, stitch, button, or decorative thread;
- inheritance-based runtime garment classes;
- automatically treating fashion names as mechanically authoritative;
- persistent pose/contact state inside the wardrobe blueprint;
- narrator access to raw graphs, capacities, coefficients, or condition meters;
- a user-programmable graph or rules DSL.

## Open questions

- **OQ1 — registry breadth.** Which additional first-wave archetypes prove
  bottoms, dresses, outerwear, and footwear without creating a fashion ontology
  project?
- **OQ2 — override limits.** Which customizations are safe as normalized
  authoring overrides versus requiring a new reusable component template?
- **OQ3 — fit ownership.** Is fit one garment-level authored band with regional
  overrides, or exclusively part of the compiled structural profile?
- **OQ4 — interaction owner.** Which existing pose/contact contract should own
  accepted body-garment relations in chat and successor cuts?
- **OQ5 — container scope.** Does v1 support item storage in pockets, or only
  hand insertion and visual deformation?
- **OQ6 — decoration condition.** Generalize existing damage/deposit contracts
  for fade/crack/peel, or add one narrow decoration-condition behavior?
