# Staged scene

A `staged_scene` benches one staging from Vesper's scene-staging registry without needing a chat composer to happen to propose it. Its purpose is parity testing for the production staging wording, the subject description, and the LoRA route.

## Required setup

- One character.
- One identity reference render of that character.
- One staging id from the registry.
- A selected/default registered model with an exact provider version.
- Optionally, a compatible curated LoRA and scale.

A staged scene has no chat and no control fixture, and the bench has **one arm**: the production cut.

## Prompt ownership

This is the most important behavior of the kind: **the admin's instruction is not the staging prompt.** The form deliberately sends an empty instruction, and the runner compiles a prompt program from the selected staging registry entry and the subject's visual cut — the exact program the chat scene lane's single-reference `edit` rung compiles for the same plan and cut.

That is what makes the result evidence about the production staging wording instead of about an ad-hoc prompt typed for the bench.

The form can vary staging setting, lighting, and time of day where those fields are supplied. `stagedScenePlan` resolves those into a scene plan whose focal is the selected character, and `stagedSceneProgram` (`image-lab-staged.ts`, pure) lowers it with `lowerScenePlan` under `allowIntimate: true` — every intimate entry's arrangement is withheld without it, and a bench for the intimate LoRA whose prompt omitted the act would grade the model on the wrong picture — then compiles through the character seam with `bindingStrategy: "instruction_edit"`, `intimateReveal: true`, the identity reference bound to the subject, and `characterSceneImageOperation({ subjectCount: 1, kind: "edit" })`. The registry owns every explicit phrase (the lowering adopts the staging's measured surface form); nothing here paraphrases a template. For the same plan and cut the bench's program is byte-identical to the chat lane's, and `image-lab-staged.test.ts` pins it against a seam with no database behind it.

## The subject

The subject is a committed visual cut, realized by `image-lab-staged-visual.ts` through the same standalone assembly the avatar and variant lanes take, under the chat scene lane's own knobs: the digest's consent gate shut (intimate anatomy reaches a staged prompt the way it reaches a chat's — as the route's typed reveal over the cut's coverage, spent on the uncensored rung), the staging's own camera under the lane's viewpoint id `image_lab_staged_scene`. It is the ONLY thing the program says about the person, exactly as in a chat: appearance, identity anchor, figure, and — on the uncensored route — intimate anatomy, from the same visual state a chat render reads. A verdict then rules on the sentence a real conversation would have sent for this staging.

A run whose cut cannot be assembled settles the row failed with `visual_digest_unavailable`, before any provider spend. It is never degraded to a name-only render: a prompt production never sends would answer a different question than the row asks. A cut that assembles but compiles to a refusal — a lost required anchor, a missing pack, a renumbered slot — settles under the prompt program's own `image_prompt_program.*` code, the way an `image_lora.*` or `image_profile.*` refusal lands verbatim. A pinned endpoint with no active prompt binding for the scene task settles under `image_prompt_program.unbound` (`STAGED_PROGRAM_UNBOUND`); the bench has no authorized way to word the act until the endpoint is bound.

**The staging's exposure is the act's premise, not the character's wardrobe.** A staged row states bare skin exactly where its registry template describes bare skin, and covered everywhere else, and states the viewer's own exposure the same way. It does not read the character's saved clothing: a dressed character would suppress the bare-region phrasing the template is written around, and the bench would quietly pay for an ordinary portrait. That premise is handed to the assembly as worn coverage (`stagedPremiseWorn`), so the digest's exposure readout and the camera's per-location perception both answer the premise and the two halves of one run cannot disagree about what the shot shows.

## References

Exactly one identity reference is required. The staged recipe also permits an optional `location` role, supplied through the general owned-image picker — the chat-independent place-image source this kind needs, since a staged experiment intentionally has no chat. The runner sends the program's **own planned list** (`program.sentReferences`), in the program's order, so a numbered slot names the image the payload carries at that position by construction.

## Model and LoRA behavior

The selected model is honored and must be pinnable. In the Model picker, `Default` resolves to the production intimate-scene model (`qwen/qwen-image-edit-2511`), and the staged kind sends that slug explicitly so the bench names the same model production runs rather than whatever the runner would otherwise resolve. The seeded staging LoRA is `INTIMATE_SCENE_LORA_ID`, the same curated row the production intimate route pairs with 2511.

The recipe profile (`imageLabStagedSceneRecipeProfile`) runs the `instruction_edit` prompt strategy, which passes the compiled prompt through untouched — the program already numbers its own references, and a composing strategy would prefix a second numbering over the program's. The recipe profile carries no binding row (it is a request shape, not an authorized endpoint), so the program binds on the profile key a chat scene would compile this model under: the pinned model's own offered scene profile, else the scene task's default.

LoRA resolution is shared with production. The lab can override the selected LoRA's scale within its curated range, making this kind useful for scale sweeps. The built-in staging LoRA's band is deliberately wider than the strengths already graded, because a sweep is only informative if it can reach both edges the verdicts below distinguish — `anatomy_withheld` is the scale too low, `geometry_wrong` is the scale too high.

Raw provider input is refused because the experiment is specifically meant to reproduce a production-shaped staging request.

## Verdicts

- `act_depicted`
- `act_substituted`
- `anatomy_withheld`
- `geometry_wrong`
- `identity_lost`
- `inconclusive`

## Execution path

`apps/web/src/server/images/image-lab-staged.ts` → `runStagedScene` → staging registry + the subject's cut (`image-lab-staged-visual.ts`) → `stagedScenePlan` → `stagedSceneProgram` (`lowerScenePlan` + `buildCharacterPromptProgram`) → `imageLabStagedSceneRecipeProfile` → shared `runRecipeIntent` with the program's prompt, planned references and compiled negative.
