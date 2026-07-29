# Affordance spec draft — skin surface

Status: companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
(promoted with the plan 2026-07-28)

## Purpose

Derive observable skin-surface detail from canonical skin attributes plus
**authoritative** body state. This domain does not infer emotion or physiology.
It answers how an already-established state reads on this body, under this
coverage and lighting, to this observer.

It follows the shared
[domain architecture](body-attribute-affordances.spec.architecture.md), but it
should not invent an `EffectiveMechanics` object merely for symmetry. The first
implementation compiles reusable per-region appearance structure, assembles a
current frame, and leaves phenomenon-specific response calculations in their
own files until two or more consumers genuinely share one.

Examples:

- sweat supplied by physiology appears as a faint sheen, beads, or running
  moisture on exposed regions;
- an authoritative vascular-response sign may read as redness, deepening tone,
  warmth, or increased luminosity depending on the character and light;
- piloerection may be visually subtle but tactilely available during asserted
  contact;
- mud supplied by an exposure event reads differently when dry versus wet.

The common case should be silence. A valid baseline skin appearance is not an
automatic per-turn cue.

## Inputs

### Canonical attributes

- `skin.tone` and `skin.undertone` — baseline color context;
- `skin.texture` — baseline reflectivity and moisture behavior;
- `skin.markings` and `face.freckles` — occlusion/contrast interactions;
- body-hair attributes by region — water-beading and tactile/visual texture.

### Authoritative live state

- wetness or sweat level by location;
- vascular/color-response signs supplied by physiology;
- piloerection supplied by physiology;
- contamination placement and kind;
- any persistent pressure mark supplied by body/presentation state or an
  explicit recent event.

### Perception inputs

Coverage, light, distance, orientation, line of sight, and asserted contact are
applied after surface-state resolution. They decide whether a current physical
surface state is visually or tactilely available; they do not decide whether
the state exists.

No sign means no derived observation. The affordance layer never decides that a
character “must be blushing.”

## Structural profile

```ts
interface SkinSurfaceRegionProfile {
  locationId: BodyLocationId;
  baselineReflectivity: UnitInterval;
  moistureFilmAffinity: UnitInterval;
  dropletBeadingAffinity: UnitInterval;
  surfaceColorResponse: {
    rednessVisibility: UnitInterval;
    toneDeepeningVisibility: UnitInterval;
    luminosityChangeVisibility: UnitInterval;
  };
  bodyHairVisibility: UnitInterval;
}

type SkinSurfaceProfile = readonly SkinSurfaceRegionProfile[];
```

Do not encode darker skin as simply “low flush contrast.” The response profile
must allow several observable modes instead of treating visible redness as the
only valid expression. Calibration should be reviewed against diverse reference
fixtures and should never imply that physiological change is absent merely
because red coloration is less prominent.

The compiler creates entries only for locations present on the realized body.
The same surface phenomena run over each region profile; adding a region does
not create a second moisture or color-response implementation.

## Effective mechanics and frame

V1 has no standalone `SkinSurfaceEffectiveMechanics`. Current moisture mode,
color-response visibility, and contamination mode are phenomenon-specific
results, not reusable capacities yet.

```ts
interface SkinSurfaceAffordanceFrame {
  subjectId: CharacterId;
  storyTime: StoryTimestamp;
  regions: SkinSurfaceProfile;
  wetnessByLocation: ReadonlyMap<BodyLocationId, UnitInterval>;
  physiologySigns: readonly PhysiologySignRead[];
  contaminationByLocation: ReadonlyMap<BodyLocationId, ContaminationRead>;
  persistentMarks: readonly BodySurfaceMarkRead[];
}
```

The physiology/body-state adapter supplies signs and marks. The domain never
receives raw emotional drivers or infers a sign from prose.

## Phenomena

### `skin.moisture_surface_state`

Combines authoritative wetness with texture, grooming/surface state, and
region.

Output bands may include:

- `faint_sheen`;
- `dewy`;
- `beading`;
- `running_droplets`;
- `dampened_body_hair`.

`highlights_contour` is not a physical surface tag. Cue projection may add it
only after the perception read proves that current light, angle, and visible
surface support the effect; musculature alone is not sufficient.

The phenomenon computes its moisture response from one
`SkinSurfaceRegionProfile` plus the region's live inputs. If later phenomena
need the same film/beading intermediate, promote it to a named mechanics field
then—not before.

### `skin.color_response_surface_state`

Requires an authoritative physiology/body-state sign and emits only the
surface response. Possible tags include:

- `redness`;
- `tone_deepening`;
- `warm_luminosity`;
- `pallor`;
- `mottling`.

Cause comes from the supplied sign/event, not from narrator inference. Whether
an observer can distinguish the response is decided by perception.

### `skin.piloerection_surface_state`

Requires an authoritative piloerection sign. The physical response is
region-specific. Visual availability depends on body hair, light, distance,
and coverage; tactile availability requires current asserted skin contact.

### `skin.contamination_surface_state`

Consumes authoritative contamination placement. Moisture changes the visual
mode — dry dust, damp smears, mud streaks — but the affordance read does not
create or move contamination.

### Pressure marks are state, not affordance hysteresis

A sock line, strap mark, pillow crease, or binding impression that remains after
its cause is removed is persistent body/presentation state. Its owner records a
mark with location, intensity, start/expiry, and provenance. This domain only
turns that existing mark into a perception-gated observation.

The affordance layer must not keep a hidden activation latch to remember it.

## Worked case

After a hot-weather run, physiology supplies sweat and exertion-related color
response. With temples and collarbone exposed in useful light:

- a clear moisture sheen may resolve at those locations;
- the color-response observation uses the character's calibrated response mode
  rather than always saying “bright red”;
- covered torso regions emit no visual cue;
- tactile warmth or moisture is available only through asserted contact.

## Narrative rules

- Prefer meaningful changes from baseline, not permanent skin facts.
- Do not mention a surface observation every turn because it remains valid.
- Preserve region, channel, and intensity.
- Apply coverage/light/distance/contact only in perception and cue projection,
  never by deleting the underlying surface state.
- Never translate a low-visibility red response into “no reaction.”
- Do not infer the emotional or physiological cause beyond supplied provenance.

## Acceptance tests

- phenomena never receive raw skin/body-hair enum values;
- structural compilation creates profiles only for realized body locations;
- one region can be added without duplicating surface phenomenon code;
- absent physiology sign means no flush/pallor/goosebump observation;
- opaque coverage blocks the visual channel without changing surface-state
  resolution;
- asserted contact may license a tactile channel without licensing sight;
- different skin response profiles produce different semantic modes without
  changing underlying physiology intensity;
- wetness changes dust to smear/mud behavior only when contamination exists;
- a pressure mark appears only when authoritative mark state exists;
- baseline dry skin produces no automatic cue;
- identical inputs produce deterministic outputs.

## Resolved (owner rulings, 2026-07-28)

### `PhysiologySignRead` contract

A physiology sign says what the body is **doing**, without guessing why the
character feels that way. It contains:

- sign type — sweat, vascular response, pallor, piloerection, surface warmth;
- affected body locations (this is the region mapping — no second table);
- intensity;
- when it began and when it last changed;
- optional expiry;
- the event or body-state source that established it;
- confidence/evidence.

It MUST NOT contain an emotional conclusion ("embarrassed blush") unless a
separate authoritative source established that cause.
`skin.color_response_surface_state` therefore reads sign type plus intensity,
never a motive.

### Surface-color response calibration

Avoid a one-dimensional "how red does this skin get?" scale.
`surfaceColorResponse` stays three-moded: redness visibility, tone deepening,
luminosity/warmth change.

- Defaults are registry-calibrated from `skin.tone` and `skin.undertone`.
- An optional character-specific response-pattern override layers on top.
- Race is never the input.
- Low redness visibility never means "no physiological response" — the other
  modes carry it.
- Calibration is reviewed against a diverse fixture set under several lighting
  conditions.

### Grooming products — two owners

- The item/product definition owns **what the product does** (glossy, matte,
  water-resistant, oily, powdered …).
- Body-surface presentation state owns **where it is currently applied, how
  strongly, and for how long**.

This domain reads both and owns neither.

### Pressure-mark ownership

Temporary pressure marks (sock lines, pillow creases, strap impressions) belong
to **body-surface mark state**: location, intensity, creation time, expiry, and
source. `BodySurfaceMarkRead` is that owner's read.

If a mark permanently becomes a scar, an explicit event ends the temporary mark
and creates a persistent located appearance fact. There is no implicit
promotion, and no hidden latch here.

### Shared live inputs

Asserted contact — which licenses the tactile channel — comes from the shared
scene/body-relations owner (architecture spec §Scene/body-relations owner).
Unknown contact still means silence.

### Calibration stance

Every numeric coefficient in this domain (reflectivity, beading affinity,
color-response visibility) is a fixture-tested calibration default, not
permanent product law.
