# Providers

**One backend — Replicate — and the model list is DATA, not code.** Which models the app can
run are rows in `image_models`, managed from the admin-only `/settings/image-models` page.
There is no Venice provider — no `VENICE_*` env, no `server/ai/venice.ts`, no `venice_*`
provider ids (owner ruling 2026-08-05: Replicate is cheaper and more accurate). Every image
lane is Replicate; OpenRouter stays for text only.

## Owns / does not own

- **Owns:** the model row and its probe, task profiles and how a render resolves one, the
  curated LoRA library, the render intent and its reference planning, shape negotiation, the
  Replicate transport, and send strictness.
- **Does not own:** what each model measured at a pinned version — that is
  [../../image-models/models/README.md](../../image-models/models/README.md) — nor what any
  lane puts in its prompt, which is [../pipelines/README.md](../pipelines/README.md).

## Reading order

| Doc                                    | What it covers                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| [registry.md](registry.md)             | The model row, what is probed, what is reviewed, and how a version is promoted |
| [profiles.md](profiles.md)             | Task profiles, the seeded set, the resolution degrade, and eligibility         |
| [loras.md](loras.md)                   | The curated LoRA library and identity-LoRA training bindings                   |
| [render-intents.md](render-intents.md) | Describing a render as an intent: reference planning, control routing, seeds   |
| [shape.md](shape.md)                   | Per-render aspect negotiation, resolution tiers, and cropping                  |
| [transport.md](transport.md)           | The Replicate transport, execution budgets, send strictness, failure classes   |
