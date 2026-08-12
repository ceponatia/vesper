# Qwen-family advanced image subsystem — controlled portraits and scenes

Status: active (direction settled 2026-08-10; model ruled 2026-08-07 — build on
Qwen Image Edit 2511, Qwen Image Edit Plus is the fallback)

Outcome: The owner can run a portrait or scene through a controlled experiment —
supplying a pose or depth guide, a face reference, and an optional style — and
compare it side by side with the ordinary result, so that an advanced image
technique reaches players only when the comparison shows it is better.

Technical companion:
[qwen-advanced-image-subsystem.spec.md](qwen-advanced-image-subsystem.spec.md) —
the owner of implementation status and technical decisions.

## What this plan does not own

Every advanced technique below rides on machinery three sibling plans already
own. This plan owns only the Qwen-family recipes and the comparison lab that
judges them; where a capability appears in both places, the sibling plan is the
owner and this one is a consumer.

- [image-model-capabilities.plan.md](image-model-capabilities.plan.md) owns the
  shared model profiles, reference roles, controls, and Replicate transport every
  model-specific subsystem reuses. Two of its slices cover ground this plan
  assumes: its Qwen LoRA library slice owns hosted LoRA selection, scale
  validation, and compatibility, and its future-visual-controls slice owns the
  input-binding vocabulary for mask, pose, and depth images. This plan does not
  build a second copy of either.
- [image-render-quality.plan.md](image-render-quality.plan.md) owns prompt
  quality, identity trials, result review, and repair policy.
- [image-identity-packs.plan.md](image-identity-packs.plan.md) owns the canonical
  portrait and face-detail references used to preserve identity, and the
  profile-aware gate that decides whether they may be sent.
- [spatial-scene-images.plan.md](spatial-scene-images.plan.md) owns producing
  consistent pose, depth, mask, and segmentation controls from a validated scene
  frame. This plan consumes control maps; it does not invent a competing pose
  representation, and its first fixtures are hand-reviewed stand-ins for that
  system's later output.

## Which model this plan runs on

**Owner ruling (2026-08-07): build on Qwen Image Edit 2511. Register Qwen Image
Edit Plus only if 2511 turns out not to honour control maps.**

**Probe result (2026-08-11): 2511 honours control maps.** The Stage 0 pose and
depth generations each rendered the identity subject full-body in the control
fixture's arms-raised stance from a waist-up reference that carried no pose
signal, with identity preserved. Every stage below runs on 2511, and Qwen Image
Edit Plus is not registered.

2511 is already seeded, already probed, and already the default for scenes and
variants, so building on it costs no new registry work and keeps the experiment
on the better identity model. Plus is the older 2509-generation checkpoint under
a marketing name; 2511 is its successor.

The one fact the ruling left open was whether 2511 honours control maps —
documentation could not settle it in either direction:

- 2509 (shipped on Replicate as "Qwen Image Edit Plus") explicitly advertises
  native ControlNet support for depth, edge, and keypoint maps.
- 2511's model card never mentions ControlNet. It lists only what is new —
  reduced drift, character consistency, integrated LoRAs, geometric reasoning.
- But 2511 is described as "an enhanced version over Qwen-Image-Edit-2509", and
  **neither model exposes a control input at all**. The map travels as one of the
  numbered images and the model interprets it, so there is no interface through
  which the capability could have been removed — only training could have lost
  it, and an enhancement release is unlikely to have.

So the prior is that 2511 retains it, and one generation settles the question:
send a pose or depth map as a numbered image to 2511 with a matching instruction
and see whether the output honours the skeleton. This is Stage 0's first step. If
it holds, every stage below runs on 2511 and Plus is never registered. If it
fails, register and probe Plus as the controlled-composition connector and keep
2511 for identity finishing — the two-model shape the earlier draft assumed.

## Prerequisites

**All met as of 2026-08-11.** The shared render intent shipped (capabilities
slice 2, 2026-08-07), so every render lane describes its references by role, and
the two pieces Stage 1 was waiting on landed together:

- **Reference priority selection** (capabilities slice 3 remainder) — a profile's
  policy chooses which references survive when capacity is short, in what order,
  and the composing prompt strategy names each reference's role in the prompt.
- **Control-image roles** (capabilities slice 9) — pose, depth and edge images
  are routed by what the model declares, with `edge` now a reference role of its
  own. On 2511 that routing is the numbered-image path Stage 0 proved.

Owner ruling (2026-08-10): build Stage 0 first, then build these two pieces
under the capabilities plan as part of this same effort, then return here for
Stage 1. The lab never grows its own reference-arrangement code — that ruling
still binds every stage below.

Stage 1 is therefore unblocked. Its recipes select `multi_reference_compose` and
declare their control roles in the profile's `referencePolicy`; nothing in this
plan arranges provider inputs itself.

## Recommendation

Use a **Qwen-family subsystem** as Vesper's first advanced, model-specific image
prototype.

The subsystem combines Qwen workflows, each used for the job it actually
supports:

- **Qwen Image 2512** remains the normal starting point for a portrait created
  from text;
- **Qwen Image Edit 2511** is the controlled-composition connector, using pose
  keypoints, depth maps, edge maps, and ordinary visual references, and is also
  the identity connector; the LoRA connector is the dedicated Qwen LoRA
  explorer endpoint (see the finishing connector and Stage 4);
- **Qwen Image Edit Plus** is held in reserve, registered only if the Stage 0
  probe shows 2511 ignores control maps.

Running both roles on one model is the cheaper and better-identity arrangement,
and it keeps the prototype on a model the application already understands. Should
the probe fail, the roles split across two connectors and every stage below still
holds — only the model behind the controlled-composition connector changes.

## Current provider facts

The prototype should begin with a fresh live probe, but the following facts were
verified against the Replicate model pages on 2026-08-06.

**Neither model exposes a control input.** No field named `pose`, `depth`, or
`controlnet` exists on either Replicate interface. A control map is supplied as
one of the numbered images, and the prompt states which image carries identity,
pose, depth, clothing, location, or another role. That is still a real controlled
workflow, but it means Vesper must understand the role of every input image
rather than treating the inputs as an anonymous list — and it means no capability
probe can detect control support. Only a generated result can.

### Qwen Image Edit 2511 — the plan's model

Accepts up to three reference images, with instruction editing, seeds, and
quality controls. Already seeded, probed, and serving scenes and variants. It
exposes no LoRA input — re-verified against the live schema on 2026-08-11,
correcting the 2026-08-06 reading; its model card's "integrated LoRAs" phrase
describes built-in acceleration, not a loadable LoRA — so LoRA work runs on the
dedicated endpoint named under Stage 4.

Its model card does not mention ControlNet. It is nonetheless the expected
control-capable model: it is published as an enhancement over 2509, its feature
list covers only what is new, and control support lives in the weights rather
than in an interface that could have been dropped. Community ComfyUI workflows
report pose and depth control working on 2511. Stage 0 confirms this empirically
before anything is built on it.

### Qwen Image Edit Plus — the fallback

The 2509-generation checkpoint. Accepts one to three input images and explicitly
advertises native ControlNet support for pose or keypoint maps, depth maps, and
edge maps — the only Qwen edit model to document the capability outright.

It is older than 2511 and weaker at identity, so it is registered only if Stage 0
shows 2511 ignoring control maps. It has no registry row, no probed version, and
no page under `docs/image-models/`; registering and probing it would be the first
step of the fallback path.

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

The prototype should compare a controlled result against an optional identity
finishing pass. It must not assume that the finishing pass is better. A second
pass that improves the face but changes the pose, outfit, body, camera, lighting,
or setting is a regression — and when both passes run on 2511, the second pass
has to justify its cost against a model that has already seen the same
references.

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

Owner ruling (2026-08-10): the first fixture set is a hybrid. Pose skeletons and
depth maps are extracted from a few existing Vesper renders with standard
preprocessors, edge maps are computed directly from those renders, and two or
three skeletons are hand-authored for poses the gallery lacks (lying, kneeling).
Every fixture is reviewed before a trial uses it.

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

Owner ruling (2026-08-10): the LoRA library itself — hosting, compatibility,
scale validation, selection, provenance — is built once, as the capabilities
plan's Qwen LoRA library slice. This plan keeps only the comparison trials that
judge whether a LoRA earns its cost. A dedicated Qwen LoRA endpoint is
registered only if 2511's integrated support proves insufficient — and it did
(2026-08-11): 2511's live schema exposes no LoRA input, so that clause is
exercised and the dedicated endpoint under Stage 4 is the LoRA connector.

## Connector model

The subsystem should use separate connectors with explicit purposes rather than
one universal Qwen adapter.

### Generation connector

Uses Qwen Image 2512 for a new image created from text. It remains the normal
starting point for a portrait without a source image.

### Controlled-composition connector

Uses Qwen Image Edit 2511 with numbered visual roles — or Qwen Image Edit Plus
instead, if Stage 0 shows 2511 ignoring control maps. It is responsible for pose,
depth, edge, outfit, location, and other controlled combinations.

Because control maps travel through the same image list as ordinary references,
the connector must explicitly label every image's role and send them in a stable,
recorded order.

### Identity and LoRA finishing connector

Uses Qwen Image Edit 2511 for identity reinforcement. A trial that calls for a
LoRA runs on the live-probed Qwen LoRA endpoint instead — the official Qwen
Image Edit 2509 LoRA explorer, registered under Stage 4 once 2511's live schema
proved it takes no LoRA — because 2511 cannot load one.

This connector is optional for each job. A controlled result may be accepted
without a finishing pass when it is already better.

**When 2511 serves both roles, a finishing pass is a second pass of the same
model** — identity references, no control map, a narrower instruction. That is a
weaker prior than a genuine model change, so the trial must show the second pass
earning its cost rather than assuming it does. If the fallback path is taken and
the two connectors run different models, the finishing pass becomes a real model
change and the comparison regains its original force.

It remains behind the same subsystem boundary so the rest of Vesper does not need
to understand node names or workflow files.

## Qwen workflow modes

The visible vocabulary should stay small even though the underlying workflows are
technically intricate.

### Identity Priority

Uses the strongest eligible identity references, conservative instructions, and
an optional identity-finishing pass. This is the default advanced portrait mode.

### Controlled Composition

Uses pose, depth, or edge guidance through the controlled-composition connector.
It is the core experimental mode for both portraits and scenes.

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
- which reviewed LoRA a trial runs and the comparison that judges it (the LoRA
  library itself belongs to the capabilities plan);
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

Owner ruling (2026-08-10): the lab stays admin-only through the whole prototype.
Stage 7 decides which proven modes graduate into ordinary Portrait Studio or
scene controls; the raw lab itself remains admin tooling.

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

Owner ruling (2026-08-10): the first vertical slice proves both a controlled
portrait and a controlled scene — Stage 2 does not wait on a Stage 1 verdict.

### Stage 0 — isolate and lock the baseline

Status: complete — 2026-08-11; both probe verdicts are recorded in the spec.

Create the parallel, admin-only subsystem path. Reuse the same
`REPLICATE_API_TOKEN`, provider client, and shared image infrastructure while
leaving every ordinary picker and default untouched.

Pin or explicitly record the tested versions and run live capability probes.
Record current normal portrait-variant and scene results on a fixed corpus.

**First, settle the control question.** Send a pose or depth map to Qwen Image
Edit 2511 as a numbered image with a matching instruction, and check whether the
output honours the skeleton. This is one generation, and it decides the plan's
shape: if 2511 honours control maps, every stage below runs on it and Plus is
never registered; if it does not, register and probe Plus as the
controlled-composition connector and keep 2511 for identity finishing. Record the
result either way — no probe can answer this, so this generation is the only
evidence that will ever exist.

Exit: the control question is answered and recorded, and the lab can run and save
an experimental job without changing normal image behavior.

### Stage 1 — controlled portraits

Status: complete — 2026-08-11; the trial verdicts are recorded in the spec.

Prove numbered roles on the controlled-composition connector for:

- identity plus pose;
- identity plus depth;
- identity plus edge;
- identity plus outfit or style plus pose.

Start with reviewed control fixtures rather than waiting for the full spatial-scene
system.

Exit: the owner can compare controlled portrait results against the normal direct
edit baseline with complete saved settings.

### Stage 2 — controlled single-character scenes

Status: complete — 2026-08-11; the trial verdicts are recorded in the spec.

Run simple single-character scenes through pose, depth, and edge recipes. Preserve
the detached scene-job behavior and compare each result against the ordinary scene
path.

Exit: at least one control type shows a repeatable structural improvement without
an unacceptable identity regression.

### Stage 3 — optional identity finishing

Status: complete — 2026-08-11; conditionally viable — verdicts and the
conditions are recorded in the spec.

Pass selected controlled results through Qwen Image Edit 2511 using the identity
pack. Compare:

- direct 2511 edit, no control map;
- the controlled result;
- the controlled result followed by an identity-finishing pass.

Do not promote the finishing pass unless it improves identity without materially
changing structure, clothing, body, camera, lighting, or setting.

### Stage 4 — curated LoRA support

Status: complete — 2026-08-11. The library, the lab wiring, the registered
connector, all five pre-spend refusal checks and both style-LoRA arms are done
and ruled on: a curated LoRA can be selected, validated, run, and reproduced
from its record, and an incompatible or unreachable one is refused before any
money is spent.

Run one known compatible style LoRA through the finishing connector, consuming
the capabilities plan's LoRA library slice for hosting, compatibility, scale
validation, prompt additions, and provenance rather than building any of that
here.

Confirm that incompatible or unavailable LoRAs fail before provider spend.

Finding (2026-08-11): Qwen Image Edit 2511 exposes no LoRA input at all on its
live schema, so the finishing connector for LoRA runs is the dedicated Qwen
LoRA endpoint the ruling below reserved — the official Qwen Image Edit 2509
LoRA explorer, which loads a hosted LoRA by link and runs without one when no
link is given, letting the same pinned model produce the no-LoRA comparison
arm. The trial protocol and endpoint facts are in the
[spec](qwen-advanced-image-subsystem.spec.md).

### Stage 5 — one character LoRA pilot

Status: complete — 2026-08-11. A character LoRA improves identity alongside
identity-pack references (owner ruling; the verdicts and the whole pipeline
record are in the spec). The LoRA alone drifts, which the owner attributes to a
training set that was not varied enough rather than to the technique, so how
good a character LoRA can get is handed to a LoRA training tool in the admin
dashboard — parked in [deferred.plan.md](deferred.plan.md), wanted so a more
sophisticated LoRA can be trained. Owner rulings at kickoff (2026-08-11): the pilot subject is Sabrina
Vale, and the training set is her curated identity-faithful renders plus
synthesized variants to about twenty images — a training set is assembled only
from images whose generation provenance is verifiable, which the app's own
renders are by construction.

Train or obtain one character LoRA from a reviewed, varied image set. Compare:

- identity-pack references only;
- character LoRA only where a fair comparison is possible;
- identity-pack references plus the character LoRA;
- controlled and uncontrolled Qwen paths.

Judge face identity, build consistency, outfit and background leakage, edit
obedience, structural control, latency, failure rate, and overall preference.

### Stage 6 — two-character controlled trials

Status: complete — 2026-08-12; the owner accepted its verdicts (six arms,
protocol and results in the [spec](qwen-advanced-image-subsystem.spec.md)). Held
both characters uncontrolled, under depth, and under a two-person pose skeleton;
lost one only when the control fixture described a single body.

Add carefully bounded two-character tests only after the single-character path
passes. Measure identity swapping, duplicated people, missing characters, pose
ownership, and whether one structural control can guide both people reliably.

### Stage 7 — promotion decision

Status: in progress — the promotion is ruled; the first of its three items (two
characters in one chat scene image) is built 2026-08-12 and awaiting a look on
the deploy, and the other two each owe one design ruling. The assessment behind
the ruling is in the [spec](qwen-advanced-image-subsystem.spec.md)
§"Stage 7 promotion assessment".

Decide which parts, if any, should graduate into ordinary Portrait Studio or scene
controls.

A connector or mode may remain an admin tool even if another part of the subsystem
is promoted.

The assessment weighed five candidates — two characters in one chat scene image,
edge-controlled portrait variants, depth-controlled scenes, the identity-finishing
pass, and LoRA use in ordinary lanes — against what each would cost.

**Owner ruling (2026-08-12): three of the five graduate.**

- **Two characters in one chat scene image** — a chat whose roster holds two
  characters currently renders scene images showing one of them. The cast renders
  automatically, with no toggle, **when two characters are established as being in
  the same location**; a roster entry who is not in the current scene is not drawn
  into it.
- **Edge-controlled portrait variants** — the reliable control that costs no
  provider call.
- **A reviewed style LoRA in an ordinary lane**, behind a curated profile.

Depth-controlled scenes and the identity-finishing pass stay admin-only. Both are
blocked on plans that have not started — a production source of control maps, and
authored appearance attributes — and neither blocker is this plan's to remove.

Delivery order and the remaining design rulings each promotion needs are in the
spec's §"Stage 7 promotion delivery".

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
- the controlled result alone and the optional finishing path are compared rather
  than assuming the more complicated path wins;
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

The Replicate Qwen edit interfaces accept control maps in the same image list as
identity and style references — this is true of 2511 and Plus alike. Vesper must
preserve explicit roles, ordering, and prompt wording so a pose map is never
mistaken for a character reference.

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

## Recommended defaults

- Build on Qwen Image Edit 2511, and settle the control question with one
  generation before building anything on top of it.
- Make controlled composition part of the initial prototype, not a deferred
  optional stage.
- Test pose, depth, and edge independently before stacking controls.
- Treat the identity and LoRA finishing pass as optional and evidence-gated
  rather than assuming it belongs in every workflow.
- Reuse the same `REPLICATE_API_TOKEN` and shared Replicate client.
- Build an admin-only parallel lab path in the existing dev deployment.
- Keep all ordinary model selections and buttons unchanged during the trial.
- Keep identity packs as source truth even when a character LoRA is available.

## Open questions

- how to deliver outfit control, given that filling the model's three-reference
  capacity collapses identity. Both wardrobe runs — identity plus a control map
  plus an outfit reference, the model's full capacity — produced a different
  person and ignored the pose, under two different instructions, while every
  two-reference run preserved identity at least moderately (the trial results in
  the [spec](qwen-advanced-image-subsystem.spec.md) record both). Two parts need
  answering: why crowding at capacity costs identity rather than an optional
  role, and what shape outfit control should take instead — a separate pass over
  a finished image, a wardrobe-specific recipe, or a model with more reference
  room. Owner ruling (2026-08-11): Stage 1 and Stage 2 are accepted as they
  stand, identity plus one control is the proven configuration, and the wardrobe
  pipeline is future work outside that acceptance.
- where the identity-finishing pass gets its appearance text in production.
  Stage 3 proved the pass only helps when its instruction describes the
  character's hair, eyes, brows and face shape: with the instruction blank it
  invented hair colour and recropped the frame in every run, and with that text
  supplied it improved two of three (the verdicts are in the
  [spec](qwen-advanced-image-subsystem.spec.md)). The trial text was
  hand-derived from the canonical reference because the trial character carries
  no authored appearance attributes at all. A promoted finishing pass therefore
  depends on characters carrying authored facial and hair attributes, which is
  [character-schema.plan.md](character-schema.plan.md)'s ground — the question
  for Stage 7 is whether that plan supplies the text, whether the lab derives it
  another way, or whether the pass stays admin-only until one of those exists.
