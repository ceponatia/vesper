# Provider model reference

This subfolder owns Vesper's per-model provider/API reference. The parent [image-models documentation](../README.md) owns package behavior, feature semantics, and registered family adapters.

Per-model reference for every Replicate image model Vesper can run. One file per
model, recording the API attributes the render path depends on: what the model's
reference-image input is called, whether it takes one image or a list, how many,
how to get a 3:4 output out of it, and what it returns.

These files describe **the provider's API**, not Vesper's configuration. Which
models are actually offered, and on which surfaces, is data in the `image_models`
table and is managed from the admin page at `/settings/image-models`.
Adding a model to the app does not require adding a file here, but doing so is
the difference between a model we understand and one we merely call.

> **Version note:** [providers/](../../images/providers/README.md) owns how Vesper probes,
> pins, and activates provider versions. Each per-model page owns that model's
> external API snapshot and any known provider drift. Do not infer an active
> row's controls from Replicate's current playground alone.

## The provenance line

Every page in this folder carries **exactly one dated line**, in the header block under the slug:

```text
**Provenance:** probed <YYYY-MM-DD> against pinned version `<version id>`.
```

That pairing is the whole claim: everything the page records below it — the schema, the field
names, the caps, the measured behavior — was read from that exact provider version on that date.
A date without a version says nothing reproducible, and a version without a date cannot be aged,
so the two only ever appear together.

**No other date appears on a catalog page**, with one exception: a dated `Owner ruling
<YYYY-MM-DD>: …` line, which records a decision rather than a measurement. A re-probe **replaces**
the provenance line rather than adding a second one, and a recheck that changed nothing leaves no
trace — if a recheck established a fact, that fact is stated in prose.

The header block is otherwise `**Slug:**`, an optional `**Registered as:**` for a
version-pinned row, and an optional `**Quality ruling:**` naming the reviewed posture in words.

## Why these files exist

Replicate's schemas disagree with each other in ways that cannot be papered
over with one shared mapping:

- The reference input is called `image` on most models, `image_input` on two,
  `images` on another, and `reference_image` on two more.
- On some models that field is a single URI; on others it is an array.
- **A URI-typed input is not necessarily a reference.** One model declares a
  ControlNet `depth_image` *before* its `reference_image`, so "the first image
  input" is the wrong answer. The probe's reference-field priority order and the
  reasoning behind it are owned by
  [providers/registry.md](../../images/providers/registry.md).
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
  variant and scene default. Its page owns version-specific optional controls.
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

Registered by admin, rated, and deliberately on **no ordinary player picker**:

- [Qwen Image Edit Plus LoRA](qwen-image-edit-plus-lora.md) —
  `qwen/qwen-image-edit-plus-lora`. Generate **no**, edit yes, 3 references,
  plus runtime `lora_weights`/`lora_scale`. `instruction_edit` · `moderate`.
  This older 2509-generation wrapper is used by the intimate-scene LoRA
  model-swap route and by LoRA-focused lab work. Any registered/enabled model row
  is selectable in the admin Image Generator; LoRA bindings only determine
  whether the Generator exposes LoRA controls for that row. The wrapper is
  **not** offered by an ordinary portrait/variant/scene picker. See the
  [2511 page](qwen-image-edit-2511.md) for that endpoint's version-specific API.

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
and the pickers. These are human ratings from looking at output; **a re-probe must
never overwrite them**, and `unknown` is permissive so an unreviewed row keeps
working as it does today. Each file records its model's ratings and the reasoning.

The identity-critical tasks (`variant`, `scene`, `chat_look`) **actively enforce
these ratings during profile offering/resolution**. A model rated `weak` or with
`edit_kind: img2img` is ineligible for those tasks, so a stale stored selection
falls through the profile-resolution chain instead of rendering a stranger.
`imageProfileOffered` composes this structural eligibility with the profile's
enabled flag and the remaining legacy surface toggle. The database profile rows,
not the prose here, are the runtime source of truth
([providers/README.md](../../images/providers/README.md)).

`probed_version_id` — the version the stored bindings came from, and the version named in each
file's provenance line — is written on rows added through the admin page and on the four seeded
rows whose slugs name it. The six original seeded rows carry none: they predate the column.
`advanced_capabilities` is probe-owned and
holds optional control bindings plus provider-input descriptors; a row created
before a capability derivation existed gains those fields on re-probe or version
activation. Do not infer the active row's capability from the current Replicate
playground alone.

## Seeded profiles

Beneath each model sit `image_model_profiles` rows — "how to use this model for
one job" (task, operation, prompt strategy, reference policy, control defaults,
timeout). There are built-in profiles reproducing the production lanes plus
curated alternatives, and **every production render resolves one**
([profiles.md](../../images/providers/profiles.md) §Every render resolves a
profile, and every picker lists profiles). A model offered on a surface with no
eligible profile for that task is passed over for the task default. Profiles are
ordinary deletable rows; the database, not these files, is the runtime source of
truth.

The admin-only **Image Generator is intentionally different**: it is a freeform
registered-model bench rather than a player task-profile picker. It derives its
controls from the selected row's currently probed capability record and pins the
chosen provider version for the run. A model being absent from ordinary player
pickers therefore does **not** mean the Image Generator cannot run it.

## Keeping these current

Replicate does not version this metadata: a model's `latest_version` can change
its input schema underneath a fixed slug. Each file's provenance line records the version id it
was read from and the date it was read. When a render starts failing on a payload that used to
work — or Replicate documents a new capability — re-probe before debugging or
redesigning Vesper:

```bash
curl -s -H "Authorization: Bearer $REPLICATE_API_TOKEN" https://api.replicate.com/v1/models/qwen/qwen-image-edit-2511 | jq '.latest_version.id, .latest_version.openapi_schema.components.schemas.Input'
```

The admin page's probe-latest flow does the same discovery without mutating the
active row. Smoke-test the candidate, then activate it explicitly. A per-model page records both
the active probed snapshot — through its provenance line — and any known newer provider schema
when those differ.
