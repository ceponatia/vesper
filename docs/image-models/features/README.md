# Image model features

Features are the semantic vocabulary used by `@vesper/image-models` adapters. They describe **what a model family can express**, while the probed image-model record remains authoritative for **which provider input fields carry it**.

Source: [`packages/image-models/src/features`](../../../packages/image-models/src/features).

## Feature contract

Every feature is an `ImageFeature` with:

- `id` — a stable, provider-neutral capability id;
- `semantic` — one sentence describing what the capability means in Vesper terms;
- optional `isBound(model)` — whether the active probed model record exposes what the feature needs; and
- optional `validate(model, request)` — pre-spend refusals for a model/request pairing.

A feature must not name provider fields such as `cfg`, `guidance`, `image_input`, or `lora_weights`. It asks the normalized/probed `ImageModel` record instead. This prevents the feature layer from becoming a second, stale copy of provider schema discovery.

`ImageModelRequestFacts` contains only `referenceCount` and `usesLora`. It grows only when a semantic feature cannot judge a request without another normalized fact.

## Feature modules

The documentation mirrors the package's `src/features/` modules:

- [Prompt](prompt.md) — `prompt`
- [References](references.md) — `multiReference`
- [Aspect ratio](aspect-ratio.md) — `aspectRatio`
- [Controls](controls.md) — `seed`, `guidance`, `negativePrompt`
- [LoRA](lora.md) — `lora`
- [Output](output.md) — `outputFormat`, `outputQuality`
- [Safety](safety.md) — `safetyToggle`

Together these are the ten feature constructors exported from the package root.

## Binding is different from composition

An adapter's `capabilities` list says which semantic features the family/endpoint **claims**. `isBound(model)`, where present, asks whether the active probed row exposes the required normalized binding.

That distinction matters when provider versions drift. For example, the LoRA-capable Qwen wrapper composes `lora`, but a particular row can still fail `isBound` if its active probe does not expose both LoRA weights and LoRA scale.

Some features intentionally have no `isBound` hook because the normalized model record cannot answer the question honestly without matching raw provider field names. That is not treated as "always bound"; it means binding truth stays elsewhere. The no-`isBound` features are `prompt`, `outputQuality`, and `safetyToggle`.

## Validation behavior

Feature validators accumulate when `defineImageModel` composes an adapter. A request can therefore receive more than one refusal reason instead of stopping at the first failed feature.

Only two feature modules validate requests:

- `multiReference` rejects an intended reference count above `referenceCapacity(model).max`;
- `lora` rejects a LoRA-bearing request when the active model record lacks either the LoRA weights or LoRA scale binding.

These are model/request compatibility checks. They do not replace `@vesper/image-core`'s final-wire invariants, which verify the payload that is actually going to the provider.

## Qwen composition

| Feature          | Edit 2511 | Edit Plus LoRA | Image 2512 |
| ---------------- | :-------: | :------------: | :--------: |
| `prompt`         | yes       | yes            | yes        |
| `multiReference` | yes       | yes            | no         |
| `aspectRatio`    | yes       | yes            | yes        |
| `seed`           | yes       | yes            | yes        |
| `guidance`       | no        | no             | yes        |
| `negativePrompt` | no        | no             | no         |
| `lora`           | yes       | yes            | no         |
| `outputFormat`   | yes       | yes            | yes        |
| `outputQuality`  | yes       | yes            | yes        |
| `safetyToggle`   | yes       | yes            | yes        |

An exported feature is vocabulary, not proof that a Qwen adapter composes it. `negativePrompt` is the clearest example: the package can represent families that genuinely act on negative conditioning, while Qwen Image 2512 omits the feature because its declared negative field does not steer output.

[Back to `@vesper/image-models`](../README.md).
