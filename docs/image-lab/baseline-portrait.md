# Baseline portrait

A `baseline_portrait` is the comparison arm for portrait/variant work. It answers: **what does Vesper's production portrait profile do for this character with this instruction?**

It is not a generic selected-model render.

## Required setup

- One character.
- An instruction/prompt.
- The character must have a canonical avatar that the production variant profile can use as its identity anchor.

The client sends no ordered lab inputs for this kind. The baseline runner resolves its own production reference.

## What actually runs

The runner resolves the production `variant` image profile, loads the character's canonical avatar, constructs an ordinary `ImageRenderIntent`, and executes it through `renderImageIntent`.

The admin's instruction becomes the base prompt. The experiment records the profile selected by production and the reference-planning outcome.

## Important: the Model picker is not an override

The New Experiment form currently shows the same registry-backed Model picker used by other experiment kinds. For a portrait baseline, that picker is misleading: selecting a model does not force the baseline to use it.

At run time the baseline resolves the production variant profile and then writes that profile's resolved model slug back onto the experiment. Whatever model slug was stored when the experiment was created is replaced. This is intentional in the runner: a baseline is supposed to reproduce production selection, not force a different model.

Accordingly, use a baseline portrait only when the production-profile result is the thing you want to compare against. To exercise a lab-only renderer or a specific registered model, the lab needs the general model-trial path described in [Known gaps](known-gaps-and-recommendations.md).

## Version behavior

Baselines do not require an exact provider version pin. Production follows the active profile/model configuration, and this experiment's purpose is to reproduce that behavior. The row may therefore have no `requestedVersionId`.

## Verdicts

Baselines intentionally have no verdict. They are comparison arms, not a question such as control obedience or identity repair.

## Execution path

`apps/web/src/server/images/image-lab-baseline.ts` → `runBaseline(..., "variant")` → production profile resolution → `renderImageIntent`.

## Best use

Create a portrait baseline beside a controlled portrait when you want the same authored instruction compared between the normal production profile and the lab's production-shaped control recipe. Do not use it as a model smoke test.
