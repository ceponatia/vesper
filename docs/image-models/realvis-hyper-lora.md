# RealVis Hyper LoRA

**Slug:** `nsfw-api/realvis-hyper-lora`
**Probed:** 2026-08-05, version `9b1951176565c8f810f28ed140787a81c8f49b49e2d40d0a135d9491b95782bd`

The model page carries no description. From its schema it is a **HyperLoRA +
InstantID identity pipeline** over a RealVisXL checkpoint: a face reference plus
a prompt, with two separate weights controlling how hard the identity is pushed.
Run on Replicate's own GPUs.

Two things make it unusual in this set: its reference field is named
`reference_image` (every other model uses `image`, `image_input`, or `images`),
and its default width/height are already exactly Vesper's 3:4.

## Capabilities

- **Generate without a reference:** **no.** `prompt` *and* `reference_image` are
  both required, so it never serves the new-portrait surface.
- **Edit from a reference:** yes, identity-preserving by construction.
- **Reference field:** `reference_image` — a single URI, *"Reference image
  containing the face/identity you want to preserve in the generation."*
- **Reference cap:** 1.
- **Aspect handling:** none in the registry's terms — `width`/`height` integers,
  defaulting to `768`×`1024`.
- **Output:** array of URIs.

## The reference field name is the odd one

The capability probe searches `image`, `image_input`, `images` in that fixed
order and then falls back to *any* URI-typed property, which is how
`reference_image` is found. Worth knowing when reading a stored row: this is the
one model where `reference_field` is not one of the three usual names, and it is
the fallback branch — not the priority list — that resolved it.

## Its defaults are already 3:4

`width` 768 × `height` 1024 is exactly 0.75, Vesper's target ratio. So even
though no shape key is sent (the registry has no width/height aspect mode yet),
the model renders at the right shape and `cropToTargetAspect` returns the buffer
untouched — it only crops when the ratio is actually off.

That is luck rather than design: any future default change on the model's side
would start costing a crop silently. When the registry learns width/height, this
row should pin them explicitly.

## No safety checker input, and none needed

There is **no `disable_safety_checker`** — and unlike
[Wan 2.7](wan-2-7-image-pro.md) or [Seedream 5 Lite](seedream-5-lite.md), that
absence is not a vendor gate. Those two proxy an external API that moderates
server-side; this one runs open weights on Replicate with no checker in the
wrapper to begin with, so there is nothing to disable.

## Identity weights

- `hyperlora_weight` — default `0.5`, range 0–1. *"Weight of the HyperLoRA
  identity effect."*
- `instantid_weight` — default `0.5`, range 0–1. *"Weight of the InstantID
  effect."*
- `facedetail_strength` — default `0.35`, range 0–1.

Both identity weights sit at half strength by default. If early renders drift off
the character's face, these are the knobs — the first per-model schema this row
will want.

## Inputs

- `prompt` — string. **Required.**
- `reference_image` — URI string. **Required.**
- `negative_prompt` — string, with a long quality-boilerplate default
  (`"lowres, bad anatomy, bad hands, text, error, …"`).
- `width` — integer, default `768`, range 64–1536.
- `height` — integer, default `1024`, range 64–1536.
- `steps` — integer, default `30`, range 1–150.
- `cfg` — number, default `7`, range 1–20.
- `sampler_name` — enum, default `"dpmpp_2m"`. Values: `euler`,
  `euler_ancestral`, `heun`, `dpmpp_2s_ancestral`, `dpmpp_2m`, `dpmpp_2m_sde`,
  `dpmpp_sde`, `uni_pc`.
- `scheduler` — enum, default `"karras"`. Values: `normal`, `karras`.
- `seed` — integer, default `0` (*"0 = random"*).
- `hyperlora_weight` / `instantid_weight` / `facedetail_strength` — see above.

There is **no `output_format`**, no `num_outputs`, and no safety input.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — take the
first entry.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "reference_image": "<single url>"
}
```

The leanest payload in the set: nothing in this model's schema matches the
constants `deriveExtraInput` pins, so the row's `extra_input` is empty. Output is
converted to WebP on write like everything else.
