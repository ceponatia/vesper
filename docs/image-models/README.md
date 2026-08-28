# `@vesper/image-models`

`@vesper/image-models` is Vesper's model-family behavior package: the place where image models are allowed to differ without leaking model-slug checks into the provider-neutral render kernel.

It owns four things:

1. a semantic **feature vocabulary** for what a model family can express;
2. the `defineImageModel` **composer** that turns features and quirks into an adapter;
3. per-family **adapters** for prompt dialects, request validation, and execution hints; and
4. the **adapter registry** that resolves a registered model slug to the behavior Vesper knows about.

The package does **not** replace the probed image-model registry. The database/probe remains authoritative for provider wire truth: input field bindings, reference arity and capacity, supported aspects, output controls, active provider version, and other schema-derived facts. `@vesper/image-models` owns behavior; the probed model record owns fields.

Source: [`packages/image-models`](../../packages/image-models/README.md).

## Reading order

| Doc                                                     | What it covers                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Features](features/README.md)                          | Semantic feature contract, current feature modules, binding rules, and Qwen capability matrix     |
| [Provider model reference](models/README.md)            | Per-model Replicate/API snapshots, provider drift, reviewed capability, inputs, and payload notes |
| [Image system overview](../images/README.md)            | Profiles, providers, asset registry, pipelines, identity packs, and the surrounding image system  |
| [Provider probing and registry](../images/providers/README.md) | Provider fields, active versions, probing, profile resolution, and registry truth                 |

## Current package state

The package is private (`@vesper/image-models`, version `0.0.0`) and publishes only its root entrypoint plus `package.json`. Callers import from `@vesper/image-models`, not from `src/*` subpaths.

Only the **Qwen Image family** is implemented in the adapter registry. Models without an adapter, including Flux, Wan, SDXL, and Seedream families, use the generic path. For those models, `adapterForImageModel(slug)` returns `null`; that is the normal fallback, not an error.

The registry keys adapters by the model's **base slug**, so a reproducibility pin such as `owner/name:version` still receives the behavior registered for `owner/name`.

### Registered Qwen adapters

| Model                                                                   | Role                                                                    | Composed features                                                                                                      | Family behavior                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`qwen/qwen-image-edit-2511`](models/qwen-image-edit-2511.md)           | Instruction editor; default for scene images and portrait variants      | `prompt`, `multiReference`, `aspectRatio`, `seed`, `fastMode`, `lora`, `outputFormat`, `outputQuality`, `safetyToggle` | Qwen numbered-reference prompt dialect                                   |
| [`qwen/qwen-image-edit-plus-lora`](models/qwen-image-edit-plus-lora.md) | 2509-generation instruction editor; separate legacy comparison endpoint | same edit feature set as 2511                                                                                          | numbered-reference dialect; eight-minute startup hint; one startup retry |
| [`qwen/qwen-image-2512`](models/qwen-image-2512.md)                     | Text-to-image generator arm; default for a brand-new portrait           | `prompt`, `aspectRatio`, `seed`, `guidance`, `fastMode`, `outputFormat`, `outputQuality`, `safetyToggle`               | no edit dialect; no execution hint                                       |

One absence is deliberate:

- **Qwen Image 2512 does not compose `negativePrompt`.** The endpoint declares a negative-prompt field, but Vesper's measured behavior shows that it does not steer output. The package therefore does not advertise the field as a behavioral capability merely because the schema contains it.

Both edit adapters compose `lora`. Composing it states that the endpoint family can load a custom LoRA; the probed model record remains authoritative for whether the version Vesper actually runs exposes the provider bindings. The [2511 provider reference](models/qwen-image-edit-2511.md) owns provider-version capability details.

## Features

A feature answers a semantic question such as "can this render carry several references?" or "can the caller select guidance strength?" It does not answer "which provider field carries that value?" The latter belongs to the probed model record.

The package exports eleven feature constructors:

| Feature id       | Meaning                                              | Documentation                                      |
| ---------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `prompt`         | authored text prompt                                 | [Prompt](features/README.md#prompt)                |
| `multiReference` | several role-bearing reference images                | [References](features/README.md#references)        |
| `aspectRatio`    | caller-selected output shape                         | [Aspect ratio](features/README.md#aspect-ratio)    |
| `seed`           | reproducible seeded generation                       | [Controls](features/README.md#generation-controls) |
| `guidance`       | prompt-guidance strength                             | [Controls](features/README.md#generation-controls) |
| `fastMode`       | accelerated sampling the caller may choose or refuse | [Controls](features/README.md#generation-controls) |
| `negativePrompt` | a negative prompt that actually affects output       | [Controls](features/README.md#generation-controls) |
| `lora`           | one external LoRA with a chosen strength             | [LoRA](features/README.md#lora)                    |
| `outputFormat`   | caller-selected output encoding                      | [Output](features/README.md#output)                |
| `outputQuality`  | caller-selected encoding quality                     | [Output](features/README.md#output)                |
| `safetyToggle`   | caller can disable the endpoint's own safety checker | [Safety](features/README.md#safety-toggle)         |

See [features/README.md](features/README.md) for the `ImageFeature` contract, binding rules, and request validation behavior.

## Composer and adapter contract

`defineImageModel({ family, features, quirks })` produces an `ImageModelAdapter` with:

- `family` — the checkpoint/model family name;
- `capabilities` — feature ids in declaration order;
- optional `preparePrompt`;
- optional `validateRequest`; and
- optional `executionHints`.

Features may contribute request validation. Those validations accumulate in declaration order so a caller can see every incompatibility at once.

Quirks own behavioral hooks. A prompt preparer, quirk validator, or execution-hint hook may be claimed by only one quirk in a definition; conflicting claims throw when the definition is evaluated instead of silently overriding one another. Duplicate feature ids likewise throw.

### Prompt preparation must be idempotent

An `ImagePromptPreparer` must satisfy `prepare(prepare(prompt)) === prepare(prompt)`. Planning hashes the prepared prompt, while the send path prepares again. A non-idempotent dialect could make a render disagree with its own compiled fingerprint.

The Qwen edit dialect rewrites Vesper's generic identity-lock sentence into Qwen's numbered-reference wording only when one or more references are present. One reference gets the single-reference lock; multiple references get the multi-reference lock. Prompts without the legacy identity sentence are left unchanged.

## Request validation

`ImageModelRequestFacts` is intentionally small:

- `referenceCount`
- `usesLora`

The validating features are:

- `multiReference`, which refuses a request whose intended reference count exceeds the probed model capacity rather than silently dropping references;
- `lora`, which refuses a LoRA request unless both LoRA weights and LoRA scale are bound on the active probed model version.

The application runs adapter request validation in the **Image Generator bench pre-spend path**, where the request facts are final. Production lanes do not run this validator because their `allow_trim` reference policy can legally reduce the pre-plan reference count; validating the untrimmed count would reject renders the planner can make valid.

## Execution hints

Adapters may state provider-neutral timing knowledge:

- `startupBudgetMs`
- `renderBudgetMs`
- `maxStartupRetries`

An absent hint means the caller's lane default governs. Hints are claims about observed endpoint behavior, not default values that every adapter must fill.

Only `qwen/qwen-image-edit-plus-lora` supplies hints: an eight-minute startup budget and one startup retry. Its render budget is intentionally unset because the adapter has no model-specific render-time measurement that justifies overriding the bench default.

The web application's Image Generator and Image Lab combine adapter hints with their bench budgets. Production keeps its own execution policy rather than inheriting bench timing.

## Package boundary

`@vesper/image-models` may depend on lower-ranked provider-neutral packages such as `@vesper/image-core` and `@vesper/contracts`. It must not import the web application, Next.js, database code, environment state, character/chat contracts, or its peer provider packages `@vesper/image-replicate` and `@vesper/image-sd`.

```text
                    @vesper/contracts
                           ▲
                   @vesper/image-core
              ▲            ▲            ▲
 @vesper/image-models  @vesper/image-sd  @vesper/image-replicate
              ▲            ▲            ▲
              └────────────┼────────────┘
                     @vesper/web
```

The package is universal runtime code: pure data and pure functions, with no persistence, network access, clock, randomness, Node globals, or browser globals.

## Where the application joins it to rendering

`apps/web/src/server/images/model-adapters.ts` is the application-owned join between this package and the render system. It supplies four integration helpers:

- model-specific prompt preparation to planning and send paths;
- adapter request refusals for the Generator bench;
- render runtime facts including the selected prompt dialect; and
- bench execution policy with model-specific hint overrides.

Keeping the join in one application module prevents planning and sending from resolving different dialects for the same model.

## Adding another family

To add family-specific behavior:

1. reuse the existing semantic features where they describe the family honestly;
2. add a new feature only when the current vocabulary cannot state a real capability;
3. keep provider field names in the probe/model record rather than the feature;
4. use family quirks only for behavior such as prompt dialects, validations, or measured execution differences;
5. compose endpoint adapters with `defineImageModel`;
6. register base slugs in `src/registry.ts`; and
7. update this documentation and the relevant page under [models/](models/README.md).

A model does not need an adapter merely because it exists. The generic path is correct whenever Vesper has no family-specific behavior to encode.
