# Prompt programs

**One immutable set of world facts; two independently versioned prompt channels;
one endpoint dialect that words them.** A render never hands a model a paragraph
somebody wrote for it. It builds a **world digest**, compiles that digest into
**positive claims** and **negative constraints**, reconciles the two, and lets the
endpoint's **dialect** decide how each piece is said.

The layer lives in `packages/image-core/src/prompt-program/`. The application
owns projection — turning a Vesper item, location or character into digest facts —
because only it knows what a garment or an ambient blob is. `@vesper/image-core`
owns everything after that.

A lane is on the prompt-program path when its resolved model and task have an
**active binding**. Library item and location renders are, and so is every
character-image profile the catalog offers — portrait, variant, scene and
chat-look, on every model each is offered for. `chat_place` is deliberately
unbound: it is the one identity-free chat lane and it keeps its own builder.

Character-bearing lanes reach the layer through one shared seam, which owns the
character projection, the cast, reference planning and the identity anchor:
[character-prompts.md](character-prompts.md).

## The pipeline

```text
row / snapshot ─projection─▶ ImageWorldDigest ─┬─▶ positive claims ─┐
                                               │                    ├─▶ collision linter
                                               └─▶ negative blocks ─┘        │
                                                                             ▼
                                                          transport resolution
                                                                             │
                                                                             ▼
                                                     endpoint dialect ─▶ prompt + negative field
```

`compileImagePromptProgram` runs the whole sequence in one pure function.
Everything it needs arrives as a value: the digest is deep-frozen, the packs are
data, and the dialect is a pair of pure functions. **No stage rereads canonical
state**, which is why a negative constraint can never be evaluated against a
different moment than the positive prompt describes.

## The world digest

`ImageWorldDigest` is what one render knows, read once. It carries scene facts,
subjects, a location, items, typed relations between them, camera bands, the
operation contract, reference facts, suppressions, and the source revisions
everything was read at. It is deep-frozen at construction and fingerprinted over
its ordered contents, so two compiles of the same world are byte-equal and a
moved source row produces a different fingerprint.

`read` says which moment this is. A chat or scene render uses a
`committed_cut` token; a standalone item, location or portrait render uses a
`transactional_projection` token minted from the source revisions. That is what
makes "retry this exact composition" distinguishable from "render current state".

**Every fact is typed, never prose.** A fact carries its key, its concept, a
structured value, its semantic tags, its projection disposition, a priority, and
the owner's own source reference. The source reference is diagnostic only — no
compiler in the package reads it, so provenance cannot leak into a payload.

### Projection dispositions

Every image-eligible source field carries one classification, recorded in
`apps/web/src/contracts/images/world-projection.ts`:

| Disposition       | Meaning                                                  |
| ----------------- | -------------------------------------------------------- |
| `required_visual` | the image is wrong without it; fitting may never drop it |
| `optional_visual` | real visual detail, first to go under a budget squeeze   |
| `relational`      | binds entities together rather than describing one       |
| `reference_only`  | reaches the render as an image, not as words             |
| `nonvisual`       | true, but nothing a picture can show                     |
| `restricted`      | visual but deliberately withheld                         |
| `unsupported`     | no dialect can express it yet                            |

Only the first three produce facts, so a `restricted` field has no shape in which
to reach a prompt. **A field with no classification is an oversight by
definition** — `world-projection-coverage.test.ts` derives the field list from the
table columns and the definition schemas and fails when one is unclassified.
`nonvisual` and `restricted` are good answers; silence is not.

## Concepts

A concept is what a fact MEANS, in a closed registry no model owns
(`concepts.ts`). "Auburn hair" is `subject.appearance` — not the sentence and not
the tag. Each concept declares three things:

- **the channel it belongs to** — operation, scene, viewer, subject, camera,
  relation, item, location or style — which is what kind of world fact it is, and
  which fixes the order the selector walks and the order a duplicated fact key is
  resolved in;
- **the prompt-segment kind its prose belongs to**, so the existing canonical
  order and mandatory floor apply to claims for free;
- **the conflict keys asserting it protects**, which is the whole safety property
  of the negative channel.

**A channel is not a segment kind, and neither implies the other.** The channel
answers what kind of fact this is; the segment kind answers where its words land.

A concept's segment kind therefore decides whether its claims can be trimmed. The
segment vocabulary protects `identity`, `morphology`, `age`, `wardrobe` and
`exposure` **by kind**, so a concept carrying optional detail must not be routed
into one — an item's authored description filed under `identity` would be a
paragraph no budget squeeze could ever remove.

## Scene semantics

A chat scene is planned in the application and compiled here, so the two need a
vocabulary belonging to neither a registry nor a dialect.
`packages/image-core/src/scene-ir/` is it: the closed staging, capture-mode,
camera, viewer-part and exposure-region vocabularies, the provider-neutral
staging semantics, and the carrier for the registry's measured wording.

| Layer                 | Owns                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| `apps/web`            | the registries, scene planning, evidence gating, measured wording, the lowering |
| `image-core/scene-ir` | the compiler-input vocabulary: ids, staging semantics, the surface-form carrier |
| `image-core`          | compilation, the concept program, dialect wording, its own coarsened bands      |

The application does not own an id merely because it owns the registry that
decides when the id applies: the compiler owns the opcode, the application owns
the logic that emits it. Drift is a compile error rather than a parity test — the
staging registry is a keyed record written `satisfies SceneStagingTable<…>`, so
extending the id union fails the registry until it answers for the new id.
`scene-ir` is a **package boundary drawn inside a package**: it may depend on
`@vesper/contracts` and Zod and on nothing else — never a dialect, a provider
config, any other compiler internal — so a later extraction is a file move plus an
import rewrite. Its names reach consumers through the package's single `.` entry.

Six concepts describe the SHOT rather than anybody in it: `scene.mood`,
`scene.capture_mode`, `scene.possession` and `scene.staging`, plus
`subject.activity` — what a person is DOING, which is not how they are held — and
`camera.height`. Scene facts ride a flat list on the digest rather than an entity
slice, because a scene has no ref a relation could point at. There is no "scene"
prompt segment: mood emits in `atmosphere`, capture mode in `framing`, and
staging, possession and activity in `pose`. **No scene concept may be filed into
`identity`, `morphology`, `age`, `wardrobe` or `exposure`** (owner ruling
2026-09-01), which are unfittable by kind — a scene is the layer that gives way
under a budget squeeze before a character stops being recognizable. A scene fact
that must survive says so on the fact, through a `required_visual` disposition.

### The viewer is a channel, not a subject

An embodied first-person shot crops the viewer's own hands, forearms, lap, legs
or torso into the foreground, and the viewer is deliberately not in the cast:
they have no entity slice, no ref a relation could bind, no identity reference,
and no place in `operation.subjectCount`. Three concepts carry them —
`viewer.body_geometry` (which parts the frame holds, as ids from the shared part
vocabulary), `viewer.appearance` (the skin and build of those parts) and
`viewer.intimate_anatomy` (the exposed half, on a route that permits it). They
ride the same flat scene list for the same reason scene facts do, and their own
channel is what keeps them apart from it: geometry emits in `pose` beside the
staging it complements, the two descriptive concepts in `current_state`, and
none of them in a mandatory kind.

`scene.capture_mode` distinguishes the embodied first person from the
disembodied one, because the two decide different prompts: the disembodied form
asserts the viewer's absence and lets `scene.possession` bind every visible limb
to the cast, while the embodied form asserts only that the face and head stay out
of frame — binding the cast to every visible limb there would hand them the
viewer's own hands. The count claim stays the cast's either way; how a dialect
words it beside cropped viewer anatomy is the dialect's decision
([pipelines/scene-framing.md](pipelines/scene-framing.md) §Whose eyes the shot is
through).

### Measured wording is a versioned artifact

Wording belongs to a dialect, and staging is the one exception, on evidence: a
minority of each tuned template's characters carries nearly all of its measured
delta, and what those characters encode is model behaviour rather than scene
meaning, so no dialect can re-derive them from typed semantics. A `scene.staging`
claim therefore carries a **surface form** — the arrangement, a readable revision
(`on_all_fours@3`), and a SHA-256 digest of the bytes that revision means.

It is not a prose escape hatch, structurally: a caller cannot supply a string,
because a form is reachable only by closing a table total over the staging
vocabulary; the text sits behind a module-private symbol with one named read, so
**every dialect explicitly adopts or replaces the sentence** and neither is a
silent default (the prose and Qwen families adopt, the tag family replaces); and
the claim keeps its concept, channel, segment kind, conflict keys and priority,
so it stays ordered, protected, fitted and traceable.

Any change to the registry's exact string bumps the revision, even when the
phrasings are believed equivalent; re-running a measurement against a different
model does not, because that is a new measurement of the same artifact. The
digest is authored data verified by one app-side test — the only place SHA-256
runs, since this package is browser-portable and may not import `node:crypto`.

## Positive claims

`selectImagePositiveClaims` turns a digest into ordered claims, walking the
operation contract first, then the scene, then subjects, camera, relations,
items, the location, and style. Nothing is invented: every claim traces to a
fact, a relation, a camera band or an operation member the digest already
carried.

Emission order is the prompt-segment vocabulary's canonical order, with mandatory
claims ahead of optional ones inside each kind. A dialect may reorder within its
own compile; the fitter protects the mandatory floor either way.

## Negative constraints

There is **no universal negative string**. Steering is composed from named,
guarded blocks over the same conflict-key vocabulary the positive side protects:

| Block                         | Forbids                                            | Applies when                         |
| ----------------------------- | -------------------------------------------------- | ------------------------------------ |
| `generated_text_artifacts`    | unintended text, garbled letters, captions         | nothing must be legible              |
| `watermark_and_signature`     | watermark, signature, logo                         | always                               |
| `photoreal_surface_artifacts` | waxy skin, over-smoothing, oversaturation          | photoreal render with a person in it |
| `anatomy_duplication`         | extra and missing limbs, digits, appendages        | at least one subject                 |
| `hand_artifacts`              | malformed hands, extra fingers                     | hands in frame or holding something  |
| `single_subject_integrity`    | additional people, duplicated faces                | exactly one subject                  |
| `identity_drift`              | a different face from the reference                | an identity reference is being sent  |
| `composition_artifacts`       | cut-off subject, confused layout, awkward cropping | the camera did not ask for a crop    |
| `background_clutter`          | cluttered background, unrelated objects            | the task wants a clean backdrop      |
| `style_exclusions`            | the media this render is not in, low quality       | a medium was actually stated         |
| `provider_default_override`   | whatever the wrapper injects                       | synthesized from the endpoint        |

A guard decides whether a block makes sense for the job. The **linter** then
decides whether this particular world contradicts it.

## The collision linter

Set subtraction over conflict keys, and deliberately boring. A claim declares the
keys it protects; a constraint declares the keys it forbids; a key claimed on both
sides is removed from the **negative**, because a conflict with authoritative
world truth resolves in favour of truth.

- A constraint that loses some keys is **narrowed**.
- A constraint that loses all of them is **dropped**, with the claim that
  displaced it recorded.
- A **required** constraint that loses all of them makes the profile ineligible
  before any provider spend.

Protections come from three places: the concept registry (asserting
`location.signage` protects lettering whatever the sign says), a fact's own
semantic tags (a species feature group tagged `morphology.extra_appendage`
protects the anatomy exclusions), and the operation and camera (which medium,
which framing band, how many people).

What it enforces, concretely: requested lettering disarms the text block; an
ensemble disarms the single-subject block; a portrait crop disarms the cropping
exclusions; a moving subject disarms `blur`; an illustrated render disarms
`illustration`; an authored amputation disarms the missing-anatomy terms; an
android's synthetic surface disarms `waxy skin`.

## Dialects and transport

A dialect is how ONE endpoint wants a job expressed — a different axis from
`promptStrategy`, which says what the job IS. The registry is code and closed: a
profile binding selects an entry by id and can never carry a template.

Each dialect declares its positive and negative syntax, its negative transport
(`dedicated_field`, `inline_instruction`, `positive_replacement`, or
`unsupported`), its reference syntax, whether it supports weights and literal
quotes, and its **hidden prompt sources** — the provider defaults, injected
preprompts, upsamplers and refiner channels that alter the effective prompt
without being asked. A wrapper that injects a non-empty default negative gets an
explicit override constraint synthesized for it.

**A dialect's declared transport is not permission to use it.** Whether the
running version actually exposes the field is a probe fact supplied by the caller;
when it does not, every exclusion is recorded with a `dropped` transport and no
key is invented.

**And a field that exists is not a field that works.** `qwen/qwen-image-2512`
exposes `negative_prompt` and ignores it — the measurement is owned by
[its model page](../image-models/models/qwen-image-2512.md). Its dialect
therefore declares `unsupported`, so every exclusion drops with the reason
`endpoint_ignores_negative_field` — recorded, never sent — and probing the row
cannot change that. On an endpoint like this the positive channel is the only one
that steers, and exclusions that matter have to become affirmative claims.

A binding naming a dialect with no registered compiler **refuses**. Falling back
to a generic prompt would silently drop every guarantee this layer provides.

### Families

Every declared dialect id has a registered compiler, and several ids share an
implementation. That is deliberate and bounded: each id keeps its own registry
entry, its own pack pair and its own binding, so promoting a wording finding for
one endpoint moves nothing on the others, and an endpoint that earns wording of
its own forks out without disturbing its former siblings.

| Family     | Positive syntax  | References   | Endpoints                                                        |
| ---------- | ---------------- | ------------ | ---------------------------------------------------------------- |
| Qwen 2512  | natural language | none         | the description generator                                        |
| Qwen edit  | natural language | numbered     | the delta editor, and the LoRA-capable wrapper                   |
| Prose      | natural language | role labels  | Seedream, Wan, SD 3.5 Large, FLUX Dev, P-Image                   |
| Tag        | comma tags       | none         | LikeReality Pony (Compel weights), SDXL PuLID                    |

**Numbered slots are a Qwen-family convention** (owner ruling 2026-08-24), not a
property of taking a reference array. Seedream and Wan accept ordered arrays and
document no numbering convention, so the prose family names each reference by
its role and the person or place it shows, and asserts no slot number. A prompt
that never says "Image 2" cannot say it about the wrong image.

## Packs and bindings

Positive and negative packs are separate products with separate versions,
evidence and promotion history. A **binding** pins one profile to one dialect and
one compatible pack pair, so a render never observes half an activation.

A binding's status says which pack pair production runs. Production resolution
(`activeImagePromptBinding`) sees only `active` rows, and null is an ordinary
answer rather than a fault — what it means is the lane's own law. `chat_place` is
unbound by design and keeps its own builder; a character-bearing lane has no
second prompt path, so an unbound scene rung is dropped from its degradation
chain rather than worded another way.
A binding exists only for a profile that actually renders on the bound model — a
profile riding another endpoint gets no row, never a reserved name. Pack
**versions** carry their own status independently: it records the data's
promotion state, not any lane's rollout.

A binding is keyed on the profile key, the model slug and the task, with the
prompt strategy narrowing further where one profile is asked for two job shapes.
Every dimension is load-bearing:

- **The model slug**, because several profiles share one key across models — five
  variant profiles are all `variant-standard`, and a key without the slug would
  hand all five one endpoint's dialect and packs. Resolution takes the **base**
  slug: a community checkpoint's row carries a `:version` pin, and a binding
  names an endpoint while `versionId` separately pins a provider version.
- **The profile key**, because a profile added on a bound model later must not
  inherit a binding nobody wired it into.
- **The prompt strategy**, because a scene profile is asked for two shapes. Its
  chain degrades multi-reference edit → single-reference edit → bare
  text-to-image, and the last states `text_to_image_description` where the others
  state `instruction_edit`. A binding pins one strategy and the compile refuses a
  mismatched pair, so each scene profile carries two rows sharing one pack pair;
  without the second, a scene would refuse the moment its references became
  unusable, turning a designed degradation into a failed render.

Resolution runs on a lane's **final** resolved profile, after any model swap. The
variant bench kind and the intimate scene route both pair their picked profile
with a LoRA wrapper model, so the wrapper carries bindings of its own — resolving
from the pre-swap profile would bind a program to a model the render does not run
on, and leaving the wrapper unbound would be a legacy exception no binding table
shows.

A pack manifest says which named blocks are enabled, their order and priority,
which reviewed wording variant to use, and which evidence backs each choice. It
may **not** contain executable code, a condition expression or a whole-prompt
template — a malformed or adversarial template must not become production
behaviour through an admin field.

A positive pack's **suppressed concepts govern every claim source, including the
pack's own rendering-intent descriptors**. You suppress `style.descriptor`
because the model degrades when style words appear, so a pack that went on
emitting its own would defeat the setting it declared. Suppressing a concept the
render may not lose refuses instead.

Evidence carries a source type, a URL, a review date, the endpoint version and a
confidence. A community or Reddit finding can justify a trial; only an
authoritative endpoint source or a Vesper trial verdict satisfies a promotion.

## Failure behaviour

Every refusal happens before provider spend, and each has its own code:

| Code                                                    | Cause                                                 |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `image_prompt_program.dialect_unregistered`             | the binding names a dialect nothing implements        |
| `image_prompt_program.strategy_mismatch`                | binding and operation disagree about the job          |
| `image_prompt_program.world_stale`                      | a retry's digest describes a different read           |
| `image_prompt_program.pack_dialect_mismatch`            | a bound pack was authored for another dialect         |
| `image_prompt_program.missing_required_fact`            | a required world fact never reached the digest        |
| `image_prompt_program.mandatory_concept_suppressed`     | the pack suppresses a concept the render may not lose |
| `image_prompt_program.mandatory_claim_dropped`          | the endpoint cannot express a protected claim         |
| `image_prompt_program.required_exclusion_unexpressible` | a required exclusion is contradicted by world truth   |
| `image_prompt_program.post_merge_collision`             | a replacement claim contradicts a surviving exclusion |

Softer degradation is reported and carries on: a narrowed or dropped optional
constraint, a trimmed optional claim, a version with no negative field, and a
preserve entry naming a fact this program does not state
(`image_prompt_program.preserve_unworded`). The character seam adds three
refusals of its own — [character-prompts.md](character-prompts.md).

## What may reach a provider

The compiled text is prose a model is asked to act on, and nothing else may
travel in it.

- **No internal handle reaches provider prose.** Not a database id, a projection
  source key, a registry kind id, a fact key or a fingerprint. Claims and
  contracts identify facts structurally because that is what makes a set
  derivable and checkable; turning an identifier into language is the dialect's
  job, and a dialect that cannot word an entry drops it and reports rather than
  emitting the identifier.
- **The preserve set is structural; its wording is not.** A change contract
  names the facts an edit must not touch by key. The dialect resolves each key
  against the program's own claims and renders what the fact names — its locus,
  or its concept's noun — never the key. An entry the program does not state is
  dropped, and the sentence disappears entirely rather than shrinking to a list
  of handles; a mandatory preserve claim that renders nothing is a dropped
  mandatory claim, which refuses before provider spend.

## Provenance

Two sibling keys on the image row's `meta`, beside the existing `render` and
`visualState` records:

- **`meta.worldState`** — read kind and token, world fingerprint, entity refs,
  selected fact keys, source revisions, suppressions.
- **`meta.promptProgram`** — program fingerprint, binding and both pack versions,
  dialect, strategy, task, model slug, surviving and dropped claim ids, every
  constraint's transport outcome with the keys it kept and lost and the claim that
  displaced each, the endpoint's hidden prompt sources, hashes of the compiled
  positive and negative text, and the final reference bindings.

A staging claim that reached the prompt also records what became of the registry's
measured sentence: the arrangement, its revision and digest, whether the dialect
adopted or replaced the wording, and which dialect decided. That record is what
stops a reader concluding from a revision alone that the measured words were sent.
A claim that did not survive fitting carries no such record and appears among the
dropped ids instead, so the two can never describe one claim differently.

The program fingerprint covers **which exclusions were delivered**, not only
which were selected — two renders whose packs, linter and world are identical
still fingerprint apart when one carried its exclusions and the other dropped
them, because identity follows the payload rather than the intent.

Identifiers and fingerprints, never copies of the world. A developer inspector
resolves current definitions separately and can say plainly when they no longer
match the revision a render used.
