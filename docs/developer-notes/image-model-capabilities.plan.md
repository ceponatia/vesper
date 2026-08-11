# Image model capabilities — profiles, shared controls, and richer workflows

Status: active. Slice 1 shipped 2026-08-05 (reviewed capability ratings, the
profile table, 17 built-in profiles, and the resolver). Slice 2 shipped
2026-08-07: every player render now resolves a profile and goes through the
shared render intent, with payloads unchanged. Slices 3 and 9 shipped their
selection and control-binding halves and slice 6 shipped the LoRA library, all
2026-08-11; slices 4–5, 7–8 and the transport half of slice 3 remain.

Outcome: The owner can pick a named, curated setup for each image model — a quick
portrait, a 4K location, a scene that keeps the same character — so that one
model can do several different jobs well without a code change.

Content/tuning companion:
[image-render-quality.plan.md](image-render-quality.plan.md) — per-model prompt
dialects, negative-prompt banks, face-fidelity work, and trial protocol ride on
this plan's profile/control machinery (its first slices ran ahead of it).

Technical companion: [image-model-capabilities.spec.md](image-model-capabilities.spec.md)
— in progress, and the owner of slice-by-slice implementation status for this
topic. Read its §"Implementation status" for what is built; this plan says what
the slices are for.

This is a follow-up to the shipped
[image model registry](finished/image-model-registry.plan.md). The registry solved the
first problem: image models are now data, Replicate is the only provider, and a
model can describe enough of its API for Vesper to call it safely. This plan
solves the next problem: the six models do not merely accept different field
names. They are good at different kinds of work and expose controls that Vesper
currently ignores.

## Why this work is needed

The registry deliberately models the smallest useful common surface. It knows
whether a model can generate from text, whether it accepts reference images, how
many references it can take, how those references must travel, and how to ask for
the right shape. That is a strong foundation and should remain.

It is not yet enough to use the models well.

The registry describes every reference-capable model as able to "edit." In
practice, that word covers several very different operations. Qwen Image Edit
2511 follows editing instructions and is intended to preserve the subject.
Seedream can combine many examples into a new composition. Qwen Image 2512 and
Stable Diffusion 3.5 Large use strength-based image-to-image repainting, which
can replace the person Vesper was trying to preserve. Those operations should not
be treated as interchangeable just because all of them accept an image input.

The same model can also need different settings for different jobs. Wan 2.7 can
use thinking mode and very high resolutions for text-to-image work, while its
edit path has different limits and requires inlined references. Seedream 4.5 may
be an everyday 2K scene model in one context and a slower 4K location model in
another. One bag of permanent per-model constants cannot express those
differences cleanly.

Finally, several useful features are currently left unused: deterministic seeds,
negative prompts, quality controls, edit strength, multi-image composition,
coherent image sets, multiple outputs, and Qwen-compatible LoRAs. Adding each
feature directly to each lane would produce a collection of special-purpose
harnesses that all upload images, map settings, poll Replicate, download output,
and normalize files in slightly different ways. This plan instead adds one shared
rendering vocabulary and keeps the genuinely model-specific behavior small.

## Where the work stands

**Shipped and in the database (slice 1).** Every registered model now carries a
reviewed rating no schema can supply: what kind of editing it really does, how
well a face survives it, and an operator caveat where one is warranted (Wan's
moderation). Seventeen built-in profiles exist, one per model per job the app
actually runs today. A resolver decides which profile a job may use and refuses
the combinations that would quietly swap out a character's face. None of this
changes a rendered image: no player-facing lane calls the profile layer, and each
seeded profile describes exactly what its lane already does.

**Shipped and live (slice 2).** All seven ordinary lanes — portrait, variant,
scene, item, location, and the two chat anchors — now pick a profile for their
job and describe what they want in one shared vocabulary before any model is
called. A reference is no longer "the second image": it says whether it is the
character, the room, or a style example, which is what the identity-pack and
visual-state work were both waiting for.

Nothing about the pictures changed, and that was the requirement. Each of the
seventeen profiles was written to describe exactly what its lane already did, so
the move changed where the configuration comes from and not what the provider
receives. The model-level selection code the lanes used before was deleted rather
than left beside the profile layer.

**Shipped and live (slices 3 and 9).** A profile's reference policy now decides
which references survive when the model cannot take them all, and in what order:
required first, then the profile's role order, then a caller's priority, then the
order the lane offered them. A three-reference scene on a two-reference model
drops whichever reference matters least instead of whichever happened to be last,
and says which of three reasons it went for. Structural controls — pose, depth,
edge, mask — are routed by what the model declares: to their own provider input
where one exists (spending no ordinary reference slot), and otherwise as numbered
images in the ordinary list, which is how the model this work is aimed at accepts
them. The composing prompt strategy can finally be compiled, because there is now
wording that names each reference's job and tells the model to obey a control map
rather than draw it.

No picture changed. Every seeded profile either carries an empty policy, which
selects exactly as the old positional trim did, or lists its roles in the order
its lane already sends them.

**Shipped (slice 6).** The curated LoRA library is live: an administrator can
register a hosted LoRA — a Hugging Face repository or a direct HTTPS weights
link, never a credential — with a curated strength range, allowed tasks, and
optional trigger words or prompt additions, and a render that names one has it
validated against the model, version, task and range before any provider money
is spent. An incompatible or unreachable LoRA refuses with a recorded reason
instead of silently running without it. The first trial that exercises it is
the Qwen lab's Stage 4
([qwen-advanced-image-subsystem.plan.md](qwen-advanced-image-subsystem.plan.md)).

**Not started.** Reference preparation and parallel uploads (the rest of slice
3), recorded seeds, safe version promotion, image sets, and any admin or player
UI for profiles remain ahead. One gap the migration opens: the model pickers
still list models, while renders resolve profiles, so a model an operator adds
without a profile is offered and then quietly passed over for the default —
visible in the diagnostics, and closed by the picker slice.

## What stays unchanged

The `image_models` registry remains the source of truth for which Replicate
models Vesper knows about and the provider facts needed to call them.

The existing shape negotiation, reference transport, output download, WebP
normalization, model pickers, defensive fallbacks, and same-model scene
degradation ladder remain. A failed Qwen scene should not quietly become a
Seedream scene with a different-looking person.

The raw per-model constants remain available as a low-level escape hatch. They
should not become the main product configuration system.

## The new layer: task-specific model profiles

A profile sits beneath a registered model and describes how that model should be
used for one job, rather than changing what the provider model fundamentally
supports.

A profile can say that it is for portraits, variants, scenes, items, locations,
text repair, example-based transformations, or coherent image sets. It can say
whether the run is generation or editing, which prompt style to use, which
reference roles matter, which quality and resolution settings apply, how long the
prediction may run, and which optional controls are enabled.

The seeded seventeen are all deliberately plain — "Portrait Standard", "Scene
Standard", one per model per job — because slice 1 had to change nothing. The
point of the later slices is choices such as:

- Qwen Image 2512 — Portrait Fast
- Qwen Image 2512 — Portrait Quality
- Qwen Image Edit 2511 — Scene Standard
- Qwen Image Edit 2511 — Cinematic LoRA
- Seedream 4.5 — Ensemble Scene
- Seedream 4.5 — 4K Location
- Seedream 5 Lite — Quality Scene
- Wan 2.7 — Text-to-Image 4K
- Wan 2.7 — Multi-Reference Edit

The player-facing controls should use readable, curated profiles. Raw provider
knobs belong in the admin configuration and advanced diagnostics, not in every
normal image picker.

## A shared rendering request

Every image-producing lane will describe what it wants in the same terms before
any Replicate payload is built.

That request will identify the task, prompt, desired aspect and quality, optional
controls, and reference images with explicit roles. A reference will no longer be
merely the first, second, or third buffer. It may be the identity anchor, the
location, a style example, an object, a before image, an after example, a pose
control, or another future visual input.

The selected profile and the registered model will translate that request into
the provider's actual fields. Shared utilities will choose the references that
fit, prepare and transport them, map common controls, negotiate dimensions,
normalize all returned images, and record what actually ran.

This role-aware request is important beyond the immediate model work. It lets a
future visual-state system provide identity, clothing, location, pose, depth, or
style references without teaching every image lane a different ordering
convention. It is also what the identity-pack plan's render-lane slice is waiting
on.

## Semantic capabilities

Some facts can be read from Replicate's schema. Others require human judgment
and live testing.

The registry probe can discover that an image input exists, but it cannot decide
whether the model is a strong identity-preserving editor or a destructive
repaint model. It cannot know that Wan's moderation is unusually restrictive, or
that one model is too slow to be a sensible default. Vesper therefore records
reviewed semantic facts alongside the probed mechanical ones — this part shipped
in slice 1, and a re-probe never overwrites them.

The app distinguishes instruction editing, multi-reference composition, ordinary
image-to-image repainting, and no editing, and records a reviewed
identity-preservation rating plus any operator warning that should appear when a
model is selected.

These fields guide profile creation and picker eligibility. They do not pretend
to be immutable truth; a new model version can be re-tested and re-rated. What is
still missing is the admin screen to read or change them — today they are set by
migration or by an API call.

## Model-specific opportunities

### Qwen Image 2512

Qwen Image 2512 remains the general text-to-image portrait model. Vesper should
add fast, balanced, and quality profiles using the model's guidance, inference
steps, and fast-mode controls. Generated seeds should be stored so an owner can
retry the same composition or deliberately request a new variation. Negative
prompts should be available in the profile and in an advanced admin control.

Its optional reference input is conventional strength-based image-to-image. That
can support a deliberate remix workflow with an edit-strength setting, but it
should not be presented as equivalent to Qwen Image Edit for scenes where the
same character must survive.

### Qwen Image Edit 2511

Qwen Image Edit remains the default identity-preserving editor for scenes and
portrait variants. The next improvement is to make its references role-aware:
identity first, then location, then a style or object example when capacity
allows.

It should also gain specialized profiles for correcting text in an existing
image and for applying a curated visual style. Its own endpoint exposes no LoRA
input — the Qwen lab verified that against the live schema — so curated LoRA
work runs on the dedicated Qwen LoRA endpoint that lab registered, still
through the same shared Replicate client
([qwen-advanced-image-subsystem.plan.md](qwen-advanced-image-subsystem.plan.md)
owns that choice).

A LoRA must be compatible with the Qwen Image family and reachable by Replicate.
The practical starting points are a public Hugging Face repository or a stable
HTTPS link to a weights file. Vesper should not store Hugging Face tokens or
other hosting secrets alongside a model.

The first LoRA experiment should be one curated house style at a few reviewed
strengths. Per-character LoRAs may eventually improve difficult angles and
full-body consistency, but they add training, hosting, compatibility, and
lifecycle work and should not be the first slice.

### Seedream 4.5

Seedream 4.5 should be used where its multi-reference capacity and high
resolution matter. Profiles can support ensemble scenes, several recurring
objects, stronger location consistency, and 4K location or promotional images.
The prompt builder must respect its provider guidance about prompt length rather
than sending an unbounded scene prompt.

Its sequential generation mode creates an opportunity for coherent sets: a few
related views of a location, a short visual sequence, or several shots of one
scene. That should be a distinct workflow rather than changing the ordinary
single-image scene button.

### Seedream 5 Lite

Seedream 5 Lite remains a slower, quality-oriented alternative. It should gain a
3K profile and an example-pair transformation workflow where the user supplies a
before image and an example of the desired result.

Its coherent-output features can share the same image-set workflow as Seedream
4.5. A future Seedream-to-Seedance video handoff may use temporary provider
links, but those should never be treated as normal durable Vesper assets. Video
handoff is deferred until Vesper has an actual video pipeline.

### Stable Diffusion 3.5 Large

Stable Diffusion 3.5 Large should remain focused on original and deliberately
stylized portraits. Profiles may expose curated guidance, negative prompt, and
seed settings. Its strength-based image-to-image mode is not suitable for the
normal identity-critical scene path and should remain unavailable there unless
future trials demonstrate otherwise.

The existing render-at-4:5 and crop-to-3:4 behavior remains the right shape
fallback.

### Wan 2.7 Image Pro

Wan needs separate generation and editing profiles. The generation profile can
use thinking mode and, where cost and latency are acceptable, higher
resolutions. The edit profile keeps the proven inlined-reference transport and
uses dimensions that the edit path supports.

Wan's multiple-output and coherent-set modes can later feed the shared image-set
workflow. Its upstream moderation cannot be disabled and has rejected benign
Vesper references, so scene profiles must remain opt-in and display a warning.
The application should not silently move a refused Wan render to another model.

## Shared utilities

The implementation should centralize the following work:

- choosing references by role, priority, required status, and model capacity;
- rotating, resizing, stripping metadata, and encoding reference images into a
  format the model accepts;
- uploading references with bounded concurrency or inlining them when the model
  requires it;
- negotiating aspect ratio, named resolution tiers, explicit pixel sizes, and
  custom dimensions;
- mapping seed, guidance, steps, negative prompt, edit strength, output count,
  thinking mode, coherent-set mode, and LoRA settings onto the field names a
  model actually exposes;
- fitting prompts to model limits while preserving mandatory identity and scene
  instructions before optional detail;
- accepting either one output or many and converting every durable asset to the
  application's normal image format;
- recording the resolved model version, profile, controls, reference roles,
  seed, duration, and warnings for later comparison.

The control mapping and the profile compile step in that list already exist, from
the trial work. The rest does not.

The model adapter should only own behavior that really is specific to that model,
primarily prompt strategy and provider quirks that cannot be represented as data.

## Version upgrades

Bare Replicate model slugs can move to a new provider version with a changed
schema. Re-probing after the change is useful, but it happens after the model has
already drifted.

The six built-in models are all official Replicate models and still track the
latest version. They should instead be pinned to tested versions. The admin page
should be able to probe the latest version as a candidate, show what capabilities
changed, run an explicit smoke test, and then activate that version atomically. A
version change must not update the active model's stored capabilities until the
version itself is activated.

This is especially important for optional features such as LoRAs, where one
version may expose a field that another does not.

Until this slice lands, ordinary renders deliberately follow the floating latest
version. A controlled comparison cannot: it refuses a model whose exact version
it cannot pin, which is why trial setup re-probes the models a run will use.

## Multiple outputs and coherent sets

Existing image lanes continue to ask for one image. The provider layer will be
able to normalize several outputs, while the existing single-image wrapper takes
the first result and preserves today's behavior.

A separate image-set workflow will store ordered siblings with a shared set
identity. It can later support Seedream sequences, Wan image sets, storyboard
shots, and variation grids without forcing the portrait, variant, and scene
pipelines to understand batches.

## Delivery slices

1. **Capability vocabulary and profiles.** Status: complete — 2026-08-05.
   Reviewed edit kind and identity-preservation metadata, task-specific
   profiles, and a resolver that maps an existing model selection to a default
   profile without changing a single render.
2. **Shared render intent.** Status: complete — 2026-08-07. The normalized
   request, with the portrait, variant, scene, item, location, chat-look and
   chat-place lanes refactored through it, prompts and outputs preserved. Two
   things it deliberately left alone, both of which would have changed live
   renders: production still follows each model's floating latest version rather
   than the compile step's pin, and still takes its prediction budget from the
   environment unless a profile declares one.
3. **Role-aware references and transport.** Status: in progress — selection and
   prompt wording complete 2026-08-11; the transport half remains. A profile's
   policy now chooses which references survive when capacity is short, in what
   order, and reports why each omission happened; the composing strategy has
   general-vocabulary wording that names every reference's job. What remains is
   the transport half: a preparation step and bounded concurrent uploads,
   preserving Wan's inline path.
4. **Common controls and reproducibility.** Status: in progress — control
   mapping and per-profile timeouts landed; seed recording remains. Store
   seeds, add quality profiles, map guidance, steps, negative prompt, and edit
   strength only where supported, and use per-profile prediction timeouts.
5. **Version promotion.** Status: queued. Pin the built-ins, add candidate
   probing and capability diffs, and provide an explicit smoke-test-and-activate
   flow.
6. **Qwen LoRA library.** Status: built 2026-08-11 — awaiting the initial
   style trial, which runs as the Qwen lab's Stage 4 protocol. Add compatible
   hosted LoRAs, profile selection, scale validation, trigger or prompt
   additions, and one initial style trial.
7. **Model-specific profiles.** Status: queued. Add Seedream high-resolution and
   example-based profiles, Wan generation/edit profiles, Qwen text repair, and
   curated Stable Diffusion portrait profiles.
8. **Image sets.** Status: queued. Normalize multiple outputs and add the
   separate coherent-set storage and UI workflow.
9. **Future visual controls.** Status: complete — 2026-08-11. Masks, pose, depth
   and edge images are routed by what the active model declares: to a dedicated
   provider input where the version has one, and otherwise as numbered images in
   the ordinary reference list. `edge` became a reference role of its own, so a
   profile can require an edge map rather than a generic control.

Each slice should be independently usable. Image sets must not change ordinary
scene generation.

Slice 2 was the gate on other work, and that gate is now open: the identity-pack
plan's render-lane consumption slice and the visual-state plan can both supply
role-carrying references.

## Success criteria

- The application can use several profiles for one model without duplicating the
  provider harness.
- A profile never sends an input that the active pinned model version does not
  support.
- Existing chats and stored model selections continue to render through a
  sensible default profile.
- Reference trimming preserves required identity references before optional
  location, style, or object references.
- Seeds and resolved settings are recorded well enough to retry the same
  composition.
- Qwen Image Edit can apply one curated, compatible hosted LoRA through a normal
  profile.
- Wan can use different safe settings for generation and editing without two
  copies of the Replicate client.
- The existing single-image lanes remain single-image lanes while a separate
  workflow can retain ordered multi-output sets.
- Admins can see and test a new Replicate version before it replaces the active
  one.

## Out of scope for the first implementation

Training LoRAs inside Vesper, automatically creating one LoRA per character,
video generation, ControlNet or pose generation, user-uploaded arbitrary LoRAs,
and automatic fallback between different image models are not part of the first
slices.

The architecture should leave room for them, but the initial work is about making
the current six models more capable, predictable, and reusable without turning
the image path into six separate systems.

## Open questions

Each carries a recommended default the implementation may proceed on unless the
owner rules otherwise.

- Should normal player controls stay profile-based, with raw settings admin-only?
  Recommended: yes.
- When should production models be pinned? Recommended: as part of the
  version-promotion slice.
- Should LoRAs be administrator-curated only at first? Recommended: yes.
- Should one render be limited to one LoRA? Recommended: yes — that is what the
  tested Qwen Image Edit binding supports.
- Should a global prediction-timeout fallback survive alongside a bounded
  per-profile override? Recommended: yes.
- Should latency be a maintained model label or derived from measurements?
  Recommended: derived — treat it as operational data.
