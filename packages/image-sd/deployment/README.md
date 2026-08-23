# Vesper SDXL character renderer

This directory is the deployable Cog/ComfyUI implementation of Vesper's owned
SDXL renderer on Replicate. It accepts one normalized render request, builds the
frozen ComfyUI graph in `sd_workflow.py`, and returns one image.

The TypeScript contract that the rest of Vesper imports lives in
`../src/deployment/`. This directory is the provider image itself: Python,
ComfyUI, pinned model assets, recipes, build configuration, and deployment
checks.

For the package boundary and the broader Stable Diffusion design, see
[`../README.md`](../README.md) and
[`sd-rendering-package.plan.md`](../../../docs/developer-notes/sd-rendering-package.plan.md).

## What the renderer currently supports

One prediction can combine:

```text
prompt + negative prompt
        │
        ├── character LoRA ──────┐
        ├── identity reference ──┤  PuLID
        ├── depth map ───────────┤  ControlNet
        └── pose skeleton ───────┤  ControlNet
                                 ▼
                            SDXL sampling
                                 ▼
                            one output image
```

Implemented today:

- SDXL base generation;
- one optional character LoRA;
- one optional PuLID identity reference;
- optional preprocessed depth and OpenPose controls;
- deterministic seeds;
- named, revisioned recipes;
- custom width/height within the predictor's validated range.

Not implemented by this deployment:

- inpainting / masked repair;
- the planned low-denoise finishing pass;
- edge/Canny ControlNet;
- SD3.5 workflows.

Recipes that request an unsupported block are rejected rather than silently
running a different graph.

## Current recipes

`recipes.json` is generated from the `@vesper/image-sd` recipe registry. Do not
edit it by hand.

| Recipe | Purpose |
| --- | --- |
| `sdxl/base-portrait` | Vanilla SDXL control arm; no identity conditioning. |
| `sdxl/identity-portrait` | Default identity recipe; PuLID weight 0.80 and LoRA scale 0.80. |
| `sdxl/identity-portrait-w065` | Stage 3 weaker PuLID trial arm. |
| `sdxl/identity-portrait-w095` | Stage 3 stronger PuLID trial arm. |

The Stage 3 PuLID trial selected `sdxl/identity-portrait` at 0.80 as the
**provisional** identity recipe. The LoRA-only and LoRA+PuLID comparisons wait on
character LoRA training; the trial result, limitations, and evidence are in
[`sd-rendering-package.trial.md`](../../../docs/developer-notes/sd-rendering-package.trial.md).

## Input contract

The predictor deliberately uses snake_case field names already understood by
Vesper's Replicate capability probe.

| Input | Default | Notes |
| --- | --- | --- |
| `prompt` | required | Prompt authored by Vesper. |
| `negative_prompt` | `""` | No hidden negative prompt is injected. |
| `reference_image` | none | Identity reference; requires an identity-capable recipe. |
| `depth_image` | none | Already-preprocessed depth map, not a photograph. |
| `pose_image` | none | Already-preprocessed OpenPose skeleton render. |
| `lora_weights` | none | HTTP(S) URL ending in `.safetensors`. |
| `lora_scale` | recipe value | Optional override, validated from 0 to 4. |
| `seed` | random | Chosen seed is logged. |
| `width` | `832` | Must be 256–2048 and divisible by 8. |
| `height` | `1216` | Must be 256–2048 and divisible by 8. |
| `recipe` | `sdxl/identity-portrait` | Named recipe revision to resolve. |

### Identity is recipe-gated

A reference image only activates PuLID when the selected recipe carries an
`identityWeight`. Sending `reference_image` with `sdxl/base-portrait` is an
error; the predictor does not ignore the reference and does not invent a default
identity strength.

The default recipe is `sdxl/identity-portrait` because it safely collapses to the
base graph when neither a reference nor a LoRA is supplied. This lets the same
published schema handle both base and identity renders without making the
no-identity control recipe ambiguous.

### Control images are control maps

`depth_image` and `pose_image` are not source photographs. Vesper must preprocess
them before calling this model. The deployment loads the supplied files directly
into the corresponding ControlNet branches.

### LoRAs remain runtime assets

The SDXL, PuLID, InsightFace, facexlib, EVA-CLIP, and ControlNet assets are baked
into the container. Character LoRAs are different: they vary per character, so
`predict.py` downloads a requested LoRA on first use in a worker and caches it by
URL for later predictions on that worker.

## Cold-start behavior

Static model assets are downloaded and SHA-256 verified during **`cog build`**,
not during the first paid prediction. A correctly built worker therefore starts
with the renderer's immutable weights already present.

`Predictor.setup()` is still defensive and idempotent:

1. load `recipes.json` and `weights_manifest.json`;
2. resolve/check the expected static assets, downloading a missing artifact only
   as a fallback;
3. start ComfyUI;
4. wait for its API to become ready.

A cold worker still has to initialize Python/Torch/ComfyUI and load model data
into GPU memory. Baking the weights removes the large network transfer; it does
not make GPU initialization disappear.

If a Replicate cold start logs downloads of the base checkpoint, PuLID,
ControlNets, InsightFace, facexlib, or EVA-CLIP, treat that as a deployment
problem. Those assets should have been present in the built image. A character
LoRA download is expected when that LoRA has not yet been cached by the worker.

## Files that matter

| File | Purpose |
| --- | --- |
| `cog.yaml` | CUDA/Python build, pinned ComfyUI and PuLID revisions, PuLID patch, static weight bake. |
| `requirements.txt` | Direct Python dependency pins. |
| `frozen-requirements.txt` | Recorded transitive `pip freeze` closure for rebuild comparison. |
| `predict.py` | Cog input schema, runtime asset staging, ComfyUI process, prediction lifecycle. |
| `sd_workflow.py` | Pure workflow builder; the graph of record. |
| `recipes.json` | Generated deployed recipe data. |
| `weights_manifest.json` | Static artifact sources, target paths, filenames, and SHA-256 digests. |
| `workflows/*.json` | Reviewable snapshots of canonical graphs. |
| `scripts/check_weight_bake_sync.py` | Checks that `cog.yaml` bakes the artifacts pinned by the manifest. |
| `scripts/check_frozen_closure.py` | Compares a real image's Python closure with `frozen-requirements.txt`. |
| `scripts/generate_workflow_snapshots.py` | Regenerates canonical workflow snapshots. |

## Reproducibility rules

The deployment is intentionally more rigid than a normal ComfyUI installation.
A render should be explainable later from source, recipe revision, model version,
and seed.

### Static weights are pinned twice, with a tripwire

`weights_manifest.json` is the runtime/provenance declaration. `cog.yaml` also
contains the build-time URLs, filenames, and hashes so Cog can fetch those assets
while constructing the image.

That duplication is deliberate and mechanically checked. Run:

```bash
python scripts/check_weight_bake_sync.py
```

The root SD deployment test also checks the same invariant. If an artifact URL,
filename, or digest changes, update the manifest and the bake step together.

### Python dependencies have a recorded closure

`requirements.txt` contains direct pins. `frozen-requirements.txt` records the
full installed closure from the accepted build. After rebuilding, compare the
actual image:

```bash
cog exec python scripts/check_frozen_closure.py
```

Resolve any drift before promoting the image. If a dependency change is
intentional, update `frozen-requirements.txt` in the same change.

### The workflow is source, not uploaded JSON

Production does not accept arbitrary ComfyUI workflow JSON. `sd_workflow.py`
builds the graph from code and `recipes.json` supplies the versioned numbers.
Regenerate the review snapshots after changing either:

```bash
python scripts/generate_workflow_snapshots.py
```

`recipes.json` itself is regenerated from the repository root with:

```bash
pnpm tsx scripts/generate-sd-deployment-recipes.ts
```

### PuLID carries one guarded compatibility patch

The pinned PuLID node registers its middle-block attention replacement under a
key that does not match the pinned ComfyUI version. `cog.yaml` rewrites that
specific key at build time and checks both the expected pre-patch and post-patch
forms.

Do not weaken or bypass those guards when changing either pin. A failed guard
means the compatibility assumption must be re-verified against the new code.
The patched renderer is therefore not behaviorally identical to an unpatched
ComfyUI/PuLID deployment; keep that in mind when comparing identity results with
third-party models.

## Build and smoke-test

Run these commands from this directory.

First verify the duplicated weight declarations, build the image, and check its
Python closure:

```bash
python scripts/check_weight_bake_sync.py
cog build
cog exec python scripts/check_frozen_closure.py
```

Then run representative predictions. Use `cog run`:

```bash
# Base SDXL.
cog run \
  -i prompt="a photograph of a woman standing in a sunlit kitchen, natural light" \
  -i negative_prompt="blurry, low quality" \
  -i recipe="sdxl/base-portrait" \
  -i seed=1

# PuLID identity conditioning.
cog run \
  -i prompt="a photograph of a woman in a wool coat on a winter street" \
  -i reference_image=@./reference.png \
  -i seed=1

# Identity plus a character LoRA.
cog run \
  -i prompt="a photograph of a woman reading at a kitchen table" \
  -i reference_image=@./reference.png \
  -i lora_weights="https://example.invalid/character.safetensors" \
  -i lora_scale=0.8 \
  -i seed=1
```

Before pushing a new version, verify at minimum:

1. the same seed and inputs reproduce the same image;
2. the default recipe without reference/LoRA matches the base recipe at the same
   seed;
3. `sdxl/base-portrait` plus `reference_image` fails clearly;
4. the identity trial recipes produce visibly different conditioning at the same
   seed/reference;
5. a cold prediction does not download the static model bundle;
6. any changed depth/pose path gets its own smoke render rather than being
   assumed correct from a base portrait test.

## Deploy to Replicate

The Replicate model already exists. Push a new immutable version with:

```bash
cog push r8.im/ceponatia/sdxl-character-render
```

Do not treat a successful push as production promotion. Vesper pins model
versions through the image-model registry. Use the owner-admin
`/settings/image-models` candidate flow to:

1. **probe latest** and review the candidate capability diff;
2. **smoke-test** the candidate through an appropriate profile;
3. **activate version** only after the candidate passes.

That flow pins `owner/name:version` and updates the probed capability bindings
atomically. The registry/version process is documented in
[`docs/images/providers.md`](../../../docs/images/providers.md).

## Operational notes

- The renderer returns exactly one saved image per prediction.
- Input images are copied to unique per-prediction filenames and cleaned up after
  the render; the ComfyUI-side output is also cleaned up after it is copied to
  Cog's return path.
- Unknown recipes, unsupported recipe blocks, invalid dimensions, malformed LoRA
  URLs, and invalid identity/recipe combinations fail before or instead of
  returning a plausible-but-wrong image.
- A LoRA URL must be HTTP(S) and end in `.safetensors`.
- ComfyUI runs as a subprocess on localhost. `predict.py` owns startup, readiness
  polling, submission, history polling, and server-exit/failure detection.
- Prediction logs include the selected recipe/revision, seed, and resolved
  generation settings. Use those before debugging output by eye.

## Related documentation

- [`@vesper/image-sd` README](../README.md) — package ownership and boundaries.
- [`sd-rendering-package.plan.md`](../../../docs/developer-notes/sd-rendering-package.plan.md) — remaining implementation plan.
- [`sd-rendering-package.trial.md`](../../../docs/developer-notes/sd-rendering-package.trial.md) — current identity-strength verdict and limitations.
- [`docs/images/providers.md`](../../../docs/images/providers.md) — model registry, probing, profiles, and version promotion.
- [`evidence/sd-identity-matrix-r1/README.md`](../../../evidence/sd-identity-matrix-r1/README.md) — Stage 3 identity-matrix evidence structure.
