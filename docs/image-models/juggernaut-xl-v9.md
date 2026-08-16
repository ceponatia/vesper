# Juggernaut XL v9

**Slug:** `lucataco/juggernaut-xl-v9`
**Registered as:** `lucataco/juggernaut-xl-v9:bea09cf018e513cef0841719559ea86d2299e05448633ac8fe270b5d5cd6777e`
**Probed:** 2026-08-05, version `bea09cf018e513cef0841719559ea86d2299e05448633ac8fe270b5d5cd6777e`
**Quality ruling:** outside the reviewed set — runs on the wrapper's own defaults

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
bucket of 832×1216, roughly 30–40 steps, and moderate CFG:

- `width: 832`;
- `height: 1216`;
- `num_inference_steps: 35`;
- `guidance_scale: 5`;
- `scheduler: "KarrasDPM"`;
- `negative_prompt: ""`.

**Vesper does not send these.** This model is outside the reviewed set, so
the reviewed policy (`packages/image-core/src/models/reviewed-profile-controls.ts`) has no entry for it and an
admin who registers it gets the cog's own defaults — 5 steps at guidance 2, a
1024-square render, and the wrapper's media-biased negative. The values above are
recorded as the creator's recommendation, for an admin who wants to configure
this endpoint themselves through the row's `extra_input` or a task profile.

This is normal Juggernaut XL v9, not the separately published Lightning build;
the cog's fast defaults are a wrapper preset rather than the checkpoint's
intended configuration.

## Shape behavior

The registry's generic aspect modes do not represent free width/height inputs, so
`chooseAspect` has no aspect key to send here and the model renders at whatever
its own `width`/`height` defaults say. `renderWithModel` normalizes the returned
image to the lane target afterward.

At the cog's 1024×1024 default that crop discards about a quarter of the width to
reach Vesper's 3:4 portrait. Rendering the 832×1216 bucket instead costs only a
modest top/bottom trim — an admin who wants that has to set it on the row, since
no reviewed policy sets it for this model.

## Negative prompt policy

The wrapper's default negative is:

```text
CGI, Unreal, Airbrushed, Digital
```

That hidden default makes assumptions about rendering media and conflicts with
the creator's recommendation to begin with little or no negative prompt. It is
sent on every render unless an admin clears it: outside the reviewed set nothing
overrides it. Setting `negative_prompt` to an empty string on the row clears it,
and `buildRegistryModelInput` preserves an empty value rather than dropping the
key and letting the provider restore its own default.

Vesper never adds anatomy or production terms of its own at the context-free
render seam. Printed clothing, graphic marks, unusual morphology, or authored
absences can all make a generic block wrong.

## The watermark default

`apply_watermark` defaults to `true`. The capability probe pins it to `false` on
every model that declares the input, this one included — that is a probe rule
rather than a reviewed-set one, so it still applies here.

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
