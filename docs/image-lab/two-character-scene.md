# Two-character scene

A `two_character_scene` tests whether a model can compose two named people without swapping, merging, duplicating, or losing either identity. A structural fixture is optional, allowing identity composition to be tested separately from control obedience.

## Required setup

- One chat/conversation the evidence will be filed against.
- Two different characters.
- One identity reference render for each character.
- A selected/default registered model with an exact provider version.
- An instruction/prompt.
- Optionally, one reviewed pose, depth, or edge fixture.

Each identity input stores its own `characterId`. This is the only experiment kind that binds a subject directly to an input, because a single top-level character field cannot describe a two-person cast.

## Binding integrity

Before spending, the runner verifies that both character names are usable and distinguishable and that each identity image is actually filed as a render of the character it claims to depict. These checks prevent a malformed request from looking like a model that swapped identities.

The prompt compiler names each character in its numbered reference binding. The form sends character A first, character B second, then the optional control.

## Capacity

Every supplied reference in this kind is required. If the selected model cannot fit both identities plus the optional control, the experiment refuses `capacity_exceeded` rather than dropping a character.

For the default Qwen edit model, three reference slots fit the two identities plus one fixture exactly.

## Control behavior

The control is optional. If none is declared, no pose/depth/edge/control-role image may ride along undeclared. If a control is selected, it must pass the same fixture review/provenance gates as other control experiments.

## Verdicts

- `both_identities_held`
- `identities_swapped`
- `character_missing`
- `character_duplicated`
- `identity_degraded`
- `inconclusive`

## Execution path

`apps/web/src/server/images/image-lab-scene.ts` → `runTwoCharacterScene` → `imageLabTwoCharacterRecipeProfile` → shared `runRecipeIntent`.