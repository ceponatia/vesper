# Image identity packs — render integration spec

Status: detail for [image-identity-packs.spec.md](image-identity-packs.spec.md)

Trial protocol:
[image-identity-packs.spec.trial.md](image-identity-packs.spec.trial.md)

This document owns profile-aware eligibility, reference-role emission, shared
render-intent integration, provenance, rollout, and consumer tests.

## Integration boundary

The identity-pack service exposes authorized candidates and measured eligibility.
It does not choose a model, reorder unrelated references, build provider payloads,
or write provider-specific prompt prose.

The image-model capabilities/profile layer owns:

- whether a task is identity-critical;
- which identity roles a profile accepts;
- role ordering;
- required versus optional roles;
- total reference capacity;
- provider transport field names;
- effective reference resize behavior;
- ineligibility when all required identities cannot fit.

The render-quality layer owns:

- numbered or delta-first provider instructions;
- model-native prompt dialect;
- quality controls;
- identity and composition trial verdicts;
- face repair and output QA.

## Reference roles

V1 exposes two roles:

```ts
export type IdentityReferenceRole =
  | "canonical_identity"
  | "face_detail";
```

The canonical role points at the character's current source portrait. It carries
broad face, hair, body, age, and presentation context.

The face-detail role points at the hidden crop. It carries higher local facial
detail but less body, hairstyle, and composition context.

Neither role is universally superior. Profiles choose a strategy based on the
model, task, and capacity.

## Candidate contract

```ts
export interface IdentityReferenceCandidate {
  role: IdentityReferenceRole;
  imageId: string;
  packId: string;
  packRevision: number;
  sourceImageId: string;
  sourceContentHash: string;
  required: boolean;
  warningCodes: ImageIdentityPackWarningCode[];
  evaluation: {
    policyVersion: string;
    effectiveReferenceWidthPx: number | null;
    effectiveReferenceHeightPx: number | null;
    effectiveFaceWidthPx: number | null;
    effectiveFaceHeightPx: number | null;
  };
}

export type EvaluateIdentityPackResult =
  | {
      eligible: true;
      candidates: IdentityReferenceCandidate[];
      warnings: ImageIdentityPackWarningCode[];
    }
  | {
      eligible: false;
      code: ImageIdentityPackFailureCode | "profile_ineligible";
      messageKey: string;
    };
```

The candidate contract contains ids and measurements, not file bytes. Shared
render intent resolves authorized bytes through the normal image service only
after selection.

## Profile identity strategies

A profile declares one strategy:

```ts
export type IdentityReferenceStrategy =
  | "canonical_only"
  | "face_detail_only"
  | "canonical_then_face_detail"
  | "face_detail_then_canonical";
```

Profiles may declare the face-detail role optional. Examples:

- a one-reference editor may use `canonical_only` until trial evidence proves
  `face_detail_only` is better for that task;
- a two-reference identity editor may use `canonical_then_face_detail`;
- a repair profile may prefer `face_detail_then_canonical` when the original
  scene image occupies another required role;
- a scene generator with weak identity-reference support may remain canonical
  only.

The strategy belongs to the pinned profile/version. It is not inferred from the
number of image fields in a provider schema.

## Required identities and capacity

Required character identities are resolved before optional face detail, location,
style, object, or pose references.

For an ensemble:

1. resolve one required canonical identity candidate for every required
   character;
2. prove that the profile can transport all required identities;
3. add optional face-detail roles in deterministic profile order;
4. add non-identity roles according to the capabilities plan;
5. refuse the profile when required roles exceed capacity.

A profile never ejects one character's identity to fit another character's face
crop or an optional style image.

V1 identity packs remain one-character packs. Ensemble composition is a render
request concern, not a multi-character pack record.

## Eligibility timing

Identity-pack eligibility runs before provider reservation and after profile
resolution, because effective provider resize and role strategy are profile
facts.

```text
resolve character + canonical source
-> ensure current identity pack
-> resolve eligible model profile
-> evaluate pack under profile policy
-> select all required references
-> reserve render/provider budget
-> fetch authorized reference bytes
-> build provider payload
```

A known stale, ambiguous, missing, or undersized pack stops before render-unit and
price guards are charged.

A temporary file read that occurs after reservation follows the normal failed
image pipeline and records that no provider call was made when applicable.

## Shared render intent

The lane entry is `identityPackRenderReferences`
(`apps/web/src/server/images/identity-pack-consume.ts`): it evaluates the pack
under the resolved profile's declared strategy, reads each allowed candidate's
bytes through an owner-scoped ready-only query, and returns generic role-aware
references — `role: "identity"`, mapped by the pure
`identityCandidateReferenceSpecs`
(`packages/image-core/src/render-intent/identity-references.ts`) — together
with the candidate-parallel provenance the lane persists. The planner and
provider adapters see only the final ordered array and field mapping; the
identity-pack role vocabulary never reaches a provider.

No image lane may:

- query `identity_face_crop` images by kind;
- recompute its own persistent face crop;
- substitute another Gallery image when the pack is blocked;
- reorder identity roles after profile resolution;
- omit pack provenance from the render attempt.

During rollout, the old path may remain behind the consumer flag, but there is no
permanent dual authority.

## Provider prompt relationship

The pack role names are semantic application roles. The render-quality compiler
translates resolved order into provider wording, for example:

```text
image 1: canonical identity for Mira
image 2: close facial detail for Mira
image 3: cafe location reference
```

The prompt describes final send order; it does not assume that
`canonical_identity` is always image 1.

When text and image state disagree:

- canonical face and immutable identity remain reference-authoritative;
- authored apparent age, current wardrobe/exposure, and intended morphology
  remain text/state-authoritative;
- the face crop cannot override current hairstyle or body state merely because
  the source portrait is older.

Those rulings belong to the delta-first edit contract. The pack proves which
source supplied identity.

## Profile-aware quality evaluation

The evaluator combines stored pack measurements with profile facts:

- effective provider reference dimensions;
- resize/crop mode when known;
- required minimum effective face dimensions;
- whether heuristic crops are allowed;
- whether an admin override is allowed;
- whether the profile uses canonical, face detail, or both.

The result may:

- allow both candidates;
- allow canonical and omit optional face detail with a warning;
- allow an admin-overridden face detail for a trial;
- reject the whole profile when its required identity role is unusable.

The evaluator does not mutate the pack. The same revision may be eligible for one
profile and ineligible for another.

## Render provenance

Every selected identity reference records:

```ts
export interface IdentityReferenceProvenance {
  characterId: string;
  packId: string;
  packRevision: number;
  packSchemaVersion: number;
  derivationVersion: string;
  policyVersion: string;
  role: IdentityReferenceRole;
  imageId: string;
  sourceImageId: string;
  sourceContentHash: string;
  cropMethod: ImageIdentityCropMethod | null;
  crop: SourcePixelCrop | null;
  warningCodes: ImageIdentityPackWarningCode[];
  adminOverride: boolean;
  effectiveReferenceWidthPx: number | null;
  effectiveReferenceHeightPx: number | null;
  effectiveFaceWidthPx: number | null;
  effectiveFaceHeightPx: number | null;
}
```

This provenance belongs with the resolved render attempt/provider payload, not
only on the character or image row. An old render remains explainable after a pack
is superseded.

The final render record also includes model/profile/version, prompt hashes,
ordered non-identity references, resolved controls, seed, latency, cost, crop
bounds, moderation, and output-QA findings as defined by sibling plans.

## Rollout flag

Pack persistence and preparation ship before provider behavior changes.

Use one consumer flag:

```text
IMAGE_IDENTITY_PACK_REFERENCES
```

Default off. When off:

- packs may be created, backfilled, inspected, and trialed;
- current lanes preserve existing reference behavior;
- no provider payload changes because a pack exists.

When on for an eligible profile:

- shared render intent obtains candidates only through the pack service;
- provenance records the selected revision;
- profile capacity and quality gates apply.

Do not create a permanent “legacy references” preference. After trial and
rollout, remove lane-local recropping and the compatibility fallback.

## Output QA relationship

Identity packs supply reference truth and measurements. They do not own generated
output similarity scoring.

A later output-QA service may compare a generated face against the selected pack
and add an advisory finding. It may not:

- change the current pack;
- silently choose another model;
- promote a face crop based only on one generated output;
- persist an embedding under this v1 contract;
- overwrite the original generated image.

The exact pack revision used is the comparison source so QA remains reproducible.

## Face repair relationship

Face repair consumes identity-pack roles like any other explicit render task. The
repair profile may additionally require the rendered scene and a mask.

The pack system does not select the mask, editor, repair strength, or output
promotion policy. It guarantees only that the selected character identity comes
from a current, authorized, traceable reference.

Multi-person repair remains ineligible until repair can bind a selected face
region to one character without changing the others.

## Integration diagnostics

Stable codes include:

```text
images.identity_pack.profile_ineligible
images.identity_pack.required_identity_capacity
images.identity_pack.reference_fetch_failed
images.identity_pack.provenance_missing
images.identity_pack.manual_override
images.identity_pack.legacy_fallback_used
```

A profile-ineligible result is actionable product feedback, not an unhandled
provider error. The UI can suggest a clearer canonical portrait, manual crop, or a
model/profile that supports the required references.

## Slice 5B build record (2026-08-13)

Render-lane consumption is built behind the flag, which stays off. Rulings the
build settled:

- **The strategy lives in the profile's `referencePolicy` jsonb** as
  `identityStrategy`, zod-defaulted to `canonical_only`, so every stored
  profile row parses unchanged and a richer strategy is a data edit after a
  trial verdict, never a migration. Profile rows are discrete columns, so a
  top-level zod field would have been unstorable; the policy jsonb is the one
  home that is both declared-per-profile and editable as data. It sits
  deliberately outside `profileRenderControlsFingerprintJson`, which names its
  hashed fields explicitly — the trial pins the ordered roles a cell actually
  sends, which is the fact the strategy resolves to, so no persisted
  fingerprint can move.
- **The eligible evaluation arm carries candidate-parallel `provenance`.** The
  evaluation is the last moment the projected pack and its candidates coexist;
  a lane that re-read the pack to explain its own send could see a different
  revision.
- **Provenance home: `images.meta.identityReferences`** on the output row —
  the §"Render provenance" objects for exactly the references sent, validated
  through `identityReferenceProvenanceListSchema` at the consume boundary.
  Write-side only; nothing reads it yet. "Exactly the references sent" is
  enforced by the scene shell rather than assumed from the caller's plan: a
  refused render (`failedPrecondition`) persists none — the row fails before
  any send, including the multi-member cast where an earlier member's pack
  answered before a later member's refusal — and the persisted set follows the
  attempt that actually rendered: a capacity trim drops the untraveled
  anchor's entry, and the fallback-rung meta correction rewrites the row to
  that rung's own send set.
- **Per-lane refusal shapes.** Variant: a returned produce failure — the
  `portrait_variant` row is reserved and failed with the reason, no provider
  call. Chat look: null before any row is reserved (this lane's precondition
  shape; the next look change re-fires). Scene: `failedPrecondition` on the
  resolved-scene input — the row is reserved and failed naming the member, and
  the selfie retry is skipped. All three refuse rather than substitute. The
  chat look/place lanes additionally drain their collected diagnostics into
  the process log (`logDiagnostics`): their production caller is a detached
  job with no sink, and the look lane's row-less refusal would otherwise leave
  no record anywhere of why the look never appeared.
- **A minted chat look stays the scene cast's identity reference** (build
  ruling): it carries current wardrobe/state and is itself downstream of the
  avatar, so only the avatar-fallback path consults the pack. A cast member
  with no portrait at all still renders from text — no identity source is not
  a blocked pack.
- **The scene cast sends one pack reference per member** — the first required
  candidate, else the first — because the cast structure carries one anchor
  per member and multi-role-per-person prompt wording belongs to the
  render-quality layer. Two-role strategies are fully expressed in the variant
  and chat-look lanes.
- **No lane-local face recropping existed to remove.** The removal the plan
  anticipated was vacuous — verified across every lane; `sharp` use outside
  the pack service is output aspect-cropping only.
- **Required-first ordering outranks strategy order at capacity**, pinned by a
  package test: under a one-reference cap the required canonical beats an
  optional face crop listed first, per §"Required identities and capacity".

## Render integration tests

Coverage includes:

- canonical and face-detail role emission;
- every profile strategy;
- optional face-detail omission;
- required role refusal;
- ensemble identity-before-optional ordering;
- total reference-capacity failure;
- refusal before provider invocation;
- exact pack provenance in the resolved render attempt;
- admin override warning propagation;
- feature-flag-off behavior preservation;
- final provider order matching numbered prompt wording;
- no direct lane query for hidden crop kinds;
- removal of lane-local recropping after rollout.

The separate [trial spec](image-identity-packs.spec.trial.md) owns corpus,
comparison cells, review procedure, threshold calibration, and promotion verdicts.

## Completion boundary

Integration is complete when:

- every identity-critical profile resolves identity through the pack service;
- no provider receives a stale or known-unusable pack reference;
- all required identities are capacity-checked before provider spend;
- prompt numbering matches final reference order;
- render provenance identifies exact pack revisions and effective measurements;
- the controlled trial has promoted or rejected each proposed face-detail
  strategy;
- the rollout flag and legacy recropping path are removed.

Structured visual state, output face-similarity QA, regional face repair,
multi-angle identity sets, LoRAs/embeddings, and pose/depth/mask controls remain
separate systems.
