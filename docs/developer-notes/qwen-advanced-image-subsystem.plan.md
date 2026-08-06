# Qwen-family advanced image subsystem — controlled portraits and scenes

Status: draft for owner review — revised 2026-08-06

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
  future system for producing consistent pose, depth, masks, and physically
  controlled scenes.

## Recommendation

Use a **Qwen-family subsystem** as Vesper's first advanced, model-specific image
prototype.

The original version of this plan centered too narrowly on Qwen Image Edit 2511.
That model is useful for identity-preserving edits and LoRAs, but it does not by
itself test the technically intricate controls this prototype is meant to explore.

The revised subsystem should combine several Qwen workflows, each used for the
job it actually supports:

- **Qwen Image 2512** remains the normal starting point for a portrait created
  from text;
- **Qwen Image Edit Plus** is the first controlled-composition connector, using
  pose keypoints, depth maps, edge maps, and ordinary visual references;
- **Qwen Image Edit 2511** is a candidate identity-finishing and LoRA connector;

This gives the prototype meaningful advanced tools immediately while keeping it
close to a model family the application already understands.

## Current provider facts

The prototype should begin with a fresh live probe, but the following facts were
verified against the Replicate model pages on 2026-08-06.

### Qwen Image Edit Plus

Qwen Image Edit Plus accepts one to three input images and advertises native
ControlNet support for common structural conditions, including:

- pose or keypoint maps;
- depth maps;
- edge maps.

Its Replicate interface does not expose a separate field named `pose`, `depth`, or
`controlnet`. The control map is supplied as one of the numbered images, and the
prompt explains which image supplies identity, pose, depth, clothing, location,
or another role.

That is still a real controlled workflow, but it means Vesper must understand the
role of every input image rather than treating the inputs as an anonymous list.

### Qwen Image Edit 2511

Qwen Image Edit 2511 accepts up to three reference images and one compatible LoRA.
It supports instruction editing, seeds, quality controls, and an adjustable LoRA
strength.

It does not expose dedicated mask, pose, depth, edge, or ControlNet fields. It
should therefore be used for the capabilities it actually has: identity-aware
editing, reference-guided refinement, and LoRA-assisted finishing.

## Goal

Build a controlled Qwen image laboratory for Vesper that can test:

- structural guidance from pose, depth, and edge maps;
- identity preservation from canonical and face-detail references;
- LoRA-assisted style or character consistency;
- single-stage versus multi-stage image workflows;
- repeatable comparison against the normal portrait and scene paths.

The subsystem should help determine which advanced techniques materially improve
Vesper's images. It should not assume that a more complicated workflow is better
merely because it uses more models or controls.

## Parallel prototype recommendation

Build this as a **parallel experimental system** rather than changing the normal
dev-site image paths at the start.

The parallel system should reuse the same Replicate account and the existing
`REPLICATE_API_TOKEN` from `.env`. It does not need a second provider secret or a
separate Replicate account.

It should also reuse Vesper's shared image infrastructure wherever possible:

- the Replicate client;
- uploads and downloads;
- image normalization and storage;
- detached image jobs;
- authorization;
- retries and timeouts;
- billing and cost guards;
- image lineage and diagnostics.

The parallelism belongs at the **workflow and product level**, not by duplicating
the provider platform.

### What remains isolated

During the prototype:

- normal portrait generation remains unchanged;
- normal portrait variants remain available;
- normal scene generation remains unchanged;
- current default model selections are not replaced;
- advanced Qwen profiles do not silently become ordinary profiles;
- advanced outputs are clearly labeled experimental candidates;
- failures in the advanced path do not trigger hidden fallbacks or affect the
  standard result;
- advanced results can be compared directly with standard results.

The preferred first implementation is an admin-only or feature-flagged lab surface
inside the existing dev deployment. A wholly separate application or deployment
would add operational work without improving the experiment enough to justify it.

A separate deployment should be considered only if advanced jobs later require a
self-hosted GPU worker, ComfyUI service, incompatible dependencies, or enough load
to disrupt the normal dev environment.

## Why parallel development is safer

Advanced image workflows introduce several variables at once:

- new model endpoints;
- structural control images;
- different reference orderings;
- more complicated instructions;
- multiple model calls for one accepted result;
- different latency and cost;
- a greater chance that a finishing pass damages a good draft.

Mixing these directly into the standard path would make failures difficult to
interpret. A parallel path lets Vesper answer the important questions cleanly:

- Did pose or depth control actually improve composition?
- Did the identity-finishing pass help, or did it redraw too much?
- Did the LoRA add value beyond good references?
- Is a two-stage result better enough to justify two calls?
- Can the workflow be reproduced from its saved record?
- Is the experimental path reliable enough to promote?

## Product outcomes

The prototype should produce six useful outcomes.

### Structurally controlled images

Vesper should be able to supply a pose, depth, or edge guide and see whether Qwen
follows the intended body position, framing, and scene structure more reliably
than prompt-only generation.

### More reliable identity

Portrait variants and scene images should look like the established character,
not merely a similar person. The subsystem should use the character's identity
pack deliberately rather than treating every reference as an anonymous image.

### Clear change boundaries

A request such as changing clothing, expression, hairstyle, framing, pose, or
setting should clearly state what may change and what must remain stable.

### Useful LoRA evidence

Vesper should prove that it can select and run a reviewed Qwen-compatible LoRA,
then determine whether style or character LoRAs add enough value to justify their
training and lifecycle cost.

### Honest multi-stage comparison

The prototype should compare a controlled Qwen Image Edit Plus result against an
optional Qwen Image Edit 2511 finishing pass. It must not assume that the finishing
pass is better. A second pass that improves the face but changes the pose, outfit,
body, camera, lighting, or setting is a regression.

### A repeatable subsystem pattern

The Qwen work should establish a reusable boundary: shared image infrastructure
handles provider and asset work, while the model subsystem owns the recipes,
capability limits, control roles, prompts, and workflow decisions specific to that
model family.

## Scope

### Portrait Studio

The first portrait-studio use is an advanced variant and refinement path. It does
not replace new portrait generation.

A user starts from the current canonical portrait or another selected portrait
and chooses an intended change, such as:

- change clothing while preserving the person;
- change expression or hairstyle;
- create a closer face portrait;
- create a full-body or alternate-angle portrait;
- adopt a supplied pose;
- preserve the outline or structure of a source image;
- apply a reviewed visual style;
- test a character LoRA;
- repair identity drift in an otherwise useful portrait.

The subsystem generates a separate candidate and keeps the original. A result may
be promoted only through the normal portrait workflow.

The first release supports one character at a time.

### Scene images

The first scene use is a single-character scene generated from:

- the committed scene description;
- the character's identity pack;
- one selected structural control or scene reference;
- optional LoRA support in a finishing stage.

The first scene trials should focus on cases where structural control is easy to
judge: standing, sitting, leaning, kneeling, lying down, facing a direction, or
holding a simple object.

Two-character scenes may be added only after the single-character path succeeds.
Identity swapping, duplicated people, and contact geometry require a separate
trial rather than assuming the one-character workflow scales automatically.

Scene generation remains detached from the text turn. A failed advanced render
must never block or roll back the conversation.

### Structural controls

The prototype includes the following controls in its initial scope:

- pose or keypoint maps;
- depth maps;
- edge maps.

The prototype should test each control separately before combining them. A more
complicated stack is not automatically more accurate.

The first control sources may include reviewed static fixtures, control maps
extracted from selected images, and later the outputs of the spatial-scene system.
The Qwen subsystem should consume shared controls rather than invent a competing
pose representation.

### LoRAs

The prototype supports one administrator-curated LoRA per LoRA-capable finishing
render.

The LoRA path should be introduced in two steps.

First, use a known compatible style LoRA to prove version pinning, hosting,
selection, strength limits, prompt additions, and diagnostics.

Second, train or obtain one character LoRA from a reviewed image set and compare
it against identity-pack references alone.

A character LoRA is additive evidence, not the canonical source of identity. The
identity pack remains the source of truth, and a LoRA must not silently stay active
when its training set no longer represents the current character.

## Connector model

The subsystem should use separate connectors with explicit purposes rather than
one universal Qwen adapter.

### Generation connector

Uses Qwen Image 2512 for a new image created from text. It remains the normal
starting point for a portrait without a source image.

### Controlled-composition connector

Uses Qwen Image Edit Plus with numbered visual roles. It is responsible for pose,
depth, edge, outfit, location, and other controlled combinations.

Because control maps travel through the same image list as ordinary references,
the connector must explicitly label every image's role and send them in a stable,
recorded order.

### Identity and LoRA finishing connector

Uses Qwen Image Edit 2511 or another live-probed Qwen LoRA endpoint when a trial
calls for identity reinforcement or a LoRA.

This connector is optional for each job. A controlled result may be accepted
without a finishing pass when it is already better.

It remains behind the same subsystem boundary so the rest of Vesper does not need
to understand node names or workflow files.

## Qwen workflow modes

The visible vocabulary should stay small even though the underlying workflows are
technically intricate.

### Identity Priority

Uses the strongest eligible identity references, conservative instructions, and
an optional identity-finishing pass. This is the default advanced portrait mode.

### Controlled Composition

Uses pose, depth, or edge guidance through Qwen Image Edit Plus. It is the core
experimental mode for both portraits and scenes.

### Balanced

Uses identity references and a structural or scene guide while allowing more
freedom in lighting, camera, and composition.

### Style Priority

Uses a reviewed style reference or LoRA and permits more visual transformation.
The interface warns that exact identity may be weaker.

## Reference and control recipes

The subsystem should use named recipes instead of asking each caller to arrange
images manually.

### Controlled portrait recipe

Use the canonical portrait or selected source, one pose/depth/edge control, and
one optional face-detail, outfit, or style reference. The instruction explicitly
names the role of every numbered image.

### Portrait finishing recipe

Use the controlled draft, canonical identity portrait, and eligible face detail.
Apply a LoRA only when the selected profile permits it.

### Controlled scene recipe

Use the character identity reference, the chosen control map, and the most
valuable scene, location, wardrobe, or face-detail reference that still fits.

The first trial should compare whether canonical identity or face detail is more
valuable when control already consumes one of the limited slots.

### Direct identity-edit recipe

Use Qwen Image Edit 2511 without a controlled draft. This remains a required
baseline so the trial can determine whether the more intricate path really adds
value.

### Two-character recipe

Use one required identity reference per character first. A remaining slot may hold
a pose or scene control. If all required identities and the selected control do
not fit, the workflow is ineligible rather than silently dropping a character.

## What the Qwen subsystem owns

The Qwen-specific layer owns:

- which Qwen connector is eligible for a job;
- which workflow and mode to use;
- how limited input slots are allocated among identity, control, location, style,
  clothing, and object roles;
- Qwen's numbered-image instructions;
- compatible LoRA selection and reviewed strength ranges;
- version-specific capability checks;
- optional finishing-pass decisions;
- Qwen trial presets, warnings, and comparison reports.

It should remain small enough that another model can have a genuinely different
subsystem without copying the entire image platform.

## What remains shared

The Qwen subsystem reuses rather than replaces:

- the image-model registry and profile system;
- the shared Replicate client and API token;
- image uploads, downloads, normalization, storage, and lineage;
- detached image jobs, retries, cancellation, and cost limits;
- identity packs and their quality gate;
- authored appearance and future visual-state data;
- scene composition and future spatial controls;
- advisory result checks and the fixed comparison corpus;
- authorization, deletion, copying, and publishing rules.

The subsystem may consume these systems but should not create Qwen-only copies of
them.

## User experience during the prototype

### Advanced Image Lab

Add an admin-only Advanced Image Lab or equivalent experimental panel.

It should allow the owner to choose:

- Portrait Studio or scene-image trial;
- the source character and image;
- the requested change;
- Identity Priority, Controlled Composition, Balanced, or Style Priority;
- pose, depth, or edge control;
- an optional reviewed LoRA;
- whether to test a finishing pass;
- standard-versus-advanced comparison.

The result should show the images and their lineage as a comparison set rather
than quietly replacing an existing image.

### Portrait Studio

The ordinary Portrait Studio remains unchanged during the first prototype. An
Advanced Qwen action may open the lab with the selected character and source
already filled in.

### Scene images

The ordinary scene button remains unchanged. Admins receive an Advanced Qwen
rerender or lab action for selected chats. Proven profiles may later graduate to
the normal scene options.

### Clear ineligibility messages

The interface should explain when a workflow cannot run, including:

- no usable identity pack;
- too many required inputs for the model's capacity;
- missing or invalid control image;
- incompatible LoRA;
- unavailable model version;

It must not silently run a weaker recipe under the same label.

## Delivery stages

### Stage 0 — isolate and lock the baseline

Create the parallel, admin-only subsystem path. Reuse the same
`REPLICATE_API_TOKEN`, provider client, and shared image infrastructure while
leaving every ordinary picker and default untouched.

Pin or explicitly record the tested versions and run live capability probes.
Record current normal portrait-variant and scene results on a fixed corpus.

Exit: the lab can run and save an experimental job without changing normal image
behavior.

### Stage 1 — Qwen Image Edit Plus controlled portraits

Add Qwen Image Edit Plus as an experimental connector and prove numbered roles for:

- identity plus pose;
- identity plus depth;
- identity plus edge;
- identity plus outfit or style plus pose.

Start with reviewed control fixtures rather than waiting for the full spatial-scene
system.

Exit: the owner can compare controlled portrait results against the normal direct
edit baseline with complete saved settings.

### Stage 2 — controlled single-character scenes

Run simple single-character scenes through pose, depth, and edge recipes. Preserve
the detached scene-job behavior and compare each result against the ordinary scene
path.

Exit: at least one control type shows a repeatable structural improvement without
an unacceptable identity regression.

### Stage 3 — optional identity finishing

Pass selected controlled results through Qwen Image Edit 2511 using the identity
pack. Compare:

- direct 2511 edit;
- Edit Plus controlled result;
- Edit Plus followed by 2511 finishing.

Do not promote the finishing pass unless it improves identity without materially
changing structure, clothing, body, camera, lighting, or setting.

### Stage 4 — curated LoRA support

Add one known compatible style LoRA, reviewed strengths, prompt additions, and
complete provenance to the selected LoRA-capable connector.

Confirm that incompatible or unavailable LoRAs fail before provider spend.

### Stage 5 — one character LoRA pilot

Train or obtain one character LoRA from a reviewed, varied image set. Compare:

- identity-pack references only;
- character LoRA only where a fair comparison is possible;
- identity-pack references plus the character LoRA;
- controlled and uncontrolled Qwen paths.

Judge face identity, build consistency, outfit and background leakage, edit
obedience, structural control, latency, failure rate, and overall preference.

### Stage 6 — two-character controlled trials

Add carefully bounded two-character tests only after the single-character path
passes. Measure identity swapping, duplicated people, missing characters, pose
ownership, and whether one structural control can guide both people reliably.

### Stage 7 — promotion decision

Decide which parts, if any, should graduate into ordinary Portrait Studio or scene
controls.

A connector or mode may remain an admin tool even if another part of the subsystem
is promoted.

## Trial and evidence

The prototype should be judged against fixed examples rather than memorable best
cases.

Use several characters with different face shapes, hair, builds, visual styles,
and authored details. Include:

- close portraits;
- alternate-angle portraits;
- full-body poses;
- sitting and lying poses;
- simple object interactions;
- easy and difficult lighting;
- scenes where wardrobe and setting must remain stable;
- at least one unusual or non-human visual feature.

Reviewers should compare outputs without being told which workflow produced them.
The trial should answer:

- Did the structural control improve pose, framing, or depth?
- Does the result still look like the established character?
- Did Qwen make the requested change and avoid unrelated changes?
- Did the finishing pass help or damage the controlled draft?
- Does the LoRA add value beyond good references?
- Is any gain large enough to justify additional latency and provider cost?
- Can the same result be understood and retried from its saved record?

## Success criteria

The prototype succeeds when:

- it operates in parallel without changing the main dev-site image defaults;
- it uses the same Replicate environment configuration without creating a second
  provider implementation;
- pose, depth, and edge controls can each be run through a normal recorded job;
- at least one structural-control recipe materially outperforms the current
  baseline on the fixed corpus;
- required identity references are never displaced silently by optional style,
  location, or control inputs;
- Qwen Image Edit Plus alone and the optional 2511 finishing path are compared
  rather than assuming the more complicated path wins;
- at least one compatible LoRA can be selected, validated, run, and reproduced;
- the character LoRA pilot produces a clear evidence-based decision, including a
  valid decision not to ship it;
- a failed or ineligible advanced workflow leaves the source image and standard
  workflow untouched;
- every result records connector, model version, mode, ordered input roles, LoRA,
  seed, controls, and final settings well enough to compare or retry;
- the Qwen-specific layer does not duplicate shared storage, jobs, billing,
  authorization, or generic provider infrastructure;
- the boundary is clear enough to build Pony, Seedream, or another model subsystem
  with different connectors and workflows.

## Risks and safeguards

### Control maps share the ordinary image input

The Replicate Qwen Image Edit Plus interface accepts control maps in the same image
list as identity and style references. Vesper must preserve explicit roles,
ordering, and prompt wording so a pose map is never mistaken for a character
reference.

### More stages can produce a worse image

Every additional pass is optional and separately judged. The original controlled
result remains available, and a finishing pass is not accepted merely because one
facial detail improved.

### A LoRA can overpower the character

Use curated strength ranges and compare against a no-LoRA baseline. Character
training images should vary pose, expression, lighting, and clothing so the LoRA
does not learn one costume or background as identity.

### Three inputs are not many

Required identities always win. The workflow explains which optional input was
omitted and never hides a dropped character. Recipes are task-specific so a style
or location image is not sent merely because a slot happens to be free.

### Experimental work can leak into the normal site

Use separate experimental profiles, feature flags, routes, and labels. Do not
change normal defaults until the owner explicitly promotes a proven profile.

### Provider versions can change

Use tested versions during a trial and re-probe before activation. A model page's
marketing description is not sufficient proof that the active API schema still
supports the required inputs.

### Advanced controls can create a confusing interface

Expose a small number of goal-oriented modes. Raw provider settings and individual
trial arms belong in admin diagnostics, not normal player controls.

### A model-specific subsystem can become a second image platform

Keep shared responsibilities outside the Qwen layer. The subsystem describes how
to use Qwen; it does not own files, queues, billing, authorization, or generic
image records.

## Out of scope for the first implementation

- replacing Qwen Image 2512 for ordinary brand-new portraits;
- changing normal Portrait Studio or scene defaults;
- automatic LoRA training inside Vesper;
- arbitrary user-uploaded LoRAs;
- silent automatic face repair;
- pretending prompt wording creates a true mask;
- building a second pose or visual-state system;
- multi-character contact scenes before single-character controls pass;
- letting generated pixels alter authoritative character or world state;
- making a separate provider client merely for the lab;
- requiring a separate deployment before the Replicate-only prototype is proven.

## Recommended defaults for our review

- Build a Qwen-family subsystem, not a 2511-only subsystem.
- Make Qwen Image Edit Plus controlled composition part of the initial prototype,
  not a deferred optional stage.
- Test pose, depth, and edge independently before stacking controls.
- Keep Qwen Image Edit 2511 as an optional identity and LoRA finisher rather than
  assuming it belongs in every workflow.
- Reuse the same `REPLICATE_API_TOKEN` and shared Replicate client.
- Build an admin-only parallel lab path in the existing dev deployment.
- Keep all ordinary model selections and buttons unchanged during the trial.
- Keep identity packs as source truth even when a character LoRA is available.
- Write a technical specification only after this product direction is reviewed
  and settled.

## Points to review before implementation

The main decisions for the next revision are:

- whether the first vertical slice should include both a controlled portrait and
  a controlled scene, or prove portraits first;
- whether the existing seven-image test character set is suitable for the first
  character LoRA pilot;
- which initial control fixtures should be hand-reviewed pose, depth, and edge
  maps;
- whether Qwen Image Edit 2511 or a Qwen Image Edit Plus LoRA variant should be
  the preferred LoRA connector after live probing;
- how much of the Advanced Image Lab should later remain available to ordinary
  character owners;
