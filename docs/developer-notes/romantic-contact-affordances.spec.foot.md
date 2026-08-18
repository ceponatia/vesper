# Romantic contact affordances — foot domain

Status: **built as a pure fixture-driven domain, production-unregistered;
reconciled 2026-08-18.** The domain lives under
`apps/web/src/contracts/affordances/domains/foot/` but remains deliberately
absent from the live affordance-domain registry. Its pure mechanics stay valid;
registration now waits on the complete truth/effect/perception path for each
phenomenon rather than on a contact-local cue pipeline.

Plan: [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)

Core: [romantic-contact-affordances.spec.contact-core.md](romantic-contact-affordances.spec.contact-core.md)

Effects/presentation: [romantic-contact-affordances.spec.effects.md](romantic-contact-affordances.spec.effects.md)

## Scope

This is the first proving domain for regional contact mechanics. It owns:

- foot semantic topology;
- stable regional profile compilation;
- pure foot-specific contact phenomena;
- calibrated fixture behavior.

It does not own:

- pose/support/contact commitment;
- footwear state;
- body wetness/product/residue/marks;
- permission;
- visual attention/memory;
- tactile/scent narrator selection;
- emotional or expressive reactions.

## Semantic topology

```text
foot
├── plantar_surface (authoring label: sole)
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

Side/digit identity stays in `BodyLocusRef`. Do not duplicate it in domain ids.

## Stable regional profile

```ts
interface FootSurfaceStructuralProfile extends RegionalStructuralProfile {
  domain: "foot";
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

Child profiles inherit sparse parent values and calibrated modifiers.

Examples:

- heel -> firmer/more callused/lower compliance than arch;
- arch -> softer/more compliant;
- ball -> higher pressure exposure;
- interdigital spaces -> higher retention/lower airflow when articulation closes
  them;
- dorsal skin remains distinct from plantar baseline;
- toenails use hard-surface structure.

These are mechanics inputs, not narrator adjectives.

## Current condition ownership

The domain may consume current condition but must not persist its own copy.

Current codebase status:

- **body-surface wetness exists** per body location and is a valid owner;
- wardrobe owns footwear/hosiery presentation/condition/coverage;
- general body residue/product inventory is still missing;
- body contact/pressure marks are still missing;
- generic body temperature/physiology inputs are not yet a complete owner for
  all planned phenomena.

Therefore:

- known wetness may be consumed where supplied;
- no source wetness must remain no wetness;
- unavailable != known dry;
- lotion/oil/residue cannot be inferred from wetness;
- pressure marks cannot be remembered inside this domain.

Regional distribution may map a known coarse source into subregions only under a
declared deterministic law that preserves zero/unknown.

## Support and articulation

The scene owner supplies support/mobility evidence. The foot domain interprets
it regionally; it does not move the body.

Conceptual read:

```ts
interface FootSupportRead {
  footId: FootId;
  supportRole: "weight_bearing" | "partial" | "free";
  mobility: "free" | "limited" | "fixed" | "trapped";
  supportSurfaceId?: EntitySurfaceId;
  evidence: readonly AffordanceEvidence[];
}
```

Actual toe curl/flex/spread/point/ankle rotation requires committed pose/action
state. Contact never creates an expressive movement merely because it is
physically possible.

The current chat scene model does not produce `trapped`; restraint/pinning stays
out of scope rather than defaulting it.

## Footwear integration

Wardrobe remains authoritative.

Semantic parts may include:

```text
sock / hosiery: cuff · leg_section · heel_section · sole_section · toe_section
shoe: upper · toe_box · tongue · closure · heel_counter · insole · outsole
```

Rules:

- covered surfaces block direct skin access according to current part coverage;
- flexible material may transmit pressure/shape while filtering texture;
- open-toed footwear may expose toes without exposing sole/heel;
- closure/displacement/removal is a wardrobe operation;
- rigid/tight footwear may restrict articulation only when current garment
  mechanics support it;
- mark/residue effects appear only after their state owner commits them.

## Phenomena and channels

Every phenomenon must produce a channel-tagged physical observation and/or an
effect proposal before it reaches any presentation owner.

### `foot.contact_pressure`

Requires committed contact. Emits pressure/area/path mechanics.

Primary channel: tactile.

A visible compression/deformation, if later supported, is a separate visual
observation.

### `foot.surface_texture_contact`

Requires tactile access and known profile/material/current state.

Possible semantic tags:

```text
soft_arch
firmer_ball
rougher_heel
smooth_dorsal_surface
ribbed_sock_filtered
stocking_filtered
moisture_softened
```

Channel: tactile. It must not enter visual state.

### `foot.glide_response`

Requires committed sliding motion plus known friction contributors.

Possible outputs:

```text
dragging
controlled_glide
smooth_glide
slippery
grip_breaks
rough_surface_catch
```

Water, sweat, oil/lotion, and wet fabric require separate calibrated curves.
No source can be invented merely to obtain a glide result.

Channel: tactile.

### `foot.articulation_observation`

Consumes committed pose/articulation and restrictions.

Possible current states:

```text
toes: relaxed | flexed | curled | pointed | spread
arch: neutral | extended
```

A visible articulation may route to visual state. A tactilely perceived movement
routes to the future nonvisual sensory owner. The same underlying pose may
produce separate channel observations.

### `foot.nail_contact`

Consumes actual nail contact, nail shape/condition, angle, pressure, motion.

A tactile nail-edge result is not a scratch. Scratch remains an effect proposal
until a body-state owner commits it.

### `foot.pressure_mark_surface_state`

**Not live until a body-mark owner exists.** The domain may retain pure fixtures
for the calculation, but it cannot persist or present a mark from domain memory.

Once an owner exists, the visual result routes through visual state.

### `foot.surface_transfer`

Calculates a proposed material transfer only when an actual source exists.

The source/target or intermediate garment mutation must commit atomically under
one idempotency key through the appropriate state owner.

No committed effect -> no residue/deposit observation.

### `foot.scent_proximity`

Requires real scent contributors plus exposure/permeability/distance/airflow.

Channel: olfactory. It is **fixture-only for presentation** until a shared
nonvisual sensory owner exists. It may not be passed through visual state.

### `foot.contact_temperature`

Requires tactile contact plus actual temperature reads for the relevant bodies/
materials/environment.

Channel: tactile. Missing temperature suppresses the result; ordinary body warmth
is not an implicit default.

## Visual-state integration

Visual facts only:

- committed pose/articulation where visible;
- owner-committed wetness/marks/residue;
- visible footwear condition/presentation;
- contact relation/motion through the shared visual-state contact adapters.

Visual state owns viewpoint/exposure/occlusion, visual salience, notice/mention
memory, repetition, and narrator/image selection.

This domain must not keep a second visual cue ranking or `last mentioned` state.

## Nonvisual presentation

Tactile and olfactory foot phenomena remain pure/diagnostic until the shared
sensory presentation owner exists.

That future owner must gate:

- observer participation/proximity;
- channel access/material transmission;
- novelty/change/relevance;
- repeat family/cooldown;
- bounded narrator selection;
- retake restoration.

Do not add a foot-specific sensory memory/cue block to bypass that prerequisite.

## First calibration fixture

```text
target:
  seated; one bare, free foot resting in player's lap
  lotion present on arch and ball, absent on heel
  arch softer/smoother than heel

action:
  player's palm slides from arch across heel
  light-to-moderate broad pressure

expected physical mechanics:
  contact committed without major reposition
  direct skin path
  softer/smoother arch result
  easier glide across the authoritative lotion region
  localized heel drag/catch
  no invented toe curl, sweat, scent, scratch, residue transfer, or pleasure
```

Because the current codebase lacks a general body product/residue owner, a live
version of this exact lotion fixture remains blocked unless the fixture supplies
an explicit pure state input. It must not be promoted by pretending body wetness
means lotion.

## Fixture matrix

- seated character with one bare free foot in player's lap;
- standing character attempting to lift the only weight-bearing foot;
- free heel reachable after slight ankle rotation;
- trapped/constraint case -> unresolved/explicit transition, never invented
  freedom;
- heel reachable by hand but not mouth from current geometry;
- shoe/sock blocking direct skin;
- open-toed footwear exposing toes only;
- rigid footwear hiding/restricting articulation only when supported;
- flexible material transmitting touch while filtering texture;
- arch versus heel tactile profile;
- known sole wetness with a drier dorsal region under declared distribution;
- unknown wetness never becoming dry/slippery;
- between-toe access blocked by articulation;
- nail trace versus uncommitted scratch;
- confirmed lubricant glide versus heel catch;
- pressure mark absent before owner commit;
- transfer absent before owner commit;
- scent suppressed by channel gates;
- held unchanged contact remaining physical truth without forcing a repeated cue.

## Required properties

- profile inheritance deterministic;
- increasing callus does not increase softness at same locus;
- each substance curve calibrated separately;
- zero/unknown source state preserved;
- no committed contact -> no contact mechanics;
- footwear filters exact surfaces, not whole-foot globally;
- missing temperature -> no temperature result;
- transfer idempotent/conserved when owner exists;
- rollback removes owner-committed mark/residue;
- tactile/olfactory observations cannot enter visual state;
- visual observations use visual-state attention/memory rather than local ranking;
- identical restored fixtures produce identical physical observations/effect
  proposals.

## Registration gate

Do not register the entire foot domain simply because its pure fixtures pass.
Register phenomenon-by-phenomenon only when each has:

1. live authoritative source reads;
2. committed contact/action path;
3. any required effect transaction;
4. correct sensory-channel routing;
5. observer/visibility rules owned outside the domain;
6. retry/retake coverage;
7. leak tests proving no unsupported state/reaction is invented.

Visual phenomena may become eligible earlier because visual state already owns
the visual consumer path. Tactile/scent phenomena wait for the nonvisual sensory
presentation owner.
