# Model-aware image prompts — implementation state

Status: companion to [model-aware-image-prompts.plan.md](model-aware-image-prompts.plan.md)

This document owns **what is built, where it lives, and the rulings the build
settled**. The plan owns the design and the delivery order; the research doc owns
the endpoint evidence. When this document and the plan disagree about whether
something exists, this one is authoritative and the plan's stage line is the
summary to correct.

## Code map

| Concern                                       | Module                                                           |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Conflict-key vocabulary, medium protections   | `packages/image-core/src/prompt-program/conflict-keys.ts`        |
| Semantic concept registry                     | `packages/image-core/src/prompt-program/concepts.ts`             |
| Camera band vocabulary                        | `packages/image-core/src/prompt-program/camera-bands.ts`         |
| World digest contracts, builder, fingerprint  | `packages/image-core/src/prompt-program/world-digest.ts`         |
| Positive claim selection and ordering         | `packages/image-core/src/prompt-program/positive-claims.ts`      |
| Guarded negative blocks and guard derivation  | `packages/image-core/src/prompt-program/negative-constraints.ts` |
| Collision linter                              | `packages/image-core/src/prompt-program/collision.ts`            |
| Dialect contract and registry                 | `packages/image-core/src/prompt-program/dialects.ts`             |
| Qwen Image 2512 dialect                       | `packages/image-core/src/prompt-program/dialect-qwen-2512.ts`    |
| Pack, version, binding and evidence contracts | `packages/image-core/src/prompt-program/prompt-packs.ts`         |
| Seeded Qwen 2512 packs and bindings           | `packages/image-core/src/prompt-program/packs-qwen-2512.ts`      |
| The compile pipeline                          | `packages/image-core/src/prompt-program/compile-program.ts`      |
| Stored provenance shapes                      | `packages/image-core/src/prompt-program/provenance.ts`           |
| Source-field disposition registry             | `apps/web/src/contracts/images/world-projection.ts`              |
| Item and location projections                 | `apps/web/src/contracts/images/entity-digest.ts`                 |
| Character slice over `VisualImageDigest`      | `apps/web/src/contracts/images/subject-digest.ts`                |
| Entity lane read, compile and refusal         | `apps/web/src/server/images/entity-prompt-program.ts`            |

## What is built

**The core layer is complete and the Qwen Image 2512 vertical slice runs
end-to-end**: world digest → positive claims → negative constraints → collision
linting → transport resolution → the Qwen constructor → the provider payload,
with provenance for every step.

Two production lanes consume it: library **item** and **location** renders.
`prompts-entity.ts` is deleted. Every other image lane keeps its existing prompt
path until its own cutover.

The character slice (`projectSubjectDigests`) is built and exercised by the
package's collision cases, but no character-bearing lane is bound to a dialect
yet, so nothing routes through it in production.

## Rulings the build settled

### A concept's segment kind decides whether its claims can be fitted

The prompt-segment vocabulary protects `identity`, `morphology`, `age`,
`wardrobe` and `exposure` from budget trimming, and it applies that protection by
KIND. So a concept carrying optional detail must not be routed into one: an
item's authored description filed under `identity` would be a paragraph no budget
squeeze could remove, and the fitter would start compressing the sentences the
render actually depends on instead.

Consequences in the registry: `subject.appearance` sits in `current_state` (the
same call the visual digest already makes for presentation facts);
`item.identity` and `location.identity` DO sit in `identity`, because each
carries exactly one required fact — the name — with every optional detail
belonging to a different concept.

### Morphology protection is a tag handshake, not a kind lookup

`@vesper/image-core` must not learn what a species feature group is, and visual
state must not learn what `extra_appendages` means to a negative block. So a
projection tags a fact (`morphology.extra_appendage`, `morphology.absent_limb`,
`morphology.synthetic_surface`) and `imageMorphologyProtectionTags` says what the
tag buys. An untagged anatomy fact protects nothing, which is deliberate:
ordinary human anatomy is exactly what the duplication exclusions defend.

### A container field is classified when its members are

`definition.sensory` holds one visual member and two non-visual ones, so
classifying the blob as a whole would force one answer for all three.
`unclassifiedImageFields` therefore treats a container as covered once a member
of it is classified, and the coverage tripwire enumerates the leaves.

### The dialect declares a transport; the probe decides whether it exists

`compileImagePromptProgram` takes `negativeFieldAvailable` from the caller, which
reads it off the model version's probed control bindings. The Qwen dialect
declares a dedicated `negative_prompt` field, but the seeded 2512 row has empty
`advancedCapabilities`, so today every exclusion is recorded with a `dropped`
transport and no key is invented. Probing the version is the only change needed
to start sending them.

### Packs are code-owned until a table exists

`qwenImage2512PositivePack` and `qwenImage2512NegativePack` are version-pinned
code with content hashes computed exactly as a stored row's would be. The plan's
own degradation rule allows this: a code fallback is legitimate when it is
byte-identical to a known active version, and a code-owned pack is its own known
active version. A future migration must reproduce the same hash.

### An unbound lane refuses

`buildEntityPromptProgram` returns a refusal, and the pipeline writes it onto the
failed image row, when no binding exists for the resolved model and task. This
follows the plan's "refusal beats a generic prompt" rule and is deliberately
visible: repointing the item or location profile at an unbound model takes that
lane out of service until somebody adds a binding. The plan carries this as an
open question.

### The seeded negative pack leaves `identity_drift` off

Qwen Image 2512's reviewed identity preservation is `weak` and its reference input
is a strength-based repaint, so there is no identity to hold and a negative term
claiming otherwise would be superstition. It becomes a candidate the day an
identity-critical profile binds this endpoint, and it needs its own trial first.

## Contract deltas from the plan's sketch

The plan sketches shapes; these are the ones the build changed, and why.

- **`ImageWorldFact` carries `disposition`, not `required`.** One source of truth:
  a fact's projection classification decides both whether it enters the digest and
  whether fitting may drop it.
- **`ImagePositiveClaim` carries `objectRef`, not `relationRef`.** A relation claim
  needs the other END of the relation, and the relation itself is already the
  claim's concept.
- **Entity slices carry `label`.** `ref` and `entityId` are handles that must never
  reach a provider; a relation compiled from them would put database ids in the
  payload. The label is the projection's answer to "what would you call this in a
  sentence".
- **Bindings key on `profileKey`, not `profileId`.** A code-owned binding cannot
  know a row id a migration will generate, and the profile key is the same value
  the render fingerprint already uses.
- **`ImageCameraFact` is a discriminated union over the package's own bands.** The
  bands mirror the application's viewing vocabulary member for member; the copy is
  deliberate, so a game-side change surfaces in the adapter rather than reaching a
  negative guard as an unrecognized string.

## Test ownership

One package file, `packages/image-core/src/prompt-program/prompt-program.test.ts`,
owns three claims: the negative channel never forbids what the world requires
(a table over the plan's minimum collision rules); a compile is deterministic and
fails closed; the digest cannot carry a `restricted` or unknown-concept fact.

App-side, `apps/web/src/contracts/images/entity-digest.test.ts` owns the
projection decisions the deleted prose tests protected, and
`apps/web/src/server/images/world-projection-coverage.test.ts` is the tripwire
that fails when a table column or definition member has no projection decision.

Per-concept wording, per-block guards in isolation and pack contents are
deliberately untested: the first two are covered through the collision table and
the end-to-end compile, and enumerating a registry proves only that the list was
typed twice.

## Remaining

- Probe the Qwen Image 2512 version so the compiled exclusions reach the provider.
- Run the first pinned image trial for item and location renders.
- Freeze the current payload hashes for the lanes not yet cut over (Stage 0).
- Add architecture tests preventing new embedded "no X" boilerplate in the
  remaining prose builders.
- Cut over the character-bearing lanes, each behind its own dialect and trial.
- Move packs and bindings into tables with admin promotion and rollback.
