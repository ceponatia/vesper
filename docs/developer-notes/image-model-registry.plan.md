# Image model registry — swappable Replicate models, managed from the app

Status: active (started 2026-08-05)

## Why

Every image in Vesper — a character's portrait, a variant of that portrait, a
scene painted from a conversation — comes from an image model we picked in code.
Changing which model runs has meant editing a TypeScript file, opening a pull
request, waiting for CI, and deploying. That is a slow loop for something the
owner wants to try on a whim, and image models turn over fast.

Two things are changing at once.

**Venice is going away.** Replicate has been tested side by side and is both
cheaper and more accurate for what this app does. Venice was the default
provider for portraits, portrait variants, and scenes; all of that moves to
Replicate. Nothing about Venice is worth keeping behind a flag — the code comes
out.

**The model list becomes data.** Instead of a hardcoded picker, the models the
app can use live in the database, and an admin-only page in settings adds,
edits, and removes them. Pasting a Replicate model path such as
`stability-ai/stable-diffusion-3.5-large`, ticking the surfaces it should appear
in, and saving is the whole flow. Swapping a model becomes a thirty-second task
instead of a deploy.

## What the owner gets

**A settings page that manages the model list.** Admin-only. Paste a Replicate
model path, tick "portrait studio" and/or "scene generator", save. The model
appears in those pickers immediately. Rows can be edited or deleted, including
the ones the app ships with — the database is the only source of truth, so there
is no second, privileged list hiding in the code.

**Models that describe themselves.** On save, the app asks Replicate what that
model actually accepts and records the answer: whether it can work from a
reference image, whether it can work without one, what its reference input is
called, and whether it takes one image or several. That means a mistyped model
path fails loudly at save time rather than silently at render time, and the
pickers can hide models that cannot do the job being asked of them.

**Pickers that only offer what can work.** The scene generator and the New
Variant section both need a model that edits from a reference, so they only list
models that can. Creating a brand-new portrait needs a model that can work from
a written description alone, so that picker lists those. One model in the
starting set — Qwen Image Edit 2511 — can only edit, so it correctly never
appears as an option for a portrait made from nothing.

**A model picker in New Variant.** The portrait studio has had one picker,
governing new portraits only; variants silently used the single Venice model
that could edit. Now that several models can edit, that section gets its own
picker.

## The models we start with

Six, seeded into the database so the page has something to manage on day one.
Full API details for each live in [docs/image-models/](../image-models/).

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
  cannot be switched off (see the third rough edge below).

## Three rough edges we absorb

**Not every model can produce Vesper's shape.** Every image in the app is 3:4.
Most of these models offer 3:4 directly. Stable Diffusion 3.5 Large does not —
its closest option is 4:5 — so the app renders it at 4:5 and centre-crops to
3:4, losing about six percent of the width. Wan 2.7 Image Pro has no aspect
ratio setting at all and is driven by pixel dimensions instead, so the app picks
dimensions that are already 3:4. Neither of these is visible to a player; both
have to be handled per model rather than by one shared setting.

**Replicate does not publish a reference-image limit.** Models that accept a
list of references do not say how long that list may be. So the limit is a
number stored against each model and editable on the settings page, seeded from
what we know, rather than something the app can discover. The scaffold that
answers "how many references does this model support?" reads that stored number.

**One model refuses the way we send reference images.** Every model is handed
its references as a link to a file we upload to Replicate; Wan 2.7 rejects that
outright, because it reads the image type off the end of the filename and the
link it receives has none — the render fails with "invalid image format" before
the model does any work (owner report 2026-08-05). So how the bytes are sent
becomes a per-model setting, like the reference limit: upload a link, or paste
the image straight into the request. Only Wan needs the second. Whether a model
needs it cannot be read from its API — it is found by running the model — so the
setting is remembered on the row and never overwritten by re-probing.

Wan has a second problem that this does not fix: it moderates prompts and
reference images upstream, with no way to turn that off, and refused an ordinary
character reference during testing. It works now, but expect it to say no often.

## Also in this change: three scene-picker bugs

Found while investigating a report that switching the scene model failed with a
message about something still being in progress when nothing was
([diagnosis](image-model-registry.spec.md#scene-picker-busy-bugs)). All three are
small and sit in the code this work already touches.

- The scene model dropdown stays clickable while a reply is streaming, even
  though the save behind it is guaranteed to be rejected during that window. It
  gets disabled, the way the composer already is.
- When that save is rejected, the dropdown keeps showing the model the owner
  picked while the server keeps the old one — and the next render uses the
  server's value. The failed save now puts the dropdown back.
- The rejection message always blames a streaming reply, even when a world
  command is the actual cause. It now names the real one, which the sibling
  world routes already do.

The underlying reason the window exists at all — the exchange lock being held
through the whole settle tail — is already tracked as **B14** in
[chat-reply-latency.plan.md](chat-reply-latency.plan.md) and is not re-solved
here.

## Delivery slices

1. **Registry foundation** — the database table, the migration, the seed of six
   models, and the contract that describes a model record.
2. **Replicate client generalization** — run any model in the registry, mapping
   references onto whatever that model calls its reference input, and handling
   the aspect-ratio and output-format differences per model.
3. **Venice removal** — delete the provider and reroute portraits, variants, and
   scenes to the registry.
4. **Admin surface** — the API routes and the settings page, including the
   save-time capability probe.
5. **Pickers** — registry-driven pickers in the portrait studio (both sections)
   and the scene strip, plus the three bug fixes.

## Success criteria

- An admin can add a Replicate model from the settings page and use it in the
  next render without a deploy.
- A mistyped model path is rejected at save time with a message naming the
  problem.
- A model that cannot edit never appears in the scene generator or New Variant.
- Portraits, variants, and scenes all render through Replicate with no Venice
  code left in the repository.
- Every image still comes out 3:4 regardless of which model produced it.

## Open questions

None currently. The four decisions this plan rested on were ruled by the owner
on 2026-08-05 and are recorded in
[image-model-registry.spec.md](image-model-registry.spec.md) under "Owner
rulings".
