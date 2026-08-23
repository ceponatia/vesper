# Image models

Per-model reference for every Replicate image model Vesper can run. One file per
model, recording the API attributes the render path depends on: what the model's
reference-image input is called, whether it takes one image or a list, how many,
how to get a 3:4 output out of it, and what it returns.

These files describe **the provider's API**, not Vesper's configuration. Which
models are actually offered, and on which surfaces, is data in the `image_models`
table and is managed from the admin page at `/settings/image-models` — see
`image-model-registry.plan.md`.
Adding a model to the app does not require adding a file here, but doing so is
the difference between a model we understand and one we merely call.

## Why these files exist

Replicate's schemas disagree with each other in ways that cannot be papered
over with one shared mapping:

- The reference input is called `image` on most models, `image_input` on two,
  `images` on another, and `reference_image` on two more.
- On some models that field is a single URI; on others it is an array.
- **A URI-typed input is not necessarily a reference.** One model declares a
  ControlNet `depth_image` *before* its `reference_image`, so "the first image
  input" is the wrong answer — the probe searches identity names first and
  control names (`depth_image`, `pose_image`, `mask`, …) last
  ([../images/providers.md](../images/providers.md)).
- Some models expose `aspect_ratio` and offer `3:4`. One offers `aspect_ratio`
  without `3:4`. One has no `aspect_ratio` at all and is driven by `size`. Six
  have no aspect input whatsoever and are sized by `width`/`height` integers;
  the three of those six that are in the reviewed set carry reviewed dimensions
  from the reviewed policy
  (`packages/image-core/src/models/reviewed-profile-controls.ts`), and every render is cropped to shape
  after download regardless.
- Output is an array of URIs on twelve of fourteen models, and a bare URI string
  on the other two.
- One model watermarks by default (`apply_watermark`), which the probe pins off.
- **Community models can only be run by version id.** The bare-slug endpoint is
  official-models-only, so a community model's registry row is auto-pinned to
  `owner/name:version` when it is added — and a seeded community row is written
  pinned for the same reason. That is why the community models below carry a
  version in their stored slug and the official ones do not.
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

Only the ten seeded models carry reviewed ratings. The four below them are
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
- [NSFW FLUX Dev](nsfw-flux-dev.md) — `aisha-ai-official/nsfw-flux-dev`. Generate
  yes, edit **no**, no references. `none` · `unknown`. Portrait studio only.
- [LikeReality Pony v1](likereality-pony-v1.md) —
  `aisha-ai-official/likereality-pony-v1`. Generate yes, edit **no**, no
  references. `none` · `unknown`. Portrait studio only.
- [SDXL PuLID](sdxl-pulid.md) — `nsfw-api/sdxl-pulid`. Generate yes, edit yes,
  1 reference. `unknown` · `unknown`, plus an operator warning — an untried
  identity adapter with 283 lifetime runs. Variant and scene only.
- [Pruna P-Image](p-image.md) — `prunaai/p-image`. Generate yes, edit **no**, no
  references. `none` · `unknown`. Portrait studio only; the speed baseline.

Of those last four, only SDXL PuLID takes a reference image, which is why it is
the only one on the variant and scene surfaces — the other three cannot hold a
character's face across a render at all.

Registered by admin, rated, and deliberately on **no** player surface:

- [Qwen Image Edit Plus LoRA](qwen-image-edit-plus-lora.md) —
  `qwen/qwen-image-edit-plus-lora`. Generate **no**, edit yes, 3 references,
  plus the `lora_weights`/`lora_scale` pair no other Qwen edit endpoint has.
  `instruction_edit` · `moderate`. The Advanced Image Lab's LoRA finishing
  connector; unreachable from every picker.

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

**These four are outside the reviewed set**, and that is a stronger statement
than "unrated". An admin can add any of them, and what runs is then the
wrapper's own configuration: no reviewed dimensions, no cleared negative
default, no sampler correction, and no seeded task-profile controls. The
per-model pages below record what each wrapper defaults to and what its creator
recommends, so an admin adding one knows what they are getting — but nothing in
Vesper corrects it on their behalf. The reviewed set is the Qwen family plus the
seeded adult/identity additions.

## Moderation, by hosting model

Which models will refuse a render is not a property of the prompt — it follows
from how Replicate runs them:

- **Open weights on Replicate's GPUs** — the NSFW classifier is a component in
  the cog wrapper and `disable_safety_checker` removes it. Both Qwen models,
  FLUX dev, Juggernaut XL v9 and Pruna P-Image work this way; the `nsfw-api`
  pipelines and the two `aisha-ai-official` fine-tunes ship with no checker at
  all, which is why their rows carry no safety key — the probe only pins inputs
  a schema actually declares.
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
`multi_reference_compose`, `identity_conditioned`, `img2img`, `none`, or
`unknown`) and
`identity_preservation` (`strong` / `moderate` / `weak` / `unknown`, how well a
face survives). A third, `operator_warning`, is free text bound for the admin card
and the pickers — no surface renders it yet. These are human ratings from looking at
output; **a re-probe must
never overwrite them**, and `unknown` is permissive so an unreviewed row keeps
working as it does today. Each file records its model's ratings and the reasoning.

The rule they feed is already written, though nothing runs it yet (§Seeded
profiles): the identity-critical tasks (`variant`, `scene`, `chat_look`) refuse a
`weak` rating or an `img2img` edit kind outright, because `canEdit` alone was never
evidence that a face survives ([../images/providers.md](../images/providers.md)). The legacy
`for_portrait`/`for_variant`/`for_scene` toggles are what actually gate today's
pickers.

`probed_version_id` — the version the stored bindings came from, and the
`Probed:` header in each file — is written on rows added through the admin page
and on the four seeded rows whose slugs name it. The six original seeded rows
carry none: they predate the column. `advanced_capabilities` (the optional
control bindings each file's Inputs section lists in prose) is `{}` on every row;
the column was introduced by
`image-model-capabilities.plan.md`.

## Seeded profiles

Beneath each model sit `image_model_profiles` rows — "how to use this model for
one job" (task, operation, prompt strategy, reference policy, control defaults,
timeout). There are 22 built-ins, each reproducing what its lane resolves today,
and **every render now resolves one** ([../images/providers.md](../images/providers.md)
§Every render resolves a profile) — a model offered on a surface with no profile
for that task is passed over for the task default, which is why a seeded model
gets a seeded profile per surface it is offered on. Each file lists the profiles
seeded on its model. Profiles are ordinary deletable rows; the database, not these
files, is the runtime source of truth.

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
