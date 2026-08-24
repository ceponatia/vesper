# `@vesper/image-models`

`@vesper/image-models` is Vesper's model-family behavior package: the place where image models are allowed to differ without leaking model-slug checks into the provider-neutral render kernel.

It owns four things:

1. a semantic **feature vocabulary** for what a model family can express;
2. the `defineImageModel` **composer** that turns features and quirks into an adapter;
3. per-family **adapters** for prompt dialects, request validation, and execution hints; and
4. the **adapter registry** that resolves a registered model slug to the behavior Vesper knows about.

The package does **not** replace the probed image-model registry. The database/probe remains authoritative for provider wire truth: input field bindings, reference arity and capacity, supported aspects, output controls, active provider version, and other schema-derived facts. `@vesper/image-models` owns behavior; the probed model record owns fields.

Source: [`packages/image-models`](../../packages/image-models/README.md).

## Documentation map

- **[Features](features/README.md)** — every semantic feature currently exported by the package, grouped the same way as `src/features/`.
- **[Provider model reference](models/README.md)** — the per-model Replicate/API documentation. These pages describe provider endpoints and reviewed model facts; they are not the package's adapter registry.
- **[Image system overview](../images/README.md)** — how the application resolves profiles, models, providers, and render plans around this package.
- **[Provider probing and registry](../images/providers.md)** — the source of truth for provider fields and active model versions.

## Current package state

The package is private (`@vesper/image-models`, version `0.0.0`) and publishes only its root entrypoint plus `package.json`. Callers import from `@vesper/image-models`, not from `src/*` subpaths.

Only the **Qwen Image family** is implemented in the adapter registry. Flux, Wan, SDXL, Seedream, and other registered models remain on the generic path until Vesper has family-specific behavior to encode. For those models, `adapterForImageModel(slug)` returns `null`; that is the normal fallback, not an error.

The registry keys adapters by the model's **base slug**, so a reproducibility pin such as `owner/name:version` still receives the behavior registered for `owner/name`.

### Registered Qwen adapters

| Model | Role | Composed features | Family behavior |
| --- | --- | --- | --- |
| [`qwen/qwen-image-edit-2511`](models/qwen-image-edit-2511.md) | Instruction editor; default for scene images and portrait variants | `prompt`, `multiReference`, `aspectRatio`, `seed`, `outputFormat`, `outputQuality`, `safetyToggle` | Qwen numbered-reference prompt dialect |
| [`qwen/qwen-image-edit-plus-lora`](models/qwen-image-edit-plus-lora.md) | 2509-generation instruction editor with loadable LoRA support | all 2511 edit features plus `lora` | numbered-reference dialect; eight-minute startup hint; one startup retry |
| [`qwen/qwen-image-2512`](models/qwen-image-2512.md) | Text-to-image generator arm; default for a brand-new portrait | `prompt`, `aspectRatio`, `seed`, `guidance`, `outputFormat`, `outputQuality`, `safetyToggle` | no edit dialect; no execution hint |

Two absences are deliberate:

- **Qwen Image Edit 2511 does not compose `lora` in the current package.** Its active Vesper model record does not expose the normalized LoRA bindings the feature requires, so the adapter cannot honestly claim it. The [2511 provider reference](models/qwen-image-edit-2511.md) owns provider-version capability details.
- **Qwen Image 2512 does not compose `negativePrompt`.** The endpoint declares a negative-prompt field, but Vesper's measured behavior shows that it does not steer output. The package therefore does not advertise the field as a behavioral capability merely because the schema contains it.

## Features

A feature answers a semantic question such as "can this render carry several references?" or "can the caller select guidance strength?" It does not answer "which provider field carries that value?" The latter belongs to the probed model record.

The package exports ten feature constructors:

| Feature id | Meaning | Documentation |
| --- | --- | --- |
| `prompt` | authored text prompt | [Prompt](features/prompt.md) |
| `multiReference` | several role-bearing reference images | [References](features/references.md) |
| `aspectRatio` | caller-selected output shape | [Aspect ratio](features/aspect-ratio.md) |
| `seed` | reproducible seeded generation | [Controls](features/controls.md) |
| `guidance` | prompt-guidance strength | [Controls](features/controls.md) |
| `negativePrompt` | a negative prompt that actually affects output | [Controls](features/controls.md) |
| `lora` | one external LoRA with a chosen strength | [LoRA](features/lora.md) |
| `outputFormat` | caller-selected output encoding | [Output](features/output.md) |
| `outputQuality` | caller-selected encoding quality | [Output](features/output.md) |
| `safetyToggle` | caller can disable the endpoint's own safety checker | [Safety](features/safety.md) |

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

When another model family genuinely needs behavior that the generic path cannot express:

1. reuse the existing semantic features where they describe the family honestly;
2. add a new feature only when the current vocabulary cannot state a real capability;
3. keep provider field names in the probe/model record rather than the feature;
4. add family quirks only for behavior such as prompt dialects, validations, or measured execution differences;
5. compose endpoint adapters with `defineImageModel`;
6. register base slugs in `src/registry.ts`; and
7. update this documentation and the relevant page under [models/](models/README.md).

A model does not need an adapter merely because it exists. The generic path is the correct path until Vesper has a concrete family-specific behavior to encode.
