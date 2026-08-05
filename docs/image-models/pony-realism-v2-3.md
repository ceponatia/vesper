# Pony Realism v2.3

**Slug:** `nsfw-api/pony-realism-v2.3`
**Probed:** 2026-08-05, version `7d1b41807ba3094e6d88e8eeeeb97425514bbbac00fc1aabc935612942a9cd7f`

The model page carries no description. From its schema it is an **InstantID +
IP-Adapter + ControlNet identity pipeline** over a Pony Realism SDXL checkpoint:
you give it a face, a prompt, and optionally a pose reference, and it renders a
new image of that person. Run on Replicate's own GPUs.

Note the slug: `pony-realism-v2.3` with a dot. `nsfw-api/pony-realism-v23` and
`nsfw-api/pony-realism` both 404.

Low run count (212 at probe time), so treat reliability as unproven relative to
the Qwen defaults.

## Capabilities

- **Generate without a reference:** **no.** `image` is required, so this model
  can never serve the new-portrait surface.
- **Edit from a reference:** yes, and identity-preserving by construction —
  IdentityNet/InstantID is what the pipeline is built around.
- **Reference field:** `image` — a single URI, described as *"Input face image"*.
- **Reference cap:** 1. (A second URI input exists — `pose_image` — but it is a
  different role, not a second identity slot. See below.)
- **Aspect handling:** none. No `aspect_ratio`, no `size`, not even
  `width`/`height`; the output shape follows the pipeline's own defaults, so
  Vesper crops after download.
- **Output:** array of URIs.

## The second image input is a pose, not a reference

`pose_image` is *"(Optional) reference pose image"* — it feeds the OpenPose
ControlNet (`enable_pose_controlnet`, default `true`) to dictate the subject's
posture, while `image` supplies the face. Vesper's render path sends one
reference to one field today, so `pose_image` goes unused.

It is a genuinely interesting seam for the scene lane: the scene composer already
produces an explicit pose, and a posed source image would be a stronger signal
than words. That belongs in the "expand the per-model schema" work, not in the
prompt + reference pass.

## Identity and detail knobs

Two scales control the tension every identity pipeline has between "looks like
them" and "looks good":

- `controlnet_conditioning_scale` — default `0.8`, *"IdentityNet strength (for
  fidelity)"*. Higher holds the face; too high flattens everything else.
- `ip_adapter_scale` — default `0.8`, *"image adapter strength (for detail)"*.

Left at their defaults for now. If renders come back looking like a generic
person rather than the character, this pair is the first thing to raise.

## Inputs

- `image` — URI string. **Required.** The face.
- `pose_image` — URI string, optional.
- `prompt` — string, default `"a person"`.
- `negative_prompt` — string, default `""`.
- `face_detection_input_width` / `face_detection_input_height` — integer, default
  `640`, range 640–4096.
- `scheduler` — enum, default `"EulerDiscreteScheduler"`. Values:
  `DEISMultistepScheduler`, `HeunDiscreteScheduler`, `EulerDiscreteScheduler`,
  `DPMSolverMultistepScheduler`, `DPMSolverMultistepScheduler-Karras`,
  `DPMSolverMultistepScheduler-Karras-SDE`.
- `num_inference_steps` — integer, default `30`, range 1–500.
- `guidance_scale` — number, default `7.5`, range 1–50.
- `ip_adapter_scale` — number, default `0.8`, range 0–1.5.
- `controlnet_conditioning_scale` — number, default `0.8`, range 0–1.5.
- `enable_pose_controlnet` — boolean, default `true`; `pose_strength` number,
  default `0.4`.
- `enable_canny_controlnet` — boolean, default `false`; `canny_strength` number,
  default `0.3`.
- `enable_depth_controlnet` — boolean, default `false`; `depth_strength` number,
  default `0.5`.
- `enable_lcm` — boolean, default `false`; with `lcm_num_inference_steps`
  (default `5`) and `lcm_guidance_scale` (default `1.5`). Faster, lower quality.
- `enhance_nonface_region` — boolean, default `true`.
- `output_format` — enum, default `"webp"`. Values: `webp`, `jpg`, `png`.
- `output_quality` — integer, default `80`, range 0–100.
- `num_outputs` — integer, default `1`, range 1–8.
- `seed` — integer.
- `disable_safety_checker` — boolean, default `false`.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — take the
first entry.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "image": "<single url>",
  "output_format": "webp",
  "output_quality": 95,
  "num_outputs": 1,
  "disable_safety_checker": true
}
```

No shape key is sent — the model has no aspect input — so whatever it returns is
centre-cropped to 3:4 after download.
