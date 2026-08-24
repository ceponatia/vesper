# LoRA feature

Source: [`packages/image-models/src/features/lora.ts`](../../../packages/image-models/src/features/lora.ts).

`loraFeature()` contributes capability id `lora`.

## Semantic

The model can load one external LoRA for a render and apply it at a chosen strength.

The feature deliberately treats the weights locator and strength as a pair. A version exposing only one is not considered capable of carrying a curated LoRA binding correctly.

## Binding

`isBound(model)` is true only when both normalized controls exist on the active probed model record:

- `advancedCapabilities.controls.loraWeights`
- `advancedCapabilities.controls.loraScale`

This means family composition and active-version capability remain separate facts. An adapter may claim LoRA support while a stale or drifted probed row still fails the binding check.

## Validation

When `ImageModelRequestFacts.usesLora` is false, the feature has nothing to refuse.

When `usesLora` is true and either normalized binding is missing, validation returns a pre-spend refusal explaining that the active version cannot carry the LoRA and should be re-probed or replaced with a model that exposes both fields.

This is the cheap model/request compatibility check. It does not replace `@vesper/image-core`'s final-wire LoRA invariant, which later verifies that the resolved LoRA locator and scale actually reached the payload unchanged.

## Current Qwen composition

Only `qwen/qwen-image-edit-plus-lora` composes `lora`.

`qwen/qwen-image-edit-2511` deliberately does not. Its endpoint exposes no runtime LoRA weights/scale inputs; references to integrated LoRAs describe acceleration built into the published model rather than a caller-loadable LoRA.

`qwen/qwen-image-2512` also does not compose this feature.

The Plus LoRA adapter currently represents **one LoRA per prediction**. The endpoint has one weights/scale pair, not a repeated or multi-LoRA input.

[Back to features](README.md).
