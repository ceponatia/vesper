# Romantic contact affordances — intimate-region domain

Status: **not built; architecture reconciled 2026-08-18.** No intimate contact
domain is registered or wired. This work is blocked on future exact permission
scopes, physiology/body-surface owners, explicit intimate action producers, and
channel-correct perception/presentation routing.

Plan: [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)

Core: [romantic-contact-affordances.spec.contact-core.md](romantic-contact-affordances.spec.contact-core.md)

Effects/presentation: [romantic-contact-affordances.spec.effects.md](romantic-contact-affordances.spec.effects.md)

Permission: [romantic-contact-affordances.spec.permission.md](romantic-contact-affordances.spec.permission.md)

## Scope and hard boundary

This domain may eventually apply shared contact mechanics to anatomy present in
the character's realized body configuration. It calculates physical phenomena
from committed contact/current state.

It never decides or infers:

- desire;
- consent/permission;
- attraction;
- pleasure/orgasm;
- resistance/withdrawal;
- expressive reaction;
- player acceptance;
- anatomy that is absent from the realized body.

Physiology reads are inputs. They are never evidence of permission.

## Permission is not `romantic_touch`

The current permission owner knows `romantic_touch`; that scope does **not**
authorize intimate anatomy, kissing, undressing, nudity exposure, or sex.

Before this domain is enabled, product design must define the exact directional
scopes relevant to the supported actions. Scope membership remains exact unless
a future product ruling explicitly defines implications.

The NPC -> player exception remains only an authorship rule: Vesper does not
pre-authorize the player's response. It does not bypass anatomy, exposure,
physical feasibility, content, or action-scope gates.

## Existing topology

Use the shared body location registry. Do not create a second intimate anatomy
vocabulary.

Relevant current groups include:

```text
chest
└── breasts
    └── nipples

groin
├── mons
├── vulva
│   ├── labia_majora
│   ├── labia_minora
│   ├── clitoris
│   └── vestibule
├── vagina
├── penis
└── testicles

pelvis
├── perineum
└── anus
```

Side/subregion/internal-vs-external detail belongs in validated body-locus/path
contracts, not new ad-hoc strings.

## Stable profile versus current state

Conceptually:

```ts
interface IntimateStructuralProfile extends RegionalStructuralProfile {
  domain: "intimate";
  locus: BodyLocusRef;
  geometry: IntimateBaselineGeometryRead;
  compliance: UnitInterval;
  supportResponse: UnitInterval;
  drySurfaceFriction: UnitInterval;
  textureBand?: IntimateTextureBand;
}
```

Current state must come from real owners, not this domain's memory:

- body-surface wetness where already owned;
- physiology-owned erection/engorgement/swelling/lubrication/vascular change;
- products/residue after a body-state owner exists;
- temperature after a real source exists;
- marks after a body-mark owner exists;
- garment state from wardrobe.

The current codebase does **not** yet own the full set. Visual state explicitly
suppresses unsupported physiology/contamination/contact-mark families. That is a
blocker, not permission to default them.

Known dry and unavailable remain different.

## Exposure/access

Intimate access is locus-, action-, actor-, and channel-specific.

```ts
type IntimateExposureMode =
  | "covered_opaque"
  | "covered_transmissive"
  | "visible_sheer"
  | "partially_exposed"
  | "direct_external"
  | "direct_internal";
```

Rules:

- opaque coverage blocks direct visual/skin reads but may transmit pressure or
  contour;
- sheer visibility does not imply tactile access;
- garment displacement applies only after a wardrobe operation commits;
- a general intimate-scene signal cannot substitute for exact action/access;
- internal access requires an explicit compatible action, aligned path,
  committed exposure, exact permission scope, and physical feasibility;
- missing policy/coverage/path evidence fails closed.

Do not persist a domain-local `visualPath`; visual visibility is evaluated by
visual state from the committed visual facts and observer/camera context.
Nonvisual access belongs to the future shared sensory owner.

## Phenomena

Every phenomenon returns a channel-tagged physical observation and/or effect
proposal. It never writes narrator prose.

### `intimate.effective_exposure`

Returns structured exposure/access state for a locus. It is a prerequisite for
other phenomena, not automatically a narration cue.

A visually meaningful exposure change may later project into visual state.

### `intimate.contact_pressure`

Requires committed contact. Uses shared pressure/area/motion mechanics and
preserves:

- exact locus/path;
- pressure band;
- area band;
- motion band;
- direct versus material-filtered contact.

The result is primarily tactile; any visible deformation is a separate visual
phenomenon with its own support/state requirements.

### `intimate.surface_moisture`

May combine only authoritative sources:

- body-surface wetness;
- physiology-owned lubrication;
- sweat when owned;
- water;
- authored/applied product;
- committed residue.

Contact/arousal/narrative framing cannot synthesize moisture.

### `intimate.friction_glide`

Requires committed relative motion plus known relevant surface/material state.
Possible semantic outputs:

```text
dragging
controlled_glide
smooth_glide
slippery
material_catch
grip_breaks
```

Substance curves are distinct. Water, sweat, oil/lotion, physiology-owned
lubrication, and wet fabric are not one monotonic “wetness” scale.

This is tactile mechanics and may not enter visual state.

### `intimate.soft_tissue_deformation`

Requires actual pressure/support/current geometry. Potential compliance alone is
silent.

A visual deformation observation and a tactile deformation observation are
separate channel results even when produced by the same physical frame.

### `intimate.physiology_geometry`

Projects an existing physiology-owned state through baseline anatomy.

Examples may include erection/engorgement/swelling or nipple projection, but
only after the physiology owner exists and supplies the current state.

Opaque clothing may permit a garment-contour visual read while suppressing bare
anatomy detail.

### `intimate.garment_contour`

Combines known current body geometry with garment fit/tension/material/condition.

Possible visual results:

- contour transmitted through fabric;
- local tension/compression;
- damp cling only where garment/body wetness supports it;
- movement transmitted through flexible material.

Contour is not direct exposure.

This phenomenon should project through visual state, which owns viewpoint,
occlusion, exposure, salience, and narrator/image selection.

### `intimate.fluid_transfer`

Requires a real source plus committed contact/path/permeability. It proposes a
conserved transfer; the appropriate body/garment owner commits source removal and
target/intermediate deposition atomically.

The current body residue owner required for general skin deposition does not yet
exist, so this cannot be promoted to live truth merely because the contact domain
can calculate a proposal.

### `intimate.aftereffect_visibility`

Reads only committed aftermath:

- wardrobe displacement/exposure;
- dampness;
- committed marks;
- physiology-owned flush/change;
- committed residue.

It has no hidden domain timer.

Visual aftermath routes into visual state. Nonvisual aftermath routes to the
future sensory owner.

### `intimate.action_alignment`

Validates:

- actor/target loci exist;
- action path matches external/internal destination;
- scene geometry/support permits it;
- wardrobe permits the requested access;
- actor control is valid;
- target movement has its own authority when required;
- exact permission scope applies.

It emits resolver requirements/diagnostics, not narrator prose.

## Sensory routing

### Visual

Route only visual phenomena to visual state.

Visual state owns:

- per-subject exposure/visibility;
- viewpoint/camera filtering;
- occlusion;
- visual attention;
- notice/mention state;
- repetition suppression;
- narrator/image selection.

Intimate contact must not maintain its own visual cue memory or ranking.

### Tactile

Requires participant involvement in the qualifying committed contact plus
material/path transmission. It waits on the shared nonvisual sensory
presentation owner before live narrator cues.

### Olfactory

Requires real contributors plus proximity/exposure/permeability/airflow as
applicable. It waits on the shared nonvisual sensory owner.

### Gustatory

Requires an explicit compatible direct oral contact and exact action/policy
scope plus real source contributors. It waits on the shared nonvisual sensory
owner.

No nonvisual intimate observation may be passed through the visual-state
`AffordanceObservation` bridge.

## Effects

Effect proposals follow the shared effects spec:

- proposal is not truth;
- body/wardrobe owner validates and commits;
- transfer is conserved and idempotent;
- retake removes the committed result through the owner rollback path;
- observation reads the **post-commit** state;
- no hidden residue/mark state lives here.

## First fixture matrix

1. Hand over opaque underwear: material-filtered pressure possible; no direct
   skin or anatomy-specific visual detail.
2. Sheer but undisplaced garment: visual allowance may change; direct tactile
   access does not.
3. Explicitly displaced garment after applicable scope/action: direct external
   access only at the committed exposed locus.
4. Direct contact with known dry current state: pressure/texture may resolve;
   no invented slippery result.
5. Same contact after authoritative product/lubrication state: the correct
   substance curve changes friction locally.
6. Physiology-owned geometry under opaque underwear: garment contour may resolve;
   bare detail remains hidden.
7. Missing physiology: genre/arousal cannot create swelling/lubrication.
8. Rolled-back transfer: no residue/deposit observation remains.
9. Sustained unchanged contact: physical state persists; presentation repetition
   is owned by visual/nonvisual attention layers, not the domain.
10. Retake: same restored contact/policy/body/wardrobe cut produces the same
    physical observations/effect proposals.

## Leak-prevention tests

- absent/unrealized anatomy cannot be targeted/narrated;
- `romantic_touch` cannot authorize intimate action;
- permission cannot imply arousal/response;
- arousal/physiology cannot imply permission;
- opaque coverage suppresses bare-anatomy visual facts;
- tactile transmission never becomes direct-skin access;
- no motion -> no glide;
- no authoritative source -> no moisture/residue;
- unknown -> neither dry nor slippery;
- transfer/marks appear only after owner commit;
- nonvisual phenomena cannot enter visual state;
- visual phenomena use visual-state visibility/selection rather than local
  ranking/capture;
- retake is idempotent across contact, permission, effects, and presentation
  owners;
- malformed policy/wardrobe/body reads fail closed.

## Prerequisites before implementation

1. First player romantic action seam and `romantic_touch` proof are accepted.
2. Future intimate permission scopes are explicitly ruled.
3. Required physiology/body-surface owners exist for the phenomena selected.
4. Wardrobe access/displacement path is authoritative.
5. Visual facts have visual-state feature/adapters.
6. A shared nonvisual sensory presentation owner exists before tactile/scent/
   taste cues go live.
7. A dedicated intimate leak-prevention trial is defined before registration.
