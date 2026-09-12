# FLUX.2 klein 4B Base LoRA

**Slug:** `black-forest-labs/flux-2-klein-4b-base-lora`
**Provenance:** probed 2026-09-12 against pinned version `c8ca755d41dd4a19b8fe1f50247bc6b37c73ac5321af8277d97c5e66e803ecdc`.

**Quality ruling:** none — the row carries no reviewed correction.

Black Forest Labs' 4-billion-parameter FLUX.2 klein base, wrapped to accept **runtime LoRA
weights**. One endpoint that both generates and edits: `prompt` is its only required input, and
supplying the optional `images` list turns the same call into an edit. `is_official` is true, so
the row is registered under the bare slug and its version pin lives in `probed_version_id` rather
than in the slug. Every claim below is **documented** — read from the provider's published schema
and model page — rather than measured in Vesper.

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

This page is the third row, and it is **the only one of the three that accepts LoRA weights**. It
is also the only one that declares neither `guidance` nor `go_fast`: taking runtime weights costs
both knobs its siblings have. A guidance or fast-mode value asked of this endpoint is refused
before spend, because those fields do not exist on this version. For a guidance scale use
[FLUX.2 klein 4B Base](flux-2-klein-4b-base.md); for the distilled fast path use
[FLUX.2 klein 4B](flux-2-klein-4b.md).

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

## The LoRA pair is a pair of LISTS

This is the fact most likely to be assumed wrong here. Every other LoRA-bound row Vesper has —
the Qwen edit endpoints — declares two **scalar** fields, `lora_weights` (a string) and
`lora_scale` (a number). This endpoint declares two **arrays**:

| Field          | Declared shape             | Vesper binding                                         |
| -------------- | -------------------------- | ------------------------------------------------------ |
| `lora_weights` | array of strings, nullable | `loraWeights`, element type `string`, `arity: "array"` |
| `lora_scales`  | array of numbers, nullable | `loraScale`, element type `number`, `arity: "array"`   |

Note the plural `lora_scales`. The pair is usable in exactly two shapes and nothing else: both
sides scalar, or both sides arrays with the same two element types. A schema pairing an array
`lora_weights` with a scalar `lora_scale` matches neither reading and binds **neither** field —
never half a LoRA. The binding's `type` names the ELEMENT type in the array case, not a new "array
of X" primitive, so range checks keep judging one value per field and the control mapper decides
whether to wrap it. Vesper sends one curated LoRA, so each list arrives as a one-element array.

Neither field declares `items.minimum` or `items.maximum`, so the scale binding carries no range.
The description's "Defaults to 1.0 for each if not provided" is prose, not a declared bound, and
nothing reads a range out of a sentence. The curated LoRA row's own scale band is what constrains
a value here.

Both fields are **reserved**: raw provider values may not reach them. A LoRA arrives by selecting
a row from the curated library, which carries its own locator rules and compatibility ruling.

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
- **Guidance:** none declared.
- **Accelerated sampling:** none declared.
- **Runtime custom LoRA:** yes — `lora_weights` / `lora_scales`, as lists. The description states
  ComfyUI and native Flux Klein formats, with ComfyUI weights converted automatically.
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

Three declared inputs map onto Vesper's normalized control vocabulary:

- **`seed`** — integer, nullable, no declared bounds.
- **`lora_weights`** and **`lora_scales`** — the array LoRA pair described above, bound together
  or not at all.

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
- **`lora_weights`**, **`lora_scales`** and **`seed`** — control-bound. The LoRA pair in
  particular is the curated library's transport, and a typed address is not a way around it.

### The pinned inputs

The row's `extra_input` carries `disable_safety_checker` and `output_quality: 95` — **two keys,
not the three its siblings carry**. This version declares no `go_fast`, and Replicate rejects
unknown inputs, so copying a sibling's pins onto this row would fail every render.

## Reviewed capability

Reviewed by hand and never overwritten by a schema probe:

- **Edit kind:** `unknown`. No Vesper trial has established which editing mechanism this
  reference path behaves like. `unknown` is the column's permissive default, so the row is not
  locked out of the identity-critical eligibility gate by a rating nobody has written
  ([README.md](README.md) §Reviewed capability).
- **Identity preservation:** `unknown`. Nothing here has been graded against a held reference face.
- **Operator warning:** records that the endpoint is untried in Vesper and on no production
  surface, that output is one megapixel unless raised, that the safety checker's role is
  unobserved, that it declares the array LoRA pair and neither `go_fast` nor `guidance`, and that
  no curated LoRA has been run against it — so whether Flux Klein-format weights behave as the
  provider describes is unobserved. Bound for the admin card and the model pickers.

## Moderation

**Unknown.** The schema declares `disable_safety_checker`, which is the shape of a cog wrapper
whose classifier is a removable component rather than a vendor-API proxy
([README.md](README.md) §Moderation, by hosting model). That is suggestive, not conclusive: no
Vesper render has established what this endpoint refuses, and an input existing says nothing
about what else runs upstream of it. A LoRA changes what the model was trained to draw, which is a
separate ceiling from what a classifier refuses.

## Offered surfaces

`for_portrait`, `for_variant` and `for_scene` are all false, and the row carries no
`image_model_profiles` rows, so **no player task resolves it and it is on no player surface**. It
runs through the admin [Image Generator](../../image-generator/README.md), which is
capability-driven rather than profile-driven: it derives its controls from this row's probed
capability record and pins `probed_version_id` for each run.

A LoRA reaches a render here only if a curated `image_loras` row names this slug among its
compatible models; the library's compatibility list is empty by default, and empty means nothing
is compatible rather than everything.

## Inputs

| Field                    | Type          | Default | Notes                                                                     |
| ------------------------ | ------------- | ------- | ------------------------------------------------------------------------- |
| `prompt`                 | string        | —       | **Required.** The generation prompt, or the edit instruction with images. |
| `images`                 | URI array     | `[]`    | Up to 5. jpeg, png, gif or webp.                                          |
| `aspect_ratio`           | enum          | `1:1`   | Eleven ratios plus the `match_input_image` sentinel.                      |
| `output_megapixels`      | enum          | `"1"`   | Strings `0.25`, `0.5`, `1`, `2`, `4`.                                     |
| `seed`                   | integer       | none    | Nullable. No declared range.                                              |
| `lora_weights`           | string array  | none    | Nullable. LoRA URLs; ComfyUI and native Flux Klein formats.               |
| `lora_scales`            | number array  | none    | Nullable. One scale per weight; provider default 1.0 each.                |
| `output_format`          | enum          | `jpg`   | `webp`, `jpg`, `png`. The row stores `webp`.                              |
| `output_quality`         | integer       | `95`    | 0–100. Not relevant for png. The row pins 95.                             |
| `disable_safety_checker` | boolean       | `false` | The deployment's safety posture decides it.                               |

Nothing else is declared. There is no `guidance` under any spelling, no `go_fast`, no
`num_inference_steps`, no `strength`, no `negative_prompt`, no `width`/`height`, and no `size`.

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
  "lora_weights": ["https://…/weights.safetensors"],
  "lora_scales": [1],
  "output_format": "webp",
  "output_quality": 95,
  "disable_safety_checker": false,
  "seed": 1234
}
```

`images` appears only when references are supplied, `aspect_ratio` only when the caller names a
shape — a Generator run asks for no shape at all by default
([form.md](../../image-generator/form.md) §Output shape) — and `seed` only when one is set. The
two LoRA keys appear together or not at all, each as a one-element list, and only when a curated
LoRA is selected. `disable_safety_checker` carries the deployment's posture, not the row's stored
placeholder. No other key is written unless an admin sets one of the two Advanced inputs.

## RefControl depth recipe

A published third-party LoRA trains this endpoint's runtime weights to read its first reference
image as a depth map and its second as the identity to preserve, with the trigger word
`refcontrol`. [loras.md](../../images/providers/loras.md) §RefControl depth row (klein 4B, pilot)
owns the curated row's exact field values and the artifact's provenance; this section owns the
operator recipe and the wire shape it produces.

### Producing the depth map

The depth map is an owner-scoped `lab_control` image with `controlKind: depth`
([depth-fixture.md](../../image-lab/depth-fixture.md)), reached one of two ways:

- **Hand-authored** — an operator uploads a depth map they already have
  ([depth-fixture.md](../../image-lab/depth-fixture.md) §Hand-authored depth fixtures).
- **Extracted** — the Image Lab's depth extraction runs a reference image through the pinned
  `chenxwh/depth-anything-v2` model and stores the result as the same `lab_control` kind
  ([depth-fixture.md](../../image-lab/depth-fixture.md) §Automatic extraction).

Either path needs a review before an experiment relies on the fixture
([depth-fixture.md](../../image-lab/depth-fixture.md) §Review requirement), and either way the
result is an owner-scoped image the Generator's existing owned-image picker
([form.md](../../image-generator/form.md) §Sources) selects like any other reference — this recipe
adds no ingestion path, no Generator/Lab coupling, and no depth-specific UI.

### Running the recipe

1. Open the [Image Generator](../../image-generator/README.md) and select
   `black-forest-labs/flux-2-klein-4b-base-lora`.
2. Set primary image 1 to the reviewed depth map and primary image 2 to the identity reference the
   render preserves. Both travel as ordinary primary references under the neutral `reference` role
   in the order selected; an optional per-reference purpose is provenance only and never changes
   which provider field either one lands on.
3. Author a prompt that states each image's role in plain language, since nothing about the
   request itself tells the model which numbered image is which — for example, "follow the first
   image as depth structure and preserve the second image's face and identity".
4. Pick the curated depth LoRA row at its default scale. The row's one trigger word joins the
   prompt through the existing prompt-addition mechanism when the authored prompt does not already
   carry it, and the run record's final prompt shows the woven result.
5. For the no-LoRA comparison arm, clear the LoRA selection entirely rather than asking the row for
   a scale outside its curated band — an out-of-band scale refuses before spend, it is not a
   substitute for "no LoRA".
6. Record each arm's run id, since a run id is what the comparison below reads.

### The wire shape

```json
{
  "prompt": "<authored prompt, with the trigger woven in if it was missing>",
  "images": ["<depth map url>", "<identity reference url>"],
  "lora_weights": ["<the row's verified S3 locator>"],
  "lora_scales": [0.9],
  "output_format": "webp",
  "output_quality": 95,
  "disable_safety_checker": "<the deployment's safety setting; true under the default REPLICATE_SAFE_MODE>"
}
```

`images` carries the depth map first and the identity reference second because that is the order
the admin selected them in — the planner and transport preserve reference order end to end and add
no routing based on purpose
([render-intents.md](../../images/providers/render-intents.md) §Which references survive is the
profile's policy). The two LoRA keys are the row's own resolved locator and scale, each as the
one-element list this endpoint's array-shaped pair requires
([loras.md](../../images/providers/loras.md) §Scalar and array bindings) — never a second entry,
and never a raw locator an admin typed in directly. `disable_safety_checker` is the deployment's
own `REPLICATE_SAFE_MODE` setting (`replicate-runtime.ts`'s `resolveReplicateConfig`), which
overwrites the row's `extra_input` pin at send time on every run, this recipe included.

### What the record proves, and what it does not

The run record proves the exact request sent: which two images occupied `images` and in which
order, which locator and scale reached `lora_weights` / `lora_scales`, and the exact final prompt
the trigger word landed in. It is provenance, not a verdict — the Image Generator carries no
evidence rule and no human-verdict vocabulary
([image-generator/README.md](../../image-generator/README.md) §The boundary against the Advanced
Image Lab). A stored run record does not establish that the depth map actually shaped the output or
that the identity survived; only a rendered image an operator inspects says that.

### The comparison this recipe feeds

The recipe's inputs feed a three-arm comparison against one held seed and one held depth/identity
pair: no LoRA, the row at its curated minimum (0.8), and the row at its curated maximum (1.0) — the
only variable between arms is the LoRA's own scale. This page's recipe produces the inputs and the
run ids; the authorized comparison that grades the three arms against each other is a separate,
owner-authorized step, never a claim this page makes on its own.
