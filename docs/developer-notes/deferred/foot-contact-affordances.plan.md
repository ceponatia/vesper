# Foot contact affordances and sensory feedback

Status: draft (stub — parked 2026-07-27, owner request; promote per
[CLAUDE.md](CLAUDE.md) before building)

## What

Use foot contact as the first chat-facing proving domain for grounded physical
and sensory narration. The system should turn a player or character action plus
authoritative pose, contact, clothing, body-surface, and environment state into:

- a validated committed contact or a clear rejection/required reposition;
- current pressure, contact-area, texture, glide, temperature, transfer, and
  scent observations when their inputs actually exist;
- compact, perception-safe narrator cues;
- stable repetition keys so sustained contact remains true without being
  described every turn.

```text
player / character action intent
              ↓
action + access resolver
              ↓
committed contact, motion, and minimal pose adjustments
              ↓
regional foot-contact frame
              ↓
narrow foot phenomena
              ↓
physical + tactile + scent observations
              ↓
perception, relevance, novelty, repeat cap
              ↓
structured narrator cues
```

Feet are the first test bed because they exercise support, accessibility,
articulation, contact, texture, local moisture, footwear, material filtering,
tactile perception, scent proximity, state transfer, and repetition control
without requiring the full intimate-physiology model. The same proven contact
primitives may later support hand contact, kissing, and adult consent-gated
intimate interactions, but those regions are not part of this draft.

## Why it matters

The narrator should not be asked to reinterpret vague appearance prose or solve
body geometry. It should not invent that a foot is bare, reachable, damp,
flexed, weight-bearing, or reacting emotionally because those details would
make a sentence more vivid.

The player also should not have to micromanage harmless joint adjustments. If a
bare, free foot is already within reach, an intent such as touching or kissing
its heel may imply a small ankle rotation or lean. It must not silently imply
shoe removal, sock removal, a major posture change, exposure, locomotion, or a
character reaction.

Success is:

- natural player intent rather than joint-by-joint puppeteering;
- physically coherent action resolution;
- useful sensory differences between foot regions and coverings;
- no narrator access to internal support coefficients or rejected alternatives;
- no repeated recital of an unchanged contact;
- a reusable contact seam that does not become a second pose, wardrobe,
  physiology, consent, or behavior engine.

## Relationship to existing deferred plans

This plan is a focused consumer and architecture proof, not a parallel system.

- [Body-attribute affordances](body-attribute-affordances.plan.md) owns the
  profile → mechanics → frame → phenomenon → cue architecture.
- [Domain architecture](body-attribute-affordances.spec.architecture.md) owns
  the generic contracts, evidence, diagnostics, perception, ranking, and
  capture rules.
- [Skin surface](body-attribute-affordances.spec.skin-surface.md) owns the
  projection of authoritative wetness, sweat, contamination, pressure marks,
  and other surface state into region observations.
- [Clothing state graph](clothing-state-graph.plan.md) owns shoes, socks,
  hosiery, garment instances, closures, displacement, wetness, cleanliness,
  and material state.
- [Garment interaction](body-attribute-affordances.spec.garment-interaction.md)
  owns effective material behavior and coverage reads.
- [Relative geometry](body-attribute-affordances.spec.relative-geometry.md)
  provides the precedent for action-relevant pair geometry without making
  generic reach or action success an ambient narrator cue.
- [Physiology](physiology.plan.md) owns sweat production, temperature, vascular
  signs, sensitivity drivers, and any later intimate physiology. This plan may
  consume results but never infer them.

The important boundary is that the existing affordance layer is a read layer.
A small cooperating **contact-action resolver** must first decide whether an
attempted action can occur and commit any permitted pose/contact transition.
Foot phenomena then read the committed result. They do not create contact by
claiming it was possible.

## Relevance of the proposed phenomenon list

The external proposal is mostly relevant and fits the existing architecture,
but several entries need ownership corrections.

| Proposal | Ruling |
| --- | --- |
| `foot.contact_pressure` | Adopt. It resolves pressure locus, band, and area only from committed contact. |
| `foot.surface_texture_contact` | Adopt. It combines regional surface structure, current condition, and material between the surfaces. |
| `foot.glide_response` | Adopt. It requires current sliding motion and authoritative moisture/product/material state. |
| `foot.arch_toe_pose` | Split. Articulation capacity may be a foot mechanic; actual curl/flex/spread is committed pose/action state. The affordance read may describe it but cannot choose it or treat it as emotion. |
| `foot.nail_contact` | Adopt with a mutation boundary. It may derive edge/trace/scratch eligibility from actual contact; a scratch or mark requires a committed event/body-state update. |
| `footwear.aftermark` | Adopt as a consumer of authoritative pressure-mark state. The affordance layer must not keep hidden aftermark hysteresis. |
| `foot.surface_transfer` | Adopt as a resolver/event plus read. Eligibility may be calculated here, but residue movement must be committed by the contact/body/garment owner before narration treats it as present. |
| `foot.scent_proximity` | Adopt as an olfactory perception phenomenon, not a permanent foot adjective. It requires exposure, current contributors, distance, and airflow. |

The suggested `RegionalContactFrame` is a useful reusable abstraction. V1
should keep it deliberately small and prove it through foot fixtures before
turning it into a universal body-contact framework.

## Core rulings

### Support does not determine posture

`supportRole` answers how a foot participates in current support. It does not
by itself decide whether the character is standing, seated, reclining, lying,
kneeling, crouching, or transitioning.

A seated character may brace both feet and load them substantially. A lying
character may press one foot into a mattress or wall. A standing character may
have one free foot. A kneeling character may primarily load knees and shins.
The pose owner must supply the whole-body support arrangement.

```ts
interface FootSupportRead {
  footId: FootId;
  supportRole: "weightBearing" | "partial" | "free";
  mobility: "free" | "limited" | "fixed" | "trapped";
  supportSurfaceId?: EntitySurfaceId;
  evidence: readonly AffordanceEvidence[];
}
```

Support role and mobility are independent. A non-weight-bearing foot may still
be trapped under another leg, pinned by furniture, held by another actor, or
constrained by rigid footwear.

### Accessibility is actor-, surface-, and action-specific

A foot is not globally `accessible`. Accessibility is queried for one actor,
using one body part, toward one target surface, for one action.

```ts
interface FootAccessQuery {
  actorId: CharacterId;
  actorRegion: BodyLocationId;
  targetId: CharacterId;
  targetFootId: FootId;
  targetSurfaceId: FootSurfaceId;
  actionKind: FootContactActionKind;
}

type FootAccessMode =
  | "direct"
  | "implicit_adjustment"
  | "explicit_reposition_required"
  | "blocked_by_clothing"
  | "blocked_by_geometry"
  | "out_of_reach";

interface FootAccessResult {
  mode: FootAccessMode;
  coveringLayers: readonly GarmentInstanceId[];
  implicitAdjustments: readonly MinimalPoseAdjustment[];
  explicitRequirements: readonly ActionRequirement[];
  evidence: readonly AffordanceEvidence[];
}
```

The heel may be reachable by hand but not by mouth. The top of the foot may be
visible but covered. The arch may be tactilely available through a sock while
direct skin contact remains blocked.

### Minimal kinematic adjustments may be implicit

The resolver may perform a small, ordinary movement required to satisfy an
otherwise-valid intent when it:

- stays within the current interaction and proximity;
- does not remove or displace clothing;
- does not expose a covered surface;
- does not change rooms, furniture, or major posture;
- does not require a substantial support transfer;
- does not override resistance or consent;
- does not invent an independent expressive reaction.

Examples that may be implicit:

- slight ankle rotation of a free foot;
- a small foot lift when support and clearance allow it;
- the actor leaning closer;
- moving a hand from heel to arch;
- angling the head to reach an already exposed surface;
- a small passive articulation directly entailed by an allowed contact action.

Examples that must be explicit:

- removing or loosening shoes or socks;
- undoing a closure;
- pulling a trapped foot free;
- getting up, sitting down, rolling over, or moving to new furniture;
- transferring enough weight to change stability;
- crossing meaningful distance;
- voluntarily curling, spreading, or pointing the toes as a character response;
- forcing articulation against resistance.

The behavior/reaction system may later choose a toe curl, withdrawal, or other
response. Physical possibility never licenses the narrator to invent it.

### Clothing state changes are never implied

Shoes, socks, and hosiery participate through the clothing graph. A requested
skin-contact action fails or reports an explicit removal requirement while a
covering layer remains authoritative.

Wearing a shoe does not make toe motion physically impossible. It usually makes
that motion externally unobservable. The narrator may surface internal movement
only when a valid channel exposes it—for example, direct contact with a flexible
shoe that transmits the movement.

### Possibility is not an event

Every phenomenon requires the actual current cause:

- pressure requires committed contact;
- texture requires contact plus a tactile channel;
- glide requires current sliding motion;
- nail trace requires nail contact at a supported angle;
- transfer requires a committed transfer event/state update;
- scent requires current contributors and olfactory access;
- articulation observations require a committed pose configuration.

A capacity or eligibility result remains diagnostic until an action owner
commits the corresponding state.

## Foot regional topology

The runtime needs an addressable semantic surface graph. This is anatomical
and interaction topology, not a detailed biomechanical mesh.

```text
foot
├── plantar_surface / sole
│   ├── heel_pad
│   ├── arch
│   │   ├── medial_arch
│   │   └── lateral_arch
│   ├── ball
│   ├── inner_edge
│   └── outer_edge
├── dorsal_surface
│   └── top_of_foot
├── toes
│   ├── toe_tops
│   ├── toe_pads
│   ├── interdigital_spaces
│   └── toenails
└── ankle_boundary
```

`sole` is the product/authoring label; `plantar_surface` may be the internal
identifier. The ankle is adjacent interaction topology rather than a child of
the sole or toes.

### Parent inheritance and regional overrides

Child surfaces inherit stable baseline structure from their parent and apply
narrow modifiers. Character authoring should not require an independent full
profile for every subregion.

```ts
interface FootSurfaceStructuralProfile {
  surfaceId: FootSurfaceId;
  parentSurfaceId?: FootSurfaceId;
  softness: UnitInterval;
  compliance: UnitInterval;
  drySurfaceFriction: UnitInterval;
  callusBand: UnitInterval;
  moistureRetention: UnitInterval;
  airflowExposure: UnitInterval;
  tactileTextureBand: FootTextureBand;
}
```

Examples:

- `heel_pad` inherits from the sole, then usually increases callus and reduces
  compliance;
- `arch` inherits from the sole, then usually reduces callus and increases
  softness/compliance;
- `ball` may increase pressure exposure and callus relative to the arch;
- `interdigital_spaces` inherit toe skin but increase moisture retention and
  reduce airflow when the toes are together;
- `toenails` use a separate hard-surface profile rather than inheriting skin
  texture.

Exact canonical attribute ids require a repository vocabulary audit. Likely
needs include sole baseline, dorsal/top-of-foot presentation, toe structure,
and toenail length/shape/condition/polish. Static attributes must not store a
permanent smell or taste.

## Dynamic surface condition

Stable structure combines with authoritative current state:

```ts
interface FootSurfaceConditionRead {
  surfaceId: FootSurfaceId;
  moisture: UnitInterval;
  sweatContribution: UnitInterval;
  temperatureBand?: ContactTemperatureBand;
  cleanlinessBand?: CleanlinessBand;
  residues: readonly SurfaceResidueRead[];
  pressureMarks: readonly BodySurfaceMarkRead[];
  coveredDuration?: StoryDuration;
  evidence: readonly AffordanceEvidence[];
}
```

Physiology/body state must supply the sweat, wetness, and temperature source.
The foot domain may distribute a nonzero coarse foot wetness read through
calibrated regional retention and airflow modifiers, but it must never create
moisture from a zero/absent source.

This permits the sole, dorsal surface, and interdigital spaces to differ:

- a shoe-contained sole may remain damp while the top dries after removal;
- interdigital spaces may retain moisture longer than exposed toe tops;
- lotion may be present on the sole but absent between the toes;
- dust or grass may affect only contacted surfaces;
- a pressure line remains visible only when an authoritative mark exists.

Taste and scent are derived perception outputs from current sweat, residues,
products, cleanliness state, exposure, and channel. They are not permanent
character adjectives and should not be generated when the inputs are absent.

## Footwear integration

Footwear and hosiery are wardrobe-owned semantic graphs. Useful sparse parts
include:

```text
sock / hosiery
├── cuff
├── leg_section
├── heel_section
├── sole_section
└── toe_section

shoe
├── upper
├── toe_box
├── tongue
├── closure
├── heel_counter
├── insole
└── outsole
```

The effective read supplied to foot contact should include:

```ts
interface FootwearContactRead {
  coveringLayers: readonly GarmentLayerRead[];
  containedSurfaces: readonly FootSurfaceId[];
  compression: UnitInterval;
  rigidity: UnitInterval;
  toeBoxVolume: UnitInterval;
  ankleRestriction: UnitInterval;
  effectiveFriction: UnitInterval;
  permeability: UnitInterval;
  closureState: GarmentClosureRead;
}
```

Rulings:

- direct skin contact is blocked while an opaque physical layer remains;
- tactile contact through fabric may remain available with a material filter;
- open-toed footwear may expose toe surfaces without exposing the sole;
- a loose shoe may permit heel slip while still containing the toes;
- tight footwear may restrict articulation and suppress visible deformation;
- shoe or sock removal is a committed wardrobe action, never an affordance
  shortcut;
- pressure marks are body-state records created by an owner event and merely
  projected by the skin/foot read after removal.

## Contact-action boundary

The action resolver consumes intent, access, policy, pose, support, clothing,
and geometry. It either rejects the action, requests an explicit transition, or
commits a contact/motion read.

```ts
interface CommittedRegionalContactRead {
  contactId: ContactId;
  storyTime: StoryTimestamp;
  source: BodySurfaceHandle;
  target: BodySurfaceHandle;
  pressureIntent: ContactPressureIntent;
  contactAreaHint: ContactAreaHint;
  motion?: CommittedContactMotionRead;
  materialBetween: readonly GarmentLayerRead[];
  implicitAdjustments: readonly MinimalPoseAdjustment[];
  provenanceEventId: EventId;
}
```

The affordance layer never receives an uncommitted attempted contact as if it
were current truth. Rejected attempts may produce a separate action-result cue,
but they do not enter the physical observation queue.

## Regional contact frame

The proposed reusable abstraction is accepted with two changes: both surfaces
carry their own current condition, and support/access evidence stays explicit.

```ts
interface RegionalContactFrame {
  storyTime: StoryTimestamp;
  source: BodySurfaceRead;
  target: BodySurfaceRead;
  contact: CommittedRegionalContactRead;
  motion?: CommittedContactMotionRead;
  materialBetween: readonly GarmentLayerRead[];
  sourceCondition: SurfaceConditionRead;
  targetCondition: SurfaceConditionRead;
  support: RegionalSupportContext;
  perception: PerceptionContext;
  recentEvents: readonly AffordanceCausalEvent[];
}
```

V1 may place this minimal contract in the generic affordance contact core while
keeping all foot-specific profile compilation and phenomena under the foot
contact domain. Do not generalize additional fields until a second domain proves
the need.

## Initial phenomena

### `foot.contact_pressure`

Requires committed contact. Combines pressure intent, source/target surface
geometry, support, and current motion into semantic outputs:

- contact locus or path;
- `trace`, `light`, `moderate`, or `firm` pressure;
- `point`, `narrow`, or `broad` contact area;
- pressure distribution changes when a path crosses heel, arch, ball, edge, or
  toes.

It does not decide that contact occurred and does not create redness or a mark.

### `foot.surface_texture_contact`

Requires actual contact and a tactile channel. Combines target regional profile,
current moisture/residue state, and material between the surfaces. Output tags
may include:

- `soft_arch`;
- `firmer_ball`;
- `rougher_heel`;
- `smooth_dorsal_surface`;
- `ribbed_sock_filtered`;
- `stocking_filtered`;
- `moisture_softened`.

Tags remain semantic and relative; the narrator does not receive coefficients.

### `foot.glide_response`

Requires current sliding motion. Inputs:

- local dry friction and compliance;
- lotion, oil, sweat, water, or other authoritative surface material;
- hosiery/garment material between the surfaces;
- pressure and contact area;
- current path across foot/body regions.

Output bands:

- `dragging`;
- `controlled_glide`;
- `smooth_glide`;
- `slippery`;
- `grip_breaks`;
- a local `rough_surface_catch` when the path actually crosses a rougher region.

No lotion/oil/sweat input means the phenomenon cannot invent a slippery result.

### `foot.articulation_observation`

The foot profile may expose range/capacity constraints used by the action
resolver. The observation phenomenon consumes only committed pose state:

- toes relaxed, flexed, curled, pointed, or spread;
- arch neutral or extended;
- movement restricted by support, footwear, contact, or obstruction.

It never converts touch into a toe curl, withdrawal, or other emotional
reaction. Those require a behavior/reaction decision followed by pose state.

### `foot.nail_contact`

Combines actual nail contact, nail length/shape/condition, angle, pressure, and
motion. It may emit:

- `light_nail_trace`;
- `firm_nail_edge`;
- `scratch_possible_but_not_committed` as diagnostic suppression;
- `scratch_contact` only after a committed action result.

Any resulting scratch, redness, residue, or damage belongs to body/garment state
and must be recorded by an event owner.

### `foot.pressure_mark_surface_state`

Consumes authoritative marks such as sock lines, strap impressions, or shoe
compression after the covering pressure changes or ends. The mark includes
location, intensity, provenance, and expiry. The phenomenon only decides how it
is available to perception.

### `foot.surface_transfer`

The contact resolver may calculate transfer eligibility from current material,
pressure, area, and motion. Transfer becomes true only when a committed event
updates source and destination residue state. The observation may then describe:

- lotion transferred to another skin region;
- sweat dampening fabric;
- dirt or paint moved between surfaces;
- a visible or tactile trail along the contact path.

The affordance read owns no contamination inventory and performs no mutation.

### `foot.scent_proximity`

Requires authoritative odor contributors plus olfactory access:

- exposed or permeable surface;
- distance/proximity;
- airflow;
- recent footwear removal where relevant;
- current products, sweat, residues, and cleanliness state.

Outputs carry intensity and provenance rather than value judgments. Hidden
contributors do not become perceptible merely because the scene is romantic.

### `foot.contact_temperature`

Contact temperature is permitted as a tactile result when physiology/body state
supplies current temperature bands and actual contact exists. This plan does not
build ambient thermal simulation. The narrator may receive a relative result
such as `target_cooler_than_source`, not invented exact temperatures.

## Strong first fixture

```text
bare foot
+ authoritative lotion on plantar surface
+ committed sole-to-inner-thigh contact
+ slow sliding path
+ moderate pressure
+ heel → arch → ball path
→ broad warm contact
→ smooth glide through the arch
→ rougher heel briefly catches at the path boundary
→ lotion transfer eligible, but not present until the event commits it
```

Narrator-facing projection:

```ts
{
  actionTruth: "Sabrina's bare sole is sliding along Daniel's inner thigh.",
  observations: [
    {
      id: "foot.contact_pressure",
      semanticTags: ["broad_contact", "moderate_pressure"],
      repeatKey: "foot:sole:inner_thigh:pressure:moderate:broad"
    },
    {
      id: "foot.glide_response",
      semanticTags: ["smooth_glide", "brief_rough_heel_catch"],
      repeatKey: "foot:heel_arch_ball:inner_thigh:glide:smooth_with_catch"
    }
  ],
  prohibitedInferences: [
    "Do not invent toe movement or an emotional reaction.",
    "Do not invent transfer until a committed event supplies it.",
    "Do not mention supportRole, coefficients, or implicit joint angles."
  ]
}
```

The narrator may realize one selected cue naturally. It should not explain that
the foot is free, no longer bearing weight, or rotated by a specific angle.

## Repetition and attention

A physical observation may remain valid for many turns while mention priority
falls to zero. `repeatKey` should include enough semantic state to distinguish a
meaningful change without encoding raw values:

```text
phenomenon
+ source surface
+ target surface
+ contact path/locus
+ semantic pressure or glide band
+ material-between band
```

Sustained identical contact keeps the same key. Mention priority may return when
one of these changes materially:

- pressure;
- motion or direction;
- contact area;
- surface locus/path;
- moisture/product state;
- material between surfaces;
- exposure or perception channel;
- a committed character reaction with current narrative importance.

The physical read remains available as authority even when no narrator cue is
selected.

## Narrator contract

The narrator receives:

- the committed action truth needed to avoid contradiction;
- at most one or two ranked tactile/visual/olfactory observations;
- current region and channel;
- semantic intensity bands and cause/event provenance when useful;
- repeat/change metadata.

It does not receive:

- support coefficients;
- range-of-motion values;
- rejected access alternatives;
- raw friction, moisture, or callus numbers;
- hidden surfaces;
- uncommitted transfer;
- inferred consent, arousal, preference, or reaction;
- permission to remove clothing or change posture.

## Proposed code organization

Keep the generic core narrow and the proving domain co-located:

```text
src/contracts/affordances/
  core/
    regional-contact.ts

  domains/
    foot-contact/
      attribute-maps/
        sole.ts
        toes.ts
        toenails.ts
        index.ts
      regions.ts
      profile.ts
      mechanics.ts
      access-adapter.ts
      frame.ts
      phenomena/
        contact-pressure.ts
        surface-texture-contact.ts
        glide-response.ts
        articulation-observation.ts
        nail-contact.ts
        pressure-mark-surface-state.ts
        surface-transfer.ts
        scent-proximity.ts
        contact-temperature.ts
        index.ts
      domain.ts
      fixtures.ts
      foot-contact.test.ts
```

The action/contact owner may live outside `affordances/` if it mutates pose or
contact state. The foot domain receives only its committed read through a lane
adapter. Chat and successor lanes must target the same lane-neutral contracts.

## Rollout slices

### Slice 0 — ownership and vocabulary audit

- Inventory current foot/toe/toenail attributes and coverage ids.
- Inventory chat and successor posture, support, contact, action, cut, and
  reaction seams.
- Identify authoritative wetness, sweat, temperature, residue, cleanliness,
  mark, and odor contributors.
- Record exact shoe/sock/hosiery state available before the clothing graph ships.
- Decide which inputs fail closed and which may use conservative degraded reads.

### Slice 1 — contact/action seam and access policy

- Add action-specific `FootAccessQuery` and deterministic result modes.
- Separate support role, mobility, and accessibility.
- Implement the implicit-adjustment policy and explicit-state-change boundary.
- Produce committed contact reads only after geometry, clothing, policy, and
  action validation succeed.
- Add diagnostics for clothing block, geometry block, support conflict,
  out-of-reach, and explicit-reposition-required.

### Slice 2 — foot region/profile contracts

- Add the semantic surface graph and parent inheritance.
- Compile stable foot/sole/toe/toenail attributes into regional profiles.
- Add region modifiers for heel, arch, ball, edges, dorsal surface,
  interdigital spaces, and nails.
- Add deterministic profile and monotonic/inheritance tests.

### Slice 3 — pressure and texture proof

- Implement `foot.contact_pressure` and `foot.surface_texture_contact`.
- Prove no-contact silence, material filtering, region differences, and
  perception-channel gating.
- Capture narrowed evidence and suppression diagnostics.

### Slice 4 — motion, glide, and contact temperature

- Implement sliding paths and `foot.glide_response`.
- Add lotion, sweat/water, dry-surface, sock, hosiery, and footwear fixtures.
- Prove a rougher heel can catch without making the whole sole uniformly rough.
- Add contact-temperature comparison from authoritative body-state bands.

### Slice 5 — footwear and aftermath

- Integrate the clothing-state graph when available.
- Prove toe motion can be physically valid but perception-hidden inside a shoe.
- Require explicit shoe/sock removal and closure changes.
- Read authoritative sock/strap/compression marks after removal; no affordance
  hysteresis.

### Slice 6 — transfer and scent channels

- Add transfer eligibility, committed residue events, and resulting surface
  observations.
- Add olfactory gating by exposure, permeability, distance, airflow, and
  contributor provenance.
- Prove absent sweat/product/residue produces no invented scent, taste, or
  slippery behavior.

### Slice 7 — narrator projection and romantic-chat evaluation

- Add the bounded cue block behind a feature flag in the romantic chat lane.
- Preserve committed contact truth while ranking at most one or two observations.
- Add repeat-key history and action/change relevance.
- Compare physical contradiction, clothing contradiction, repetition, sensory
  specificity, and narrator over-explanation against the current prompt path.
- Capture selected reads with the committed cut so retakes remain stable.

### Slice 8 — second-region reuse decision

- Reuse the minimal `RegionalContactFrame` for one non-foot case, likely hand or
  kissing contact.
- Extract shared pressure/friction/transfer helpers only where duplication is
  proven.
- Do not start intimate-region physiology or exposure work merely to validate
  the generic type.

## Required fixtures

- Seated character with one bare free foot resting in the player's lap.
- Seated character extending a foot without destabilizing support.
- Standing character attempting to lift the only weight-bearing foot.
- Free foot whose heel is reachable through a slight implicit ankle rotation.
- Foot trapped beneath another leg and requiring explicit repositioning.
- Bare heel reachable by hand but not by mouth from current geometry.
- Shoe and sock blocking direct skin access.
- Open-toed footwear exposing toes but not sole or heel.
- Toe movement inside a rigid shoe: physically possible, not observable.
- Toe movement transmitted through a flexible shoe during asserted hand contact.
- Arch versus heel tactile profile.
- Sole damp while top of foot is drier.
- Interdigital moisture retained after surrounding toe tops dry.
- Between-toe access blocked until the current articulation/contact permits it.
- Toenail trace at light pressure versus unsupported scratch narration.
- Lotion-assisted glide across arch with rougher heel catch.
- Sock seam/strap mark appearing only from authoritative mark state.
- Lotion/sweat/dirt transfer absent until a committed event updates residues.
- Scent unavailable through distance/coverage and available after a qualifying
  exposure/proximity change.
- Identical sustained contact producing no fresh narrator cue.
- Pressure, path, moisture, or reaction change restoring mention priority.
- Retake restoring pose, contact, residues, selected cue, and repeat history.

## Acceptance criteria

- Whole-body posture is never inferred from one foot's support role.
- Support role, mobility, and accessibility are separate deterministic reads.
- An action query is scoped to actor region, target surface, and action kind.
- Minimal implicit adjustments never remove clothing, expose a region, relocate
  an actor, force resistance, or invent a reaction.
- Shoes/socks/hosiery deterministically block or filter the correct surfaces.
- Internal toe movement does not become observable without an available channel.
- Parent surface inheritance is deterministic and region overrides remain local.
- No committed contact means no pressure, texture, glide, nail, or transfer cue.
- No current sliding motion means no glide response.
- No moisture/product input means no invented slippery result.
- Surface moisture can differ by region but never arises from an absent source.
- Transfer becomes narrative truth only after an authoritative event/state
  update.
- Pressure marks appear only from authoritative mark state and expire through
  their owner.
- Scent requires current contributors plus valid exposure, distance, and airflow.
- The narrator never receives raw mechanics, support jargon, hidden surfaces, or
  rejected alternatives.
- Physical truth remains stable while repeated unchanged cues are suppressed.
- Identical inputs and committed events produce identical reads, diagnostics,
  and captured retake results.
- Chat and successor adapters use one lane-neutral foot/contact core.

## Not in scope

- full rigid-body, collision, gait, balance, fluid, or cloth simulation;
- deciding character desire, consent, arousal, or emotional reactions;
- adult intimate-region physiology, exposure, or geometry phenomena;
- permanent authored foot smell/taste values;
- precise anatomical measurements or medical modeling;
- automatic removal or displacement of clothing;
- a universal action-capability system for the entire body;
- scene-image generation or a separate image-only contact model;
- narrator prose stored in registries or state.

## Open questions

- **OQ1 — vocabulary.** Which current foot/toe/toenail attributes can safely
  compile into mechanics, and which new orthogonal fields are required?
- **OQ2 — pose owner.** Which current chat/successor contract can authoritatively
  provide support contacts, foot mobility, articulation, and pair proximity?
- **OQ3 — contact owner.** Does committed contact become a transient cut read, a
  typed event, persisted pose state, or a combination?
- **OQ4 — implicit adjustment limit.** Which semantic adjustment bands are
  allowed before the resolver must ask for explicit repositioning?
- **OQ5 — regional moisture.** Can physiology supply per-foot-region wetness, or
  should the foot adapter distribute a coarse nonzero source through calibrated
  retention modifiers?
- **OQ6 — footwear depth.** What is the smallest shoe/sock graph that supports
  containment, open-toed exposure, heel slip, toe restriction, and pressure
  marks without modeling every construction detail?
- **OQ7 — generic frame location.** Should `RegionalContactFrame` live in
  affordance core immediately, or remain foot-local until the second-region
  proof?
- **OQ8 — transfer owner.** Which body/garment event lane owns residue removal,
  deposition, and rollback?
- **OQ9 — scent/taste policy.** What semantic vocabulary provides grounded
  sensory feedback without repetitive value judgments or permanent labels?
- **OQ10 — rollout dependency.** Should the first pressure/texture slice use a
  conservative degraded footwear read before the clothing-state graph ships, or
  wait for that prerequisite?
