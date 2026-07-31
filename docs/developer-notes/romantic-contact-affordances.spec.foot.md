# Romantic contact affordances — foot domain

Status: technical companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
(promoted 2026-07-28 — the first proving domain, committed slices 0–4)

## Scope

This domain proves the
[shared contact core](romantic-contact-affordances.spec.contact-core.md) through
foot-focused romantic play. It owns foot surface topology, stable regional
profile compilation, foot-specific mechanics, and foot phenomenon vocabulary.
It does not own pose, contact commitment, footwear state, moisture production,
residue persistence, reactions, or narrator wording.

## Semantic surface topology

This is an interaction map, not a biomechanical mesh.

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

Side and digit identity are carried by `BodyLocusRef`, not duplicated in every
surface id. The ankle boundary is adjacent topology rather than a child of the
sole.

## Profile compilation

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

Child surfaces inherit a sparse parent profile and apply calibrated modifiers:

- heel increases firmness/callus and usually reduces compliance;
- arch reduces callus and usually increases softness/compliance;
- ball increases pressure exposure relative to the arch;
- interdigital spaces increase moisture retention and reduce airflow when
  current articulation closes the space;
- dorsal surface remains distinct from the plantar baseline;
- toenails use hard-surface structure rather than skin inheritance.

Character authoring should not require a complete profile per subregion.
Slice 0 must audit the current `feet.*` registry and record any orthogonal
fields actually needed. No new field is added merely to encode a derived
heel/arch difference.

## Current condition

```ts
interface FootSurfaceConditionRead extends SurfaceConditionRead {
  surfaceId: FootSurfaceId;
  moisture?: UnitInterval;
  moistureContributors: readonly SurfaceSubstanceRead[];
  temperatureBand?: ContactTemperatureBand;
  cleanlinessBand?: CleanlinessBand;
  residues: readonly SurfaceResidueRead[];
  pressureMarks: readonly BodySurfaceMarkRead[];
  coveredDuration?: StoryDuration;
}
```

Body/physiology state supplies sweat, wetness, and temperature. Product,
environment, and contact events supply residues. The foot adapter may
distribute a nonzero coarse foot condition across regions using retention and
airflow modifiers, but it must preserve zero:

```text
no source wetness → no regional wetness
no residue event → no residue
no mark event → no mark
```

Known dry (`moisture = 0`) and unknown (`moisture = undefined`) are different.
Unknown suppresses moisture-, scent-, and temperature-dependent claims whose
other contributors cannot establish the result. It must not be rendered as
dry, clean, cool, odorless, or high-friction.

Regional distribution permits:

- sole damp while exposed dorsal skin has dried;
- interdigital spaces retaining moisture longer than toe tops;
- lotion on the arch but absent between toes;
- dirt or grass only on contacted surfaces;
- a strap line appearing only while an authoritative mark remains.

## Support and articulation

```ts
interface FootSupportRead {
  footId: FootId;
  supportRole: "weight_bearing" | "partial" | "free";
  mobility: "free" | "limited" | "fixed" | "trapped";
  supportSurfaceId?: EntitySurfaceId;
  evidence: readonly AffordanceEvidence[];
}
```

Support role does not determine whole-body posture. A seated character may
brace both feet; a lying character may press a foot against a wall; a standing
character may have one free foot.

Articulation capacity is stable/current mechanics. Actual toe curl, flex,
spread, point, or ankle rotation is committed pose state. Touch never causes an
expressive movement unless a behavior/reaction owner chooses and commits it.

## Footwear integration

Wardrobe supplies sparse semantic parts:

```text
sock / hosiery: cuff · leg_section · heel_section · sole_section · toe_section
shoe: upper · toe_box · tongue · closure · heel_counter · insole · outsole
```

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

Invariants:

- socks, hosiery, and shoes block direct skin contact where their current parts
  cover the requested surface;
- flexible fabric may transmit touch while filtering texture;
- open-toed footwear may expose toe surfaces but not the sole or heel;
- a loose shoe may permit heel slip while containing the toes;
- tight/rigid footwear may restrict articulation and hide deformation;
- shoe/sock removal and closure changes are committed wardrobe actions;
- pressure marks are body-state reads after an owner event, not footwear
  affordance memory.

## Phenomena

### `foot.contact_pressure`

Consumes committed contact pressure/area, surface geometry, support, and
motion.

Outputs:

- contact locus or path;
- `trace | light | moderate | firm`;
- `point | narrow | broad`;
- semantic distribution when a path crosses heel, arch, ball, edges, or toes.

It does not create redness or a pressure mark.

### `foot.surface_texture_contact`

Requires a tactile channel. Combines regional profile, current condition, and
material transmission.

Example tags:

- `soft_arch`;
- `firmer_ball`;
- `rougher_heel`;
- `smooth_dorsal_surface`;
- `ribbed_sock_filtered`;
- `stocking_filtered`;
- `moisture_softened`.

Tags remain relative and semantic; the narrator never sees coefficients.

### `foot.glide_response`

Requires current sliding motion. Inputs include local friction/compliance,
authoritative lotion/oil/sweat/water/residue, material between, pressure, area,
and the current path.

Outputs:

- `dragging`;
- `controlled_glide`;
- `smooth_glide`;
- `slippery`;
- `grip_breaks`;
- `rough_surface_catch` only when the path reaches a qualifying surface.

An absent moisture/product source cannot produce `slippery`. Unknown surface
state suppresses the moisture-dependent result.

Friction response is substance-specific. Oil/lotion, water, sweat, and a wet
garment each use an explicit calibrated curve; the domain must not apply a
global “more wetness means less friction” rule. In particular, small amounts of
water or sweat may increase skin drag before a thicker film reduces it.

### `foot.articulation_observation`

Consumes committed pose state and restriction:

- toes `relaxed | flexed | curled | pointed | spread`;
- arch `neutral | extended`;
- movement restriction from support, footwear, contact, or obstruction.

It never assigns emotional meaning.

### `foot.nail_contact`

Consumes actual nail contact, nail length/shape/condition, angle, pressure, and
motion.

It may emit `light_nail_trace` or `firm_nail_edge`. A scratch is only a proposed
effect until the body-state owner commits it.

### `foot.pressure_mark_surface_state`

Reads existing marks such as sock ribbing, strap lines, or shoe compression
after the covering changes. It carries mark provenance and owner expiry; the
affordance domain has no hidden aftermark timer.

### `foot.surface_transfer`

Calculates transfer eligibility from contact, motion, pressure, permeability,
and source residue. It proposes an effect with source amount and target locus.
Only a committed effect event makes the resulting residue observable.

The effect follows the shared conservation law: source removal and target (or
intermediate garment) deposition commit atomically under one idempotency key.

### `foot.scent_proximity`

Requires current contributors plus olfactory access:

- authored baseline scent where applicable;
- current sweat/cleanliness;
- products/residues;
- exposure/permeability;
- distance and airflow.

Scent is a current perception result, not a permanent moral or hygiene label.

### `foot.contact_temperature`

Requires tactile contact and body/environment temperature reads. It emits only
a relative band (`cooler | similar | warmer`) and confidence. It is not the
passive visual thermal phenomenon excluded from body-attribute affordances.
If either necessary temperature read is unavailable, the phenomenon is silent;
ordinary body warmth is not an implicit default.

## First calibration fixture

```text
target:
  seated; one bare, free foot resting in player's lap
  lotion present on arch and ball, absent on heel
  arch softer/smoother than heel

action:
  player's palm slides from arch across heel
  light-to-moderate broad pressure

expected:
  contact committed without major reposition
  direct skin path
  soft/smooth arch observation
  easy glide while path crosses lotion
  localized heel drag/catch
  no invented toe curl, sweat, scent, scratch, residue transfer, or pleasure
```

The first fixture should be evaluated as pure mechanics, then with cue ranking,
then in romantic chat.

## Required fixture matrix

- seated character with one bare free foot in the player's lap;
- standing character attempting to lift the only weight-bearing foot;
- free heel reachable after slight ankle rotation;
- trapped foot requiring explicit reposition;
- heel reachable by hand but not mouth from current geometry;
- shoe and sock blocking direct skin access;
- open-toed footwear exposing toes but not sole/heel;
- toe movement physically possible but hidden in rigid footwear;
- toe movement transmitted through flexible fabric during touch;
- arch versus heel tactile profile;
- sole damp while dorsal surface is drier;
- interdigital moisture retained after toe tops dry;
- between-toe access blocked by current articulation;
- nail trace versus uncommitted scratch;
- lotion-assisted glide with localized heel catch;
- pressure mark absent before owner event and visible after removal;
- transfer absent before commit and present afterward;
- scent suppressed by coverage/distance and allowed after qualifying change;
- held contact suppressed until pressure, path, material, or motion changes.

## Test properties

- parent inheritance and regional overrides are deterministic;
- increasing callus does not increase softness at the same locus;
- within a single calibrated lubricant curve, increasing a confirmed
  lubricating film does not increase drag before a declared saturation/
  transition point; water, sweat, oil, and lotion are tested separately;
- zero source moisture remains zero across regional distribution;
- unknown moisture never becomes a known-dry or slippery observation;
- no committed contact yields no pressure, texture, glide, nail, or transfer
  observation;
- footwear filters the correct surfaces rather than the whole foot;
- state owner rollback removes the corresponding mark/residue read;
- a retried transfer cannot duplicate residue and always conserves the
  committed amount;
- missing temperature suppresses contact-temperature output;
- identical fixtures produce identical observations, evidence, and repeat keys.

Open questions are centralized in the
[plain-English plan](romantic-contact-affordances.plan.md#open-questions).

## As built — slice 2

Shipped in `src/contracts/affordances/domains/foot/` — a third affordance
domain beside `hair` and `garment`, built on the slice-1 contact core. **Pure
contracts only: no lane wiring, no storage, no schema change, no migration, and
no change under `src/server` or `src/app`.**

The three blockers the [audit](romantic-contact-affordances.audit.md#what-slice-1-therefore-builds-and-what-it-must-not)
handed this slice are honoured rather than worked around: every fixture supplies
its geometry explicitly, `foot.surface_texture_contact` requires a tactile
channel no lane asserts (so it is fixture-only), and `foot.glide_response` has
no production surface-state source. Contact temperature is **not built** — no
temperature owner exists in either lane.

### File map

| File | Responsibility |
| --- | --- |
| `topology.ts` | The 16 surface ids and the tree. Each node carries its exact `bodyLocationId`; the wardrobe-slot `coverageLocationId` an observation reports is DERIVED from it at module load by walking the registry to the nearest `coverageRelevant` ancestor. `FootLocusRef` (surface + side + digit); detail-token resolution. Also the domain's own side vocabulary — `footSides` / `footSideSchema` (`left \| right`) and `footSideOf`, the one narrowing from the contact core's wider list. |
| `attribute-maps.ts` | Three axes — `feet.arch` → `archGroundContact`, `feet.nails` → `nailEdgeProminence`/`nailSurfaceSmoothness`, `feet.toes` → `interdigitalDepth`. |
| `profile.ts` | `FootSurfaceStructuralProfile`; four seeds + sparse child modifiers; each axis applied at exactly ONE surface, with descendants inheriting the result; `footTextureBandOf`. |
| `condition.ts` | `FootSurfaceConditionRead`, the per-side coarse read and its dry-versus-wetting refinement, the `footConditionSetSchema` one-answer-per-foot rule, `distributeFootCondition`, `footRetentionWeight`, `footConditionForSide`, `unknownFootCondition`, `footSubstanceIsWetting`. |
| `friction.ts` | Five calibrated per-substance curves, `footFrictionMultiplier`, `dominantFootSubstance`, `footEffectiveFriction`, `footGlideResponseOf`. |
| `footwear.ts` | Sock/shoe part vocabulary → contained surfaces; `compileFootwearContact` → `ContactMaterialLayerRead`s; duplicate-`layerId` canonicalization + `FootwearAnomalyRead`; the six invariants as reads. |
| `support.ts` | Per-foot `FootSupportRead` / `FootArticulationRead` and their one-entry-per-side set schemas, `footMovementRestrictionOf`, `selectFootArticulation`, `footInterdigitalClosure`, and `footPoseClosureAt` — the domain's single rule for what a committed pose does to the toe spaces at one locus. |
| `mechanics.ts` | Per-FOOT blocks of per-surface effective compliance/friction/texture; `effectiveFriction` is absent exactly when moisture is. |
| `frame.ts` | `FootContactRead` — the projection of a slice-1 `CommittedContactRead` onto this subject's foot — plus state/context/frame. |
| `phenomena/` | `bands.ts` (suppression codes, repeat keys) + five phenomena. |
| `domain.ts` | `readInputs` (six adapter-law inputs), `footAffordanceDomain`. **Not registered in `domains.ts`.** |
| `fixtures.ts` | The calibration fixture and nine further cases (eight of which commit a contact through the real slice-1 gate; `rigidBootHiddenToes` and `noCommittedContact` deliberately supply none). **Not in the barrel.** |
| `*.test.ts` | 8 files / 206 cases: topology, profile, condition, friction, footwear, support, phenomena, end-to-end. |

### Registry additions

`src/contracts/body/locations/everyday.ts` gains the three loci the audit named,
all `coverageRelevant: false` — contact loci, not garment slots, exactly as the
intimate subtree is modelled:

| Id | Parent | Why not a wardrobe slot |
| --- | --- | --- |
| `foot_arch` | `sole` | No footwear covers an arch without covering the sole. |
| `ball_of_foot` | `sole` | Same, and a coverage editor carving the ball out would produce a hole that cannot exist. |
| `toenails` | `toes` | Nail polish is not a garment. |

They ride `expand`, so `expandCoverage(["sole"])` — the exploded set every
coverage consumer tests membership against — contains the arch and the ball. The
two garment READS deliberately never see them: `resolveWardrobeVisibility`
skips `coverageRelevant: false` ids outright, and `exposedRegions` classifies the
foot from its own `EXPOSURE_REGION_LOCATIONS.feet` list, which names only the
four slots. That is the intended split — the new ids exist for contact, not for
deciding whether a foot reads bare — and it is why `garment-coverage.ts`,
`visibility.ts`, `garment-blueprint-validation.ts`, and `items/coverage.ts`
needed no change and no stored coverage set, effective-coverage read, or
blueprint moved.

The compound ids are deliberate: bare `arch` and `ball` would enter
`species/targets.ts`'s free-text body-target phrase index and match "the stone
arch" or "threw the ball" in ordinary prose.

### Key entry points

Not the complete export surface — the barrel re-exports every module below, and
the tuned constants, walkers, and band helpers are exported alongside these. The
functions a caller actually starts from:

`compileFootProfile` · `distributeFootCondition` / `unknownFootCondition` ·
`footEffectiveFriction` / `footGlideResponseOf` · `compileFootwearContact` and
its `footwear*` reads · `footMovementRestrictionOf` / `selectFootArticulation` ·
`deriveFootMechanics` · `footContactFromCommitted` / `buildFootFrame` ·
`footPhenomena` and the five phenomenon ids · `footDomainDefinition` /
`footAffordanceDomain` / `FOOT_DOMAIN_ID`.

`fixtures.ts` (`footWorkedCases`, `readFootAffordances`, `committedFootContact`)
is **not** exported from the barrel — the contact core's `test-support.ts`
precedent, for the same reason: its builders throw and carry defaults nobody
chose. Tests import the module directly.

### Deltas from the draft above — this section is the authority

| Draft | As built | Why |
| --- | --- | --- |
| `FootSurfaceConditionRead` carries `temperatureBand` | Removed | No temperature owner exists in either lane. Garment's rule applies: an input no phenomenon reads is an invitation to read it, and a channel that cannot be filled is a channel that gets guessed. |
| …carries `pressureMarks` and `coveredDuration` | Removed | Their only consumer is `foot.pressure_mark_surface_state`, which is slice 4. The vocabulary having no mark member is what makes inventing one impossible. |
| `FootSupportRead` declares its own `supportRole` / `mobility` enums | Reuses the contact core's `ContactSupportRole` / `ContactSupportMobility` | Slice 1 lifted them **from this spec** on the grounds that they were already the general answer. Re-declaring them here would create the second definition that move existed to prevent. |
| `FootwearContactRead.coveringLayers: GarmentLayerRead[]` | `ContactMaterialLayerRead[]` | Slice-1 as-built naming; and the core deals in layers, not garments. |
| `FootwearContactRead` has no filter register | Adds `surfacesByLayer` and `filterTagByLayer` | `ribbed_sock_filtered` needs to know which layer is outermost **over one surface**. Without a per-layer surface map the tag would describe the stack rather than the place. |
| A phenomenon reads a per-surface condition | Phenomena read `mechanics` only; the distribution happens in `deriveMechanics` | Retention and airflow are profile terms, and the staged pipeline hands the profile to exactly one stage. Two copies of "how wet is the arch" would eventually disagree. |
| `foot.contact_pressure` emits a band unconditionally | Absent committed pressure ⇒ **silence** | Slice 1 made `pressure` optional precisely so a contact nobody measured is not a `trace` press. An absent *area* only drops its tag; "how hard" is answerable without "how much of". |
| Texture example tag `rougher_heel` | `rougher_heel_pad` | One rule — `<comparative>_<surfaceId>` — instead of a per-surface alias table. `smooth_dorsal_surface`, `soft_arch`, and `firmer_ball` match the draft verbatim. |
| `foot.articulation_observation` sits with the contact-gated phenomena | Requires committed **pose**; contact is an optional input | A pose is true whether or not anyone is touching (a toe movement inside a rigid boot is real in an empty room), and the draft's own test-property list excludes articulation from "no committed contact yields no … observation". Contact rides along only as a possible *restriction*. |
| `foot.glide_response` "requires current sliding motion" | Also requires a **known** moisture at every locus on the path | Unknown is not dry. A path with one unreadable surface suppresses rather than reporting the dry number for it. |
| — | Glide reports ONE locus, chosen in two steps: a qualifying CATCH anywhere on the path wins; otherwise the grippiest locus does | Choosing the grippiest locus first and only then asking whether it catches loses a real heel snag the moment something else out-frictions it — grit on an arch beats a callused heel and the snag vanishes. Ties break on path order in both steps, so the pick is deterministic. |
| — | `slippery` is gated on the film REDUCING friction, not on a film being present | Presence alone let a tack-phase film — which raises drag — unlock the slipperiest bands: a dry pedicured toenail read `smooth_glide` and the same nail under a draggier film of water read `grip_breaks`. The gate is now a floor on the friction rather than a relabel of the band, so the mapping is monotone: more friction is never a slipperier answer. |
| — | Texture will not make a bare-skin claim at a locus the wardrobe says is covered | The contact's `directSkinContact` is lane-authored, and consulting it alone meant footwear could not stop a bare-skin read at all: a contact asserting direct skin through a sock reported the bare intensity band. Two owners must agree, and the conservative half wins. |
| — | Observations report the nearest **coverage-relevant** locus (`sole`, `heel`, `toes`, …), never the new non-slot ids | Perception exposure is built from coverage; an observation keyed to a non-slot locus reads `unknown` and fails closed for every observer. The fine surface id rides the tags and the repeat key. |
| — | `softness = baseSoftness × (1 − callus)` | Makes "increasing callus never increases softness" structural rather than a property of the numbers. |
| — | Five substance curves are three-point piecewise-linear with a **declared** `tackPeakAt` / `saturationAt` | The spec demands per-substance calibration and a declared transition point. Water, sweat, and a wet garment rise above ×1 before falling; oil declares `tackPeakAt: 0` and never rises. Integer floor interpolation keeps the falling limb monotone on the integers, not merely on the reals. |
| — | Several contributors resolve by **largest deviation from dry**, never by product | Multiplying two films would reintroduce the global "wetter is slipperier" rule these curves exist to refuse. |
| — | `foot.nail_contact` is included, with two bands and no magnitude | It was cheap once `feet.nails` was already an axis. It has no vocabulary a scratch could hide in. |
| — | `feet.size` and `feet.smell` are **not** axes | `feet.size` maps to nothing this domain calculates (contact area belongs to the contact, not the foot); `feet.smell` is a permanent authored label, which is what the plan forbids scent from being. |
| `FootSurfaceStructuralProfile extends RegionalStructuralProfile` with a `domain: "foot"` tag | A standalone interface; no base type, no tag | `RegionalStructuralProfile` was never built — no shared regional base exists anywhere in `affordances/core`, and inventing one for a single client is the duplication the architecture spec forbids. The `domain` tag is redundant: a profile only ever reaches its own domain's stages. Five fields were ADDED — `bodyLocationId`, `coverageLocationId`, `structureKind`, `pressureExposure`, `nailEdgeProminence` — because the registry pointers, the keratin exception, the ball-versus-arch rule, and the nail phenomenon each need a term the draft did not name. |
| `FootSupportRead { footId, evidence }` | `{ side, supportRole, mobility, supportSurfaceId?, evidence }`, and `FootArticulationRead` gains `side` too | `footId` had no producer and no id space. `side` reuses the contact core's `ContactSurfaceSide`, which contact reads already carry, so a support read and the locus it is about are keyed the same way. Without it "left trapped, right free" was unrepresentable and one subject-wide pose read could describe the foot nobody was touching. Both arrive as LISTS on the frame; `selectFootArticulation` picks the one an observation is about. |
| `FootwearContactRead.closureState: GarmentClosureRead` | A local `footwearClosureStates` enum with an `unknown` member, plus an `evidence` field on the read | There is no `GarmentClosureRead` in the wardrobe to reuse — `garment-instance.ts` models closures as per-part fastener state, which is a finer thing than "is this shoe done up". The local enum is the coarse answer this domain needs. `unknown` is a first-class member because a heel slip is a positive claim and an unreadable closure must not be called loose. `evidence` matches every other read in the layer. |
| `FootSurfaceConditionRead` field names | `moistureContributors: FootSurfaceSubstanceRead[]`, `residues: FootSurfaceResidueRead[]` | The draft's `SurfaceSubstanceRead` / `SurfaceResidueRead` / `BodySurfaceMarkRead` / `CleanlinessBand` are unprefixed generic nouns that would go through `export *` in `affordances/index.ts`. Slice 1 prefixed its own for the same reason; a bare `SurfaceResidueRead` in a shared barrel is a collision waiting for the intimate domain. |
| — | The coarse condition read REFUSES a stated `moisture: 0` carrying water, sweat, or a wet garment | The two channels could tell different stories: `{ moisture: 0, contributors: [oil] }` gave texture a dry surface and glide a `slippery` one. Wetting kinds now fail the schema (⇒ `invalid`, ⇒ suppression), and product kinds — which legitimately sit on dry skin — raise the regional `moisture` to the film they represent, so both channels read the same surface. |
| — | The interdigital spaces respond to CURRENT articulation | The spec makes retention/airflow move *"when current articulation closes the space"*, which cannot live beside stable `feet.toes`. `footRetentionWeight` takes a closure of `-1/0/+1` derived from the committed toe pose, and texture suppresses outright at `interdigital_spaces` when the pose has the toes pressed together (fixture-matrix row 13). Since the hardening pass each foot uses ITS OWN pose (see the per-side row below); only a locus that names no side still needs the two feet to agree. |
| — | Shared: `readAdapterInput` moved into `affordances/core` | Hair and garment already carried byte-identical copies of the adapter-law narrowing; a third would have been a copy-paste of a law. Domain-neutral, so the core's neutrality test is unaffected. |
| `foot.articulation_observation` emits the pose whatever is worn | **(hardening, 2026-07-30)** The pose-DETAIL tags (`toes_*`, `arch_*`) are gated per surface on `footwearHidesDeformation`; a dropped detail is marked with `pose_hidden_by_footwear`; the `restricted_by_*` tag always stays | `footwearHidesDeformation` had no phenomenon consumer, and the core perception filter is sight-only over an observation's `sourceLocationId` — so a visible booted foot leaked the toe position the boot physically hides. Gating the two detail tags rather than suppressing the observation is the smallest honest fix: what a boot hides is the movement, not the boot. The gate is per surface (`toes` for the toe pose, `arch` for the arch pose), so a rigid shoe with an open toe box keeps the toes and drops the arch, and the marker tag keeps "nothing to see" distinguishable from "cannot be seen". Deformation transmission answers for touch as well as sight, so the rule survives slice 3's per-observation channel filter unchanged. |
| The coarse condition read is subject-wide | **(hardening, 2026-07-30)** `FootCoarseConditionRead` carries an optional `side`; the payload is a SET (`footConditionSetSchema`, at most one entry per foot plus one side-less entry); `FootEffectiveMechanics` became per-foot blocks (`feet: FootSideEffectiveMechanics[]`) and `footSurfaceMechanics(mechanics, surfaceId, side?)` looks up by side | Support, articulation, and every contact read were already per side; the condition read was the one that was not, so a soaked left sole beside a dry right one was unrepresentable. A repeated side FAILS the schema (⇒ `invalid` ⇒ suppression) rather than being merged: two answers for one foot is the same contradiction the dry-while-wet refinement already refuses. A foot the owner never mentioned reads UNKNOWN — the lookup falls back to the side-less block, never to the other foot. The side-less block always exists, so an unsided locus stays readable. |
| The interdigital closure needs both feet to agree | **(hardening, 2026-07-30)** Per-side blocks use their own foot's closure; only the side-less block keeps an agreement rule (renamed `undistinguishedInterdigitalClosure`), and that rule requires **two DISTINCT feet supplied and agreeing** — zero poses, one pose, and disagreement are all the structural-neutral `0` | With per-side conditions the agreement rule stopped being a workaround for a missing model and became the answer to a narrower question. A block is built for every foot the lane named in EITHER the condition set or the pose set, so a curled left foot and a spread right one under one shared condition now read differently between the toes. For a locus that names no side there is still no foot to pick. The **one-pose case was a residual defect the owner caught the same day**: the first cut treated a single supplied foot as vacuous "agreement", but one left foot says nothing whatever about the right one and an unsided locus may well BE the right one — spending the left foot's curl on it was picking a foot in disguise. Two agreeing feet survive because the answer is then the same whichever foot the locus turns out to be: a deduction, not a guess. |
| The support and articulation payload arrays say "one entry per foot" in prose | **(hardening, 2026-07-30)** `footSupportSetSchema` / `footArticulationSetSchema` (`support.ts`) enforce it — at most one entry per side, capped at the side count (`footSides.length` since the 2026-07-31 row below); `domain.ts` parses through them | Both sets are keyed by side, so two entries for one foot are two owners telling different stories about one thing: "the left foot is trapped" beside "the left foot is free" has no correct resolution, and neither does a foot that is both curled and spread. The arrays permitted it, so whichever consumer looked first (`footReadForSide` takes the first match) silently won. A repeated side now fails the schema ⇒ `invalid` ⇒ the read carries no value at all, which is the same law the condition set already follows and the same reason: repairing a contradiction means choosing which half to believe. `articulation` is a REQUIRED dependency, so an invalid pose set suppresses `foot.articulation_observation` with `affordance.input.invalid` and the core's standard diagnostic; `support` is optional, which at the time meant nothing was suppressed over it — since the pre-slice-3 core law change (see the optional-invalid row below) an invalid support set suppresses the dependent phenomenon too, so the contradiction can neither become a `restricted_by_support` nobody asserted nor an `unrestricted` nobody asserted. |
| `compileFootwearContact` unions duplicate `layerId` rows silently | **(hardening, 2026-07-30)** Duplicates are canonicalized into ONE item by a stated rule per field, and the repair is reported as a `FootwearAnomalyRead` on the read, which `deriveMechanics` files as a `foot.footwear.anomaly` `warn` | A silent union let the compile decide by arrival order — an adapter returning the same cut twice in a different order produced two different filter registers — while dropping the read would make a shod foot read bare, the one direction this layer must never fail in. Rules: restrictive terms (`compression`, `rigidity`, `ankleRestriction`) and `effectiveFriction` take the max; `toeBoxVolume`, `permeability`, `tactileTransmission`, `shapeTransmission` take the min; `parts` union so no surface loses its cover; `visibleThrough` ANDs; `closureState` reuses `aggregateClosure`; `order` takes the innermost and `kind` the most enclosing; and `filterTag` survives only if every row agrees, collapsing to `unknown` otherwise — two answers to "what does a toucher meet here" is not evidence for either. The anomaly rides the READ rather than a sink because the compile runs inside `readInputs`, which by the adapter result law returns a value and not a log; `deriveMechanics` is the next stage that owns a `diagnostics` array, the same channel a provisional axis uses. |
| A blank axis suppresses the whole foot domain ("compile every surface, or none at all") | **(pre-slice-3, 2026-07-30)** `compileFootProfile` compiles the surfaces it CAN establish and omits only each missing axis's own: no `feet.arch` ⇒ the arch subtree (`arch`, `medial_arch`, `lateral_arch`); no `feet.nails` ⇒ the toenail; no `feet.toes` ⇒ the interdigital spaces. Heel, ball, sole, edges, dorsal, toe tops/pads, and the ankle are seed-and-modifier structure and always compile. A read at an omitted surface suppresses downstream with `surface_unprofiled`; `foot.contact_pressure` consults no `feet.*` attribute and reads on any committed pressure | The all-or-nothing gate made a single unauthored field silence facts the profile could establish — a known contact pressure vanished because toenail upkeep was blank. Suppression now has exactly the width of the gap. Invalid stays invalid (`affordance.input.invalid` for authored-but-unmapped vocabulary, `unavailable` for unset), and the compiler NEVER substitutes a registry default — baselines are materialized into stored profiles at grounding time (`materializeDefault`, docs/contracts/attributes.md), never at read time. |
| — | **(pre-slice-3, 2026-07-30, core)** The phenomenon dependency law: required ⇒ must be `supported`; optional + `unavailable` ⇒ the resolver runs; optional + `invalid` ⇒ suppressed with `affordance.input.invalid` and the standard diagnostic (`unmetDependencies`, `affordances/core/registry.ts`) | Optional used to mean "ignored entirely", which laundered corruption into absence: an unparseable "trapped" support let articulation read unrestricted, an invalid wind read as still air for hair's wind-motion. Absence degrades by design; a corrupt ANSWER being treated as no answer is the confusion the adapter result law exists to prevent. Audited across hair (`wind`, `motion`, `contamination`, `events`), garment (no optional dependencies), and foot (`condition`, `footwear`, `articulation`, `support`, `contact`). |
| The four foot fields are authored or absent | **(pre-slice-3, 2026-07-30, registry)** `feet.size`, `feet.arch`, `feet.nails`, `feet.toes` carry `defaultValue` + `materializeDefault`: every stored body (characters AND personas; blank, forged, imported, cloned, PATCHed) grounds the missing ones as `source: "creation"` rows with sourceId `registry-default:feet:v1`; `scripts/backfill-registry-defaults.ts` fills existing rows. `feet.smell` is deliberately NOT flagged | Slice 3's reads should not hinge on an author having thought about feet, but a default must stay a stored, editable, overridable FACT — not a compiler fallback ("invalid values remain invalid") and never a manufactured moisture, scent, product, residue, or contact. Registry detail: docs/contracts/attributes.md §materializeDefault. |
| The unsided two-feet rule is private to `mechanics.ts` | **(owner review, 2026-07-31)** It moved to `support.ts` as `footPoseClosureAt(articulations, side)` — the ONE rule every consumer asks: a sided locus uses its own foot, an unsided locus (absent side, or the core's `center`, which names no foot) uses a modifier only when TWO DISTINCT FEET AGREE, everything else is the structural-neutral `0`. Both mechanics blocks and `foot.surface_texture_contact` now go through it, and it also returns the deciding toe pose — only when every deciding foot names the same one | The mechanics half was corrected on 2026-07-30 (row above); the texture resolver, which could not reach a private helper, kept its own `footReadForSide(…) ?? articulations[0]` fallback. That is the same inference wearing a different coat: one curled LEFT foot suppressed the between-toes observation for a space that names no side and may well be the right foot's. A rule with two implementations has two answers, so the fix is one exported rule rather than a second copy of the corrected logic. The pose detail is dropped when two agreeing feet close the spaces through different poses (`curled` and `flexed` both close), because naming one would describe a foot that may not be the one being touched. |
| The three foot-owned participant reads key `side` to the contact core's `ContactSurfaceSide` | **(owner review, 2026-07-31)** Support, articulation, and condition use the foot-local `footSideSchema` (`left \| right`) instead. Absent still means undistinguished; a `center` side — or any unrecognized one — FAILS the schema, so the whole payload degrades `invalid` at the trust boundary and every dependent phenomenon is suppressed with `affordance.input.invalid` plus the standard diagnostic. `FootLocusRef.side` deliberately keeps the SHARED vocabulary (it is a projection of a committed contact), and `footSideOf` is the single narrowing: a `center` locus lands on the undistinguished block, exactly where an absent side does | The shared list carries `center` because a back, a chest, and a mouth have middles. A foot does not, so a "center foot" is not a coarser answer but a wrong one — and it was reachable: three payloads could describe one, `deriveFootMechanics` would have built it a third block, and the two-distinct-feet agreement rule counted DISTINCT SIDES, so a `center` entry beside a `left` one could have passed for two feet and moved an unsided locus. Failing the schema is the same law the repeated-side and dry-while-wet contradictions already follow: nobody meant it, and repairing it means choosing what to believe. The agreement rule is now additionally walked over `footSides` itself, so it can only ever count a left and a right. |

### Domain registration: deferred to slice 3, deliberately

`footAffordanceDomain` is built and exported but is **absent from
`affordances/domains.ts`**. Registration would be inert today — the only
production caller (`server/engine/chat-affordances.ts`) passes an explicit
domain list and never uses the default tuple — but that tuple is the declared
LIVE set, and every foot phenomenon requires a committed contact from a
lifecycle neither lane owns. A row there would be a promise this build cannot
keep, and any future caller relying on the default would get an
`affordance.input.unavailable` warning per read for a decision nobody made
(the exact failure `chat-affordances.ts` documents). `foot.test.ts` pins the
absence, the reason, and the proof that adding the row later is safe: an unfed
lane yields zero observations, zero constraints, zero cues, and one `warn`.

### Not built, and where it went

- **`foot.contact_temperature`** — **deferred, no owner.** There is no
  temperature STATE owner in either lane: the only non-sampling `temperature` in
  `src/` is prompt prose telling the narrator that touch conveys it
  (`server/engine/prompts/character-chat.ts:1353`), which is an instruction, not
  a read. The audit resolves the plan's "can contact warmth join the foot
  milestone?" as **no** on today's evidence.
- **`foot.scent_proximity`** — **deferred.** It needs current cleanliness,
  current sweat, and an olfactory access channel; none exists, and `feet.smell`
  is an authored starting label, not a current perception result.
- **`foot.pressure_mark_surface_state`** and **`foot.surface_transfer`** —
  **slice 4** (the [effects companion](romantic-contact-affordances.spec.effects.md)).
  Nothing here creates, persists, or transfers a residue or a mark; the
  condition read can carry residues an owner placed and has no mark channel at
  all.
- **Narrator/guidance wiring, `CHAT_PHYSICAL_CONSTRAINTS`, the chat pipeline,
  and the lane adapter** — **slice 3**, together with domain registration.
- **Storage, schema, migrations, successor adapters** — unchanged from slice 1's
  position. The storage home was ruled 2026-07-30 (durable event provenance +
  a versioned active-contact projection in the chat's retake snapshot — see the
  [contact-core spec](romantic-contact-affordances.spec.contact-core.md#as-built--slice-1));
  slice 3 implements it.
- **A tactile perception channel in the shared core.** `filterAffordanceObservations`
  gates every observation on `sight`, so a tactile-only read would be dropped for
  an observer who cannot see. The foot domain gates its own tactile phenomenon on
  a lane-asserted channel, but slice 3 must extend the core filter per-observation
  before a blind-but-touching observer reads correctly.
- **The `crosses_*` path tags are not perception-filtered.** The core filter
  checks an observation's `sourceLocationId` and `targetLocationId`; a
  `crosses_heel_pad` tag rides a `sole`-keyed observation, so a fine locus from a
  region this observer cannot see can still reach a prompt through a tag. Slice
  3's per-observation channel-aware filter has to take the tags into account too,
  not just the two location fields.
- **`FootwearContactRead.effectiveFriction` is the outermost item's, regardless
  of surface.** It is the friction a toucher meets on top of the stack, and it is
  correct for a fully-shod foot and wrong for a partially-shod one: a sandal with
  a bare toe box reports the sandal's leather for the toes too. No phenomenon
  reads it today (glide uses the per-surface skin friction), which is why it
  shipped as is — slice 3 must make it per-surface before wiring anything to it.
- **`FootwearContactRead` has no side — RULED a registration blocker (owner,
  2026-07-31).** One wardrobe answer covers both feet, so "a sock on one foot"
  is unrepresentable. The ruling: footwear gains a foot **side** (the
  `footSides` vocabulary; absent = both/undistinguished is a design call for
  that change), and friction becomes surface- **and side-**specific, **before
  channel-aware registration** — the same gate as the per-surface friction item
  above. Until then a partially-shod pair cannot be authored truthfully and
  registration stays blocked on it.
- **Fixture-matrix rows that need an unowned owner** — standing/weight-bearing
  lift, trapped-foot reposition, reach-after-rotation, and hand-but-not-mouth
  geometry are decided by the contact-core RESOLVER (reach, support, geometry),
  which this slice does not touch; the foot half of those rows — what a
  weight-bearing, fixed, or trapped foot does to a restriction read — is covered
  in `support.test.ts`. Scent suppression, mark-after-removal, and
  transfer-before/after-commit belong to the deferred phenomena above.
