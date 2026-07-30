# Garment archetypes and reusable components — technical specification

Status: draft companion to
[clothing-archetypes-components.plan.md](clothing-archetypes-components.plan.md).
Promote and re-audit before implementation.

Upstream/runtime owner:
[../clothing-state-graph.plan.md](../clothing-state-graph.plan.md).
Downstream affordance consumer:
[../body-attribute-affordances.spec.garment-interaction.md](../body-attribute-affordances.spec.garment-interaction.md).

## 1. Purpose

Define an authoring-time compiler that turns recognizable garment archetypes
and reusable component fragments into the normalized garment blueprint values
the shipped clothing system already snapshots, validates, hashes, instantiates,
mutates, and projects.

This specification owns:

- typed garment archetype definitions beneath the existing category registry;
- reusable component graph fragments and component variants;
- deterministic graph compilation and diagnostics;
- backward-compatible blueprint-v2 extensions;
- structural component capabilities consumed by wardrobe, coverage, interaction,
  and affordance code;
- localized decoration condition contracts.

It does not own:

- garment instance identity, locus, presentation, condition storage, retake, or
  replay;
- current pose, body contact, grasp, or insertion relations;
- current physical effects such as pocket sag or fabric tension;
- observer perception, cue ranking, narrator prose, or image realization.

## 2. Existing contracts that remain authoritative

The implementation on `main` already establishes these rulings:

1. `ItemDefinition.category` is the broad authoring/editor bucket. Category names
   carry no runtime mechanics and do not enter gameplay prompts.
2. `GarmentBlueprint` is a normalized value with sparse part nodes, typed edges,
   behavior bindings, and a content hash.
3. Chat garment instances point to content-hash-deduplicated blueprint snapshots.
   Library edits do not mutate established scenes.
4. The garment store owns instance locus, presentation, gradients, regional
   overrides, deposits, damage, captured effective coverage, and garment cue
   memory.
5. Existing category templates are the migration-safe fallback for definitions
   without richer construction metadata.
6. Coverage changes are behavior-specific and subtraction-only from a part's own
   baseline coverage.
7. The garment affordance domain consumes wardrobe structure and condition; it
   does not create a second garment or material catalog.
8. The current shared scene/body-relations owner is planned but not yet shipped.
   Pose-, grasp-, insertion-, wind-, and support-dependent garment phenomena must
   remain silent without it.

This specification extends those contracts; it does not replace them.

## 3. Model levels

Keep each level distinct:

| Level | Purpose | Runtime mutable? |
| --- | --- | --- |
| category | existing broad editor bucket and legacy default | no |
| archetype | recognizable construction grammar such as tee or pullover hoodie | no |
| component template | reusable graph fragment such as a hood, long sleeves, or kangaroo pocket | no |
| construction recipe | one item definition's archetype, component choices, materials, fit, and overrides | authoring only |
| compiled blueprint | normalized mechanical graph snapshotted by instances | no |
| garment instance | one copy with locus, presentation, and condition | yes |
| body-garment relation | current hand insertion, grasp, contact, or pose relation | yes, outside wardrobe |
| derived effect | current sag, tension, drape, motion, opacity, or visibility result | derived only |
| selected observation | perception-safe, ranked semantic cue | derived/captured by existing owners |

## 4. Core design rulings

### 4.1 Archetypes bind to existing categories

Every archetype declares exactly one existing `clothingCategories` id.

```ts
interface GarmentArchetypeDefinition {
  id: GarmentArchetypeId;
  version: number;
  categoryId: ClothingCategoryId;
  displayName: string;
  defaultComponents: readonly GarmentComponentUse[];
  optionalSlots: readonly GarmentComponentSlot[];
  constraints: readonly GarmentConstructionConstraint[];
  defaultMaterialAssignments: Readonly<
    Record<GarmentMaterialSlotId, GarmentMaterialProfileId>
  >;
  defaultFit: GarmentFitClass;
}
```

Do not add a parallel runtime `family` vocabulary. An optional UI-only family
label may group archetypes in the editor, but it cannot determine mechanics,
coverage, layering, or prompts.

### 4.2 Composition, not inheritance

Archetypes compose component fragments. Do not express relationships through
class inheritance or implicit parent archetypes.

```text
pullover_hoodie
  upper_body_base
  long_sleeve_pair
  ribbed_cuff_pair
  hood
  optional_drawstring_pair
  kangaroo_pocket
  no_front_closure
```

```text
zip_hoodie
  split_upper_body_base
  long_sleeve_pair
  ribbed_cuff_pair
  hood
  optional_drawstring_pair
  full_front_zipper
  left_front_pocket
  right_front_pocket
```

An archetype's defaults are authoring conveniences. The compiler emits explicit
parts and capabilities; runtime systems never infer them from `archetypeId`.

### 4.3 Existing blueprint hashing remains authoritative

Do not introduce a `sourceFingerprint` as a second runtime identity.

The construction recipe may carry archetype/component revision provenance for
editing and recompilation. The compiler output is normalized with the existing
blueprint normalizer and identified by the existing `garmentBlueprintHash`.

Two mechanically identical compiled graphs should deduplicate even when reached
through different authoring routes. Authoring provenance therefore remains
outside the hash-bearing mechanical blueprint unless a future ruling says it
changes runtime behavior.

### 4.4 Existing definitions remain legacy-compatible

A definition without a construction recipe continues through the shipped
category-template compiler.

A definition with a construction recipe compiles its blueprint from that recipe.
For construction-enabled definitions:

- the compiled blueprint is structural truth;
- any whole-definition coverage field retained for legacy consumers is a derived
  projection of compiled part coverage, not an independently editable truth;
- editing the category must not silently replace the selected archetype;
- editing construction creates a new blueprint value/hash for future instances;
  existing instances stay pinned to their snapshots.

## 5. Authoring contracts

### 5.1 Construction recipe

Add one typed optional clothing-only field to `ItemDefinition`; do not use the
untyped `fields` escape hatch.

```ts
interface GarmentConstructionRecipe {
  archetypeId: GarmentArchetypeId;
  archetypeVersion: number;
  componentSelections: readonly GarmentComponentSelection[];
  materialAssignments: Readonly<
    Record<GarmentMaterialSlotId, GarmentMaterialProfileId>
  >;
  fit: GarmentFitClass;
  overrides: readonly GarmentConstructionOverride[];
}
```

Recommended fit vocabulary:

```ts
type GarmentFitClass =
  | "unknown"
  | "loose"
  | "fitted"
  | "tight"
  | "structured";
```

`unknown` remains the degraded default and establishes no ordinary body contact.
The first release should use one garment-level fit value. Regional fit overrides
must wait for a demonstrated case that one band cannot represent.

### 5.2 Component uses and slots

```ts
interface GarmentComponentUse {
  instanceKey: string;
  componentTemplateId: GarmentComponentTemplateId;
  componentVersion: number;
  variantId?: GarmentComponentVariantId;
  materialAssignments?: Readonly<
    Record<GarmentMaterialSlotId, GarmentMaterialProfileId>
  >;
  parameters?: Readonly<Record<string, GarmentComponentParameterValue>>;
}

interface GarmentComponentSlot {
  id: GarmentComponentSlotId;
  cardinality: "zero_or_one" | "exactly_one" | "zero_or_more";
  accepts: readonly GarmentComponentTemplateId[];
  defaultComponent?: GarmentComponentUse;
}

interface GarmentComponentSelection {
  slotId: GarmentComponentSlotId;
  components: readonly GarmentComponentUse[];
}
```

Parameters are closed and schema-owned per component template. They are not an
arbitrary JSON rules language.

Examples of bounded parameters:

- fastener count for a placket;
- sleeve length variant;
- hood position support;
- pocket capacity band;
- whether a zipper is full, half, or quarter length.

### 5.3 Overrides

Overrides exist for rare authored variations without raw graph editing.

```ts
type GarmentConstructionOverride =
  | { kind: "remove_component"; instanceKey: string }
  | { kind: "replace_component"; instanceKey: string; replacement: GarmentComponentUse }
  | { kind: "set_component_parameter"; instanceKey: string; key: string; value: GarmentComponentParameterValue }
  | { kind: "set_material"; slotId: GarmentMaterialSlotId; materialProfileId: GarmentMaterialProfileId }
  | { kind: "set_fit"; fit: GarmentFitClass };
```

Do not support arbitrary node/edge patches from an LLM. A recurring override
shape should graduate into a reusable component variant.

## 6. Component templates

A component template is a namespaced blueprint fragment plus compilation
constraints. It cannot contain mutable runtime state.

```ts
interface GarmentComponentTemplate {
  id: GarmentComponentTemplateId;
  version: number;
  nodes: readonly GarmentPartNodeTemplate[];
  edges: readonly GarmentEdgeTemplate[];
  behaviors: readonly GarmentBehaviorBindingTemplate[];
  materialSlots: readonly GarmentMaterialSlot[];
  capabilities: readonly GarmentCapabilityTemplate[];
  parameters: readonly GarmentComponentParameterDefinition[];
  constraints: readonly GarmentConstructionConstraint[];
}
```

Component-local ids are namespaced with `instanceKey` during compilation.

```text
long_sleeves.left_sleeve
long_sleeves.right_sleeve
long_sleeves.left_cuff
long_sleeves.right_cuff
```

The final ids must satisfy the existing opaque garment-part id rules and remain
stable for identical normalized construction input.

## 7. Blueprint-v2 extension

### 7.1 Compatibility rule

Blueprint-v2 retains every blueprint-v1 field and meaning. Readers must branch
on `version`; blueprint-v1 values upcast with absent roles/capabilities and
retain identical coverage and behavior.

Do not rewrite stored blueprint-v1 snapshots merely because v2 exists.

### 7.2 Part nodes

Retain all existing v1 kinds and add the smallest new topology required:

```ts
type GarmentPartKindV2 =
  | GarmentPartKindV1
  | "opening"
  | "container"
  | "decoration"
  | "cord";
```

Add optional semantic role and closed capabilities:

```ts
interface GarmentPartNodeV2 extends GarmentPartNodeV1 {
  role?: GarmentPartRoleId;
  capabilities?: readonly GarmentPartCapability[];
}
```

Example roles:

```text
front_panel
back_panel
sleeve
cuff
collar
neck_opening
hood
hood_opening
pocket_opening
pocket_compartment
button_placket
front_zipper
drawstring
screen_print
embroidery
patch
applique
```

`kind` describes broad topology. `role` says what the part means. Runtime code
may branch on typed roles/capabilities where required, never on aliases or item
names.

### 7.3 New relationships

Extend the edge union additively:

```ts
type GarmentEdgeV2 =
  | GarmentEdgeV1
  | { kind: "opens_into"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "adjusts"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "applied_to"; from: GarmentPartId; to: GarmentPartId };
```

Semantics:

- `opens_into`: an opening accesses a container;
- `adjusts`: a cord, strap, or adjuster changes another part's presentation;
- `applied_to`: a decoration is attached to a structural region.

These edges never change `part_of` ownership.

### 7.4 Presentation extensions

Add presentation only when a compiled behavior supports it.

Recommended first new channel:

```ts
interface GarmentPresentationStateV2 extends GarmentPresentationStateV1 {
  position: Readonly<Record<GarmentPartId, GarmentPartPositionState>>;
}

type GarmentPartPositionState =
  | { kind: "hood"; state: "down" | "raised" }
  | { kind: "adjustment"; degree: FixedUnit };
```

Recommended behavior additions:

```text
positionable_hood
adjustable_drawstring
```

A raised hood changes current coverage/occlusion through a narrow
behavior-specific function. It does not directly mutate hair state.

## 8. Component capabilities

Capabilities are compiled structural facts. They do not prove a current
relation.

### 8.1 Container capability

```ts
interface GarmentContainerCapability {
  kind: "container";
  compartmentPartId: GarmentPartId;
  openingPartIds: readonly GarmentPartId[];
  accepts: readonly ("hand" | "small_item")[];
  capacityBand: "small" | "medium" | "large";
  openingAccess: "restricted" | "ordinary" | "wide";
  stretchResponse: FixedUnit;
}
```

A pullover hoodie usually compiles one compartment with two openings. A zip
hoodie usually compiles two compartments with one opening each.

The capability means insertion is mechanically possible. It never means a hand
or item is currently inside.

### 8.2 Graspable capability

```ts
interface GarmentGraspableCapability {
  kind: "graspable";
  partId: GarmentPartId;
  gripClasses: readonly ("pinch" | "hold" | "pull")[];
}
```

Typical parts include cuffs, hems, drawstrings, lapels, and pocket edges.

### 8.3 Coverage-affecting capability

Coverage remains behavior-owned. A capability may identify a hood or closure as
coverage-relevant, but only the existing behavior-specific coverage resolver may
subtract or restore body locations.

## 9. Initial archetype grammar

Start with a deliberately narrow upper-body proof:

| Archetype | Existing category | Default sleeves | Neck/collar | Closure | Pocket | Common options |
| --- | --- | --- | --- | --- | --- | --- |
| `tee` | `top` | short | neck opening; no collar | none | none | graphic, chest pocket, long sleeves |
| `polo` | `top` | short | collar | short button placket | optional chest pocket | embroidery, long sleeves |
| `pullover_sweater` | `top` | long | neck opening | none | none | ribbed cuffs/hem, graphic, quarter zip |
| `cardigan` | `top` or ruled `outerwear` mapping | long | optional collar | full buttons or zipper | optional front pockets | belt, embroidery |
| `pullover_hoodie` | `top` or ruled `outerwear` mapping | long | hood + hood opening | none | one kangaroo compartment | drawstrings, graphic, no pocket |
| `zip_hoodie` | `outerwear` | long | hood + hood opening | full front zipper | two front compartments | drawstrings, graphic, no pockets |

The `cardigan` and `pullover_hoodie` category mapping must be resolved during
promotion against actual editor layering expectations. Do not add a new category
to avoid the ruling.

### 9.1 Example: standard tee

```text
upper_body_base
short_sleeve_pair
neck_opening
optional_surface_decoration
```

No collar, closure, or pocket capability exists unless explicitly selected.

### 9.2 Example: polo

```text
upper_body_base
short_sleeve_pair
collar
short_button_placket(count)
optional_chest_pocket
optional_embroidery
```

### 9.3 Example: pullover hoodie

```text
upper_body_base
long_sleeve_pair
ribbed_cuff_pair
hood(positionable)
optional_drawstring_pair
kangaroo_pocket(one compartment, two openings)
optional_surface_decoration
```

### 9.4 Example: zip hoodie

```text
split_upper_body_base
long_sleeve_pair
ribbed_cuff_pair
hood(positionable)
optional_drawstring_pair
full_front_zipper
left_front_pocket
right_front_pocket
optional_surface_decoration
```

## 10. Compilation pipeline

```text
item construction recipe
        ↓ resolve exact archetype revision
archetype defaults
        ↓ apply component selections and variants
component graph fragments
        ↓ namespace local part ids
namespaced fragments
        ↓ apply validated overrides and materials
candidate blueprint-v2
        ↓ normalize and validate
compiled garment blueprint
        ↓ existing content hash
snapshot value used by future instances
```

The compiler must be pure and deterministic. It cannot depend on:

- wearer;
- current scene or story time;
- pose, contact, or body-garment relations;
- weather or current condition;
- narrator or image context;
- mutable library state beyond explicitly versioned registry inputs.

Identical normalized input must produce byte-equivalent normalized blueprints
and the same existing content hash.

## 11. Validation and diagnostics

Reject or diagnose:

- unknown category, archetype, component, variant, or material revisions;
- archetype category mismatches;
- missing required or duplicate single-cardinality slots;
- mutually exclusive component selections;
- unknown component parameters or invalid parameter values;
- duplicate namespaced part ids;
- missing/multiple roots or cyclic `part_of` ownership;
- edges whose endpoints do not exist;
- `opens_into` targeting a non-container role;
- an opening referenced by more than one compartment unless explicitly allowed;
- `adjusts` from a non-adjuster or to an unsupported target;
- `applied_to` from a non-decoration or to a non-structural part;
- behavior bindings illegal for a part kind/role;
- material slots left unresolved;
- coverage locations outside the body registry;
- a component removal that leaves dangling edges, capabilities, or behaviors;
- a runtime shortcut that infers component existence from `archetypeId`.

Diagnostics should be stable codes suitable for authoring UI and tests. Invalid
construction must not fail a chat turn: active instances use already-validated
snapshot values, and malformed stored definitions degrade through existing
`parseOr`/conservative fallback conventions.

## 12. Fit integration

Add garment fit as authored structural truth and expose it through the existing
wardrobe-to-affordance adapter.

Establishment law remains:

- `fitted` and `tight` worn regions may establish ordinary contact;
- `loose` requires pose, pressure, or another asserted relation;
- `structured` does not imply contour contact merely because it holds shape;
- `unknown` establishes no contact.

The archetype provides a default, the recipe may override it, and the compiled
structural read exposes it. The affordance domain must not infer fit from
material, name, category, or archetype.

## 13. Decoration structure and condition

### 13.1 Decoration profile

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

### 13.2 Persistent localized condition

Recommended narrow state:

```ts
interface GarmentSurfaceFeatureCondition {
  partId: GarmentPartId;
  fade: FixedUnit;
  cracking: FixedUnit;
  peeling: FixedUnit;
  integratedAt: StoryTimestamp;
}
```

This state belongs inside the existing garment instance condition owner and is
legal only for compatible decoration roles/processes.

Do not encode fade as:

- a global garment condition channel;
- an ordinary contaminant deposit;
- a generic tear/scuff damage mark;
- an affordance-owned memory;
- prose reconstructed from garment age.

Semantic operations should use bands/deltas rather than raw fixed-point writes.
Retakes restore decoration condition with the same garment store snapshot.

## 14. Body-garment interaction boundary

Current relations belong to the planned shared scene/body-relations owner.
They are neither blueprint state nor garment presentation.

Recommended narrowed read:

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
      gripClass: "pinch" | "hold" | "pull";
    };
```

The relation owner validates:

- the garment currently exists and is at a compatible locus;
- referenced parts exist in the instance's blueprint snapshot;
- the opening leads to the named compartment;
- the component accepts the body part/interaction class;
- current closure and presentation make the opening accessible;
- the body part is available and the pose/reach is plausible;
- no incompatible simultaneous relation already owns the body part.

Wardrobe and garment affordances consume accepted relations but never create or
persist them.

## 15. Affordance integration

Keep this chain explicit:

```text
pocket/opening capability               compiled garment structure
hand inserted through opening           scene/body relation
pocket sag/tension                       garment affordance
hand visibility/manipulation limits      pose/contact read
selected semantic observation            perception + cue ranker
prose                                    narrator
```

A future `garment.occupied_component_deformation` phenomenon may consume:

- narrowed container/graspable capability;
- accepted interaction relation;
- current garment presentation and accessibility;
- material stiffness/stretch and garment fit;
- relevant pose, contact, and motion.

It may derive:

- kangaroo-pocket sag around one or both hands;
- tension near pocket openings;
- localized bulge from an authoritative occupant;
- a grasped cuff, hem, or drawstring moving with the hand.

It must not infer occupancy from:

- garment/archetype name;
- pocket capability alone;
- prior prose;
- hands being hidden for another reason;
- a generic pose label without a relation.

A faded graphic usually goes directly from persistent condition through
visibility/perception and cue ranking. It is not an affordance unless current
force produces a new physical effect, such as visible cracking under stretch.

## 16. Coverage and occlusion

Blueprint compilation establishes baseline part coverage. Current presentation
continues to use narrow behavior-specific, subtraction-only coverage functions.

New examples:

- `positionable_hood: raised` may add current hood occlusion only through an
  explicitly ruled hood behavior; it does not alter the blueprint baseline or
  hair state;
- opening a zip hoodie affects the two front panels according to existing
  closure thresholds and leaves back-panel coverage intact;
- pocket occupancy does not change body exposure;
- a decoration contributes no body coverage merely because it is applied to a
  coverage-bearing panel.

The final `EffectiveCoverageRead` remains the one shared answer for narration,
body affordances, retakes, and images.

## 17. Authoring experience

Ordinary authoring should present recognizable decisions:

```text
Category: Top
Archetype: Pullover hoodie
Fit: Oversized / loose
Body material: Gray cotton fleece
Sleeves: Long, ribbed cuffs
Hood: Standard, positionable
Drawstrings: Black round cords
Pocket: Kangaroo pocket
Decoration: Screen-printed chest graphic
Initial condition: Graphic moderately faded; left cuff lightly frayed
```

The editor renders a generated summary:

```text
Pullover hoodie · long sleeves · hood · two drawstrings ·
one kangaroo compartment with two openings · chest screen print
```

An advanced inspector may show normalized nodes, edges, behaviors, capabilities,
validation, and the resulting blueprint hash. It must not be required for normal
items.

“Draft from description” may propose category, archetype, components, materials,
fit, and initial decoration condition. Proposals remain fill-empty-only,
human-reviewed, and compiled through the same validators. The model never emits
raw graph patches.

## 18. Migration and rollout

1. Introduce blueprint-v2 readers and validators while continuing to write v1.
2. Add v1→v2 upcast defaults in pure contract code and prove behavioral parity.
3. Add construction recipe contracts and compiler behind authoring-only use.
4. Keep legacy definitions on the category-template path.
5. Compile new/edited opted-in definitions to v2 snapshots.
6. Do not rewrite active instance snapshots or silently opt existing definitions
   into an archetype.
7. Add authoring UI and “Draft from description” only after compiler fixtures are
   stable.
8. Add body-garment relations and occupied-component affordances only after the
   shared relation owner ships.

A rollback consists of stopping new recipe writes. Existing compiled snapshots
remain valid values and do not depend on live archetype registries at runtime.

## 19. Test corpus

### Compiler and compatibility

- same normalized recipe → byte-equivalent blueprint and same existing hash;
- blueprint-v1 upcast preserves every node, edge, behavior, material, and
  coverage result;
- existing definition without recipe compiles through the current category
  template unchanged;
- active instance remains pinned after archetype/component registry edits;
- unknown revisions fail authoring validation with stable diagnostics.

### Archetype grammar

- tee has no collar, closure, or pocket by default;
- polo has collar and short placket;
- pullover sweater has long sleeves and no front closure;
- pullover hoodie has one compartment with two openings;
- zip hoodie has split front panels, full zipper, and two compartments;
- no-pocket hoodie exposes no container capability;
- long-sleeve tee is a component substitution, not a bespoke runtime branch;
- quarter-zip sweater changes only the selected component structure.

### Coverage and presentation

- tee and sweater sleeve coverage differs according to compiled parts;
- raised hood changes current hair/head occlusion through the hood behavior;
- lowering the hood restores the previous coverage read;
- opening a zip hoodie never drops back-panel coverage;
- pocket occupancy never changes intimate exposure;
- decoration nodes contribute no independent body coverage.

### Decoration condition

- graphic fade/crack/peel is keyed to the decoration part;
- washing/cleaning rules do not repair cracking unless explicitly ruled;
- hidden graphic emits no visual cue but retains condition;
- retake restores decoration condition and mention history exactly;
- ordinary garment wear does not automatically create a faded graphic.

### Interaction and affordance

- pocket capability alone emits no occupancy observation;
- accepted left-hand insertion changes hand visibility/availability through the
  relation owner;
- accepted two-hand insertion may derive one compatible sag/tension observation;
- invalid opening→compartment pair is rejected;
- closed/inaccessible opening rejects insertion;
- one body part cannot simultaneously satisfy incompatible interaction owners;
- pullover and zip hoodie topology produces different compartment reads;
- absent relation owner keeps occupied-component phenomena silent.

### Resilience

- malformed recipe degrades at authoring/read boundaries without failing a turn;
- malformed blueprint snapshot follows existing conservative parse/default rules;
- dangling component edge or behavior never reaches an active instance;
- registry changes cannot make a stored instance hash unresolvable;
- raw graph/capability values never enter narrator or image prompts.

## 20. Acceptance criteria

- One existing category vocabulary remains authoritative for broad authoring.
- Archetypes/components compile to the existing normalized/hashable blueprint
  substrate rather than creating a parallel garment runtime.
- Blueprint-v1 snapshots remain readable and behaviorally unchanged.
- Runtime mechanics inspect explicit parts, edges, behaviors, and capabilities;
  no mechanics branch on archetype names.
- Fit becomes conservative authored wardrobe truth and lights up existing
  contact-gated affordances only where justified.
- Pockets, hoods, drawstrings, and decorations are structurally addressable.
- Capability never masquerades as current occupancy, grasp, pose, or contact.
- Decoration condition is localized, persistent, rollback-safe, and
  perception-gated.
- The existing coverage read, cue ranker, narrator boundary, and image boundary
  remain the only downstream consumer paths.

## 21. Open decisions at promotion

- Exact typed field name and storage shape for `GarmentConstructionRecipe` on
  `ItemDefinition`.
- Whether `cardigan` and `pullover_hoodie` map to `top` or `outerwear` by default
  under the existing layer/editor behavior.
- Whether roles alone are sufficient for most new parts or whether all four new
  topology kinds are required.
- Whether decoration fade/crack/peel should be one narrow surface-feature state
  or an extension of existing damage contracts.
- Whether the first capability release includes small-item occupancy or hands
  only.
- Exact lifecycle/cut-capture contract supplied by the future shared
  scene/body-relations owner.
- Whether garment-level fit is enough permanently or merely the first release.