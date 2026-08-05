# Image render quality — model-native prompts, negative steering, and faces that survive

Status: active (rulings settled 2026-08-05; first hardening slice implemented)

Technical companion: [image-render-quality.spec.md](image-render-quality.spec.md)

Sibling plans:

- [image model registry](image-model-registry.plan.md) owns which provider models
  exist and the mechanical facts needed to call them;
- [image model capabilities](image-model-capabilities.plan.md) owns profiles,
  shared controls, role-aware references, version promotion, seeds, and
  multi-output machinery;
- this plan owns the quality policy that rides on those systems: what each model
  is told, what it is told not to draw, how references are prepared, and how a
  render is judged.

## The problem

Vesper now has models from several unrelated families behind one generic image
adapter. They accept the same broad concepts — prompt, references, shape — but
are not interchangeable.

The owner reported two visible failures after the registry expanded:

- Qwen Image Edit often returns a recognisably similar person rather than the
  character's exact face;
- SDXL-lineage and identity-specialist community models more often produce
  malformed hands, extra limbs, weak anatomy, or framing that looks malformed
  after Vesper crops it.

The current pipeline contributes to both. Provider defaults are treated as
quality defaults, every model receives the same provider-neutral prose, negative
prompts are mostly unused, and a canonical waist-up portrait is accepted as an
identity reference without checking whether its face is large or sharp enough to
carry identity.

## Corrections to the original draft

The first draft had the right direction but overstated several facts.

**SDXL has finite CLIP context, but hosted wrappers are not all identical.** The
SDXL text encoders use 77-position contexts. A particular Replicate cog may
truncate, chunk, or otherwise preprocess a longer prompt. The plan must not claim
that every SDXL wrapper silently ignores everything after exactly 75 tokens. The
correct policy is still subject-first, compact prompting, but the effective
context budget is a tested capability of a pinned model version rather than a
family-wide guess.

**Negative prompts are not free quality.** Long boilerplate negatives can fight a
checkpoint's training and can conflict with legitimate stylized, multi-person,
or close-framed images. Juggernaut's creator specifically recommends beginning
with little or no negative prompt. Vesper therefore starts with compact,
problem-shaped negatives and composes stronger blocks only when task and style
are known.

**Pony Realism and RealVis Hyper LoRA are candidates, not proven winners.** Their
InstantID/HyperLoRA machinery makes them worth testing for identity retention,
but the registered community models have limited usage evidence and no Vesper
trial verdict. They must not be described as the best face technology in the
registry until the fixed matrix demonstrates it.

**A full-frame “fix the face” pass is risky.** A second generative pass can change
pose, clothing, body, lighting, or setting while improving a face. Regional
repair or inpainting is the preferred production direction. Full-frame
Pony/RealVis re-rendering remains a useful admin comparison arm, not the assumed
final workflow.

## Settled rulings

These replace the former open questions.

### Juggernaut v9 is the full-step checkpoint

The registered `lucataco/juggernaut-xl-v9` model is normal Juggernaut XL v9, not
the separately published Lightning build. Its cog's 5-step, guidance-2 defaults
are a fast wrapper preset, not the checkpoint's intended quality configuration.

Vesper's reviewed starting configuration is:

- 832×1216 source render;
- 35 inference steps;
- guidance scale 5;
- the wrapper's `KarrasDPM` scheduler;
- a short anatomy/production negative rather than a large generic negative wall.

Vesper still normalizes the result to the lane's requested ratio. For a 3:4
portrait, 832×1216 requires a modest top/bottom crop, but it preserves far more
portrait detail than rendering 1024×1024 and discarding a quarter of the width.
The fixed trial matrix may tune these values, but the Lightning-versus-base
question is closed.

### Face crops are derived assets

A canonical portrait should compile into an **identity pack** when it is saved,
not be recropped independently on every render.

The pack begins with:

- the canonical portrait;
- a tight face crop;
- crop coordinates, source image id, detector/heuristic version, confidence, and
  generation timestamp;
- basic reference-quality measurements such as face pixel area, blur, occlusion,
  and detected face count.

Existing portraits are backfilled lazily when first needed, with an admin batch
available for trial preparation. Render-time cropping is only a degraded fallback
when the derived asset is missing or stale.

The first implementation may use a deterministic upper-centre portrait crop,
but it should store a confidence of `heuristic` rather than pretending it found a
face. A real detector may replace that crop only when its confidence clears a
reviewed threshold. Derived assets are invalidated when their source portrait
changes.

### Face repair proves out on the admin/dev surface first

“Fix the face” is not player-visible on day one. It starts behind an admin/dev
feature flag, accepts one explicitly selected character, and refuses
multi-person images.

Promotion to the player UI requires the fixed trial matrix to show a material
identity improvement without unacceptable drift in pose, clothing, body,
lighting, or setting. It remains an explicit action that creates a new image and
keeps the original. It is never a silent fallback after another model fails.

### Cost is governed by render units and a price guard

Provider prices move too often to bake a dollar number into the design. Vesper
uses a stable operational budget:

- one standard render is 1 render unit;
- an automatic/default player action may spend at most 1 unit;
- an explicit player quality or repair action may spend at most 2 units;
- an admin trial cell may spend at most 4 units;
- player-facing best-of-N starts at N=2 and never runs automatically for scenes;
- N=3 or larger remains admin-only until measured value justifies it.

A second configurable cents ceiling, refreshed when provider pricing is
reviewed, prevents an unusually expensive profile from hiding behind the same
unit count. Both guards must pass.

### Quality is the default for identity-critical edits

Variants, chat-look renders, and explicit face repair prioritize fidelity over
speed. Qwen Image Edit therefore runs with `go_fast: false` while it serves only
identity-critical jobs.

Routine scene generation remains subject to an operational promotion gate rather
than an assumption: a quality profile becomes the scene default only after its
p95 latency is at most 45 seconds on production-like traffic and its failure rate
does not regress. Slower quality remains available as an explicit action before
that point.

If Qwen Edit later gains non-identity tasks such as text repair, the single
runtime override must be replaced by task profiles so those jobs may choose a
fast profile independently.

### Static negatives stay style-neutral

The first hardening slice does **not** put photorealism or single-subject
negatives into shared model rows. Static steering contains only anatomy and
production defects that are wrong in either realistic or stylized work.

Photoreal blocks, Pony score/rating conventions, single-subject blocks, hand
emphasis, and framing-specific terms are composed only when the profile layer
knows the task, style, subject count, and visible anatomy. This resolves the
stylized-portrait mismatch instead of accepting a temporary regression.

## First hardening slice in this change

The profile rows introduced by the capabilities plan are still dormant, so the
first code slice is deliberately small and centralized.

`src/server/images/quality-presets.ts` supplies reviewed, exact-slug overrides at
`renderWithModel`, the one seam every lane already crosses. It currently:

- turns Qwen Image Edit fast mode off;
- gives Qwen Image 2512, SD 3.5, Pony, and RealVis conservative negative
  steering;
- gives Juggernaut the full-step settings above and a smaller negative;
- pins RealVis to its native 768×1024 3:4 size;
- rewrites the existing provider-neutral identity lock into Qwen's numbered-image
  dialect, with separate single-reference and multi-reference wording.

Pinned community slugs are matched without their version suffix. Unknown models
remain byte-identical and receive no guessed inputs.

This is a transitional compatibility layer, not a second configuration system.
It exists because the profile machinery is not called by the render path yet. As
shared render intent and control mapping land, each reviewed override moves into
a profile and the exact-slug policy shrinks to zero.

## Target quality architecture

### Structured render intent before model text

Prompt dialects should not attempt to reverse-engineer a finished paragraph.
Every lane should first produce ordered semantic segments:

- mandatory operation and identity/change contract;
- subject identities and age anchors;
- visible current state and pose;
- authoritative clothing and exposure;
- setting and location references;
- lighting, framing, and atmosphere;
- style and quality instructions.

The profile chooses a strategy and dialect. The compiler then writes prose,
compact SDXL tags, Pony-flavoured tags, or a model-specific instruction while
preserving segment priority. Mandatory segments are never truncated to save an
optional mood adjective.

### Prompt dialects are version-tested

The initial dialect vocabulary remains:

- `prose` for Qwen, Seedream, Wan, FLUX, and SD 3.5 unless a trial rules
  otherwise;
- `sdxl_tag` for compact community SDXL checkpoints such as Juggernaut and
  RealVis;
- `pony_tag` for Pony-lineage checkpoints.

Each pinned model version records a measured effective prompt budget. The test
uses a sentinel near the tail and a fixed seed to determine whether the wrapper
retains or loses late instructions. Until measured, the compiler is conservative
and places identity, subject count, morphology, pose, and clothing first.

### Negative steering is compositional

Named negative blocks are composed from context rather than stored as one giant
string:

- anatomy: extra or malformed limbs, hands, and fingers;
- production: text, watermark, signature, logo, blur, and low resolution;
- photoreal: synthetic media and plastic-skin terms, realistic style only;
- single-subject: duplicate people/faces, portrait and single-person variant
  only;
- Pony low-score tags, Pony dialect only;
- task-local blocks such as visible-hands steering only when hands actually
  matter in frame.

The linter rejects direct positive/negative collisions. A stylized prompt cannot
also forbid illustration; a multi-person scene cannot forbid multiple people; a
close-up cannot forbid cropping in general.

### Delta-first edit instructions

Instruction editors receive an explicit change contract:

- which numbered image supplies identity, place, style, pose, or object;
- exactly what changes;
- which load-bearing facts must remain unchanged;
- which text or region is authoritative when references disagree.

“Change the outfit” is weaker than “change only the outfit to the listed
wardrobe; preserve the exact face, hair, body, pose, camera, lighting, and
background.” The compiler should state that delta once, not scatter contradictory
preserve clauses through the prompt.

## Identity packs and reference quality

A bad identity reference cannot be repaired by more insistent prose. Before an
identity-critical render, Vesper scores the pack:

- one usable face detected, or a declared heuristic crop;
- minimum face dimensions after the provider's input resize;
- blur below threshold;
- no severe eye/mouth occlusion;
- crop padding sufficient to preserve jaw, hairline, and ears;
- source orientation and colour profile normalized;
- no stale source hash.

A failed score does not silently replace the reference. The UI explains the
problem and offers a new canonical portrait or a reviewed manual crop. Admin
trials may override with a recorded warning.

Reference ordering is deterministic:

1. canonical identity portrait;
2. face-detail crop for the same identity;
3. additional character identities;
4. location;
5. pose/control image;
6. style;
7. object.

A selected profile may change role capacity, but it may never evict a required
identity reference in favour of an optional style image.

## Visual state and attention

Static character attributes are not enough to render a living scene. The image
compiler should consume the same richer visual contract that can later improve
narration:

- identity: stable morphology and recognisable landmarks;
- presentation: deliberate hairstyle, makeup, jewellery, and worn objects;
- current state: damp hair, rolled sleeves, smudged makeup, dirt, fatigue,
  trembling hands, posture, and body language;
- garment state: per-part coverage, open/closed/rolled/draped presentation, and
  condition gradients;
- visibility: distance, lighting, angle, motion, and occlusion;
- salience: what is distinctive, newly changed, or relevant to the current
  action.

A lightweight visual-attention pass selects a few visible, high-salience deltas
instead of dumping the entire appearance sheet into every scene. Current changes
such as wet hair or a loosened tie outrank low-salience static facts such as eye
colour unless the shot is close enough to show them. This same contract can feed
narration, image generation, future animation, and physical validation without
making the source portrait the only truth.

## Face repair strategy

The preferred production path is local repair:

1. identify the selected character's face region;
2. expand and feather a mask around the full face/hairline boundary;
3. use the identity pack and original image as references;
4. edit only the masked region;
5. compare identity and seam quality before saving a new asset.

Until a suitable regional editor is registered, the admin trial compares:

- Qwen Edit with canonical portrait plus face crop;
- Pony Realism with the identity crop and rendered scene as pose control;
- RealVis Hyper LoRA with the identity crop;
- no repair baseline.

Full-frame specialist outputs are judged on composition drift as well as face
likeness. A better face with a changed outfit or body is a failure, not a partial
win.

## Advisory output QA

Automated checks may flag a result but do not silently choose another model.
Useful first checks are:

- face count versus expected people;
- identity similarity against the selected identity pack;
- severe blur or empty/black output;
- likely text or watermark;
- gross duplicate-body or duplicate-face anomalies;
- output dimensions and the amount removed by post-crop.

A failed check offers “retry same settings,” “new variation,” or an explicit
repair action. It records the reason and keeps the original for diagnostics.

## Provenance and trials

Every render comparison needs enough provenance to reproduce what happened:

- model slug and resolved version;
- profile and prompt dialect;
- final positive and negative prompt hashes;
- resolved control values and seed;
- ordered reference roles, source ids, and crop metadata;
- provider and end-to-end latency;
- estimated cost/render units;
- source and final dimensions, including post-crop bounds;
- warnings, moderation result, and advisory QA findings.

The fixed trial matrix remains 3–4 characters spanning human/non-human,
heavy/sparse authoring, and realistic/stylized appearances across the affected
portrait, variant, and scene tasks. Pairwise owner review grades identity,
anatomy, composition fidelity, and overall preference. New model versions do not
replace an active version until the relevant regression cells pass.

## Community-model license gate

Schema compatibility and output quality are not sufficient for production use.
Before a community checkpoint becomes a built-in default, paid feature, or
server-side production dependency, the operator records a review of its current
model license and hosting/deployment terms. The gate is version/date stamped and
must be revisited when a model or license changes.

This is especially important for community SDXL checkpoints whose model cards may
allow local experimentation while restricting commercial hosted APIs. The app
must not infer production permission from the fact that Replicate can execute a
model.

## Delivery slices

1. **Immediate hardening — implemented here.** Apply reviewed exact-slug quality
   overrides at the shared render seam, use style-neutral negatives, correct
   Juggernaut's fast defaults, pin RealVis dimensions, and translate Qwen's
   identity lock into numbered-reference instructions. Unit-test the policy and
   keep unknown models unchanged.
2. **Shared render intent and profile controls.** Complete capabilities slice 2/4
   so lanes resolve task profiles, common controls, timeout, seeds, and ordered
   semantic prompt segments. Move the transitional exact-slug inputs into
   profiles.
3. **Dynamic dialects and negatives.** Compile prose/SDXL/Pony prompts from
   segments, measure effective prompt budgets per pinned version, and compose
   task/style/subject-aware negative blocks with conflict linting.
4. **Identity packs.** Generate and persist face crops, crop provenance, quality
   metrics, source hashes, invalidation, lazy backfill, and manual-review tools.
5. **Qwen fidelity trials.** A/B canonical portrait alone, portrait plus face
   crop, numbered role binding, and fast/quality profiles one change at a time.
6. **Admin face repair.** Ship the single-person, explicit, provenance-preserving
   trial action; compare regional repair when available against full-frame
   Pony/RealVis candidates.
7. **Dimension and framing profiles.** Generalize width/height negotiation,
   native size tiers, focal-aware cropping, and per-task output shapes instead of
   relying on model defaults.
8. **Best-of-N and seeded retry.** Add N=2 player portrait selection, admin trial
   grids, stored seeds, and “same composition” versus “new variation” semantics.
9. **Advisory QA and promotion gates.** Record identity/face-count/blur/text/crop
   signals and make fixed-matrix regression results part of model-version
   promotion.
10. **Visual-state compiler.** Feed current appearance, garment presentation,
    visibility, and salience into image prompt segments from one shared visual
    contract.

Each slice must be independently useful. No slice introduces automatic
cross-model fallback.

## Success criteria

- Qwen identity-critical renders use numbered, delta-first identity instructions
  and quality mode unless a task profile explicitly says otherwise.
- Juggernaut no longer runs its normal checkpoint at 5 steps/CFG 2 or wastes a
  square render before portrait cropping.
- Every negative input is known to exist on the selected pinned model, and static
  negatives never conflict with realistic/stylized style or subject count.
- Unknown/admin-added models remain unchanged until reviewed.
- Identity references meet measurable quality requirements and can be traced to
  their canonical source.
- A fixed-matrix change improves identity or anatomy without unacceptable
  composition drift and carries reproducible settings.
- Face repair remains explicit, one-character-only at first, and preserves the
  original image.
- Render-unit, cents, and latency guards prevent quality features from becoming
  uncontrolled defaults.
- Community models clear a recorded license/terms review before production
  defaulting.

## Remaining empirical questions

The owner decisions are settled. These are trial questions, not blockers to
beginning implementation:

- whether Juggernaut's compact negative improves anatomy or should be reduced to
  an empty/default negative;
- whether `KarrasDPM` is the best wrapper sampler for Vesper's portrait prompts;
- how much Qwen's face crop and fast-mode change improve identity independently;
- the minimum useful face-pixel and blur thresholds for the identity pack;
- whether Pony or RealVis can improve identity without composition drift;
- which advisory QA metrics correlate well enough with owner judgment to gate a
  version rather than merely annotate it.

## Out of scope

Training per-character LoRAs, arbitrary user-supplied model weights, automatic
cross-model fallback, video generation, and a general pose/depth system remain
outside this plan. The architecture leaves seams for them, but image quality must
first become measurable and reproducible on the models Vesper already runs.
