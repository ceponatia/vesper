# Image Generator

The Image Generator is Vesper's admin-only raw prompt-and-model bench at
`/settings/image-generator`, reached from the account dropdown in the global header rather than
from the Settings page ([../ui/pages.md](../ui/pages.md)).

It runs any registered image model with an admin-authored whole prompt, optional reference images,
dedicated structural inputs, normalized controls, and raw provider values — and keeps a durable
per-attempt record: what was asked for, what was actually sent, which exact provider version ran,
and what came back or why nothing did.

## Reading order

| Doc                        | What it covers                                                                 |
| -------------------------- | ------------------------------------------------------------------------------ |
| [runs.md](runs.md)         | The immutable run row, the multi-image fan-out, outputs, provenance, duplicate |
| [form.md](form.md)         | The capability-driven create form, output shape, and the owned-image picker    |
| [refusals.md](refusals.md) | All-or-nothing inputs and the fail-closed-before-spend refusal codes           |
| [api.md](api.md)           | Routes, the job seam, and the code map                                         |

## The boundary against the Advanced Image Lab

The Generator and the [Advanced Image Lab](../image-lab/README.md) are two separate benches on one
shared stack:

- **The Generator is freeform provider exploration.** The admin picks the model explicitly, authors
  the entire positive prompt, and no evidence rule constrains the request. The record is provenance
  — this exact request produced this image — with no verdict vocabulary.
- **The Lab is structured evidence.** Every experiment kind owns a defined question, subject
  bindings, fixture-review rules, and, where defined, a human verdict. Raw prompt and model testing
  is deliberately not a Lab experiment kind, and no Lab evidence rule is relaxed to accommodate it.

Neither surface imports the other: the Generator never touches a Lab contract, runner, or recipe,
and the Lab never reads a Generator run. Both share the model registry and its probed capability
records ([../images/providers/README.md](../images/providers/README.md)), the pure render planner
reached through `renderImageIntent`, the curated LoRA library, the job and provider-health
machinery, and the owner-scoped byte readers (`apps/web/src/server/images/owned-image-reads.ts`) —
and nothing else.

## Related

- [../image-lab/README.md](../image-lab/README.md) — the structured-evidence bench beside this one.
- [../images/providers/README.md](../images/providers/README.md) — the registry, the capability
  probe that drives this form, render intents, and transport.
- [../images/asset-registry.md](../images/asset-registry.md) — hidden-kind policy and the asset
  lifecycle `generator_output` rides.
