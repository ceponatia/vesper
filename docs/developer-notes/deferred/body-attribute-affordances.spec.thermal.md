# Affordance spec draft — thermal observables

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## What this covers

Temperature-driven observables that are pure algebraic reads: visible breath
in cold air, skin temperature through touch, and radiated warmth at close
proximity. Deliberately small — it exists partly as an architectural stress
test, because its phenomena take almost no input from authored attributes.
It proves the phenomenon registry stands on its own: a phenomenon is defined
by its dependency paths, and an empty `attributes` dependency list is legal.

The physiology stub owns every thermal *process* — shivering, sweating for
cooling, cold-induced pallor, fever. Those surface through the skin-surface
spec's visibility gates. This spec covers only passive heat-transfer physics
between a body and its surroundings.

## Contributing inputs

- Environment: temperature band, humidity, wind (wind chill sharpens breath
  plumes and skin cooling).
- Body state: surface temperature by location (physiology/body-state owns the
  value; this layer reads it), exertion sign (breath volume).
- Attributes: nearly none — at most `build.*` for thermal-mass edge cases,
  which v1 should skip.

## Phenomena

- **visible-breath** — environment temperature below a band + a breathing
  subject → breath plume candidates; intensity scales with exertion sign
  (heavy breathing after a run reads at a colder-visible band than rest).
  Everyone present gets the same read — a cheap, scene-wide consistency win
  (no more one character's breath fogging while another's doesn't).
- **touch-temperature** — skin surface temperature resolves to a contact-only
  band: cold hands, chilled skin after rain (evaporative reading of wetness ×
  wind), feverish forehead, sun-warmed shoulder. Only observable through an
  asserted contact pair — the textbook tactile-channel perception gate. Wet
  skin + wind reads colder than air temperature alone; the formula is an
  authored transfer, not thermodynamics.
- **radiated-warmth** — at very-close proximity bands (adjacent, pressed
  close), a body reads as a warmth source; strongest for the huddling-
  together-in-the-cold beat. Requires asserted proximity/contact; may fold
  into touch-temperature if it can't justify a separate rule.

## Worked example

Winter street, two characters walking close after leaving a hot bathhouse:
both emit `clear` breath plumes; the one with a damp collar (cross-ref hair
droplet/wet specs) gets a `chilled_skin` touch band at the neck; when she
takes his arm, the contact pair licenses both the cold-hand read on her side
and radiated warmth on his. None of it is visible to a distant observer
except the breath.

## Open questions

- Does body state carry per-location surface temperature yet, or only a
  whole-body band? (Determines how coarse touch-temperature starts.)
- Who owns the environment temperature vocabulary — weather/conditions
  system, environment context, or a new registry?
- Is radiated-warmth a real phenomenon or a touch-temperature band? Decide at
  promotion; default to folding it in.
