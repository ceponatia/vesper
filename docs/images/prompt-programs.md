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

Not every lane uses it yet. A lane is on the prompt-program path when its
resolved model and task have an **active binding**; today that is library item and
location renders on `qwen/qwen-image-2512`. Every other lane keeps its existing
prompt builder.

Character-bearing lanes reach the layer through one shared seam,
`apps/web/src/server/images/character-prompt-program.ts`. It owns the whole
semantic path — the world-digest assembly, the operation contract, binding and
pack resolution, reference planning, the prompt budget and the compile — and
both the shadow that measures a cutover and the production render that performs
one call it. That sharing is a requirement, not a convenience: a lane's
accumulated shadow evidence describes the prompt production will send only if
the same code built both. The two callers differ in exactly two arguments —
which binding statuses resolution may see, and whether a lost required anchor
refuses or is tolerated so it can be measured.

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

`ImageWorldDigest` is what one render knows, read once. It carries subjects,
a location, items, typed relations between them, camera bands, the operation
contract, reference facts, suppressions, and the source revisions everything was
read at. It is deep-frozen at construction and fingerprinted over its ordered
contents, so two compiles of the same world are byte-equal and a moved source
row produces a different fingerprint.

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

### The character projection

Character subjects reach the digest through a two-module seam in
`apps/web/src/contracts/images/`, and the split is an ownership boundary, not a
convenience:

| Layer                          | Owns                                              |
| ------------------------------ | ------------------------------------------------- |
| visual state                   | which facts apply, and required vs camera-visible |
| canonical character owners     | the semantic value of each selected fact          |
| `subject-digest.ts` (scaffold) | vocabulary translation; it adds no truth          |
| `character-adapter.ts`         | joining selection to values as complete claims    |

`projectSubjectDigests` translates the visual digest's classification into
concepts and dispositions, verbatim. `projectCharacterWorldSlices` consumes it
and states what translation alone cannot:

- **A truth fingerprint is provenance, never prompt semantics.** Appearance
  facts arrive carrying their fingerprint as `value`; the adapter answers them
  from the canonical owners — the attribute registry, the located-fact rows, the
  anatomy rows — and never decodes or guesses from a fingerprint. A fact no
  owner can value is suppressed, and a required one lands in `missingRequired`
  so a lane compiled with `refuseOnMissingRequired` fails closed.
- **Apparent age** is stated from the `identity.apparent_age` attribute through
  the image age vocabulary (`imageAgeBandPhrases`), whose floor is an explicit
  adult (owner ruling 2026-07-29): a minor band the registry recognizes states
  nothing — a designed suppression, never a missing anchor — while an absent
  value, or one outside the registry's vocabulary, fails the mandatory age
  segment closed.
- **Exposure** is the adapter's own authoritative `subject.exposure` claims over
  the garment coverage readout, worded by `visual-segments.ts`'s one canonical
  table — in its predicate-fragment inflection, since dialects wrap exposure
  values as `<subject> is <value>` — and gated to the regions the digest's
  framing band can show. Covered regions are silent — silence is the covered
  statement — and a subject with no joined coverage readout fails the mandatory
  exposure closed.
- **An authored absence** re-files its anatomy fact as `subject.absence` — the
  same `morphology` segment kind, a different protection — which takes the
  missing-part exclusions off the negative channel's table; a prosthetic
  additionally tags `morphology.synthetic_surface`.
- **Every emitted value is prompt-ready.** Record-shaped values resolve to their
  readable members with ids stripped; a record with nothing readable left is
  suppressed rather than flattened into a payload.

## Concepts

A concept is what a fact MEANS, in a closed registry no model owns
(`concepts.ts`). "Auburn hair" is `subject.appearance` — not the sentence and not
the tag. Each concept declares two things:

- **the prompt-segment kind its prose belongs to**, so the existing canonical
  order and mandatory floor apply to claims for free;
- **the conflict keys asserting it protects**, which is the whole safety property
  of the negative channel.

A concept's segment kind therefore decides whether its claims can be trimmed. The
segment vocabulary protects `identity`, `morphology`, `age`, `wardrobe` and
`exposure` **by kind**, so a concept carrying optional detail must not be routed
into one — an item's authored description filed under `identity` would be a
paragraph no budget squeeze could ever remove.

## Positive claims

`selectImagePositiveClaims` turns a digest into ordered claims, walking the
operation contract first, then subjects, camera, relations, items, the location,
and style. Nothing is invented: every claim traces to a fact, a relation, a camera
band or an operation member the digest already carried.

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

## Packs and bindings

Positive and negative packs are separate products with separate versions,
evidence and promotion history. A **binding** pins one profile to one dialect and
one compatible pack pair, so a render never observes half an activation.

A binding's status is the lane's rollout state (owner ruling 2026-08-29). An
`active` row means the lane is cut over: production resolution
(`activeImagePromptBinding`) sees only active rows, and null is its ordinary
staged-rollout answer — the lane keeps its existing prompt builder. A
`candidate` row is a real binding under shadow measurement: the character-lane
shadow resolves it through `imagePromptBindingForShadow`, which accepts
candidate and active rows alike so a promotion never changes the shadow's
answer, while production resolution never sees it. Cutover is the
candidate → active promotion of the row. A binding exists only for a profile
that actually renders on the bound model — a profile riding another endpoint
gets no row, never a reserved name.

A binding is keyed on the profile key, the model slug and the task, and
resolution runs on a lane's **final** resolved profile — after any model swap,
such as the variant lane's bench kind pairing its profile with a LoRA wrapper
model. The slug is load-bearing: several profiles share one key across different
models, so a key without the slug would cut over every one of them at once.
Resolving from a pre-swap profile would bind a program to a model the render
does not run on. Pack **versions** carry their own status
independently: it records the data's promotion state, not any lane's rollout.

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
constraint, a trimmed optional claim, a version with no negative field.

## Provenance

Two sibling keys on the image row's `meta`, beside the existing `render` and
`visualState` records:

- **`meta.worldState`** — read kind and token, world fingerprint, entity refs,
  selected fact keys, source revisions, suppressions.
- **`meta.shadowComparison`** — on a character lane under shadow measurement, a
  compact verdict (`parity`, `divergence`, `unmeasured` or `error`) over fact
  coverage, transport parity, mandatory survival and both payload lengths, with
  the diagnostic codes that produced it. Every stored list is capped, and the
  full detail is log-only. It keeps being recorded after a lane is cut over,
  because the shadow resolver sees a row across its promotion and an observation
  is most worth having at the moment the lane starts relying on it.
- **`meta.promptProgram`** — program fingerprint, binding and both pack versions,
  dialect, strategy, task, model slug, surviving and dropped claim ids, every
  constraint's transport outcome with the keys it kept and lost and the claim that
  displaced each, the endpoint's hidden prompt sources, hashes of the compiled
  positive and negative text, and the final reference bindings.

The program fingerprint covers **which exclusions were delivered**, not only
which were selected — two renders whose packs, linter and world are identical
still fingerprint apart when one carried its exclusions and the other dropped
them, because identity follows the payload rather than the intent.

Identifiers and fingerprints, never copies of the world. A developer inspector
resolves current definitions separately and can say plainly when they no longer
match the revision a render used.
