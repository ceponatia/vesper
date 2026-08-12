# Juggernaut XL v9

**Slug:** `lucataco/juggernaut-xl-v9`
**Registered as:** `lucataco/juggernaut-xl-v9:bea09cf018e513cef0841719559ea86d2299e05448633ac8fe270b5d5cd6777e`
**Probed:** 2026-08-05, version `bea09cf018e513cef0841719559ea86d2299e05448633ac8fe270b5d5cd6777e`
**Quality ruling:** 2026-08-05

> Juggernaut XL v9

A photorealism-tuned SDXL checkpoint, run on Replicate's GPUs. Offered for
portraits only — this endpoint has no reference input and therefore cannot serve
normal variants or identity-critical scenes.

## Community model — pinned by version

`is_official` is false, so the row is pinned to the version above and runs
through Replicate's versioned predictions endpoint. It does not follow future
releases. A different version must be probed, semantically reviewed, trialed, and
license-reviewed before activation.

## Capabilities

- **Generate without a reference:** yes. Nothing is formally required because
  `prompt` has a provider default.
- **Edit from a reference:** no. There is no URI input.
- **Aspect handling:** free `width` and `height` integers rather than an aspect
  enum.
- **Output:** array of URIs; Vesper takes the first result.

## Normal v9, not Lightning

The endpoint schema defaults to 5 inference steps and guidance 2, but the
checkpoint is normal Juggernaut XL v9. The separately published Lightning build
is a different model.

The creator's v9 guidance uses full-step SDXL settings and recommends a portrait
bucket of 832×1216, roughly 30–40 steps, and moderate CFG. Vesper's reviewed
starting point is:

- `width: 832`;
- `height: 1216`;
- `num_inference_steps: 35`;
- `guidance_scale: 5`;
- `scheduler: "KarrasDPM"`;
- `negative_prompt: ""`.

These values are applied by `packages/image-core/src/models/quality-presets.ts` at the shared
render seam. They overlay the probed row because provider defaults describe what
the cog will do, not the quality policy Vesper wants.

The fixed trial may tune the sampler and numeric values. It does not revisit
whether this is a Lightning checkpoint.

## Shape behavior

The registry's generic aspect modes do not yet represent free width/height
inputs. The reviewed runtime policy sends 832×1216 through `extraInput` anyway.
`chooseAspect` has no aspect key to send, and `renderWithModel` normalizes the
returned image to the lane target afterward.

For Vesper's 3:4 portrait output, 832×1216 is slightly taller than target and
requires a modest top/bottom crop. This is a substantial improvement over the
old behavior: 1024×1024 followed by discarding about a quarter of the width.

The capabilities plan should eventually model explicit dimensions and focal-aware
cropping as profile controls. Until then, the exact-slug quality policy owns this
endpoint's native portrait size.

## Negative prompt policy

The wrapper's default negative is:

```text
CGI, Unreal, Airbrushed, Digital
```

That hidden default makes assumptions about rendering media and conflicts with
the creator's recommendation to begin with little or no negative prompt. Vesper
therefore sends an explicit empty string. `buildRegistryModelInput` preserves the
empty value, so the provider cannot silently restore its default.

No anatomy or production terms are added at this context-free seam. Printed
clothing, graphic marks, unusual morphology, or authored absences can all make a
generic block wrong. A later portrait profile may add conflict-checked terms and
compare them against the empty baseline.

## The watermark default

`apply_watermark` defaults to `true`. The capability probe pins it to `false`, and
the reviewed quality policy preserves that override.

## Inputs

- `prompt` — string; provider supplies a stock default.
- `negative_prompt` — string, provider default
  `"CGI, Unreal, Airbrushed, Digital"`.
- `width` / `height` — integer, both provider-default 1024.
- `num_outputs` — integer, default 1, range 1–4.
- `scheduler` — enum, default `DPM++SDE`; includes `KarrasDPM` and other common
  schedulers.
- `num_inference_steps` — integer, provider-default 5, range 1–100.
- `guidance_scale` — number, provider-default 2, range 1–20.
- `seed` — integer.
- `apply_watermark` — boolean, provider-default true; pinned off by Vesper.
- `disable_safety_checker` — boolean, provider-default false.

There is no `output_format` field and no aspect enum.

## Effective Vesper payload

The prompt varies by lane; the effective control portion is:

```json
{
  "width": 832,
  "height": 1216,
  "num_outputs": 1,
  "num_inference_steps": 35,
  "guidance_scale": 5,
  "scheduler": "KarrasDPM",
  "negative_prompt": "",
  "apply_watermark": false,
  "disable_safety_checker": true
}
```

The image is downloaded and normalized to the requested Vesper aspect.

## License/terms gate

This is a community checkpoint. Before making it a production default, paid
feature dependency, or other server-side commercial path, record a current
review of the checkpoint license and the intended hosted/API use. Replicate
availability is not itself permission for every product use.

Until that review and the fixed quality trial pass, Juggernaut remains a reviewed
experimental portrait option rather than a production-default claim.

## Related model possibility

`asiryan/juggernaut-xl-v7` is an older family member that exposes image,
mask/inpainting, strength, and LoRA inputs. It also differs in safety inputs and
needs its own version probe, semantic rating, license review, and identity trial.
It is not a drop-in scene-capable version of this row.
