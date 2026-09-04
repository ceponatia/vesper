# The create form

The create form derives everything past the prompt from the selected model's probed capability
record, never from its slug
([../images/providers/registry.md](../images/providers/registry.md)). Registering a new model
changes this form through its capability record alone, with no code edit.

Everything starts unset: the provider's own defaults rule until the admin explicitly sets a value.

## What the capability record decides

- **Primary references** appear only on a model that can edit. They enter the planner in caller
  order under the neutral `reference` role; an optional per-reference **purpose** is recorded
  provenance only and never changes routing. Explicit primaries are capped at 6 app-side, further
  bounded by the model's own reference capacity.
- **Dedicated structural inputs** (pose / depth / edge / mask / control) appear only for the roles
  the version's probed `additionalImageInputs` bind to their own provider fields. An explicitly
  dedicated selection never falls back to the numbered reference array.
- **Normalized controls** (seed, negative prompt, guidance, steps, edit strength, thinking mode,
  fast mode, resolution tier, custom dimensions, LoRA) are editable only where the active version
  binds a field for them. The image-set controls — `coherentSet`, `outputCount`, `sequentialMode` —
  stay deliberately absent, and the server refuses any that arrive: they are **provider** inputs
  asking one prediction to return a set, no registered version declares one, and the bench's own
  image count is a different request ([runs.md](runs.md) §Several images from one request).
- **The LoRA picker** offers every enabled library row, and pre-fills one case: selecting
  `qwen/qwen-image-edit-2511` fills in the curated "Qwen Image Edit 2511 NSFW all inclusive
  v2.0" row once, because the Generator mirrors the production intimate pairing so an operator
  reproducing the route does not re-pick the row. It is a default, not a lock — the select stays
  free to change or clear, a manual clear survives, leaving and returning re-arms it, and a
  duplicated run carries whatever its source recorded, including a deliberate none. The pairing is a
  named UI preference rather than a derived one: the row's `compatibleModelSlugs` names both Qwen
  edit endpoints, so "the only compatible row" would arm the default on the 2509 legacy comparison
  endpoint too.
- **Advanced model inputs** render from the probed `providerInputs` descriptors: non-reserved fields
  of a type the bag can express become typed inputs, while reserved fields — owned by the prompt,
  reference, aspect, control and dedicated plumbing — are listed but not editable. A model
  registered before descriptors existed has none, so it offers no advanced inputs at all and the
  server refuses any sent directly to the API; a re-probe restores them.
- **The prompt** is required only where the version's probed prompt descriptor says so. On a model
  whose schema does not require it, an empty prompt sends no prompt field at all rather than an
  empty string.
- **Images per run** is the one control that is *not* capability-driven — it is the bench's loop
  count, so it appears on every model. The form holds the Run button when a seed is set beside a
  count above one; the runner refuses the same pair pre-spend, because an API caller never passes
  through the form.

## Fast mode is three-state

Unlike every other boolean here, fast mode has three positions: leave it alone, ask for the
endpoint's accelerated sampling path, or refuse it. The wrappers that expose it turn it on
themselves, so "off" is a request rather than silence — and blank stands down to whatever the model
already runs with, which on a reviewed model is Vesper's correction rather than the provider's own
preference.

It is also the one control that may deliberately contradict a reviewed production ruling: an admin
can ask `qwen/qwen-image-edit-2511` for the accelerated path every production lane refuses
([its model page](../image-models/models/qwen-image-edit-2511.md) owns that ruling), because a bench
whose controls only ever agreed with production could not investigate the setting it exists to
question. Production is untouched — the reviewed policy carries `go_fast` as a provider override,
and overrides merge last.

## A bound control is not a promise the endpoint acts on it

A binding is a mechanical fact about what an input is called, and the form offers every control the
active version declares.

`qwen/qwen-image-2512` declares a negative-prompt field and ignores it entirely
([its model page](../image-models/models/qwen-image-2512.md) owns the measurement), so its box
carries a hint saying so rather than being withheld — a withheld control would bury a reviewed
judgment inside a probe record, where the next re-probe would silently undo it.

A dedicated structural input does **not** by itself make a request an edit. A model that generates
from a prompt while taking a required `pose_image` is still generating, and only a model that cannot
generate at all reads its structural image as the thing being edited — which is why such a model can
be run here without a primary reference binding at all.

## Output shape: the model's own by default

Every player-facing image lane asks the render path for Vesper's 3:4 portrait target, picks the
nearest shape the model offers, and centre-crops whatever comes back to reach it. The Generator does
not. A bench that reshaped a model's answer would be reporting Vesper's opinion as the model's, so a
Generator run asks for **no shape at all** by default: no `aspect_ratio` or `size` key is written
into the payload, no provider bucket is chosen for being nearest a target the admin never named, and
the returned image is stored uncropped at whatever size the model produced.

Choosing an **Output shape** switches the run to that member of the version's own declared list,
filtered to the members the shared shape mapper actually resolves back to. It travels as a ratio
through the same shape mapper every lane uses, so the value that reaches the provider is the member
that was picked — and when a version declares several members at one ratio and the mapper would
resolve to a different one, the run refuses rather than substituting it. On a version whose shape
list IS its size list, the shape select replaces the resolution tier outright, because there the two
are one provider input.

The distinction is an explicit policy on the shared render request
(`ImageRenderTarget.aspectRatio`, where `null` means the model's own —
[../images/providers/shape.md](../images/providers/shape.md)), not a Generator fork of the payload
builder. Production lanes are unchanged.

## The effective-request summary

A summary above the Run button states the resolved operation, version pin, references, shape,
controls, and advanced values. The summary and the POST assemble from the same state, so they cannot
disagree.

## Sources: the general owned-image picker

`GET /api/admin/self/owned-images` lists the requesting admin's own `ready` images — every kind
except the two system-bookkeeping ones (`identity_face_crop`, `identity_trial_output`) — as ids plus
display metadata; bytes stay behind the authorized image file route.

The shared picker component renders it with a kind filter and cursor paging, and feeds both the
Generator's inputs and the Image Lab's generic roles: fixture extraction sources, the controlled
portrait's optional object reference, and the staged scene's optional location reference.
