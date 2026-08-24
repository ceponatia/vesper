# Safety-toggle feature

Source: [`packages/image-models/src/features/safety.ts`](../../../packages/image-models/src/features/safety.ts).

`safetyToggleFeature()` contributes capability id `safetyToggle`.

## Semantic

The endpoint exposes a caller-controlled way to disable its own content/safety checker for a render.

This is a model-family capability, not a statement that Vesper always disables moderation. Whether the application requests the toggle is policy owned at the application/render seam.

The feature also does not imply that **all** moderation is controllable. Vendor-side moderation can exist outside the model wrapper and remain impossible for Vesper to disable even when other endpoints expose a local checker flag.

## Binding

`safetyToggle` intentionally has **no `isBound` hook**.

There is no normalized safety-toggle control slot in the `ImageModel` record today. The field may live in pinned extras, and the feature layer is not allowed to discover it by matching raw provider field names. Operator-facing warnings on the model record remain the place to state moderation behavior that cannot be controlled.

## Current Qwen composition

All three registered Qwen adapters compose `safetyToggle`:

- `qwen/qwen-image-edit-2511`
- `qwen/qwen-image-edit-plus-lora`
- `qwen/qwen-image-2512`

[Back to features](README.md).
