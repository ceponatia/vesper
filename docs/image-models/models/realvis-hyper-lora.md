# RealVis Hyper LoRA

**Slug:** `nsfw-api/realvis-hyper-lora`
**Registered as:** `nsfw-api/realvis-hyper-lora:9b1951176565c8f810f28ed140787a81c8f49b49e2d40d0a135d9491b95782bd`
**Provenance:** probed 2026-08-05 against pinned version `9b1951176565c8f810f28ed140787a81c8f49b49e2d40d0a135d9491b95782bd`.

**Quality ruling:** outside the reviewed set — runs on the wrapper's own defaults

The model page carries no descriptive README. Its schema exposes a HyperLoRA +
InstantID pipeline over a RealVisXL checkpoint: a face reference plus a prompt,
with separate identity weights.

That makes it useful as a face-repair comparison arm, not a proven production
winner. It has no pose/control image field, so a full-frame re-render may improve
a face while changing body, clothing, camera, lighting, or setting.

Its reference field is named `reference_image`, unlike the registry's usual
`image`, `image_input`, or `images` names. Its provider defaults are 768×1024,
exactly Vesper's 3:4 target.

## Community model — pinned by version

`is_official` is false. The row is pinned to the version above and runs through
Replicate's versioned predictions endpoint. A new version requires a new probe,
semantic review, fixed-matrix trial, and license/terms review.

## Capabilities

- **Generate without a reference:** no; `prompt` and `reference_image` are
  required.
- **Identity-guided render:** yes, through HyperLoRA/InstantID weights.
- **Reference field:** `reference_image`, one URI containing the identity face.
- **Reference cap:** 1.
- **Aspect handling:** free `width`/`height` integers.
- **Output:** array of URIs.

## Reference-field probing

The capability probe checks the common image names first and then falls back to
any URI-typed input. `reference_image` is found by that fallback. The stored
field name is therefore essential; a hardcoded generic `image` key would fail.

## Native dimensions

The provider defaults to 768×1024, which is already Vesper's 3:4 portrait shape —
`cropToTargetAspect` returns the buffer unchanged at that size.

Vesper does not pin those values. This model is outside the reviewed set, so
the reviewed policy (`packages/image-core/src/models/reviewed-profile-controls.ts`) has no entry for it and the
generic registry has no free width/height aspect mode to negotiate one either.
The shape therefore rides on the wrapper's own default, and a future wrapper
update that changed it would change Vesper's output shape with nothing to catch
it. An admin who wants the size fixed sets `width`/`height` on the row.

## Identity/detail controls

- `hyperlora_weight` — default 0.5, range 0–1;
- `instantid_weight` — default 0.5, range 0–1;
- `facedetail_strength` — default 0.35, range 0–1.

Raising identity weights may improve likeness but increase prompt/composition
tradeoffs. The first trial holds defaults and tests reference quality/prompt
behavior before tuning these values one at a time.

## Negative prompt policy

The wrapper has a long generic quality/anatomy/style default. Omitting the field
would silently activate that boilerplate even though the shared render seam does
not know intended style, text, blur, morphology, or authored absences.

Vesper does not clear it. Outside the reviewed set nothing overrides the wrapper,
so that boilerplate reaches every render. An admin who wants it gone sets
`negative_prompt` to an empty string on the row; `buildRegistryModelInput`
preserves an empty value rather than dropping the key and letting the provider
restore its default.

## Safety input

There is no `disable_safety_checker`. Unlike vendor-proxied models, this wrapper
publishes no safety toggle for Vesper to map.

## Inputs

- `prompt` — string, required.
- `reference_image` — URI string, required.
- `negative_prompt` — string with a long provider default; Vesper clears it.
- `width` — integer, default 768, range 64–1536.
- `height` — integer, default 1024, range 64–1536.
- `steps` — integer, default 30, range 1–150.
- `cfg` — number, default 7, range 1–20.
- `sampler_name` — enum, default `dpmpp_2m`; includes Euler, Heun, and DPM++
  variants.
- `scheduler` — enum, default `karras`.
- `seed` — integer, provider-default 0 meaning random.
- `hyperlora_weight`, `instantid_weight`, `facedetail_strength` — identity/detail
  controls above.

There is no `output_format`, `num_outputs`, pose input, or safety input.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — Vesper
takes the first result and normalizes it to WebP on write.

## Effective current Vesper payload

```json
{
  "prompt": "<built prompt>",
  "negative_prompt": "",
  "reference_image": "<single identity url>",
  "width": 768,
  "height": 1024
}
```

These reviewed additions are applied at `renderWithModel` until task profiles own
them.

## Trial and production gate

RealVis is an admin comparison arm for single-character face repair. The trial
must grade identity improvement and full-frame drift against Qwen and Pony. It
should not be promoted merely because the face looks closer if pose, body,
wardrobe, setting, or lighting change.

The model also requires a recorded review of its checkpoint/wrapper license and
intended hosted product use before becoming a production default or paid feature
path.
