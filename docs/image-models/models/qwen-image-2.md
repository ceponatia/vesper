# Qwen Image 2

**Slug:** `qwen/qwen-image-2`
**Provenance:** probed 2026-09-10 against pinned version `266e594fa007032292c211586354fe193d7aa4e675a1eeb0aef0c6a424468ddd`.

**Quality ruling:** none — the row carries no reviewed correction.

> A next-generation image generation and editing model from Alibaba's Qwen team.
> Supports text-to-image and image editing with strong text rendering, especially
> for Chinese.

One endpoint that both generates and edits. `prompt` is its only required input, and
supplying the optional single `image` turns the same call into an edit. `is_official` is
true, so the row is registered under the bare slug and its version pin lives in
`probed_version_id` rather than in the slug. Every claim below is **documented** — read
from the provider's published schema and model page — rather than measured in Vesper.

## Not the Qwen-Image-Edit family

Three Replicate endpoints share the `qwen/qwen-image-` prefix and are different models:

| Endpoint                    | What it is                                           | Reference input                    |
| --------------------------- | ---------------------------------------------------- | ---------------------------------- |
| `qwen/qwen-image-2`         | Unified generation and editing in one model          | `image`, one URI, optional         |
| `qwen/qwen-image-2512`      | Text-to-image arm with strength-based image-to-image | `image`, one URI, optional         |
| `qwen/qwen-image-edit-2511` | Instruction editor over a numbered reference list    | `image`, an array of 1–3, required |

The schema differences are what a payload builder has to get right:

- **Arity.** [Qwen Image Edit 2511](qwen-image-edit-2511.md) binds `image` as an **array**
  despite the singular name; this endpoint and [Qwen Image 2512](qwen-image-2512.md) bind the
  same key as a **single URI string**. A payload that wraps this model's reference in a list
  is malformed.
- **Required-ness.** 2511 lists its reference in the schema's `required` set, which is what
  keeps it out of the new-portrait picker. Here only `prompt` is required, so the row is both
  generate-capable and edit-capable.
- **Edit mechanism.** 2512's reference is strength-based repainting driven by a `strength`
  input. This endpoint declares no `strength` at all: the prompt is the edit instruction, and
  `match_input_image` is the only reference-shaped control beside it.
- **Controls.** 2511 and 2512 expose a sampler surface — `go_fast`, `num_inference_steps`,
  guidance, `output_format`, `output_quality`, `disable_safety_checker` — and 2511 additionally
  exposes a runtime LoRA. This endpoint declares none of them.
- **Output.** 2511 and 2512 return an array of URIs. This endpoint returns a bare URI string.

`qwen/qwen-image-edit-2509` is 2511's predecessor in that same instruction-editor line. Vesper
registers no row for it and this folder carries no page for it; a reference to "Qwen Image Edit"
means 2511.

Replicate publishes **no separate `qwen/qwen-image-2-edit` endpoint** — editing on this
generation is the optional `image` input on this slug. A higher-quality sibling,
`qwen/qwen-image-2-pro`, exists on Replicate; Vesper registers no row for it, so it has no page
here.

The `@vesper/image-models` adapter registry keys on the **exact base slug**, so nothing about
this model is inherited from the neighbouring Qwen rows by prefix. It has no adapter at all —
see Offered surfaces below.

## Capabilities

- **Generate without a reference:** yes. Required input is `prompt` only.
- **Edit from a reference:** yes, through the optional `image` input.
- **Reference field:** `image`, a single URI string.
- **Reference cap:** 1.
- **Aspect handling:** `aspect_ratio` enum, provider default `1:1`, and it includes `3:4` —
  Vesper's portrait target is native here. `match_input_image` overrides the enum when a
  reference is supplied.
- **Accelerated sampling:** none declared. There is no `go_fast` and no step count to trade.
- **Runtime custom LoRA:** none declared.
- **Output format control:** none. No `output_format` or `output_quality` input exists.
- **Safety toggle:** none declared.
- **Output:** a bare URI string, not an array.

## Controls and raw provider inputs

Two declared inputs map onto Vesper's normalized control vocabulary, and the probe binds both:

- **`seed`** — integer, nullable. The field description states a 0–2147483647 range; the schema
  itself declares no numeric bounds, so nothing validates one.
- **`negative_prompt`** — string, provider default empty, bound as the normalized negative-prompt
  control. **Whether it steers output here is unmeasured.** 2512's measured ruling that its own
  negative field is ignored is scoped to that endpoint and does not transfer to this one: a
  binding is a mechanical fact about what an input is called, not a promise the endpoint acts on
  it ([form.md](../../image-generator/form.md) §A bound control is not a promise the endpoint
  acts on it).

The other two inputs are not owned by the prompt, reference, aspect or control plumbing, so
the admin Image Generator renders them as **Advanced model inputs** from the probed
`providerInputs` descriptors ([form.md](../../image-generator/form.md) §What the capability
record decides):

- **`enable_prompt_expansion`** — boolean, provider default **`true`**. Left alone, the endpoint
  rewrites and expands the prompt before rendering it, so the text that reaches the model is not
  the text Vesper compiled. A controlled comparison sets it `false`, which is what makes the
  admin's prompt the one under test.
- **`match_input_image`** — boolean, default `false`. With a reference supplied, `true` takes the
  output's aspect ratio and resolution from that image instead of from `aspect_ratio`. Its effect
  is unmeasured in Vesper.

## Reviewed capability

Reviewed by hand and never overwritten by a schema probe:

- **Edit kind:** `unknown`. The vocabulary's positive terms name mechanisms — a numbered
  instruction edit, a multi-reference compose, a strength repaint — and no Vesper trial has
  established which of them this single-reference edit path behaves like. `unknown` is the
  column's permissive default, so the row is not locked out of the identity-critical eligibility
  gate by a rating nobody has written ([README.md](README.md) §Reviewed capability).
- **Identity preservation:** `unknown`. Nothing here has been graded against a held reference
  face.
- **Operator warning:** *"Untried in Vesper: no reviewed edit kind and no identity rating yet, so
  it is offered on no production surface. Its schema declares no safety-checker switch, so
  whether the endpoint moderates upstream is unknown until a run is observed. Prompt expansion
  is on by the provider's default (enable_prompt_expansion) — a raw provider input a controlled
  run should switch off."* Bound for the admin card and the model pickers.

## Moderation

**Unknown.** The schema declares no `disable_safety_checker`, so no input can relax anything, and
no Vesper render has established what the endpoint refuses.

The shape of the control set is suggestive rather than conclusive: no sampler controls, no step
count, no output encoding, a bare-URI output, and a model page pointing at Alibaba Cloud Model
Studio's Qwen-Image API for its documentation. That is what a vendor-API proxy looks like, and a
proxy's moderation runs on the vendor's servers where no payload can reach it
([README.md](README.md) §Moderation). An absent safety input is equally consistent with a wrapper
that simply ships no classifier, which is how the `nsfw-api` and `aisha-ai-official` rows behave,
so the reading stays unconfirmed.

## Offered surfaces

`for_portrait`, `for_variant` and `for_scene` are all false, and the row carries no
`image_model_profiles` rows, so no player task resolves it. It runs through the admin
[Image Generator](../../image-generator/README.md), which is capability-driven rather than
profile-driven: it derives its controls from this row's probed capability record and pins
`probed_version_id` for each run.

There is **no family adapter** for this slug. `adapterForImageModel("qwen/qwen-image-2")` returns
`null` and the generic path runs it, which is the normal fallback rather than an error — Vesper
has no family-specific behavior to encode for this endpoint
([image-models README](../README.md) §Current package state).

## Inputs

| Field                     | Type       | Default | Notes                                                                                      |
| ------------------------- | ---------- | ------- | ------------------------------------------------------------------------------------------ |
| `prompt`                  | string     | —       | **Required.** The generation prompt, or the edit instruction when an image is supplied.    |
| `image`                   | URI string | none    | Optional reference for image editing, style transfer, or image-to-image.                   |
| `match_input_image`       | boolean    | `false` | With an image, takes the output's aspect and resolution from it instead of `aspect_ratio`. |
| `aspect_ratio`            | enum       | `1:1`   | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`.                           |
| `enable_prompt_expansion` | boolean    | `true`  | Automatically expands and optimizes the prompt.                                            |
| `negative_prompt`         | string     | `""`    | Elements to avoid. Effect on this endpoint unmeasured.                                     |
| `seed`                    | integer    | none    | Nullable. Described as 0–2147483647; no numeric range is declared in the schema.           |

Nothing else is declared. There is no `disable_safety_checker`, `go_fast`, `output_format`,
`output_quality`, `num_inference_steps`, `strength`, `width`/`height`, or
`lora_weights`/`lora_scale`, and no guidance input under any spelling.

## Output

`{"type": "string", "format": "uri"}` — a bare URI string rather than an array. The shared
`outputUrl` helper accepts both forms.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "image": "<single url>",
  "aspect_ratio": "3:4",
  "seed": 1234
}
```

`image` appears only when a reference is supplied, `aspect_ratio` only when the caller names a
shape — a Generator run asks for no shape at all by default
([form.md](../../image-generator/form.md) §Output shape) — and `seed` only when one is set. No
other key is written unless an admin sets one of the two Advanced inputs.

## Provider guidance

Recorded from the model page as documented provider facts:

- Output is native 2K, up to 2048×2048.
- Prompts are accepted up to 1,000 tokens, which is what makes a multi-block text layout
  describable in one prompt.
- For an edit, state the constraints explicitly — "do not change the background", "keep lighting
  realistic". The provider's guidance is that this endpoint follows explicit constraints better
  than implied ones.
