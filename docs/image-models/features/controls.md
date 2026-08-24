# Generation-control features

Source: [`packages/image-models/src/features/controls.ts`](../../../packages/image-models/src/features/controls.ts).

This module defines three normalized single-binding controls: `seed`, `guidance`, and `negativePrompt`.

Each binding check reads `model.advancedCapabilities.controls`, which is populated by provider probing. The feature layer never needs to know whether a provider spells guidance `guidance`, `cfg`, or something else.

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

## `negativePrompt`

`negativePromptFeature()` contributes capability id `negativePrompt`.

**Semantic:** the model accepts a negative prompt **and actually acts on it**, so exclusions genuinely steer output.

**Binding:** `isBound(model)` is true when the active model record has a normalized `negativePrompt` binding.

Composition is intentionally stricter than schema presence. A family should compose this feature only when negative conditioning changes model behavior, not merely because the provider exposes a field with that name.

**Current Qwen use:** none of the registered Qwen adapters compose `negativePrompt`.

Qwen Image 2512 is the important case: its provider schema declares a negative-prompt field, but Vesper's paired testing found no steering effect. Advertising the feature would therefore turn a decorative compatibility field into a false capability claim. The edit endpoints do not expose negative prompting in their schemas at all.

[Back to features](README.md).
