# Controlled scene

A `controlled_scene` asks whether a reviewed structural control still holds in Vesper's production-shaped scene composition recipe.

## Required setup

- One chat/conversation.
- One identity reference for the conversation's primary character.
- One reviewed pose, depth, or edge fixture.
- A selected/default registered model with an exact provider version.
- An instruction/prompt.

Optional content references supported by the recipe are `location`, `outfit`, and `style`.

## Subject and references

The experiment is filed against the selected chat. The identity picker is scoped to that chat's primary character so the experiment cannot claim to be about one conversation while supplying an unrelated character identity through the ordinary UI.

Identity and the declared fixture are required references. Optional content may be trimmed by the render-intent planner when model capacity is narrower; the outcome records the roles actually sent and any dropped references.

## Prompt behavior

The admin's instruction is the base prompt. The recipe's `multi_reference_compose` strategy prefixes numbered role bindings based on the planned references. The form previews those bindings before submission.

## Model/version behavior

The selected model slug is honored and must resolve to an exact provider version. This differs from [Baseline scene](baseline-scene.md), which follows production profile selection and does not use the Model field as an override.

## Settings and Mode

Raw provider-shaped settings are refused because this kind is explicitly meant to test the production request shape. Normalized controls can be carried by the experiment contract when supported by the model/profile.

The UI's `controlled_composition` / `controlled_identity` Mode value is currently stored but is not consumed by `runControlled` or the recipe builder to change the request. Treat it as metadata until that wiring exists.

## Verdicts

- `honours_control`
- `ignores_control`
- `inconclusive`

## Execution path

`apps/web/src/server/images/image-lab-control.ts` → `runControlled(..., "controlled_scene")` → scene control recipe → shared `runRecipeIntent`.