# Image model capabilities — profiles, shared controls, and richer workflows

Status: active (started 2026-08-05)

Technical companion: [image-model-capabilities.spec.md](image-model-capabilities.spec.md)

This is a follow-up to the shipped
[image model registry](image-model-registry.plan.md). The registry solved the
first problem: image models are now data, Replicate is the only provider, and a
model can describe enough of its API for Vesper to call it safely. This plan
solves the next problem: the six models do not merely accept different field
names. They are good at different kinds of work and expose controls that Vesper
currently ignores.

## Why this work is needed

The current registry deliberately models the smallest useful common surface. It
knows whether a model can generate from text, whether it accepts reference
images, how many references it can take, how those references must travel, and
how to ask for the right shape. That is a strong foundation and should remain.

It is not yet enough to use the models well.

Today, every reference-capable model is broadly described as able to “edit.” In
practice, that word covers several very different operations. Qwen Image Edit
2511 follows editing instructions and is intended to preserve the subject.
Seedream can combine many examples into a new composition. Qwen Image 2512 and
Stable Diffusion 3.5 Large use strength-based image-to-image repainting, which
can replace the person Vesper was trying to preserve. Those operations should
not be treated as interchangeable just because all of them accept an image
input.

The same model can also need different settings for different jobs. Wan 2.7 can
use thinking mode and very high resolutions for text-to-image work, while its
edit path has different limits and requires inlined references. Seedream 4.5
may be an everyday 2K scene model in one context and a slower 4K location model
in another. One bag of permanent `extraInput` values on the model row cannot
express those differences cleanly.

Finally, several useful features are currently left unused: deterministic seeds,
negative prompts, quality controls, edit strength, multi-image composition,
coherent image sets, multiple outputs, and Qwen-compatible LoRAs. Adding each
feature directly to each lane would produce a collection of special-purpose
harnesses that all upload images, map settings, poll Replicate, download output,
and normalize files in slightly different ways. This plan instead adds one
shared rendering vocabulary and keeps the genuinely model-specific behavior
small.

## What stays unchanged

The `image_models` registry remains the source of truth for which Replicate
models Vesper knows about and the provider facts needed to call them.

The existing shape negotiation, reference transport, output download, WebP
normalization, model pickers, defensive fallbacks, and same-model scene
degradation ladder remain. A failed Qwen scene should not quietly become a
Seedream scene with a different-looking person.

The raw `extraInput` object remains available as a low-level escape hatch. It
should not become the main product configuration system.

## The new layer: task-specific model profiles

Vesper will add profiles beneath each registered model. A profile describes how
that model should be used for one job rather than changing what the provider
model fundamentally supports.

A profile can say that it is for portraits, variants, scenes, items, locations,
text repair, example-based transformations, or coherent image sets. It can say
whether the run is generation or editing, which prompt style to use, which
reference roles matter, which quality and resolution settings apply, how long
the prediction may run, and which optional controls are enabled.

This lets the app offer choices such as:

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
controls, and reference images with explicit roles. A reference will no longer
be merely the first, second, or third buffer. It may be the identity anchor, the
location, a style example, an object, a before image, an after example, a pose
control, or another future visual input.

The selected profile and the registered model will translate that request into
the provider’s actual fields. Shared utilities will choose the references that
fit, prepare and transport them, map common controls, negotiate dimensions,
normalize all returned images, and record what actually ran.

This role-aware request is important beyond the immediate model work. It lets a
future visual-state system provide identity, clothing, location, pose, depth, or
style references without teaching every image lane a different ordering
convention.

## Semantic capabilities

Some facts can be read from Replicate’s schema. Others require human judgment
and live testing.

The registry probe can discover that an image input exists, but it cannot decide
whether the model is a strong identity-preserving editor or a destructive
repaint model. It cannot know that Wan’s moderation is unusually restrictive,
or that one model is too slow to be a sensible default. Vesper will therefore
record reviewed semantic facts alongside the probed mechanical capabilities.

At minimum, the app should distinguish instruction editing, multi-reference
composition, ordinary image-to-image repainting, and no editing. It should also
record a reviewed identity-preservation rating and any operator warning that
should appear when a model is selected.

These fields guide profile creation and picker eligibility. They do not pretend
to be immutable truth; a new model version can be re-tested and re-rated.

## Model-specific opportunities

### Qwen Image 2512

Qwen Image 2512 remains the general text-to-image portrait model. Vesper should
add fast, balanced, and quality profiles using the model’s guidance, inference
steps, and fast-mode controls. Generated seeds should be stored so an owner can
retry the same composition or deliberately request a new variation. Negative
prompts should be available in the profile and in an advanced admin control.

Its optional reference input is conventional strength-based image-to-image.
That can support a deliberate remix workflow with an edit-strength setting, but
it should not be presented as equivalent to Qwen Image Edit for scenes where the
same character must survive.

### Qwen Image Edit 2511

Qwen Image Edit remains the default identity-preserving editor for scenes and
portrait variants. The next improvement is to make its references role-aware:
identity first, then location, then a style or object example when capacity
allows.

It should also gain specialized profiles for correcting text in an existing
image and for applying a curated visual style. Its current tested endpoint
supports one custom LoRA through `lora_weights` and `lora_scale`, so Vesper can
offer a house-style or other curated LoRA without building a separate Replicate
client.

A LoRA must be compatible with the Qwen Image family and reachable by Replicate.
The practical starting points are a public Hugging Face repository or a stable
HTTPS URL to a `.safetensors` file. Vesper should not store Hugging Face tokens or
other hosting secrets in the image-model row.

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
4.5. A future Seedream-to-Seedance video handoff may use temporary provider URLs,
but those URLs should never be treated as normal durable Vesper assets. Video
handoff is deferred until Vesper has an actual video pipeline.

### Stable Diffusion 3.5 Large

Stable Diffusion 3.5 Large should remain focused on original and deliberately
stylized portraits. Profiles may expose curated CFG, negative prompt, and seed
settings. Its strength-based image-to-image mode is not suitable for the normal
identity-critical scene path and should remain unavailable there unless future
trials demonstrate otherwise.

The existing render-at-4:5 and crop-to-3:4 behavior remains the right shape
fallback.

### Wan 2.7 Image Pro

Wan needs separate generation and editing profiles. The generation profile can
use thinking mode and, where cost and latency are acceptable, higher
resolutions. The edit profile keeps the proven inlined-reference transport and
uses dimensions that the edit path supports.

Wan’s multiple-output and coherent-set modes can later feed the shared image-set
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
  application’s normal image format;
- recording the resolved model version, profile, controls, reference roles,
  seed, duration, and warnings for later comparison.

The model adapter should only own behavior that really is specific to that
model, primarily prompt strategy and provider quirks that cannot be represented
as data.

## Version upgrades

Bare Replicate model slugs can move to a new provider version with a changed
schema. Re-probing after the change is useful, but it happens after the model has
already drifted.

The built-in production models should instead be pinned to tested versions. The
admin page should be able to probe the latest version as a candidate, show what
capabilities changed, run an explicit smoke test, and then activate that version
atomically. A version change must not update the active model’s stored
capabilities until the version itself is activated.

This is especially important for optional features such as LoRAs, where one
version may expose a field that another does not.

## Multiple outputs and coherent sets

Existing image lanes continue to ask for one image. The provider layer will be
able to normalize several outputs, while the existing single-image wrapper takes
the first result and preserves today’s behavior.

A separate image-set workflow will store ordered siblings with a shared set
identity. It can later support Seedream sequences, Wan image sets, storyboard
shots, and variation grids without forcing the portrait, variant, and scene
pipelines to understand batches.

## Delivery slices

1. **Capability vocabulary and profiles.** Add reviewed edit type and identity
   preservation metadata, add task-specific profiles, and resolve existing model
   selections to a default profile without changing current renders.
2. **Shared render intent.** Introduce the normalized request and refactor the
   existing portrait, variant, scene, item, location, chat-look, and chat-place
   lanes through it while preserving their prompts and outputs.
3. **Role-aware references and transport.** Replace positional trimming with
   priority selection, add bounded concurrent uploads, and preserve Wan’s data
   URL path.
4. **Common controls and reproducibility.** Store seeds, add quality profiles,
   map guidance, steps, negative prompt, and edit strength only where supported,
   and use per-profile prediction timeouts.
5. **Version promotion.** Pin the built-ins, add candidate probing and capability
   diffs, and provide an explicit smoke-test-and-activate flow.
6. **Qwen LoRA library.** Add compatible hosted LoRAs, profile selection, scale
   validation, trigger or prompt additions, and one initial house-style trial.
7. **Model-specific profiles.** Add Seedream high-resolution and example-based
   profiles, Wan generation/edit profiles, Qwen text repair, and curated Stable
   Diffusion portrait profiles.
8. **Image sets.** Normalize multiple outputs and add the separate coherent-set
   storage and UI workflow.
9. **Future visual controls.** Extend the input-binding vocabulary to masks,
   pose, depth, and other control images when a selected model requires them.

Each slice should be independently usable. The shared render-intent refactor must
not wait for image sets or LoRAs, and image sets must not change ordinary scene
generation.

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

The architecture should leave room for them, but the initial work is about
making the current six models more capable, predictable, and reusable without
turning the image path into six separate systems.

## Open decisions

The implementation can begin with the following recommended defaults unless the
owner rules otherwise:

- Keep normal player controls profile-based; keep raw settings admin-only.
- Pin production models after the version-promotion slice lands.
- Permit only administrator-curated LoRAs at first.
- Start with one LoRA per render because that is what the tested Qwen Image Edit
  binding supports.
- Preserve a global prediction-timeout fallback, with a bounded override on each
  profile.
- Treat measured latency as operational data rather than a manually maintained
  model label.
