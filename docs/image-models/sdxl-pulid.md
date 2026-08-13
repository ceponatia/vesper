# SDXL PuLID

**Slug:** `nsfw-api/sdxl-pulid`
**Registered as:** `nsfw-api/sdxl-pulid:83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5`
**Probed:** 2026-08-11, version `83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5`
**Quality ruling:** experimental identity-specialist candidate

The model page carries no description text. Its schema exposes a PuLID
identity-adapter pipeline over an SDXL checkpoint: a face reference plus a
prompt, with a depth-guided ControlNet as a second, distinct image role.
Lifetime run count on Replicate is 283 — barely exercised on the platform, and
by far the least-exercised model in this batch.

## Community model — pinned by version

`is_official` is false, so the row is pinned to the version above and runs
through Replicate's versioned predictions endpoint. It does not follow future
releases. A new version requires a new probe, semantic review, fixed-matrix
trial, and license/terms review.

## Capabilities

- **Generate without a reference:** yes. `prompt` is the only required input.
- **Edit from a reference:** yes, through PuLID's face-embedding adapter.
- **Reference field:** `reference_image`, one URI. See below for why this is
  not `depth_image`.
- **Reference cap:** 1.
- **Aspect handling:** free `width`/`height` integers; no `aspect_ratio` or
  `size` input.
- **Output format control:** none.
- **Safety toggle:** none.
- **Output:** array of URIs.

## Reference-field resolution

This model declares two URI-typed inputs — `reference_image` and
`depth_image` — and `depth_image` comes first in the schema's property order.
The capability probe's `findReferenceField` (`packages/image-replicate/src/probe.ts`)
resolves a reference field by checking a preferred-name list first (`image`,
`image_input`, `images`, `reference_image`, `face_image`), then the model's
remaining properties in schema order, and only then a deprioritized list of
control-style names (`depth_image`, `pose_image`, `mask`, `mask_image`,
`control_image`) held for last. `reference_image` sits on the preferred list
and `depth_image` on the deprioritized one, so the probe resolves this
model's reference field to `reference_image` despite its later position in
the schema. The general policy — and why control names are deprioritized
rather than excluded — is recorded once in
[../images/providers.md](../images/providers.md).

SDXL PuLID is why that ordering matters in practice. A resolver that simply
took the first URI-typed property in schema order would land on `depth_image`
— handing a character's identity portrait to a ControlNet depth converter,
which renders a silhouette-shaped stranger rather than that person, with
nothing in the payload looking wrong. It is the first registered model where
getting the order right actually changes the outcome:
[RealVis Hyper LoRA](realvis-hyper-lora.md) resolves correctly too, but for a
less demanding reason — `reference_image` is its only URI-typed input, so any
reasonable resolution order would have found it.

Vesper never sends `depth_image`.

## Shape and method are pinned

The provider defaults `width`/`height` to 512×512 — both off-shape for a 3:4
crop and far below Vesper's 768×1024 canonical portrait. `method` defaults to
`fidelity`, which is already the setting Vesper wants, but pinning it
explicitly means a provider-side default change cannot silently move this
model from identity preservation to style transfer.
`packages/image-core/src/models/quality-presets.ts` sends:

```json
{
  "width": 832,
  "height": 1216,
  "method": "fidelity"
}
```

Vesper uses this model for identity preservation, not style transfer, so
`method` is never left to inherit whatever the provider ships as its default
tomorrow.

## Reviewed capability

Both ratings are `unknown`, and each for a different reason:

- **Edit kind:** `unknown`. The vocabulary — `instruction_edit`,
  `multi_reference_compose`, `img2img`, `none` — has no term for what PuLID
  actually does. It injects face embeddings into the diffusion process rather
  than following an edit instruction or repainting from a strength value, so
  none of the three positive terms fit, and `unknown` is the honest label.
  `unknown` is also the column's permissive default, so this model still
  passes the identity-critical eligibility gate (`profileEligibility` in
  `image-model-profiles.ts`) rather than being locked out by a rating nobody
  has written.
- **Identity preservation:** `unknown`. PuLID is designed for likeness — that
  is the entire point of a face-embedding adapter — but designed-for is not
  measured, and no Vesper trial has looked at its output.
- **Operator warning:** *"PuLID identity adapter with 283 lifetime Replicate
  runs and no Vesper trial — likeness is unmeasured. Single reference only,
  so scene renders never reach the multi-reference rung. Its depth_image
  ControlNet input is never sent."* Bound for the admin card and the model
  pickers; no surface renders it yet.

## Not offered for portraits

`for_portrait` is false even though the model can generate from a bare
prompt. That is a choice, not a capability gap: with no reference supplied,
PuLID is an ordinary SDXL generator with nothing to recommend it over the
models already offered on the portrait surface. Its purpose in this registry
is identity-guided variants and scenes, which is what `for_variant` and
`for_scene` are for.

## Seeded profiles

Two, neither the global default:

- `variant-standard` (Variant Standard) — task `variant`, `edit`,
  `instruction_edit`, `identity` required and `style` allowed.
- `scene-standard` (Scene Standard) — task `scene`, `edit`,
  `instruction_edit`, identity → location → style → object with nothing
  required.

`instruction_edit` is the prompt strategy every seeded edit profile carries,
on this model as on every other — the lane still picks its reference mode at
render time (as [Seedream 5 Lite](seedream-5-lite.md) notes for the
multi-reference models). Reference cap 1 means the scene ladder's
multi-reference rung is never reachable on this model: a `multi` scene render
degrades to the single-reference rung instead.

## Inputs

- `prompt` — string. **Required.**
- `negative_prompt` — string, default `""`.
- `reference_image` — URI string. Optional. *"An image containing a face that
  you want to use as reference for face swapping."*
- `depth_image` — URI string. Optional. *"RGB image that will be converted to
  a depth map and used as ControlNet guidance."* Never sent by Vesper — see
  Reference-field resolution above.
- `method` — enum, default `fidelity`. Values: `fidelity`, `style`, `both`
  (*"fidelity for face swapping, style for style transfer, both for a mix"*).
- `face_weight` — number, default `0.8`, range 0–1.
- `depth_strength` — number, default `1`.
- `width` — integer, default `512`.
- `height` — integer, default `512`.
- `steps` — integer, default `30`.
- `cfg` — number, default `3`.
- `seed` — integer, default `0` (`0` = random).
- `sampler_name` — enum, default `euler_ancestral`. Values: `euler`,
  `euler_ancestral`, `heun`, `dpmpp_2s_ancestral`, `uni_pc`.
- `scheduler` — enum, default `normal`. Values: `beta`, `normal`.

There is no `output_format` or `disable_safety_checker` input, and no
image-typed input beyond `reference_image` and `depth_image`.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — Vesper
takes the first result.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "reference_image": "<single identity url>",
  "width": 832,
  "height": 1216,
  "method": "fidelity"
}
```

`depth_image` is never included.

## Trial and production gate

No Vesper trial has been run — `identity_preservation` stays `unknown` until
one grades identity improvement and full-frame drift against a held
reference face, not merely whether an output looks plausible. Reliability is
itself part of what a trial has to answer: at 283 lifetime runs this is the
least-exercised model in the batch, and it is also the only reference-capable
model among the four seeded here. The model also requires a recorded review
of its checkpoint/wrapper license and intended hosted product use before it
becomes a production default or a paid feature path.
