# Finishing pass

A `finishing_pass` re-edits the result of another lab experiment to answer: **can the subject's identity be improved while everything else stays the same?**

## Required setup

- A succeeded, finishable source experiment with a result image.
- A selected/default registered model with an exact provider version.
- For the ordinary identity arm, an eligible identity pack for the inherited subject.
- For the `lora_only` arm, a selected compatible LoRA.

Finishable source kinds are baseline portrait, baseline scene, controlled portrait, and controlled scene. A probe, another finishing pass, a two-character scene, or a staged scene cannot be used as the source.

## Inputs are runner-resolved

The admin does **not** select ordered inputs for this kind. The runner reads the source experiment's actual result image and writes the references it actually sends back onto the finishing-pass row.

The subject is inherited from the source experiment. If the source was chat-scoped, the runner resolves the chat's primary character for identity-pack lookup.

## Two arms

### Identity arm

Sends:

1. the source experiment's result as `before`;
2. identity references selected by the character's identity-pack policy.

The fixed finishing instruction says the output is the base image with identity corrected toward the supplied reference while other composition/state remains unchanged. Admin text is additive; it does not replace the fixed instruction.

### LoRA-only arm

Sends the source result and **no identity reference**. A LoRA is required. This isolates what the weights contribute instead of making any identity improvement attributable to both a reference pack and the LoRA.

## Model/settings behavior

The selected model is honored and must be pinnable. Raw provider input is refused; the pass runs through a code-defined recipe. Curated LoRA settings are resolved through the shared production LoRA machinery, including model/version compatibility and allowed scale range.

## Verdicts

- `improves_identity`
- `identity_unchanged`
- `changes_beyond_identity`
- `inconclusive`

## Execution path

`apps/web/src/server/images/image-lab-finishing.ts` → `runFinishingPass` → identity-pack/LoRA resolution → `imageLabFinishingRecipeProfile` → shared `runRecipeIntent`.