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

## Quality policy before profiles are wired

The provider defaults `go_fast` to `true`. The image-model profile rows are still
dormant, so `src/server/images/quality-presets.ts` applies the reviewed effective
setting at the shared render seam:

```json
{
  "go_fast": false
}
```

All current Qwen Edit jobs are identity-critical. Quality therefore wins over the
provider's speed preset. Once text repair or another non-identity task uses this
model, task profiles must replace this global override so fast and quality work
can diverge deliberately.

The effective value may differ from the raw `image_models.extra_input` row until
profile controls reach the render path. Diagnostics and provenance should report
the final payload, not infer it from the row.

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
hair, skin tone, build, and age; change only what this instruction requests.
```

The scene prompt already enumerates references later in send order. The quality
seam supplies the interpretation contract without changing non-Qwen prompts or
custom Qwen instructions that do not contain the legacy lock.

Both replacements are no longer than the generic sentence they replace. The edit
builder has already fitted its prompt before model selection, so provider-specific
preparation cannot silently re-expand it beyond the fitted budget.

The existing apparent-age sentence remains text-authoritative when it follows
the identity lock. This preserves the owner ruling that age text must correct an
age-ambiguous reference rather than inherit drift from it.

## Seeded profiles

Three profiles exist, all `operation: edit` with the `instruction_edit` prompt
strategy. They currently have empty control defaults and nothing calls the
profile layer yet:

- `variant-standard` — task `variant`; identity required, style optional;
- `scene-standard` — task `scene`; identity → location → style → object. It
  requires no reference at profile-definition level because the existing scene
  degradation ladder includes a bare-prompt rung, although the provider itself
  still requires at least one image;
- `chat-look-standard` — task `chat_look`; identity required, style optional.

When shared render intent lands, these profiles should become explicit fast and
quality variants, and the runtime `go_fast` override should move into the quality
profiles.

## Reference-quality roadmap

A waist-up portrait may contain too few face pixels for exact identity. The next
quality slice compiles the canonical portrait into an identity pack containing:

- canonical portrait;
- tight face crop;
- crop/source provenance;
- minimum face-size, blur, occlusion, and face-count checks.

The first single-character scene trial compares:

1. canonical portrait only;
2. canonical portrait + face crop;
3. the same references with fast mode on versus off;
4. numbered/delta-first instruction versus the prior generic sentence.

Only one variable changes per A/B. A face crop that cannot clear the quality gate
is not sent merely to fill a reference slot.

## Reference ordering

Until role-aware profile selection is live, the existing send order remains
application-defined. The target single-character order is:

1. canonical identity portrait;
2. close face crop for the same character;
3. location reference.

For multiple characters, required identity images outrank face-detail and
location references. If all required identities do not fit the cap, the profile
is ineligible; Vesper must not silently drop one person's identity.

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
