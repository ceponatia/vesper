# Affordance spec draft — soft tissue

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## What this covers

How soft body masses — breasts, buttocks, hips/thighs — sit, move, and deform:
gravity and support state, motion response to impulses, and compression at
contact. High narrative value for a romance-first product, and the highest
repetition risk in the whole system, so the cue cap and `repeatKey` discipline
are load-bearing here, not optional polish.

Intimate-region physiological responses (`vulva.swelling`, `vulva.wetness`,
and kin) belong to the physiology stub and are out of scope. This spec is
mechanics of mass, not arousal response.

## Contributing attributes

- `breasts.size`, `breasts.shape`, `breasts.fullness`,
  `breasts.augmentation` — mass, rest geometry, and damping (augmentation
  raises firmness/damping and changes rest shape under gravity).
- `buttocks.size`, `buttocks.firmness`, `buttocks.shape`
- `hips.width`, `waist.definition`, `build.weight_presentation` — softness
  distribution beyond the two named regions.

## Physical profile sketch

Per soft-tissue region:

- `restMass` — how much mass is in play.
- `firmness` — resistance to deformation; drives both rest shape and damping.
- `damping` — how fast motion settles (augmented tissue: high).
- `mobility` — free-motion tendency once support is removed.

## Phenomena

- **gravity-and-support** — a standing read of current hang/rest state from
  posture (upright, leaning, lying back, bent forward) × support garment
  state (supported, loosely supported, unsupported) × firmness. Lying back
  redistributes; standing unsupported hangs per firmness band. This read is
  what keeps prose and scene images agreeing after a wardrobe change.
- **motion-response** — impulse events (running, stairs, jumping, a sudden
  turn, collision, laughter) emit sway/bounce candidates scaled by
  `restMass × mobility`, suppressed by support strength and damping. Ordinary
  walking should resolve below threshold except at high mass + unsupported;
  the common case must be silence.
- **compression** — an asserted contact (arms crossed beneath, pressed
  against a partner or surface, a tight garment band) yields a deformation
  candidate whose intensity follows mass and inverse firmness; also feeds the
  contact partner's tactile channel.

## Suppression examples

- Strong support garment: motion-response suppressed even for high mass —
  evidence `{ code: "supported", sourcePath: "presentation.support" }`.
- High augmentation firmness: sway suppressed despite size; gravity read
  returns the augmented rest shape instead.
- Opaque heavy coat: motion may be physically valid yet emits no visual
  candidate; nothing reaches the narrator.

## Worked example

Unsupported under a thin shirt, hurrying downstairs: motion-response emits a
`clear` sway candidate with cause `descending_stairs`. Same character, sports
bra: no candidate — suppression records name the garment. Perception layer
then decides whether any observer is positioned to notice at all.

## Open questions

- Is `firmness` derivable from shape/fullness/augmentation, or does it need
  its own authored attribute?
- Does thigh/belly softness need its own region profile, or does
  `build.weight_presentation` contribution suffice for v1?
- Where does the decency/narrative-focus gate live — perception layer,
  narrator contract, or product policy above both? (An observer *could*
  notice; whether the scene should dwell is not physics.)
- Male/flat-chested characters: does the region profile simply resolve to
  negligible mass, or is the phenomenon set gated by attribute presence?
