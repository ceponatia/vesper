# Intimate-scene LoRA follow-ups

Status: post-ship follow-up to [intimate-scene-lora.plan.md](finished/intimate-scene-lora.plan.md) — the 2511 consolidation candidate is recorded but not implemented or scheduled.

This document owns only the post-ship question of whether the intimate scene
route should keep changing Qwen generations to obtain runtime LoRA support.
Current runtime behavior remains documented on
[Qwen Image Edit Plus LoRA](../image-models/models/qwen-image-edit-plus-lora.md),
and the version-specific provider API for 2511 remains owned by
[Qwen Image Edit 2511](../image-models/models/qwen-image-edit-2511.md).

## Candidate — remove the model-generation swap

If a 2511 provider version that exposes runtime LoRA controls can load Vesper's
curated Hugging Face weights and still depict the accepted intimate stagings,
the intimate route can be evaluated without swapping to the older 2509 wrapper.
That would isolate the LoRA as the meaningful route change instead of changing
both the LoRA and the base edit generation at once.

This is a candidate investigation, not current behavior and not an approval to
change the production route.

## Validation gate

Before any route change:

- use the existing provider-version candidate flow to confirm the exact 2511
  candidate and its probed LoRA bindings without treating Replicate latest as
  production state;
- run that exact version in the admin Image Generator with the same kind of
  identity reference the scene lane uses and the curated Hugging Face LoRA;
- inspect the Replicate prediction input and require both the expected identity
  image input and `lora_weights`; Vesper's `meta.lora` proves routing intent, not
  provider receipt;
- compare the candidate against the current 2509 intimate route with prompt,
  identity reference, staging, LoRA scale, and quality controls held constant
  wherever both schemas permit;
- grade both **act depiction** and **identity fidelity**. A route that depicts the
  act but loses the character is not a successful replacement;
- change the production route only after the comparison has an owner verdict.

## Current disposition

The production route stays on the 2509 LoRA wrapper. This follow-up records the
replacement candidate and the evidence required to justify changing it; it does
not change a model row, provider pin, LoRA row, or render path.
