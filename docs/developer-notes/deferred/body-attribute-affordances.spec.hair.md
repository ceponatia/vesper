# Affordance spec draft — hair

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

Hair is the proving domain. The plan document carries its full worked design —
the `HairPhysicalProfile` vocabulary, the four phenomena, illustrative
formulas, worked cases A–D, and the vocabulary prerequisites. This file is the
landing spec that freezes that design at promotion; until then it is an index,
not a second copy. Do not let hair detail drift between the two documents:
the plan owns it today, this spec owns it after promotion.

## Scope

- **Contributing attributes:** `hair.length`, `hair.texture`, `hair.quality`
  (provisional until the vocabulary split), structured style/constraint tags
  derived beside free-text `hair.style`, and `hair.color` only where a
  phenomenon needs an appearance interaction (wet darkening).
- **Profile:** reach, exposed area, strand mass, bulk density, flexibility,
  surface friction, water loading, clump affinity, curl retention — see the
  plan's `HairPhysicalProfile`.
- **Phenomena:** wind motion, wet clumping, skin adhesion, droplet shedding.

## What promotion must freeze here

1. The final `HairPhysicalProfile` field list and fixed-point ranges.
2. The `hair.quality` split ruling (strand thickness / density / condition /
   surface) and the sweep story for stored values.
3. The `HairConstraintTag` vocabulary and which system owns tag assignment.
4. The four phenomenon contracts: dependency paths, candidate IDs
   (`hair.strands_lift_in_wind`, `hair.wet_clumping`,
   `hair.strands_adhere_to_skin`, `hair.sheds_droplets`), band thresholds,
   and hysteresis values.
5. The first calibration table plus the ordering/monotonicity tests that pin
   it.

## Open questions

Tracked in the plan's `## Open questions` (hair vocabulary split, structured
style ownership, hysteresis storage, color-change semantics). Resolutions
land here.
