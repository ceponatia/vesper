# Render intents

**A render is described as an intent, not as a model call.** A lane supplies its resolved
profile, its prompt, a target ratio, and references that carry a **role** — `identity`,
`location`, `style`, `object`, the neutral `reference` role the Image Generator's primaries
carry, and the structural control roles — instead of an anonymous buffer list where a reference's
meaning was its position.

Planning is pure and happens before any bytes leave the process, and it decides which references
survive, in what order, and on which provider field (`planIntentReferences`).

## The workspace split

The path is split across the workspace boundary at exactly that line. Planning and profile
compilation are `@vesper/image-core` (`planImageRender`, `compileProfileRenderPlan`): no
database, no provider, no environment.

The application half (`server/images/render-intent.ts`) resolves the LoRA binding against the
library, resolves the deployment facts the planner may not read — today just whether the
provider's safety checker is bypassed — reports the diagnostics below, and calls the transport.

A lane renders through `renderImageIntent` and never touches the planner directly. The Advanced
Image Lab is the one exception, because it needs the compiled prompt before it renders. The
[Image Generator](../../image-generator/README.md) renders through `renderImageIntent` too, with
a synthetic per-run profile and an explicit version pin — it is the consumer the `providerInputs`
descriptors and the dedicated-input bindings exist to drive.

## Which references survive is the profile's policy

Selection sorts required references ahead of optional ones, then by the profile's `roleOrder`,
then by a caller's numeric `priority`, then by the order the lane supplied them — and truncates
at `referenceCapacity`.

A role outside `allowedRoles` is dropped before the contest (an empty `allowedRoles` declares no
allowlist, and a `requiredRoles` entry is allowed implicitly); `maxPerRole` caps each role. Every
dropped reference carries the reason it went — `role_not_allowed`, `role_cap`, or
`model_capacity` — and they read out in caller order under `image_profile.references_trimmed`. An
empty policy is a no-op, which is what keeps the seeded profiles' payloads unchanged.

`requiredRoles` are checked against everything that will actually be SENT — the primary array and
the dedicated control fields alike — and refuse the render with
`image_profile.required_reference_missing` if any is absent.

A reference the CALLER marked `required: true` refuses one layer finer: if selection drops it for
any reason, the plan refuses with `image_profile.required_reference_dropped`, naming each dropped
role and reason. The role gate is a set, so it alone cannot tell "an identity reference survived"
from "the second of two required identities was trimmed". Only optional references are trimmed
and reported.

Per-render controls merge over the profile's stored defaults, and the profile's prompt strategy
compiles the final text. A strategy this path has no wording for refuses with
`image_profile.prompt_strategy_unsupported` rather than sending a lesser one.

## A structural control is routed by its binding, not by its position

A control role (`mask` · `pose` · `depth` · `edge` · `control`) is checked against the active
version's `additionalImageInputs` — probe-derived per the alias table in
[registry.md](registry.md), so a row gains its dedicated bindings at probe or re-probe time.

- A version that declares its own field for the role gets the image on that field, where it does
  **not** spend a primary reference slot.
- A version that declares none takes the control as an ordinary numbered image in the primary
  array, which is how Qwen Image Edit 2511 accepts pose and depth maps.
- A binding naming the primary reference field is read as the numbered array rather than as a
  second field.
- A binding naming any reserved field is refused with `image_model.control_field_reserved`.

A dedicated field's declared arity and `maxItems` cap what it takes; the surplus drops as
`role_cap`.

A version may also declare a control input it **requires**. A render with nothing to bind to that
field is refused with `image_profile.required_control_input_missing` before transport, rather than
buying a provider rejection at full latency.

## Prompt strategies add nothing the lane already said

The two production prompt strategies add **nothing** to the lane's own text: a character lane's
compiled program already names its references, so a second set of numbered bindings would
describe the same images twice.

`multi_reference_compose` is the exception and the point of the strategy — it prefixes a numbered
`Image N:` binding per reference from one reference upward, in send order, naming each role's
purpose, and adds a closing clause whenever a structural control is present telling the model to
follow the control and never render it. The identity-pack vocabulary compiles its own separate
numbered preamble for the identity trial. No character lane runs it: the Image Lab's staged
bench, which compiles the chat scene's own program, runs `instruction_edit` for exactly that
reason.

`image_profile.references_renumbered` reports when selection moves a slot under a prompt that
was written before planning — measured as slot equality, so removing the second of three
references (dropped, disallowed, or routed to a dedicated field) counts, while trimming from the
tail does not. No application module authors a reference-slot label of its own
(`scripts/image-reference-numbering.test.ts` keeps that census empty), so no lane triggers it.

A character-image prompt is numbered from the prompt program's own reference plan rather than
from a list written before planning, so its slots agree with the payload by construction, the
lane sends the planned list, and the seam refuses (`image_prompt_program.references_renumbered`)
if planning ever moves one ([../character-prompts.md](../character-prompts.md)).

An intent carries **one** prompt channel, `prompt` — the lane's text before the profile's prompt
strategy compiles it. A character render sends its compiled program's positive text there,
already fitted to the model's probed prompt binding inside the compile
(`imagePromptBudgetFromBinding`), and its compiled exclusions as the normalized
`controls.negativePrompt`; there is no second prompt channel for the two to disagree with.

## Two things the intent deliberately does not send

It does **not** pin a provider version: an ordinary render follows whatever the model slug
resolves to (a pinned slug pins production; a bare slug floats), while a controlled comparison
pins explicitly — the identity trial, the Image Lab's pinning kinds, and every Image Generator run
do.

And it does **not** force a prediction budget: a profile's own `timeoutMs` is used when it
declares one (no seeded profile does), and otherwise `REPLICATE_PREDICTION_TIMEOUT_MS` decides
([transport.md](transport.md)).

## Seeds and the render record

**Seeds are resolved app-side and recorded, never drawn in the pure planner.** An explicit
`controls.seed` always wins; otherwise a `random`-policy profile draws a uniform integer inside
the active version's probed seed binding — only when that binding exists (an unseeded run stays
honestly unseeded), and never on a render carrying an explicit version pin, whose schema the
active bindings do not describe.

Every generating lane then records the attempt under `images.meta.render` — model, profile, task,
prompt strategy, resolved seed, applied and dropped controls, the reference roles actually sent
(truncated to what the byte budget let through), the prediction id, and the version the provider
says it executed — on failures too where the lane's failure shape returns rather than throws. That
record is what a retry of the same composition reads. The character-fact lanes file a second,
sibling provenance key beside it — `images.meta.visualState`, the visual-digest record
([../pipelines/README.md](../pipelines/README.md)).

## Selection stays fail-visible

`routeSceneAttempts` (`packages/image-core/src/provider-interface/attempts.ts`) orders one model's
degradation ladder — multi-reference edit → single-reference edit, with a bare-prompt generate
rung only when no usable reference exists **and** the model can generate.

A render never hops to a *different* model, so a failure stays visible and retryable rather than
silently painting a different-looking person (owner ruling 2026-07-29). An edit-only model with no
reference yields an empty chain and a visible refusal. The `replicate/<slug>` actually used is
recorded on `images.meta.model`.
