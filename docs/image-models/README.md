# Image models

Per-model reference for every Replicate image model Vesper can run. One file per
model, recording the API attributes the render path depends on: what the model's
reference-image input is called, whether it takes one image or a list, how many,
how to get a 3:4 output out of it, and what it returns.

These files describe **the provider's API**, not Vesper's configuration. Which
models are actually offered, and on which surfaces, is data in the `image_models`
table and is managed from the admin page at `/settings/image-models` — see
[developer-notes/image-model-registry.plan.md](../developer-notes/image-model-registry.plan.md).
Adding a model to the app does not require adding a file here, but doing so is
the difference between a model we understand and one we merely call.

## Why these files exist

Replicate's schemas disagree with each other in ways that cannot be papered
over with one shared mapping:

- The reference input is called `image` on most models, `image_input` on two,
  `images` on another, and `reference_image` on one.
- On some models that field is a single URI; on others it is an array.
- Some models expose `aspect_ratio` and offer `3:4`. One offers `aspect_ratio`
  without `3:4`. One has no `aspect_ratio` at all and is driven by `size`. Three
  have no aspect input whatsoever and are sized by `width`/`height` integers the
  registry does not send yet — those renders are cropped to shape instead.
- Output is an array of URIs on nine of ten models, and a bare URI string on the
  remaining one.
- One model watermarks by default (`apply_watermark`), which the probe pins off.
- **Community models can only be run by version id.** The bare-slug endpoint is
  official-models-only, so a community model's registry row is auto-pinned to
  `owner/name:version` when it is added. That is why the three community models
  below carry a version in their stored slug and the official ones do not.
- **No model declares `maxItems` on its array reference input.** Reference caps
  are stated in prose in the field description, so they are recorded here and
  stored per row — they cannot be read from the schema.
- **One model rejects Replicate's own uploaded-file URLs.** Wan 2.7 reads the
  file extension off what it is handed, and an upload arrives without one, so
  its references must be inlined as `data:` URIs (`reference_transport` on the
  row). Nothing in a schema reveals this; it is learned by running the model.

## The models

| Model | Slug | Generate | Edit | References |
| --- | --- | --- | --- | --- |
| [Qwen Image 2512](qwen-image-2512.md) | `qwen/qwen-image-2512` | yes | yes (img2img) | 1 |
| [Qwen Image Edit 2511](qwen-image-edit-2511.md) | `qwen/qwen-image-edit-2511` | no | yes | 3 |
| [Seedream 4.5](seedream-4-5.md) | `bytedance/seedream-4.5` | yes | yes | 14 |
| [Seedream 5 Lite](seedream-5-lite.md) | `bytedance/seedream-5-lite` | yes | yes | 14 |
| [Stable Diffusion 3.5 Large](stable-diffusion-3-5-large.md) | `stability-ai/stable-diffusion-3.5-large` | yes | yes (img2img) | 1 |
| [Wan 2.7 Image Pro](wan-2-7-image-pro.md) | `wan-video/wan-2.7-image-pro` | yes | yes | 9 |
| [FLUX.1 dev](flux-dev.md) | `black-forest-labs/flux-dev` | yes | yes (img2img) | 1 |
| [Juggernaut XL v9](juggernaut-xl-v9.md) | `lucataco/juggernaut-xl-v9` | yes | no | 0 |
| [Pony Realism v2.3](pony-realism-v2-3.md) | `nsfw-api/pony-realism-v2.3` | no | yes | 1 |
| [RealVis Hyper LoRA](realvis-hyper-lora.md) | `nsfw-api/realvis-hyper-lora` | no | yes | 1 |

## Moderation, by hosting model

Which models will refuse a render is not a property of the prompt — it follows
from how Replicate runs them:

- **Open weights on Replicate's GPUs** — the NSFW classifier is a component in
  the cog wrapper and `disable_safety_checker` removes it. Both Qwen models,
  FLUX dev, and Juggernaut XL v9 work this way; the two `nsfw-api` pipelines ship
  with no checker at all.
- **Vendor-API proxies** — moderation runs on the vendor's servers before
  Replicate sees a result, so no input can reach it. Wan 2.7 and Seedream 5 Lite
  refuse this way (`ContentModerationError`, and Wan's `Async prediction failed`
  prefix is the giveaway of a proxied call). Seedream 4.5 is the exception that
  proves the rule: BytePlus exposes a relaxation, so it takes the flag.

The flag only removes the classifier. What a model was *trained* to draw is a
separate ceiling, and the reason the SDXL-lineage fine-tunes here behave
differently from FLUX and Qwen at identical settings.

"Generate" means the model can run with no reference image. "Edit" means it has
a reference input at all — it does not promise identity preservation, which is a
separate quality judgement recorded in each file.

## Keeping these current

Replicate does not version this metadata: a model's `latest_version` can change
its input schema underneath a fixed slug. Each file records the version id it was
read from and the date. When a render starts failing on a payload that used to
work, re-probe before debugging Vesper:

```bash
curl -s -H "Authorization: Bearer $REPLICATE_API_TOKEN" https://api.replicate.com/v1/models/qwen/qwen-image-edit-2511 | jq '.latest_version.id, .latest_version.openapi_schema.components.schemas.Input'
```

The admin page's re-probe button does the same thing and writes the result back
to the row.
