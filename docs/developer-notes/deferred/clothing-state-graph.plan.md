# Clothing state graph and condition gradients

Status: draft (stub — parked 2026-07-27, owner request; promote per
[CLAUDE.md](CLAUDE.md) before building)

Authoring-time garment families, archetypes, reusable component fragments, and
blueprint compilation are specified separately in
[clothing-archetypes-components.spec.md](clothing-archetypes-components.spec.md).
This plan owns the compiled blueprint's persistent instances, live state,
coverage, and observation consumers.

## What

Turn clothing from a list of garment names into persistent, addressable visual
state:

```text
garment archetype + reusable components
        ↓ compile and validate
garment blueprint graph
        ↓ instantiate
garment instance + locus
        ↓ mutate by typed events
part presentation + material gradients + local marks
        ↓ derive
effective coverage, visibility, and garment observations
        ↓ rank
one or two grounded narrator/image cues
```

The motivating cases should become ordinary state transitions:

- the second and third buttons of a shirt are open;
- only the left sleeve is rolled;
- its collar is bent and one cuff is damp;
- the jacket is no longer worn and rests over the chair;
- rain darkens a cotton shirt while beading on a leather jacket;
- mud remains at the hem after the rest has dried;
- both hands occupy a pullover hoodie's one kangaroo pocket;
- a tee's screen-printed graphic remains visibly faded;
- raising a hood changes current hair/head coverage.

The narrator should not reconstruct these facts from prior prose. The wardrobe
owns them, retakes restore them, coverage reads honor them, and the narrator
receives compact semantic observations rather than a graph or raw percentages.

## Why it matters

Vesper already knows **which garments** are worn. It does not yet know enough
about **how each garment is currently arranged** or **what has happened to its
material**:

- character chat stores item-definition ids in `wornItemIds`; removing an item
  drops it from the worn list, so it cannot remain on a chair or in a hand;
- the continuity leg can add/remove whole garments, but cannot address a
  sleeve, strap, closure, collar, or hem;
- item definitions carry whole-garment coverage/layer/opacity, so a rolled
  sleeve or open placket cannot change the effective read;
- `itemInstanceStateSchema` has coarse condition/cleanliness/wetness fields but
  is not a live chat wardrobe substrate;
- the successor engine has real item identities/loci and fixed-point
  cleanliness/wear meters, but its chat surface renders only worn item names;
- the deferred
  [garment-affordance spec](body-attribute-affordances.spec.garment-interaction.md)
  expects wardrobe-owned material profiles and persistent wetness, dirt,
  damage, displacement, and fastened state that do not exist yet.

This plan is that missing upstream wardrobe/presentation owner. The affordance
layer may derive wet cling, opacity, drape, deformation, and motion from it; it
must not invent or persist garment state itself.

The separate
[archetype/component spec](clothing-archetypes-components.spec.md) supplies the
missing authoring grammar: a tee, polo, sweater, pullover hoodie, or zip hoodie
compiles reusable typed components into the normalized blueprint consumed here.
Runtime systems inspect the compiled graph; they never infer pockets, buttons,
sleeves, hoods, or other mechanics from an English category name.

## Design rulings for the draft

### Two graphs, not one universal property graph

1. A **garment blueprint graph** describes stable construction: meaningful
   parts, materials, coverage, closures, and typed relationships.
2. A **wardrobe scene graph** is derived for a committed cut: actor wears
   garment, part covers body location, outer part occludes inner part, garment
   rests on scene anchor, and so on.

Only authored/runtime facts are stored. Effective `covers`, `occludes`,
opacity, and perceptibility are recomputed so multiple stored truths cannot
drift.

### Archetypes compile components before instantiation

Garment families and archetypes are authoring aids, not runtime classes. An
archetype supplies default and optional reusable graph fragments; a pure
compiler expands them into the complete sparse blueprint graph.

For example, a pullover hoodie normally compiles a hood, long sleeves, cuffs,
and one kangaroo pocket with two openings. A zip hoodie normally compiles split
front panels, a full zipper, and two separate pockets. Valid variants may omit
or replace any optional component. Once compiled, downstream code must inspect
explicit nodes, edges, capabilities, and behavior bindings rather than branch
on `archetypeId`.

The compiler contract, component registry, hoodie/tee/polo examples, and
validation rules live in
[clothing-archetypes-components.spec.md](clothing-archetypes-components.spec.md).

### Model only parts that can change a read

This is semantic topology, not CAD or cloth simulation. A node earns its place
when it can be independently manipulated, conditioned, exposed/hidden, or used
to change coverage.

A shirt may have root, front/back panels, collar, two sleeves/cuffs, hem, and
one placket closure. It does not need every seam or ten button nodes. A closure
can model several fasteners with a count and open interval.

Archetype templates compose reusable components into the common sparse graph.
“Draft from description” may propose an archetype, component selections,
materials, and narrow refinements; ordinary authoring must not require graph
surgery. The compiled graph remains authoritative even when an unusual garment
departs from its archetype defaults.

### Definitions are not instances

Library items are blueprints. A conversation/world needs a stable garment
instance with its own locus and mutable state. Instantiation captures the
blueprint revision or normalized snapshot so a later library edit cannot
silently change an established scene.

Character chat proves this first with chat-scoped instances. The successor
adapter maps the same contracts onto `sim_items`, `sim_item_holdings`, and the
item-condition event lane.

### Combine gradients with sparse local facts

A boolean `dirty` is too crude, but seven whole-garment sliders are also too
crude. Use:

- material gradients for continuous, broadly meaningful state;
- regional overrides when one part differs from the garment baseline;
- localized deposits/marks when identity and location matter;
- typed presentation state for closures, rolls, tucks, displacement, and
  placement.

Mud, blood, and dust are contaminants, not permanent columns. A torn cuff is a
located damage mark, not merely `damage = 62`. “Freshness” is derived from
cleanliness, deposits/odor, and recent care. Warmth waits for an authoritative
thermal owner rather than masquerading as a visual gradient.

### Models propose semantic operations, never raw state

The continuity model may report “left sleeve rolled substantially” or “rain
soaked both shoulders.” It must not set `wetness: 73` or write graph patches.
A pure reducer validates exact garment/part handles and maps a small semantic
degree vocabulary to deterministic operations. Invalid or ambiguous proposals
are no-ops with diagnostics.

### Raw state never enters narrator prose

The narrator receives:

- a compact authoritative garment read so it cannot contradict placement or
  coverage;
- at most one or two perception-safe, ranked garment observations;
- a change/repeat key so steady state does not become a clothing recital.

The graph, coefficients, and percentages remain inspector/debug data.

## Sketch

### Compiled garment blueprint

The schema belongs under `src/contracts/items`, not in an untyped `fields`
convention. This is the normalized output of the archetype/component compiler,
not the ordinary authoring input:

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

type GarmentEdge =
  | { kind: "part_of"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "fastens"; from: GarmentPartId; targets: readonly GarmentPartId[] }
  | { kind: "opens_into"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "adjusts"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "applied_to"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "mirrors"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "constrains"; from: GarmentPartId; to: GarmentPartId };
```

The small structural `kind` vocabulary describes topology; extensible semantic
roles identify sleeves, cuffs, hoods, pocket openings/compartments, drawstrings,
zippers, graphics, embroidery, and similar useful parts.

Validation requires one root, known endpoints, acyclic `part_of` edges, unique
ids, and valid body/material/role registry ids. Relationship-specific
validation requires, for example, `opens_into` to target a container and
`applied_to` to target a structural region. Other typed edges may cross the tree
but cannot change ownership.

`GarmentBehaviorBinding` points nodes at narrow registry behaviors such as
`rollable_sleeve`, `linear_front_closure`, `positionable_hood`,
`adjustable_drawstring`, `accessible_container`, or `tuckable_hem`. Avoid an
arbitrary rules DSL in v1. Full compilation and authoring contracts live in the
[archetype/component spec](clothing-archetypes-components.spec.md).

### Material profiles

A registry-owned profile supplies mechanics used by multiple reads:

```ts
interface GarmentMaterialProfile {
  id: GarmentMaterialProfileId;
  absorbency: FixedUnit;
  dryingRate: FixedUnit;
  wrinkleAffinity: FixedUnit;
  stainRetention: FixedUnit;
  abrasionResistance: FixedUnit;
  baselineOpacity: FixedUnit;
  wetOpacityResponse: FixedUnit;
  drapeStiffness: FixedUnit;
  clingAffinity: FixedUnit;
  dryMass: FixedUnit;
  stretchElasticity: FixedUnit;
}
```

These are mechanics, not prompt adjectives. Narrator/image phrasing comes from
derived semantic bands. Start with a small materially distinct registry (for
example woven cotton/linen, knit, silk/satin, denim, wool, leather, synthetic
shell) and a conservative `unknown`.

### Garment instance and locus

```ts
interface GarmentInstanceState {
  id: GarmentInstanceId;
  blueprint: GarmentBlueprintSnapshot;
  locus: GarmentLocus;
  presentation: GarmentPresentationState;
  condition: GarmentConditionState;
  lastChange: GarmentChangeStamp;
}

type GarmentLocus =
  | { kind: "wardrobe"; ownerId: ActorId }
  | { kind: "worn"; actorId: ActorId }
  | { kind: "held"; actorId: ActorId }
  | { kind: "scene"; placeKey: string; anchor: string }
  | { kind: "gone"; basis: "lost" | "destroyed" | "discarded" };
```

The chat `scene` locus may use its existing scene-place key and a short grounded
anchor (“over the desk chair”). It is not a substitute for the future spatial
model. Successor worlds map to existing item loci; exact furniture placement
waits for that lane’s spatial item-position owner.

Presentation is sparse and typed:

```ts
interface GarmentPresentationState {
  closure: Readonly<Record<GarmentPartId, GarmentClosureState>>;
  roll: Readonly<Record<GarmentPartId, FixedUnit>>;
  tuck: Readonly<Record<GarmentPartId, "out" | "partial" | "in">>;
  position: Readonly<Record<GarmentPartId, GarmentPositionState>>;
  displacement: readonly GarmentDisplacement[];
}

type GarmentClosureState =
  | { kind: "continuous"; openness: FixedUnit }
  | { kind: "fastener_series"; openFastenerIndexes: readonly number[] };
```

Each channel is legal only when the node’s behavior binding supports it.
Storage uses fixed point; UI/model operations use semantic states. Continuous
closure and roll normalize in one direction: `0` means fully
fastened/unrolled and `1` fully open/rolled. A closure behavior may instead
declare a bounded fastener count/direction so individual buttons can change
without becoming full graph nodes. Position state covers authored component
behaviors such as a hood being `down`, `raised`, or `drawn_tight`; it does not
become a generic pose channel.

### Body-garment interaction read

A structural capability means an interaction is possible; it is not proof that
the interaction is currently occurring. A pocket may accept hands, but “both
hands are in the pocket” requires an authoritative pose/contact relation.

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

The pose/contact/interaction owner validates this read against the garment's
locus, explicit capabilities, opening accessibility, current presentation,
body-part availability, and incompatible actions. Wardrobe captures/consumes
the accepted relation for the cut but does not invent it. Affordances may then
derive effects such as pocket sag, tautness, or motion suppression.

### Condition vector, regional overrides, and marks

Recommended v1 channels:

| Channel | Direction | Dynamics | Why |
| --- | --- | --- | --- |
| `wetness` | dry → saturated | sources + analytical drying | visible; unlocks garment affordances |
| `cleanliness` | soiled → clean | wear/exposure/clean sources; zero at rest | aligns with existing item contracts |
| `crease_load` | smooth → deeply wrinkled | wear/pose/care; little automatic recovery | clothing-specific visual state |
| `wear` | pristine → worn out | discrete use/damage/care | aligns with successor item condition |

```ts
interface GarmentConditionState {
  base: GarmentConditionVector;
  regionOverrides: Readonly<
    Record<GarmentPartId, Partial<GarmentConditionVector>>
  >;
  deposits: readonly GarmentDeposit[];
  damageMarks: readonly GarmentDamageMark[];
  surfaceFeatures: readonly GarmentSurfaceFeatureCondition[];
  integratedAt: StoryTimestamp;
}
```

Deposits carry a registry kind (`mud`, `blood`, `dust`, `food`, `paint`,
`cosmetic`, `unknown`), part ids, intensity/extent bands, freshness, cause, and
time. Damage marks carry a kind (`tear`, `hole`, `fray`, `scuff`, `burn`,
`missing_fastener`), one part, severity/extent, and cause. Addressable
decoration parts may carry localized fade, cracking, peeling, or abrasion in
`surfaceFeatures`; this is persistent garment condition, not an affordance or
narrator invention.

The base gradient is a default, not an average that overwrites detail. A wet
hem override can coexist with a dry garment base. Whole-garment bands derive
from visible weighted regions.

Reuse the successor §25 fixed-point integration kernel rather than creating
floating-point turn math. Generalize its pure numerics if needed; do not make
chat depend on successor persistence contracts. There is no tick loop:

- wetness approaches dry unless a live wetting source applies;
- cleanliness and wear do not change because a prompt was built;
- crease load changes through wearing/pose/care events;
- operations integrate to event time, apply a clamped source, then persist;
- retakes restore pre-exchange state exactly.

Bands need hysteresis so a boundary value does not alternate between “damp”
and “wet.” Models and narrators see bands, never thresholds or fixed-point
values.

### Typed mutation surface

One operation contract serves character and player wardrobes:

```ts
type GarmentOperation =
  | { kind: "transfer"; garmentId: GarmentInstanceId; to: GarmentLocusInput }
  | { kind: "set_closure"; garmentId: GarmentInstanceId; partId: GarmentPartId; state: GarmentClosureInput }
  | { kind: "set_roll"; garmentId: GarmentInstanceId; partId: GarmentPartId; degree: DegreeBand }
  | { kind: "set_tuck"; garmentId: GarmentInstanceId; partId: GarmentPartId; state: TuckState }
  | { kind: "set_position"; garmentId: GarmentInstanceId; partId: GarmentPartId; state: GarmentPositionInput }
  | { kind: "restore_presentation"; garmentId: GarmentInstanceId; partIds: readonly GarmentPartId[] }
  | { kind: "apply_condition"; garmentId: GarmentInstanceId; partIds: readonly GarmentPartId[]; channel: GarmentConditionKey; change: DegreeDelta }
  | { kind: "deposit"; garmentId: GarmentInstanceId; partIds: readonly GarmentPartId[]; depositKind: GarmentDepositKind; degree: DegreeBand }
  | { kind: "clean"; garmentId: GarmentInstanceId; partIds: readonly GarmentPartId[]; target: CleanBand }
  | { kind: "damage"; garmentId: GarmentInstanceId; partId: GarmentPartId; damageKind: GarmentDamageKind; degree: DegreeBand }
  | { kind: "apply_surface_condition"; garmentId: GarmentInstanceId; partId: GarmentPartId; channel: GarmentSurfaceConditionKey; change: DegreeDelta }
  | { kind: "repair"; garmentId: GarmentInstanceId; markIds: readonly GarmentMarkId[] };
```

The continuity prompt enumerates only in-scope opaque garment and part handles.
The extractor returns those handles, not names to fuzzy-match. The existing
name matcher remains only a degraded legacy bridge.

Operations apply in fiction order. A transfer may remove coverage before a
part operation; an impossible later operation is dropped with a stable
diagnostic. Outfit preset changes compile to instance transfers, not a
free-text replacement.

Unowned garments (“a borrowed hoodie”) need one explicit degraded path: mint a
chat-scoped instance from a validated minimal category template, or retain
non-mechanical prose that cannot change exposure. Never let a free-text flag
decide intimate coverage.

### Derived wardrobe and observation read

At the committed cut:

1. load garment instances at authoritative loci;
2. integrate conditions to story time;
3. apply presentation behavior to per-part coverage;
4. derive cross-garment visibility/occlusion by body location and layer;
5. join accepted body-garment interaction reads for the cut;
6. build effective material/coverage reads;
7. let garment affordances derive current effects;
8. perception-gate and rank observations;
9. capture the selected read with the cut.

Example:

```ts
{
  id: "garment.sleeve_rolled",
  garmentId: "g_shirt",
  partId: "sleeve_left",
  visibility: "clear",
  intensityBand: "substantial",
  semanticTags: ["left_only", "forearm_exposed"],
  cause: { kind: "presentation_change", storyTime: 1840 },
  repeatKey: "g_shirt:sleeve_left:rolled:substantial",
}
```

Useful families are `closure_open`, `part_rolled`, `part_positioned`,
`part_displaced`, `surface_damp_or_wet`, `surface_feature_visible`,
`deposit_visible`, and `damage_visible`, plus relation-backed observations such
as `hands_in_pocket` and affordance-owned wet cling, occupied-component
deformation, effective opacity, pose drape, and motion.

Effective coverage is one shared read for narration, exposure gates, and
images. A rolled sleeve may expose a forearm; two open collar buttons do not
automatically imply bare torso. Narrow behavior-specific coverage functions
decide that.

### Narration and image policy

Separate **authority** from **attention**:

- the authoritative wardrobe digest is a terse state guard;
- selected cues are only changes, action-relevant details, or unusually
  salient effects;
- unchanged condition remains available for consistency but loses mention
  priority;
- hidden parts cannot produce visual cues;
- a repeat key includes garment, part, observation kind, and semantic band,
  reusing the existing surfaced-cue/captured-cut pattern.

Scene images may consume the same semantic read after narration is stable. A
visual fingerprint should invalidate a scene render when relevant, but minor
drying must not continuously remint `chat_look` identity anchors. Structural
outfit/placement and large presentation changes may refresh the look anchor;
transient condition belongs primarily in per-scene prompts.

## Ownership boundaries

| Owner | Owns | Does not own |
| --- | --- | --- |
| archetype/component registry | families, archetypes, reusable graph fragments, compilation | live instances or inferred runtime mechanics |
| item/wardrobe | compiled blueprint, instance, locus, presentation, gradients, deposits, damage, surface-feature condition | body pose/contact; cling/drape/deformation observations; attention |
| pose/contact interaction | accepted body-garment relations and body-part availability | garment construction or persistent condition |
| environment/events | rain, spills, contact, force, care/damage causes | graph patches |
| garment affordances | effective mechanics and actual current effects | persistent wardrobe or interaction state |
| coverage/perception | visibility and observer/channel gating | mutation |
| cue ranker | relevance, novelty, repetition budget | truth or condition |
| narrator/image | realization of selected semantic reads | new state |

This plan does not absorb the broader visual-attention or recognizable-feature
memory work. It supplies garment observations to those consumers.

## Slices

### Slice 0 — audit, corpus, and promotion rulings

- Re-verify chat wardrobe, item definition, successor item-condition, cut,
  image, and garment-affordance seams.
- Build fixtures for tees/polos/pullover and zip hoodies, asymmetric sleeves,
  closures, hood position, hand-in-pocket relations, faded graphics,
  removal-to-chair, cotton/leather rain, local mud, drying, washing, retake,
  hidden underlayers, and image agreement.
- Resolve the open questions before schema work.

### Slice 1 — blueprint/material contracts and authoring

- Implement the archetype/component compiler and initial registry from
  [clothing-archetypes-components.spec.md](clothing-archetypes-components.spec.md)
  under `src/contracts/items`.
- Add graph/material/role/capability registries, validators, and conservative
  degraded defaults.
- Extend classification/“Draft from description” to propose sparse nodes and
  materials, fill-empty-only and human-reviewed.
- Add an advanced graph inspector without making it mandatory.

### Slice 2 — chat-scoped instances and whole-garment loci

- Materialize definition-backed instances for character and player.
- Migrate preset/worn-list state without preserving a second wardrobe truth.
- Make don/doff/hold/scene placement rollback-safe.
- Decide and implement the guarded ad-hoc garment path.

### Slice 3 — presentation graph

- Add closure, roll, tuck, position, restore, and displacement operations.
- Derive per-part coverage and reuse the existing visibility resolver through
  a richer input shape.
- Add state-tool controls and graph/coverage diagnostics.

### Slice 4 — gradients and local marks

- Generalize/reuse the fixed-point item-condition kernel.
- Ship wetness and crease load plus bridges for cleanliness/wear.
- Add regional overrides, contaminants, damage marks, decoration/surface
  condition, hysteretic bands, and event-time integration.
- Prove wet cotton/leather diverge through material response.

### Slice 5 — grounded continuity extraction

- Replace whole-description mutation with one operation field shared by
  character/player scope.
- Enumerate exact handles; validate, clamp, and diagnose rejected operations.
- Capture operation traces in the admin inspector.

### Slice 6 — narrator, coverage, and image consumers

- Build the authoritative digest and bounded garment-cue block.
- Wire effective coverage into exposure and scene-image prompts.
- Apply repeat/change gating and compare against the garment-name baseline.
- Tune contradiction, repetition, concrete-detail, and extraction accuracy
  before enabling by default.

### Slice 7 — successor adapter

- Map blueprints/snapshots onto successor items and free-text worn slots onto
  validated garment-part/slot vocabulary.
- Extend `item-condition-v1` instead of creating a parallel store.
- Emit state changes through successor commands/events with fork/replay parity.
- Upgrade `readSimChatOutfit` from a name join to the shared digest.

### Slice 8 — affordance and visual-memory integration

- Feed wardrobe-owned structure/current state plus accepted body-garment
  interaction reads to garment affordances.
- Admit observations to shared visual attention/memory only after perception
  and cut capture.
- Evaluate scene-image reuse; do not build an image-only state model.

## Acceptance criteria

- Archetypes compose reusable component fragments into deterministic normalized
  blueprints; runtime systems inspect explicit graph structure rather than
  inferring components from `archetypeId`.
- A pullover hoodie may expose one kangaroo compartment with two openings while
  a zip hoodie exposes two separate pockets and a front closure.
- A valid no-pocket hoodie does not gain pocket capability from its name.
- Left/right parts can differ without duplicating the garment.
- Closing, rolling, cleaning, drying, damaging, and repairing are deterministic
  typed operations with stable rejection diagnostics.
- A doffed jacket remains located and stops contributing coverage.
- Coverage, narrator authority, and image exposure share one read.
- Cotton and leather respond differently to the same rain source.
- A muddy hem survives whole-garment drying and is removed by regional cleaning.
- A tee graphic can fade or crack independently of the surrounding panel.
- A hand-in-pocket observation requires an accepted body-garment interaction;
  pocket capability alone never creates occupancy.
- Raising a hood changes the shared coverage/visibility read for hair and head.
- Raw gradients and hidden/intimate details never bypass perception/focus gates.
- Unchanged clothing produces no fresh cue; a meaningful change may produce one.
- Retake/replay restores graph state, condition, selected read, and mention
  history identically.
- Active instances do not mutate when their library blueprints change.
- Malformed JSONB/LLM operations degrade through `parseOr`, a no-op/default, and
  a stable diagnostic without failing the turn.

## Not in scope

- cloth, fluid, collision, or thermal simulation;
- manually authoring every seam and button;
- an arbitrary property graph or user-programmable behavior DSL;
- a complete fashion ontology or inheritance hierarchy of garment classes;
- a new visual-attention system;
- manufacturing, sizing, tailoring, laundry economy, or item acquisition;
- precise furniture coordinates before the spatial owner exists;
- sending the graph or raw meter values to an LLM.

## Open questions

- **OQ1 — v1 registry breadth.** Start with the archetypes/components in the
  companion spec; confirm the smallest additional bottom, dress, outerwear, and
  footwear set plus the smallest useful material registry.
- **OQ2 — chat instance identity.** Snapshot the normalized blueprint or store
  definition id + immutable revision/hash? How are duplicate copies authored?
- **OQ3 — ad-hoc garments.** May continuity mint a category-grounded chat
  instance, or must unowned garments remain non-mechanical until adopted?
- **OQ4 — scene placement lifetime.** On a scene move, does a left garment stay,
  follow by default, or require explicit continuity resolution?
- **OQ5 — first channel set.** Recommended: wetness + crease load first while
  preserving cleanliness/wear compatibility; contaminants and damage are
  sparse facts, not more global meters.
- **OQ6 — coverage behaviors.** Exact rules for plackets, zippers, sleeves,
  straps, skirts/hems, and asymmetric layering.
- **OQ7 — extraction confidence.** Always drop ambiguous part operations, or
  fall back to the garment root when conservative?
- **OQ8 — image invalidation.** Which presentation bands refresh `chat_look`
  versus only the next scene image?
- **OQ9 — plan boundary.** Promote this as the wardrobe-state prerequisite to
  body affordances, or promote both with one shared perception/ranking slice?
