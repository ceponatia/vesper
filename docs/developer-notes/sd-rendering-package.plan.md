# Stable Diffusion Rendering Package Plan

**Package:** `@vesper/image-sd`  
**Status:** active  
**Outcome:** The owner can offer Stable Diffusion as another set of image profiles in the existing pickers, so that characters keep a trained, consistent identity that the newer closed image models cannot reliably provide.  
**Primary family:** SDXL  
**Secondary family:** Stable Diffusion 3.5  
**Provider:** Replicate  
**Primary deployment method:** Vesper-owned Cog/ComfyUI workflow exposed as a normal Replicate model

## 1. Goal

Build a dedicated Stable Diffusion package that gives Vesper's SD models the customization they need to compete reasonably with Qwen, Seedream, and other newer image models without creating a second image-generation system.

The package should provide Stable Diffusion with:

- character-specific LoRAs;
- reference-based identity conditioning using PuLID or an equivalent identity adapter;
- pose, depth, and other ControlNet conditioning;
- Stable Diffusion-specific generation settings;
- targeted inpainting and repair;
- a controlled finishing/upscale pass;
- reproducible training and evaluation recipes;
- SDXL-first support with room for SD3.5-specific workflows later.

The package must plug into Vesper's **existing image model registry, profiles, render intent, Replicate transport, jobs, image storage, and web UI selectors**.

A user should experience Stable Diffusion as another set of image profiles in the existing UI, not as a separate subsystem.

---

# 2. Core architectural rule

`@vesper/image-sd` is a **Stable Diffusion implementation package**, not an alternative to `@vesper/image-core`.

The package hierarchy should be:

```text
                         @vesper/contracts
                                ▲
                                │
                      @vesper/image-core
                         ▲             ▲
                         │             │
              @vesper/image-sd   @vesper/image-replicate
                         ▲             ▲
                         └──────┬──────┘
                                │
                           @vesper/web
```

`@vesper/image-sd` may depend on:

- `@vesper/image-core`;
- `@vesper/contracts`;
- package-owned Stable Diffusion workflow/configuration dependencies.

It must **not** depend on:

- the web application;
- Next.js;
- Vesper's database;
- character or chat contracts;
- `@vesper/image-replicate`;
- ambient environment variables.

The web application remains the bridge between the Stable Diffusion package and the Replicate transport.

The workspace package-boundary checker must be updated to explicitly allow:

```text
@vesper/image-sd -> @vesper/image-core -> @vesper/contracts
```

No cross-workspace relative imports or deep imports are permitted.

---

# 3. What the package owns

The package should own knowledge that is specifically about operating Stable Diffusion well.

### Generation recipes

Examples:

- SDXL base portrait;
- SDXL identity-preserving portrait/variant;
- SDXL character scene;
- SDXL ControlNet scene;
- SDXL inpainting repair;
- SDXL finishing/detail pass;
- later SD3.5 ControlNet variants.

A recipe defines Stable Diffusion behavior, not Vesper game state.

For example, a recipe may specify:

- checkpoint family;
- sampler;
- scheduler;
- step range;
- CFG;
- identity-adapter weight;
- ControlNet strengths;
- ControlNet start/end points;
- inpainting denoise;
- finishing denoise;
- internal resolution;
- LoRA behavior.

### Deployment workflow

The package should contain the reproducible workflow used to create the Vesper-owned Replicate deployment.

Conceptually:

```text
prompt
  +
negative prompt
  +
identity reference
  +
character LoRA
  +
optional pose/depth control
        │
        ▼
     SDXL base
        │
        ▼
 targeted repair if required
        │
        ▼
 low-denoise finishing pass
        │
        ▼
      output
```

Initially this can be developed as a ComfyUI workflow.

Once the recipe is validated, it should be frozen into a versioned Vesper-owned Replicate/Cog deployment rather than leaving production dependent on arbitrary workflow JSON.

### Training recipes

The package should define how a Vesper character LoRA is prepared and evaluated.

It receives generic image/training manifests. It does not load characters from Vesper itself.

### Stable Diffusion evaluation fixtures

The package should contain deterministic settings and fixture definitions necessary to compare workflow revisions.

It should not own the saved evaluation results; Vesper or the Advanced Image Lab owns those records.

---

# 4. What remains outside the package

The web application continues to own:

- resolving a character's current visual state;
- identity-pack lookup;
- selecting character reference images;
- deciding which characters are present;
- clothing/location/item state;
- authorization;
- DB persistence;
- image jobs;
- image assets;
- profile selection;
- character-to-LoRA association;
- Replicate credentials;
- provider calls;
- UI state;
- gallery behavior.

`@vesper/image-core` continues to own:

- model capabilities;
- image profiles;
- reference roles;
- normalized render intent;
- reference ordering;
- prompt fitting;
- LoRA control contracts;
- render planning;
- render provenance;
- failure vocabulary.

`@vesper/image-replicate` continues to own:

- Replicate API access;
- model probing;
- file transport;
- prediction execution;
- provider response normalization.

There should be no Stable Diffusion API client inside `@vesper/image-sd`.

---

# 5. Replicate model design

## Vesper-owned SDXL renderer

The long-term production target should be a Vesper-owned Replicate model, conceptually:

```text
vesper/sdxl-character-render
```

Its public input contract should deliberately use names the existing Vesper capability probe understands whenever possible.

Suggested inputs:

```text
prompt
negative_prompt

reference_image
pose_image
depth_image
mask_image
source_image

lora_weights
lora_scale

seed
width
height

recipe
```

Optional low-level parameters can also exist, but Vesper should normally select them through a recipe/profile instead of sending arbitrary values on every render.

The wrapper should expose one stable output image.

### Important design rule

Complexity belongs **inside the Vesper SD renderer**.

The ordinary Vesper image path should not have to know that one prediction internally performed:

1. PuLID;
2. ControlNet;
3. SDXL sampling;
4. inpainting;
5. a low-denoise finishing pass.

From Vesper's perspective it was one image render.

This keeps:

- jobs unchanged;
- cost accounting understandable;
- image provenance coherent;
- retries simple;
- the player UI unchanged.

---

# 6. Model strategy

## SDXL — primary customizable family

SDXL should be the first target because its supporting ecosystem is considerably more mature.

The first checkpoint evaluation should include at least:

- a strong realistic SDXL checkpoint with commercially acceptable terms;
- vanilla/base SDXL as a control.

Do not lock Vesper to a community checkpoint until licensing and hosted-product use are explicitly reviewed.

## SD3.5 — secondary family

Keep the existing SD3.5 Large integration.

Do not try to force SDXL and SD3.5 through identical internal workflows.

Later, `@vesper/image-sd` can carry separate recipe families:

```text
sdxl/*
sd35/*
```

SD3.5 becomes especially interesting for its own ControlNet implementations and stronger native prompt comprehension.

---

# 7. Starting generation settings

These values are **trial starting points**, not permanent defaults.

For the initial realistic SDXL trial:

| Setting | Initial target |
|---|---|
| Native portrait size | 832 × 1216 |
| Steps | 30–40 |
| CFG | approximately 4–6 |
| Sampler | DPM++ family |
| Scheduler | Karras where supported |
| Character LoRA | around 0.7–0.9 |
| PuLID identity weight | test 0.65 / 0.80 / 0.95 |
| Depth ControlNet | test roughly 0.45–0.70 |
| Pose ControlNet | test roughly 0.65–0.85 |
| Repair denoise | roughly 0.30–0.55 |
| Replacement inpaint denoise | roughly 0.55–0.70 |
| Finishing denoise | roughly 0.20–0.30 |
| Finishing upscale | roughly 1.25–1.5× |

Only one variable should move at a time during the initial tuning passes.

The winning values become versioned SD recipe defaults.

---

# 8. Identity architecture

Stable Diffusion character identity should use three layers with different purposes.

## Layer 1 — Identity pack

Vesper's existing identity pack remains the canonical visual source.

No Stable Diffusion-specific reference collection should be created separately.

## Layer 2 — Character LoRA

Train a character LoRA from the identity pack.

Start with approximately **12–20 carefully selected images**, rather than automatically using every available image.

The set should intentionally contain:

- front view;
- three-quarter views;
- profiles;
- close face;
- upper body;
- full body;
- different expressions;
- multiple lighting conditions;
- varied backgrounds;
- varied clothing.

The dataset must minimize accidental correlations such as:

> this character always wears this shirt

or:

> this character always appears in this room.

Test at least:

- rank 8;
- rank 16.

The winning training recipe becomes package-owned configuration.

## Layer 3 — Runtime identity adapter

Use PuLID initially.

The character LoRA gives Stable Diffusion a learned representation of the person, while PuLID anchors an individual render against an actual current identity reference.

Neither should automatically be run at maximum strength.

The combined system should be tested specifically for:

- face similarity;
- age;
- hair;
- body build;
- skin tone;
- ability to change clothing;
- ability to change pose;
- ability to change location;
- expression flexibility.

---

# 9. LoRA storage and character association

Continue using Vesper's existing `image_loras` library for actual LoRA records.

Do not create a second Stable Diffusion LoRA library.

Add a small Vesper-owned association between an identity pack and its trained identity LoRA.

Conceptually:

```text
identity pack
     │
     ▼
identity LoRA binding
     │
     ▼
image_loras row
```

The binding should record enough provenance to determine whether the LoRA is stale after the identity pack changes.

At minimum:

- identity pack ID;
- LoRA ID;
- model family/checkpoint compatibility;
- training dataset fingerprint;
- training recipe/version;
- creation date;
- active/retired state.

The association belongs to the application/database layer, not `@vesper/image-sd`.

---

# 10. Existing LoRA limitation

Vesper currently models one LoRA selection per render.

Keep that limitation for the first production slice.

The first Stable Diffusion recipe should use that slot for the **character identity LoRA**.

Do not add multi-LoRA support merely because Stable Diffusion can use it.

After identity rendering works, separately evaluate whether combining:

```text
character LoRA
+
style LoRA
```

provides enough benefit to justify extending `controls.lora` into a bounded LoRA list.

If implemented later, use a small explicit cap such as 2–3 rather than arbitrary stacking.

---

# 11. ControlNet architecture

The existing `image-core` reference vocabulary already distinguishes:

- `pose`;
- `depth`;
- `edge`;
- `mask`;
- generic `control`.

Use those roles rather than creating Stable Diffusion-specific reference types.

## Initial priority

1. **Depth**
2. **Pose**
3. Edge/Canny only if trials prove useful

Depth should be the first production experiment because the existing SDXL PuLID wrapper already exposes a depth ControlNet input that Vesper currently leaves unused.

## Control extraction

The Advanced Image Lab already has pose/depth preprocessing.

Production rendering should not import Image Lab code.

Before ControlNet reaches ordinary scenes, extract the reusable preprocessing operation into a shared server-side image service used by both:

```text
Advanced Image Lab
        │
        ▼
shared control-image extraction
        ▲
        │
production image rendering
```

The pure role contracts remain in `@vesper/image-core`.

Provider IO remains outside it.

---

# 12. Inpainting policy

Inpainting is a **repair mechanism**, not the normal path for changing authored character state.

Do not make the default pipeline:

```text
generate one state
→ remove part of it
→ regenerate another state
```

If Vesper's authored visual state says something should be visible, the base render should generate that state directly.

Use inpainting for localized failures such as:

- malformed hand;
- broken clothing boundary;
- incorrect small object;
- face artifact;
- accidental extra object;
- local anatomy defect;
- occlusion repair.

This reduces seams and preserves lighting/composition.

---

# 13. Face swapping

Face swapping is out of scope for the initial package.

The package should prefer:

```text
LoRA + PuLID
```

over:

```text
generate stranger + replace face
```

Reasons include:

- licensing complications around several common face-swap stacks;
- face swaps correct only part of identity;
- mismatched lighting and head geometry;
- hair/body identity remains unresolved;
- additional processing and artifact risk.

The architecture does not need to permanently forbid a future licensed identity-repair model, but production should not depend on one.

---

# 14. Stable Diffusion profiles

The Vesper-owned Replicate deployment should register as a normal `image_models` row.

Profiles then expose its capabilities to existing surfaces.

## Initial profiles

### `sdxl-base-portrait`

**Task:** `portrait`  
**Operation:** generate

Use for creating a new character image when no learned identity exists yet.

No identity reference required.

---

### `sdxl-identity-variant`

**Task:** `variant`  
**Operation:** edit

Requires:

- identity reference.

Uses when available:

- character LoRA;
- PuLID identity conditioning.

Optional:

- outfit;
- style;
- pose/depth controls.

---

### `sdxl-chat-look`

**Task:** `chat_look`  
**Operation:** edit

Same identity architecture as variants, optimized for character appearance updates used by chat.

---

### `sdxl-character-scene`

**Task:** `scene`  
**Operation:** edit

Initially experimental.

Uses:

- identity;
- character LoRA;
- location where available;
- outfit;
- optional pose/depth;
- optional objects.

This should **not become the global scene default** until multi-character behavior is specifically validated.

---

# 15. Web UI integration

Stable Diffusion must use the existing image profile flow.

No `/api/stable-diffusion/*` player endpoints.

No separate Stable Diffusion model selector.

No Stable Diffusion settings page for ordinary users.

Profiles are returned through:

```text
GET /api/image-profiles?task=<task>
```

and automatically appear under their model label in the existing shared picker.

That gives us:

| Web feature | Profile task |
|---|---|
| Portrait Studio — new portrait | `portrait` |
| Portrait Studio — variant | `variant` |
| Chat character appearance | `chat_look` |
| Chat scene strip | `scene` |
| Scenario modal | `scene` |

The existing model/profile admin page continues to manage whether each profile is enabled and offered.

The Advanced Image Lab remains the place for experimentation.

---

# 16. Normal render route

The ordinary production path remains:

```text
Web UI
   │
   ▼
existing portrait / variant / scene route
   │
   ▼
resolveImageProfileForTask
   │
   ▼
build Vesper prompt + references
   │
   ▼
ImageRenderIntent
   │
   ▼
renderImageIntent
   │
   ▼
@vesper/image-core planner
   │
   ▼
renderWithModel
   │
   ▼
@vesper/image-replicate
   │
   ▼
Vesper SD Replicate model
   │
   ▼
normal image persistence
```

Do not create an SD-specific branch in every image lane.

If a family-specific application hook eventually becomes necessary, add **one** preparation seam immediately before `renderImageIntent`, not separate logic in portrait, variant, scene, and chat routes.

Prefer avoiding that hook entirely during the first implementation.

---

# 17. Stable Diffusion-specific controls

Do **not** immediately add every ComfyUI setting to `image-core`.

Checkpoint-specific controls such as:

- sampler;
- scheduler;
- PAG;
- ADetailer;
- refiner switches;
- internal denoise values;

should initially live inside the SD recipe or profile `providerOverrides`.

Promote something into `image-core`'s normalized capability vocabulary only when:

1. another model family needs the same concept; or
2. Vesper needs to vary it dynamically at runtime.

This prevents Stable Diffusion from turning the provider-neutral core into a ComfyUI schema.

One core change *is* justified early:

### Add an identity-conditioned edit kind

Status: built 2026-08-23 (landed with Stage 2) — `identity_conditioned` is in the edit-kind vocabulary and passes the identity-critical eligibility screen; flipping existing model rows to it remains an owner review action.

The current PuLID model has to use `editKind = unknown` because none of the current values describe an identity adapter.

Add something conceptually equivalent to:

```text
identity_conditioned
```

This makes eligibility and diagnostics accurately describe PuLID/InstantID-style pipelines.

---

# 18. Multi-character scenes

Treat this as a separate problem.

Do not assume that because the single-character recipe works, arbitrary group scenes work.

The first scene trial must explicitly test:

- one character;
- two characters;
- identity crossover;
- face duplication;
- LoRA identity bleeding;
- incorrect wardrobe assignment;
- reference-to-subject association.

Until the two-character trial passes, Stable Diffusion scene profiles remain non-default.

If reliable multi-subject identity requires multiple LoRAs, regional conditioning, or subject masks, design that as its own later slice rather than contaminating the initial renderer.

Qwen/Seedream can remain the preferred multi-character renderers meanwhile.

---

# 19. Negative prompts

Stable Diffusion should use the model-aware negative prompt system rather than one universal negative string.

The SD package may define SD-specific negative-prompt recommendations, but it should receive the final authored positive/negative content from Vesper rather than interpreting character state itself.

Negative construction must remain aware that legitimate renders can contain:

- unusual anatomy;
- missing limbs;
- prosthetics;
- text;
- logos;
- blur;
- non-human features;
- authored wardrobe/exposure states.

Never blindly inject generic terms that contradict canonical visual state.

---

# 20. Development stages

## Stage 0 — Freeze the baseline

Status: queued — needs owner-priced baseline renders; Stage 1 landed without it (no behavior changes).

Capture the current quality of:

- SD3.5 Large;
- current SDXL PuLID;
- Qwen portrait/variant;
- Qwen/Seedream scenes.

Use fixed characters, prompts, references, and seeds where available.

These outputs become the comparison baseline.

No production behavior changes.

---

## Stage 1 — Create `@vesper/image-sd`

Status: complete — 2026-08-22.

Add:

- package manifest;
- package-local TypeScript project;
- package-local tests;
- curated root exports;
- README;
- workspace boundary policy;
- recipe contracts;
- training-manifest contracts;
- deployment directory.

Run the complete repository verification gate.

No image behavior changes.

---

## Stage 2 — Build the Vesper SDXL Replicate renderer

Status: complete — 2026-08-23. Deployed as `ceponatia/sdxl-character-render` (private, frozen per the runbook in `packages/image-sd/deployment/README.md`), registered in Vesper with no surfaces and no profiles, so only the Advanced Image Lab reaches it.

Prototype the workflow in ComfyUI.

Implement:

- SDXL checkpoint;
- prompt/negative prompt;
- native 832×1216 output;
- PuLID identity input;
- one LoRA;
- optional depth;
- optional pose;
- deterministic seed;
- Stable Diffusion recipe selection.

Deploy as an experimental Vesper-owned Replicate model.

Register it in Vesper.

Offer it only to the Advanced Image Lab initially.

---

## Stage 3 — Tune identity before adding complexity

Status: PuLID arms run and graded 2026-08-23 — provisional identity recipe is `sdxl/identity-portrait` (0.80); verdict in `sd-rendering-package.trial.md`. Remaining before this stage closes: the LoRA-only and LoRA + PuLID arms (blocked on Stage 4's trained LoRA) and a re-roll of the three weak fixture seeds.

Run a controlled matrix for:

- base SDXL;
- PuLID only;
- LoRA only;
- LoRA + PuLID.

For PuLID, test at least three identity strengths.

Grade:

- face;
- age;
- hair;
- build;
- clothing flexibility;
- pose flexibility;
- state obedience.

Select a provisional identity recipe.

Do not add ControlNet until this stage has a clear winner.

---

## Stage 4 — Character LoRA training

Create a repeatable training pipeline from an identity pack.

Compare:

- rank 8;
- rank 16.

Record:

- dataset fingerprint;
- training recipe;
- base checkpoint;
- resulting weights;
- trigger token;
- model compatibility.

Store the resulting LoRA through the existing LoRA library.

Add identity-pack-to-LoRA association.

Still experimental.

---

## Stage 5 — Depth ControlNet

Promote reusable depth preprocessing out of the Image Lab-only implementation.

Run:

```text
identity recipe
vs.
identity recipe + depth
```

Test multiple depth strengths.

Promote only if pose/composition improves without unacceptable identity or prompt degradation.

This stage should also exercise the existing SDXL PuLID model's currently-unused depth input as a comparison.

---

## Stage 6 — Pose ControlNet

Repeat the same process for pose.

Evaluate separately from depth before testing them together.

Then test:

```text
identity
identity + pose
identity + depth
identity + pose + depth
```

Do not assume more controls means a better render.

---

## Stage 7 — Repair and finishing

Add targeted inpainting.

Add the low-denoise finishing/upscale pass.

Compare:

- no finishing;
- finishing only;
- repair + finishing.

Measure whether finishing actually improves details without changing identity.

ADetailer/refiner-style passes should remain experimental until this comparison proves they are worth the additional complexity.

---

## Stage 8 — Connect portrait and variant UI

Seed and enable:

- `sdxl-base-portrait`;
- `sdxl-identity-variant`;
- `sdxl-chat-look`.

They automatically appear through the existing profile APIs and pickers.

Keep them non-default at first.

Perform a production-path smoke test through the actual Portrait Studio and chat appearance flow—not only through the Image Lab.

---

## Stage 9 — Scene integration

Add `sdxl-character-scene`.

Test ordinary production scene routing, not merely the lab.

Validate:

- location fidelity;
- clothing;
- identity;
- physical composition;
- object inclusion;
- crop;
- scene continuity.

Run the dedicated two-character trial.

Only after this passes should SD be considered a serious general-purpose scene option.

---

## Stage 10 — Promotion decision

Compare the best SD recipe against current Vesper models using the same inputs.

Evaluate:

- identity;
- state fidelity;
- composition;
- anatomy;
- hands;
- clothing accuracy;
- location accuracy;
- prompt adherence;
- visual quality;
- repetition;
- latency;
- cost;
- provider failure rate.

The goal is **not necessarily for SDXL to beat Qwen overall**.

Promotion succeeds if Stable Diffusion becomes valuable where its customization ecosystem provides something the newer monolithic models cannot reliably provide.

---

# 21. First experiment before building the package

Before committing to the full package, run one cheap architectural proof.

Use the existing SDXL PuLID integration.

Vesper already supplies:

```text
identity reference
width/height
method=fidelity
```

Add its existing but unused `depth_image`.

Then run a controlled matrix over:

```text
face_weight
×
depth_strength
×
sampler
```

using an existing identity pack.

If depth-guided PuLID materially improves identity + composition, it validates the central package architecture:

```text
structured references
+
identity conditioning
+
structural conditioning
+
Stable Diffusion
```

If it does not, investigate that result before building the LoRA/training portion.

---

# 22. Explicit non-goals

The initial package does **not**:

- replace `@vesper/image-core`;
- replace Replicate;
- create separate player-facing image routes;
- create a separate Stable Diffusion UI;
- make SD the default renderer;
- implement arbitrary ComfyUI graphs submitted by users;
- implement arbitrary extension/node installation;
- support unlimited LoRAs;
- rely on face swapping;
- use DreamBooth in the first training pass;
- use textual inversion in the first training pass;
- promise reliable multi-character rendering before it is tested;
- expose every Stable Diffusion knob to players;
- duplicate identity packs;
- duplicate the LoRA library.

---

# 23. Definition of done

The package is ready for normal Vesper use when:

1. `@vesper/image-sd` obeys monorepo boundaries and owns its tests.
2. A Vesper-owned SDXL workflow is reproducibly deployable on Replicate.
3. The deployment registers through the existing image-model probe.
4. It renders through `renderImageIntent` without an alternate production route.
5. Character identity can use both an identity pack and a trained LoRA.
6. PuLID/identity conditioning has a measured configuration.
7. Pose/depth controls have measured configurations rather than guessed defaults.
8. Inpainting and finishing are localized internal workflow tools.
9. Portrait/variant/chat profiles appear through the existing image profile picker.
10. Scene support is promoted only after dedicated scene and multi-character trials.
11. Render provenance still records the resolved model, profile, controls, references, seed, prediction, and version.
12. Disabling every SD profile restores current Vesper behavior without code changes.

That last requirement is important: **Stable Diffusion should enter Vesper as an optional model-family capability, not as an invasive rewrite of the image system.**

Owner ruling (2026-08-23): the vendored PuLID node's dead middle-block
attention patches are corrected at build time, so the Vesper renderer applies
identity conditioning at all attention blocks. This diverges deliberately from
the public ComfyUI PuLID baseline (including `nsfw-api/sdxl-pulid`), and Stage
3 comparisons against that model must account for it. Detail:
`packages/image-sd/deployment/README.md`.