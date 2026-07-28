# Recognizable features — candidate catalog

Status: detail for
[body-attribute-affordances.spec.recognizable-features.md](body-attribute-affordances.spec.recognizable-features.md)
(promoted with the plan 2026-07-28)

## Purpose

Provide a broad vocabulary of identity details worth considering during
registry and fixture design. This is a candidate catalog, not a requirement to
ship every feature and not a list stored on each character.

V1 should prefer details that are reliably locatable, visible, and
representable without prose parsing.

## Candidate families

| Family | Examples | Primary owner |
| --- | --- | --- |
| Facial geometry | crooked/asymmetric nose, cleft chin, uneven jaw, prominent brow, one dimple, facial asymmetry | canonical attributes |
| Eyes | complete or sectoral heterochromia, limbal ring, pupil mismatch, cloudy eye, unusual iris flecks, one drooping lid | attributes; injury for acquired damage |
| Brows | eyebrow notch, missing patch, joined brows, one naturally raised brow, scar through brow | attributes or located fact |
| Teeth and mouth | front gap, chipped tooth, missing tooth, gold tooth, sharp canine, crooked smile line, lip scar | attributes; anatomy/dental event; located fact |
| Ears | one torn lobe, ear notch, uneven points, cauliflower ear, stretched piercing holes | anatomy or located fact |
| Hairline and growth | widow's peak, cowlick, white forelock, premature streak, bald patch, unusually dense sideburn, single stubborn curl | attributes/presentation; condition for temporary loss |
| Pigmentation | shoulder freckles, beauty mark, mole constellation, birthmark, vitiligo patch, port-wine stain, sun spots, albinism patch | located appearance facts |
| Skin texture | acne scarring, weathered cheeks, rough knuckles, callused palms, stretch marks, scales, unusually smooth scar tissue | attributes or located facts |
| Scars | linear cut, burn scar, surgical scar, bite mark, claw marks, ritual scarification, puncture, eyebrow scar | located facts with event provenance |
| Temporary marks | bruise, black eye, hickey, rash, sunburn, pressure line, ring indentation, paint, soot, blood, mud | body condition/contamination |
| Hands and digits | missing ring finger, extra digit, fused fingers, crooked healed finger, tremor, stained fingertips, bitten nails | anatomy; condition; attributes |
| Feet and toes | missing toe, overlapping toes, webbing, old ankle scar, unusual arch, dancer's calluses | anatomy, attributes, located facts |
| Limbs | prosthetic limb, shortened limb, healed fracture angle, bowed leg, one shoulder lower | anatomy or persistent body state |
| Torso | shoulder freckle field, collarbone birthmark, chest scar, stretch marks, surgical seam, asymmetrical rib contour | located facts/anatomy |
| Tattoos and modification | sleeve tattoo, tiny ankle symbol, brand, ritual ink, scarification, subdermal implant, piercing holes | located facts; jewelry remains wardrobe |
| Supernatural morphology | chipped horn, mismatched horn curve, torn wing edge, translucent wing spot, tail kink, missing scales, glowing rune, bioluminescent freckles | anatomy, morphology attributes, located facts |
| Acquired story consequences | stitches becoming a scar, magical corruption vein, regrown limb with color mismatch, curse mark, healed bite, removed-tattoo trace | evented condition → persistent fact/topology |
| Signature presentation | glasses, ribbon, makeup motif, favorite coat, habitual braid, prosthetic cover, recurring jewelry | wardrobe/presentation |
| Recognizable motion | head tilt, shoulder roll, hand tremor, distinctive gait, tail-tip twitch, wing carriage | movement/behavior; later visual-memory extension |

## Useful constellations

Several ordinary details may form a more distinctive whole:

- freckles across both shoulders plus one darker spot near the collarbone;
- a crooked nose, front-tooth gap, and left-cheek dimple;
- silver forelock plus a scar through the opposite eyebrow;
- chipped right horn plus a habitual leftward head tilt;
- missing ring finger plus a pale band of scar tissue and a changed grip.

The projector may create a constellation candidate only from already-noticed
members. It must not invent a composite prose fact or use hidden members to
raise uniqueness.

## Authoring priorities

Start with:

- freckle/birthmark clusters;
- moles and beauty marks;
- one or two scar shapes with event provenance;
- tooth gap/chip;
- hair streak/forelock;
- horn chip or tail kink;
- missing digit after anatomy ownership exists.

Defer features that need unreliable fine geometry, subjective prose, or motion
classification until the base location and memory systems are proven.

## Boundaries

- Piercing holes may be body facts; removable jewelry is wardrobe.
- A prosthetic's presence is anatomy/presentation; its removable cosmetic cover
  is an item.
- A limp may be recognizable but is movement/body-state, not static anatomy.
- Dirt, blood, bruising, and pressure marks are temporary unless an event
  explicitly creates lasting aftermath.
- Intimate details obey the same exposure, consent, and narrative-focus gates
  as every other body read; rarity never bypasses them.
