# The Vesper SDXL character renderer

This directory is a complete Cog deployment: the Vesper-owned Stable Diffusion
model on Replicate, conceptually `vesper/sdxl-character-render`. It builds a
container holding a pinned ComfyUI, a pinned PuLID custom node, and a predictor
that turns one Vesper render request into one image. See §3, §5 and §20 Stage 2
of [sd-rendering-package.plan.md](../../../docs/developer-notes/sd-rendering-package.plan.md).

**Nothing here has run on a GPU yet.** The graph, the pins and the runbook have
been reviewed and the pure builder has been exercised, but the first `cog build`
and `cog predict` are the owner's, and they are what turn this from a reviewable
deployment into a working one. Read the [Freeze](#3-freeze) section before the
first push — several values are deliberately left to be recorded at that moment
rather than guessed now.

Do not confuse this folder with `../src/deployment/`. That holds the renderer's
**input contract** — the TypeScript schema Vesper builds requests against, part
of the package's public API. This folder holds the **renderer itself**. One is
what callers see, the other is what runs.

## What it is

One prediction internally does all of this:

```text
prompt + negative prompt
        │
        ├── character LoRA ──────┐
        ├── identity reference ──┤   (PuLID)
        ├── depth map ───────────┤   (ControlNet)
        └── pose skeleton ───────┤   (ControlNet)
                                 ▼
                            SDXL sampling
                                 ▼
                            one output image
```

From Vesper's side that was a single image render, with one cost line, one
provenance record and one retry. That is the plan's §5 design rule —
**complexity belongs inside the renderer** — and it is why the ordinary render
path needs no Stable Diffusion branch: the deployment registers as a normal
`image_models` row, the existing capability probe reads its published input
schema, and its profiles appear in the existing pickers.

The graph is **frozen into source**, not executed as data. A workflow edited in a
browser and submitted as JSON has no version, no review and no way to answer
"what produced this image" six months later, and a node quietly upgraded
underneath it changes every render with nothing in any diff. Here the graph is
`sd_workflow.py`, the numbers come from a named recipe revision, and both are in
git.

## What is here

| File | What it is |
| --- | --- |
| `cog.yaml` | The build: CUDA, Python, torch, ComfyUI and PuLID, each at an exact revision. |
| `requirements.txt` | Direct Python dependencies, pinned. ComfyUI's own come from its pinned checkout. |
| `predict.py` | The Cog predictor: the public input contract, weight staging, the ComfyUI server, one image out. |
| `sd_workflow.py` | The graph, as a pure function. Stdlib only — no torch, no ComfyUI, no IO. |
| `recipes.json` | The recipe registry, generated from TypeScript. Never hand-edited. |
| `weights_manifest.json` | Every model artifact, its source URL, where it lands, and its digest. |
| `workflows/*.json` | Reviewable snapshots of the built graph for five canonical requests. |
| `scripts/generate_workflow_snapshots.py` | Rebuilds those snapshots. Also the builder's smoke test. |

### Generated files

`recipes.json` is written by `pnpm tsx scripts/generate-sd-deployment-recipes.ts`
from the repository root. `scripts/sd-deployment-recipes.test.ts` runs in the
ordinary pure suite and fails if it goes stale, because a deployed renderer
running last month's numbers while provenance records this month's revision is
exactly the failure the recipe contract exists to prevent.

`workflows/*.json` is written by `python3 scripts/generate_workflow_snapshots.py`
from this directory. Regenerate and commit after any change to `sd_workflow.py`,
`recipes.json` or `weights_manifest.json`.

## The input contract

Field names are snake_case on purpose: they are the vocabulary Vesper's Replicate
capability probe already reads.

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `prompt` | string | — | Authored by Vesper. |
| `negative_prompt` | string | `""` | Authored by Vesper (§19); this model injects nothing. |
| `reference_image` | uri | none | Identity anchor. Present ⇒ PuLID runs. |
| `depth_image` | uri | none | An already-preprocessed depth map. |
| `pose_image` | uri | none | An already-preprocessed OpenPose skeleton render. |
| `lora_weights` | string | none | URL of one `.safetensors` character LoRA. |
| `lora_scale` | number | recipe's | 0–4. Overrides the recipe. |
| `seed` | integer | random | Same seed + same inputs ⇒ same image. The chosen seed is logged. |
| `width` / `height` | integer | 832 / 1216 | Multiples of 8. |
| `recipe` | string | `sdxl/identity-portrait` | Which frozen recipe to run. |

**`recipe` has a default, and the default is the identity recipe.** The Advanced
Image Lab reaches a registered model by typing its slug and cannot send a
`recipe` input, so whatever the default is becomes what every lab run gets.
`sdxl/identity-portrait` degrades *exactly* to `sdxl/base-portrait` when no
reference image and no LoRA arrive — its extra fields only configure branches
those inputs create — so the default costs a base render nothing and saves an
identity render from silently running with no identity.

### Control images are already preprocessed

`depth_image` and `pose_image` are **control maps, not photographs**. This
deployment ships no preprocessors and never will: Vesper's Advanced Image Lab
already owns depth and pose extraction, and the plan (§11) promotes that into a
shared server-side service rather than duplicating it inside a provider image.

This differs from the third-party `nsfw-api/sdxl-pulid` model Vesper also runs,
which converts an ordinary RGB image to depth internally. Sending this model a
photograph where it expects a depth map produces a render conditioned on the
photograph's luminance — a plausible image, wrong for a reason nothing reports.

## What Stage 2 implements, and what it defers

Implemented: SDXL checkpoint, prompt and negative prompt, native 832×1216, PuLID
identity conditioning, one LoRA, optional depth ControlNet, optional pose
ControlNet, deterministic seed, recipe selection.

Deferred, and **refused rather than ignored** — a recipe carrying one of these
fails the prediction with a sentence naming it:

- **Inpainting and repair** (`inpaint`), and therefore `mask_image` and
  `source_image`, which are absent from the predictor's inputs entirely. §12 is
  explicit that inpainting is a repair mechanism rather than the normal route
  for changing authored state; it arrives in Stage 7.
- **The low-denoise finishing/upscale pass** (`finishing`). Also Stage 7, and
  only if the comparison there proves it improves detail without moving identity.
- **The edge/Canny ControlNet.** §11 puts it behind "only if trials prove
  useful".
- **SD3.5.** The recipe vocabulary carries an `sd35/*` namespace because the
  contract has to; this deployment has SDXL nodes and refuses anything else.

Silence would be worse than refusal here. The recipe id is what render
provenance records, so a quietly dropped finishing pass would leave that id
describing an image it never produced.

## 1. Build

Run everything below from **this directory**.

```bash
cog build
```

That clones ComfyUI at `72865f4f27eaf5396f8f36370e0a2be3a9a090ee` (v0.33.1) and
cubiq/PuLID_ComfyUI at `93e0c4c226b87b23c0009d671978bad0e77289ff`, and installs
the pinned Python dependencies. No weights are baked in — `setup()` fetches them
per `weights_manifest.json` on first boot, idempotently, so a rebuild does not
re-download ~15 GB and a warm container touches the network only for a LoRA it
has not seen.

`cog.yaml` uses `predict:`, which current Cog documents as a deprecated
compatibility field for `run:`/`BaseRunner`. That is deliberate: the predictor is
a `BasePredictor` with `setup()`/`predict()`, which still works, and migrating it
(`cog doctor --fix`) is a mechanical change that should land on its own rather
than inside the build that first proves this renderer works.

## 2. Local smoke test

The first prediction downloads every artifact, so give it time and disk.

```bash
# Base render — no identity, no controls.
cog predict \
  -i prompt="a photograph of a woman standing in a sunlit kitchen, natural light" \
  -i negative_prompt="blurry, low quality" \
  -i recipe="sdxl/base-portrait" \
  -i seed=1

# Identity conditioning from a reference.
cog predict \
  -i prompt="a photograph of a woman in a wool coat on a winter street" \
  -i reference_image=@./reference.png \
  -i seed=1

# Identity plus a trained character LoRA.
cog predict \
  -i prompt="a photograph of a woman reading at a kitchen table" \
  -i reference_image=@./reference.png \
  -i lora_weights="https://example.invalid/character.safetensors" \
  -i lora_scale=0.8 \
  -i seed=1

# Identity plus depth control. `depth.png` must ALREADY be a depth map.
cog predict \
  -i prompt="a photograph of a woman seated by a window" \
  -i reference_image=@./reference.png \
  -i depth_image=@./depth.png \
  -i seed=1
```

Check three things before going further:

1. **Determinism.** The same seed and inputs twice produce the same image.
2. **Degradation.** The default recipe with no reference and no LoRA produces the
   same image as `recipe=sdxl/base-portrait` at the same seed. If it does not,
   the identity recipe is not degrading cleanly and the lab's default is wrong.
3. **Refusal.** An unknown recipe id fails with the list of known ids rather than
   rendering something.

## 3. Freeze

Do this once, on the first build that works, and commit the result.

1. **Record every digest.** For each artifact in `weights_manifest.json`, take
   the sha256 of the downloaded file and write it into the `sha256` field. From a
   running container: `sha256sum /ComfyUI/models/checkpoints/*.safetensors` and so
   on for each `target_dir`. Every one is null today and marked
   `FROZEN-AT-FIRST-BUILD`; once filled, a mismatch fails the boot loudly instead
   of rendering with a file that quietly moved.
2. **Record the transitive Python closure.** `requirements.txt` pins only direct
   dependencies. Run `pip freeze` inside the built image and append the full
   output, so a resolver cannot move a transitive package underneath a frozen
   renderer. This is the second `FROZEN-AT-FIRST-BUILD` marker — `grep -rn
   FROZEN-AT-FIRST-BUILD .` finds both.
3. **Consider mirroring the weights.** Every `source_url` points at a third party.
   Hugging Face repositories are renamed, made private and deleted; a renderer
   that cannot rebuild is a renderer that cannot be revised. Re-host the frozen
   artifacts at a durable Vesper-owned address and repoint `source_url` — the
   existing precedent for frozen artifacts is `s3://snarebox-pub/lora/…`. Keep the
   original URL in the artifact's `notes` so provenance survives the move.
4. **Confirm the ControlNet load path.** The two xinsir ControlNets are published
   in diffusers layout (`diffusion_pytorch_model.safetensors`, renamed on
   download). ComfyUI reads that layout, but this specific pair has not been
   loaded here yet — confirm the first depth render actually applies control
   rather than logging a load warning and sampling unconditioned.

## 4. Deploy

Create the model, then push the image.

```bash
# List the current GPU SKUs — do not assume yesterday's names still exist.
curl -s -H "Authorization: Bearer $REPLICATE_API_TOKEN" \
  https://api.replicate.com/v1/hardware

# Create it PRIVATE. `hardware` is the SKU predictions run on, so it must be a
# GPU here (unlike the LoRA training destination in
# scripts/train-image-lora.ts, which is an inert shelf and uses `cpu`).
curl -s -X POST https://api.replicate.com/v1/models \
  -H "Authorization: Bearer $REPLICATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "owner": "<your-replicate-owner>",
        "name": "sdxl-character-render",
        "visibility": "private",
        "hardware": "<a GPU sku from the call above>",
        "description": "Vesper-owned SDXL character renderer (PuLID + LoRA + ControlNet)"
      }'

cog push r8.im/<your-replicate-owner>/sdxl-character-render
```

`cog push` prints the resulting version hash. **Write it down** — it is what
Vesper pins, and it is the only way to tell two builds of this directory apart.

## 5. Register it in Vesper

The deployment is offered to the **Advanced Image Lab only** at this stage
(plan §20, Stage 2). It becomes a portrait/variant/chat option in Stage 8, and a
scene option no earlier than Stage 9.

1. **Add the model.** As the owner-admin, `POST /api/admin/self/image-models`
   with `{"slug": "<owner>/sdxl-character-render", "surfaces": []}`. The model is
   non-official, so the route probes it and stores the slug auto-pinned to
   `owner/name:version`; passing the pinned form yourself works too and is worth
   doing when you already have the hash from `cog push`.
   - The probe requires `prompt` in the published schema and binds
     `negative_prompt`, `seed`, `lora_weights`, `lora_scale` and integer
     `width`/`height` as controls. It picks `reference_image` as the primary
     reference and deliberately deprioritises `depth_image` and `pose_image`, so
     a control map is never mistaken for an identity reference.
2. **Create no profiles.** Zero profile rows is what makes it lab-only: profiles
   are how a model reaches the player-facing pickers.
3. **Set the reviewed fields.** `PATCH /api/admin/self/image-models/<id>`:
   - `operatorWarning`: something like *"Experimental Vesper-owned SDXL renderer.
     `depth_image` and `pose_image` must already be depth/pose maps — this model
     runs no preprocessors. Untuned: every recipe value is a Stage 3 starting
     point."*
   - `editKind`: `identity_conditioned`. §17 added that value because none of the
     others describes an identity adapter, and PuLID pipelines previously had to
     register as `unknown`.
   - `identityPreservation`: leave it alone until Stage 3 has graded output.
     Nothing here has been looked at yet, and this rating gates the
     identity-critical tasks.
4. **Write the model doc.** After the first successful probe, add
   `docs/image-models/sdxl-character-render.md` following that folder's README —
   what the reference input is called, whether it takes one image or a list, how
   output is shaped, and anything surprising about the schema.

## Reference: what is pinned, and what was checked

| Thing | Pin | Verified against |
| --- | --- | --- |
| ComfyUI | `72865f4f27eaf5396f8f36370e0a2be3a9a090ee` (v0.33.1, 2026-08-13) | The repository's release list and the tag's `requirements.txt`. |
| PuLID node | `93e0c4c226b87b23c0009d671978bad0e77289ff` (2025-04-14) | `cubiq/PuLID_ComfyUI`, the latest commit on `main`. |
| Node class names | `PulidModelLoader`, `PulidEvaClipLoader`, `PulidInsightFaceLoader`, `ApplyPulid` | The node's `NODE_CLASS_MAPPINGS`, and each class's `INPUT_TYPES`. |
| Core node inputs | `CheckpointLoaderSimple`, `CLIPTextEncode`, `LoraLoader`, `ControlNetLoader`, `ControlNetApplyAdvanced`, `KSampler`, `EmptyLatentImage`, `VAEDecode`, `SaveImage`, `LoadImage` | ComfyUI `nodes.py` at v0.33.1. |
| Sampler / scheduler names | The five samplers and four schedulers the recipe contract allows | `comfy/samplers.py` at v0.33.1 — all nine exist, so the mapping is identity. |
| Weight URLs | Every `source_url` in `weights_manifest.json` | Each repository's file listing; the facexlib URLs come from facexlib's own source. |

The PuLID node's author declared it "maintenance only" in April 2025. That is a
reason to pin it rather than a reason to avoid it: the node's behaviour is now
stable, and moving off it becomes a deliberate decision rather than something
that happens on a rebuild.

It also means one upstream defect is pinned in with it, and it is invisible
rather than fatal. `ApplyPulid` registers its attention patches under the keys
`("input", id, i)`, `("output", id, i)` and `("middle", 1, i)`, but ComfyUI sets
the middle block's key to `("middle", 0)` — so ten of the seventy patch sites
never fire and identity conditioning is applied at the input and output
cross-attention blocks only. Nothing logs this; the render succeeds and identity
is simply weaker than the reference PuLID implementation would give. The same is
true of every ComfyUI PuLID pipeline built on this node, including the
third-party `nsfw-api/sdxl-pulid` model §21 compares against, so the comparison
stays fair — but a Stage 3 identity score read as "PuLID's ceiling" would be
wrong. Fixing it means carrying a patch against the vendored node, which is a
deliberate decision and not one this deployment takes on its own.
