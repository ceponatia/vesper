# Staged scene

A `staged_scene` benches one staging from Vesper's scene-staging registry without needing a chat composer to happen to propose it. Its purpose is parity testing for the production staging wording, the subject description, and the LoRA route.

## Required setup

- One character.
- One identity reference render of that character.
- One staging id from the registry.
- A selected/default registered model with an exact provider version.
- Optionally, a compatible curated LoRA and scale.
- A subject-facts mode, defaulting to production parity (see below).

A staged scene has no chat and no control fixture.

## Prompt ownership

This is the most important behavior of the kind: **the admin's instruction is not the staging prompt.** The form deliberately sends an empty instruction, and the runner compiles the prompt from the selected staging registry entry with the same scene-plan/render-prompt machinery used by the production chat path.

That is what makes the result evidence about the production staging wording instead of about an ad-hoc prompt typed for the bench.

The form can vary staging setting, lighting, and time of day where those fields are supplied. The selected character is named directly in the compiled staging sentence, and — on the default subject-facts mode below — described from the same visual state a chat render reads.

## Subject facts

A staged run chooses where the subject's own facts come from. The choice is recorded on the row, because two runs of one staging that describe the subject differently are exactly the comparison this control exists to make.

- **Production parity — describe the character.** The default. The prompt carries the character's appearance, identity anchors, figure, and — on the uncensored route — their intimate anatomy, drawn from the character's visual digest under the production chat lane's own segment policy. A verdict then rules on the sentence a real conversation would have sent for this staging.
- **Ablation — name only, no description.** The prompt names the character and says nothing else about them; the likeness has to come from the identity reference alone. It is a deliberately reduced run, and it answers only one question: whether the written description is helping the face or fighting the reference image. **Read it only beside a parity run of the same staging** — on its own it is a shorter prompt with no baseline.

A parity run that cannot describe its subject — the visual assembly failed, or a required visual fact resolved no prompt clause — settles the row failed with `visual_digest_unavailable`, before any provider spend. It never falls back to the ablation: an arm the operator did not choose would answer a different question than the row asks.

Runs created before this control existed read back as the ablation, because that is what they sent.

**The staging's exposure is the act's premise, not the character's wardrobe.** A staged row states bare skin exactly where its registry template describes bare skin, and covered everywhere else, and states the viewer's own exposure the same way. It does not read the character's saved clothing: a dressed character would suppress the bare-region phrasing the template is written around, and the bench would quietly pay for an ordinary portrait. That premise drives both the prompt's exposure readout and what the camera is treated as able to see, so the two halves of one run cannot disagree about what the shot shows.

## References

Exactly one identity reference is required. The staged recipe also permits an optional `location` role, supplied through the general owned-image picker — the chat-independent place-image source this kind needs, since a staged experiment intentionally has no chat.

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

`apps/web/src/server/images/image-lab-staged.ts` → `runStagedScene` → staging registry + subject facts (`image-lab-staged-visual.ts`, on the parity mode) + production scene prompt compiler → `imageLabStagedSceneRecipeProfile` → shared `runRecipeIntent`.
