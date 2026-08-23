# SD identity strength (plan Stage 3, PuLID arms) — trial result

Status: closed — provisional winner `sdxl/identity-portrait` (0.80), 2026-08-23; LoRA arms still pending Stage 4

A stakeholder summary of the Stage 3 identity-strength run for
`sd-rendering-package.plan.md`. Identifiers, prediction records, and the
cell-by-cell grades live in the evidence appendix —
[sd-rendering-package.trial.evidence.md](sd-rendering-package.trial.evidence.md).

## Verdict

**The provisional identity recipe is the existing `sdxl/identity-portrait` at
identity weight 0.80.** It matched or beat the weaker 0.65 arm on every
dimension at no measured cost, while the stronger 0.95 arm bought a small
likeness gain at prices Vesper cannot pay: it erased an authored face-level
state outright, collapsed prompted poses toward a frontal portrait, and showed
the worst rendering artifacts. Pass-with-limits: PuLID alone reaches "styled
like her", not "recognizably her" — the trained character LoRA (Stage 4) is
what the remaining gap needs, exactly as the plan's identity architecture
predicted.

## What we tried

Four arms — plain SDXL with no identity input, and PuLID identity conditioning
at 0.65, 0.80, and 0.95 — each rendered the same eight fixed scenes at fixed
seeds through the newly deployed Vesper renderer, using one existing identity
pack's reference photo. Two graders scored all 32 images against the actual
reference on seven dimensions (face, age, hair, build, clothing flexibility,
pose flexibility, state obedience) on a 0/1/2 scale, reading the four arms of
each scene side by side. The no-identity arm is the control: it confirms both
that the renders don't resemble the reference by accident and what the prompts
produce when nothing pulls at them.

## What a player would notice

- **The character is styled like herself everywhere.** Hair worn up with
  face-framing strands, brows, eye makeup, lip fullness, and skin warmth carry
  into new outfits, new poses, and even harsh nighttime street light — where
  the likeness actually got stronger with weight, not weaker.
- **But she is not yet unmistakably herself.** Face shape, skin tone, and body
  type drift toward a generic slender ideal at every weight; no render earned
  a "this is her" face score. Body type never transferred at all.
- **She wears the reference photo's expression.** Every identity render copied
  the reference's parted-lip expression regardless of what was asked for — a
  laugh was flattened, a neutral face was not neutral. Lowering the weight did
  not buy the expression back.
- **At 0.95, authored looks start losing.** A small authored dressing on the
  cheek — the kind of state Vesper's world model owns — was erased completely
  at 0.95, while body-level authored state (a prosthetic forearm) held at
  every identity weight. At 0.80 and below the face-level state survived in
  degraded form.

## Limitations

- **The LoRA-only and LoRA+PuLID arms of the plan's Stage 3 matrix did not
  run** — no SDXL character LoRA exists until Stage 4 trains one. This verdict
  selects the provisional PuLID configuration only; the full Stage 3 matrix
  completes after Stage 4.
- **One reference, one character.** The run used a single identity pack, so it
  cannot say how the weights behave across face types, skin tones, or
  less styled reference photos.
- **Three scenes were weakened by their seeds** — one turned the subject away
  from the camera, one drifted into a period-photo style that ignored parts of
  the prompt, one rendered in black and white — and one state probe framed out
  the detail needed for one of its checks. Re-rolled seeds are needed before
  this grading is treated as more than provisional.
- **The renderer's identity conditioning is deliberately stronger than the
  public PuLID baseline** (the build-time patch the owner ruled on), so these
  numbers do not transfer to the third-party PuLID model Vesper also runs.

## Next steps

- `sdxl/identity-portrait` (0.80) stands as the provisional identity recipe;
  the 0.65 and 0.95 trial arms stay in the registry until Stage 3 fully closes
  with the LoRA arms, then retire per the registry's own rule.
- **Proceed to Stage 4 (character LoRA training)** — every likeness gap this
  run found (face geometry, skin tone, build) is the layer the LoRA owns.
  `sd-rendering-package.plan.md` owns that work.
- **Curate identity-pack anchors toward neutral, closed-mouth references** —
  the adapter copies the reference's expression wholesale, so the anchor photo
  chooses the character's default expression. This guidance belongs wherever
  identity-pack curation is documented when Stage 4 builds on it.
- Re-roll the weak fixture seeds before the next graded run.

## Evidence

[sd-rendering-package.trial.evidence.md](sd-rendering-package.trial.evidence.md) —
run identifiers, arms, per-cell grades, grader protocol, and the deployment
versions involved. The tracked grades are
`evidence/sd-identity-matrix-r1/scores.csv`; images are local-only per
`evidence/README.md`.
