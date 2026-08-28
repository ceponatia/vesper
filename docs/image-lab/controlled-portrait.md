# Controlled portrait

A `controlled_portrait` asks whether a reviewed structural control still works when the request is shaped like a production portrait edit rather than a raw provider probe.

## Required setup

- One character.
- One identity reference render of that character.
- One reviewed pose, depth, or edge fixture.
- A selected/default registered model with an exact provider version.
- An instruction/prompt.

An optional extra content reference may also be supplied. The recipe supports `outfit`, `style`, and `object`: outfit and style draw from the character's portrait renders, while `object` draws from the general owned-image picker, since no character- or chat-scoped list holds item imagery.

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

Unlike a baseline, this kind **does** use the experiment's selected model. The model must be registered and resolvable to an exact provider version before rendering.

## Raw provider inputs

A controlled portrait is intended to be production-shaped. A raw provider `controlInput` bag is therefore refused as `settings_unsupported`. A [Control probe](control-probe.md) supports that raw bag but also requires a reviewed control fixture; the lab has no neutral provider-input experiment — that is [Image Generator](../image-generator/README.md) territory.

## Mode field

The experiment contract can store one of four modes (`identity_priority`, `controlled_composition`, `balanced`, `style_priority`), but no runner or recipe path consumes `row.mode` to alter the render request — it is recorded metadata, not an active bias control. The create form does not offer it; historic stored values remain visible on the experiment detail view.

## Verdicts

- `honours_control`
- `ignores_control`
- `inconclusive`

A note is required with the ruling.

## Execution path

`apps/web/src/server/images/image-lab-control.ts` → `runControlled(..., "controlled_portrait")` → `imageLabRecipeProfile` → shared `runRecipeIntent` → `renderImageIntent`.
