# Garment archetypes and reusable components

Status: draft — parked 2026-07-30 after reconciling the clothing-archetype idea
with the clothing state graph that shipped on 2026-07-27. Do not build from this
stub; promote it per [CLAUDE.md](CLAUDE.md) first.

Companion technical design:
[clothing-archetypes-components.spec.md](clothing-archetypes-components.spec.md).
Upstream system:
[../clothing-state-graph.plan.md](../clothing-state-graph.plan.md).

## What

Add an authoring layer that describes a garment as a recognizable archetype
assembled from reusable components, then compiles it into the sparse garment
blueprint graph the wardrobe already stores and executes.

```text
existing broad category
        ↓ author selects
specific archetype
        ↓ compose defaults + options
reusable garment components
        ↓ deterministic compilation
versioned garment blueprint
        ↓ existing clothing system
instance, locus, presentation, condition, coverage, cues
```

Examples:

- a tee compiles with short sleeves, a neck opening, and no closure by default;
- a polo adds a collar and short button placket;
- a pullover sweater normally has long sleeves and no front closure;
- a pullover hoodie may add a hood, drawstrings, and one kangaroo pocket;
- a zip hoodie has split front panels, a full zipper, and normally two separate
  front pockets;
- a graphic, patch, or embroidery becomes an addressable surface component
  rather than prose buried in the item description.

Archetypes provide authoring defaults, not hidden runtime rules. A hoodie without
a pocket, a long-sleeve tee, or a quarter-zip sweater remains valid because the
compiled graph explicitly says which parts exist.

## Why it matters

The shipped clothing state graph solved persistent garment identity and mutable
state: individual parts can be rolled, opened, displaced, wetted, dirtied,
damaged, located, restored by retakes, and projected into one coverage and cue
read.

Its first release intentionally compiled broad existing categories such as
`top` and `outerwear` into conservative sparse graphs. That was the correct
migration-safe foundation, but a broad category cannot express construction
differences that now matter:

- a tee and polo are both tops but do not have the same collar or closure;
- a sweater and tee do not have the same sleeve coverage;
- a hood is not merely another alias for a collar;
- a kangaroo pocket is one compartment with two openings, while a zip hoodie
  usually has two compartments;
- a printed graphic should be able to fade independently of the fabric panel;
- the system cannot validate a hand-in-pocket relation until the pocket and its
  openings exist as explicit structure.

Without an archetype/component compiler, authors either accept generic category
graphs or edit raw nodes and edges. The former loses useful truth; the latter
turns ordinary clothing authoring into graph surgery.

## Product outcomes

An author should be able to select “pullover hoodie,” choose or remove its
optional components, assign materials and fit, and see a generated structural
summary without touching graph JSON.

The resulting garment should support grounded downstream statements such as:

- “both hands are tucked into the hoodie's front pocket,” when an authoritative
  body-garment interaction says so;
- “the pouch pulls around her wrists,” when an affordance derives deformation
  from occupancy, fit, material, and pose;
- “the faded graphic across her tee,” when persistent decoration condition is
  visible and worth mentioning;
- “the hood covers most of her hair,” when presentation and coverage say the
  hood is raised.

The narrator still receives compact semantic reads, never the archetype registry,
component graph, capacities, or raw condition values.

## Design rulings

### Keep the existing category vocabulary

`ItemDefinition.category` remains the broad authoring and editor bucket. This
plan does not replace `top`, `outerwear`, `dress`, `pants`, and the other shipped
categories with a second family taxonomy.

An archetype sits beneath a category:

```text
category: top
archetype: pullover_hoodie
```

Existing item definitions without an archetype continue through the shipped
category-template path unchanged.

### Composition, not inheritance

Use declarative archetypes assembled from reusable component fragments. Do not
build an inheritance tree such as `ZipHoodie extends Hoodie extends Sweater`.
Garments routinely add, omit, or substitute features in combinations that make
inheritance brittle.

### The compiled graph remains runtime truth

Runtime systems may use an archetype id for display, filtering, and authoring
provenance. They must never infer a pocket, hood, closure, sleeve length, or
behavior from that id.

The existing normalized blueprint and its content hash remain the mechanical
identity snapshotted by garment instances. This plan does not introduce a
second runtime fingerprint.

### Extend the blueprint compatibly

The shipped blueprint-v1 contracts and stored snapshots must remain readable.
The archetype compiler should target a backward-compatible blueprint-v2 shape:
retain existing nodes, edges, behaviors, normalization, validation, and hashing;
add only the roles, component relationships, and capabilities needed for the
new construction grammar.

Existing instances never silently acquire new parts when an archetype or
component registry changes.

### Structure, relation, effect, and narration are separate

Keep four facts distinct:

```text
STRUCTURE
The hoodie has one kangaroo compartment and two openings.

CURRENT RELATION
Both hands are inserted through those openings.

DERIVED EFFECT
The pocket sags and pulls around the wrists.

NARRATION
She keeps both hands buried in the hoodie's front pocket.
```

The wardrobe owns compiled structure and persistent garment state. The planned
shared scene/body-relations owner owns current hand insertion, grasp, pose, and
contact. Garment affordances may derive deformation from accepted relations but
must not invent occupancy. Narration realizes the final selected observation.

### Decorations are components with localized condition

A graphic, patch, applique, or embroidery is an addressable decoration attached
to a structural region. Its mutable fade, cracking, peeling, staining, or
abrasion belongs to garment condition keyed to that component.

Do not turn every decoration into a global garment meter, and do not treat
ordinary wear as proof that a graphic is faded.

### Fit becomes authored wardrobe truth

The current garment-affordance implementation has a deliberate fit gap: unknown
fit establishes no ordinary body contact, leaving wet cling production-silent.
This extension should add one conservative garment-level fit band, with regional
overrides only if real cases justify them.

Fit is structural wardrobe truth. Affordances consume it; they do not calibrate
or persist it.

## Boundaries

| Owner | Owns here | Does not own here |
| --- | --- | --- |
| category registry | broad editor bucket and legacy defaults | specific construction mechanics |
| archetype/component compiler | reusable fragments, variants, constraints, blueprint compilation | live garment state |
| clothing state graph | blueprint snapshots, instances, locus, presentation, condition, coverage | body pose/contact relations |
| scene/body-relations owner | accepted pose, contact, grasp, and insertion relations | garment construction |
| garment affordances | current physical effects derived from authoritative inputs | persistent state or occupancy |
| perception/cue ranking | visibility, relevance, novelty, repetition budget | truth mutation |
| narrator/image consumers | realization of selected semantic reads | raw graph interpretation |

## Likely slices

### Slice 0 — re-audit and blueprint-v2 ruling

- Re-verify current item authoring, blueprint, validator, store, migration,
  coverage, garment-affordance, and state-tools seams.
- Freeze the blueprint-v1 compatibility and upcast contract.
- Resolve fit storage, archetype provenance, and legacy-definition behavior.
- Build fixtures for tees, polos, sweaters, pullover hoodies, zip hoodies,
  no-pocket variants, long-sleeve substitutions, and graphics.

### Slice 1 — archetype and component registries

- Add typed archetype definitions, reusable component fragments, variant slots,
  material slots, and validation constraints.
- Bind every archetype to one existing clothing category.
- Add a pure deterministic compiler into normalized blueprint-v2 values.
- Reuse the existing blueprint content hash; do not create a parallel identity.

### Slice 2 — backward-compatible blueprint extensions

- Add semantic roles and the smallest useful new component relationships.
- Add pocket/opening, hood, drawstring, and decoration structure.
- Add conservative fit to wardrobe structure.
- Keep blueprint-v1 snapshots readable and behaviorally identical.

### Slice 3 — ordinary authoring flow

- Add archetype and component controls to item authoring.
- Show a generated component summary and stable validation errors.
- Extend “Draft from description” to propose archetype, components, materials,
  and fit, fill-empty-only and human-reviewed.
- Keep the advanced graph inspector optional.

### Slice 4 — first garment grammar

- Ship tee, polo, pullover sweater, cardigan, pullover hoodie, and zip hoodie.
- Prove sleeve, collar, front-panel, closure, hood, and pocket differences.
- Prove unusual but valid substitutions without bespoke runtime code paths.

### Slice 5 — decorations and localized surface condition

- Add screen print, embroidery, patch, and applique components.
- Add localized fade/crack/peel condition with deterministic operations and
  retake/replay parity.
- Wire perception and existing garment cue ranking without creating a separate
  decoration narrator path.

### Slice 6 — component capability reads

- Project narrowed capabilities for pockets, openings, hoods, drawstrings,
  graspable parts, and closures.
- Make coverage and current garment presentation consume explicit structure.
- Keep capability reads inert where the scene/body-relations owner is absent.

### Slice 7 — body-garment interactions

- Only after the shared scene/body-relations owner ships, add accepted hand
  insertion and garment-part grasp relations.
- Validate relations against garment locus, opening accessibility, current
  presentation, pose, and body-part availability.
- Capture or replay relations according to that owner's lifecycle, not inside
  the wardrobe store.

### Slice 8 — affordance and consumer integration

- Add occupied-component deformation only when authoritative interactions and
  material/fit mechanics exist.
- Feed hood coverage and component condition into the shared coverage,
  perception, cue, and image reads.
- Evaluate contradiction, repetition, authoring burden, and narrator usefulness
  before enabling new cue families by default.

## Acceptance criteria

- Existing clothing definitions and blueprint-v1 snapshots remain behaviorally
  unchanged unless an author explicitly adopts an archetype.
- Categories remain the single broad authoring vocabulary; archetypes do not
  duplicate or replace them.
- A standard tee compiles without a collar, closure, or pocket.
- A polo compiles with a collar and short placket by default.
- Pullover and zip hoodies compile different front-panel, closure, and pocket
  topology.
- A no-pocket hoodie exposes no pocket interaction capability.
- A long-sleeve tee works through component substitution without a runtime
  special case.
- Runtime coverage, interaction, and affordance code inspects explicit compiled
  structure rather than branching on English garment names or archetype ids.
- A hand-in-pocket observation requires an authoritative interaction relation;
  pocket capability alone never creates occupancy.
- A graphic is independently addressable and can carry localized persistent
  condition.
- The existing blueprint hash remains the instance snapshot identity.
- Retakes and replay restore compiled structure, presentation, condition,
  interactions from their proper owner, selected reads, and mention history
  consistently.

## Not in scope

- cloth meshes, sewing patterns, manufacturing construction, or CAD;
- manually authoring every seam, stitch, button, or decorative thread;
- replacing the existing category registry;
- inheritance-based runtime garment classes;
- automatic mechanics inferred from fashion names;
- storing pose/contact state inside garment blueprints;
- a general-purpose property graph or user-programmable rules DSL;
- item storage economy inside pockets before container gameplay is separately
  justified;
- bypassing the existing perception, exposure, consent, or cue-budget gates.

## Open questions

- **OQ1 — construction storage.** Does an item definition store a typed
  archetype/component authoring recipe beside its compiled blueprint source, or
  can the recipe remain authoring-only once compiled?
- **OQ2 — fit depth.** Is one garment-level `unknown | loose | fitted | tight |
  structured` band sufficient for the first release?
- **OQ3 — blueprint-v2 shape.** Which concepts require new node kinds versus an
  optional semantic role or capability on existing kinds?
- **OQ4 — override limits.** Which author customizations are safe normalized
  overrides, and which require a reusable component variant?
- **OQ5 — first-wave breadth.** Do the six upper-body archetypes prove the
  compiler before bottoms, dresses, footwear, and non-human accommodations?
- **OQ6 — decoration condition.** Should fade/crack/peel use one narrow
  surface-feature state or extend the existing damage/deposit vocabulary?
- **OQ7 — interaction timing.** Should component capability ship before the
  scene/body-relations owner, remaining deliberately inert until that owner is
  available?
- **OQ8 — pocket scope.** Does the first interaction release support hands only,
  or also authoritative small-item occupancy?