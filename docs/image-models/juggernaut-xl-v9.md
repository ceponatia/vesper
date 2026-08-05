# Juggernaut XL v9

**Slug:** `lucataco/juggernaut-xl-v9`
**Probed:** 2026-08-05, version `bea09cf018e513cef0841719559ea86d2299e05448633ac8fe270b5d5cd6777e`

> Juggernaut XL v9

A photorealism-tuned SDXL checkpoint, run on Replicate's own GPUs. The SDXL
lineage matters here: these community fine-tunes are trained far less
conservatively than the newer editor architectures, and they ship with a safety
checker that is a wrapper component rather than a vendor-side gate. Offered for
portraits only — it has no reference input at all.

## Capabilities

- **Generate without a reference:** yes. Nothing is required: `prompt` itself has
  a default (a stock portrait description), so an empty payload still renders.
- **Edit from a reference:** **no.** There is no URI input of any kind, so the
  row can never be offered on the scene or variant surfaces.
- **Aspect handling:** none — see below.
- **Output:** array of URIs.

## No aspect input, and no width/height support yet

Shape comes from `width`/`height` integers, both defaulting to `1024`. Vesper's
registry understands two aspect modes (`aspect_ratio` enums and Wan-style `size`
pixel pairs) and neither matches a pair of free integers, so no shape key is sent
and the model renders **1024×1024**. `renderWithModel` then centre-crops that
square to 3:4, discarding about a quarter of the width.

The result is correctly shaped and usable, but it wastes pixels and crops framing
the model chose. Teaching the registry a third aspect mode — `width`/`height`
integers — is the natural next step, and would serve this model,
[Pony Realism v2.3](pony-realism-v2-3.md) and
[RealVis Hyper LoRA](realvis-hyper-lora.md) at once.

## The watermark default

`apply_watermark` defaults to **`true`** on this model — an invisible-ish
provenance watermark stamped into every output. It is the only model in the set
with such an input, and a default that would silently mark every Vesper image, so
the capability probe pins it to `false` (`deriveExtraInput`), the same way it
pins the group-generation inputs that would otherwise return image sets.

## Fast-path defaults

`num_inference_steps` defaults to `5` and `guidance_scale` to `2` — the
Lightning-style fast configuration rather than a 30-step render. Expect quick,
slightly softer results out of the box; raising steps is a per-model knob for
later.

## Inputs

- `prompt` — string. Defaults to a stock portrait description, so it is not
  formally required.
- `negative_prompt` — string, default `"CGI, Unreal, Airbrushed, Digital"`.
- `width` / `height` — integer, both default `1024`.
- `num_outputs` — integer, default `1`, range 1–4.
- `scheduler` — enum, default `"DPM++SDE"`. Values: `DDIM`,
  `DPMSolverMultistep`, `HeunDiscrete`, `KarrasDPM`, `K_EULER_ANCESTRAL`,
  `K_EULER`, `PNDM`, `DPM++SDE`.
- `num_inference_steps` — integer, default `5`, range 1–100.
- `guidance_scale` — number, default `2`, range 1–20.
- `seed` — integer.
- `apply_watermark` — boolean, default `true`. Pinned off by Vesper.
- `disable_safety_checker` — boolean, default `false`.

There is **no `output_format`** and no aspect input.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — take the
first entry.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "num_outputs": 1,
  "apply_watermark": false,
  "disable_safety_checker": true
}
```

No shape key is sent; the 1024×1024 result is cropped to 3:4 after download.

## If you want Juggernaut on the scene surface

`asiryan/juggernaut-xl-v7` is the same checkpoint family one version back, and it
*does* take a reference: `image` plus a `mask` for inpainting, a `strength` knob,
and `lora_weights`. The trade is that it is older and exposes **no**
`disable_safety_checker` input at all. It is not registered today; add it from
the admin page if the img2img path is worth testing.
