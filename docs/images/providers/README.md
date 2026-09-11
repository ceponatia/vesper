# Providers

The selectable image-model catalog is **DATA in `image_models`**, while the row's endpoint identity determines which provider transport executes it.

- **Replicate** remains the default backend for the existing catalog, including Qwen Image 2, Qwen 2511/2512, Seedream, Wan, SDXL and the LoRA/preprocessor paths.
- **fal.ai** currently owns the two Qwen Image 3 rows: `alibaba/qwen-image-3/text-to-image` and `alibaba/qwen-image-3/edit`.
- Venice remains removed — no `VENICE_*` env, `server/ai/venice.ts`, or `venice_*` provider ids.

The model list is managed from the admin-only `/settings/image-models` page. Provider routing is below the render-intent seam, so Character Studio, scene rendering and the Admin Image Generator resolve profiles/models the same way regardless of which transport ultimately runs them.

## Owns / does not own

- **Owns:** the model row and its provider contract, task profiles and how a render resolves one, the curated LoRA library, render intent/reference planning, shape negotiation, provider dispatch, transport behavior, and send strictness.
- **Does not own:** what each model measured at a reviewed provider contract — that is [../../image-models/models/README.md](../../image-models/models/README.md) — nor what any lane puts in its prompt, which is [../pipelines/README.md](../pipelines/README.md).

## Runtime credentials

- `REPLICATE_API_TOKEN` configures Replicate-backed image rows.
- `FAL_API_KEY` configures fal-backed Qwen Image 3 rows.

A deployment may have both, which is the normal production configuration after the Qwen Image 3 migration.

## Reading order

| Doc                                    | What it covers                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| [registry.md](registry.md)             | The model row, what is probed/reviewed, and provider/version provenance        |
| [profiles.md](profiles.md)             | Task profiles, the seeded set, the resolution degrade, and eligibility         |
| [loras.md](loras.md)                   | The curated LoRA library and identity-LoRA training bindings                   |
| [render-intents.md](render-intents.md) | Describing a render as an intent: reference planning, control routing, seeds   |
| [shape.md](shape.md)                   | Per-render aspect negotiation, resolution tiers, and cropping                  |
| [transport.md](transport.md)           | Replicate transport details and the provider-neutral render boundary           |
