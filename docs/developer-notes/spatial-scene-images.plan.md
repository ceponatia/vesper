# Spatially controlled scene images — pose, depth, and character identity

Status: draft (written 2026-07-20; not started — no spatial contract, template,
solver, renderer, or worker exists in the codebase, and Gate 0 has not been run)

Outcome: A player can see a scene image in which each character is posed and
positioned the way the story just described and still looks like themselves, so
that the picture stops contradicting the text it illustrates.

This plan graduates the self-hosted ComfyUI / pose-control follow-up in
[deferred.plan.md](deferred.plan.md). It extends the shipped provider and lineage
foundation in [finished/scene-images.plan.md](finished/scene-images.plan.md) and
the runtime documented in [docs/images/](../images/README.md).

Neighbouring plans, all of which moved under it after this one was written:

- [image model registry](finished/image-model-registry.plan.md) made the model list data
  and **removed Venice entirely** (owner ruling 2026-08-05) — Replicate is the
  only provider, and the fallback ladder is now one model using fewer references;
- [image model capabilities](image-model-capabilities.plan.md) owns profiles,
  role-aware references, controls, and seeds — the transport any structural
  control would travel through;
- [image identity packs](image-identity-packs.plan.md) shipped the single-view
  identity pack this plan assumed it would have to build;
- [Qwen advanced image subsystem](qwen-advanced-image-subsystem.plan.md) proposes
  a **competing, cheaper first step**: the hosted Qwen edit models accept pose,
  depth, and edge maps as numbered input images, so a controlled experiment may
  be reachable without a GPU worker at all. That plan now runs on the
  already-seeded Qwen Image Edit 2511 (owner ruling 2026-08-07), making it
  cheaper still. That plan and Gate 0 below answer the same question and should
  not both be opened. **Answered (2026-08-11):** that lab's Stage 0 probe
  confirmed hosted 2511 honours pose and depth maps supplied as numbered
  images, so Gate 0's spike does not run separately; this plan's remaining
  distinct value is producing consistent controls from a validated spatial
  frame.
- [scene composition](scene-composition.plan.md) is the **prompt-only near-term
  treatment** of camera vantage, subject facing, and intimate staging — no
  structural control, reachable without paid gates. Its camera and staging
  vocabularies are candidate inputs to this plan's pose-template intents.

The direction in one sentence:

> Resolve one small, explicit 3D scene; derive pose and depth controls from it;
> then let image models render appearance while validation protects structure,
> character identity, wardrobe, POV, and policy invariants.

## Goal

Generate realistic images in which recurring fictional adult characters:

- remain recognizably the same person across scenes;
- occupy the requested pose, orientation, and depth order;
- preserve current body, hair, distinguishing features, and wardrobe;
- meet at intended contact points without limb-ownership errors;
- obey first-person/embodied-viewer framing;
- can use an eligible mature-content route; and
- fall back to today's scene workflow if structural control is unavailable.

The missing piece is a shared spatial representation. Prose does not uniquely
specify joints, occlusion, support, reach, or which reference belongs to which
posed body. The image system must not invent private geometry that conflicts
with story truth. A versioned spatial frame should eventually serve image
controls, narrator reachability, debugging, and motion.

Character chat remains the test bed. The session lane is not changed implicitly.

## Non-goals

- General physics or medically exact biomechanics.
- Unrestricted LLM-authored joint coordinates.
- A visible 3D-avatar product.
- Moving image generation onto the turn's critical path.
- Treating generated pixels as authoritative state.
- Training a foundation model.
- Shipping video in the still-image milestones.

## Decisions

1. **One 3D source produces all structural controls.** OpenPose, depth,
   segmentation, masks, and preview geometry share one camera and posed scene.
2. **The hidden rig is infrastructure.** Capsule or low-poly bodies are enough if
   joints, depth, occlusion, and contact are correct.
3. **Templates define supported interactions.** Parameters and bounded inverse
   kinematics provide variation; unknown poses fail closed to a fallback.
4. **Models propose; code resolves.** A detached composer may propose a template,
   roles, contacts, and camera family. Registries clamp the vocabulary and
   deterministic code solves and validates it.
5. **Render inference is not story truth.** A frame inferred from narration is
   `render_inferred` and cannot constrain later narration. Only committed,
   validated engine state may become `authoritative`.
6. **Structure and appearance are separate.** Pose/depth establish geometry;
   references, optional character LoRAs, region masks, and repair establish who
   occupies that geometry.
7. **Multi-pass is the expected quality path.** Structure, identity composition,
   repair, and upscale may use different calls.
8. **Providers expose capabilities, not model names, to domain code.** Routing
   chooses a legal workflow at runtime.
9. **Build alongside; cut over by evidence.** The structural path is additive
   and feature-flagged. Today's Venice/Qwen routes remain maintained and
   intentionally selectable—not merely emergency fallbacks—while the new route
   is debugged. No solver, worker, or provider failure may block a text turn.
10. **Stills ship before motion.** Contracts remain time-extensible.

## Existing foundation and gaps

Already shipped:

- immutable `images` assets and `image_references` lineage;
- detached `scene_image` jobs with dedupe, retry, and diagnostics;
- a model-registry capability layer, and a degradation ladder that drops
  references rather than switching models — a selected model never falls across
  to a different one, because a wrong-looking character costs more than a missing
  image (owner ruling 2026-07-29);
- Replicate-backed generation and up-to-three-reference editing;
- canonical avatars, current-look and place anchors, wardrobe projection,
  embodied POV, and mature-route eligibility checks;
- a scene composer that creates a structured render plan;
- **single-view identity packs** — a revisioned, source-hashed face-detail crop
  with quality measurement, manual correction, and pre-spend eligibility; and
- a **scene / body-relations owner** in the chat lane (posture, facing,
  proximity, support roles, coarse surface height, and the reach they imply),
  which is the committed physical state Gate 5 below was waiting for.

Still required:

- camera, coordinate, joint, support, contact, and occlusion contracts;
- pose templates plus deterministic IK/validation;
- procedural OpenPose, depth, segmentation, and masks;
- a provider or worker that consumes those controls;
- multi-view identity references and regional person binding — the shipped pack
  is one view of one character, and this plan needs several angles plus a way to
  bind a pack to a region of the frame;
- pose/identity/contact evaluation; and
- reproducible control and model-attempt lineage.

## Parallel development and migration

This is a second route through the existing job, asset, lineage, and model
contracts—not a rewrite or a big-bang replacement. Through Gates 0–4:

- The existing Replicate generate/edit routes remain production-supported and may
  stay the default for unsupported or unstable scene classes.
- A per-job/chat feature flag and capability routing select old, structural, or
  shadow/A-B execution without changing the caller's result contract.
- Structural-route failures preserve their diagnostics and may fall back to an
  old route within the detached job's bounded attempt/cost budget. That fallback
  is a route change, not a model change: the no-cross-model rule above still
  holds, so a structural attempt that fails falls back to the ordinary route on
  the same model or reports a refusal.
- New spatial components add adapters and tests around current seams; they do not
  destabilize working image generation while templates and models are debugged.
- Retiring any old route requires measured quality/reliability parity, production
  observation, and an explicit owner decision in a later plan.

## Target pipeline

```text
committed scene state or detached composer proposal
  → SpatialPoseRequest
  → template + bounded parameters
  → rig scaling + IK/contact solve + validation
  → SceneSpatialFrame
  → pose + depth + segmentation + masks + proxy preview
  → structure render
  → identity/reference composition
  → regional repair
  → low-denoise upscale
  → checks + candidate selection
  → immutable image + attempt lineage
```

### Spatial contracts

Add a pure `contracts/spatial/` module with no Three.js, ComfyUI, or
model-specific types:

- `SpatialPoseRequest`: template intent, role bindings, contacts, camera intent,
  provenance, and confidence.
- `PoseTemplate`: normalized role rigs, parameter limits, required/optional
  contacts, support surfaces, joint limits, camera families, and fallback.
- `SceneSpatialFrame`: coordinate convention, camera, scaled skeletons, root and
  joint transforms, contacts, solver residuals, visibility/person regions,
  provenance, seed, and template revision.
- `SpatialRead`: contacts, limb reachability, occupied limbs, relative
  orientation/distance, confidence, and explicit `unknown` reasons.

Use stable ids, explicit units, finite numbers, bounded arrays, and `parseOr` at
stored/provider boundaries. The stored form must be renderer-independent.

### Templates and procedural controls

Begin with high-value configurations: standing or sitting beside/across/behind,
lying in same/opposite orientation, kneeling beside a seated/lying person,
embrace, hand-hold, head-on-lap, simple reaches, bent-limb contacts, and viewer
hands/arms/lap/legs entering from an edge.

For each request, deterministic code:

1. binds characters to template roles;
2. scales a standard rig from available qualitative body/height attributes;
3. applies template transforms and bounded parameters;
4. solves named end effectors to contact anchors with IK;
5. checks joint limits, support, gross collision, reach, and residuals; and
6. returns a typed failure when no valid frame exists.

Templates are versioned JSON plus visual fixtures. Example photos may bootstrap
pose/depth extraction, but the reviewed template is reusable 3D transforms and
constraints, not a camera-locked bitmap.

A small server-side renderer—initially evaluate Three.js with rigged GLTF proxy
bodies—renders pixel-aligned artifacts from one frame:

- OpenPose/DWPose-compatible body map;
- normalized depth, plus metric depth if a provider needs it;
- per-person and per-body-region segmentation;
- character, face/hair, wardrobe, hand, and repair masks; and
- neutral developer preview.

All artifacts carry the frame id, camera, resolution, template/renderer revisions,
and checksum. Store controls losslessly; user-facing WebP assumptions must not
corrupt keypoint colors, depth, or region ids.

### Character identity packs

[image-identity-packs.plan.md](image-identity-packs.plan.md) already owns the
identity pack, its derivation, quality gate, correction path, and provenance. Its
v1 is deliberately one character, one canonical portrait, one face-detail crop.

This plan needs more than that, and the extra roles are what it must add rather
than reinvent:

- front, three-quarter, and profile face references;
- a neutral full-body / current-build reference;
- a current-look reference for wardrobe and appearance;
- optional distinguishing-feature crops and a provider-specific LoRA; and
- positive synthetic provenance plus adult/life-stage eligibility.

Only reviewed synthetic assets enter a pack. Never promote generated variants to
new canonical roots; chained references compound drift. LoRA datasets, if used,
must vary angle, expression, lighting, and outfit so identity does not absorb one
background or costume.

### Provider and attempt contracts

Extend provider capabilities with pose/depth/multi-control support, masks and
regional identity, reference limits, LoRA/inpaint/upscale support, deterministic
seeds, policy/provenance requirements, license, resolution, latency, and cost.

Each attempt records frame hash, control checksums, provider/model/workflow
revision, seed, LoRAs, references, prompt, timings, cost, and scores. Cache controls
by `(frame hash, renderer revision, resolution)`. The accepted image remains the
normal immutable `images` asset; failed attempts retain diagnostics without
polluting the Gallery.

## Model workflow to evaluate

Model names below are Gate 0 candidates, not permanent architecture decisions.

1. **Structure:** run Qwen-Image with InstantX Qwen-Image-ControlNet-Union using
   pose or depth. Benchmark pose-only, depth-only, multiple controls, and a neutral
   proxy RGB input; do not assume stacked controls are stable.
2. **Identity composition:** give Qwen-Image-Edit-2511 the structured candidate and
   indexed identity references. Prefer one face plus one body/current-look image
   per featured character when the input budget permits.
3. **Regional repair:** inpaint face, hair, hands, distinguishing features, or
   wardrobe contradictions through masks without redrawing the accepted structure.
4. **Mature-scene alternative:** evaluate an eligible, permissive SDXL-family or
   later checkpoint with pose/depth plus character LoRA or identity adapters,
   followed by conservative identity repair. Every candidate must pass license,
   provenance, policy, quality, and cost gates.
5. **Finish:** upscale only an accepted candidate at low denoise.

The app's current registry-model scene route is the no-control baseline. For three
or more people, test masked sequential composition—assign and protect one
character region at a time—then a restrained harmonization pass. A global
“combine everyone” prompt is not expected to preserve identity ownership reliably.

ComfyUI is the assumed worker/workflow orchestrator here because it makes
multi-stage experiments inspectable. That assumption is now contested: the
[Qwen advanced image subsystem plan](qwen-advanced-image-subsystem.plan.md)
established on 2026-08-06 that the hosted Qwen edit models take pose, depth, and
edge maps as ordinary numbered input images on Replicate, with no separate
control field and no GPU worker. Gate 0 must decide between the two before any
worker is stood up. Whichever wins, production code calls a versioned worker or
profile API; it does not depend on a graph file or node names.

## Validation and evaluation

Generate several cheap candidates before repair/upscale. Store metric and threshold
versions; automated scores remain advisory until calibrated against blinded review.

- **Pose:** generated keypoints versus requested skeleton, normalized by body size.
- **Depth:** coarse person/body-region ordering at sampled pixels.
- **Identity:** face embedding plus hair, silhouette, markings, and feature checks.
- **Binding:** identity appears in its assigned region; catch swaps and duplicates.
- **Wardrobe/exposure:** visible garments and bare regions match authoritative state.
- **Contact:** crops around required anchors plus human review during calibration.
- **POV/count:** extra people, literal cameras, full viewer bodies, or missing parts.

The fixed corpus should cover one/two people, crossed limbs, opposite orientation,
bent joints, furniture, embodied POV, wardrobe changes, eligible mature content,
and at least one non-human feature. Compare:

- the current single/multi-edit baseline on the registry's scene model;
- structure control without and with identity repair;
- reference packs versus LoRA identity;
- full regional-repair pipeline; and
- the eligible mature-scene alternative.

Track acceptance rate, swap/extra-person rate, generations per accepted image,
keypoint/contact/identity distributions, p50/p95 queue and worker latency, GPU
seconds/cost per accepted image, fallback rate, and content rejection by workflow.
Set numeric acceptance thresholds only after baseline and human labels exist.

## Delivery gates

No gate has been started. Gate 0's spike question was answered externally
(2026-08-11, below), so Gate 1 is the first to open when this plan activates.

### Gate 0 — measured workflow spike

Status: void — answered externally 2026-08-11; the Qwen lab's Stage 0 probe
settled the hosted-control question this spike existed to buy.

- Build the 12–20-scene corpus and render today's baseline.
- Prototype pose/depth structure → identity composition, first on hosted
  Replicate (Qwen Image Edit 2511 takes the control map as a numbered input
  image) and only then on an ephemeral/cloud GPU if the hosted route cannot do
  it.
- Measure VRAM, latency, cost, content coverage, license, and provider terms.
- Choose the hosted control route or a self-hosted/cloud ComfyUI worker.

Exit: one workflow materially improves pose/contact without a material identity
regression. Otherwise park the worker and improve reference editing.

This gate is a **paid spend** and duplicates the question the
[Qwen advanced image subsystem plan](qwen-advanced-image-subsystem.plan.md) asks.
Running both is buying the same answer twice.

### Gate 1 — contracts, templates, and renderer

Status: not started — first to open when this plan activates.

- Add schemas, 5–8 initial templates, camera presets, solver, and controls.
- Add golden artifacts, property tests, visual snapshots, and a developer inspector.

Exit: the same request is byte-stable, all controls align, and invalid contacts
return typed failure.

### Gate 2 — single-character chat

Status: not started — after Gate 1.

- Let the detached composer propose a bounded pose.
- Resolve only a `render_inferred` frame; do not mutate chat/world state.
- Add the structural provider behind a flag, identity packs, repair, and lineage.

Exit: blinded review beats the baseline on pose and identity with no added turn
latency and clean provider fallback.

### Gate 3 — two-character contact and binding

Status: not started — after Gate 2.

- Add two-role templates, IK contact, support, collision, and person regions.
- Add sequential/masked composition plus swap/duplicate detection.
- Model viewer limbs as a special rig/region, not an unbound extra person.

Exit: no systematic swapping; pose, orientation, and required contact pass the
fixed corpus, including mature-content and non-human-feature rows.

### Gate 4 — production operation

Status: not started — after Gate 3.

- Version the worker API and workflow bundle.
- Add queue limits, idempotency, cancellation, timeouts, health, cost budgets,
  caching, lifecycle sweep, shadow/A-B mode, and admin inspection.
- Complete security, provenance, license, and provider-ToS review.

Exit: attempts are observable and reproducible, spend is bounded, and rollback to
the current provider ladder is safe.

### Gate 5 — authoritative spatial reads

Status: not started — after Gate 4; its engine prerequisite landed 2026-07-21.

The prerequisite this gate was written to wait for has arrived: the successor
engine owns physical actions and positions for successor chats (gates 0–6 closed
2026-07-21), and the chat lane has its own scene / body-relations owner for
posture, facing, proximity, support, and reach. Both are coarse — neither holds
joint-level pose — so this gate still has to build the frame; what it no longer
has to wait for is somebody to own where the bodies are.

- Committed action resolution emits authoritative frames and `SpatialRead` facts.
- Narration receives concise contacts/reachability and explicit impossibilities
  only at sufficient confidence.
- Image generation consumes that same committed frame.

Exit: reach/contact fixtures produce consistent state, narrator constraints, and
control images from one source.

## Resilience, safety, and trust

- Image work stays detached; failure never rolls back text or state.
- Validate every composer/provider/worker payload with bounded schemas.
- Unknown ids and disagreeing controls fail closed and emit diagnostics.
- Exhausted identity-repair budgets produce a failed attempt, not a wrong canonical
  character image.
- No generated pose, pixel, caption, or score mutates authoritative body state.
- Mature routes require every depicted person to be a fictional adult with positive
  synthetic-reference provenance.
- Uploaded or unknown-provenance likenesses default to a safe route or no image;
  permissive/intimate editing is a launch blocker, not a prompt convention.
- Record model license/commercial status, adult-content rules, retention/training
  policy, moderation requirements, version, and removal path.

Local weights remove a host runtime filter; they do not waive model licenses,
acceptable-use terms, or learned safety behavior.

## Animation extension

Later, generalize a frame to `SpatialMotionClip`: duration/frame rate, skeletal
keyframes, interpolation, contact/support intervals, camera/expression tracks, and
pose/depth/segmentation sequences rendered from one timeline.

That timeline can animate a future 3D avatar or drive a video model. Wan2.2-Animate,
for example, accepts a character reference plus pose and face videos; Vesper could
render those drivers procedurally. Qwen may establish or repair keyframes, but must
not generate every frame independently because identity and clothing will flicker.
Motion gets a separate plan after Gate 3.

## Rough effort

| Work                                           | One-developer estimate |
| ---------------------------------------------- | ---------------------: |
| Gate 0 evaluation/workflow spike               |               3–8 days |
| Contracts, resolver, renderer, inspector       |             12–25 days |
| Single-character integration                   |              5–10 days |
| Two-character contact/identity                 |             10–25 days |
| Production worker/operations                   |              7–15 days |
| Narrator integration after engine prerequisite |              5–12 days |

A useful single-character treatment is plausibly 20–40 focused days. Robust
two-character production is more plausibly 40–80+ days; model evaluation, GPU
operation, and identity/contact repair dominate uncertainty.

## Open questions

1. Does this plan or the
   [Qwen advanced image subsystem](qwen-advanced-image-subsystem.plan.md) run the
   controlled-image experiment? They ask the same question and only one should be
   funded. An owner decision, not a research task.
2. Is single-character control valuable alone, or must v1 include two-person contact?
3. Managed GPU, dedicated worker, or hosted control API for the first deployment?
4. Are reviewed multi-view packs enough for v1, or are character LoRAs required?
5. Which body dimensions may authoritatively scale rigs?
6. Which controls must be retained versus reproduced from frame + renderer revision?
7. Is a developer inspector enough, or does the player need a pose editor?

## Definition of done

- One versioned frame drives pose, depth, segmentation, masks, and preview.
- Templates/IK cover the supported interaction set with typed failure.
- Existing identity, wardrobe, POV, life-stage, and provenance invariants survive.
- Structural rendering sits behind the existing provider ladder.
- Accepted one- and two-person rows preserve character identity and binding.
- Pose/contact/occlusion beat the prompt/reference-only baseline.
- Attempts are reproducible, scored, observable, and bounded in cost.
- Failure degrades without blocking the text turn.
- The same authoritative frame can later feed narrator reads and motion clips.

## Gate 0 research inputs

Revalidate versions, licenses, and behavior when the spike begins:

- [Qwen-Image-Edit-2511 model card](https://huggingface.co/Qwen/Qwen-Image-Edit-2511)
- [InstantX Qwen-Image-ControlNet-Union model card](https://huggingface.co/InstantX/Qwen-Image-ControlNet-Union)
- [Wan2.2 official repository](https://github.com/Wan-Video/Wan2.2)
