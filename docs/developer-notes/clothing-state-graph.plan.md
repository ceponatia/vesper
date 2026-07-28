# Clothing state graph and condition gradients

Status: next (graduated 2026-07-27 from the deferred parking lot, same day as
parking. Promotion rulings below settled OQ3/OQ4/OQ5/OQ9; the remaining open
questions resolve in slice 0. Queued at the top of [roadmap.md](roadmap.md)
§Next. This plan is the upstream wardrobe-truth prerequisite for the
still-parked body-attribute-affordances companion set — promoted alone, per
ruling R1.)

## What

Turn clothing from a list of garment names into persistent, addressable visual
state:

```text
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
- mud remains at the hem after the rest has dried.

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
  [garment-affordance spec](deferred/body-attribute-affordances.spec.garment-interaction.md)
  expects wardrobe-owned material profiles and persistent wetness, dirt,
  damage, displacement, and fastened state that do not exist yet.

This plan is that missing upstream wardrobe/presentation owner. The affordance
layer may derive wet cling, opacity, drape, and motion from it; it must not
invent or persist garment state itself.

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

### Model only parts that can change a read

This is semantic topology, not CAD or cloth simulation. A node earns its place
when it can be independently manipulated, conditioned, exposed/hidden, or used
to change coverage.

A shirt may have root, front/back panels, collar, two sleeves/cuffs, hem, and
one placket closure. It does not need every seam or ten button nodes. A closure
can model several fasteners with a count and open interval.

Category templates generate the common sparse graph. “Draft from description”
may propose refinements; ordinary authoring must not require graph surgery.

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

## Promotion rulings (owner, 2026-07-27)

- **R1 (OQ9) — promoted alone, as the prerequisite.** This plan graduates by
  itself; [deferred/body-attribute-affordances.plan.md](deferred/body-attribute-affordances.plan.md)
  stays parked and consumes this plan's digest when it later promotes. No
  shared perception/ranking slice now — slice 8 remains the integration seam.
- **R2 (OQ3) — continuity may mint ad-hoc garment instances.** An unowned
  garment the fiction introduces ("a borrowed hoodie") becomes a real
  chat-scoped instance minted from a validated minimal category template
  (sparse graph, conservative material, degraded defaults). Guarded exactly as
  the design rulings demand: never free-text, and a minted garment never
  decides intimate coverage on its own.
- **R3 (OQ4) — a left garment stays at its place.** The scene locus persists
  across scene moves; returning to the room finds the jacket still over the
  chair. Continuity narrates retrieval as an ordinary transfer operation —
  never a silent rejoin of the wardrobe.
- **R4 (OQ5, recommendation adopted) — wetness + crease_load ship first**,
  with cleanliness/wear bridged for compatibility; contaminants and damage
  stay sparse located facts, not additional global meters.

The schema belongs under `src/contracts/items`, not in an untyped `fields`
convention:

```ts
interface GarmentBlueprint {
  version: number;
  rootNodeId: GarmentPartId;
  nodes: readonly GarmentPartNode[];
  edges: readonly GarmentEdge[];
  behaviors: readonly GarmentBehaviorBinding[];
}

interface GarmentPartNode {
  id: GarmentPartId;
  kind:
    | "root" | "panel" | "collar" | "sleeve" | "cuff"
    | "strap" | "hem" | "closure" | "lining" | "hardware";
  side?: "left" | "right" | "center";
  aliases: readonly string[];
  materialProfileId: GarmentMaterialProfileId;
  baselineCoverage: readonly BodyLocationId[];
  layerOffset?: number;
}

type GarmentEdge =
  | { kind: "part_of"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "fastens"; from: GarmentPartId; targets: readonly GarmentPartId[] }
  | { kind: "mirrors"; from: GarmentPartId; to: GarmentPartId }
  | { kind: "constrains"; from: GarmentPartId; to: GarmentPartId };
```

Validation requires one root, known endpoints, acyclic `part_of` edges, unique
ids, and valid body/material registry ids. Other typed edges may cross the tree
but cannot change ownership.

`GarmentBehaviorBinding` points nodes at narrow registry behaviors such as
`rollable_sleeve`, `linear_front_closure`, `adjustable_strap`, or
`tuckable_hem`. Avoid an arbitrary rules DSL in v1.

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
without becoming full graph nodes.

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
  integratedAt: StoryTimestamp;
}
```

Deposits carry a registry kind (`mud`, `blood`, `dust`, `food`, `paint`,
`cosmetic`, `unknown`), part ids, intensity/extent bands, freshness, cause, and
time. Damage marks carry a kind (`tear`, `hole`, `fray`, `scuff`, `burn`,
`missing_fastener`), one part, severity/extent, and cause.

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
  | { kind: "restore_presentation"; garmentId: GarmentInstanceId; partIds: readonly GarmentPartId[] }
  | { kind: "apply_condition"; garmentId: GarmentInstanceId; partIds: readonly GarmentPartId[]; channel: GarmentConditionKey; change: DegreeDelta }
  | { kind: "deposit"; garmentId: GarmentInstanceId; partIds: readonly GarmentPartId[]; depositKind: GarmentDepositKind; degree: DegreeBand }
  | { kind: "clean"; garmentId: GarmentInstanceId; partIds: readonly GarmentPartId[]; target: CleanBand }
  | { kind: "damage"; garmentId: GarmentInstanceId; partId: GarmentPartId; damageKind: GarmentDamageKind; degree: DegreeBand }
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
5. build effective material/coverage reads;
6. let garment affordances derive current effects;
7. perception-gate and rank observations;
8. capture the selected read with the cut.

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

Useful families are `closure_open`, `part_rolled`, `part_displaced`,
`surface_damp_or_wet`, `deposit_visible`, and `damage_visible`, plus
affordance-owned wet cling, effective opacity, pose drape, and motion.

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
| item/wardrobe | blueprint, instance, locus, presentation, gradients, deposits, damage | cling/drape observations; attention |
| environment/events | rain, spills, contact, force, care/damage causes | graph patches |
| garment affordances | effective mechanics and actual current effects | persistent wardrobe state |
| coverage/perception | visibility and observer/channel gating | mutation |
| cue ranker | relevance, novelty, repetition budget | truth or condition |
| narrator/image | realization of selected semantic reads | new state |

This plan does not absorb the broader visual-attention or recognizable-feature
memory work. It supplies garment observations to those consumers.

## Slices

### Slice 0 — audit, corpus, and promotion rulings

- Re-verify chat wardrobe, item definition, successor item-condition, cut,
  image, and garment-affordance seams.
- Build fixtures for asymmetric sleeves, closures, removal-to-chair,
  cotton/leather rain, local mud, drying, washing, retake, hidden underlayers,
  and image agreement.
- Resolve the open questions before schema work.

### Slice 1 — blueprint/material contracts and authoring

- Add graph/material registries, validators, degraded defaults, and category
  graph templates under `src/contracts/items`.
- Extend classification/“Draft from description” to propose sparse nodes and
  materials, fill-empty-only and human-reviewed.
- Add an advanced graph inspector without making it mandatory.

### Slice 2 — chat-scoped instances and whole-garment loci

- Materialize definition-backed instances for character and player.
- Migrate preset/worn-list state without preserving a second wardrobe truth.
- Make don/doff/hold/scene placement rollback-safe.
- Decide and implement the guarded ad-hoc garment path.

### Slice 3 — presentation graph

- Add closure, roll, tuck, restore, and displacement operations.
- Derive per-part coverage and reuse the existing visibility resolver through
  a richer input shape.
- Add state-tool controls and graph/coverage diagnostics.

### Slice 4 — gradients and local marks

- Generalize/reuse the fixed-point item-condition kernel.
- Ship wetness and crease load plus bridges for cleanliness/wear.
- Add regional overrides, contaminants, damage marks, hysteretic bands, and
  event-time integration.
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

- Feed wardrobe-owned structure/current state to garment affordances.
- Admit observations to shared visual attention/memory only after perception
  and cut capture.
- Evaluate scene-image reuse; do not build an image-only state model.

## Acceptance criteria

- Left/right parts can differ without duplicating the garment.
- Closing, rolling, cleaning, drying, damaging, and repairing are deterministic
  typed operations with stable rejection diagnostics.
- A doffed jacket remains located and stops contributing coverage.
- Coverage, narrator authority, and image exposure share one read.
- Cotton and leather respond differently to the same rain source.
- A muddy hem survives whole-garment drying and is removed by regional cleaning.
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
- a new visual-attention system;
- manufacturing, sizing, tailoring, laundry economy, or item acquisition;
- precise furniture coordinates before the spatial owner exists;
- sending the graph or raw meter values to an LLM.

## Open questions

_All resolved. OQ3, OQ4, OQ5, and OQ9 at promotion — see §Promotion rulings.
OQ1, OQ2, OQ6, OQ7, and OQ8 in slice 0 (2026-07-27) — rulings and their full
rationale live in [clothing-state-graph.audit.md](clothing-state-graph.audit.md)
§Part 2, alongside the seam map's six corrections to this plan's assumptions
(dead-not-dormant `itemInstanceStateSchema`; the name-keyed `scene` locus; the
visibility-resolver rewrite slice 3 actually requires; the proposal-triggered
`chat_look` refresh OQ8 must widen; the no-duplicate-worn-copies defect; the
`outfit_exposed` bypass slice 2 must demote). One-line versions: templates bind
to the existing 15 `clothingCategories` ids (9 sparse, 6 root-only) with the
7+unknown material registry; instances snapshot a content-hash-deduplicated
blueprint into the chat-wide store (never a library pointer); behaviors only
subtract from their own node's baseline coverage with per-behavior thresholds;
ambiguous part handles are dropped with a diagnostic (root is an explicit
handle; empty partIds legal only for condition-class ops); `chat_look`
refreshes on worn-set/structural-presentation/wet-band/deposit-damage-presence
changes via a pre/post key comparison.
