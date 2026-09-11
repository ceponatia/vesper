# Qwen Image 3 Pro

**Slug:** `alibaba/qwen-image-3-pro`  
**Pinned Replicate version:** `2d41e651d91e3ff97dfd0f3f85c22ccc45e084f7edf843f701e49895f8398213`.

Qwen Image 3 Pro is the higher-fidelity Qwen Image 3 endpoint on Replicate. At the initial September 2026 integration it costs $0.04 per output image versus $0.03 for the regular model, and is the default for Vesper's Character Studio portrait/variant tasks and scene images.

## Initial Vesper integration

- Generates with no reference and edits with one optional `image` reference.
- Reference arity is **single** and the initial Vesper transport is **`data_url`**. This deliberately avoids the short-lived Replicate-file URL path that produced an immediate provider-side file-format refusal during the Qwen Image 2 trial.
- Supported aspect ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`.
- Normalized controls in the first adapter: prompt, aspect ratio, seed, and negative prompt.
- `enable_prompt_expansion` and `match_input_image` remain raw provider inputs in the Admin Image Generator. Production profiles pin both false so the compiled Vesper prompt and requested aspect stay authoritative.
- The model has its own `qwenImage3Pro` adapter. It is intentionally separate from the regular Image 3 adapter even though their first capability sets match, so later Pro-specific prompt or execution tuning does not leak across models.
- Production prompt bindings are model-specific rows, but temporarily delegate wording to Vesper's existing natural-language prose compiler until Qwen-3-Pro-specific trials justify a dedicated dialect.

## Defaults

Migration `0134_qwen-image-3-defaults.sql` makes this model the enabled default for:

- `portrait` — Character Studio canonical portrait generation;
- `variant` — Character Studio portrait variants; and
- `scene` — scene-image generation.

Item, location, chat-place, and chat-look defaults are intentionally unchanged. The explicit intimate/NSFW LoRA route remains paired to Qwen Image Edit 2511 because that LoRA is model-specific.

## Reviewed capability

`edit_kind` and `identity_preservation` remain `unknown` for the first production trial. Those columns should be promoted only from observed Vesper output, not from the provider's schema or marketing copy.
