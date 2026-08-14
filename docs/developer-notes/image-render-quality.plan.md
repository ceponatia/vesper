# Image render quality — model-native prompts, reference quality, and faces that survive

Status: active (owner rulings settled 2026-08-05; slice 1 — the reviewed
exact-slug hardening at the shared render seam — shipped 2026-08-05, corrected
through 2026-08-06; slice 2 unblocked since the capabilities plan's shared
render intent shipped 2026-08-07; reference preparation left this plan for
[image-identity-packs.plan.md](image-identity-packs.plan.md) on 2026-08-05;
nothing else in the slice list exists in code)

Outcome: A player can generate a portrait or scene that still shows their own
character, so that a new image stops coming back as a similar-looking stranger
with malformed hands.

Technical companion: [image-render-quality.spec.md](image-render-quality.spec.md)

Sibling plans:

- [image model registry](finished/image-model-registry.plan.md) owns which provider models
  exist and the mechanical facts needed to call them;
- [image model capabilities](image-model-capabilities.plan.md) owns profiles,
  shared controls, role-aware references, version promotion, seeds, and
  multi-output machinery;
- [image identity packs](image-identity-packs.plan.md) owns the face reference
  itself — derivation, quality measurement, correction, invalidation, and the
  reference-strategy trial;
- [visual state and attention](visual-state.plan.md) owns the appearance
  projection an image prompt should eventually read;
- [Qwen advanced image subsystem](qwen-advanced-image-subsystem.plan.md) owns the
  proposed controlled laboratory for pose/depth/LoRA experiments;
- [scene composition](scene-composition.plan.md) owns what a scene shot
  contains — camera vantage, subject facing, intimate staging — which this
  plan's dialects then translate per model (the two meet at the identity-lock
  wording);
- this plan owns the quality policy that rides on those systems: what each model
  is told, which controls are quality defaults, how repair works, and how a
  render is judged.

## The problem

Vesper now has models from several unrelated families behind one generic image
adapter. They accept the same broad concepts — prompt, references, and shape —
but they are not interchangeable.

The owner reported two visible failures after the registry expanded:

- Qwen Image Edit often returns a recognisably similar person rather than the
  character's exact face;
- SDXL-lineage and identity-specialist community models more often produce weak
  anatomy, malformed hands, or framing that looks malformed after Vesper crops
  it.

The pipeline contributed to both. Provider defaults were treated as quality
defaults, every model received the same provider-neutral prose, and a canonical
waist-up portrait was accepted as an identity reference without checking whether
its face was large or sharp enough to carry identity.

Two of those three now have an answer. Slice 1 replaced the provider defaults on
the reviewed models and gave Qwen Edit its own identity wording, and the identity
pack system measures a reference before spending on it. What remains is the
general case: every other model still receives the same provider-neutral prose,
and nothing composes a prompt from what the scene actually contains.

## Corrected assumptions

Four claims that must not be reintroduced, and what is true instead.

**SDXL has finite CLIP context, but hosted wrappers are not all identical.** The
SDXL text encoders use 77-position contexts. A particular Replicate cog may
truncate, chunk, or otherwise preprocess a longer prompt. The plan must not claim
that every SDXL wrapper silently ignores everything after exactly 75 tokens. The
correct policy is still subject-first, compact prompting, but the effective
context budget is a tested capability of a pinned model version rather than a
family-wide guess.

**There is no universal negative prompt at the current render seam.** Long
boilerplate negatives can fight a checkpoint's training, and every plausible
“safe” term can conflict with legitimate content. Text and logos may be requested
on signs or clothing; blur may be intentional; low-resolution rendering may be a
pixel-art style; “missing fingers” may describe a landmark; “extra limbs” may be
correct for a non-human species. The shared seam cannot see task, style, intended
morphology, authored absences, visible body parts, or subject count. It therefore
must not invent negative content.

Where a reviewed wrapper has a non-empty provider default that can contradict
Vesper's state, the transitional policy explicitly clears it to the empty string.
All authored negative steering waits for task profiles and conflict checking.

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
- an explicitly empty negative prompt, replacing the wrapper's media-biased
  default and following the creator's little/no-negative starting guidance.

Vesper still normalizes the result to the lane's requested ratio. For a 3:4
portrait, 832×1216 requires a modest top/bottom crop, but it preserves far more
portrait detail than rendering 1024×1024 and discarding a quarter of the width.
The fixed trial matrix may tune the sampler and numeric values, but the
Lightning-versus-base question is closed.

### Face crops are derived assets, and they are somebody else's product now

A canonical portrait compiles into an **identity pack** when it is saved, rather
than being recropped independently on every render.

That ruling grew into a system of its own on 2026-08-05 and left this plan.
[image-identity-packs.plan.md](image-identity-packs.plan.md) owns derivation,
source hashing, quality measurement, manual correction, invalidation, deletion,
and the reference-strategy trial; its pack-side slices shipped 2026-08-06. This
plan no longer states how a face crop is produced or judged — it only consumes a
pack the way any other identity-critical render does.

### Face repair proves out on the admin/dev surface first

“Fix the face” is not player-visible on day one. It starts behind an admin/dev
feature flag, accepts one explicitly selected character, and refuses
multi-person images.

Promotion to the player UI requires the fixed trial matrix to show a material
identity improvement without unacceptable drift in pose, clothing, body,
lighting, camera, or setting. It remains an explicit action that creates a new
image and keeps the original. It is never a silent fallback after another model
fails.

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

### Negative prompts require structured context

The transitional shared-seam policy adds no negative content to Qwen Image 2512,
SD 3.5, or Pony, whose provider defaults are already empty. It also does not add
Pony score tags before the fixed trial establishes that they help the pinned
version.

Juggernaut and RealVis expose non-empty provider defaults that can silently
contradict requested style or morphology. Their reviewed runtime overrides send
`negative_prompt: ""` to neutralize that hidden behavior.

Future photoreal blocks, anatomy blocks, single-subject blocks, hand emphasis,
framing terms, and Pony score/source/rating conventions are composed only when
the profile layer knows the task, style, subject count, visible anatomy, authored
absences, and intended morphology.

## Slice 1 — the reviewed settings that are live today

The profile rows introduced by the capabilities plan are still dormant, so the
first code slice was deliberately small and centralized. It shipped 2026-08-05
and is in every render the app makes.

A small reviewed policy applies exact-slug overrides at the one seam every image
lane already crosses. It:

- turns Qwen Image Edit fast mode off;
- gives Juggernaut the full-step settings above and clears its wrapper negative;
- pins RealVis to its native 768×1024 3:4 size and clears its long generic
  negative boilerplate;
- rewrites the existing provider-neutral identity lock into compact Qwen
  numbered-image wording that does not expand the already-fitted edit prompt;
- leaves Qwen Image 2512, SD 3.5, Pony, and every unknown or operator-added model
  byte-identical.

Pinned community slugs are matched without their version suffix.

This is a transitional compatibility layer, not a second configuration system.
It exists because the profile machinery is not called by the production render
path yet. As shared render intent and control mapping land, each reviewed
override moves into a profile and the exact-slug policy shrinks to zero. Exact
settings, matching rules, and the retirement sequence are in
[the spec](image-render-quality.spec.md).

## Target quality architecture

### Structured render intent before model text

Prompt dialects should not attempt to reverse-engineer a finished paragraph.
Every lane should first produce ordered semantic segments:

- mandatory operation and identity/change contract;
- subject identities, intended morphology, and age anchors;
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

### Negative steering is compositional and morphology-aware

Named negative blocks are composed from context rather than stored as one giant
string:

- production: unwanted generated text/watermarks only when the task does not
  request text or graphic marks;
- anatomy: duplicated, disconnected, or malformed anatomy after subtracting
  intended morphology and authored absences;
- photoreal: synthetic-media and plastic-skin terms, realistic style only;
- single-subject: duplicate people/faces, portrait and single-person variant
  only;
- Pony score/source/rating conventions, tested pinned version only;
- task-local blocks such as visible-hand steering only when hands matter in
  frame.

The linter rejects direct positive/negative collisions. A stylized prompt cannot
also forbid illustration; a multi-person scene cannot forbid multiple people; a
close-up cannot forbid cropping in general; a character with an authored missing
finger cannot receive “missing fingers” as a negative; a multi-limbed species
cannot receive “extra limbs”; a storefront sign cannot receive a blanket `text`
negative.

### Delta-first edit instructions

Instruction editors receive an explicit change contract:

- which numbered image supplies identity, place, style, pose, or object;
- exactly what changes;
- which load-bearing facts must remain unchanged;
- which text or region is authoritative when references disagree.

“Change the outfit” is weaker than “change only the outfit to the listed
wardrobe; preserve the exact face, hair, body, pose, camera, lighting, and
background.” The compiler states that delta once rather than scattering
contradictory preserve clauses through the prompt.

## What this plan expects from its neighbours

A bad identity reference cannot be repaired by more insistent prose, and a static
appearance paragraph cannot describe a living scene. Both fixes are real work,
and both belong to other plans. This plan states only what it needs from them.

**From identity packs:** a pre-spend verdict on whether the selected character
has a usable face reference, which reference roles are available, and enough
provenance to reproduce the choice later. A failed verdict must reach the player
as an explanation, not a silently substituted reference, and must stop the render
before provider money is spent. Derivation, thresholds, correction, and the
reference-strategy trial are [that plan's](image-identity-packs.plan.md).

**From visual state:** the appearance facts a render must not drop — identity,
intended morphology, subject count, authoritative wardrobe — separated from the
optional current-state detail a prompt budget may or may not fit. Damp hair, a
rolled sleeve, and smudged makeup are exactly the kind of fact this plan's
prompts want and cannot currently obtain.
[visual-state.plan.md](visual-state.plan.md) owns that projection.

**From capabilities:** ordered semantic prompt segments, resolved controls, seeds,
and role-aware reference transport. Its shared render intent shipped 2026-08-07,
so this plan's slice 2 has its seam; the segment vocabulary and control
transports it still lists as remaining are what slices 3 and beyond wait on.

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
- no-repair baseline.

Full-frame specialist outputs are judged on composition drift as well as face
likeness. A better face with a changed outfit or body is a failure, not a partial
win.

## Advisory output QA

Automated checks may flag a result but do not silently choose another model.
Useful first checks are:

- face count versus expected people;
- identity similarity against the selected identity pack;
- severe unintended blur or empty/black output;
- likely unintended text or watermark;
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

The fixed trial matrix uses 3–4 characters spanning human/non-human,
heavy/sparse authoring, realistic/stylized appearances, intentional text/graphic
content, and at least one intentional absence, prosthetic, or unusual appendage
count. Pairwise owner review grades identity, anatomy relative to intended
morphology, edit fidelity, composition drift, and overall preference. New model
versions do not replace an active version until the relevant regression cells
pass.

## Community-model license gate

Schema compatibility and output quality are not sufficient for production use.
Before a community checkpoint becomes a built-in default, paid feature, or
server-side production dependency, the operator records a review of its current
model license and hosting/deployment terms. The gate is version/date stamped and
must be revisited when a model or license changes.

The app must not infer production permission from the fact that Replicate can
execute a model.

## Delivery slices

Slice numbers are stable identities and are never reused, so a slice that leaves
this plan keeps its number as a pointer.

1. **Immediate hardening.** Status: complete — 2026-08-05, corrections through
   2026-08-06. Reviewed exact-slug quality overrides at the shared render seam:
   Juggernaut's fast defaults corrected, conflicting wrapper negatives cleared
   on Juggernaut and RealVis, RealVis dimensions pinned, and Qwen's identity
   lock translated into compact numbered-reference instructions. Unit-tested,
   with every unreviewed model unchanged. The corrections made the prompt
   rewrite idempotent so a compiled comparison cell cannot conflict with its own
   prompt.
2. **Shared render intent and profile controls.** Status: queued — unblocked;
   the capabilities slice 2 it waited on shipped 2026-08-07. Lanes now resolve
   task profiles and common controls; what remains here is moving the
   transitional exact-slug inputs into profiles and the ordered semantic prompt
   segments.
3. **Dynamic dialects and negatives.** Status: blocked on slice 2. Compile
   prose/SDXL/Pony prompts from segments, measure effective prompt budgets per
   pinned version, and compose task/style/subject/morphology/text-aware negative
   blocks with conflict linting.
4. **Identity packs.** Status: void — moved out 2026-08-05. Now
   [image-identity-packs.plan.md](image-identity-packs.plan.md), whose pack-side
   slices shipped 2026-08-06.
5. **Model-fidelity trials.** Status: queued — the harness it uses shipped
   2026-08-06. The identity-pack plan's trial subsystem runs blinded pairwise
   comparison cells and is the tool this slice uses. Reference-strategy
   questions (portrait alone versus portrait plus face crop, detector versus
   heuristic crop) belong to that plan's trial. What stays here is model tuning
   with the reference held fixed: fast versus quality mode, sampler and CFG
   within Juggernaut's full-step band, and dialect choice per pinned version.
6. **Admin face repair.** Status: queued. Ship the single-person, explicit,
   provenance-preserving trial action; compare regional repair when available
   against full-frame Pony/RealVis candidates.
7. **Dimension and framing profiles.** Status: queued. Generalize width/height
   negotiation, native size tiers, focal-aware cropping, and per-task output
   shapes instead of relying on model defaults.
8. **Best-of-N and seeded retry.** Status: queued. Add N=2 player portrait
   selection, admin trial grids, stored seeds, and “same composition” versus
   “new variation” semantics.
9. **Advisory QA and promotion gates.** Status: queued. Record
   identity/face-count/blur/text/crop signals and make fixed-matrix regression
   results part of model-version promotion.
10. **Visual-state consumption.** Status: blocked on slice 2. Feed the mandatory
    and optional facts from [visual-state.plan.md](visual-state.plan.md) into
    image prompt segments. That plan owns the projection; this slice is its
    image consumer and cannot start before slice 2 gives it somewhere to put
    the segments.

Each slice must be independently useful. No slice introduces automatic
cross-model fallback.

## Success criteria

Met by slice 1:

- Qwen identity-critical renders use compact numbered identity instructions and
  quality mode unless a task profile explicitly says otherwise.
- Juggernaut no longer runs its normal checkpoint at 5 steps/CFG 2 or wastes a
  square render before portrait cropping.
- The context-free seam never invents a negative prompt; reviewed non-empty
  wrapper defaults are neutralized explicitly instead.
- Unknown and operator-added models remain unchanged until reviewed.

Still to prove:

- Dynamic negatives are task-, text-, style-, subject-, and morphology-aware and
  conflict-checked before they are sent.
- A fixed-matrix change improves identity or anatomy without unacceptable
  composition drift and carries reproducible settings.
- Face repair remains explicit, one-character-only at first, and preserves the
  original image.
- Render-unit, cents, and latency guards prevent quality features from becoming
  uncontrolled defaults.
- Community models clear a recorded license/terms review before production
  defaulting.

Identity-reference quality and traceability are graded by the identity-pack
plan's own criteria, not restated here.

## Open questions

The owner decisions are settled. These are trial questions, not blockers to
beginning implementation:

- which Juggernaut sampler and CFG within the full-step band best fit Vesper's
  prompts;
- which context-aware negative blocks improve quality without erasing intended
  text, style, or morphology;
- how much Qwen's fast-versus-quality mode changes identity on its own, with the
  reference held fixed;
- whether Pony or RealVis can improve identity without composition drift;
- which advisory QA metrics correlate well enough with owner judgment to gate a
  version rather than merely annotate it.

## Out of scope

Training per-character LoRAs, arbitrary user-supplied model weights, automatic
cross-model fallback, video generation, and a general pose/depth system remain
outside this plan. The architecture leaves seams for them, but image quality must
first become measurable and reproducible on the models Vesper already runs.
