# Character LoRA training — runbook and decisions

Status: detail for [sd-rendering-package.plan.md](sd-rendering-package.plan.md) (Stage 4)

How a Vesper character LoRA is trained, published, registered, and compared. The
plan owns why Stage 4 exists and what it must deliver; this doc owns how it is
run and every decision the build settled.

## The errand in one pass

Training is a paid, hand-supervised errand that runs a handful of times per
character. It is two scripts and one owner judgement in the middle.

```text
curate 12–20 images by hand           (owner)
        │
        ▼
scripts/train-sd-character-lora.ts    (paid: stages, trains, publishes, records)
        │
        ▼
scripts/register-sd-character-lora.ts (free: image_loras row + pack binding)
        │
        ▼
scripts/eval/sd-identity-matrix.ts    (paid: the graded comparison)
```

The two halves are separate scripts on purpose. Training is slow, expensive and
runs from wherever the dataset lives; registration is instant, free, and needs a
database URL. A typo in a library label must never cost a training run.

### 1. Curate the dataset

The plan's §8 asks for roughly 12–20 selected images spanning front,
three-quarter, profile, close face, upper body and full body, across varied
lighting, backgrounds and clothing — and, above all, without accidental
correlations ("this character always wears this shirt", "always appears in this
room"). No script can see any of that, so this step is entirely the owner's.

Put the images in a flat directory. Optionally add a manifest so the coverage
report can say what is missing:

```json
{
  "front-01.png": { "view": "front", "tags": ["daylight", "outdoors"] },
  "full-01.png":  { "view": "full_body", "tags": ["evening", "indoor"] }
}
```

Untagged images still train; they just count toward no view, and the run says so.

### 2. Train

```bash
pnpm tsx scripts/train-sd-character-lora.ts --dataset-dir ./sabrina --dataset-manifest ./sabrina.json --identity-pack-id <pack> --trigger-token sabrina --recipe sdxl/character-lora-r8 --destination ceponatia/sabrina-sdxl-r8 --create-destination --s3-bucket <bucket> --dry-run
```

`--dry-run` stages the dataset, prints the curation report and the exact training
request, and makes no network call. Drop it and add `--yes` to spend.

Run it twice — once per rank — changing only `--recipe` and `--destination`. That
is the comparison.

### 3. Register

```bash
pnpm tsx scripts/register-sd-character-lora.ts --result ./sd-lora-training-output/<training-id>/training-result.json --label "Sabrina — SDXL rank 8"
```

Creates the `image_loras` row and the `image_identity_lora_bindings` row. The
binding lands `experimental`; `--activate` promotes it and fails loudly if the
pack already has a promoted binding.

### 4. Grade

```bash
pnpm tsx scripts/eval/sd-identity-matrix.ts --version <renderer-version> --reference ./anchor.png --lora r8=<url> --lora r16=<url> --dry-run
```

Each `--lora` adds two arms: the LoRA alone (`sdxl/lora-portrait`) and the LoRA
with PuLID at 0.80 (`sdxl/identity-portrait`). Passing both ranks runs Stage 3's
two missing arms and Stage 4's rank comparison in one matrix, over the same
fixtures and seeds the graded PuLID run used.

## What the package owns

`packages/image-sd/src/training/` holds the training recipes, the dataset
manifest contract, the fingerprint and the curation assessment. Two seeded
recipes, differing in exactly one value:

| Recipe                     | Rank | Steps | Resolution | Batch |
| -------------------------- | ---- | ----- | ---------- | ----- |
| `sdxl/character-lora-r8`   | 8    | 1000  | 1024       | 4     |
| `sdxl/character-lora-r16`  | 16   | 1000  | 1024       | 4     |

Both train against `stabilityai/stable-diffusion-xl-base-1.0` — the deployed
renderer's checkpoint, because a LoRA is only valid on the weights it was trained
against. Every value is a trial starting point; the winning rank becomes revision
2 of a single `sdxl/character-lora` recipe and the loser retires.

A test derived from the registry fails if the two arms ever differ in anything
but rank. That is the invariant the whole comparison rests on, and it is invisible
in a diff that touches one literal.

## Decisions this build settled

### The trainer is `stability-ai/sdxl`, pinned

Probed live 2026-08-23; version `7762fd07cf82…`. It is the official SDXL
fine-tuner, it exposes `lora_rank` as a training input, and it returns a
`weights` archive. The community forks on Replicate are all forks of this same
Cog. Pinned rather than tracking latest for the reason every model version here
is pinned, and with more force: Stage 4 *is* a comparison, so a trainer that
moved between the two runs would make the arms differ in something nobody chose.

### The trained textual-inversion embeddings are discarded

The trainer runs a pivotal-tuning pipeline: it learns a LoRA *and* an embedding
for the trigger token, and ships both in one archive. Vesper publishes only
`lora.safetensors`.

Two reasons, and they agree. Plan §22 makes textual inversion a non-goal of the
first training pass. And the deployed renderer has no embedding loader — it loads
LoRA weights and nothing else — so a token trained as an embedding would be a
prompt word pointing at nothing.

The consequence is why `--trigger-token` should be an **ordinary word**, normally
the character's first name, rather than the trainer's default `TOK`. The LoRA is
trained on captions containing the token; at render time that token resolves
through the base text encoder. A real word already means something close to the
right thing there. `TOK` means nothing at all.

### The trainer writes its own captions

`stability-ai/sdxl` captions the dataset itself from a caption prefix; it does not
read caption sidecars. A caption authored in the dataset manifest therefore
changes the dataset **fingerprint** — correct, it is a different curation — while
changing nothing about the training run. The script says so rather than letting
that pass silently.

### Cropping is a flag, not a recipe field

`--use-face-detection` is off by default. Turning it on crops every image to a
detected face, which would destroy the full-body and upper-body framings §8 asks
for and leave a LoRA that never learned a build. It stays available because a
head-and-shoulders-only dataset genuinely wants it. Both arms of a comparison must
use the same flags; the exact trainer input is recorded in `training-result.json`
so a difference is visible afterwards.

### The weights are published to S3

The renderer fetches `lora_weights` with a plain unauthenticated request from
inside a Replicate container, so the object must be readable with no credential.
Replicate's own Files API cannot host it: those URLs expire after 24 hours and
answer 401 to an anonymous request (probed 2026-08-23). The script uploads through
the AWS CLI using whatever profile the operator's shell already has — no AWS
credential or SDK enters this repository — and then verifies the published URL is
anonymously readable, because a private object produces a LoRA that looks
perfectly registered and fails every render naming it, after billing each one.

### The dataset fingerprint is over names and content

An image's `id` in the manifest is its **file name** — the only stable handle a
hand-curated directory has, and the one the curator sees. Its `uri` is the
**content hash**, not a path: a path would make the fingerprint depend on which
machine ran the training, and swapping one photograph for another under the same
file name would go unnoticed.

### The binding points at a pack revision

`image_identity_lora_bindings` names an `image_identity_packs` row, not a
character. Supersession is the entire staleness signal: a LoRA trained from
revision 3 keeps rendering perfectly after revision 4 becomes current, it just
stops being a likeness of the character every other surface describes. Nothing
errors, so the drift has to be readable from a row.

Several bindings per pack are normal — the rank comparison needs two at once, both
`experimental` — and at most one may be `active`, held by a partial unique index
rather than by application discipline. A losing arm is `retired`, never deleted,
so an image rendered under it can still say what produced it.

The pure rule (`evaluateIdentityLoraBinding` in `@vesper/image-core`) deliberately
treats `experimental` as **usable**. It means "not yet promoted", not "not yet
valid"; a rule that refused an unpromoted binding would make promotion impossible,
because nothing could ever be rendered into being the winner.

## Before the LoRA arms can run

`sdxl/lora-portrait` — the LoRA-only arm's recipe — was added to the registry with
Stage 4, and `deployment/recipes.json` is generated from that registry and **baked
into the container image**. The predictor refuses a recipe id it does not carry.

So the deployment must be pushed again before any `lora-*` arm will render. The
push runbook is `packages/image-sd/deployment/README.md`. The rank comparison's
`identity-lora-*` arms use `sdxl/identity-portrait`, which the deployed build
already carries, but they are graded against the LoRA-only arms, so in practice
the push comes first.

## What Stage 4 deliberately did not build

- **No admin UI and no API route.** The binding is written by operator tooling
  only. Stage 8 connects the profile and picker path; a promotion control over a
  binding nothing renders with yet would be a control over nothing.
- **No render-lane consumption.** No production lane reads a binding. The LoRA
  reaches a render through the Image Lab and the eval harness, which is what
  "still experimental" means in the plan.
- **No dataset-from-the-database path.** Image bytes live on the Fly volume and
  curation is a human judgement, so the pipeline takes a local directory and
  records the pack id it was curated from. If curation is ever automated, the
  fingerprint is already the field that would compare two curations.

## Open questions

None. Questions this work raised are recorded as decisions above.
