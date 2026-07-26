# Thermal observables — scope ruling

Status: draft tombstone (reviewed 2026-07-26; not a companion implementation
spec for [body-attribute-affordances.plan.md](body-attribute-affordances.plan.md))

Fable drafted passive thermal observations — visible breath, contact
 temperature, and radiated warmth — as a stress test for the affordance
registry. The examples are useful, but they do not belong in the body-attribute
physics plan.

They depend almost entirely on:

- environment temperature, humidity, and wind;
- physiology/body-state surface temperature;
- breathing/exertion state;
- observer proximity or asserted contact.

Canonical appearance attributes contribute little or nothing. Keeping the file
as a first-class companion spec would broaden a focused visual-attribute system
into a generic world-observation engine before the hair proof exists.

## Ruling

- Do not implement this file as part of the body-attribute affordance plan.
- Visible breath belongs to a future environment/perception observation design.
- Contact temperature belongs to physiology/body-state reads plus tactile
  perception.
- Radiated warmth should be folded into proximity/contact temperature unless a
  later product case proves it deserves a distinct phenomenon.
- The shared observation contract may be reusable later, but reuse is not a
  reason to schedule this domain now.

This tombstone remains only to preserve the reviewed idea and explain why it was
removed from the active companion-spec list.
