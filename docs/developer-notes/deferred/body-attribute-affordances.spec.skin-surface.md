# Affordance spec draft — skin surface

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## Purpose

Derive observable skin-surface detail from canonical skin attributes plus
**authoritative** body state. This domain does not infer emotion or physiology.
It answers how an already-established state reads on this body, under this
coverage and lighting, to this observer.

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
  explicit recent event;
- coverage, light, distance, orientation, and contact.

No sign means no derived observation. The affordance layer never decides that a
character “must be blushing.”

## Profile vocabulary

```ts
interface SkinSurfaceProfile {
  baselineReflectivity: UnitInterval;
  moistureFilmAffinity: UnitInterval;
  dropletBeadingAffinity: UnitInterval;
  surfaceColorResponse: {
    rednessVisibility: UnitInterval;
    toneDeepeningVisibility: UnitInterval;
    luminosityChangeVisibility: UnitInterval;
  };
  bodyHairVisibilityByLocation: ReadonlyMap<BodyLocationId, UnitInterval>;
}
```

Do not encode darker skin as simply “low flush contrast.” The response profile
must allow several observable modes instead of treating visible redness as the
only valid expression. Calibration should be reviewed against diverse reference
fixtures and should never imply that physiological change is absent merely
because red coloration is less prominent.

## Phenomena

### `skin.moisture_visibility`

Combines authoritative wetness with texture, grooming/surface state, light,
coverage, and region.

Output bands may include:

- `faint_sheen`;
- `dewy`;
- `beading`;
- `running_droplets`;
- `dampened_body_hair`.

A `highlights_contour` tag is allowed only when the current light and visible
surface actually support it; musculature alone is not sufficient.

### `skin.color_response_visibility`

Requires an authoritative physiology/body-state sign and emits only the visible
surface response. Possible tags include:

- `redness`;
- `tone_deepening`;
- `warm_luminosity`;
- `pallor`;
- `mottling`.

Cause comes from the supplied sign/event, not from narrator inference.

### `skin.piloerection_visibility`

Requires an authoritative piloerection sign. Visual strength depends on region,
body hair, light, distance, and coverage. A tactile observation may survive when
current asserted skin contact exists even if the visual channel does not.

### `skin.contamination_visibility`

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
- Never translate a low-visibility red response into “no reaction.”
- Do not infer the emotional or physiological cause beyond supplied provenance.

## Acceptance tests

- absent physiology sign means no flush/pallor/goosebump observation;
- opaque coverage blocks the visual channel;
- asserted contact may license a tactile channel without licensing sight;
- different skin response profiles produce different semantic modes without
  changing underlying physiology intensity;
- wetness changes dust to smear/mud behavior only when contamination exists;
- a pressure mark appears only when authoritative mark state exists;
- baseline dry skin produces no automatic cue;
- identical inputs produce deterministic outputs.

## Open questions

- Exact physiology-sign contract and region mapping.
- Ownership and authoring review of surface-color response calibration.
- Whether grooming products belong in skin presentation state or garment/item
  effects.
- Which body-state contract owns persistent pressure marks.
