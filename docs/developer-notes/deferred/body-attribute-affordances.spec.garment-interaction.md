# Affordance spec draft — garment interaction

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## What this covers

Fabric as a physical participant: wet cling and translucency, wind response
of skirts/hems/capes, and drape changes with pose. The rain-soaked shirt that
clings and turns translucent is the flagship case — very high value for this
product, and impossible for the narrator to keep consistent without a
deterministic read.

**Boundary caveat:** garments are presentation state, not body attributes, so
this domain sits half outside the plan's title. It is included because the
phenomenon registry composes garment material profiles with body state
through exactly the same machinery, and because wet-cling only matters as a
body-adjacent effect. Whether garment physics profiles are authored by the
wardrobe system and *consumed* here, or owned here outright, is the first
open question — this spec must not quietly become a second wardrobe system.

## Contributing inputs

Not attributes — garment facts supplied by the presentation layer:

- material class (cotton, silk, leather, wool, knit, synthetic…)
- weave weight and opacity baseline
- fit (loose / fitted / tight) and construction (structured vs draped)
- base color lightness (white cotton turns translucent; black doesn't read)

Body-side inputs: wetness by location, soft-tissue/build contour profiles
(what cling reveals), pose and motion, environment wind and rain.

## Physical profile sketch

Per worn garment (or garment region): `absorbency`, `clingAffinity`,
`wetTranslucency`, `flutterMass`, `drapeStiffness`.

## Phenomena

- **wet-cling** — saturation above a band makes fabric adhere to skin and
  follow body contour; candidate carries the affected regions and a contour
  band (what silhouette detail becomes readable). Translucency resolves
  separately from `wetTranslucency × saturation × color lightness`.
- **derived coverage** — the architectural wrinkle: wet-cling and
  translucency *modify the effective `CoverageRead`* that other phenomena and
  the perception layer consume (a translucent region may downgrade opacity so
  a flush or marking underneath becomes partially visible). That makes
  coverage a pipeline — authored coverage → garment-state modifiers → final
  read — and the resolution order must be explicit, or phenomena would feed
  each other in the same pass. Promotion must rule on this layering before
  any implementation.
- **wind-response** — hems, skirts, capes, loose sleeves flutter/lift by
  `flutterMass` vs wind band; suppressed by wetness (soaked fabric hangs)
  and fit, exactly parallel to hair wind motion. Lift candidates are banded
  and capped — this is an affordance, not an upskirt generator; the
  perception/decency gate applies with force.
- **drape-and-motion** — pose transitions emit settle candidates (a skirt
  pooling when she sits, a hem riding on stairs); mostly low salience,
  aggressive `repeatKey` suppression.

## Worked example

White cotton shirt, fitted, caught in the rain: saturation crosses the cling
band → cling candidate over shoulders/back with `clear` contour, translucency
downgrades those regions' opacity one band; the skin-surface spec's
flush-visibility can now emit a `subtle` candidate through it. The same rain
on a leather jacket: absorbency near zero, droplets bead and run, no cling,
opacity unchanged — the only candidate is surface droplets.

## Open questions

- Ownership: does the wardrobe/presentation system author garment physics
  profiles, with this layer purely consuming them?
- Derived-coverage layering: fixed two-stage pipeline, or a general
  dependency ordering across phenomena? (Blocks everything else here.)
- Does v1 ship wet-cling only and defer wind/drape (smallest slice with the
  most value)?
- Where is the decency gate for lift/translucency candidates — same ruling
  as the soft-tissue spec's question, decide once for both.
