# Image model features

Features are the semantic vocabulary used by `@vesper/image-models` adapters. They describe
**what a model family can express**, while the probed image-model record remains
authoritative for **which provider input fields carry it**.

Source: [`packages/image-models/src/features`](../../../packages/image-models/src/features).
The thirteen feature constructors exported from the package root are documented below, one
`##` section per `src/features/` module.

## Owns / does not own

- **Owns:** the feature vocabulary, each feature's semantic claim, its `isBound` rule, its
  pre-spend validation, and the Qwen, FLUX.2 klein, and FLUX.1 Kontext composition matrices.
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

Only three feature modules validate requests: `multiReference` rejects an intended reference
count above `referenceCapacity(model).max`; `sourceImage` rejects a request that carries no
reference image on a model that cannot generate from nothing, and rejects one above the same
normalized maximum; and `lora` rejects a LoRA-bearing request when the active model record
carries no usable LoRA weights/scale pair — missing, or the two fields disagreeing on shape.

These are model/request compatibility checks. They do not replace `@vesper/image-core`'s
final-wire invariants, which verify the payload that is actually going to the provider.

## Prompt

`promptFeature()` (`src/features/prompt.ts`) contributes capability id `prompt`.

**Semantic:** the model accepts an authored text prompt describing or instructing the image.
The feature is explicit even though nearly every current image model takes text, because an
adapter's capability list is intended to describe the endpoint completely. A pure upscaler
or other image-only endpoint can legitimately omit the prompt capability rather than
inheriting one implicitly.

**Binding:** none. The row's prompt binding records where a prompt goes — a probed field
name — and, when a length is curated for it, how long a prompt the model answers well to
([providers/registry.md](../../images/providers/registry.md) §Probe-owned columns). Older or
unprobed rows can lack that binding even though the provider still accepts a prompt, and
treating the missing record as proof that the model has no prompt would create false
refusals. Prompt-length fitting remains `@vesper/image-core`'s responsibility.

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

### `sourceImage`

`sourceImageFeature()` (`src/features/references.ts`) contributes capability id
`sourceImage`.

**Semantic:** the model requires exactly one reference image — the source the render works
from — and carries no more than one. This is a different semantic claim from
`multiReference`, not a capacity-1 reading of it: `multiReference`'s claim is that several
images can each carry a distinct, named role, which is false at a cap of one, while
`sourceImage`'s claim is that the render has nothing to work from without that single image.
`qwen/qwen-image-2512`'s single reference input is a different case again — an OPTIONAL
strength-based image-to-image slot, not a required source — so that endpoint composes
neither feature.

**Binding:** true when the model can edit and its normalized reference capacity
(`referenceCapacity(model)`) is at least one. A generation-only row cannot bind this feature
regardless of what its stored `maxReferences` says.

**Validation:** the feature refuses a request that carries no reference image when the model
cannot generate from nothing (`!model.canGenerate`), and refuses one whose reference count
exceeds the model's capacity — the same over-capacity sentence `multiReference` produces.
The two features share that wording through one helper in `references.ts` rather than
carrying two slightly different phrasings of the same fact.

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

`src/features/controls.ts` defines five normalized single-binding controls. Each binding
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
- **`steps`** — `stepsFeature()`. The model accepts an inference-step count, trading render
  time against sampling quality. Bound when the active record has a normalized `steps`
  control binding.
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
only one, or exposing the two in different shapes, is not considered capable of carrying a
curated LoRA binding correctly. Each adapter that composes this feature represents **one
LoRA per prediction** — never a repeated or multi-LoRA input.

A bound pair comes in exactly two shapes, over `advancedCapabilities.controls.loraWeights`
and `.loraScale`: **scalar**, where the active version's schema declares
`lora_weights`/`lora_scale` as two plain fields (every Qwen edit endpoint), and **array**,
where it declares `lora_weights`/`lora_scales` as two singleton-capable lists (a FLUX.2
klein `-base-lora` endpoint). Which shape a version uses is a probed fact, never an adapter
choice — see [providers/loras.md](../../images/providers/loras.md) for how the probe tells
the two apart and [`@vesper/image-core`'s capabilities module](../../../packages/image-core/src/capabilities/image-model-capabilities.ts)
for `resolveImageLoraBindingPair`, the one shared reading of a usable pair that this feature,
the render-side control mapper, the final-wire invariant, and the library's mechanical
compatibility check all consult — a version whose two fields disagree on shape is exactly as
unbound as a version missing one of them.

**Binding:** true only when `resolveImageLoraBindingPair` resolves a pair from the active
probed model record — both fields present and agreeing on shape. Family composition and
active-version capability are separate facts — an adapter may claim LoRA support while a
stale or drifted probed row still fails the binding check.

**Validation:** when `ImageModelRequestFacts.usesLora` is false the feature has nothing to
refuse. When `usesLora` is true and the pair does not resolve, validation returns a pre-spend
refusal naming the specific problem — the missing side, or the shape mismatch (an array
`lora_weights` beside a scalar `lora_scale`, say) — rather than one generic sentence, and
says the active version should be re-probed or replaced with a model that exposes a matching
pair. This is the cheap model/request compatibility check; it does not replace
`@vesper/image-core`'s final-wire LoRA invariant, which verifies that the resolved LoRA
locator and scale actually reach the payload unchanged — as a scalar value for a scalar
binding, or as the single element of a one-item list for an array one.

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

| Feature          | Edit 2511 | Image 2512 |
| ---------------- | :-------: | :--------: |
| `prompt`         |    yes    |    yes     |
| `multiReference` |    yes    |     no     |
| `aspectRatio`    |    yes    |    yes     |
| `seed`           |    yes    |    yes     |
| `guidance`       |    no     |    yes     |
| `fastMode`       |    yes    |    yes     |
| `negativePrompt` |    no     |     no     |
| `lora`           |    yes    |     no     |
| `outputFormat`   |    yes    |    yes     |
| `outputQuality`  |    yes    |    yes     |
| `safetyToggle`   |    yes    |    yes     |

An exported feature is vocabulary, not proof that a Qwen adapter composes it.
`negativePrompt` is the clearest example: the package can represent families that genuinely
act on negative conditioning, while Qwen Image 2512 omits the feature because its declared
negative field does not steer output. `fastMode` is the mirror case — both adapters compose
it because both endpoints genuinely offer the accelerated sampling path, and whether Vesper
*should* ask for it is a reviewed judgment held elsewhere.

## FLUX.2 klein composition

klein (`packages/image-models/src/families/flux/klein.ts`) registers three variant compositions from the
captured schemas recorded on each endpoint's model page ([FLUX.2 klein 4B](../models/flux-2-klein-4b.md),
[4B Base](../models/flux-2-klein-4b-base.md), [4B Base LoRA](../models/flux-2-klein-4b-base-lora.md)) rather
than one union: a distilled endpoint, a base endpoint, and a base-lora endpoint, each a genuinely different
schema rather than one schema read three ways. 4B and 9B are parameter-count twins — the schema and the
composed feature set are identical between the two sizes for a given variant, so the registry maps both
twin slugs to one variant object instead of duplicating the definition ([package README → registered klein
adapters](../README.md#registered-flux2-klein-adapters)).

| Feature          | Distilled (`4b`/`9b`) | Base (`4b-base`/`9b-base`) | Base-LoRA (`4b-base-lora`/`9b-base-lora`) |
| ---------------- | :-------------------: | :------------------------: | :---------------------------------------: |
| `prompt`         |          yes          |            yes             |                    yes                    |
| `multiReference` |          yes          |            yes             |                    yes                    |
| `aspectRatio`    |          yes          |            yes             |                    yes                    |
| `seed`           |          yes          |            yes             |                    yes                    |
| `fastMode`       |          yes          |            yes             |                    no                     |
| `guidance`       |          no           |            yes             |                    no                     |
| `lora`           |          no           |             no             |                    yes                    |
| `outputFormat`   |          yes          |            yes             |                    yes                    |
| `outputQuality`  |          yes          |            yes             |                    yes                    |
| `safetyToggle`   |          yes          |            yes             |                    yes                    |
| `negativePrompt` |          no           |             no             |                    no                     |

These are declared capabilities read from the captured schemas, not measured render quality and not a
guarantee that every safety checker can be fully disabled. The base-lora variant's `lora` binding is the
ARRAY pair shape — `lora_weights`/`lora_scales` as matched singleton lists — the second shape
`resolveImageLoraBindingPair` recognizes alongside the Qwen edit endpoints' scalar pair (see [LoRA](#lora)
above). No klein variant composes `preparePrompt`: the family is a bench-only onboarding with no
source-backed prompt finding, and it does not reuse the production Flux checkpoints'
`flux_dev_positive_replacement` dialect merely because both share the word FLUX. No variant composes an
execution hint; a hint requires a measurement of the actual endpoint.

**Adapter lookup is not the same fact as an enabled database row.** Registering a klein slug in
`IMAGE_MODEL_ADAPTERS` is code support for the behavior above; it does not itself register, enable, or
authorize any model. No 9B `image_models` row is seeded; database registration of a 9B row is a separate
owner decision, and this composition does not add one. Only a registered, enabled row actually renders,
whatever adapters the lookup can resolve for its slug.

## FLUX.1 Kontext composition

The FLUX.1 Kontext family (`packages/image-models/src/families/flux/kontext.ts`) registers one endpoint,
the DEV tier, composed directly from its captured Input schema
([model page](../models/flux-kontext-dev.md)):

| Feature          | Dev |
| ---------------- | :-: |
| `prompt`         | yes |
| `multiReference` | no  |
| `sourceImage`    | yes |
| `aspectRatio`    | yes |
| `seed`           | yes |
| `guidance`       | yes |
| `steps`          | yes |
| `fastMode`       | no  |
| `negativePrompt` | no  |
| `lora`           | no  |
| `outputFormat`   | yes |
| `outputQuality`  | yes |
| `safetyToggle`   | yes |

These are declared schema capabilities read from the captured endpoint, not measured render quality, and
not a guarantee that the safety checker can be fully disabled. No adapter in this family composes
`preparePrompt` or an execution hint: no prompt-rewriting finding and no measured timing back either hook
for this endpoint. The Qwen and FLUX.2 klein compositions above are unchanged by this addition and compose
neither `sourceImage` nor `steps`.

[Back to `@vesper/image-models`](../README.md).
