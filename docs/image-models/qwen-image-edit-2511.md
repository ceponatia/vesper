# Qwen Image Edit 2511

**Slug:** `qwen/qwen-image-edit-2511`
**Probed:** 2026-08-05, version `a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729`
**Quality ruling:** 2026-08-05

> An enhanced version over Qwen-Image-Edit-2509, featuring multiple improvements
> including notably better consistency.

Vesper's default for chat scene images and portrait variants. It is the current
instruction editor used when the application must preserve a known character,
but “identity-preserving” is a relative capability rating rather than a promise
of exact likeness. The owner has observed faces that remain similar while losing
recognisable facial structure, which is why this model is the first target of the
render-quality plan.

## The edit-only built-in

This is the only seeded model whose reference input is required. Its schema
declares `required: ["prompt", "image"]`, so it cannot generate from a prompt
alone and is never offered in the new-portrait picker.

## Capabilities

- **Generate without a reference:** no.
- **Edit from a reference:** yes — this is its purpose.
- **Reference field:** `image`, an array of URIs despite the singular name. The
  sibling [Qwen Image 2512](qwen-image-2512.md) uses the same key for a single
  URI.
- **Reference workflow:** 1–3 reference images. Vesper stores a cap of 3.
- **Aspect handling:** `aspect_ratio` enum includes `3:4`.
- **Output:** array of URIs; WebP available.

## Reviewed capability

Reviewed by hand and never overwritten by a schema probe:

- **Edit kind:** `instruction_edit`;
- **Identity preservation:** `strong` relative to generic img2img/repaint models;
- **Operator warning:** none.

The `strong` rating keeps Qwen eligible for identity-critical tasks. It does not
mean every output is the exact same face. Trial results and future advisory
identity checks should remain separate from the coarse eligibility rating.

## Quality policy at the render seam

The provider defaults `go_fast` to `true`. The reviewed policy
(`packages/image-core/src/models/reviewed-profile-controls.ts`) pins it off,
carried both by this model's task profiles (as a provider override) and by the
transitional overlay at the shared render seam:

```json
{
  "go_fast": false
}
```

All current Qwen Edit jobs are identity-critical. Quality therefore wins over
the provider's speed preset. This model carries no curated fast/quality profile
variants; a non-identity task on it would need profile-level settings in place
of this global override before fast and quality work could diverge.

The effective value differs from the raw `image_models.extra_input` row.
Diagnostics and provenance report the final payload, not infer it from the row.

## Numbered-reference instruction policy

Qwen's multi-image guidance recommends identifying which image supplies which
subject or visual element and stating what should change versus remain fixed.
The existing Vesper builders still emit a provider-neutral identity sentence, so
`preparePromptForImageModel` rewrites only that exact sentence for this model.

With one reference:

```text
Image 1 is the identity reference. Preserve the exact face, hair, skin tone,
body proportions, and apparent age. Change only what this instruction requests.
```

With several references:

```text
Use numbered references as assigned below. Preserve each person's exact face,
hair, skin tone, build, and apparent age; change only requested details.
```

The scene prompt already enumerates references later in send order. The quality
seam supplies the interpretation contract without changing non-Qwen prompts or
custom Qwen instructions that do not contain the legacy lock.

Both replacements are no longer than the generic sentence they replace. The edit
builder has already fitted its prompt before model selection, so provider-specific
preparation cannot silently re-expand it beyond the fitted budget.

The apparent-age requirement remains text-authoritative. This preserves the owner
ruling that age text must correct an age-ambiguous reference rather than inherit
drift from it.

## Seeded profiles

Three profiles exist, all `operation: edit` with the `instruction_edit` prompt
strategy, and each is its task's global default
([providers.md](../images/providers.md)):

- `variant-standard` — task `variant`; identity required, style optional;
- `scene-standard` — task `scene`; identity → location → style → object. It
  requires no reference at profile-definition level because the existing scene
  degradation ladder includes a bare-prompt rung, although the provider itself
  still requires at least one image;
- `chat-look-standard` — task `chat_look`; identity required, style optional.

All three carry empty control defaults. This model has no curated profiles
beyond them; the `go_fast` override stays at the quality seam above.

## Identity references

A waist-up portrait may contain too few face pixels for exact identity, so the
identity reference(s) an edit render sends come from the identity-pack service —
[identity-packs.md](../images/identity-packs.md) owns crop derivation, quality
gates, and provenance. A face crop that cannot clear the quality gate is never
sent merely to fill a reference slot.

Reference selection and ordering are the resolved profile's policy
([providers.md](../images/providers.md)): required identity references outrank
optional face-detail and location references, and a required reference that
does not survive selection refuses the render rather than silently dropping one
person's identity.

## Inputs

- `prompt` — string, required. It is an edit instruction, not merely a scene
  description.
- `image` — array of URI strings, required. JPEG, PNG, GIF, or WebP references.
- `aspect_ratio` — enum, provider default `"match_input_image"`. Values:
  `match_input_image`, `1:1`, `16:9`, `9:16`, `4:3`, `3:4`.
- `go_fast` — boolean, provider default `true`; Vesper's current effective value
  is `false`.
- `output_format` — enum, provider default `"webp"`. Values: `webp`, `jpg`,
  `png`.
- `output_quality` — integer, default `95`, range 0–100.
- `seed` — integer.
- `disable_safety_checker` — boolean, default `false`.

There is no `strength` or `prompt_strength` control. Edit intensity and unchanged
content are governed by the instruction and references.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — Vesper
takes the first result.

## Effective Vesper payload

```json
{
  "prompt": "<compact numbered edit instruction>",
  "image": ["<url 1>", "<url 2>"],
  "aspect_ratio": "3:4",
  "output_format": "webp",
  "output_quality": 95,
  "go_fast": false,
  "disable_safety_checker": true
}
```

`aspect_ratio` is sent explicitly rather than left at `match_input_image`, so a
non-conforming reference cannot dictate the output shape.

## Known limitations

- exact face likeness is not reliable enough to treat the canonical portrait as
  a sufficient identity system by itself;
- several references compete for a cap of three;
- no negative prompt or numeric edit-strength control exists;
- a second full-frame repair pass may change pose, body, clothing, or setting;
- multi-character face repair is deferred until target localization and
  role-aware reference capacity are proven.
