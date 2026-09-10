# The model registry

A row in `image_models` is what the render path needs to call one Replicate model. Per-model
API reference lives in [../../image-models/README.md](../../image-models/README.md); the row is
the runtime truth.

## What a row carries

Replicate models disagree with each other in ways no shared mapping can paper over. The
reference input is `image` on one model, `image_input` on another, `images` on a third,
`reference_image` on a fourth — and both Qwen models call it `image` with *different* arities.
So a row stores `referenceField` + `referenceArity`, `maxReferences`, `aspectMode` +
`supportedAspects`, `outputFormat`, and free-form `extraInput` constants.

Two mechanical capability booleans feed the rest of the system: `canGenerate` (can run from a
bare prompt) and `canEdit` (has a reference input at all). They are **not sufficient picker
gates by themselves**: player-facing choices are task profiles filtered through reviewed
eligibility and legacy surface switches ([profiles.md](profiles.md)), while the admin
[Image Generator](../../image-generator/README.md) is capability-driven directly from the
selected row's active probe.

`updated_at` is a **column with no contract field**: the record crosses to the client as JSON,
so adding a timestamp forces a date-serialization decision no consumer needs until the admin
version card shows "capabilities changed at".

## Capabilities are probed, not typed by hand

`probeReplicateModel` (`packages/image-replicate/src/probe.ts`, reached through the configured
client) reads the model's published OpenAPI input schema on save and derives all of the above.
`canGenerate` is false exactly when the reference field is in the schema's `required` list —
which is what keeps `qwen/qwen-image-edit-2511` out of the new-portrait picker without anyone
flagging it.

**This is the one place in the image path that fails loudly instead of degrading:** a bad slug
is a rejected save, because a half-known row would move the failure to render time where it
costs a player-visible image instead of a form error.

The one thing the probe cannot derive is `maxReferences` — no model declares `maxItems` on its
array input, the caps are stated in prose — so it is stored per row and editable on the settings
page.

## Which input is the reference is a priority order

A schema can declare several URI-typed inputs, and they are not interchangeable: a *control*
image (a depth map, a pose skeleton, a mask) looks identical to an identity reference in the
schema. So the probe checks the identity names first (`image`, `image_input`, `images`,
`reference_image`, `face_image`), then anything else URI-typed, and the control names **last** —
the keys of the dedicated-input alias table (`depth_image`, `pose_image`, `mask`, `mask_image`,
`control_image`, `edge_image`, `canny_image`), one list so the two cannot drift.

`nsfw-api/sdxl-pulid` is why: it declares `depth_image` before `reference_image`, and plain
property order resolved its reference field to the depth input — which would have fed a
character's portrait to a depth converter and rendered a silhouette-shaped stranger, with
nothing in the payload looking wrong. Control names are deprioritized rather than excluded, so a
model whose only image input is a control image still registers as edit-capable.

## Two kinds of capability, and only one is probed

Everything above is read from the schema. The facts that decide whether a model *should* do a
job cannot be: `canEdit` is true for anything with an image input, which lumps
`qwen/qwen-image-edit-2511` (follows an instruction and keeps the face) in with
`stability-ai/stable-diffusion-3.5-large` (strength repainting that hands back a plausible
stranger).

Three **reviewed** columns carry that human judgment:

- `editKind` — `none` · `instruction_edit` · `multi_reference_compose` · `identity_conditioned`
  · `img2img` · `unknown`;
- `identityPreservation` — `strong` · `moderate` · `weak` · `unknown`; and
- `operatorWarning` — free text the admin card edits and the profile pickers show as helper text
  before use.

**A re-probe must never overwrite them**, because no schema can tell you whether a face
survived. `unknown` is the column default and is deliberately **permissive**: an operator-added
experimental row keeps behaving exactly as it does today instead of being locked out by a rating
nobody has written.

`supportedAspects` and `maxReferences` are owner-curated on the same terms once a row exists.
The probe writes both at **create**, but a re-probe and a version activation leave them alone
(`imageModelReprobeFields`), because the stored list can deliberately exclude entries the schema
offers — Wan's 4K size pairs break its edit path, so resurrecting them from the schema would
break every Wan edit. The admin PATCH accepts `supportedAspects` for deliberate updates, and the
version diff labels both fields "owner-curated".

## Probe-owned columns

Two further columns are **probe-owned** — the admin PATCH cannot set either:

- **`probedVersionId`** — the exact version the stored bindings were read from. For a pinned
  `owner/name:version` slug it must equal the pin.
- **`advancedCapabilities`** — optional control bindings (seed, guidance, steps, edit strength,
  output count, thinking mode, fast mode, LoRA…), plus extra image inputs, output arity, and the
  `knownInputFields` allowlist a profile's raw overrides are validated against.

The probe derives the full known-alias binding set — seed, negative prompt, guidance
(`guidance`/`guidance_scale`/`cfg`), steps (`num_inference_steps`), edit strength
(`strength`/`prompt_strength`), output count (`num_outputs`/`max_images`), thinking mode, fast
mode (`go_fast`), sequential/set modes, a tier-like `size` enum as `resolutionTier`, integer
`width`/`height` as custom dimensions, and the two LoRA fields — types, ranges and enum values
included, plus `knownInputFields` as the sorted list of every input property, all written
atomically beside `probedVersionId` at create and re-probe.

**An alias list is a claim that two spellings mean the same quantity**, which is why
`true_cfg_scale` is deliberately not a fourth guidance alias: on a CFG-distilled checkpoint the
embedded `guidance_scale` sits near 1 while real classifier-free guidance runs several times
higher, so one normalized name over both would leave a run record unable to say which knob
moved. A model that publishes it earns its own slot and its own reviewed decision.

The same pass derives **`additionalImageInputs`** — dedicated structural image slots — from a
conservative alias table (`depth_image`→depth, `pose_image`→pose, `mask`/`mask_image`→mask,
`control_image`→control, `edge_image`/`canny_image`→edge): only an alias-named, URI-typed field
that is not the primary reference field becomes a binding, and an unknown URI field is never
classified heuristically — no alias, no entry.

It also records one **`providerInputs`** descriptor per declared input field: type, required,
default, enum values, numeric range, description capped at 500 characters, and a `reserved` flag
marking every field the render path already owns (prompt, primary reference, the aspect key,
`version`, the safety toggle, control-bound, dedicated-input, and `extraInput` fields).
Descriptors are metadata — the [Image Generator](../../image-generator/README.md)'s
advanced-input form renders them — never a second control system.

**The prompt binding's LENGTHS are owner-curated; the probe does not write them.** The derivation
writes no `prompt` member at all, because a JSON schema states that a `prompt` field exists and
what type it is, never how long a prompt the model answers well to — that guidance is published
prose about a model family. So the binding's two lengths are curated data on the row: `maxChars`,
a provider ceiling whose breach is an error and the only limit allowed to compress a mandatory
segment, and `recommendedChars`, the advisory length optional material is trimmed toward.
**A re-probe or a version activation replaces `advancedCapabilities` wholesale and drops them**,
because `imageModelReprobeFields` protects the two owner-curated columns above and not a member
inside a probe-owned record; a row whose budget matters is curated again after a re-pin.

A row probed before any of this holds `{}`, and empty means "send no optional control" — so a
profile's control defaults sit recorded-but-inert until its model's version is probed or pinned,
which is the designed activation path. An absent prompt budget means no fitting: every optional
claim is emitted, in canonical order.

## Version promotion

**Versions are promoted through an explicit candidate flow, never by drift.** Three owner-admin
actions on the model card (`/settings/image-models`):

- **`probe-latest`** probes the bare model path and returns the candidate version, a field-level
  capability diff (owner-curated fields labeled as review-only, with per-entry `controls.*`,
  `additionalImageInputs.*`, and `providerInputs.*` sections), and per-profile findings, without
  mutating anything.
- **`smoke-test`** runs one transient render pinned to the candidate through a chosen profile.
  An edit profile gets a locally generated neutral reference, nothing is persisted, and the
  action is explicitly cost-bearing.
- **`activate-version`** re-probes that exact version — falling back to the bare probe plus a
  latest-id equality check for official models, which expose no per-version endpoint — refuses
  with the blocking findings when an enabled profile would break (an impossible operation, a
  provider override outside the candidate's `knownInputFields`, a LoRA profile losing its
  bindings), and otherwise atomically pins the slug to `owner/name:version` and swaps in the
  candidate's probed capabilities.

A re-probe of a pinned row probes only its pin and never moves it to latest. Ordinary renders
follow whatever the slug resolves to, so pinning the slug is what pins production.

**Replicate latest and Vesper active are different facts.** An official wrapper may change
underneath a bare slug. Production behavior comes from the model row's active slug or pin and
its stored probe. Version-specific provider API snapshots and drift belong on that model's page
in [../../image-models/models/README.md](../../image-models/models/README.md), not here. Never
debug a historical render from the provider's current playground schema alone.
