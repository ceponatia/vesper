# Qwen Image 3

**Slug:** `alibaba/qwen-image-3`  
**Pinned Replicate version:** `8235a8d30fc32fd33a4e0e91d9cffaae6f2250fc56ff8e5736ca4a9c5b9f9fbc`.

Qwen Image 3 is Alibaba's unified generation/edit endpoint on Replicate. Vesper ships it as the lower-cost sibling of Qwen Image 3 Pro and offers it for portrait, variant, and scene work, but it is not the default.

## Initial Vesper integration

- Generates with no reference and edits with one optional `image` reference.
- Reference arity is **single** and the initial Vesper transport is **`data_url`**. This deliberately avoids the short-lived Replicate-file URL path that produced an immediate provider-side file-format refusal during the Qwen Image 2 trial.
- Supported aspect ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`.
- Normalized controls in the first adapter: prompt, aspect ratio, seed, and negative prompt.
- `enable_prompt_expansion` and `match_input_image` remain raw provider inputs in the Admin Image Generator. Production profiles pin both false so the compiled Vesper prompt and requested aspect stay authoritative.
- The model has its own `qwenImage3` adapter. It is intentionally thin for the initial trial and does not alias the Pro adapter.
- Production prompt bindings are model-specific rows, but temporarily delegate wording to Vesper's existing natural-language prose compiler until Qwen-3-specific trials justify a dedicated dialect.

## Reviewed capability

`edit_kind` and `identity_preservation` remain `unknown` for the first production trial. Those columns are judgments from observed output, not schema facts. The user's initial Replicate Playground test was materially better than the older Qwen Image 2511/2512 models, but Vesper should grade its own character/reference cases before recording a durable rating.
