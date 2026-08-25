# Advanced Image Lab

The Advanced Image Lab is Vesper's admin-only image experimentation bench at `/settings/image-lab`, reached from the account dropdown in the global header ([ui.md](../ui.md)). It exists to answer narrow image-model questions with a durable record of what was requested, what was actually sent, which model/version ran, what image came back, and—where the experiment has a defined question—a human verdict.

The lab is deliberately separate from player-facing image generation. Some experiment kinds reproduce a production-shaped request, while others bypass production policy to test a specific capability. Those are different kinds because evidence is only useful when the record says which question was being asked.

> **Boundary:** the lab is not a general model playground, by design. Raw prompt-and-model runs belong to the separate admin [Image Generator](../image-generator/README.md), which shares the registry/capability/render stack but none of the lab's evidence rules — and neither surface imports the other. The lab's own current constraints are in [Current limitations](limitations.md).

## Table of contents

### Experiment types

| Experiment                                    | What it answers                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [Control probe](control-probe.md)             | Does a pinned model obey one reviewed pose, depth, or edge fixture at all?                                             |
| [Baseline portrait](baseline-portrait.md)     | What does the production portrait/variant lane do with this instruction and character?                                 |
| [Baseline scene](baseline-scene.md)           | What does the production scene lane do with this instruction and conversation?                                         |
| [Controlled portrait](controlled-portrait.md) | Does a structural control still hold in a production-shaped portrait recipe?                                           |
| [Controlled scene](controlled-scene.md)       | Does a structural control still hold in a production-shaped scene recipe?                                              |
| [Two-character scene](two-character-scene.md) | Can the model keep two named identities distinct, optionally under a structural control?                               |
| [Finishing pass](finishing-pass.md)           | Can identity be improved without changing the rest of an existing lab render?                                          |
| [Staged scene](staged-scene.md)               | Can a selected intimate staging be depicted under the same staging wording and subject description used by production? |

### Control fixtures

| Fixture                           | How it is produced                                            | What it represents   |
| --------------------------------- | ------------------------------------------------------------- | -------------------- |
| [Pose fixture](pose-fixture.md)   | Pinned OpenPose preprocessor or hand-authored upload          | Body/joint layout    |
| [Depth fixture](depth-fixture.md) | Pinned Depth Anything v2 preprocessor or hand-authored upload | Relative scene depth |
| [Edge fixture](edge-fixture.md)   | Local Sharp/Sobel pass or hand-authored upload                | Strong image edges   |

See [Generating and reviewing control fixtures](generating-control-fixtures.md) for the complete fixture workflow.

### Current constraints

- [Current limitations](limitations.md)

## How an experiment moves through the lab

1. An admin creates an experiment. The request records its kind, subject pointers, prompt/instruction, ordered inputs, selected model slug where applicable, and settings.
2. A background job starts the kind-specific runner.
3. The runner re-validates the stored row. Lab evidence is refused before provider spend when required inputs, fixture provenance, subject bindings, capacity, or an exact model version cannot be established.
4. The runner records the exact prompt and, for pinned kinds, the requested provider version before rendering.
5. The result is saved as a hidden `lab_output` image and the experiment settles `succeeded` or `failed`.
6. Experiment kinds with a defined visual question can receive a verdict and required note. Baselines intentionally have no verdict vocabulary.

All experiment kinds dispatch through `apps/web/src/server/images/image-lab-run.ts`. Shared contracts live in `packages/image-core/src/lab/image-lab.ts`; controlled recipe profiles live in `packages/image-core/src/lab/image-lab-recipes.ts`.

## Model/version behavior at a glance

For the model-selecting kinds the create form uses a registry-backed Model picker. `Default` keeps the experiment kind's normal model choice, registered pinnable rows can be selected directly, and `Other` accepts an alternate provider-path spelling. Rows that cannot supply an exact version pin are visible but disabled.

The Model slot does **not** mean the same thing for every experiment kind:

- `control_probe`, controlled experiments, `two_character_scene`, `finishing_pass`, and `staged_scene` resolve the selected/default registered model and require an exact provider version before spending.
- `baseline_portrait` and `baseline_scene` show no picker at all: the Model slot is read-only copy stating that the model resolves from the active production profile when the run starts, and the form sends no model slug. The baseline runner records and executes that profile's model.
- Production baselines do not pin a provider version, because their purpose is to reproduce production model/profile selection rather than controlled evidence against one frozen version.

Baselines therefore do not serve as selected-model smoke tests; a selected-model smoke test is an [Image Generator](../image-generator/README.md) run.

## Control fixture rule

A fixture-sending experiment may only rely on a fixture that is identifiable and reviewed. The lab checks that the declared fixture is a hidden `lab_control` asset of the declared kind, appears exactly once in the experiment's send list under a control role, and has a recorded human review. If the fixture was extracted from an image, that same source image may not also be sent in the experiment: doing so would let the output match the fixture by copying the source instead of proving control obedience.

## Failure records

Lab failures settle onto the experiment instead of throwing away the attempt. Stable lab reasons include missing input, unpinned version, invalid/unreviewed control, control-source contamination, capacity overflow, invalid source experiment, invalid subject binding, an undescribable subject, unavailable identity reference, unsupported settings, invalid preprocessor output, and provider render failure.

That persistence is intentional: a failed experiment is still evidence about why a test could not be run.
