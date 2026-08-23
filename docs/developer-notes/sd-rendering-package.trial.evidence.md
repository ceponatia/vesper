# SD identity strength trial — evidence

Status: detail for [sd-rendering-package.trial.md](sd-rendering-package.trial.md)

## Run

- **Date:** 2026-08-23.
- **Renderer:** `ceponatia/sdxl-character-render`, version
  `bbf53f1aa12fe1254f9feae747786f3c9a03268171ac1933f67cfa744dcf9ef5` (the
  pre-freeze build; behaviorally identical to the frozen
  `6c594f76f7b59d680c2c739f0a8e2107e42d8137244a6e4ad1e02c6e0e86d263` that is
  registered in Vesper — the freeze only recorded weight digests and the pip
  closure).
- **Harness:** `scripts/eval/sd-identity-matrix.ts`; 32/32 cells succeeded,
  ~11 s per warm render on L40S. Per-cell prediction ids, seeds, and recipes:
  `evidence/sd-identity-matrix-r1/manifest.csv`.
- **Reference:** identity pack `ihu1qupxkkqsibx0wp8frezt` (character Preeti,
  `t47d6hq4wzbxn48jnfoxaiuh`), source image `ffxc6f58zjvq36vxsmrucpja`
  (768×1024). Chosen as the owner's actively used comparison character with a
  ready, current identity pack.
- **Arms:** `base` = `sdxl/base-portrait` (no reference sent — the renderer
  refuses a reference under a no-identity recipe); `w065` / `w080` / `w095` =
  `sdxl/identity-portrait-w065` / `sdxl/identity-portrait` /
  `sdxl/identity-portrait-w095` (identity weights 0.65 / 0.80 / 0.95), each
  sent the reference. LoRA inputs: none (no SDXL character LoRA exists before
  Stage 4).

## Grading

Two graders, four complete fixtures each (all four arms per fixture, read side
by side), scored 0/1/2 against the reference photo per the protocol in
`evidence/sd-identity-matrix-r1/README.md`. `state_obedience` graded only on
the two state fixtures. The merged sheet is
`evidence/sd-identity-matrix-r1/scores.csv` (32 rows).

Per-arm means (dimension: mean over graded cells):

| Arm  | face | hair | build | clothing_flex | pose_flex | state_obedience |
| ---- | ---- | ---- | ----- | ------------- | --------- | --------------- |
| base | 0.00 | 0.25 | 0.00  | 2.00          | 1.50      | 1.00            |
| w065 | 0.86 | 1.43 | 0.14  | 1.88          | 1.12      | 1.50            |
| w080 | 1.00 | 1.57 | 0.14  | 1.88          | 1.12      | 1.50            |
| w095 | 1.14 | 1.86 | 0.14  | 1.75          | 0.88      | 1.00            |

`age` scored ~2.0 on every identity arm but is a weak column: SDXL's default
subject for "a person" is a young adult, which happens to match the reference,
so the control also scored well where a face was visible.

## Key per-cell findings

- `state-face-dressing`: base 1 (dressing on the wrong location), w065 1
  (translucent ghost, correct cheek), w080 1 (solid strip, correct cheek,
  wrong form), w095 **0 — erased entirely**. The face-level authored state is
  overwritten by the identity adapter specifically, hardest at 0.95.
- `state-prosthetic-forearm`: all three identity arms 2 (below-elbow socket on
  a flesh upper arm); base 1 (glove over an intact hand — the arm never ends).
  All four arms framed out the torso, so "on the stated arm" was uncheckable.
- `location-night-street`: identity strength paid off monotonically — w095
  held the reference's updo and warm skin through hard neon and half-shadow,
  the strongest identity cell in the run; base rendered a hooded figure facing
  away (clean null).
- `expression-laughing`: only base laughed. All identity arms substituted the
  reference photo's parted-lip expression, indistinguishably across weights.
  Seed rendered every arm in black and white (skin/hair color ungradeable).
- `pose-seated-forward`: all arms drifted into a sepia cabinet-card style with
  the mounted border the negative prompt bans; identity arms lost the
  three-quarter lean, worst at w095 (fully frontal).
- `outfit-formal-overcoat`: seed produced a distant back view in 3 of 4 arms
  (no face to grade); w095 was the only arm that turned the subject to face
  the camera — the clearest composition-override event in the run — and also
  invented a maroon beanie.
- Wardrobe bleed overall: mild (a strapless silhouette in the anchor portrait,
  the possible red-scarf echo at night, the beanie at 0.95). The dominant cost
  of weight was pose/expression, not clothing.

## Weak fixtures to re-roll

`outfit-formal-overcoat` (seed 331408: subject faces away, face ungradeable),
`pose-seated-forward` (seed 442760: period-photo drift, banned border in all
arms), `expression-laughing` (seed 664085: black-and-white). The prosthetic
fixture needs a framing that keeps the torso in frame so the stated-arm check
is answerable.

## Renderer caveat

The deployed renderer patches the PuLID node's dead middle-block attention
registrations at build time (owner ruling 2026-08-23, recorded in the plan and
`packages/image-sd/deployment/README.md`), so identity conditioning here is
stronger than the public ComfyUI PuLID baseline, including
`nsfw-api/sdxl-pulid`. Grades from this run do not transfer to that model.
