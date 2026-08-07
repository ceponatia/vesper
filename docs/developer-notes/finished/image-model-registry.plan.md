# Image model registry — swappable Replicate models, managed from the app

Status: shipped — 2026-08-05. All five slices landed together, followed the same
day by three corrections found by running the models: per-model reference
transport, a probe that wrongly rejected a model with no field description, and
automatic version pinning for community models. Everything past the smallest
useful model record — task profiles, shared controls, role-aware references,
recorded seeds, safe version promotion — was carried forward to
[image-model-capabilities.plan.md](image-model-capabilities.plan.md), which is
where the remaining work is tracked.

Outcome: The owner can add or swap the image model behind portraits, variants,
and scenes from a settings page, so that trying a different model takes half a
minute instead of a code change, a pull request, and a deploy.

## Why

Every image in Vesper — a character's portrait, a variant of that portrait, a
scene painted from a conversation — came from an image model picked in code.
Changing which model ran meant editing a TypeScript file, opening a pull request,
waiting for CI, and deploying. That was a slow loop for something the owner wants
to try on a whim, and image models turn over fast.

Two things changed at once.

**Venice went away.** Replicate had been tested side by side and was both cheaper
and more accurate for what this app does. Venice was the default provider for
portraits, portrait variants, and scenes; all of that moved to Replicate. Nothing
about Venice was worth keeping behind a flag, so the code came out.

**The model list became data.** Instead of a hardcoded picker, the models the app
can use live in the database, and an admin-only page in settings adds, edits, and
removes them. Pasting a Replicate model path such as
`stability-ai/stable-diffusion-3.5-large`, ticking the surfaces it should appear
in, and saving is the whole flow.

## What the owner gets

**A settings page that manages the model list.** Admin-only, at
`/settings/image-models`. Paste a Replicate model path, tick "portrait studio"
and/or "scene generator", save. The model appears in those pickers immediately.
Rows can be edited or deleted, including the ones the app ships with — the
database is the only source of truth, so there is no second, privileged list
hiding in the code.

**Models that describe themselves.** On save, the app asks Replicate what that
model actually accepts and records the answer: whether it can work from a
reference image, whether it can work without one, what its reference input is
called, whether it takes one image or several, and every shape it offers. A
mistyped model path fails loudly at save time rather than silently at render
time, and the pickers hide models that cannot do the job being asked of them.

**Pickers that only offer what can work.** The scene generator and the New
Variant section both need a model that edits from a reference, so they only list
models that can. Creating a brand-new portrait needs a model that can work from a
written description alone, so that picker lists those. One model in the starting
set — Qwen Image Edit 2511 — can only edit, so it correctly never appears as an
option for a portrait made from nothing.

**A model picker in New Variant.** The portrait studio had one picker, governing
new portraits only; variants silently used the single Venice model that could
edit. Now that several models can edit, that section has its own picker.

## The models we start with

Six, seeded into the database by the registry's own migration so a fresh
deployment comes up with a working list. Full API details for each — and for
several models the owner researched but did not seed — live in
[docs/image-models/](../image-models/).

- **Qwen Image 2512** — the default for a brand-new portrait. Text-to-image,
  with an optional single reference.
- **Qwen Image Edit 2511** — the default for scenes and for variants. The one
  edit-only model in the set: it requires a reference and cannot be used to make
  a portrait from nothing.
- **Seedream 4.5** — takes a list of references; a strong alternative for scenes.
- **Seedream 5 Lite** — verified working in a live trial
  ([seedream-5-lite.trial.md](images/seedream-5-lite.trial.md)). Holds a
  character's face across a scene change. Slower than the default, so it is an
  opt-in pick rather than an everyday one.
- **Stable Diffusion 3.5 Large** — text-to-image. Its reference input is
  strength-based repainting rather than identity-preserving editing, so it is
  offered for portraits, not scenes.
- **Wan 2.7 Image Pro** — takes a list of references. The awkward one: it will
  not accept Replicate's own uploaded-file URLs, and its upstream moderation
  cannot be switched off (see the rough edges below).

## Rough edges absorbed

**Not every model can produce Vesper's shape.** Every image in the app is 3:4.
Most of these models offer 3:4 directly. Stable Diffusion 3.5 Large does not —
its closest option is 4:5 — so the app renders it at 4:5 and centre-crops to 3:4,
losing about six percent of the width. Wan 2.7 Image Pro has no aspect ratio
setting at all and is driven by pixel dimensions instead, so the app picks
dimensions that are already 3:4. Neither is visible to a player. Rather than
branching per model, the app records the full menu of shapes each model offers
and picks the closest one to whatever a lane asked for, which is also how the
same code serves the square item images and the wide location images.

**Replicate does not publish a reference-image limit.** Models that accept a list
of references do not say in machine-readable form how long that list may be, so
the limit is a number stored against each model and editable on the settings
page. The save-time probe reads a starting value out of the field's prose
description when it can ("List of 1-14 images"), and falls back to three.

**One model refuses the way we send reference images.** Every model is handed its
references as a link to a file uploaded to Replicate; Wan 2.7 rejects that
outright, because it reads the image type off the end of the filename and the
link it receives has none — the render fails with "invalid image format" before
the model does any work (owner report 2026-08-05). So how the bytes are sent is a
per-model setting, like the reference limit: upload a link, or paste the image
straight into the request. Only Wan needs the second. Whether a model needs it
cannot be read from its API — it is found by running the model — so the setting
is remembered on the row and never overwritten by re-probing.

Wan has a second problem that this does not fix: it moderates prompts and
reference images upstream, with no way to turn that off, and refused an ordinary
character reference during testing. It works, but expect it to say no often.

**Most Replicate models cannot be run by name.** Found after shipping, when three
newly added models saved cleanly and then failed every render with a bare "not
found". The endpoint that runs a model by name only serves Replicate's own
official models; everything else must be run by exact version. So adding a
community model now pins it to the version the probe read, automatically and
without the owner having to know the distinction.

## Also in this change: three scene-picker bugs

Found while investigating a report that switching the scene model failed with a
message about something still being in progress when nothing was
([diagnosis](image-model-registry.spec.md#scene-picker-busy-bugs)). All three were
small and sat in the code this work already touched.

- The scene model dropdown stayed clickable while a reply was streaming, even
  though the save behind it was guaranteed to be rejected during that window. It
  is now disabled, the way the composer already is.
- When that save was rejected, the dropdown kept showing the model the owner
  picked while the server kept the old one — and the next render used the
  server's value. A failed save now puts the dropdown back.
- The rejection message always blamed a streaming reply, even when a world
  command was the actual cause. It now names the real one, which the sibling
  world routes already did.

The underlying reason the window exists at all — the exchange lock being held
through the whole settle tail — is tracked as **B14** in
[chat-reply-latency.plan.md](chat-reply-latency.plan.md) and was not re-solved
here.

## Delivery slices

All shipped 2026-08-05.

1. **Registry foundation** — the database table, the migration, the seed of six
   models, and the contract that describes a model record.
2. **Replicate client generalization** — run any model in the registry, mapping
   references onto whatever that model calls its reference input, and handling
   the shape and output-format differences per model.
3. **Venice removal** — the provider deleted and portraits, variants, and scenes
   rerouted to the registry.
4. **Admin surface** — the API routes and the settings page, including the
   save-time capability probe.
5. **Pickers** — registry-driven pickers in the portrait studio (both sections)
   and the scene strip, plus the three bug fixes.

## Success criteria

All met at ship.

- An admin can add a Replicate model from the settings page and use it in the
  next render without a deploy.
- A mistyped model path is rejected at save time with a message naming the
  problem.
- A model that cannot edit never appears in the scene generator or New Variant.
- Portraits, variants, and scenes all render through Replicate with no Venice
  code left in the repository.
- Every image still comes out 3:4 regardless of which model produced it.

## Open questions

None. The four decisions this plan rested on were ruled by the owner on
2026-08-05 and are recorded in
[image-model-registry.spec.md](image-model-registry.spec.md) under "Owner
rulings".
