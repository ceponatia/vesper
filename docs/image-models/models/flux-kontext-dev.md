# FLUX.1 Kontext Dev

**Slug:** `black-forest-labs/flux-kontext-dev`
**Provenance:** probed 2026-09-13 against pinned version `85723d503c17da3f9fd9cecfb9987a8bf60ef747fd8f68a25d7636f88260eb59`.

**Quality ruling:** none — the row carries no reviewed correction.

> Open-weight version of FLUX.1 Kontext.

Black Forest Labs' open-weight instruction editor, run on Replicate's own GPUs. It is
**edit-only**: the schema's required set is `prompt` *and* `input_image`, so every render needs
one source image and there is no prompt-only mode — the row can never reach a picker that asks a
model to make an image from nothing. `is_official` is true, so the row is registered under the
bare slug and its version pin lives in `probed_version_id` rather than in the slug. Every claim
below is **documented** — read from the provider's published schema, model page and licence text
— rather than measured in Vesper. No render has been made here.

## Not the other Kontext endpoints

Replicate publishes four Kontext endpoints, and they are four different models:

| Endpoint                                  | Reference input        | LoRA input                      | Moderation control       |
| ----------------------------------------- | ---------------------- | ------------------------------- | ------------------------ |
| `black-forest-labs/flux-kontext-dev`      | `input_image`, one URI | none declared                   | `disable_safety_checker` |
| `black-forest-labs/flux-kontext-dev-lora` | `input_image`, one URI | `lora_weights`, `lora_strength` | `disable_safety_checker` |
| `black-forest-labs/flux-kontext-pro`      | `input_image`, one URI | none declared                   | `safety_tolerance` dial  |
| `black-forest-labs/flux-kontext-max`      | `input_image`, one URI | none declared                   | `safety_tolerance` dial  |

This page is the first row, and it is the only one Vesper registers. **None of the other three has
a registry row, a page here, or any behavior inherited from this one.** The differences are what a
payload has to get right:

- **The LoRA arm is a separate endpoint.** `flux-kontext-dev-lora` declares `lora_weights`,
  `lora_strength` and `megapixels`; this endpoint declares none of them. Sending a LoRA to this
  slug posts inputs it rejects, so the curated LoRA library cannot reach it at all.
- **Pro and Max are hosted BFL API calls**, not open weights on Replicate's GPUs. Their only
  moderation input is a `safety_tolerance` dial that BFL caps lower when an input image is
  present, where this endpoint exposes a real `disable_safety_checker`
  ([README.md](README.md) §Moderation, by hosting model).
- **[FLUX.1 dev](flux-dev.md) is a different model.** Its `image` input is strength-based
  repainting driven by `prompt_strength`; this one is an instruction editor whose reference is
  required and whose prompt is the edit instruction. It also declares no `strength` of any kind.

The `@vesper/image-models` adapter registry keys on the **exact base slug**, so nothing here is
inherited by prefix from a neighbour or from the FLUX.2 klein rows.

## Licence and hosted use

Three rights are involved and they are not the same right. Conflating them is the expensive
mistake available on this model.

- **The weights** are published under the **FLUX.1 [dev] Non-Commercial License v1.1.1**, whose
  definition of "FLUX.1 [dev] Model" names FLUX.1 Kontext [dev] explicitly. Section 2(b) permits
  non-commercial purposes only, and commercial use of the weights requires a separate licence
  from Black Forest Labs; Section 1(c) states that revenue-generating use, or use in direct
  interactions with end users, is not non-commercial. Section 4(a) additionally forbids
  production or commercial use of the weights, military, surveillance and biometric use, and
  unlawful content. The FLUX GitHub repository's root `LICENSE` is Apache-2.0 and covers the
  **inference code**, not the weights. The Hugging Face weights repository is gated, so the
  GitHub copy of the same licence text is the source read.
- **The outputs** are not claimed by Black Forest Labs. Section 2(d) states that BFL claims no
  ownership of Outputs and that they may be used for any purpose including commercial —
  **except** to train, fine-tune or distil a competing model. Section 2(e) puts the content
  obligation on the user: run content filters or review Output for unlawful or infringing
  content, and disclose AI generation where the law requires it.
- **The hosted endpoint** is Replicate's own term. Replicate's model page carries a "Commercial
  use" marker reading *"Outputs from this model can be sold or used in paid products"* and
  describes this endpoint as the open-weight version with a non-commercial licence, commercial
  use available through Replicate. That is a term of the hosted service, separate from the
  weights licence.

Vesper calls the hosted endpoint and nothing else. Registering this row is **not** a licence to
self-host these weights or to fine-tune from them: absent a commercial licence from BFL, those
uses stay under the non-commercial terms above.

## Pricing

The provider's published rate is **$0.025 per output image**, billed on the `image_output_count`
metric, on Nvidia H100 hardware. That is the model page's figure, not an API field, and no Vesper
run has measured latency, cold-start behavior or realized cost.

## Moderation

**Unknown.** The schema declares `disable_safety_checker`, defaulting to `false`, which is the
shape of a cog wrapper whose NSFW classifier is a removable component rather than a vendor-API
proxy ([README.md](README.md) §Moderation, by hosting model). The switch's existence is a schema
fact and nothing more: it does not prove that every check upstream of it can be disabled, nor
that any particular output is permitted.

Vesper sets the value from the deployment's own safety posture in
`packages/image-replicate/src/payload.ts`, which overwrites whatever the row stores. **A row
cannot switch enforcement per run**, and no per-run bypass exists. Nothing has been observed live
here.

## Capabilities

- **Generate without a reference:** **no.** `input_image` is in the schema's required set, so
  every call is an edit.
- **Edit from a reference:** yes, through the required `input_image` input.
- **Reference field:** `input_image`, a single URI string. It resolves **by name** in the probe's
  preferred-reference order rather than by property position — see
  [providers/registry.md](../../images/providers/registry.md) §Which input is the reference is a priority order.
- **Reference cap:** 1. The schema declares one URI string, not a list, so a payload that wrapped
  the reference in an array is malformed.
- **Accepted reference formats:** jpeg, png, gif, webp, per the field description.
- **Reference transport:** `file`, the default — and **unverified**. Whether this wrapper accepts
  Replicate's own uploaded-file URLs is unknown until a run. Two registered rows reject them,
  [Qwen Image 2](qwen-image-2.md) and [Wan 2.7 Image Pro](wan-2-7-image-pro.md), because their
  wrappers read a file extension off what reaches the model container and an upload arrives
  without one. If this endpoint fails the same way, the fix is the owner-set
  `reference_transport` column — [transport.md](../../images/providers/transport.md) §Reference bytes
  — never a probe change.
- **Aspect handling:** `aspect_ratio` enum over eleven ratios including a native `3:4`, with the
  `match_input_image` sentinel as the **provider's default** — so a render that names no shape
  gets the source image's proportions.
- **Accelerated sampling:** none declared. There is no `go_fast`.
- **Runtime custom LoRA:** none declared on this endpoint.
- **Output format control:** `output_format` (`webp` / `jpg` / `png`, provider default `webp`)
  and `output_quality` (0–100, provider default 80).
- **Safety toggle:** `disable_safety_checker` is declared.
- **Output:** a bare URI string, not an array.

### `match_input_image` is a sentinel, not a ratio

The `aspect_ratio` enum has twelve members and only eleven of them are shapes. The twelfth,
`match_input_image`, tells the endpoint to copy the input image's proportions. It expresses no
ratio, so `parseAspectValue` returns null for it and the probe drops it from the stored
`supported_aspects` — a shape picker that could choose it would be choosing something that is not
a shape. It remains in the `aspect_ratio` descriptor's declared options, because a descriptor
records what the provider accepts rather than what Vesper can use. Here it is also the provider's
own default, which is why asking for no shape is a meaningful request on this model rather than a
fallback to square.

## Controls and raw provider inputs

Every one of the nine declared inputs is accounted for, and each reaches the admin
[Image Generator](../../image-generator/README.md) through exactly one path
([form.md](../../image-generator/form.md) §What the capability record decides):

- **`prompt`** — the prompt box. Required. With a reference always present, it reads as the edit
  instruction rather than a scene description.
- **`input_image`** — the single primary reference, required, so the form's operation is always
  an edit. There is no second image slot: the endpoint declares no dedicated control inputs.
- **`aspect_ratio`** — the Output shape select, over the eleven ratios. Leaving it blank sends no
  key at all, so the provider's `match_input_image` default applies and the output takes the
  source image's proportions ([form.md](../../image-generator/form.md) §Output shape).
- **`num_inference_steps`** — the Steps control. Integer, provider default 30, declared range
  4–50.
- **`guidance`** — the Guidance control. Number, provider default 2.5, declared range 0–10.
- **`seed`** — the Seed control. Integer, nullable, no declared bounds.
- **`output_format`** — the one **Advanced model input** this row offers: an enum over `webp`,
  `jpg` and `png`. The row stores `webp`, which the payload builder writes on every render; an
  advanced value replaces it for that run.
- **`output_quality`** — application-owned. Pinned to 95 by the row's `extra_input`, listed as
  reserved and not editable, while the descriptor records the provider's own default of 80. The
  two disagreeing is correct rather than a transcription error.
- **`disable_safety_checker`** — application-owned. Reserved, and the deployment's safety posture
  decides it (§Moderation).

A bound control is not a promise the endpoint acts on the value the way its name suggests —
[form.md](../../image-generator/form.md) §A bound control is not a promise the endpoint acts on it.
Nothing here has been compared against a baseline.

## Reviewed capability

Reviewed by hand and never overwritten by a schema probe:

- **Edit kind:** `unknown`. The vocabulary's positive terms name mechanisms, and no Vesper trial
  has established which of them this single-reference edit path behaves like. `unknown` is the
  column's permissive default, so the row is not locked out of the identity-critical eligibility
  gate by a rating nobody has written ([README.md](README.md) §Reviewed capability).
- **Identity preservation:** `unknown`. Nothing here has been graded against a held reference
  face.
- **Operator warning:** *"Untried in Vesper: no reviewed edit kind and no identity rating yet, so
  it is offered on no production surface and reaches only the admin Image Generator. It is
  edit-only — the source image (input_image) is required, so every render needs one reference and
  there is no prompt-only mode. The schema declares disable_safety_checker, so the deployment's
  own safety setting decides it; that switch removes this wrapper's own NSFW classifier, and
  nothing observed here says whether a further check runs upstream of it. The open weights are
  published under Black Forest Labs' FLUX.1 [dev] non-commercial licence, while commercial use of
  what this hosted endpoint renders rests on Replicate's own terms instead — registering this row
  is not a licence to self-host or fine-tune these weights."* Bound for the admin card and the
  model pickers.

## Offered surfaces

`for_portrait`, `for_variant` and `for_scene` are all false, and the row carries no
`image_model_profiles` rows, so **no player task resolves it and it is on no player surface**. It
runs through the admin [Image Generator](../../image-generator/README.md), which is
capability-driven rather than profile-driven: it derives its controls from this row's probed
capability record and pins `probed_version_id` for each run.

The `@vesper/image-models` adapter for this slug is `fluxKontextDev`, in
`packages/image-models/src/families/flux/kontext.ts`. It declares the family's semantic features
and nothing else: it composes **no prompt rewrite** and **no execution hint**, so the prompt the
Generator compiles is the prompt that is sent.

## Inputs

| Field                    | Type       | Default             | Notes                                                                  |
| ------------------------ | ---------- | ------------------- | ---------------------------------------------------------------------- |
| `prompt`                 | string     | —                   | **Required.** The edit instruction for the supplied image.             |
| `input_image`            | URI string | —                   | **Required.** One reference. jpeg, png, gif or webp.                   |
| `aspect_ratio`           | enum       | `match_input_image` | Eleven ratios plus the sentinel; the sentinel is the provider default. |
| `num_inference_steps`    | integer    | `30`                | Range 4–50.                                                            |
| `guidance`               | number     | `2.5`               | Range 0–10.                                                            |
| `seed`                   | integer    | none                | No declared range.                                                     |
| `output_format`          | enum       | `webp`              | `webp`, `jpg`, `png`. The row stores `webp`.                           |
| `output_quality`         | integer    | `80`                | 0–100. Not relevant for png. The row pins 95.                          |
| `disable_safety_checker` | boolean    | `false`             | The deployment's safety posture decides it.                            |

Nothing else is declared. There is no `negative_prompt`, no `go_fast`, no `strength`, no
`megapixels`, no `width`/`height`, no `num_outputs`, and no `lora_weights`/`lora_strength`.

## Output

`{"type": "string", "format": "uri"}` — a bare URI string rather than an array. The shared
`outputUrl` helper accepts both forms. The row's probed capability record carries the contract's
single-image default (`{"arity": "single", "supportsMultiple": false}`), which here matches what
the schema declares.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "input_image": "https://api.replicate.com/v1/files/<id>.webp",
  "aspect_ratio": "3:4",
  "guidance": 2.5,
  "num_inference_steps": 30,
  "seed": 1234,
  "output_format": "webp",
  "output_quality": 95,
  "disable_safety_checker": false
}
```

`input_image` is always present — the endpoint refuses a call without it — and carries one
uploaded-file URL on the row's `file` transport. `aspect_ratio` appears only when the caller names
a shape; omitting it is what hands the provider's `match_input_image` default the decision.
`guidance`, `num_inference_steps` and `seed` appear only when those controls are set.
`disable_safety_checker` carries the deployment's posture, not the row's stored placeholder. No
other key is written unless an admin sets the one Advanced input.

## What is unknown here

No paid run has been made against this endpoint from Vesper, so the following are open and
nothing on this page should be read as settling them:

- **Reference transport acceptance** — whether the wrapper takes Replicate's uploaded-file URLs
  or needs inlined `data:` bytes.
- **Cold-start and latency** — the published rate is per output image, and no wall-clock figure
  has been observed.
- **Identity retention** — whether a face in the source image survives the edit.
- **Edit adherence** — how closely the instruction is followed, and how the declared `guidance`
  range behaves across it.
- **Moderation behavior** — what the endpoint refuses, and what runs upstream of the declared
  safety switch.
