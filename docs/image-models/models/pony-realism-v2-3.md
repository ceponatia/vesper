# Pony Realism v2.3

**Slug:** `nsfw-api/pony-realism-v2.3`
**Registered as:** `nsfw-api/pony-realism-v2.3:7d1b41807ba3094e6d88e8eeeeb97425514bbbac00fc1aabc935612942a9cd7f`
**Provenance:** probed 2026-08-05 against pinned version `7d1b41807ba3094e6d88e8eeeeb97425514bbbac00fc1aabc935612942a9cd7f`.

**Quality ruling:** outside the reviewed set — runs on the wrapper's own defaults

The model page carries no descriptive README. Its schema exposes an InstantID /
IP-Adapter / ControlNet pipeline over a Pony Realism checkpoint: one image
supplies a face, and an optional second field supplies a pose.

That architecture makes it worth testing for character identity. It does not make
it proven. The model had a low run count when reviewed and has no Vesper trial
verdict, so it must not be described as automatically better than Qwen Edit.

Note the slug includes a dot: `pony-realism-v2.3`.

## Community model — pinned by version

`is_official` is false. The row is pinned to the version above and runs through
Replicate's versioned predictions endpoint. A new version requires a new probe,
semantic review, fixed-matrix trial, and license/terms review.

## Capabilities

- **Generate without a reference:** no; `image` is required.
- **Identity-guided render:** yes, via an input face and identity controls.
- **Reference field:** `image`, one URI described as the input face.
- **Additional visual field:** `pose_image`, a distinct optional URI role.
- **Aspect handling:** no aspect, size, width, or height input; normalize after
  download.
- **Output:** array of URIs.

## Face and pose are separate roles

`image` supplies identity. `pose_image` feeds an OpenPose ControlNet when
`enable_pose_controlnet` is true. They are not interchangeable references and
must not be represented as two anonymous slots.

The current generic adapter sends only the registered identity field, so
`pose_image` is unused. Using this model for identity repair needs role-aware
reference bindings — the identity-pack face crop on `image`, the source scene
output on `pose_image`, the scene's compact Pony dialect as the prompt, and an
explicit single-character guard.

Without those bindings Pony is not a normal scene option, and no route may bypass
the shared adapter with a permanent special-case payload.

## Identity/detail controls

- `controlnet_conditioning_scale`, default `0.8`, is described as IdentityNet
  fidelity strength;
- `ip_adapter_scale`, default `0.8`, controls image-adapter detail;
- `pose_strength`, default `0.4`, controls pose influence when pose ControlNet is
  active.

Higher identity settings may improve likeness but can flatten expression,
texture, or prompt adherence. Tune one control at a time on the fixed matrix. The
first trial holds provider defaults and tests references/prompt policy before
changing these scales.

## Prompt and negative ruling

The provider's `negative_prompt` default is empty. The transitional render policy
leaves the model byte-identical and does not add score tags or generic anatomy
terms.

Pony conventions such as `score_9`, `score_8_up`, `source_photo`, rating tags, or
negative `score_1`–`score_3` consume prompt context and can vary by checkpoint.
The sparse model page provides no evidence that this exact pinned wrapper benefits
from a particular convention. Those terms are therefore fixed-matrix trial arms,
not hardcoded runtime assumptions.

Anatomy negatives also wait for intended morphology and authored absences. A
non-human appendage count or missing digit cannot be safely evaluated at the
context-free seam.

## Inputs

- `image` — URI string, required identity face.
- `pose_image` — optional URI string.
- `prompt` — string, provider-default `a person`.
- `negative_prompt` — string, provider-default empty.
- `face_detection_input_width` / `face_detection_input_height` — integer,
  default 640, range 640–4096.
- `scheduler` — enum, provider-default `EulerDiscreteScheduler`; includes DEIS,
  Heun, Euler, and DPM Solver/Karras variants.
- `num_inference_steps` — integer, default 30.
- `guidance_scale` — number, default 7.5.
- `ip_adapter_scale` — number, default 0.8, range 0–1.5.
- `controlnet_conditioning_scale` — number, default 0.8, range 0–1.5.
- `enable_pose_controlnet` — boolean, default true; `pose_strength` default 0.4.
- optional canny and depth ControlNets with their strength controls.
- optional LCM acceleration, disabled by default.
- `enhance_nonface_region` — boolean, default true.
- `output_format` — enum, default WebP.
- `output_quality` — integer, provider-default 80; Vesper's probe pins 95.
- `num_outputs` — integer, default 1, range 1–8.
- `seed` — integer.
- `disable_safety_checker` — boolean, default false.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — Vesper
takes the first result in ordinary lanes.

## Effective current Vesper payload

```json
{
  "prompt": "<built prompt>",
  "image": "<single identity url>",
  "output_format": "webp",
  "output_quality": 95,
  "num_outputs": 1,
  "disable_safety_checker": true
}
```

No shape or `negative_prompt` key is added. The result is normalized to the lane
target after download. `pose_image` is not sent by the current generic path.

## Trial and production gate

Pony remains admin/experimental until a single-person identity trial measures:

- face likeness versus Qwen Edit;
- pose, clothing, body, setting, and lighting drift;
- anatomy relative to the character's intended morphology;
- the value of candidate Pony score/source/rating conventions;
- latency and cost;
- failure/reliability rate.

It also requires a recorded review of the checkpoint/wrapper license and intended
hosted product use before becoming a production default or paid feature path.
