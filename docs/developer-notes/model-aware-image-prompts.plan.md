# Model-aware image prompt programs

Status: active (2026-08-18)

Research basis: [model-aware-image-prompts.research.md](model-aware-image-prompts.research.md)

Implementation state and build rulings: [model-aware-image-prompts.spec.md](model-aware-image-prompts.spec.md)

Parent owner: [image render quality](image-render-quality.plan.md)

Related plans:

- [image lane consolidation](image-lane-consolidation.plan.md) owns migration away from route-specific character prompt builders;
- [visual state and attention](visual-state.plan.md) owns the committed character visual snapshot and image digest;
- [image model capabilities](finished/image-model-capabilities.plan.md) owns endpoint profiles, provider controls, references, and normalized render intent;
- [scene composition](finished/scene-composition.plan.md) owns the committed camera, staging, pose, and action facts;
- [identity packs](finished/image-identity-packs.plan.md) owns identity-reference assets and their quality.

## Outcome

A Vesper image render uses one immutable, fingerprinted set of character, location, item, scene, camera, and operation facts. From that same set, Vesper independently resolves:

- a **positive prompt program** describing what the image must contain;
- a **negative constraint program** describing incompatible or unwanted outcomes;
- the exact model/endpoint dialect and transport used to express each program.

Positive and negative prompt packs can be researched, versioned, tested, promoted, rolled back, and managed separately. They are nevertheless compiled together, so a negative rule can never unknowingly forbid a required character feature, object, location detail, literal text, subject count, style, or morphology.

The system is endpoint-aware rather than family-generic. Qwen Image 2512, Qwen Image Edit 2511, Seedream, Wan, FLUX, Pony, SDXL PuLID, SD 3.5, and P-Image may consume the same world truth while receiving materially different prompt wording and negative transport.

## Why a separate plan is needed

The current codebase already has several important pieces:

- model profiles choose a `promptStrategy`;
- normalized controls include `negativePrompt`;
- the render kernel can resolve a caller/profile negative and record applied or dropped controls;
- `ImagePromptSegment[]` supplies canonical kinds, priority, mandatory protection, and budget fitting;
- `VisualImageDigest` provides structured, deterministic character facts and an intended-morphology subset for negative conflict checking;
- role-aware references are planned before provider payload assembly.

The remaining gap is not merely “add more templates.” Current production prompts are still assembled in route-specific modules, several negative ideas are embedded inside positive prose, and the segment seam still carries prewritten `text`/`tagText` rather than enough structured meaning for every future dialect. Character state has an emerging digest, but locations and items still arrive as narrow, independently formatted strings.

Without a dedicated prompt-program layer, a per-model refactor would create a matrix of duplicated templates:

```text
route × task × model × character fields × location fields × item fields
```

That would make every future field addition require edits in several model files and would recreate the drift the lane-consolidation work is trying to remove.

## Scope

This plan covers every production image route:

- character portraits and avatars;
- character variants and instruction edits;
- single- and multi-character scenes;
- chat look/selfie and staged renders;
- item portraits;
- location portraits;
- scene renders containing characters, locations, and items;
- future image tasks that consume the same world facts.

It covers both text-to-image and reference-based rendering. It does not require every endpoint to support a dedicated negative field.

## Non-goals

This work does not:

- create new canonical character, location, item, garment, anatomy, or scene truth;
- infer visual facts from narrator prose or biography;
- redesign provider connections, image storage, identity-pack derivation, or scene staging;
- add an LLM that freely rewrites production prompts;
- automatically retry with a different prompt or model after a failed render;
- train LoRAs, add ControlNet workflows, or implement face repair;
- make raw operator-authored lab prompts impossible.

Raw prompts remain an explicit lab/admin escape hatch. They do not receive the same “complete authoritative world state” guarantee unless the caller also supplies a prompt program.

## Core rulings

### Facts are selected once and prose is written last

No model-specific file reads character attributes, garment state, anatomy, location rows, or item rows directly. The application first builds a structured world digest. Model dialects consume that digest through semantic claims and constraints.

A new field must be projected at its owning boundary, not patched into Qwen, Seedream, Pony, and FLUX templates separately.

### “All information” means all image-eligible truth

The prompt system must be able to use every current and future fact that is relevant to the requested image. It must not blindly serialize every database field.

Each source field or projection declares one disposition:

```ts
type ImageProjectionDisposition =
  | "required_visual"
  | "optional_visual"
  | "relational"
  | "reference_only"
  | "nonvisual"
  | "restricted"
  | "unsupported";
```

This classification is explicit. A future field cannot disappear merely because nobody remembered to add it to a prompt builder. CI must fail when a new image-relevant contract member has no projection decision. `nonvisual` and `restricted` are deliberate decisions, not fallback buckets.

### Positive and negative are separate products over one truth

Positive packs and negative packs have separate identities, versions, evidence, promotion history, and rollback. They are bound together by one render profile and compiled in one pure operation over one world digest.

A negative pack never performs its own database read and never sees a different point in time from the positive pack.

### Endpoint/version behavior outranks model-family assumptions

Prompt capability is keyed by Vesper model row, provider endpoint, and executed or pinned version. A field exposed by a local Diffusers pipeline or a different host does not exist for Vesper until the current endpoint schema proves it.

### Task strategy and model dialect are different axes

`promptStrategy` continues to describe the job:

- text-to-image description;
- instruction edit;
- multi-reference composition;
- text repair;
- example transform;
- style render;
- coherent set.

A separate `promptDialect` describes how the selected endpoint wants that job expressed. Qwen edit's delta-first numbered-reference instruction is not the same concern as the fact that the job is an instruction edit.

### No universal negative string

Negative steering is composed from named constraints with applicability guards. Intended morphology, authored absences, subject count, literal text, style, camera, and task facts are subtracted before any negative text is emitted.

### Provider defaults are part of the effective prompt

A hidden provider negative, prompt preamble, prompt upsampler, or score-tag injector must be represented in capability metadata and provenance. Vesper cannot claim to manage a prompt separately if an invisible wrapper default continues to alter it.

### Promotion is evidence-gated

A research finding creates a candidate pack version. It does not mutate production. Promotion requires compiler tests and the relevant fixed image trial against the pinned endpoint/version.

## Target architecture

The contract sketches in this section and the two below it are the DESIGN. The
shapes that were actually built, and the handful of places they differ, live in
[the spec](model-aware-image-prompts.spec.md) — read that first when writing code.
This plan still carries more type-level detail than a plan should; folding the
remaining sketches into the spec is worth doing as its own pass rather than
alongside a feature change.


```text
canonical source owners
  character / visual state / wardrobe / anatomy
  location definition + current environment
  item definition + current instance state
  scene / camera / action / references
                 │
                 ▼
        atomic ImageWorldDigest
      facts + relations + source revisions
       cut/read token + deterministic hash
                 │
                 ▼
          ImagePromptProgram
     positive claims     negative constraints
             \             /
              \ collision /
               \ checks  /
                 ▼
     endpoint/profile prompt binding
 task strategy + positive dialect + negative transport
                 │
                 ▼
  compiled positive text + compiled negative field
  inline/replacement constraints + references + controls
                 │
                 ▼
             provider payload
```

The application owns world selection because it understands Vesper contracts. `@vesper/image-core` owns model-independent prompt-program contracts, fitting, dialect compilation, collision checking, endpoint bindings, and provider-neutral provenance. Provider packages own only schema-to-payload transport.

## Atomic world digest

### Contract

The exact names may follow repository conventions, but the boundary must express this shape:

```ts
interface ImageWorldDigest {
  version: 1;
  read: ImageWorldRead;
  fingerprint: string;
  subjects: readonly ImageSubjectDigest[];
  location: ImageLocationDigest | null;
  items: readonly ImageItemDigest[];
  relations: readonly ImageWorldRelation[];
  camera: readonly ImageCameraFact[];
  operation: ImageOperationContract;
  references: readonly ImageReferenceFact[];
  suppressions: readonly ImageWorldSuppression[];
  sourceRevisions: readonly ImageSourceRevision[];
}

interface ImageWorldRead {
  kind: "committed_cut" | "transactional_projection";
  token: string;
  atMinutes?: number;
}
```

For a chat/scene render, the token is the committed cut and the existing visual snapshot must match it. For a standalone portrait, item, or location render, the application reads every required owner in one transaction or equivalent consistent projection and mints a read token from the source revisions.

The digest is immutable after construction. Both prompt channels receive the same object. No compiler may reach back into live state.

### Retry behavior

A retry must make an explicit choice:

- **retry same composition:** reuse the stored world/prompt-program fingerprints and source revisions;
- **render current state:** build a new digest and record a new read token.

A retry cannot quietly combine the old character with the current wardrobe, current location, or newly moved item.

### Character facts

Reuse `VisualImageDigest` rather than creating a second character appearance owner. It already supplies:

- required identity and morphology facts;
- optional camera-visible state and body language;
- subject count;
- intended morphology for negative conflict checks;
- source keys and truth fingerprints;
- snapshot, selection, and camera fingerprints;
- suppressions and missing-mandatory diagnostics.

The world adapter may wrap or reference it, but must not reformat or duplicate its truth.

### Location facts

Add a `LocationImageDigest` projected from the location's existing owners. It should be capable of carrying, as those owners exist:

- identity, kind, scale, geometry, architectural layout, and connected spaces;
- persistent surfaces, fixtures, landmarks, signs, and authored text;
- current lighting, time, weather, damage, cleanliness, occupancy, and atmosphere when canonical owners provide them;
- camera-visible subareas and spatial relationships;
- required reference assets and their roles;
- source revisions, applicability, and suppressions.

The first implementation may project only fields that exist today, but the contract and classification registry must accept future owners without changing model compilers.

### Item facts

Add an `ImageItemDigest` that distinguishes item definition from item instance state. It should be capable of carrying:

- name, kind, material, color, dimensions, shape, parts, texture, and authored markings;
- current condition, wetness, dirt, damage, wear, contents, attachments, and configuration;
- owner, holder, wearer, container, scene locus, orientation, and relationships to other items;
- literal text, logo, label, or symbol requirements;
- reference assets and provenance;
- source revisions, applicability, and suppressions.

A worn garment remains authoritative through wardrobe/visual-state ownership. The item digest references that relationship rather than describing the garment twice.

### Relations are facts

Ownership, containment, wearing, holding, contact, relative placement, facing, and action are not prose glue. They are typed relations. Model compilers need them to bind the correct person to the correct item and reference image.

```ts
interface ImageWorldRelation {
  kind:
    | "wears"
    | "holds"
    | "contains"
    | "attached_to"
    | "located_at"
    | "left_of"
    | "right_of"
    | "in_front_of"
    | "behind"
    | "contact"
    | "acts_on";
  subjectRef: string;
  objectRef: string;
  required: boolean;
  source: ImageSourceRef;
}
```

The initial vocabulary should reuse existing scene and affordance relations where possible. This sketch does not authorize a duplicate relation system.

## Prompt-program contracts

### Positive claims

The current `ImagePromptSegment` is semantically classified, but its payload is still prewritten prose plus optional tag text. That is enough for fitting and a first dialect, but not enough for durable per-model compilation: every future model would otherwise require the application to supply another pre-rendered spelling.

Add a model-neutral semantic claim beneath or inside the segment seam:

```ts
interface ImagePositiveClaim {
  id: string;
  kind: ImagePromptSegmentKind;
  concept: string;
  value?: unknown;
  subjectRef?: string;
  locus?: string;
  relationRef?: string;
  semanticTags: readonly string[];
  required: boolean;
  priority: number;
  source: ImageSourceRef;
}
```

Examples:

- `concept: "hair.color", value: "auburn"`;
- `concept: "wardrobe.garment", value: { type: "coat", color: "navy", closure: "open" }`;
- `concept: "item.literal_text", value: "EXIT"`;
- `concept: "relation.holds", subjectRef: "mira", value: "red umbrella"`;
- `concept: "camera.framing", value: "full_figure"`;
- `concept: "operation.replace_wardrobe", value: ...`.

`ImagePromptSegment[]` remains accepted during migration. The dialect compiler must never reverse-engineer structured meaning from an opaque paragraph. Once all production lanes produce claims, raw text becomes an explicit lab/admin claim rather than the default representation.

### Negative constraints

```ts
interface ImageNegativeConstraint {
  id: string;
  category: ImageNegativeCategory;
  concepts: readonly string[];
  replacementClaims?: readonly ImagePositiveClaim[];
  conflictKeys: readonly string[];
  required: boolean;
  priority: number;
  sourcePackVersionId: string;
  evidenceIds: readonly string[];
}

type ImageNegativeCategory =
  | "artifact"
  | "anatomy"
  | "identity_drift"
  | "subject_count"
  | "literal_text_artifact"
  | "watermark_or_signature"
  | "composition"
  | "framing"
  | "style_conflict"
  | "background_clutter"
  | "task_specific"
  | "provider_default_override";
```

A constraint says what outcome is unacceptable, not how one specific model spells it. Model dialects supply natural-language, compact-tag, or Compel renderings.

### Prompt program

```ts
interface ImagePromptProgram {
  version: 1;
  worldFingerprint: string;
  operation: ImageOperationContract;
  positive: readonly ImagePositiveClaim[];
  negative: readonly ImageNegativeConstraint[];
  positivePackVersionId: string;
  negativePackVersionId: string;
  bindingVersionId: string;
  fingerprint: string;
}
```

The program fingerprint includes the ordered claims, constraints, both pack versions, endpoint/profile binding, and world digest fingerprint. The same inputs produce byte-equal program output.

## Model and endpoint dialect registry

Add a closed code registry for prompt behavior. Database rows select registry entries; they do not execute arbitrary templates or predicates.

```ts
interface ImagePromptDialectDefinition {
  id: ImagePromptDialectId;
  positiveSyntax: "natural_language" | "compact_tags" | "compel_tags";
  negativeSyntax: "natural_language" | "compact_tags" | "compel_tags" | "none";
  negativeTransport:
    | "dedicated_field"
    | "inline_instruction"
    | "positive_replacement"
    | "unsupported";
  referenceSyntax: "none" | "numbered_images" | "role_labels";
  supportsWeights: boolean;
  supportsLiteralQuotes: boolean;
  hiddenPromptSources: readonly HiddenPromptSource[];
  compilePositive(...): CompiledPositivePrompt;
  compileNegative(...): CompiledNegativePrompt;
}
```

Initial dialect candidates:

- `qwen_2512_description`;
- `qwen_2511_delta_edit`;
- `seedream_45_prose`;
- `seedream_5_lite_prose`;
- `wan_27_prose`;
- `sd35_large_prose`;
- `flux_dev_positive_replacement`;
- `pony_compel_tags`;
- `sdxl_pulid_tags`;
- `p_image_prose`.

Shared helper functions are encouraged, but each endpoint has its own registry entry and trial verdict. Two entries may initially delegate to the same implementation without becoming permanently coupled.

### Profile binding

Extend the resolved profile plan with:

```ts
interface ImagePromptProfileBinding {
  profileId: string;
  modelId: string;
  versionId: string | null;
  promptStrategy: ImagePromptStrategy;
  promptDialectId: ImagePromptDialectId;
  positivePackVersionId: string;
  negativePackVersionId: string;
  bindingVersionId: string;
}
```

The binding pins the independently versioned packs into one compatible pair. Promoting only the negative side creates a new binding version that reuses the old positive version. A render never observes half of an activation transaction.

## Prompt-pack management

### Pack records

Use separate records for positive and negative packs:

```text
image_prompt_packs
  id
  channel: positive | negative
  slug
  name
  dialect_id
  status

image_prompt_pack_versions
  id
  pack_id
  version
  manifest_json
  evidence_revision
  content_hash
  created_at
  created_by
  supersedes_version_id

image_prompt_profile_bindings
  id
  profile_id
  model_id
  version_id nullable
  positive_pack_version_id
  negative_pack_version_id
  status: candidate | active | retired
  activated_at nullable
```

The exact migration may adapt existing profile storage, but the invariants remain:

- pack versions are immutable;
- active bindings change atomically;
- rollback activates a prior binding rather than rewriting history;
- an endpoint version may pin a different binding from the floating model row;
- a provider/schema update does not silently inherit an untested pack.

### What belongs in data versus code

**Code owns:**

- semantic concept registry;
- applicability predicates;
- collision rules;
- dialect compilers;
- provider capability interpretation;
- mandatory/failure policy;
- deterministic ordering and fitting.

**Versioned pack data owns:**

- enabled block IDs;
- block order and priority adjustments;
- endpoint/task/style scope;
- reviewed wording variants supplied by the dialect;
- evidence references and research notes;
- candidate/active status.

Do not store executable JavaScript, free-form condition expressions, or an unrestricted whole-prompt template in the database. A malformed or adversarial template must not become production code through an admin field.

### Evidence records

Each pack version links to evidence records:

```ts
interface ImagePromptEvidence {
  id: string;
  sourceType: "official_model" | "official_endpoint" | "provider_guide" | "community_guide" | "reddit" | "vesper_trial";
  url?: string;
  reviewedAt: string;
  modelSlug: string;
  versionId?: string;
  claim: string;
  confidence: "authoritative" | "strong" | "hypothesis" | "anecdotal";
}
```

A Reddit finding can justify a trial case but cannot satisfy a promotion gate by itself.

## Positive prompt system

### Fact selection

The application converts the world digest into positive claims. Selection follows this order:

1. operation/change contract;
2. subject identity and count;
3. intended morphology and authored absences;
4. apparent age and identity anchors;
5. camera/framing and required geometry;
6. pose/action and spatial relations;
7. authoritative wardrobe and exposure;
8. target items and their required relations;
9. location identity and required current state;
10. optional visible current state and body language;
11. lighting, atmosphere, style, and quality.

This is semantic ordering, not one hardcoded sentence order. A dialect may reorder within safe constraints while the fitter protects required claims.

### Task strategies

#### Text-to-image description

Describe required entities and relationships before decoration. A target item or location is a first-class subject, not a tail clause after a character paragraph.

#### Instruction edit

Compile one explicit delta:

- base image role;
- additional reference roles;
- exact change;
- authoritative replacement facts;
- facts that remain unchanged;
- whether canvas, crop, viewpoint, or occupied geometry may change.

The preserve set is derived from the operation contract. It is not “preserve everything,” which can conflict with a pose or framing change.

#### Multi-reference composition

Final reference numbering occurs after reference planning. The compiler receives only references that will actually be sent, then binds each number to a character, place, style, pose, or object. The app never writes `Image 1` before capacity trimming.

#### Literal text

Required text remains a typed claim with exact spelling, language, casing, placement, and owning surface. The negative linter then knows not to activate blanket `text`, `letters`, or `logo` exclusions.

### Initial model rulings

- **Qwen Image 2512:** detailed structured prose; guarded, dedicated negatives.
- **Qwen Image Edit 2511:** delta-first numbered-reference instruction; no current endpoint negative field.
- **Seedream 4.5:** concise layered prose and explicit reference roles; budget aggressively before optional decoration.
- **Seedream 5 Lite:** its own prose pack, initially similar to 4.5 only where trials support parity.
- **SD 3.5 Large:** compact natural-language description; test against a compact-tag arm rather than assuming old SDXL syntax.
- **Wan 2.7 Image Pro:** structured prose; express exclusions in the main instruction because the endpoint has no negative field.
- **NSFW FLUX Dev:** subject + action + style + context; affirmative visual replacement; no weighting syntax.
- **LikeReality Pony v1:** Compel/Pony tags coordinated with the wrapper's injected score/negative preprompt.
- **SDXL PuLID:** compact SDXL tags as the first arm, with prose as a required comparison arm.
- **P-Image:** short concrete prose; no prompt upsampling for state-authoritative production until accepted by trial.

## Negative prompt system

### Named blocks

Start with small, composable blocks rather than a giant string:

- `generated_text_artifacts` — watermark, accidental caption, signature, or garbled letters only when no literal text/mark is requested;
- `photoreal_surface_artifacts` — waxy/plastic skin and synthetic-media cues only for relevant photoreal subjects;
- `anatomy_duplication` — duplicated/disconnected anatomy after intended species morphology and authored absences are subtracted;
- `hand_artifacts` — only when hands are visible or action-critical;
- `single_subject_integrity` — duplicate people/faces only for a one-subject task;
- `identity_drift` — endpoint-specific identity failure concepts where negative transport is shown to help;
- `composition_artifacts` — malformed crop, unintended cut-off, confused layout, or impossible overlap, scoped to camera/task;
- `background_clutter` — only when the requested scene is intentionally clean or sparse;
- `style_exclusions` — only when the desired style has a clear incompatible opposite;
- `provider_default_override` — explicit empty or replacement value when a wrapper default contradicts Vesper state.

### Conflict linter

Before rendering a constraint, compare it against:

- every required and optional positive concept;
- intended morphology and authored absences;
- subject count;
- visible/important body loci;
- requested literal text, logo, labels, or signs;
- style and medium;
- camera/framing and intended blur;
- operation/change contract;
- reference roles;
- provider hidden prompt sources.

Minimum collision rules:

- never ban `text`, `letters`, `logo`, or `signature` when one is authored;
- never ban `extra limbs`, `tails`, `horns`, `wings`, or other appendages without subtracting intended morphology;
- never ban `missing fingers` or `missing limbs` for an authored absence, amputation, or prosthetic state;
- never ban `multiple people` for an ensemble;
- never ban `cropped`, `close-up`, or `blur` when camera/style requests them;
- never ban illustration, anime, painting, 3D, or synthetic surfaces when that is the desired medium or subject material;
- never place the same concept in positive and negative channels unless a dialect-specific tested rule explicitly distinguishes the desired and undesired forms.

A conflict with authoritative world truth is resolved in favor of truth. The optional negative is dropped with a diagnostic. A required exclusion that cannot be expressed makes that endpoint/profile ineligible before provider spend.

### Transport resolution

The negative compiler returns one of four outcomes per constraint:

```ts
type ResolvedNegativeTransport =
  | { kind: "dedicated_field"; text: string }
  | { kind: "inline_instruction"; text: string }
  | { kind: "positive_replacement"; claims: readonly ImagePositiveClaim[] }
  | { kind: "dropped"; reason: string };
```

Examples:

- Qwen 2512, SD 3.5, Pony, and PuLID may receive a dedicated field;
- current Qwen Edit 2511 has no dedicated field, so identity and composition constraints become preserve/replacement claims when valid;
- FLUX and P-Image use positive replacement;
- Wan uses positive guidance and may use a tested inline exclusion where official endpoint guidance supports it;
- Seedream begins with positive replacement, with inline exclusions candidate-only until measured.

Separate management is preserved because the negative pack still owns the constraint. Provenance records that its expression moved into the positive text.

### Provider defaults and extra channels

Represent at least:

- provider default negative text;
- provider-injected positive/negative preprompt;
- prompt rewriting/upsampling;
- ADetailer positive/negative prompt pairs;
- refiner prompt channels;
- any endpoint-specific hidden quality preamble.

For LikeReality Pony, clearing `nsfw, naked` and leaving `prepend_preprompt` enabled are two different actions and must appear separately in the effective-prompt record.

## Compilation pipeline

One pure compiler should execute this sequence:

1. validate world digest/read token and required sources;
2. resolve the model/profile/version prompt binding;
3. build positive claims from the world digest and operation;
4. select negative constraints from the independently versioned negative pack;
5. resolve provider hidden/default prompt sources;
6. lint positive/negative collisions;
7. convert eligible negative constraints to dedicated, inline, or replacement transport;
8. merge replacement claims into the positive claim list with negative provenance retained;
9. fit optional semantic units to the endpoint's measured budget;
10. compile positive claims through the endpoint dialect;
11. compile the dedicated negative text through the endpoint dialect;
12. assign final reference numbering after reference planning;
13. map controls to provider fields without guessing unsupported inputs;
14. emit prompt-program provenance before provider execution.

No stage rereads canonical state.

## Failure and degradation behavior

Follow Vesper's resilience rules:

- missing required identity, morphology, target item, target location, operation, or reference role refuses before provider spend;
- a stale committed cut or mismatched digest fails closed;
- unavailable optional state is suppressed with a diagnostic;
- an unsupported optional negative is dropped and recorded;
- an unsupported required exclusion makes the profile ineligible;
- a positive/negative collision drops the negative unless doing so violates a required task constraint;
- an unrecognized dialect or pack version refuses rather than falling back to a generic prompt;
- database unavailability may use a code-owned, version-pinned fallback binding only when it is byte-identical to a known active version;
- provider schema drift never causes Vesper to invent a field name.

## Provenance and observability

Extend the existing render attempt metadata with an app/package prompt-program record. At minimum persist:

- world digest fingerprint and read token;
- visual-state fingerprint and selected feature keys;
- location/item source revisions and selected fact keys;
- operation contract fingerprint;
- model, endpoint, requested version, and executed version;
- profile and `promptStrategy`;
- prompt dialect ID;
- positive pack version, negative pack version, and binding version;
- positive claim IDs and negative constraint IDs;
- conflict decisions;
- transport outcome for each negative constraint;
- fitted/dropped optional claims;
- hidden/default prompt sources;
- compiled positive and dedicated-negative hashes;
- compiled text where existing retention and access policy permits it;
- final reference roles and numbered bindings;
- applied and dropped provider controls.

Suggested sibling metadata:

```text
meta.render        package/provider attempt
meta.visualState   existing character visual provenance
meta.worldState    location/item/read-token provenance
meta.promptProgram positive/negative packs, claims, constraints, compilation
```

Do not duplicate entire canonical entities in image metadata. Store identifiers, source revisions, fingerprints, and selected fact keys. A secured developer inspector can resolve current source definitions separately while clearly warning when they no longer match the historical revision.

## Admin and developer surfaces

Add separate management views for **Positive Prompt Packs** and **Negative Prompt Packs**. Each should support:

- endpoint/profile/task scope;
- active and candidate versions;
- evidence and last-reviewed date;
- semantic blocks/claims enabled by the manifest;
- compiled preview for fixed world fixtures;
- effective hidden provider prompt sources;
- positive/negative collision report;
- version diff;
- trial status and verdict;
- promote and rollback actions.

A combined preview shows both channels and the final provider payload because separate editing without combined inspection would hide collisions.

The initial surface should be read-only or candidate-only for pack content if unrestricted editing would outrun validation. Activation always requires a valid binding and accepted trial evidence.

## Migration from current prompt code

### Character modules

- `prompts-avatar.ts`, `prompts-format.ts`, and `prompts-appearance.ts` stop producing final model prose.
- Reusable source selection moves into the visual/world digest adapter.
- Avatar framing, background, and style become claims owned by the task, not embedded negative phrases.
- Exact age, morphology, wardrobe, and exposure wording moves to dialect compilers.

### Variant/edit module

- `prompts-variant.ts` becomes an operation/change-contract builder.
- The duplicated provider-neutral identity lock is retired after Qwen parity.
- “No text” and “no watermark” move to guarded negative constraints rather than remaining hidden inside positive prose.

### Item and location module

Done. `prompts-entity.ts` is deleted; item and location renders project their rows
into world-digest facts and compile through the Qwen 2512 dialect. Every field the
old builders used is still represented, and a new field now enters through the
projection registry rather than through another hand-edited prose template.

### Scene modules

- Single- and multi-reference paths produce one world digest and one claim set.
- Reference count changes transport, never the facts selected.
- Cast integrity and numbered binding are compiled after planning.

### Render-quality compatibility code

- `preparePromptForImageModel` and exact-slug prompt rewrites move into the dialect registry.
- Reviewed profile controls remain controls; they do not become prompt text.
- Transitional overrides are deleted only after profile bindings execute the accepted pack versions and live parity is recorded.

### Raw prompt callers

Lab, evaluation, and operator-authored callers explicitly choose:

- `raw_positive` with optional `raw_negative`; or
- a real prompt program built from fixtures/world state.

Raw mode bypasses fact-completeness and collision guarantees by design and is labeled as such in diagnostics.

## Delivery stages

### Stage 0 — research and current-behavior freeze

Status: complete — 2026-08-19.

- record the endpoint/version evidence matrix;
- freeze current positive and negative payload hashes for representative routes;
- record provider defaults and hidden prompt sources;
- add architecture tests preventing new embedded “no X” boilerplate in production prompt builders;
- identify all raw-prompt escape-hatch callers.

Nine lanes are frozen — two avatar styles, two portrait variants, three scene
renders and the two chat lanes — and the embedded-exclusion census holds sixteen
phrases across five modules. Both are pinned so that changing one of those lanes
is a deliberate cutover rather than a diff nobody compared.

### Stage 1 — prompt-program and dialect contracts

Status: complete — 2026-08-18.

- add semantic positive claims and negative constraints;
- add dialect/transport registry contracts;
- add positive/negative pack and binding schemas;
- preserve current provider payloads through compatibility dialects;
- add deterministic fingerprints and parsing resilience.

No production prompt changes in this stage.

### Stage 2 — atomic world digest

Status: complete — 2026-08-18 for items, locations and the character wrapper; concurrent-mutation and branch-restore cases remain with the character-lane cutover that will exercise them.

- wrap the existing `VisualImageDigest` as the character slice;
- add location and item digest adapters;
- add source projection dispositions and CI classification checks;
- add relations, source revisions, transactional read tokens, and world fingerprints;
- test concurrent mutation, retake, branch restore, and retry-same-composition.

### Stage 3 — shadow prompt-program compilation

Status: void — the item and location lanes cut over directly. Shadow mode exists to de-risk a lane whose output an operator already trusts; these two had no identity to lose and their previous prompt was a hand-formatted paragraph, so comparing against it would have measured the thing being replaced. It remains the right approach for every character-bearing lane.

- build positive claims and negative constraints beside legacy strings;
- compile candidate prompts without sending them;
- compare fact coverage, reference roles, mandatory survival, collision decisions, and payload length;
- persist shadow diagnostics only on admin/dev trials.

### Stage 4 — positive dialect cutover

Status: in progress — item and location renders run on the Qwen Image 2512 dialect; every other lane keeps its existing prompt path. The cutover order below is revised: item and location moved first because they carry no identity risk.

Cut over one endpoint/task lane at a time:

1. Qwen Image Edit 2511 variants and identity-critical edits;
2. Qwen Image 2512 generation lanes;
3. Seedream and Wan multi-reference scenes;
4. SD 3.5, PuLID, Pony, FLUX, and P-Image;
5. item and location portraits;
6. remaining character-bearing routes.

Each cutover requires semantic parity plus a pinned visual trial. Do not migrate every model in one release.

### Stage 5 — negative system in shadow mode

Status: in progress — guarded blocks, the collision linter and the transport record are live for item and location renders. The compiled exclusions do not yet reach the provider: the Qwen 2512 row's `negative_prompt` field is unprobed, so the control drops as `no_binding` and every outcome is recorded as dropped. Probing the version is what turns this stage into Stage 6 for this endpoint.

- activate named blocks and collision linting without sending new negative text;
- verify intended morphology, literal text, style, and subject-count protections;
- record dedicated/inline/replacement/drop decisions;
- confirm provider-default overrides are represented.

### Stage 6 — negative transport promotion

Status: blocked on the owner — the trial instrument is built and prints both arms for free (`scripts/eval/prompt-programs/entity-negative-ab.ts`), but running it costs provider spend, and promoting the result means activating the Qwen 2512 version on production.

The instrument holds seed, packs, world and positive prompt constant across seven
fixed rows and varies only whether the compiled exclusions are sent, which is the
exact boundary a version probe crosses. It reads no database, so gathering the
evidence changes nothing in production; activating afterwards is a separate owner
action, and not a scoped one — pinning that row's version also switches on the
`steps` and `go_fast` settings that sit inert on the three portrait profiles.

Promote per endpoint/profile only after A/B evidence:

- Qwen 2512 targeted dedicated negatives;
- SD 3.5 and PuLID compact dedicated negatives;
- Pony wrapper-aware negative pack;
- FLUX/P-Image positive replacements;
- Wan/Seedream inline-exclusion candidates only if they beat positive replacement;
- Qwen Edit preserve/replacement language, without inventing a missing field.

### Stage 7 — pack management and evidence workflow

Status: in progress — the pack, version, binding and evidence contracts exist and the Qwen 2512 pair is code-owned and version-pinned. The tables, the admin surfaces and the promotion/rollback actions are remaining.

- add immutable pack versions and atomic bindings;
- add admin previews, diffs, source records, trial status, promotion, and rollback;
- add review-expiry and endpoint-version-change warnings;
- keep active production packs guarded from unvalidated free-form edits.

### Stage 8 — legacy retirement and enforcement

Status: in progress — `prompts-entity.ts` is deleted and its embedded exclusions are gone. The character-bearing prose builders remain until their lanes cut over.

- delete superseded route-specific prose builders and exact-string rewrites;
- remove embedded negative phrases from positive prompt modules;
- retire compatibility text/tag renderings that no production caller needs;
- add dependency/architecture tests preventing direct entity traversal in model compilers;
- update endpoint docs with the active dialect and pack binding.

## Test matrix

### Contract and compiler tests

- every dialect × prompt strategy;
- positive and negative pack version parsing;
- deterministic order and fingerprints;
- mandatory fitting floor;
- final reference numbering;
- unsupported-field drops;
- hidden provider defaults;
- code fallback byte parity;
- activation/rollback atomicity.

### Fact coverage tests

- sparse and heavily authored characters;
- humans, androids, non-humans, altered appendage counts, prosthetics, and authored absences;
- covered and exposed anatomy;
- layered/displaced/wet/damaged clothing;
- persistent and temporary location state;
- items with materials, parts, damage, contents, labels, attachments, and placement;
- multiple characters bound to distinct identity references and items;
- embodied viewer regions in frame;
- literal text and logo requests;
- nonvisual and restricted fields remaining absent.

### Collision tests

- requested text versus text-artifact block;
- ensemble versus single-subject block;
- intentional extra limbs versus anatomy block;
- authored missing finger versus missing-finger term;
- motion blur versus blur term;
- illustration versus photoreal exclusion;
- android/synthetic material versus plastic-skin term;
- intended close-up versus crop exclusion;
- Pony hidden preprompt versus visible pack;
- positive replacement generated from a negative constraint retaining its provenance.

### Atomicity tests

- wardrobe changes during compilation;
- item moves between containers during compilation;
- location light/weather changes during compilation;
- later chat cut after a retake;
- retry same composition after world state changes;
- positive and negative packs activated concurrently;
- stale digest paired with a new reference plan.

No test may pass by rereading live state after digest construction.

### Image trials

Hold seed, endpoint version, references, controls, and source digest constant. Grade at least:

- fact adherence;
- identity retention;
- morphology correctness;
- subject/reference binding;
- wardrobe/exposure authority;
- item identity and placement;
- location consistency;
- literal text accuracy;
- anatomy and hand quality;
- composition and crop;
- style adherence;
- accidental text/watermark;
- prompt latency, provider failure, and cost.

Include the Qwen geometry case: an edit that changes a seated/partial figure into a standing/full-figure pose, with explicit permission to expand the canvas compared against generic preserve-everything wording.

## Acceptance gates

The plan is accepted when:

1. every production route builds or explicitly opts out of an atomic world digest;
2. positive and negative programs derive from the same digest and read token;
3. every current endpoint/profile resolves a versioned dialect and compatible pack binding;
4. positive and negative packs can be promoted and rolled back independently without a render seeing a partial binding;
5. no universal negative string exists at the shared seam;
6. the linter prevents contradictions with required text, subject count, style, morphology, authored absences, and camera intent;
7. unsupported negative transport is recorded rather than guessed;
8. location and item facts are structured and future fields require an explicit projection decision;
9. final reference numbering matches the actual payload;
10. provenance can reproduce the source revisions, pack versions, dialect, constraints, compiled hashes, and transport decisions;
11. pinned image trials approve each promoted endpoint/task pack;
12. superseded route-specific model prose and embedded negative boilerplate are deleted.

## Open questions

- **Does a lane with no registered dialect refuse, or keep a legacy prompt?** The
  item and location lanes currently refuse and record the reason on the failed
  image row, which follows this plan's "refusal beats a generic prompt" ruling. It
  means repointing one of those profiles at an unbound model takes the lane out of
  service until a binding exists. Detail in
  [the spec](model-aware-image-prompts.spec.md).
- **Is `definition.sensory.tactile` visual enough to project?** Texture reads
  visually; "cool to the touch" does not. It is classified `nonvisual` today so the
  projection does not invent visual claims from prose about another sense. Splitting
  the field or promoting it needs an owner call.
- **How does authored lettering become a protected claim?** `item.marking` and
  `location.signage` are the two concepts that take the text exclusions off the
  table, and neither has a producer: an item or location whose authored
  description names lettering — a door plate reading EXIT, a shop window painted
  ALDWIN & SON — reaches the compile as ordinary optional prose, so the render is
  simultaneously asked to spell the words and told to exclude unintended text.
  Both cases are in the Stage 6 trial so the pictures say how much it costs.
  Closing it needs a decision about where the lettering comes from: a new
  authored field on the item and location rows, or a narrower reading of what the
  text exclusions may forbid when a description contains a quoted string.

## Owner decisions before implementation

None blocks the architecture, but these rulings should be settled before the named stages.

### Admin-writable pack content at first release

**Recommendation:** Stage 7 initially permits candidate manifests, priorities, and reviewed wording choices from a closed registry, with combined preview and trials. Do not launch unrestricted whole-template editing until validation and audit controls are proven.

### Meaning of “all information”

**Recommendation:** include all image-eligible structured truth and require an explicit projection disposition for every source field. Do not send biography, secrets, internal notes, nonvisual traits, or restricted data merely because they exist.

### Inline exclusions on endpoints without a negative field

**Recommendation:** default to affirmative replacement. Allow inline “do not include” only in a versioned dialect after the exact endpoint wins a fixed A/B trial.

### Prompt upsampling/rewriting

**Recommendation:** off by default for authoritative production renders. It may become a separate candidate profile after fact-invention and omission tests.

### Automated negative repair after a failed image

**Recommendation:** out of scope for the first system. Start with deterministic prompts and explicit retries. An image-analysis repair loop can later produce a new, auditable candidate prompt program rather than silently mutating the original.

### LLM-written production prompts

**Recommendation:** no free-form runtime rewriting. An LLM may help researchers draft candidate wording offline, but promotion stores deterministic pack content and test evidence.

## Out of scope

Automatic visual grading, cross-model fallback, best-of-N selection, self-correcting prompt agents, model fine-tuning, LoRA training, ControlNet/pose/depth implementation, reference-image extraction, narrator prompt refactoring, observer memory, and canonical world-schema redesign remain with their existing owners or future plans.