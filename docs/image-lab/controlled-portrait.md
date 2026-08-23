# Controlled portrait

A `controlled_portrait` asks whether a reviewed structural control still works when the request is shaped like a production portrait edit rather than a raw provider probe.

## Required setup

- One character.
- One identity reference render of that character.
- One reviewed pose, depth, or edge fixture.
- A selected/default registered model with an exact provider version.
- An instruction/prompt.

An optional extra content reference may also be supplied. The recipe supports `outfit`, `style`, and `object`; the current form exposes outfit and style but has no item-image source for the `object` role.

## What the recipe does

The lab constructs a code-defined portrait recipe with:

- task `variant`;
- operation `edit`;
- prompt strategy `multi_reference_compose`;
- required identity and selected control roles;
- at most one of each role;
- optional portrait content roles.

The shared render-intent planner decides ordering/capacity and records which references were sent or dropped. Identity and the declared control are marked required, so a plan that cannot carry either is refused instead of silently rendering a different experiment.

## Model/version behavior

Unlike a baseline, this kind **does** use the experiment's selected model slug. The model must be registered and resolvable to an exact provider version before rendering.

## Raw provider inputs

A controlled portrait is intended to be production-shaped. A raw provider `controlInput` bag is therefore refused as `settings_unsupported`; use a [Control probe](control-probe.md) or the proposed general model-trial lane for provider-specific experiments.

## Mode field

The UI currently records `controlled_composition` or `controlled_identity` as the experiment's `mode`. The current runner/recipe path does not consume that value to alter the render request. Treat it as recorded metadata today, not as a proven active bias knob. See [Known gaps](known-gaps-and-recommendations.md).

## Verdicts

- `honours_control`
- `ignores_control`
- `inconclusive`

A note is required with the ruling.

## Execution path

`apps/web/src/server/images/image-lab-control.ts` → `runControlled(..., "controlled_portrait")` → `imageLabRecipeProfile` → shared `runRecipeIntent` → `renderImageIntent`.