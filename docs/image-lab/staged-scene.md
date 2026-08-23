# Staged scene

A `staged_scene` benches one staging from Vesper's scene-staging registry without needing a chat composer to happen to propose it. Its purpose is parity testing for the production staging wording and LoRA route.

## Required setup

- One character.
- One identity reference render of that character.
- One staging id from the registry.
- A selected/default registered model with an exact provider version.
- Optionally, a compatible curated LoRA and scale.

A staged scene has no chat and no control fixture.

## Prompt ownership

This is the most important behavior of the kind: **the admin's instruction is not the staging prompt.** The form deliberately sends an empty instruction, and the runner compiles the prompt from the selected staging registry entry with the same scene-plan/render-prompt machinery used by the production chat path.

That is what makes the result evidence about the production staging wording instead of about an ad-hoc prompt typed for the bench.

The form can vary staging setting, lighting, and time of day where those fields are supplied. The selected character is named directly in the compiled staging sentence.

## References

Exactly one identity reference is required. The staged recipe also permits an optional `location` role, but the current form exposes no location picker for this kind. Its existing location-image source is chat-scoped while the staged experiment intentionally has no chat. The runner can support the role once a chat-independent place-image source is available to the UI.

## Model and LoRA behavior

The selected model is honored and must be pinnable. In the Model picker, `Default` resolves to the intimate LoRA-capable wrapper rather than the ordinary Qwen edit default, because the normal default cannot load the seeded staging LoRA.

LoRA resolution is shared with production. The lab can override the selected LoRA's scale within its curated range, making this kind useful for scale sweeps.

Raw provider input is refused because the experiment is specifically meant to reproduce a production-shaped staging request.

## Verdicts

- `act_depicted`
- `act_substituted`
- `anatomy_withheld`
- `geometry_wrong`
- `identity_lost`
- `inconclusive`

## Execution path

`apps/web/src/server/images/image-lab-staged.ts` → `runStagedScene` → staging registry + production scene prompt compiler → `imageLabStagedSceneRecipeProfile` → shared `runRecipeIntent`.
