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

Each entry gives the slug, the mechanical capability, the reference cap, and then
the two reviewed ratings (edit kind · identity preservation). "Generate" means the
model can run with no reference image; "edit" means it has a reference input at
all. Neither promises identity preservation — that is the rating beside it
(§Reviewed capability).

Only the six seeded models carry reviewed ratings. The four below them are
reference docs for models Vesper *can* run but does not ship a row for: an admin
adds them from `/settings/image-models`, and they stay unrated until someone has
looked at their output.

- [Qwen Image 2512](qwen-image-2512.md) — `qwen/qwen-image-2512`. Generate yes,
  edit yes, 1 reference. `img2img` · `weak`. Vesper's new-portrait default.
- [Qwen Image Edit 2511](qwen-image-edit-2511.md) — `qwen/qwen-image-edit-2511`.
  Generate **no**, edit yes, 3 references. `instruction_edit` · `strong`. Vesper's
  variant and scene default.
- [Seedream 4.5](seedream-4-5.md) — `bytedance/seedream-4.5`. Generate yes, edit
  yes, 14 references. `multi_reference_compose` · `moderate`.
- [Seedream 5 Lite](seedream-5-lite.md) — `bytedance/seedream-5-lite`. Generate
  yes, edit yes, 14 references. `multi_reference_compose` · `strong`.
- [Stable Diffusion 3.5 Large](stable-diffusion-3-5-large.md) —
  `stability-ai/stable-diffusion-3.5-large`. Generate yes, edit yes, 1 reference.
  `img2img` · `weak`. Portrait studio only.
- [Wan 2.7 Image Pro](wan-2-7-image-pro.md) — `wan-video/wan-2.7-image-pro`.
  Generate yes, edit yes, 9 references. `multi_reference_compose` · `unknown`,
  plus an operator warning — its upstream moderation cannot be disabled.

Documented but not seeded — no row, and therefore no reviewed rating:

- [FLUX.1 dev](flux-dev.md) — `black-forest-labs/flux-dev`. Generate yes, edit yes
  (img2img), 1 reference.
- [Juggernaut XL v9](juggernaut-xl-v9.md) — `lucataco/juggernaut-xl-v9`. Generate
  yes, edit **no**, no references.
- [Pony Realism v2.3](pony-realism-v2-3.md) — `nsfw-api/pony-realism-v2.3`.
  Generate **no**, edit yes, 1 reference.
- [RealVis Hyper LoRA](realvis-hyper-lora.md) — `nsfw-api/realvis-hyper-lora`.
  Generate **no**, edit yes, 1 reference.

The last three are community models, so a row for them is stored under a pinned
`owner/name:version` slug — the bare-slug endpoint is official-models-only.

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

Wan 2.7's `operator_warning` names this for the one model where it bites hardest.
The rating vocabulary is deliberately silent about moderation: a model that
refuses is not a model that renders a stranger, and conflating the two would take
Wan out of service for a reason that has nothing to do with identity.

## Reviewed capability

Two facts on each row are **not** probed, because no schema states them:
`edit_kind` (what "editing" actually does — `instruction_edit`,
`multi_reference_compose`, `img2img`, `none`, or `unknown`) and
`identity_preservation` (`strong` / `moderate` / `weak` / `unknown`, how well a
face survives). A third, `operator_warning`, is free text bound for the admin card
and the pickers — no surface renders it yet. These are human ratings from looking at
output; **a re-probe must
never overwrite them**, and `unknown` is permissive so an unreviewed row keeps
working as it does today. Each file records its model's ratings and the reasoning.

The rule they feed is already written, though nothing runs it yet (§Seeded
profiles): the identity-critical tasks (`variant`, `scene`, `chat_look`) refuse a
`weak` rating or an `img2img` edit kind outright, because `canEdit` alone was never
evidence that a face survives ([../images.md](../images.md) §Providers). The legacy
`for_portrait`/`for_variant`/`for_scene` toggles are what actually gate today's
pickers.

Two further columns exist but are **not written yet**: `probed_version_id` (the
version the stored bindings came from — the `Probed:` header in each file is that
version today, recorded by hand) and `advanced_capabilities` (the optional control
bindings each file's Inputs section lists in prose). Both are filled by later
slices of
[developer-notes/image-model-capabilities.plan.md](../developer-notes/image-model-capabilities.plan.md);
nothing is pinned to a version yet either.

## Seeded profiles

Beneath each model sit `image_model_profiles` rows — "how to use this model for
one job" (task, operation, prompt strategy, reference policy, control defaults,
timeout). Slice 1 seeded 17 built-ins that each reproduce what their lane resolves
today, and **the layer is dormant**: no lane calls it, so a seeded profile changes
no render. Each file lists the profiles seeded on its model. Profiles are ordinary
deletable rows; the database, not these files, is the runtime source of truth.

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
