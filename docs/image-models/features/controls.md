# Generation-control features

Source: [`packages/image-models/src/features/controls.ts`](../../../packages/image-models/src/features/controls.ts).

This module defines four normalized single-binding controls: `seed`, `guidance`, `fastMode`, and `negativePrompt`.

Each binding check reads `model.advancedCapabilities.controls`, which is populated by provider probing. The feature layer never needs to know whether a provider spells guidance `guidance`, `guidance_scale`, `cfg`, or something else.

## `seed`

`seedFeature()` contributes capability id `seed`.

**Semantic:** the model accepts a seed so the same request can be reproduced.

**Binding:** `isBound(model)` is true when the active model record has a normalized `seed` control binding.

**Current Qwen use:** all three registered Qwen adapters compose `seed`.

## `guidance`

`guidanceFeature()` contributes capability id `guidance`.

**Semantic:** the model accepts a guidance strength controlling how closely generation follows the prompt.

**Binding:** `isBound(model)` is true when the active model record has a normalized `guidance` control binding.

**Current Qwen use:** only `qwen/qwen-image-2512` composes `guidance`. The two instruction-edit endpoints do not expose a guidance control; their behavior is governed by the instruction and reference images instead.

The probe resolves `guidance`, `guidance_scale`, and `cfg` to this one control, in that order. It deliberately does **not** resolve `true_cfg_scale`: on a CFG-distilled checkpoint that is a different quantity from the embedded guidance, so binding both to one name would leave a run record unable to say which value moved.

## `fastMode`

`fastModeFeature()` contributes capability id `fastMode`.

**Semantic:** the endpoint offers an accelerated sampling path, and the caller may choose it or refuse it.

**Binding:** `isBound(model)` is true when the active model record has a normalized `fastMode` control binding.

This is a quality choice wearing a speed name. The wrappers that expose it turn it on by default, so composing the feature says a family's renders can be asked to slow **down**, not merely to hurry. Both answers are real requests; absence of the control is the only way to say nothing.

Composition is a statement about what the endpoint can express, never about what Vesper should ask for. Vesper's reviewed quality policy refuses the accelerated path on `qwen/qwen-image-edit-2511`, whose every production use is identity-critical, and that ruling lives in `@vesper/image-core` rather than here.

**Current Qwen use:** all three registered Qwen adapters compose `fastMode`.

## `negativePrompt`

`negativePromptFeature()` contributes capability id `negativePrompt`.

**Semantic:** the model accepts a negative prompt **and actually acts on it**, so exclusions genuinely steer output.

**Binding:** `isBound(model)` is true when the active model record has a normalized `negativePrompt` binding.

Composition is intentionally stricter than schema presence. A family should compose this feature only when negative conditioning changes model behavior, not merely because the provider exposes a field with that name.

**Current Qwen use:** none of the registered Qwen adapters compose `negativePrompt`.

Qwen Image 2512 is the important case: its provider schema declares a negative-prompt field, but Vesper's paired testing found no steering effect. Advertising the feature would therefore turn a decorative compatibility field into a false capability claim. The edit endpoints do not expose negative prompting in their schemas at all.

[Back to features](README.md).
