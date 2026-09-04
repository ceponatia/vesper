# Image model features

Features are the semantic vocabulary used by `@vesper/image-models` adapters. They describe
**what a model family can express**, while the probed image-model record remains
authoritative for **which provider input fields carry it**.

Source: [`packages/image-models/src/features`](../../../packages/image-models/src/features).
The eleven feature constructors exported from the package root are documented below, one
`##` section per `src/features/` module.

## Owns / does not own

- **Owns:** the feature vocabulary, each feature's semantic claim, its `isBound` rule, its
  pre-spend validation, and the Qwen composition matrix.
- **Does not own:** which provider field carries a capability, or what a specific pinned
  version measured — that is the probed record and
  [the model pages](../models/README.md). Nor the final-wire invariants, which are
  `@vesper/image-core`'s.

## Feature contract

Every feature is an `ImageFeature` with:

- `id` — a stable, provider-neutral capability id;
- `semantic` — one sentence describing what the capability means in Vesper terms;
- optional `isBound(model)` — whether the active probed model record exposes what the
  feature needs; and
- optional `validate(model, request)` — pre-spend refusals for a model/request pairing.

A feature must not name provider fields such as `cfg`, `guidance`, `image_input`, or
`lora_weights`. It asks the normalized/probed `ImageModel` record instead. This prevents the
feature layer from becoming a second, stale copy of provider schema discovery.

`ImageModelRequestFacts` contains only `referenceCount` and `usesLora`. It grows only when a
semantic feature cannot judge a request without another normalized fact.

## Binding is different from composition

An adapter's `capabilities` list says which semantic features the family/endpoint
**claims**. `isBound(model)`, where present, asks whether the active probed row exposes the
required normalized binding.

That distinction matters when provider versions drift. Both Qwen edit adapters
compose `lora`, but a particular row can still fail `isBound` if its active probe does not
expose both LoRA weights and LoRA scale.

Some features intentionally have no `isBound` hook because the normalized model record
cannot answer the question honestly without matching raw provider field names. That is not
treated as "always bound"; it means binding truth stays elsewhere. The no-`isBound` features
are `prompt`, `outputQuality`, and `safetyToggle`.

## Validation behavior

Feature validators accumulate when `defineImageModel` composes an adapter. A request can
therefore receive more than one refusal reason instead of stopping at the first failed
feature.

Only two feature modules validate requests: `multiReference` rejects an intended reference
count above `referenceCapacity(model).max`, and `lora` rejects a LoRA-bearing request when
the active model record lacks either the LoRA weights or LoRA scale binding.

These are model/request compatibility checks. They do not replace `@vesper/image-core`'s
final-wire invariants, which verify the payload that is actually going to the provider.

## Prompt

`promptFeature()` (`src/features/prompt.ts`) contributes capability id `prompt`.

**Semantic:** the model accepts an authored text prompt describing or instructing the image.
The feature is explicit even though nearly every current image model takes text, because an
adapter's capability list is intended to describe the endpoint completely. A pure upscaler
or other image-only endpoint can legitimately omit the prompt capability rather than
inheriting one implicitly.

**Binding:** none. The probed prompt binding records where a prompt goes and, when known,
how long it may be. Older or unprobed rows can lack that derived binding even though the
provider still accepts a prompt, and treating the missing measurement as proof that the
model has no prompt would create false refusals. Prompt-length fitting remains
`@vesper/image-core`'s responsibility.

The prompt feature is provider-neutral and performs no rewriting, and no adapter in this
package prepares prompt text: the Qwen family's numbered-reference wording is a prompt-program
dialect in `@vesper/image-core`.

## References

`multiReferenceFeature()` (`src/features/references.ts`) contributes capability id
`multiReference`.

**Semantic:** the model can accept several reference images in one render, so references may
carry distinct roles such as character identity and scene/location guidance. The feature
does not identify the provider field that carries references. Capacity is read through
`@vesper/image-core`'s normalized `referenceCapacity(model)` helper, which reconciles the
model row's edit ability, arity, and stored reference cap.

**Binding:** true when the normalized reference capacity is greater than one. A model that
accepts exactly one reference may still support image-to-image or editing, but it does not
satisfy this feature's semantic claim of **multiple** role-bearing references.

**Validation:** the feature validates `ImageModelRequestFacts.referenceCount` against the
model's normalized maximum. If the render asks for more references than the model can carry,
validation returns a pre-spend refusal. The feature deliberately does not trim the list
itself: silently dropping a reference can remove a character identity or other required role
without leaving an obvious trace in the output. A capacity of zero receives a specific
refusal saying the model accepts no references; other over-capacity requests report the
maximum and requested count.

`qwen/qwen-image-2512` does **not** compose this feature. Its optional image input is a
single strength-based image-to-image reference, not the numbered multi-reference
instruction-edit mechanism used by the editors.

## Aspect ratio

`aspectRatioFeature()` (`src/features/aspect-ratio.ts`) contributes capability id
`aspectRatio`.

**Semantic:** the caller can request the output shape instead of always accepting the
model's own default dimensions. The feature is intentionally semantic rather than
mechanical: one provider may accept an aspect-ratio enum while another accepts width/height
dimensions, and the normalized image layer decides how the requested shape maps to wire
inputs.

**Binding:** true when `model.supportedAspects` contains at least one normalized aspect. A
model with no parseable supported aspect list is treated as unable to honor a requested
shape through this feature. The broader render system may still degrade to that model's
default and crop the downloaded result as appropriate; the feature does not invent a binding
that the probe did not establish.

## Generation controls

`src/features/controls.ts` defines four normalized single-binding controls. Each binding
check reads `model.advancedCapabilities.controls`, which is populated by provider probing,
so the feature layer never needs to know whether a provider spells guidance `guidance`,
`guidance_scale`, `cfg`, or something else.

- **`seed`** — `seedFeature()`. The model accepts a seed so the same request can be
  reproduced. Bound when the active record has a normalized `seed` control binding.
- **`guidance`** — `guidanceFeature()`. The model accepts a guidance strength controlling how
  closely generation follows the prompt. Bound when the active record has a normalized
  `guidance` control binding. The probe resolves `guidance`, `guidance_scale`, and `cfg` to
  this one control, in that order. It deliberately does **not** resolve `true_cfg_scale`: on
  a CFG-distilled checkpoint that is a different quantity from the embedded guidance, so
  binding both to one name would leave a run record unable to say which value moved.
- **`fastMode`** — `fastModeFeature()`. The endpoint offers an accelerated sampling path, and
  the caller may choose it or refuse it. Bound when the active record has a normalized
  `fastMode` control binding. This is a quality choice wearing a speed name: the wrappers
  that expose it turn it on by default, so composing the feature says a family's renders can
  be asked to slow **down**, not merely to hurry. Both answers are real requests; absence of
  the control is the only way to say nothing. Composition is a statement about what the
  endpoint can express, never about what Vesper should ask for — the reviewed per-model
  quality rulings live in `@vesper/image-core` and are stated on
  [the model pages](../models/README.md).
- **`negativePrompt`** — `negativePromptFeature()`. The model accepts a negative prompt **and
  actually acts on it**, so exclusions genuinely steer output. Bound when the active record
  has a normalized `negativePrompt` binding. Composition is intentionally stricter than
  schema presence: a family composes this feature only when negative conditioning changes
  model behavior, not merely because the provider exposes a field with that name. No
  registered Qwen adapter composes it — for `qwen/qwen-image-2512` because paired testing
  measured no steering effect
  ([its model page](../models/qwen-image-2512.md) owns that measurement), and for the edit
  endpoints because they expose no negative prompting at all.

## LoRA

`loraFeature()` (`src/features/lora.ts`) contributes capability id `lora`.

**Semantic:** the model can load one external LoRA for a render and apply it at a chosen
strength. The feature treats the weights locator and strength as a pair; a version exposing
only one is not considered capable of carrying a curated LoRA binding correctly. Each edit
adapter represents **one LoRA per prediction** — both endpoints expose a single
weights/scale pair, not a repeated or multi-LoRA input.

**Binding:** true only when both normalized controls exist on the active probed model
record: `advancedCapabilities.controls.loraWeights` and
`advancedCapabilities.controls.loraScale`. Family composition and active-version capability
are separate facts — an adapter may claim LoRA support while a stale or drifted probed row
still fails the binding check.

**Validation:** when `ImageModelRequestFacts.usesLora` is false the feature has nothing to
refuse. When `usesLora` is true and either normalized binding is missing, validation returns
a pre-spend refusal explaining that the active version cannot carry the LoRA and should be
re-probed or replaced with a model that exposes both fields. This is the cheap model/request
compatibility check; it does not replace `@vesper/image-core`'s final-wire LoRA invariant,
which verifies that the resolved LoRA locator and scale actually reach the payload
unchanged.

## Output

`src/features/output.ts` defines two features.

- **`outputFormat`** — `outputFormatFeature()`. The caller can request an output encoding
  instead of always accepting the endpoint's default. Bound when `model.outputFormat` is not
  `null`: the normalized model row already records whether an output-format input exists, so
  the feature can answer without inspecting provider field names.
- **`outputQuality`** — `outputQualityFeature()`. The caller can select an output-quality
  setting that trades file size against encoded-image fidelity. **No `isBound` hook**: there
  is no normalized output-quality control slot, the setting rides model-specific pinned
  extras, and the only lower-level evidence lives in raw provider input descriptors, which a
  semantic feature may not inspect by field name because that would duplicate the probe's
  job. Composing `outputQuality` therefore records a family convention, and the
  application/provider mapping remains responsible for whether and how that convention
  reaches the active endpoint.

## Safety toggle

`safetyToggleFeature()` (`src/features/safety.ts`) contributes capability id `safetyToggle`.

**Semantic:** the endpoint exposes a caller-controlled way to disable its own
content/safety checker for a render. This is a model-family capability, not a statement that
Vesper always disables moderation — whether the application requests the toggle is policy
owned at the application/render seam. It also does not imply that **all** moderation is
controllable: vendor-side moderation can exist outside the model wrapper and remain
impossible for Vesper to disable even when other endpoints expose a local checker flag.

**Binding:** none. There is no normalized safety-toggle control slot in the `ImageModel`
record; the field may live in pinned extras, and the feature layer is not allowed to
discover it by matching raw provider field names. Operator-facing warnings on the model
record remain the place to state moderation behavior that cannot be controlled.

## Qwen composition

| Feature          | Edit 2511 | Edit Plus LoRA | Image 2512 |
| ---------------- | :-------: | :------------: | :--------: |
| `prompt`         |    yes    |      yes       |    yes     |
| `multiReference` |    yes    |      yes       |     no     |
| `aspectRatio`    |    yes    |      yes       |    yes     |
| `seed`           |    yes    |      yes       |    yes     |
| `guidance`       |    no     |       no       |    yes     |
| `fastMode`       |    yes    |      yes       |    yes     |
| `negativePrompt` |    no     |       no       |     no     |
| `lora`           |    yes    |      yes       |     no     |
| `outputFormat`   |    yes    |      yes       |    yes     |
| `outputQuality`  |    yes    |      yes       |    yes     |
| `safetyToggle`   |    yes    |      yes       |    yes     |

An exported feature is vocabulary, not proof that a Qwen adapter composes it.
`negativePrompt` is the clearest example: the package can represent families that genuinely
act on negative conditioning, while Qwen Image 2512 omits the feature because its declared
negative field does not steer output. `fastMode` is the mirror case — all three adapters
compose it because all three endpoints genuinely offer the accelerated sampling path, and
whether Vesper *should* ask for it is a reviewed judgment held elsewhere.

[Back to `@vesper/image-models`](../README.md).
