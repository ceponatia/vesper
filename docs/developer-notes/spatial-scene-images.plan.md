# Spatially controlled scene images — pose, depth, and character identity

Status: **draft — 2026-07-20**. This plan graduates the self-hosted ComfyUI /
pose-control follow-up in [deferred.plan.md](deferred.plan.md). It extends the
shipped provider and lineage foundation in
[finished/scene-images.plan.md](finished/scene-images.plan.md) and the runtime
documented in [../images.md](../images.md).

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
9. **Today's Venice/Qwen pipeline remains the fallback.** Solver, worker, or
   provider failure never blocks a text turn.
10. **Stills ship before motion.** Contracts remain time-extensible.

## Existing foundation and gaps

Already shipped:

- immutable `images` assets and `image_references` lineage;
- detached `scene_image` jobs with dedupe, retry, and diagnostics;
- a provider capability/fallback layer;
- Venice/Qwen generation and up-to-three-reference editing;
- canonical avatars, current-look and place anchors, wardrobe projection,
  embodied POV, and mature-route eligibility checks; and
- a scene composer that creates a structured render plan.

Still required:

- camera, coordinate, joint, support, contact, and occlusion contracts;
- pose templates plus deterministic IK/validation;
- procedural OpenPose, depth, segmentation, and masks;
- a provider that consumes those controls;
- multi-view character identity packs and regional person binding;
- pose/identity/contact evaluation; and
- reproducible control and model-attempt lineage.

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

Add a versioned `CharacterVisualIdentityPack` rooted in the canonical avatar:

- front, three-quarter, and profile face references;
- neutral full-body/current-build reference;
- current-look reference for wardrobe/appearance;
- optional distinguishing-feature crops and provider-specific LoRA; and
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

Hosted Venice stays the no-control baseline and fallback. For three or more people,
test masked sequential composition—assign and protect one character region at a
time—then a restrained harmonization pass. A global “combine everyone” prompt is
not expected to preserve identity ownership reliably.

ComfyUI is the initial worker/workflow orchestrator because it makes multi-stage
experiments inspectable. Production code calls a versioned worker API; it does not
depend on a graph file or node names.

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

- current Venice single/multi-edit baseline;
- structure control without and with identity repair;
- reference packs versus LoRA identity;
- full regional-repair pipeline; and
- the eligible mature-scene alternative.

Track acceptance rate, swap/extra-person rate, generations per accepted image,
keypoint/contact/identity distributions, p50/p95 queue and worker latency, GPU
seconds/cost per accepted image, fallback rate, and content rejection by workflow.
Set numeric acceptance thresholds only after baseline and human labels exist.

## Delivery gates

### Gate 0 — measured workflow spike

- Build the 12–20-scene corpus and render today's baseline.
- Prototype Qwen pose/depth → Qwen Edit identity on an ephemeral/cloud GPU.
- Measure VRAM, latency, cost, content coverage, license, and provider terms.
- Choose self-hosted/cloud ComfyUI or a hosted control API.

Exit: one workflow materially improves pose/contact without a material identity
regression. Otherwise park the worker and improve reference editing.

### Gate 1 — contracts, templates, and renderer

- Add schemas, 5–8 initial templates, camera presets, solver, and controls.
- Add golden artifacts, property tests, visual snapshots, and a developer inspector.

Exit: the same request is byte-stable, all controls align, and invalid contacts
return typed failure.

### Gate 2 — single-character chat

- Let the detached composer propose a bounded pose.
- Resolve only a `render_inferred` frame; do not mutate chat/world state.
- Add the structural provider behind a flag, identity packs, repair, and lineage.

Exit: blinded review beats the baseline on pose and identity with no added turn
latency and clean provider fallback.

### Gate 3 — two-character contact and binding

- Add two-role templates, IK contact, support, collision, and person regions.
- Add sequential/masked composition plus swap/duplicate detection.
- Model viewer limbs as a special rig/region, not an unbound extra person.

Exit: no systematic swapping; pose, orientation, and required contact pass the
agreed corpus, including mature-content and non-human-feature rows.

### Gate 4 — production operation

- Version the worker API and workflow bundle.
- Add queue limits, idempotency, cancellation, timeouts, health, cost budgets,
  caching, lifecycle sweep, shadow/A-B mode, and admin inspection.
- Complete security, provenance, license, and provider-ToS review.

Exit: attempts are observable and reproducible, spend is bounded, and rollback to
the current provider ladder is safe.

### Gate 5 — authoritative spatial reads

This waits for the successor engine to own physical actions and positions.

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

| Work | One-developer estimate |
| --- | ---: |
| Gate 0 evaluation/workflow spike | 3–8 days |
| Contracts, resolver, renderer, inspector | 12–25 days |
| Single-character integration | 5–10 days |
| Two-character contact/identity | 10–25 days |
| Production worker/operations | 7–15 days |
| Narrator integration after engine prerequisite | 5–12 days |

A useful single-character treatment is plausibly 20–40 focused days. Robust
two-character production is more plausibly 40–80+ days; model evaluation, GPU
operation, and identity/contact repair dominate uncertainty.

## Open questions

1. Is single-character control valuable alone, or must v1 include two-person contact?
2. Managed GPU, dedicated worker, or hosted control API for the first deployment?
3. Are reviewed multi-view packs enough for v1, or are character LoRAs required?
4. Which body dimensions may authoritatively scale rigs?
5. Which controls must be retained versus reproduced from frame + renderer revision?
6. Is a developer inspector enough, or does the player need a pose editor?

## Definition of done

- One versioned frame drives pose, depth, segmentation, masks, and preview.
- Templates/IK cover the agreed set with typed failure.
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
