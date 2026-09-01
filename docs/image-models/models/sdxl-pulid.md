# SDXL PuLID

**Slug:** `nsfw-api/sdxl-pulid`
**Registered as:** `nsfw-api/sdxl-pulid:83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5`
**Provenance:** probed 2026-08-11 against pinned version `83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5`.

**Quality ruling:** experimental identity-specialist candidate

The model page carries no description text. Its schema exposes a PuLID
identity-adapter pipeline: a face reference plus a prompt, with a depth-guided
ControlNet as a second, distinct image role. Lifetime run count on Replicate is
283 — barely exercised on the platform, and by far the least-exercised model in
this batch.

## The checkpoint is Pony Realism, not stock SDXL

The workflow loads `pony_realism_23.safetensors` (observed in prediction logs
2026-08-31 against the pinned version above), while the adapter it applies is
`ip-adapter_pulid_sdxl_fp16`, which is trained against stock SDXL. Pony-family
fine-tunes shift the UNet far enough that an SDXL-trained identity adapter
transfers weakly and the checkpoint's own facial prior competes with the
reference; the person bias measured on
[LikeReality Pony v1](likereality-pony-v1.md) is the same family effect. Any
likeness expectation for this row is bounded by that pairing, not by PuLID's
published behavior on stock SDXL.

## Community model — pinned by version

`is_official` is false, so the row is pinned to the version above and runs
through Replicate's versioned predictions endpoint. It does not follow future
releases. A new version requires a new probe, semantic review, fixed-matrix
trial, and license/terms review.

## Capabilities

- **Generate without a reference:** no in practice. The schema marks `prompt`
  as the only required input, but the live workflow refuses bare prompts —
  every prediction fails with "PuLID requires a reference face image to work
  properly" (measured 2026-08-29 against the pinned version above). A
  `reference_image` must ride every request.
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
[registry.md](../../images/providers/registry.md).

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

## A changed reference reaches only a cold container

The wrapper writes every supplied `reference_image` to the fixed path
`/tmp/inputs/reference.png`, and ComfyUI keys its `LoadImage` node on that
filename rather than on file content. On a warm container the reference load is
therefore served from the execution cache, and so is the whole PuLID chain
downstream of it — the InsightFace embedding and the patched model that
`ApplyPulid` produces. The sampler runs against the face from the container's
previous prediction, and the newly supplied reference is fetched, written to
disk, and never read.

Measured 2026-08-31 against the pinned version above, from three consecutive
predictions each carrying its own reference. The cold prediction executed
`LoadImage → PulidInsightFaceLoader → PulidEvaClipLoader → PulidModelLoader →
ApplyPulid → KSampler` in 44.6s of predict time. The two warm ones executed
`CLIPTextEncode → KSampler → VAEDecode → SaveImage` and nothing else, in 4.9s —
which is 30 sampler steps at the observed 7.5 it/s with no room for face
detection or an EVA-CLIP encode.

Nothing in the declared input schema can invalidate that cache, so this is a
property of the endpoint rather than a payload mistake. The consequences are
load-bearing for anything that grades this model:

- Back-to-back renders carrying different references grade one cached face.
  Every arm of a comparison needs its own cold container.
- Public models serve many accounts from the same warm container, so a cached
  face is not necessarily one this account supplied.
- A render that silently reused a stale embedding still reports `succeeded`,
  with a payload naming the reference it ignored.

## Negative-prompt behavior

The field is live and unselective (fruit-bowl suppression canary, 2026-08-29,
against the pinned version above): with a high OFF-arm base rate, negating
`apple, apples, red apple` removed apples from every ON render at `cfg` 3 and
`cfg` 7 — and removed the subject concept with them. Every ON render lost the
fruit bowl itself (soup, porridge, purée) while OFF bowls stayed intact (8/10
at cfg 3, 6/6 at cfg 7): negating a concept on this wrapper bleeds into
everything semantically adjacent. No reviewed control or production lane
sends the field; per-block negative trials are permitted on this endpoint —
the channel is not inert — but must grade collateral damage as a first-class
metric, and no lane adopts the field until a block trial proves a wording
selective enough to trust.

Two more measurements from the same canary:

- `cfg` 7 markedly improves prompt adherence over the provider default of 3:
  OFF-arm fruit bowls were 6/6 coherent at cfg 7 against 8/10 with degenerate
  renders at the default — relevant to this model's adapter execution hints.
- The endpoint does not reliably serve identical repeat requests: the
  determinism control's second render failed three consecutive times
  ("replicate returned no image") while its identical twin succeeded, so seed
  reproducibility is unverified.

## Shape, method and identity strength are pinned

The reviewed policy (`packages/image-core/src/models/reviewed-profile-controls.ts`)
sends:

```json
{
  "width": 832,
  "height": 1216,
  "method": "fidelity",
  "face_weight": 1,
  "cfg": 7
}
```

Each one corrects a wrapper default that is wrong for how Vesper uses this row:

- `width`/`height` default to 512×512 — both off-shape for a 3:4 crop and far
  below Vesper's 768×1024 canonical portrait.
- `method` defaults to `fidelity`, which is already the setting Vesper wants.
  Pinning it explicitly means a provider-side default change cannot silently
  move this model from identity preservation to style transfer.
- `face_weight` defaults to 0.8 on a row registered for identity preservation.
  Vesper sends the field's 1.0 ceiling: there is no reading of that purpose on
  which the adapter belongs at four-fifths strength, and the field offers no
  headroom past it.
- `cfg` defaults to 3, which the canary below measured as the weak arm on this
  endpoint — 6/6 coherent renders at 7 against 8/10 with degenerate output at
  the default.

`face_weight` travels as a raw provider override, as `method` does: the
normalized control vocabulary has no word for the strength of an identity
adapter. `cfg` travels as the `guidance` control, which is exactly the word for
it.

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

`for_portrait` is false. Its purpose in this registry is identity-guided
variants and scenes, which is what `for_variant` and `for_scene` are for, and
the workflow refuses bare prompts anyway — see Capabilities above, which owns
that measurement.

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
  "method": "fidelity",
  "face_weight": 1,
  "cfg": 7
}
```

`depth_image` is never included.

## Trial and production gate

No Vesper trial has been run — `identity_preservation` stays `unknown` until
one grades identity improvement and full-frame drift against a held
reference face, not merely whether an output looks plausible. Every arm of such
a trial runs on its own cold container, for the reason recorded above: a warm
container grades a cached face rather than the reference the arm supplied.
Reliability is itself part of what a trial has to answer: at 283 lifetime runs
this is the least-exercised model in the batch, and it is also the only
reference-capable model among the four seeded here. The model also requires a recorded review
of its checkpoint/wrapper license and intended hosted product use before it
becomes a production default or a paid feature path.
