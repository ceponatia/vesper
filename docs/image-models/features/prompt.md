# Prompt feature

Source: [`packages/image-models/src/features/prompt.ts`](../../../packages/image-models/src/features/prompt.ts).

`promptFeature()` contributes capability id `prompt`.

## Semantic

The model accepts an authored text prompt describing or instructing the image.

The feature is explicit even though nearly every current image model takes text, because an adapter's capability list is intended to describe the endpoint completely. A pure upscaler or other image-only endpoint can legitimately omit the prompt capability rather than inheriting one implicitly.

## Binding

`prompt` intentionally has **no `isBound` hook**.

The probed prompt binding records where a prompt goes and, when known, how long it may be. Older/unprobed rows can lack that derived binding even though the provider still accepts a prompt. Treating the missing measurement as proof that the model has no prompt would create false refusals.

Prompt-length fitting remains `@vesper/image-core`'s responsibility.

## Current Qwen composition

All three registered Qwen adapters compose `prompt`:

- `qwen/qwen-image-edit-2511`
- `qwen/qwen-image-edit-plus-lora`
- `qwen/qwen-image-2512`

The two edit adapters additionally apply the Qwen numbered-reference prompt dialect through a quirk; the prompt feature itself is provider-neutral and performs no rewriting.

[Back to features](README.md).
