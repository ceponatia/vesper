# Image lane consolidation

Status: active (planned 2026-08-16)

Outcome: A developer can change how a character is visually described in one
place, so that portraits, scene images, edits, and chat images stop disagreeing
or preserving obsolete prompt code.

Technical companions:

- [visual-state selection and provenance](image-lane-consolidation.spec.visual-state.md)
- [prompt and lane migration](image-lane-consolidation.spec.prompts.md)
- [reference ownership and retirement](image-lane-consolidation.spec.retirement.md)

Evidence: [visual-state source and duplication audit](visual-state.audit.md)

Related owners:

- [visual state and attention](visual-state.plan.md) owns the lane-neutral
  snapshot, source adapters, visibility, attention, and image digest;
- [image render quality](image-render-quality.plan.md) owns semantic prompt
  segments, prompt budgets, and quality trials;
- [model-aware image prompt programs](model-aware-image-prompts.plan.md), its
  child plan, owns the per-endpoint dialects and negative steering this plan's
  Stage 5 waits on;
- [image model capabilities](finished/image-model-capabilities.plan.md) owns the
  shared render intent, profile planning, and role-aware reference transport;
- [scene composition](finished/scene-composition.plan.md) owns camera, staging,
  pose selection, and committed scene facts;
- [identity packs](finished/image-identity-packs.plan.md) owns identity-reference
  derivation and quality.

## Why this work is next

The audit found twenty-five appearance-summary producers, twenty-three with live
callers, plus duplicated age, wardrobe, exposure, identity-lock, cast-integrity,
and scene-assembly logic. Production lanes already converge on one render
kernel, and the shared render intent already accepts ordered semantic prompt
segments, but character-bearing lanes still hand it independently formatted
prose.

Adding another appearance feature today means deciding which of several prompt
builders and narrator helpers must be patched. The likely result is route drift:
the same person can receive a different age sentence, wardrobe description, or
appearance emphasis depending on whether the request is an avatar, variant,
single-reference scene, or multi-reference scene.

The next image work should therefore consolidate the lanes before adding more
model-specific or route-specific behavior. The work is a controlled migration,
not a rewrite of the image subsystem.

## What the owner gets

- One application-level selection of the visual facts that apply to a render.
- The same mandatory identity, morphology, age, wardrobe, exposure, and subject
  facts across every character-bearing image lane.
- Optional current-state and body-language detail selected from the same visual
  snapshot rather than rebuilt by each route.
- One scene prompt assembly regardless of reference count.
- Reference numbering and cast-integrity text that always match the final
  provider payload.
- Render records that explain which visual snapshot and feature fingerprints
  produced an image.
- Deletion of obsolete builders and exact-string compatibility machinery once
  their replacements are proven.
- Guardrails that prevent new direct appearance traversal or manual reference
  numbering from growing back.

## Boundaries

This plan consolidates character-bearing production image lanes: avatar,
single-character and multi-character scenes, variants/edits, chat look/selfie,
and staged character renders.

It does not force item-only, location-only, operator-authored lab prompts, or
trial fixtures through character visual state. Those callers may continue to
use an explicit raw-prompt escape hatch.

It does not redesign:

- the frozen recognition projection, feature keys, truth fingerprints, or
  observer visual-memory law;
- the visual-state source owners or their authority;
- scene camera, staging, contact, or pose policy;
- identity-pack derivation or reference quality;
- provider connectors, model profiles, LoRA/control behavior, or image storage;
- narrator appearance consolidation, except where a shared visual-state slice
  must remain compatible with the image consumer.

## Core rulings

### Consolidate facts before prose

Character facts remain structured until the model/profile compiler turns them
into prose or tags. This plan must not replace many appearance strings with one
new giant appearance string.

### Keep the application and package boundaries

The web application selects world facts and creates an image visual digest.
`@vesper/image-core` fits semantic segments, assigns final reference slots,
applies model dialects and controls, and compiles the provider request. The
package must not import character profiles, garment instances, anatomy state,
scene state, or the visual-state snapshot.

### One selector, not a new owner

The image visual digest is a camera-aware projection over existing owners. It
does not persist a second copy of character truth and cannot invent a fact when
an owner is unavailable.

### Mandatory facts do not compete with salience

Identity, intended morphology, apparent age, subject count, authoritative
wardrobe, exposure, requested operation, and authored absences remain mandatory.
Current-state and body-language details are optional and may be fitted according
to the model profile.

### Reference count does not change character wording

Single-reference and multi-reference renders use one segment builder. Reference
count changes transport strategy, not the algorithm that describes a person.

### Delete verified legacy code

After replacement coverage and relevant trials pass, superseded code is removed
rather than deprecated. Deletion requires no production, admin, evaluation,
dynamic, barrel, or persisted-format consumer.

## Delivery stages

### Stage 1 — guardrails and immediate dead-code deletion

Status: complete — 2026-08-16.

Freeze representative current outputs and invariants for each character-bearing
lane. Delete `intimateSceneAppearance` and `speciesAppearancePhrase` after a
fresh full-tree check confirms the audit's zero-consumer finding. Remove tests,
exports, and comments that exist only for those APIs. Preserve experimental
helpers that still have a preview, evaluation, or live call path.

The freeze renders one character through all six lanes and records which of that
character's facts each prompt actually states. It reads facts rather than
wording, so the later stages are free to rewrite prompts and are still caught the
moment a lane loses, duplicates, or newly exposes a fact. It also puts two
existing disagreements on the record: the text-to-image lane describes skin a
garment covers where the reference lanes do not, and the chat-look and variant
lanes carry no identity or morphology fact at all.

### Stage 2 — one image visual digest

Status: complete — 2026-08-21. A live conversation or a standalone character
can be turned into the single set of visual facts a picture of that character
would use, the admin inspector shows it for both chat lanes, and the first
production routes now read it and record it on saved images.
[The companion spec](image-lane-consolidation.spec.visual-state.md) lists what
is built.

Add the application adapter that selects required and optional camera-visible
facts from one snapshot. Preserve source keys, fingerprints, snapshot/source
versions, visibility evidence, and required/optional classification. Record
compact app-owned visual provenance beside package-owned render provenance.

### Stage 3 — avatar and single-character cutover

Status: built 2026-08-21 — awaiting pinned image trials over live providers
before Stage 6 removes the fallback assembly.

Move avatar and single-character scene renders from direct attribute, wardrobe,
age, exposure, and body traversal to the image digest and semantic prompt
segments. Keep portrait framing, style, camera, and scene composition behavior
unchanged. Compare final render intent and pinned trial outputs before removing
fallback assembly. The render-intent comparison is built and green; the two
companion specs record what each lane consumes and the deliberate fact-set
changes (the covered-skin fix and the morphology anchors scenes were missing).

### Stage 4 — remaining character-bearing lanes

Status: queued — depends on Stage 3.

Move multi-character scenes, variants/edits, chat look/selfie, and staged
character renders onto the same digest and segments. Represent an edit as an
operation/change contract while required identity and age preservation remain
semantic facts. Do not migrate item-, location-, or operator-authored lab
prompts without a character dependency.

### Stage 5 — one scene assembly and downstream reference ownership

Status: queued — depends on Stage 4 and on the model-aware plan's dialect
compilation reaching the character-bearing lanes.

Collapse the single- and multi-reference scene assemblers into one scene segment
builder. Make role-aware references declarative in the app and let
`@vesper/image-core` assign final image numbers and emit cast-integrity
instructions from the references that survive planning. Remove app-side
reference numbering and duplicate cast-integrity text.

Replace the exact-string portrait identity-lock coupling with an identity
semantic compiled by the selected model dialect. Remove both literal copies and
the `replaceAll` adaptation only after final Qwen output holds parity.

### Stage 6 — retire superseded formatting and budgeting

Status: queued — depends on Stages 3–5 and acceptance evidence.

Delete the old appearance summaries, direct avatar grouping, duplicate scene
assembler, redundant exposure/wardrobe renderers, and image-specific formatting
guards that have no remaining consumer. Retire the scene-local 1,500-character
string truncator only after profile-owned measured budgets and segment fitting
provide equal or better protection.

### Stage 7 — enforcement and acceptance

Status: queued — depends on Stage 6.

Add architectural tests that prevent production image modules from directly
deriving character appearance outside the adapter, manually numbering
references, or maintaining independently editable raw and segmented versions of
one request. Run the fixed visual-state and image-quality matrices, update live
image documentation, and record the owner verdict.

## Delivery order and parallel work

Stage 1 was independent and has landed.

Stages 2–4 consume visual-state work; they do not take ownership of it. Stage 5
coordinates with the model-aware plan's dialect work. A coding change must land
under the canonical owning plan when it changes that plan's contract, even when
this consolidation plan is the reason the work became urgent.

Character reference views and spatial scene controls remain separate products.
They should consume the consolidated lane after it exists rather than adding
another route-specific appearance builder first.

## Acceptance gates

Before a legacy path is removed:

1. no production import or caller remains;
2. no intentional admin, preview, or evaluation surface remains;
3. no dynamic registry, string lookup, or barrel/package consumer remains;
4. no persisted schema, replay, or provenance reader depends on it;
5. the replacement has unit and integration coverage;
6. required facts cannot be truncated or made optional;
7. covered, unavailable, or nonvisual facts remain silent;
8. reference labels match final send order;
9. retakes and branch restores reproduce the selected snapshot;
10. relevant typecheck, test, and pinned image trials pass.

## Success criteria

- Every character-bearing production image lane obtains character facts through
  one image visual digest.
- A single committed state yields the same required character segments across
  avatar, scene, edit, and chat-image routes.
- Single- and multi-reference scenes use one character-description algorithm.
- Final reference numbering and cast-integrity instructions are generated after
  reference planning and cannot contradict the payload.
- Mandatory identity, morphology, age, wardrobe, exposure, subject-count, and
  operation facts survive fitting.
- Visual provenance identifies the snapshot and selected feature fingerprints
  without duplicating all source values.
- The frozen recognition seam and observer memory remain byte-compatible.
- The two already-dead APIs and every post-cutover superseded helper are deleted.
- Raw prompts remain an explicit exception for non-character admin/lab/trial
  callers rather than the production default.
- CI rejects reintroduction of direct character appearance traversal and manual
  image numbering in production prompt code.

## Open questions

No owner decision blocks Stage 4.

The following are evidence questions governed by the named neighboring plans,
not reasons to invent local defaults:

- the optional-detail cap for each image task/profile;
- the measured prompt budget for each pinned model version;
- the exact visual-state slice at which every required digest source is ready;
- whether the final Qwen identity compiler reaches parity without any temporary
  compatibility wording.

## Out of scope

New visual-state truth owners, emotion inference, a generalized perception
engine, new image models, new reference-view generation, face repair, best-of-N,
cross-model fallback, pose/depth controls, LoRA training, narrator rollout, and
automatic vision extraction are outside this plan.
