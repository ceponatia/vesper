# Reference-image feature

Source: [`packages/image-models/src/features/references.ts`](../../../packages/image-models/src/features/references.ts).

`multiReferenceFeature()` contributes capability id `multiReference`.

## Semantic

The model can accept several reference images in one render so references may carry distinct roles, such as character identity and scene/location guidance.

This feature does not identify the provider field that carries references. Capacity is read through `@vesper/image-core`'s normalized `referenceCapacity(model)` helper, which reconciles the model row's edit ability, arity, and stored reference cap.

## Binding

`isBound(model)` is true when the normalized reference capacity is greater than one.

A model that accepts exactly one reference may still support image-to-image or editing, but it does not satisfy this feature's semantic claim of **multiple** role-bearing references.

## Validation

The feature validates `ImageModelRequestFacts.referenceCount` against the model's normalized maximum.

If the render asks for more references than the model can carry, validation returns a pre-spend refusal. The feature deliberately does not trim the list itself: silently dropping a reference can remove a character identity or other required role without leaving an obvious trace in the output.

A capacity of zero receives a specific refusal saying the model accepts no references; other over-capacity requests report the maximum and requested count.

## Current Qwen composition

Both instruction-edit adapters compose `multiReference`:

- `qwen/qwen-image-edit-2511`
- `qwen/qwen-image-edit-plus-lora`

Both are currently documented as accepting 1–3 numbered references.

`qwen/qwen-image-2512` does **not** compose this feature. Its optional image input is a single strength-based image-to-image reference, not the numbered multi-reference instruction-edit mechanism used by the editors.

[Back to features](README.md).
