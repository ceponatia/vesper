# Image render quality — technical spec

Plan: [image-render-quality.plan.md](image-render-quality.plan.md)

Machinery this rides on:
[image-model-capabilities.spec.md](image-model-capabilities.spec.md) (profiles,
control mapping, role-aware references, prompt fitting, seeds, and multi-output).
Provider schemas and reviewed notes:
[docs/image-models/](../image-models/).

This spec defines the content and quality layer: transitional reviewed settings,
prompt-dialect behavior, negative composition, identity-pack contracts, repair
rules, provenance, and the trial protocol. It does not duplicate the capabilities
spec's provider-neutral request and profile schemas.

## Current implementation after the first hardening slice

Every image lane still builds its existing prompt and resolves an `ImageModel`.
All lanes then cross:

```text
renderWithModel
  -> withReviewedImageQuality
  -> preparePromptForImageModel
  -> chooseAspect
  -> runRegistryImageModel
  -> cropToTargetAspect when needed
```

The two new functions live in
`src/server/images/quality-presets.ts`. This is intentionally the narrowest seam
that improves every current lane without wiring the dormant profile rows halfway.

### Why the policy is runtime rather than a data migration

A migration that writes `image_models.extra_input` would improve current rows but
would be fragile:

- re-probing a model replaces `extraInput` with the values derived from its
  provider schema;
- the provider's defaults are not necessarily Vesper's reviewed quality defaults;
- community models may have been added through the admin UI after the migration;
- the profile system that should eventually own these controls is not yet called
  by the render path.

The runtime policy therefore matches exact reviewed provider slugs, strips a
community model's `:version` suffix for matching, and overlays its settings after
the row's `extraInput`. An unknown/admin-added model remains unchanged and never
receives a guessed field.

This overlay is transitional. When shared render intent and common controls reach
`renderWithModel`, the effective values move to task profiles and the exact-slug
map is deleted. Until then, diagnostics and future provenance must report the
**resolved payload values**, not assume the database row is the effective run.

## Transitional reviewed settings

`withReviewedImageQuality(model)` returns the original model object when no
reviewed policy exists. For a reviewed slug it returns a shallow copy with:

```ts
{
  ...model,
  extraInput: {
    ...model.extraInput,
    ...reviewedOverrides,
  },
}
```

The original record is never mutated.

### Shared style-neutral negative

```text
extra limbs, extra arms, extra legs, malformed limbs, disconnected limbs,
extra fingers, missing fingers, fused fingers, mutated hands, poorly drawn
hands, bad anatomy, disfigured, text, watermark, signature, logo, blurry,
low resolution
```

This deliberately omits:

- `anime`, `cartoon`, `painting`, or `illustration`, because stylized portraits
  legitimately request them;
- `multiple people`, `duplicate person`, or `second face`, because the shared
  seam does not know the task's subject count;
- `cropped`, `out of frame`, or body-part framing terms, because close-ups and
  embodied POV may legitimately crop a body;
- sexual/rating terms, which belong to a route- and model-aware profile.

### Effective values by model

**Qwen Image 2512**

- add the shared style-neutral negative;
- leave its current generation speed and guidance defaults unchanged.

**Qwen Image Edit 2511**

- force `go_fast: false`;
- do not send a negative prompt because the schema has no such input.

All current uses of this model are identity-critical. If text repair or another
non-identity task begins using it, this global override must be replaced by a
quality edit profile and a fast task-specific profile.

**Stable Diffusion 3.5 Large**

- add the shared style-neutral negative;
- leave sampler/guidance unchanged until a fixed trial says otherwise.

**Juggernaut XL v9**

- `num_inference_steps: 35`;
- `guidance_scale: 5`;
- `scheduler: "KarrasDPM"`;
- `width: 832`;
- `height: 1216`;
- minimal negative:
  `extra limbs, malformed hands, extra fingers, fused fingers, text, watermark, logo`.

The normal v9 checkpoint is not the Lightning model. The model creator's
published quality settings support a full-step starting point. The compact
negative honors the creator's warning that large negative walls can reduce
quality. The fixed matrix still tests an empty negative against this minimal one.

The registry currently has no generic width/height aspect mode. These two
provider inputs travel through `extraInput`; `chooseAspect` returns no provider
shape and `cropToTargetAspect` normalizes the returned 832×1216 image. At 3:4 the
crop removes a modest strip from top and bottom rather than throwing away a
quarter of a square render's width.

**Pony Realism v2.3**

- shared style-neutral negative;
- append `score_1, score_2, score_3` as low-quality negatives;
- leave identity scales, pose strength, steps, and guidance at provider defaults
  until the identity trial isolates them.

**RealVis Hyper LoRA**

- shared style-neutral negative;
- explicitly pin `width: 768`, `height: 1024` instead of relying on a provider
  default that happens to be 3:4;
- leave HyperLoRA/InstantID strengths at provider defaults until trialed.

## Qwen numbered-reference prompt preparation

The existing builders use this provider-neutral sentence:

```text
Generate a new image of the exact same person shown in the reference image.
Preserve face, hair color and style, skin tone, body proportions, and apparent
age.
```

Qwen Image Edit's multi-image instructions work better when the caller identifies
images by number and states what changes versus what remains fixed. Rather than
changing the generic prompt for every model, `preparePromptForImageModel` replaces
that exact legacy sentence only when:

- the selected base slug is `qwen/qwen-image-edit-2511`;
- at least one reference is actually being sent;
- the prompt contains the known legacy lock.

Single-reference replacement:

```text
Image 1 is the canonical identity reference. Generate a new image of the exact
same person shown in image 1. Preserve their facial features, hair color and
style, skin tone, body proportions, and apparent age. Change only what the rest
of this instruction explicitly requests.
```

Multi-reference replacement:

```text
Treat the numbered reference images as authoritative for the people, place,
style, and objects assigned to them below. Preserve every referenced person's
exact facial identity, hair, skin tone, build, and apparent age. Change only what
the rest of this instruction explicitly requests.
```

The multi-reference scene builder already enumerates its references later in the
prompt. The replacement establishes how Qwen should interpret that list without
inventing a second ordering system.

A custom Qwen prompt that does not contain the legacy lock is not rewritten. A
Qwen run with zero references is not rewritten. Every non-Qwen prompt remains
byte-identical.

## Tests for the first slice

`quality-presets.test.ts` pins these properties:

- pinned community slugs resolve to their base path;
- unknown models return the same object and same inputs;
- Qwen Edit's stored `go_fast: true` is overridden without mutating the row;
- Juggernaut receives the reviewed full-step settings;
- the shared negative contains no realistic/stylized or subject-count conflict;
- Pony adds only its low-score negatives;
- single- and multi-reference Qwen locks are selected correctly;
- custom/no-reference/non-Qwen prompts are not changed.

The existing `models.ts` crop tests continue to own output normalization. Future
shared-render-intent tests should assert the final provider payload, including
profile controls, so the transitional and profile paths cannot diverge during
migration.

## Effective prompt context: measured, not guessed

SDXL's CLIP text encoders have 77-position contexts, but the Replicate wrapper
may truncate, chunk, or preprocess longer text. `promptDialect` therefore cannot
be justified by a universal “75 tokens and the rest disappears” rule.

For each pinned version used by `sdxl_tag` or `pony_tag`, the promotion trial
records an effective-context result:

1. create a fixed prompt with a conspicuous visual sentinel near the end;
2. render the same seed with that sentinel moved progressively earlier;
3. compare whether the requested feature appears consistently;
4. record the last reliable segment/token position as an operational budget;
5. repeat when the pinned model version changes.

The budget is advisory rather than a provider schema fact. Regardless of the
measured limit, compilers order load-bearing content first.

## Structured prompt segments

A robust dialect compiler consumes semantics, not a finished paragraph. The
shared render intent should expose ordered segments similar to:

```ts
export type ImagePromptSegmentKind =
  | "operation"
  | "identity"
  | "age"
  | "framing"
  | "pose"
  | "current_state"
  | "wardrobe"
  | "exposure"
  | "setting"
  | "lighting"
  | "atmosphere"
  | "style"
  | "quality";

export interface ImagePromptSegment {
  kind: ImagePromptSegmentKind;
  text: string;
  tagText?: string;
  mandatory: boolean;
  priority: number;
  source?: string;
}
```

`source` is diagnostic provenance such as `character.attributes`,
`garment.presentation`, `scene_plan.pose`, or `location.description`; it does not
reach the provider.

Prompt fitting removes or compresses the lowest-priority optional segments first.
It never truncates through the middle of a mandatory sentence. Identity, age
safety anchors, person count, current clothing/exposure authority, and the edit
delta remain mandatory.

## Dialect behavior

### `prose`

The initial output is today's prose, modulo an explicitly selected model-specific
instruction such as Qwen's numbered identity lock. Golden tests protect all
unaffected models.

Likely users: Qwen, Seedream, Wan, FLUX, and SD 3.5. A trial may move a model to a
different dialect without changing the task strategy.

### `sdxl_tag`

The compiler emits compact, comma-separated visual concepts. It does not use
A1111/Comfy weighting syntax such as `(word:1.2)` unless the exact provider
wrapper documents support; plain Diffusers may treat that syntax literally.

Order:

1. rendering medium/quality lead;
2. subject count and subject descriptor;
3. identity-critical morphology and landmarks;
4. pose/action and visible body parts;
5. authoritative clothing and current state;
6. setting fragment;
7. lighting;
8. optional atmosphere.

Compression:

- drop metadata labels that do not add visual meaning;
- retain values and distinctive landmarks;
- reduce wardrobe to visible garment, dominant colour/material, and critical
  presentation state;
- cap setting to the few features that define the location;
- omit non-visible traits rather than encoding them as prose;
- do not emit a tag solely because it exists on the character sheet.

### `pony_tag`

Start from `sdxl_tag`, then add model-version-tested score/source/rating
conventions. The initial candidate positive lead is:

```text
score_9, score_8_up, score_7_up
```

Realistic profiles may test `source_photo, realistic`. Rating tags are route
policy and may never be inferred from the checkpoint name. Every tag consumes
context and stays only if the fixed matrix demonstrates value for the pinned
version.

## Dynamic negative composition

Once profiles are live, static reviewed negatives move into named blocks:

```ts
export type NegativeBlock =
  | "anatomy"
  | "production"
  | "photoreal"
  | "single_subject"
  | "pony_low_score"
  | "visible_hands";
```

The composer receives:

- task;
- style;
- expected subject count;
- framing;
- visible body parts;
- dialect/model version;
- positive segments.

Rules:

- `anatomy` and `production` are default candidates on models with a supported
  negative binding;
- `photoreal` only for realistic styles;
- `single_subject` only when exactly one full person is expected;
- `pony_low_score` only for a tested Pony dialect;
- `visible_hands` only when hands are intentionally visible and important;
- no block may contain a normalized phrase that directly conflicts with a
  mandatory positive segment.

A conflict produces a diagnostic and removes the negative term; it does not fail
a player render.

For models with no `negative_prompt` binding, the composer returns no provider
field. It does not append “no extra limbs” to the positive prompt by default,
because naming an unwanted object can summon it and the scene prompt already has
specific positive ownership rules.

## Delta-first edit contract

Instruction-edit profiles should compile a single explicit operation block:

```text
References:
- image 1: canonical identity for Mira
- image 2: close face detail for Mira
- image 3: the cafe interior

Change:
- place Mira in the listed pose and authoritative wardrobe in the cafe

Keep unchanged:
- Mira's exact facial structure, hair, skin tone, body proportions, and apparent
  age
- the visual identity of the cafe where the prompt does not request a change
```

Provider wording may be prose rather than literal headings, but the semantic
contract is fixed. A reference role never depends only on array position in
application code; role-aware selection from the capabilities spec produces the
ordered list and the prompt describes that resolved order.

When text and reference disagree:

- apparent-age anchor is text-authoritative, preserving the existing owner
  ruling against age drift;
- current wardrobe/exposure state is text/state-authoritative;
- canonical face and immutable identity are reference-authoritative;
- location reference is authoritative for stable geometry unless the scene plan
  explicitly changes it.

## Identity pack contract

A canonical portrait compiles to a derived identity pack:

```ts
export interface ImageIdentityPack {
  version: 1;
  characterId: string;
  sourceImageId: string;
  sourceContentHash: string;
  faceCropImageId: string;
  faceCrop: {
    left: number;
    top: number;
    width: number;
    height: number;
    method: "detector" | "heuristic" | "manual";
    detectorVersion?: string;
    confidence?: number;
  };
  quality: {
    detectedFaces: number | null;
    faceWidthPx: number;
    faceHeightPx: number;
    blurScore: number | null;
    occlusionScore: number | null;
    accepted: boolean;
    warnings: string[];
  };
  createdAt: string;
}
```

Coordinates are source-pixel coordinates after EXIF orientation is normalized.
The derived crop is encoded with stripped metadata and a stable colour profile.
The pack is stale when `sourceContentHash` no longer matches the canonical
portrait.

### Creation and backfill

- generate the pack after a new canonical portrait becomes ready;
- a pack failure does not fail portrait save; it records a warning and disables
  the face-detail reference until corrected;
- existing characters create packs lazily on first identity-critical use;
- an admin batch prepares the fixed trial corpus;
- render-time heuristic crop is a temporary degraded fallback and must not be
  persisted as though it were detector-confirmed.

### Initial heuristic

For a Vesper-authored waist-up 3:4 portrait, crop an upper-centre region with
padding around hairline, ears, and jaw. The exact box is trial-tuned. It is safer
to include some shoulders than to clip the chin or hairline, because identity
editors use those boundaries.

A detector replaces the heuristic only when:

- exactly one suitable face is found;
- confidence clears the reviewed threshold;
- the expanded box remains mostly within the image;
- the crop clears minimum dimensions after normalization.

### Reference-quality gate

Production defaults require:

- one selected identity;
- accepted pack or an explicit admin override;
- reviewed minimum face dimensions at the provider's effective input size;
- blur/occlusion below threshold when those metrics are available;
- no stale source hash.

The player receives an actionable error such as “the saved portrait is too small
or obscured to hold the face; choose a clearer canonical portrait.” Vesper does
not spend a render unit on a reference known to be unusable.

## Reference selection and capacity

Role priority for identity-critical work:

1. required canonical identity;
2. face-detail crop for that identity;
3. additional required character identities;
4. required location/pose control for the selected profile;
5. optional location;
6. optional style;
7. optional object.

Required references are selected before optional references. If the model cannot
fit all required roles, the profile is ineligible for that request; it must not
silently discard one person's identity.

Qwen Edit's current cap of three means a single-character scene may use identity
portrait + face crop + location. A two-character scene generally uses the two
identities plus location and cannot also include both face crops. The trial must
measure whether a face crop is more valuable than the location reference in each
case; the role policy may vary by profile but remains deterministic.

## Visual-state compiler

The image request should eventually read a shared visual contract rather than a
flat character description.

```ts
export interface VisualStateFeature {
  id: string;
  phrase: string;
  layer: "identity" | "presentation" | "current_state";
  visibility: number;
  salience: number;
  changedAtTurn?: number;
  bodyRegion?: string;
  occluded?: boolean;
  sources: string[];
}
```

The attention pass scores features from:

- distance and framing;
- lighting;
- view angle;
- motion;
- garment occlusion;
- uniqueness/recognition value;
- change from the familiar baseline;
- relevance to the current action.

Only visible, high-priority features become prompt segments. Identity landmarks
remain available to the identity pack and prompt compiler, while transient state
such as damp hair, a rolled sleeve, smudged makeup, dirt, or trembling hands can
outrank static low-salience facts in a scene.

Garment state is object/part based: coverage, layer, opacity, fastened/open,
rolled, displaced, draped, wetness, damage, and dirt. This extends the existing
clothing-state graph rather than inventing a second wardrobe truth.

## Face-repair trial contract

The first action is admin/dev only and single-character only.

Input:

- source rendered image id;
- selected character id;
- accepted identity pack;
- chosen repair profile;
- optional manual face region when the detector cannot identify the target.

Output:

- a new image row; never overwrite the source;
- meta containing source image id, identity pack version, crop/mask, model,
  resolved settings, and trial arm;
- a comparison link to the original.

Trial arms:

1. no repair baseline;
2. Qwen Edit with canonical portrait + face crop;
3. Pony identity input + source image as `pose_image`;
4. RealVis identity input + scene description;
5. regional masked editor when a suitable registered model exists.

Refuse in v1 when:

- more than one full person appears or is expected;
- the selected face cannot be localized reliably;
- the source/identity pack is stale or missing;
- the profile would exceed the repair render-unit/cents ceiling.

Evaluation measures identity improvement **and** drift in pose, clothing, body,
setting, lighting, and camera. Regional repair is preferred when it achieves
similar identity with less drift.

## Cost and latency guards

A profile records `renderUnits` as stable relative work. Runtime pricing metadata
supplies an estimated cents value when available.

Policy:

- ordinary automatic action: ≤1 unit;
- explicit player quality/repair action: ≤2 units;
- admin trial cell: ≤4 units;
- player portrait best-of-N: N=2 initially;
- no automatic scene best-of-N;
- absolute configurable cents cap must also pass.

Operational promotion gates:

- identity-critical variants/chat-look: quality mode by default;
- routine scenes: quality profile becomes default only when p95 end-to-end
  latency is ≤45 seconds and failure/refusal rate does not regress;
- explicit repair may use a higher timeout but must show progress and settle
  within the profile's bounded timeout;
- latency is measured from production events, not a hand-maintained model label.

## Advisory output QA

Initial checks return findings, not an automatic model switch:

```ts
export interface ImageQualityFinding {
  code:
    | "face_count_mismatch"
    | "identity_similarity_low"
    | "severe_blur"
    | "blank_or_black"
    | "text_or_watermark"
    | "duplicate_body_suspected"
    | "large_post_crop";
  severity: "info" | "warn" | "error";
  confidence?: number;
  context?: Record<string, unknown>;
}
```

An error may prevent the image becoming the canonical portrait, but it does not
silently re-run another model. The UI can offer retry-same-seed, new variation,
or explicit repair.

The first inexpensive deterministic checks are output dimensions, blank/black
content, and post-crop fraction. Face/identity/anatomy models are added only when
their false-positive rate is measured on Vesper's corpus.

## Render provenance

At minimum record:

```ts
export interface ImageRenderProvenance {
  modelSlug: string;
  modelVersion: string | null;
  profileId: string | null;
  promptDialect: string;
  promptHash: string;
  negativePromptHash?: string;
  controls: Record<string, unknown>;
  seed?: number;
  references: Array<{
    role: string;
    imageId: string;
    identityPackVersion?: number;
    crop?: { left: number; top: number; width: number; height: number };
  }>;
  providerDurationMs?: number;
  totalDurationMs: number;
  renderUnits: number;
  estimatedCostCents?: number;
  sourceDimensions?: { width: number; height: number };
  finalDimensions: { width: number; height: number };
  crop?: { left: number; top: number; width: number; height: number };
  warnings: string[];
}
```

Sensitive full prompts need not be duplicated into analytics events; durable
image metadata may retain the authorized prompt while events carry hashes and
selected controls.

## Fixed trial matrix

Store each report under `docs/developer-notes/images/` as
`render-quality.<slice>.trial.md`.

Corpus:

- 3–4 stable characters;
- at least one human and one non-human morphology;
- one heavily authored and one sparse profile;
- realistic and stylized portrait cases;
- clear frontal identity and at least one difficult hair/skin/age case;
- portrait, one-change variant, single-character scene, and multi-reference
  scene where relevant.

Controls:

- same seed where supported;
- otherwise at least three outputs per arm;
- one variable changed per A/B;
- same canonical source and identity pack version;
- record provider version and final payload.

Owner grades each pair for:

- identity likeness;
- anatomy/hands;
- requested edit correctness;
- unchanged-detail preservation;
- composition/pose/wardrobe/setting drift;
- overall preference.

A tuning change lands only with its report and model-doc update. A model-version
promotion reruns the cells affected by changed capabilities or controls.

## Model-license gate

Before a community model becomes a production default or paid feature, record:

- model/checkpoint and wrapper version;
- license/terms source and review date;
- whether server-side hosted inference and the intended commercial use are
  permitted;
- any attribution, distribution, or output restrictions;
- reviewer and next review trigger.

Replicate availability is not evidence that every intended Vesper use is
licensed. A failed or unclear review keeps the model admin/experimental.

## Migration off the transitional policy

When profiles reach the render path:

1. seed task-specific controls that reproduce every current effective override;
2. add final-payload golden tests comparing old overlay versus profile result;
3. route one task at a time through profile controls;
4. remove that task/model's runtime override only after parity holds;
5. expose resolved controls in provenance/admin diagnostics;
6. delete `quality-presets.ts` when no reviewed exact-slug behavior remains.

Prompt rewriting also moves from exact string replacement to the Qwen
`instruction_edit` compiler once it consumes structured segments. The temporary
replacement remains until the final Qwen profiles produce the same numbered and
delta-first wording.

## Acceptance criteria

- reviewed settings affect every current lane through one seam;
- unknown models receive no added provider fields;
- pinned slug matching is deterministic;
- current Qwen identity prompts become numbered without changing non-Qwen text;
- static negatives are style- and subject-count-neutral;
- Juggernaut runs full-step at native portrait dimensions rather than its cog's
  fast square defaults;
- effective controls are testable and eventually recorded in provenance;
- dynamic prompt/negative compilers consume semantic segments and reject
  conflicts;
- identity packs are source-hashed, quality-gated, and invalidated correctly;
- repair remains explicit, single-character-first, and non-destructive;
- cost, latency, and model-license gates are enforced before a quality feature
  becomes a default.

## Remaining trial questions

No owner ruling is pending. The implementation still needs evidence for:

- Juggernaut minimal negative versus empty negative;
- `KarrasDPM` versus the cog's other compatible high-quality samplers;
- Qwen quality mode and face-crop gains measured independently;
- detector/crop quality thresholds;
- whether Pony/RealVis improve identity without unacceptable full-frame drift;
- which advisory QA scores correlate strongly enough with owner review to gate
  promotion rather than merely annotate output.
