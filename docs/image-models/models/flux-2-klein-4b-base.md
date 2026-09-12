# FLUX.2 klein 4B Base

**Slug:** `black-forest-labs/flux-2-klein-4b-base`
**Provenance:** probed 2026-09-12 against pinned version `2289efa5ebba21f5322ba1b73ac92bb6fec9f34bafc08e0c26f465dac6f8b465`.

**Quality ruling:** none — the row carries no reviewed correction.

Black Forest Labs' 4-billion-parameter FLUX.2 klein, in its **undistilled base** form. One
endpoint that both generates and edits: `prompt` is its only required input, and supplying the
optional `images` list turns the same call into an edit. `is_official` is true, so the row is
registered under the bare slug and its version pin lives in `probed_version_id` rather than in
the slug. Every claim below is **documented** — read from the provider's published schema and
model page — rather than measured in Vesper.

**Licence:** the 4B weights are published under **Apache-2.0**. The 9B siblings are not, and
Vesper registers no row for them (see [Not the 9B siblings](#not-the-9b-siblings)).

## Three 4B endpoints, and which one this is

Replicate publishes the 4B model as three endpoints. They share a prompt/reference shape and
differ exactly where a payload has to get it right:

| Endpoint                                      | Guidance          | Accelerated sampling | Runtime LoRA                         |
| --------------------------------------------- | ----------------- | -------------------- | ------------------------------------ |
| `black-forest-labs/flux-2-klein-4b`           | **none declared** | `go_fast`            | none declared                        |
| `black-forest-labs/flux-2-klein-4b-base`      | `guidance`, 1–10  | `go_fast`            | none declared                        |
| `black-forest-labs/flux-2-klein-4b-base-lora` | **none declared** | **none declared**    | `lora_weights` / `lora_scales` lists |

This page is the middle row, and it is **the only one of the three that declares a guidance
input**. That is the whole reason it is a separate registry row from the distilled
[FLUX.2 klein 4B](flux-2-klein-4b.md): a guidance value asked of either sibling is refused before
spend, because the field does not exist on their versions. For runtime LoRA weights use
[FLUX.2 klein 4B Base LoRA](flux-2-klein-4b-base-lora.md), which drops guidance again.

Everything else in the three schemas is identical: the same `images` array capped at five, the
same twelve-member `aspect_ratio` enum, the same `output_format` / `output_quality` /
`output_megapixels` trio, the same `seed`, the same `disable_safety_checker`, and the same
array-of-URIs output.

The `@vesper/image-models` adapter registry keys on the **exact base slug**, so nothing about
this endpoint is inherited from its siblings by prefix.

## Not the 9B siblings

`black-forest-labs/flux-2-klein-9b` and its variants are a different size class published under a
**non-commercial licence**, which the 4B endpoints are not. Vesper registers no row for any 9B
endpoint and this folder carries no page for one. A reference to "klein" in the registry means a
4B endpoint.

## Capabilities

- **Generate without a reference:** yes. Required input is `prompt` only.
- **Edit from a reference:** yes, through the optional `images` list.
- **Reference field:** `images`, an **array** of URIs.
- **Reference cap:** 5, from the field description's "Maximum 5 images". No klein schema declares
  `maxItems`, so the cap is read from that prose
  ([providers/registry.md](../../images/providers/registry.md) §Capabilities are probed, not typed
  by hand).
- **Accepted reference formats:** jpeg, png, gif, webp, per the field description.
- **Aspect handling:** `aspect_ratio` enum, provider default `1:1`, including a native `3:4` —
  Vesper's portrait target needs no crop here.
- **Guidance:** `guidance`, a number from 1 to 10, provider default 4.
- **Accelerated sampling:** `go_fast`, provider default `false`.
- **Runtime custom LoRA:** none declared.
- **Output format control:** `output_format` (`webp` / `jpg` / `png`, provider default `jpg`) and
  `output_quality` (0–100, provider default 95).
- **Safety toggle:** `disable_safety_checker` is declared.
- **Output:** an array of URIs.

### `match_input_image` is a sentinel, not a ratio

The `aspect_ratio` enum has twelve members, and only eleven of them are shapes. The twelfth,
`match_input_image`, tells the endpoint to copy the first reference image's proportions. It
expresses no ratio, so `parseAspectValue` returns null for it and the probe drops it from the
stored `supported_aspects` — a shape picker that could choose it would be choosing something that
is not a shape. It remains in the `aspect_ratio` descriptor's declared options, because a
descriptor records what the provider accepts rather than what Vesper can use.

### `output_megapixels` is a string enum

`output_megapixels` takes the **strings** `0.25`, `0.5`, `1`, `2`, `4`, defaulting to `1`. It is
not a resolution tier and not a number: Vesper's `resolutionTier` control derives from a `size`
enum bearing tier names like `2K`, and these versions declare no `size` at all. So it stays a raw
provider input the admin Image Generator offers under Advanced model inputs, validated against
those five members. Left alone, output is one megapixel — smaller than what the seeded Qwen and
Seedream rows produce.

## Controls and raw provider inputs

Three declared inputs map onto Vesper's normalized control vocabulary, and the probe binds all
three:

- **`seed`** — integer, nullable, no declared bounds.
- **`guidance`** — number, 1–10, provider default 4, bound as the normalized guidance control with
  that range carried verbatim. It is the first spelling in the guidance alias chain, so no
  `guidance_scale` or `cfg` fallback is consulted. **What a given value does to this endpoint's
  output is unmeasured in Vesper.**
- **`go_fast`** — boolean, bound as the normalized fast-mode control. Whether it costs image
  quality here is unmeasured. A bound control is not a promise the endpoint acts on it the way its
  name suggests ([form.md](../../image-generator/form.md) §A bound control is not a promise the
  endpoint acts on it).

Two inputs are not owned by the prompt, reference, aspect, control or pin plumbing, so the admin
Image Generator renders them as **Advanced model inputs** from the probed `providerInputs`
descriptors:

- **`output_format`** — enum, provider default `jpg`. The row stores `webp`, which the payload
  builder writes on every render; an advanced value replaces it for that run.
- **`output_megapixels`** — enum, provider default `1`, as above.

### Reserved inputs

These are owned by the render path and refused as advanced values before any spend:

- **`prompt`**, **`images`** and **`aspect_ratio`** — the payload builder writes all three.
- **`disable_safety_checker`** — the deployment's own safety posture decides it, and the
  transport overwrites whatever the row stores. No per-run bypass exists.
- **`output_quality`** — pinned to 95 by the row's reviewed configuration.
- **`go_fast`** — both control-bound and pinned, so the raw bag cannot reach it.
- **`guidance`** and **`seed`** — control-bound; set them as controls rather than raw values.

### The pinned inputs

The row's `extra_input` carries `disable_safety_checker`, `output_quality: 95` and
`go_fast: true`. The third is a real behavioral choice: the provider defaults `go_fast` to
`false`, so a Vesper render takes the accelerated path unless an operator changes the row. No
comparison against the unaccelerated path has been run here, which is why the operator warning
names it — and on this endpoint that interacts with guidance, since an accelerated path and a
guidance scale are two ways of trading the same quantity.

## Reviewed capability

Reviewed by hand and never overwritten by a schema probe:

- **Edit kind:** `unknown`. No Vesper trial has established which editing mechanism this
  reference path behaves like. `unknown` is the column's permissive default, so the row is not
  locked out of the identity-critical eligibility gate by a rating nobody has written
  ([README.md](README.md) §Reviewed capability).
- **Identity preservation:** `unknown`. Nothing here has been graded against a held reference face.
- **Operator warning:** records that the endpoint is untried in Vesper and on no production
  surface, that output is one megapixel unless raised, that the safety checker's role is
  unobserved, that accelerated sampling is pinned on against the provider's default, and that this
  is the only klein 4B endpoint offering guidance with no value evaluated here. Bound for the
  admin card and the model pickers.

## Moderation

**Unknown.** The schema declares `disable_safety_checker`, which is the shape of a cog wrapper
whose classifier is a removable component rather than a vendor-API proxy
([README.md](README.md) §Moderation, by hosting model). That is suggestive, not conclusive: no
Vesper render has established what this endpoint refuses, and an input existing says nothing
about what else runs upstream of it.

## Offered surfaces

`for_portrait`, `for_variant` and `for_scene` are all false, and the row carries no
`image_model_profiles` rows, so **no player task resolves it and it is on no player surface**. It
runs through the admin [Image Generator](../../image-generator/README.md), which is
capability-driven rather than profile-driven: it derives its controls from this row's probed
capability record and pins `probed_version_id` for each run.

## Inputs

| Field                    | Type       | Default | Notes                                                                        |
| ------------------------ | ---------- | ------- | ---------------------------------------------------------------------------- |
| `prompt`                 | string     | —       | **Required.** The generation prompt, or the edit instruction with images.    |
| `images`                 | URI array  | `[]`    | Up to 5. jpeg, png, gif or webp.                                             |
| `aspect_ratio`           | enum       | `1:1`   | Eleven ratios plus the `match_input_image` sentinel.                         |
| `output_megapixels`      | enum       | `"1"`   | Strings `0.25`, `0.5`, `1`, `2`, `4`.                                        |
| `guidance`               | number     | `4`     | 1–10. Classifier-free guidance scale.                                        |
| `seed`                   | integer    | none    | Nullable. No declared range.                                                 |
| `go_fast`                | boolean    | `false` | Accelerated sampling. The row pins it `true`.                                |
| `output_format`          | enum       | `jpg`   | `webp`, `jpg`, `png`. The row stores `webp`.                                 |
| `output_quality`         | integer    | `95`    | 0–100. Not relevant for png. The row pins 95.                                |
| `disable_safety_checker` | boolean    | `false` | The deployment's safety posture decides it.                                  |

Nothing else is declared. There is no `num_inference_steps`, no `strength`, no `negative_prompt`,
no `width`/`height`, no `size`, and no `lora_weights`/`lora_scales`.

## Output

```json
{ "type": "array", "items": { "type": "string", "format": "uri" } }
```

An array of URIs. The row's probed capability record carries the contract's single-image default
(`{"arity": "single", "supportsMultiple": false}`), which is a statement about how Vesper consumes
the response rather than a fact this schema states: the schema does not promise exactly one
member. The shared `outputUrl` helper takes the first URI when several arrive.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "images": ["<url>", "<url>"],
  "aspect_ratio": "3:4",
  "guidance": 4,
  "output_format": "webp",
  "output_quality": 95,
  "go_fast": true,
  "disable_safety_checker": false,
  "seed": 1234
}
```

`images` appears only when references are supplied, `aspect_ratio` only when the caller names a
shape — a Generator run asks for no shape at all by default
([form.md](../../image-generator/form.md) §Output shape) — and `guidance` and `seed` only when
they are set. `disable_safety_checker` carries the deployment's posture, not the row's stored
placeholder. No other key is written unless an admin sets one of the two Advanced inputs.
