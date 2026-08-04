# Romantic contact affordances — intimate-region domain

Status: technical companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
(promoted 2026-07-28 — later scope: slices 5–6, queued behind the foot proof)

## Scope and safety boundary

This domain applies the
[shared contact core](romantic-contact-affordances.spec.contact-core.md) to
permission-gated intimate contact. The
[directional permission owner](romantic-contact-affordances.spec.permission.md)
defines the common direction, chronology, revocation, authorship, and rollback
laws. This domain handles only anatomy present in the character's body
configuration and only after the lane's authoritative actor-control,
permission, exposure, and point-of-view checks.

The domain calculates physical and sensory observations. It never decides or
infers desire, consent, attraction, pleasure, orgasm, withdrawal, resistance,
or an expressive reaction. An arousal-related body read is an input from
physiology, not evidence of permission.

## Permission scopes

Intimate contact is outside the current `romantic_touch` MVP. That grant must
never authorize kissing, contact with intimate anatomy, removing another
participant's clothes, exposing oneself to them, or sex.

Later work should introduce exact directional scopes for the distinct
interactions the product chooses to support. A broad relationship label such as
`cherished` or `smitten` may eventually help set per-scope automatic
revocation thresholds, but it never creates a grant. A relationship recovery
does not restore a revoked grant.

The player-target exception remains an authorship rule: the system does not
pre-calculate the player's acceptance before an NPC acts, and the narrator may
not invent the player's reaction. It does not relax actor control, exposure,
anatomy, content, or point-of-view gates.

## Existing topology

Use the registry under `src/contracts/body/locations/intimate.ts`; do not create
a parallel body-part vocabulary.

Relevant groups and loci include:

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

The current registry/body configuration remains authoritative about which
configurable regions exist. Universal moderation-sensitive regions keep their
existing rules. Side, subregion, external/internal surface, and contact path
use validated `BodyLocusRef` detail rather than new schema columns.

## Stable profile versus live state

```ts
interface IntimateStructuralProfile extends RegionalStructuralProfile {
  domain: "intimate";
  locus: BodyLocusRef;
  geometry: IntimateBaselineGeometryRead;
  compliance: UnitInterval;
  supportResponse: UnitInterval;
  drySurfaceFriction: UnitInterval;
  sensitivityTendency?: UnitInterval;
  textureBand?: IntimateTextureBand;
}

interface IntimateCurrentConditionRead extends SurfaceConditionRead {
  physiology: IntimatePhysiologyRead;
  moisture?: IntimateMoistureRead;
  moistureContributors: readonly SurfaceSubstanceRead[];
  temperatureBand?: ContactTemperatureBand;
  residues: readonly SurfaceResidueRead[];
  marks: readonly BodySurfaceMarkRead[];
}
```

Stable profiles compile canonical attributes describing baseline anatomy.
Current condition reads:

- erection/engorgement;
- genital or nipple swelling/firmness;
- lubrication;
- vascular color/flush where visible;
- sweat and temperature;
- products, water, or residue;
- current marks or irritation only when body state owns them.

The physiology plan owns transfer functions, time behavior, and live levels.
This domain only maps current levels plus contact into observable mechanics.

`sensitivityTendency` may affect an actor's internally available tactile signal
when an established consumer needs it. It must never be converted directly
into pleasure narration or behavior.

## Effective exposure and access

Intimate access is locus-, action-, actor-, and channel-specific.

```ts
type IntimateExposureMode =
  | "covered_opaque"
  | "covered_transmissive"
  | "visible_sheer"
  | "partially_exposed"
  | "direct_external"
  | "direct_internal";

interface IntimateAccessRead {
  mode: IntimateExposureMode;
  locus: BodyLocusRef;
  materialBetween: readonly GarmentLayerRead[];
  contactPath: ContactPathRead;
  visualPath: PerceptionPathRead;
  policyDecisionRef: PolicyDecisionRef;
  evidence: readonly AffordanceEvidence[];
}
```

Rules:

- opaque coverage blocks visual/direct-skin reads but may allow
  material-filtered touch and contour;
- sheer visibility does not imply tactile access;
- displacement applies to the garment part and body locus actually affected;
- internal access requires a compatible explicit action, aligned path,
  committed exposure, and policy pass;
- a general intimate-scene signal is not sufficient evidence for specific
  contact or access;
- missing clothing, path, or policy evidence degrades toward blocked.

## Phenomena

### `intimate.effective_exposure`

Returns the exposure mode and allowed sensory channels for one locus. This is a
hard prerequisite for the remaining phenomena, not a narrator cue by itself
unless a current wardrobe/action change makes exposure relevant.

### `intimate.contact_pressure`

Uses the shared pressure/area mechanic, then maps it to the target locus and
surface geometry.

Outputs include:

- external or internal locus;
- `trace | light | moderate | firm`;
- `point | narrow | broad`;
- still/pressing/sliding/rolling motion;
- material-filtered versus direct contact.

It does not infer a response.

### `intimate.surface_moisture`

Combines only authoritative sources:

- physiology-owned lubrication;
- sweat/body wetness;
- water;
- authored/applied product;
- committed fluid/residue.

Outputs are local semantic bands and provenance. An intimate frame, high
arousal meter, or contact alone cannot synthesize wetness unless physiology has
produced the corresponding read.

Known dry and unknown are separate. If no authoritative source establishes
current moisture, the phenomenon is silent and friction cannot assume a dry
surface.

### `intimate.friction_glide`

Requires committed relative motion. Combines both structural surfaces, current
moisture, pressure/area, material layers, and motion path.

Outputs:

- `dragging`;
- `controlled_glide`;
- `smooth_glide`;
- `slippery`;
- `material_catch`;
- `grip_breaks`.

This is a contact mechanic, not an evaluation of comfort or pleasure.

Friction curves are keyed by the actual substance/material combination.
Water, sweat, physiology-owned lubrication, oil/lotion, and wet fabric are not
one monotonic moisture scale; low water or sweat films may increase skin
friction.

### `intimate.soft_tissue_deformation`

Consumes stable compliance/support mechanics, live physiology, contact
pressure/area, support, and current pose.

Possible observations:

- localized compression;
- broad flattening/support;
- displacement along a committed motion path;
- rebound after released pressure when the authoritative frame includes it;
- constrained deformation under a garment.

Potential deformation is not narrated. It requires actual contact or a current
support constraint.

### `intimate.physiology_geometry`

Projects physiology-owned state through baseline anatomy:

- penis erection/engorgement changes effective length, girth, angle, firmness,
  and garment contour;
- vulvar/clitoral swelling changes prominence and visible/tactile geometry;
- nipple erection changes projection and possible garment transmission;
- breast or genital vascular change may alter visible color only under a valid
  visual/exposure path;
- testicular position or other temperature-dependent changes are omitted until
  an authoritative physiology read exists.

Opaque clothing may permit a contour read while suppressing skin/anatomy detail.
No physiology read means no live-geometry claim.

### `intimate.garment_contour`

Combines baseline/live geometry with garment fit, tension, material thickness,
rigidity, wetness, and current displacement.

It may produce:

- shape transmitted through fabric;
- localized tension or compression;
- damp fabric clinging where garment state confirms it;
- movement transmitted through flexible material;
- anatomy detail suppressed by opaque/rigid material.

It never treats contour as direct exposure.

### `intimate.fluid_transfer`

Calculates a proposed transfer from a current source, actual contact path,
pressure/motion, receiving surface, and material permeability. The body or
garment owner commits amount, locus, timestamp, and provenance.

Source removal and target or intermediate-garment deposition commit atomically
under one idempotency key. Retry and retake cannot duplicate material or leave
only one side applied.

The observation appears only after commit and may then feed:

- surface moisture;
- garment dampness;
- visible residue;
- scent/taste contributors;
- later cleanup actions.

### `intimate.aftereffect_visibility`

Reads only authoritative aftermath:

- current displacement/exposure;
- dampness;
- pressure impressions;
- flushing or vascular change;
- committed residue;
- temporary marks.

Each source keeps its owner and expiry. The affordance domain stores no hidden
aftereffect timer.

### `intimate.action_alignment`

Validates that the action semantics match the physical frame:

- named actor surface and target locus exist;
- pose and contact path can connect them;
- clothing state permits the requested contact mode;
- external versus internal destination is correct;
- motion direction/path remains compatible;
- required support and free movement exist;
- actor control covers the initiating participant;
- consent/policy scope covers the action.

It yields a resolver constraint or diagnostic, not a prompt claim about a
failed attempt.

## Sensory channels

- **Channel: Visual**
  - **Additional intimate requirements:** Valid exposure plus viewpoint; contour-through-clothing stays distinct from anatomy detail.
- **Channel: Tactile**
  - **Additional intimate requirements:** Actor participates in committed contact; material transmission and locus are preserved.
- **Channel: Olfactory**
  - **Additional intimate requirements:** Current baseline/condition contributor, intimate proximity, exposure/permeability, and airflow.
- **Channel: Gustatory**
  - **Additional intimate requirements:** Explicit direct oral contact with the qualifying surface and policy pass.

Authored scent/taste attributes provide baseline character identity. Hygiene,
physiology, products, and residue may modulate intensity or add grounded notes;
they do not replace the authored character of the value. The narrator receives
at most one relevant sensory cue, not a catalog.

## First intimate fixture set

1. Hand over opaque underwear: touch and contour may transmit; no direct skin,
   anatomy color, lubrication, or residue cue.
2. Same garment, sheer but not displaced: visual allowance may change; direct
   tactile access does not.
3. Garment explicitly displaced after policy pass: direct external contact
   becomes possible only at the exposed locus.
4. Direct contact with dry current state: pressure/texture may resolve; glide
   must not become slippery.
5. Same contact after authoritative product/lubrication state: the calibrated
   substance curve changes the friction band and remains locally scoped.
6. Physiology-owned erection beneath opaque underwear: contour may resolve;
   bare anatomy detail remains suppressed.
7. Swelling/lubrication absent from physiology: genre and narrator framing
   cannot create them.
8. Proposed fluid transfer rolled back: no receiving-surface or garment
   observation appears.
9. Sustained unchanged contact: cue is not repeated until pressure, motion,
   material, physiology, exposure, or residue changes.
10. Retake: same event cut produces the same contact, policy reference,
    observations, and repeat keys.

## Leak-prevention and property tests

- absent/body-config-disabled region cannot be targeted or narrated;
- universal sensitive regions still require exposure/policy gates;
- intimate scene signal without committed contact produces no contact cue;
- high arousal without physiology-owned surface state produces no wetness or
  live-geometry claim;
- erection/swelling/lubrication never imply consent;
- consent never implies arousal or sensory response;
- opaque coverage prevents anatomy-specific visual cues;
- tactile transmission through fabric never flips to direct skin;
- no relative motion produces no glide;
- zero moisture/product input cannot produce a slippery result;
- unknown moisture cannot produce either a known-dry or slippery result;
- substance-specific friction fixtures cover low and high water/sweat films
  separately from confirmed lubricants;
- increasing pressure does not reduce deformation under identical support and
  profile unless a domain constraint explicitly saturates it;
- transfer and aftereffects require committed event provenance;
- transfer conserves material and is idempotent on retry/retake;
- unperceived intimate observations never reach ranking or capture;
- malformed policy/wardrobe/body reads fail closed with bounded diagnostics;
- narrator cues contain semantic results, not policy, anatomy coefficients, or
  rejected alternatives.

Common permission mechanics are settled in the
[permission-owner spec](romantic-contact-affordances.spec.permission.md).
Remaining intimate physiology and presentation questions stay in the
[plain-English plan](romantic-contact-affordances.plan.md#open-questions).
