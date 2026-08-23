# Baseline scene

A `baseline_scene` is the production comparison arm for scene experiments. It answers: **what does Vesper's normal scene profile do for this conversation with this instruction?**

## Required setup

- One chat/conversation.
- An instruction/prompt.
- Usable scene references available from the conversation's current stored imagery.

The admin does not hand-order references. The baseline runner resolves them from the conversation.

## What actually runs

The runner resolves the production `scene` image profile. It uses the conversation's newest `chat_look` image as the identity/content anchor when available, falling back to the primary character's canonical avatar, and may also use the newest `chat_place` as a location reference. Those references are sent through the ordinary render-intent planner.

The result therefore measures the current production profile/configuration, not a lab recipe.

## Important: the Model picker is not an override

As with [Baseline portrait](baseline-portrait.md), the New Experiment form currently displays the registry-backed Model picker even though the baseline runner does not honor it as model selection. The runner resolves the production scene profile and overwrites the experiment's stored model slug with the model that profile actually selects.

Use another experiment kind when the selected model itself is the variable being tested. The registry picker added in #170 makes model selection safer for the kinds that actually use it, but it does not alter baseline semantics.

## Known parity limitation

The baseline chooses the newest chat-look render but does not reproduce every wardrobe/cache-key decision made by the full scene lane. It is therefore best understood as a **production-profile/configuration baseline**, not a byte-for-byte replay of every production scene-selection decision.

## Version behavior

Scene baselines do not pin an exact provider version. They intentionally follow production profile/model resolution.

## Verdicts

Baselines have no verdict vocabulary. They exist to provide a visual comparison arm.

## Execution path

`apps/web/src/server/images/image-lab-baseline.ts` → `runBaseline(..., "scene")` → production profile resolution/reference lookup → `renderImageIntent`.
