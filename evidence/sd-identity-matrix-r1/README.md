# Stage 3 identity matrix

Status: rendered and graded 2026-08-23 — verdict below.

The controlled matrix from sd-rendering-package.plan.md §20, Stage 3: base SDXL
against PuLID at three identity strengths, over 8 fixed scenes at fixed seeds.
Rendered by `scripts/eval/sd-identity-matrix.ts`.

- **Renderer version:** `bbf53f1aa12fe1254f9feae747786f3c9a03268171ac1933f67cfa744dcf9ef5` (`ceponatia/sdxl-character-render`)
- **Reference provenance:** identity pack `ihu1qupxkkqsibx0wp8frezt`
  (character Preeti, `t47d6hq4wzbxn48jnfoxaiuh`), source image
  `ffxc6f58zjvq36vxsmrucpja` (768×1024) — the owner's actively used comparison
  character with a ready, current identity pack. Re-fetch from the app's data
  volume to re-run.
- **Cells:** 32 (base / w065 / w080 / w095 x 8 fixtures)

The images beside this file are **local only** — `evidence/README.md` records the
owner ruling that generated imagery stays out of git history. `manifest.csv` and
`scores.csv` are tracked, and they are what a later reader actually has.

## The arms

- `base` — recipe `sdxl/base-portrait` (identity weight none). vanilla SDXL, no identity conditioning — what these prompts produce with no reference at all
- `w065` — recipe `sdxl/identity-portrait-w065` (identity weight 0.65). PuLID at 0.65 — the weak arm
- `w080` — recipe `sdxl/identity-portrait` (identity weight 0.80). PuLID at 0.80 — the recipe's current middle value
- `w095` — recipe `sdxl/identity-portrait-w095` (identity weight 0.95). PuLID at 0.95 — the strong arm

The `base` arm sends **no reference image**: the renderer refuses one under a
recipe with no identity weight, and conditioning the control at some default
strength would turn it into a fourth identity cell.

## The fixtures

- `front-portrait-neutral` (seed 110517) — Probes: face, age, hair. The anchor cell — the easiest render in the set, front-lit and frontal, so a likeness that fails HERE is not the fixture being unfair. Every other cell is read against this one: a face that is the reference's here and a stranger's under hard light is a finding about identity strength, while a face that is a stranger's in both is a finding about the arm.
- `full-body-standing` (seed 220931) — Probes: build, face, clothing_flexibility. Build is only gradeable with the whole figure in frame, and this framing is also where the face falls to a few dozen pixels — the distance at which identity conditioning has least to work with. Clothing is deliberately left unspecified, so the cell doubles as the unprompted-wardrobe question: asked for no outfit at all, does the render invent one or copy the reference's?
- `outfit-formal-overcoat` (seed 331408) — Probes: clothing_flexibility, face. The outfit is named in detail and chosen to be unlike anything an identity reference is likely to have been shot in. The failure this grades is the reference's own clothing bleeding into the render, which is expected to worsen as identity weight rises — the exact trade §8 says must not be hidden behind a single quality score.
- `pose-seated-forward` (seed 442760) — Probes: pose_flexibility, face. Identity adapters pull a render back toward the frontal, centred head crop they condition on. A body angled away with the head turned back is where that pull shows: the graded failure is a render that quietly straightens up and faces front, having ignored the pose to keep the face easy.
- `location-night-street` (seed 553219) — Probes: face, hair. The hostile lighting case, and the counterpart to front-portrait-neutral: hard coloured light off a wet street throws shadow across half the face and a colour cast over skin and hair. §8 asks for location flexibility, and this is where a likeness that only survives studio light comes apart.
- `expression-laughing` (seed 664085) — Probes: face, age, pose_flexibility. §8 names expression flexibility explicitly, and a strong expression deforms exactly the features an identity adapter locks — so both failure directions are legible in one image: the laugh flattens back toward neutral (identity too strong), or the laughing face stops being the reference's (identity too weak). Age rides along because apparent age is what a model most often shifts when it redraws a creased, animated face.
- `state-prosthetic-forearm` (seed 775642) — Probes: state_obedience, build. The authored state generic priors overwrite most reliably: asked for a prosthetic limb, a model draws two flesh arms and reports success. Graded on three things a reader can check — the prosthetic is present, it is on the stated arm, and it replaces the forearm rather than being worn over a hand. state_obedience is the Vesper-specific column no general image benchmark measures, and this is the body-level half of it.
- `state-face-dressing` (seed 886193) — Probes: state_obedience, face. The second state probe, and deliberately ON the face: identity conditioning rewrites the face region hardest, so an authored mark there is the one it is most likely to erase. Read beside state-prosthetic-forearm it separates two findings a single probe would confuse — a model that ignores authored state everywhere, and an identity adapter that only overwrites the face.

## How to grade

Open the four arms of one fixture side by side, then move to the next fixture.
Score each cell in `scores.csv`, one row per arm per fixture, on these seven
dimensions: face, age, hair, build, clothing_flexibility, pose_flexibility, state_obedience.

Scale used in `scores.csv`: **0** = absent or wrong, **1** = partly there,
**2** = right. Graded 2026-08-23, two graders, four complete fixtures each,
arms read side by side per fixture.

Two of these pull against each other by design, and that tension is the result
this run exists to measure: raising identity strength should improve `face` and
cost `clothing_flexibility` and `pose_flexibility`. A single quality score would
hide it and would name the strongest arm the winner every time.

`state_obedience` is the Vesper-specific column. Grade it only on
`state-prosthetic-forearm` (is the prosthetic present, on the stated arm,
replacing the forearm?) and `state-face-dressing` (is the dressing present, on
the stated cheek?), and leave it blank elsewhere — the other fixtures author no
state to obey.

## Verdict

Graded 2026-08-23: the provisional identity recipe is **`sdxl/identity-portrait`
(0.80)**. It matches or beats 0.65 on every dimension at no measured cost
(face 1.00 vs 0.86, hair 1.57 vs 1.43, all costs equal), while 0.95 buys a
small likeness gain (face 1.14) at prices that disqualify it: it erased the
authored face dressing outright (state_obedience 1.0 vs 1.5), collapsed
prompted poses toward frontal (pose 0.88 vs 1.12), and showed the worst
artifacts. Full reading, limitations (LoRA arms pending Stage 4, weak seeds to
re-roll), and next steps: `sd-rendering-package.trial.md` in developer-notes.

Status: rendered and graded 2026-08-23.
