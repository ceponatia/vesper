# Affordance spec draft — skin surface

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## What this covers

What the skin surface visibly is doing right now: moisture sheen and
droplets, flush and pallor, goosebumps, compression marks left by removed
clothing, and dirt/contamination. This is the highest-traffic domain after
hair — almost every scene has at least one candidate — so its anti-tedium
discipline matters more than its physics.

The physiology layer owns the processes (sweating, vasocongestion,
piloerection). This spec owns only their *observability*: given a physiology
sign or body-state level, what can an observer actually see or feel, on this
skin, under this coverage, in this light. The read barrier is absolute: no
physiology sign in the context means no flush candidate, ever — the affordance
layer never infers "she is probably blushing."

## Contributing attributes

- `skin.tone`, `skin.undertone` — baseline against which color change reads.
- `skin.texture` — sheen baseline and how moisture beads vs films.
- `skin.markings`, `face.freckles` — interaction details (flush deepening
  freckle contrast; markings vanishing under contamination).
- `arms.hair`, `legs.hair`, `chest.hair`, `buttocks.hair` — body-hair
  coarseness/coverage per region, which scales goosebump and water-beading
  visibility.

## Physical profile sketch

Per-region where it matters (face vs body):

- `flushContrast` — how visibly erythema reads against baseline tone. On deep
  skin tones a flush may present as deepened tone and radiant warmth rather
  than visible red; the profile encodes that as a lower contrast band, and the
  narrator cue carries the band so prose never claims "bright red cheeks" the
  skin cannot show. Tactile warmth is tone-independent and stays available
  through the contact channel.
- `sheenBaseline` — dry-state reflectivity, from texture and grooming.
- `hairCoarseness` per region — goosebump/beading amplifier.

## Phenomena

- **moisture-visibility** — sweat level (physiology) plus external wetness
  (rain, immersion, splash) resolve to a banded read per exposed region:
  dewy → sheen → beading → running droplets. Sheen candidates can carry a
  `highlights_contour` tag when musculature or soft-tissue definition is high
  (cross-input with `build.musculature`).
- **flush-visibility** — a vasocongestion sign (exertion, arousal,
  embarrassment, cold-nipped cheeks — the physiology layer names the cause)
  gated by `flushContrast`, region exposure, lighting, and observer distance.
  Output intensity is *visible contrast*, not physiological intensity.
- **goosebumps** — piloerection sign gated by exposure; visibility scaled by
  `hairCoarseness` and light; always available on the tactile channel when an
  asserted skin contact exists, even when too subtle to see.
- **compression-marks** — recently removed tight items (waistband, straps,
  socks, bindings; pillow creases after sleep) leave fading marks at the
  covered locations. This is the flagship hysteresis case: current inputs
  alone cannot derive a mark that outlives its cause, so it needs either the
  recent-events window or the minimal persisted latch the plan debates. Fade
  is analytic (band by minutes since removal), never ticked.
- **contamination-visibility** — dirt, dust, mud, and similar placement from
  exposure events; interacts with moisture (mud streaks vs dry dust).

## Worked example

After a hot-day run, hood down: sheen at collarbone and temples (`clear`),
cheek flush with cause `exertion` (`clear` on high-contrast skin, `subtle`
band + warmth tag on deep tone), damp hairline (cross-ref hair spec). Under
an opaque jacket the same sweat level yields no torso candidate — but a
tactile candidate survives if a contact pair asserts a hand on that skin.

## Open questions

- Are physiology signs per-region or whole-body, and who maps sign → region?
- Who owns the `skin.tone` → `flushContrast` calibration table, and is it a
  profile contribution or a perception-layer concern?
- Compression marks: recent-events window vs persisted latch (shared ruling
  with the plan's hysteresis question).
- Do `skin.markings`/tattoos need coverage-style occlusion of their own?
