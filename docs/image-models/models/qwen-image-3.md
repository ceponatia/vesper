# Qwen Image 3

Vesper runs Qwen Image 3 through **fal.ai**, not Replicate. fal publishes generation and editing as separate endpoints, so the registry contains two separate rows and the adapter layer keeps them separate as well:

- `alibaba/qwen-image-3/text-to-image` — prompt-only generation;
- `alibaba/qwen-image-3/edit` — instruction editing with **1–3 ordered reference images**.

Qwen Image 2 remains on Replicate.

## Provider/version identity

fal's managed Qwen Image 3 endpoints do not expose an immutable weights/version hash comparable to a Replicate version id. Vesper records the reviewed endpoint-schema snapshots as its provider-version markers so controlled runs can still be pinned to the contract they were planned against:

- text: `fal-qwen3-text-schema-2026-09-11`
- edit: `fal-qwen3-edit-schema-2026-09-11`

These are **Vesper schema-revision markers, not model-weight hashes**. The model rows carry an operator warning stating that limitation.

## Safety and prompt handling

Both routes are sent with:

- `enable_safety_checker: false`
- `enable_prompt_expansion: false`
- `num_images: 1`
- `output_format: "png"`

fal documents that disabling its safety checker requires account authorization; if an account is not authorized, fal may continue checking the request even though Vesper sends `false`.

The transport also sends `X-Fal-Store-IO: 0`, because Vesper immediately downloads and owns the resulting image rather than using fal request history as storage.

## Resolution

Vesper exposes a normalized **1K / 2K** selector for both Qwen Image 3 endpoints. The selected tier and requested aspect are combined at the fal transport boundary into fal's custom `image_size: { width, height }` input.

Examples:

| Aspect | 1K | 2K |
| --- | --- | --- |
| `1:1` | 1024×1024 | 2048×2048 |
| `3:4` | 768×1024 | 1536×2048 |
| `16:9` | 1024×576 | 2048×1152 |
| `9:16` | 576×1024 | 1152×2048 |

Migration `0135_fal-qwen-image-3.sql` defaults the production portrait, variant/reference-view, and scene profiles to **1K while the fal integration is being evaluated**. The Admin Image Generator also initializes the selector to 1K for a model whose reviewed capability is exactly the 1K/2K pair; an admin can switch it to 2K for a controlled run.

## Surface routing

- **Character Studio portrait generation** → `alibaba/qwen-image-3/text-to-image`
- **Character Studio variants/reference views** → `alibaba/qwen-image-3/edit`
- **Scene images** → `alibaba/qwen-image-3/edit`
- **Admin Image Generator** → both rows are selectable independently

The edit row accepts up to three primary references and preserves their order when sending `image_urls` to fal.

## Adapter status

There are two explicit thin adapters:

- `qwenImage3TextToImage`
- `qwenImage3Edit`

They currently share only the reviewed provider-neutral prompt/seed/negative-prompt semantics. They are intentionally distinct so edit-specific identity, prompt-dialect, execution, or reference findings can diverge after testing without slug checks leaking into generic render code.

Production prompt bindings are also endpoint-specific, but both temporarily delegate wording to Vesper's existing natural-language prose compiler until Qwen-3-on-fal trials justify dedicated dialects.
