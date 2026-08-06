# Qwen advanced image subsystem — identity-first portraits and scenes

Status: draft for owner review — 2026-08-06

This is a product plan rather than a technical specification. It is intentionally
plain English so the direction can be reviewed and revised before implementation
details are locked down.

Related work:

- [image-model-capabilities.plan.md](image-model-capabilities.plan.md) provides the
  shared model profiles, reference roles, controls, and Replicate transport that
  every model-specific subsystem should reuse;
- [image-render-quality.plan.md](image-render-quality.plan.md) owns prompt quality,
  identity trials, result review, and repair policy;
- [image-identity-packs.plan.md](image-identity-packs.plan.md) provides the
  canonical portrait and face-detail references used to preserve identity;
- [spatial-scene-images.plan.md](spatial-scene-images.plan.md) owns the larger
  future system for pose, depth, masks, and physically controlled scenes.

## Recommendation

Use **Qwen Image Edit 2511** as the first advanced, model-specific image
subsystem.

Qwen Image Edit is already Vesper's normal choice for portrait variants and scene
images. It has the strongest reviewed identity preservation among the everyday
models currently in use, accepts up to three reference images, and a tested pinned
Replicate version exposes one compatible LoRA input.

That makes it the best first prototype because the work can improve a real
production path instead of building around an experimental model that may later
fail quality, reliability, licensing, or moderation review.

Qwen Image 2512 remains the normal model for creating a brand-new portrait from
text. Qwen Image Edit cannot start from nothing, so the advanced subsystem begins
once a portrait or other source image already exists.

## Why not begin with Pony Realism

Pony Realism v2.3 is the more obvious ControlNet experiment. Its Replicate
workflow exposes separate face, pose, depth, and edge-control options. It is a
valuable future subsystem candidate.

It is not the best first prototype, however. It is a lightly proven community
model with no Vesper trial verdict and an outstanding license and production-use
review. Starting there would combine three separate questions:

- whether model-specific subsystems are the right architecture;
- whether advanced controls improve Vesper images;
- whether this particular community model is good and safe enough to operate.

Qwen lets Vesper answer the first two questions on a model the application already
trusts more. Pony can then become the first native-ControlNet subsystem once the
shared pattern is proven.

## Goal

Turn Qwen from a single generic image-model call into a deliberate workflow for
preserving character identity while changing portraits and composing scenes.

The subsystem should make Qwen easier to use well, not expose a wall of provider
settings. It should automatically choose the right identity references, apply a
reviewed Qwen instruction style, optionally use a compatible LoRA, keep a clear
record of what ran, and let the owner compare results before promoting anything.

## Product outcomes

The prototype should produce five visible improvements.

### More reliable identity

Portrait variants and scene images should look like the established character,
not merely a similar person. The subsystem should use the character's identity
pack deliberately rather than treating every reference as an anonymous image.

### More controlled changes

A request such as changing clothing, expression, hairstyle, framing, or setting
should clearly state what may change and what must remain stable. Qwen should not
be asked to reinterpret the whole person when only one detail changed.

### Useful LoRA support

Vesper should be able to use one reviewed Qwen-compatible LoRA without adding raw
provider fields to every image screen. The first smoke test can use a known style
LoRA. The first meaningful test should use one character LoRA and compare it
against identity-pack references alone.

### Simple choices rather than raw controls

Normal users should choose a goal such as Identity Priority, Balanced, or Style
Priority. Provider-specific strengths and prompt additions should live inside
reviewed profiles. Raw settings remain an admin and trial tool.

### A repeatable model-subsystem pattern

The Qwen work should establish a reusable boundary: shared image infrastructure
handles storage, jobs, uploads, references, billing, and diagnostics, while the
Qwen subsystem owns only Qwen's recipes, limits, profiles, and model-specific
workflow decisions.

## Scope

### Portrait Studio

The first portrait-studio use is an advanced variant and refinement path. It does
not replace new portrait generation.

A user starts from the current canonical portrait or another selected portrait
and chooses the intended change. Examples include:

- change clothing while preserving the person;
- change expression or hairstyle;
- create a closer face portrait;
- create a full-body or alternate-angle portrait;
- apply a reviewed visual style;
- test a character LoRA;
- repair identity drift in an otherwise useful portrait.

The subsystem automatically supplies the best available identity references. It
shows which references and optional LoRA will be used, generates a separate new
image, and keeps the original. The result may be promoted only through the normal
portrait workflow.

The first release should support one character at a time. It should not attempt to
combine several characters into a portrait-studio composition.

### Scene images

The first scene use is a single-character scene generated from the character's
identity pack and the committed scene description.

The subsystem should reserve Qwen's limited reference slots in this order:

1. the broad canonical identity portrait;
2. the face-detail reference when it passes the quality gate;
3. one optional scene, location, style, outfit, object, or visual guide.

The third reference is selected for the job rather than permanently fixed. A
location image may matter more for one scene, while a style or wardrobe example
may matter more for another.

Two-character scenes may be added after the single-character path succeeds. Each
required identity must fit before any face-detail, location, or style reference.
If Qwen cannot hold every required identity within its three-image limit, the
workflow is ineligible rather than silently dropping someone.

Scene generation remains detached from the text turn. A failed advanced render
must never block or roll back the conversation.

### LoRAs

The subsystem supports one administrator-curated LoRA per render because that is
the capability of the tested Qwen version.

The LoRA path should be introduced in two steps.

First, use a known compatible style LoRA to prove that version pinning, hosting,
selection, strength limits, prompt additions, and diagnostics all work.

Second, train or obtain one character LoRA from a reviewed image set and compare
it against the same Qwen workflow using identity-pack references alone. This is
the test that determines whether per-character LoRAs are worth their additional
training and lifecycle cost.

A character LoRA is additive evidence, not a replacement for the canonical
portrait. The identity pack remains the source of truth. A LoRA must not silently
become stale when the canonical appearance changes.

### Pose, depth, masks, and ControlNet

Qwen Image Edit 2511 does not currently expose native pose, depth, mask, or
ControlNet inputs. Ordinary reference images must not be mislabeled as structural
controls.

The first Qwen subsystem therefore focuses on the advanced features Qwen actually
supports today: identity-aware multi-reference editing, model-specific
instructions, quality profiles, seeds, and one LoRA.

A later Qwen control connector may be added if Vesper selects and verifies a
Replicate-hosted Qwen ControlNet or control-union workflow. That route would be a
separate stage inside the same subsystem:

1. create a structurally controlled draft from pose or depth;
2. pass that draft and the character identity references to Qwen Image Edit;
3. preserve the accepted structure while restoring identity and appearance;
4. keep both attempts and compare the final result against the ordinary Qwen
   path.

This stage should use controls produced by the spatial-scene system when they
exist. The Qwen subsystem should not create a second, incompatible pose system.
If no suitable Replicate Qwen control endpoint passes the trial, the control
connector remains unshipped rather than being simulated with prompt wording.

## Qwen workflow modes

The player-facing vocabulary should stay small.

### Identity Priority

Use the strongest eligible identity references, quality settings, and conservative
change instructions. This is the default for portrait refinements and important
single-character scenes.

### Balanced

Preserve identity while allowing more freedom in pose, composition, lighting, and
setting. This may become the everyday scene profile if its trial results and
latency are acceptable.

### Style Priority

Use a reviewed style reference or LoRA and allow more visual transformation. The
interface should warn that exact facial fidelity may be weaker than Identity
Priority.

### Controlled Draft

This mode appears only after a real Qwen pose/depth connector is selected and
proven. It is not part of the initial player release.

## Reference recipes

The subsystem should use named recipes instead of asking each caller to arrange
images manually.

### Portrait refinement recipe

Use the selected portrait as the broad source, the identity-pack face detail when
eligible, and one optional style, wardrobe, or visual guide. The instruction names
each reference and states the requested change once.

### Single-character scene recipe

Use the canonical portrait, eligible face detail, and the most valuable optional
scene reference. The prompt preserves identity, body, age, distinguishing
features, and current appearance while allowing the requested scene composition.

### Two-character scene recipe

Use one required identity reference per character first. Any remaining slot may
hold the most valuable face detail or location reference. This recipe remains
experimental until identity swapping and duplicate-person failures are measured.

### Identity repair recipe

Use the existing generated image plus the character's identity references and ask
Qwen to change only the drifted identity. Because Qwen lacks regional masking,
this is an admin trial at first. A better face paired with changed clothing,
body, pose, camera, or setting counts as a failed repair.

## What the Qwen subsystem owns

The Qwen-specific layer owns:

- which Qwen workflow is eligible for the requested job;
- which Qwen profile and mode to use;
- how Qwen's three reference slots are allocated;
- Qwen's numbered-reference and change-versus-preserve instructions;
- compatible LoRA selection and reviewed strength ranges;
- version-specific capability checks;
- Qwen trial presets and comparison reports;
- warnings that are meaningful specifically for Qwen.

It should remain small enough that another model can have a different subsystem
without copying the entire image pipeline.

## What remains shared

The Qwen subsystem reuses rather than replaces:

- the image-model registry and profile system;
- the shared render request and Replicate client;
- image uploads, downloads, normalization, storage, and lineage;
- detached image jobs, retries, cancellation, and cost limits;
- identity packs and their quality gate;
- authored appearance and future visual-state data;
- scene composition and future spatial controls;
- advisory result checks and the fixed comparison corpus;
- authorization, deletion, copying, and publishing rules.

The subsystem may consume these systems but should not create Qwen-only copies of
them.

## User experience

### Portrait Studio

Add an Advanced Qwen option beside the normal variant workflow. It begins with a
small set of understandable choices:

- the change the user wants;
- Identity Priority, Balanced, or Style Priority;
- an optional reviewed style or character LoRA;
- standard or quality rendering;
- a preview of the references that will be used.

The output appears as a new candidate beside the source. The user can keep it,
discard it, make another variation, or promote it through the existing controls.

### Scene images

The ordinary scene button remains unchanged during the prototype. Admins receive
an Advanced Qwen profile or rerender action for selected chats. After the trial,
a proven profile may become a normal scene option.

The interface should explain when a job cannot use the requested workflow, such
as an unusable identity pack, too many required characters, an incompatible LoRA,
or a missing control connector. It should not silently run a weaker recipe under
the same label.

## Delivery stages

### Stage 0 — lock the baseline

Pin the tested Qwen Image Edit version used by the prototype and verify its live
Replicate inputs with a smoke test. Record the current standard portrait-variant
and scene results on a fixed character and scene corpus.

This prevents a moving provider version from changing the experiment halfway
through it.

### Stage 1 — first working Qwen path

Create the Qwen-specific workflow boundary and run one portrait refinement and
one single-character scene through it without a LoRA. Use existing references and
preserve current output behavior as the comparison baseline.

The goal is to prove that the Qwen layer can make model-specific decisions while
shared infrastructure still performs the actual render.

### Stage 2 — identity-pack recipes

Use the canonical portrait and eligible face-detail reference through the named
portrait and scene recipes. Add clear handling for the third optional reference
and for requests that exceed Qwen's capacity.

Run the fixed identity comparison before making the recipe a default.

### Stage 3 — curated LoRA support

Add one known compatible style LoRA, reviewed strength choices, prompt additions,
and complete provenance. Confirm that incompatible or unavailable LoRAs fail
before provider spend.

### Stage 4 — one character LoRA pilot

Train or obtain one character LoRA from a reviewed, varied image set. Compare:

- identity-pack references only;
- character LoRA only where a fair comparison is possible;
- identity-pack references plus the character LoRA;
- current standard Qwen behavior.

Judge face identity, body consistency, outfit and background leakage, edit
obedience, latency, failure rate, and overall preference. The result decides
whether character LoRAs become a supported feature or remain an occasional admin
tool.

### Stage 5 — scene promotion

Expose the successful Qwen profiles as normal options only after single-character
scene quality, reliability, latency, and cost are acceptable. Add two-character
trials separately; do not assume the same recipe scales up.

### Stage 6 — optional Qwen control connector

Select and trial a genuine Replicate-hosted Qwen pose/depth workflow. If it
materially improves composition without losing identity, add the Controlled Draft
mode and the Qwen Edit finishing pass. If it does not, close the stage with a
recorded negative result and leave pose control to a different model subsystem.

## Trial and evidence

The prototype should be judged against fixed examples rather than memorable best
cases.

Use several characters with different face shapes, hair, builds, visual styles,
and authored details. Include close portraits, alternate-angle portraits,
full-body images, simple scenes, difficult lighting, and at least one scene where
clothing and setting must remain stable.

Reviewers compare outputs without being told which workflow produced them. The
trial should answer:

- Does the result look more like the established character?
- Did Qwen make the requested change and avoid unrelated changes?
- Did the face improve at the cost of body, clothing, pose, or setting?
- Does the LoRA add value beyond good references?
- Is any gain large enough to justify additional latency and cost?
- Can the same result be understood and reproduced from its saved record?

## Success criteria

The prototype succeeds when:

- Qwen advanced portrait variants are materially preferred over the current
  baseline for identity and requested-change fidelity;
- the single-character scene recipe reduces recognisable identity drift without
  unacceptable composition or wardrobe regression;
- at least one compatible LoRA can be selected, validated, run, and reproduced
  through a normal Qwen profile;
- the character LoRA pilot produces a clear evidence-based decision, whether the
  answer is to ship it or not;
- required identity references are never displaced by optional style or location
  images;
- a failed or ineligible advanced workflow leaves the source image and standard
  workflow untouched;
- every result records the Qwen version, mode, references, LoRA, seed, and final
  settings well enough to compare or retry;
- the Qwen-specific code does not duplicate shared storage, job, billing, or
  provider infrastructure;
- the resulting boundary is clear enough to build a different Pony, Seedream, or
  other model subsystem without pretending their workflows are the same.

## Risks and safeguards

### A LoRA can overpower the character

Use curated strength ranges, compare against a no-LoRA baseline, and reject a
result that gains style while losing identity. Character training images must vary
pose, expression, lighting, and clothing so the LoRA does not learn one costume or
background as identity.

### Three references are not many

Required identities always win. The workflow explains which optional reference
was omitted and never hides a dropped character. Recipes are task-specific so a
location image is not sent merely because a slot happens to be free.

### A second edit can damage a good scene

Identity repair remains explicit and keeps the original. It is not an automatic
fallback. Full-frame repair must be graded on everything it changed, not only the
face.

### Replicate versions can change

The prototype uses a tested pinned version. A new version must be probed, smoke
-tested, and compared before activation, especially because LoRA support may not
appear consistently in Replicate's model metadata.

### Advanced controls can create a confusing interface

Expose a few reviewed modes and plain-language goals. Raw provider fields stay in
admin diagnostics and trial tooling.

### A model-specific subsystem can become a second image platform

Keep shared responsibilities outside the Qwen layer. The Qwen subsystem describes
how to use Qwen; it does not own files, queues, billing, authorization, or generic
image records.

## Out of scope for the first implementation

- replacing Qwen Image 2512 for brand-new portraits;
- automatic LoRA training inside Vesper;
- arbitrary user-uploaded LoRAs;
- more than one LoRA in a render;
- silent automatic face repair;
- claiming ControlNet support through ordinary image references;
- building a second pose or visual-state system;
- multi-character controlled scenes before the single-character trial passes;
- self-hosted ComfyUI or dedicated GPU operations;
- letting generated pixels alter authoritative character or world state;
- turning this draft directly into a generic subsystem for every model.

## Recommended defaults for our review

- Qwen Image Edit 2511 is the prototype model.
- Identity Priority is the default advanced mode.
- The first release is admin/dev only and single-character only.
- The identity pack remains required source truth even when a character LoRA is
  available.
- One style LoRA proves the connector; one character LoRA tests the real product
  value.
- No advanced workflow silently replaces the standard render path.
- Native ControlNet work waits for a verified Qwen Replicate endpoint and remains
  a separate delivery stage.
- A technical specification is written only after this product direction is
  reviewed and settled.

## Points to review before implementation

The main decisions for the next revision are:

- whether the first character LoRA pilot should use the existing seven-image test
  character set or a newly reviewed corpus;
- whether the prototype needs both Portrait Studio and scenes in its first
  vertical slice, or should prove portraits first and then add scenes;
- whether the optional Qwen ControlNet connector belongs in this plan's initial
  definition of done or should become a linked follow-up after LoRA and
  multi-reference editing are proven;
- when the advanced modes should move from admin-only trials to ordinary owner
  controls.
