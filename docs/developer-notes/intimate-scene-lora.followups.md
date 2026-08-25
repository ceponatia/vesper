# Intimate-scene LoRA follow-ups

Status: parked detail for [deferred.plan.md](deferred.plan.md) §"Intimate-scene LoRA — consolidate onto Qwen Edit 2511" — runtime LoRA support is verified on 2511; the route comparison is not scheduled.

This document owns only the post-ship question of whether the intimate scene
route should stop changing Qwen generations merely to obtain runtime LoRA
support. Current runtime behavior remains documented on
[Qwen Image Edit Plus LoRA](../image-models/models/qwen-image-edit-plus-lora.md),
and the version-specific provider API for 2511 remains owned by
[Qwen Image Edit 2511](../image-models/models/qwen-image-edit-2511.md).

## Candidate — remove the model-generation swap

Qwen Image Edit 2511 now exposes runtime `lora_weights` and `lora_scale`, and
Vesper's adapter plus the pinned registry row carry the verified capability.
The infrastructure question is therefore closed: the intimate route can be
evaluated without swapping to the older 2509 wrapper.

What remains is a quality comparison. If 2511 can load Vesper's curated
Hugging Face weights and still depict the accepted intimate stagings while
preserving identity, the route can isolate the LoRA as the meaningful change
instead of changing both the LoRA and the base edit generation at once.

This is a candidate investigation, not current behavior and not an approval to
change the production route.

## Validation gate

Before any route change:

- confirm the exact active 2511 version and its stored LoRA bindings rather than
  treating Replicate latest as production state;
- run that exact version in the admin Image Generator with the same kind of
  identity reference the scene lane uses and the curated Hugging Face LoRA;
- inspect the Replicate prediction input and require both the expected identity
  image input and `lora_weights`; Vesper's `meta.lora` proves routing intent, not
  provider receipt;
- compare 2511 against the current 2509 intimate route with prompt, identity
  reference, staging, LoRA scale, and quality controls held constant wherever
  both schemas permit;
- grade both **act depiction** and **identity fidelity**. A route that depicts the
  act but loses the character is not a successful replacement;
- change the production route only after the comparison has an owner verdict.

## Current disposition

The production route stays on the 2509 LoRA wrapper. The old blocker — no
2511-grade endpoint with runtime LoRA — is gone, but no quality verdict has
replaced the accepted 2509 route. This follow-up records the evidence required
to justify that change; it does not change a model row, provider pin, LoRA row,
or render path.
