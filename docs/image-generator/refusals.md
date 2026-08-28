# Refusals

## All-or-nothing inputs

Vesper's production lanes may drop a reference that will not fit — a scene missing its third image
still beats no scene. A Generator run may not: a render that sent four of five explicitly selected
images is a different experiment wearing the same run id.

So a Generator run travels under the strict arm of the shared render policy
([../images/providers/transport.md](../images/providers/transport.md) §Send strictness):

- **`references: "require_all"`** — if the model's reference capacity or the inline byte budget
  would leave any selected reference behind, the transport refuses **before creating a prediction**.
  The run settles `capacity_exceeded` naming each unsent reference and its reason, reports nothing
  to provider health, and produces no output.
- **`providerInputs: "strict"`** — the finished payload is held against the version's probed
  descriptors immediately before the provider call: required fields must be present unless the
  schema declares a default of its own, and declared type, integer-ness, enum membership and range
  must hold. Fields whose declared shape is an address, a list, or something the probe could not
  read are refused unless a typed transport owns them, so an admin API caller cannot reach a URI
  input by typing a string — the owner-scoped picker is the only path to an image.

Both checks live in `@vesper/image-replicate` beside the payload rules they enforce; the Generator
asks for the policy and never restates the rules.

## Fail closed before spend

A value that cannot be honored is refused, never silently trimmed — a silently adjusted request
would make every comparison built on it dishonest.

Every refusal settles on the run row as a stable code in the `image_generator.*` namespace;
refusals owned by the shared planner or LoRA layers (`image_profile.*`, `image_lora.*`) land
verbatim. Everything except the last two codes below is checked before the provider is paid.

| Code                      | Meaning                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `model_missing`           | the stored slug no longer resolves in the registry               |
| `version_unpinned`        | no exact provider version resolvable before spend                |
| `operation_unsupported`   | prompt-only on a no-generate model; references on a no-edit one  |
| `input_missing`           | a selected image id is unreadable or its bytes are gone          |
| `capacity_exceeded`       | selected references exceed capacity or the inline byte budget    |
| `dedicated_input_unbound` | a structural role with no dedicated capability binding           |
| `prompt_required`         | the prompt is empty and this version requires one                |
| `control_refused`         | a control or shape this version cannot send; seed beside a count |
| `provider_input_rejected` | an unknown, reserved, unsupported, or invalid provider value     |
| `version_replay_unsafe`   | a captured version cannot be replayed against trusted facts      |
| `render_failed`           | provider execution failed                                        |
| `output_store_failed`     | the provider succeeded; local persistence did not                |

`render_failed` and `output_store_failed` stay distinct so provider health is never charged for a
local disk problem; pre-spend refusals report no provider outcome at all. The runner never throws
through the job — every stop is a settled row carrying its reason, per
[../resilience.md](../resilience.md).
