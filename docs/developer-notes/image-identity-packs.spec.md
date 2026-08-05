# Image identity packs — technical spec

Plan: [image-identity-packs.plan.md](image-identity-packs.plan.md)

Related machinery:

- [image-model-capabilities.spec.md](image-model-capabilities.spec.md) owns
  provider-neutral render intent, profile eligibility, role-aware reference
  selection, and transport;
- [image-render-quality.spec.md](image-render-quality.spec.md) owns prompt dialects,
  profile quality settings, identity trials, repair, and output QA;
- [docs/images.md](../images.md) owns the existing image row-before-file pipeline,
  normalized WebP storage, resilient reads, and Gallery behavior.

This specification defines the identity-reference asset layer between a
character's canonical portrait and an image-model profile. It is deliberately
independent of any one detector or provider.

## Invariants

The implementation must preserve these invariants:

1. A character has at most one current identity-pack revision.
2. The current revision always names the current canonical source image and the
   exact hash of the stored source bytes it was derived from.
3. A ready face-detail asset is never reused after its source hash changes.
4. Automatic derivation never chooses between several plausible people.
5. A hidden face crop never crosses an owner boundary.
6. A pack may fail without failing or changing the canonical portrait.
7. A known-unusable pack stops an identity-critical render before provider spend.
8. Manual corrections are new revisions, not in-place edits.
9. Every reference sent to a provider can be traced to a pack revision and role.
10. No face-recognition embedding is persisted by v1.

## Proposed module boundaries

Pure contracts belong in:

```text
src/contracts/images/identity-pack.ts
```

Pure crop geometry and measurement helpers belong in:

```text
src/lib/images/identity-pack-crop.ts
src/lib/images/identity-pack-quality.ts
```

They may accept decoded dimensions or pixel arrays, but they do not read files,
use the database, inspect environment variables, or call a detector service.

Server ownership belongs in:

```text
src/server/images/identity-packs.ts
src/server/images/identity-pack-detector.ts
```

`src/server/images/index.ts` is the only server import surface. Existing image
lanes must not import another server module directly.

The detector module is an adapter boundary. Crop selection, pack state, quality
policy, and provider eligibility must remain testable without the detector
runtime.

## Contract vocabulary

V1 uses explicit status and provenance vocabulary:

```ts
export type ImageIdentityPackStatus =
  | "pending"
  | "ready"
  | "unusable"
  | "failed"
  | "stale"
  | "superseded";

export type ImageIdentityCropMethod =
  | "detector"
  | "heuristic"
  | "manual";

export type ImageIdentityPackWarningCode =
  | "heuristic_crop"
  | "mild_blur"
  | "partial_occlusion"
  | "tight_hairline_padding"
  | "tight_jaw_padding"
  | "small_effective_face"
  | "manual_admin_override";

export type ImageIdentityPackFailureCode =
  | "source_missing"
  | "source_not_ready"
  | "source_unreadable"
  | "source_changed"
  | "no_usable_face"
  | "ambiguous_faces"
  | "invalid_crop"
  | "crop_too_small"
  | "crop_write_failed"
  | "derivation_failed";
```

Warnings may accompany a usable pack. Failure codes explain a terminal unusable
or failed revision. Human-readable text is produced at the UI boundary; stored
logic depends on stable codes.

## Pack contract

The parsed application contract is versioned independently of the database row:

```ts
export interface ImageIdentityPackV1 {
  version: 1;
  id: string;
  characterId: string;
  revision: number;
  current: boolean;
  status: ImageIdentityPackStatus;

  source: {
    imageId: string | null;
    contentHash: string;
    width: number;
    height: number;
  };

  derivation: {
    schemaVersion: 1;
    derivationVersion: string;
    policyVersion: string;
    method: ImageIdentityCropMethod | null;
    detectorVersion: string | null;
    confidence: number | null;
    createdAt: string;
  };

  faceDetail: {
    imageId: string | null;
    crop: SourcePixelCrop | null;
    outputWidth: number | null;
    outputHeight: number | null;
  };

  quality: ImageIdentityPackQuality | null;
  warningCodes: ImageIdentityPackWarningCode[];
  failureCode: ImageIdentityPackFailureCode | null;

  review: {
    actorUserId: string | null;
    reason: string | null;
    reviewedAt: string | null;
  };
}

export interface SourcePixelCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ImageIdentityPackQuality {
  algorithmVersion: string;
  detectedFaces: number | null;
  faceBox: SourcePixelCrop | null;
  faceWidthPx: number | null;
  faceHeightPx: number | null;
  faceAreaRatio: number | null;
  blurScore: number | null;
  occlusionScore: number | null;
  padding: {
    topPx: number | null;
    rightPx: number | null;
    bottomPx: number | null;
    leftPx: number | null;
  };
}
```

All JSON read paths use `parseOr`. A malformed crop or quality object degrades to
an unusable contract and emits a diagnostic; it never throws into a render route.

## Persistence model

Add a dedicated `image_identity_packs` table. Do not store the whole pack only in
`images.meta`; current selection, concurrency, revision history, and lifecycle
need relational ownership.

The table contains:

```text
id
character_id
revision
current
status
source_image_id
source_content_hash
source_width
source_height
schema_version
derivation_version
policy_version
method
detector_version
confidence
face_crop_image_id
crop_json
quality_json
warning_codes_json
failure_code
failure_message
reviewed_by_user_id
review_reason
reviewed_at
created_at
updated_at
```

Relational rules:

- `character_id` references `characters.id` with cascade delete;
- `source_image_id` references `images.id` with set-null as a safety net;
- `face_crop_image_id` references `images.id` with set-null;
- a partial unique index permits only one row with `current = true` per
  character;
- `(character_id, revision)` is unique;
- the implementation records a derivation key consisting of character id, source
  hash, schema version, derivation version, and revision attempt so concurrent
  requests can coalesce without making terminal failures impossible to retry.

The migration receives the next available number when implementation begins. The
plan does not reserve a migration number while the registry/capabilities work is
still active.

### Why revisions are rows

A detector result, heuristic crop, manual correction, and retry are distinct
claims. Keeping them as rows gives Vesper:

- an auditable correction history;
- deterministic supersession;
- diagnostics for failed attempts;
- rollback to inspect an older crop without making it current;
- cleanup rules that can distinguish current from obsolete assets.

The current row may be `ready`, `unusable`, `failed`, or `pending`. “Current” means
“the authoritative pack state for the canonical source,” not “successful.”

## Hidden image asset

Add an internal image kind for the derived crop, named consistently with the
existing image-kind vocabulary, such as:

```text
identity_face_crop
```

The crop uses the existing `createImageAsset` and `saveImageBuffer` sequence:

```ts
createImageAsset({
  ownerId,
  kind: "identity_face_crop",
  entityKind: "character",
  entityId: characterId,
  sourceImageId,
  meta: {
    hidden: true,
    identityPackId,
    identityRole: "face_detail",
    sourceContentHash,
    crop,
    derivationVersion,
  },
});
```

The kind is excluded from:

- Gallery listings;
- character image pickers;
- public-library copy surfaces;
- social cards;
- normal delete-retention exceptions intended for user-visible images.

The pack row is the authority. `images.meta` is diagnostic provenance and may not
be used to discover the current crop.

## Source identity and hashing

The source is the image row currently named by the character's canonical portrait
pointer. The service verifies all of these before derivation:

- the image belongs to the same owner and character authorization scope;
- the row is `ready`;
- the file bytes are readable;
- decoded dimensions are valid;
- the source has not changed while the pack is being prepared.

`sourceContentHash` is SHA-256 over the stored normalized image bytes. Vesper's
image write path already rasterizes and stores WebP, so the hash refers to the
actual durable input every later crop reads.

A byte-level change invalidates the pack even when the new image looks similar.
That conservatism is intentional: the system must never claim a crop was derived
from bytes it did not read.

Coordinates are source-pixel coordinates in the stored image orientation. API
clients may submit normalized coordinates, but the server resolves and persists
integer source pixels.

## State transitions

Allowed transitions are:

```text
pending -> ready
pending -> unusable
pending -> failed
pending -> stale

ready -> stale
ready -> superseded

unusable -> stale
unusable -> superseded

failed -> stale
failed -> superseded
```

A manual correction creates a new `pending` revision, finalizes it to `ready`, and
marks the previous current revision `superseded` in the same promotion
transaction.

A canonical-source change marks the old current revision `stale` and creates a new
current `pending` revision.

Terminal derivation failures are not reset in place. A retry creates a new
revision so the failed attempt remains diagnosable.

## `ensureIdentityPack`

The server entry point is idempotent and authorization-aware:

```ts
export type EnsureIdentityPackResult =
  | {
      status: "ready";
      pack: ImageIdentityPackV1;
      warnings: ImageIdentityPackWarningCode[];
    }
  | {
      status: "blocked";
      pack: ImageIdentityPackV1 | null;
      code: ImageIdentityPackFailureCode;
      retryable: boolean;
    };

export interface EnsureIdentityPackInput {
  ownerId: string;
  characterId: string;
  purpose: "background" | "identity_render" | "admin_trial";
  sink?: DiagnosticSink;
}
```

Flow:

1. Resolve and authorize the character and current canonical source.
2. Read and hash the source bytes.
3. Return the current ready revision when source hash and derivation version match.
4. Return the current unusable revision when it matches and no retry condition has
   changed.
5. Coalesce with an existing matching `pending` revision.
6. Otherwise create a new current `pending` revision and mark the old current row
   stale or superseded as appropriate.
7. Derive outside the promotion transaction.
8. Finalize only if the character still points at the same source and the pending
   revision is still current.
9. If finalization loses the race, mark the revision stale and hard-delete its
   hidden crop.

Within one process, matching calls use a single-flight promise keyed by character
id and source hash. The database current-row constraint remains the cross-process
authority.

An identity render waits only for the bounded local derivation. It does not call an
image provider while a pack is unresolved. A background caller may return after
reserving work, but the status endpoint must expose `pending` clearly.

## Derivation pipeline

### Detector contract

The detector adapter returns candidates without making product decisions:

```ts
export interface DetectedFaceCandidate {
  box: SourcePixelCrop;
  confidence: number;
  landmarks?: {
    leftEye?: { x: number; y: number };
    rightEye?: { x: number; y: number };
    mouth?: { x: number; y: number };
  };
  occlusionScore?: number;
}

export interface IdentityFaceDetector {
  version: string;
  detect(image: Buffer): Promise<DetectedFaceCandidate[]>;
}
```

The first implementation uses a local detector adapter. It must not upload the
canonical portrait to an unreviewed third-party face-analysis service.

Detector selection remains replaceable. The fixed corpus determines whether the
chosen adapter is good enough; the pack contract does not depend on one library.

### Candidate ruling

- Exactly one candidate above the reviewed confidence floor may produce a
  detector crop.
- More than one plausible candidate produces `ambiguous_faces`.
- Zero accepted candidates may use the heuristic only when the image is the
  current canonical character portrait, has portrait-like dimensions, and no
  metadata contradicts a single-subject portrait.
- Otherwise the result is `no_usable_face` and requires manual correction or a
  clearer source.

The service never chooses the largest face, centre face, or highest-confidence
face from a multi-person result without user action.

### Crop geometry

Detector crop geometry is controlled by a versioned pure policy. It expands the
face candidate to preserve:

- the full hairline;
- both ears when visible;
- the complete jaw and chin;
- limited neck and shoulder context;
- enough edge padding to survive provider resizing.

The expansion creates a square crop, shifts it only through explicit policy
values, clamps it to the source, and records lost requested padding. A crop that
can only be satisfied by clipping load-bearing boundaries becomes unusable rather
than silently accepted.

The initial heuristic is deterministic:

1. choose a square whose side is the source width for a normal portrait image, or
   the smaller source dimension otherwise;
2. centre it horizontally;
3. place it within the upper portion of the portrait using the versioned
   `heuristic_v1` vertical offset;
4. clamp to source bounds;
5. label it `heuristic` and attach the `heuristic_crop` warning.

The exact expansion and vertical-offset constants live in the policy object and
are pinned by golden geometry tests. Tuning them increments the derivation
version.

### Crop encoding

The crop is extracted with `sharp` under the same decode limits used by normal
image storage. It is:

- square;
- downscaled only when its longest side exceeds the reviewed storage ceiling;
- never enlarged merely to look higher resolution;
- encoded through the normal WebP write path;
- stripped of source metadata;
- stored with actual output dimensions.

The initial storage ceiling is policy, not provider behavior. Provider adapters may
resize the crop again for an effective reference input.

## Intrinsic quality measurement

The pack records measurements even when a current policy accepts the crop. This
allows threshold changes to re-evaluate old packs without rerunning every detector.

V1 measures when available:

- detected face count;
- detector face box;
- face width and height in source pixels;
- face area as a fraction of the crop;
- crop dimensions;
- padding between the face box and crop edges;
- blur score with an algorithm/version label;
- occlusion score from the detector when supported;
- detector confidence.

A missing optional metric is `null`, not zero. Zero is a real measurement.

Blur measurement uses a deterministic local algorithm. Its raw score is meaningful
only with its algorithm version; warning thresholds belong to the policy.

`quality.accepted` is not persisted as eternal truth. Read code evaluates stored
measurements against the named policy version and returns current blockers and
warnings.

## Reference policy

The versioned pure policy has two layers:

```ts
export interface IdentityPackIntrinsicPolicy {
  version: string;
  detectorConfidenceFloor: number;
  minimumCropWidthPx: number;
  minimumCropHeightPx: number;
  blurWarningThreshold: number | null;
  blurBlockThreshold: number | null;
  occlusionWarningThreshold: number | null;
  occlusionBlockThreshold: number | null;
  minimumBoundaryPaddingPx: number;
}

export interface IdentityPackProfilePolicy {
  minimumEffectiveFaceWidthPx: number;
  minimumEffectiveFaceHeightPx: number;
  allowHeuristic: boolean;
  allowAdminOverride: boolean;
}
```

Numeric values are established by the fixed trial corpus and checked into a
versioned policy module. They are not database columns or provider-schema facts.

### Effective provider size

A render-profile evaluation receives the model's actual reference resize behavior
when known. It scales the stored face box into the effective provider input and
checks minimum face dimensions there.

When resize behavior is unknown, the profile remains conservative and may warn or
refuse the optional face-detail role. The evaluator does not assume that uploading
a 1024-pixel file means the model sees 1024 pixels.

## Render-time eligibility

The pack service exposes candidate roles but does not choose provider ordering:

```ts
export type IdentityReferenceRole =
  | "canonical_identity"
  | "face_detail";

export interface IdentityReferenceCandidate {
  role: IdentityReferenceRole;
  imageId: string;
  packId: string;
  packRevision: number;
  sourceImageId: string;
  sourceContentHash: string;
  required: boolean;
  warningCodes: ImageIdentityPackWarningCode[];
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

The canonical candidate points at the source image. The face-detail candidate
points at the hidden crop.

The image-model capabilities/profile layer decides whether a task uses:

- canonical only;
- face detail only;
- canonical then face detail;
- face detail then canonical;
- neither, when the selected model/profile does not support references.

A model's reference cap may make a profile ineligible. The pack layer never drops
a required character identity to preserve an optional location, style, or pose
reference.

No lane may query `identity_face_crop` images directly. It asks the pack service
for authorized candidates and passes them into shared render intent.

## Manual crop revisions

The client submits normalized crop coordinates and the current pack id/revision.
The server:

1. re-authorizes the character;
2. verifies the pack is still current and the source hash still matches;
3. resolves normalized coordinates to integer source pixels;
4. validates bounds, minimum size, and square aspect;
5. re-runs intrinsic measurements on the proposed crop;
6. creates a hidden crop image;
7. creates a new `manual` revision;
8. atomically promotes it and supersedes the previous revision.

A stale editor save returns a conflict and reloads the current source; it never
applies old coordinates to new bytes.

Character-owner corrections may not bypass hard geometry or source checks. Admins
may override reviewed blur, occlusion, or effective-size policy for a trial or
support case, but the revision records:

- admin actor id;
- reason;
- `manual_admin_override` warning;
- the original blockers;
- the policy version.

The override does not change the underlying measurements.

## Creation, backfill, and retries

### New canonical portraits

After a canonical portrait is successfully stored and assigned to the character,
Vesper starts best-effort pack preparation. The portrait response is not rolled
back when preparation fails.

### Existing characters

The first identity-critical request calls `ensureIdentityPack`. The local crop and
measurement work happens before provider reservation. An admin batch can prepare a
bounded trial corpus in advance.

### Retry policy

Retryable failures are file-read or local runtime failures. Ambiguous faces,
invalid manual geometry, and a known-small source are not retried until the source,
policy, or user crop changes.

A retry creates a new revision after bounded backoff. It does not spin on every
render request.

## Source change and staleness

A pack is stale when any of these is true:

- the character's canonical image id changed;
- the stored source hash differs;
- the source row or file disappeared;
- the schema version changed in a way that cannot be re-evaluated;
- the derivation version changed and the new algorithm requires a new crop.

A policy-threshold change alone does not make the bytes stale. It re-evaluates the
same measurements under a new policy.

Source assignment code should mark the old current pack stale eagerly. Read-time
verification remains mandatory because files and rows can change outside the
happy path.

## Copy and publish behavior

A copied or published character gets destination-owned image rows under the
existing clone policy. Identity-pack records are not copied by foreign key and
hidden crop rows are not shared.

After the destination canonical image becomes ready:

- create a new destination pack;
- derive a new destination face-crop asset;
- authorize it only through the destination character and owner.

When the destination source hash equals the origin hash, the implementation may
reuse source-pixel crop coordinates as a hint. It still writes a new pack and crop
asset. Origin review actor ids and admin override authority do not automatically
transfer.

## Deletion and cleanup

Character deletion cascades the pack rows. The deletion path hard-deletes all
associated `identity_face_crop` image rows and files.

The canonical source follows the broader image/Gallery retention policy and may
survive character deletion. This exception does not extend to hidden identity
assets.

When a pack is superseded or stale, its hidden crop may remain for a short bounded
diagnostic retention window. The image sweep then removes it when it is not the
face crop of a current ready pack.

A failed crop write follows normal failed-image cleanup. A crop that loses the
finalization race is removed immediately because no pack revision may claim it.

## Authorization and privacy

Every pack read or write begins from an authorized character, not from a bare
image id.

The source and crop endpoints enforce:

- character owner access;
- explicit admin access for inspection/override;
- no public-library access to hidden crops;
- no cross-owner source or crop references;
- no pack details in another user's render diagnostics.

Logs contain ids, methods, status codes, dimensions, and timings. They do not
contain image bytes, face crops, raw prompts, or derived facial descriptions.

V1 does not persist face embeddings, guessed demographic labels, attractiveness,
emotion, identity names, or other biometric classifications.

## Admin and user routes

Proposed route surface:

```text
GET  /api/characters/:characterId/identity-pack
POST /api/characters/:characterId/identity-pack/ensure
POST /api/characters/:characterId/identity-pack/manual-crop
POST /api/characters/:characterId/identity-pack/reset-automatic

POST /api/admin/identity-packs/batch
GET  /api/admin/identity-packs/:packId/history
```

Route names may follow the repository's final nesting convention, but the
operations remain separate. A manual save is not disguised as a generic image
metadata edit.

The bounded batch accepts explicit character ids or a named trial-corpus id,
validates a maximum count, supports dry run, and returns per-character outcomes.
It never performs unbounded synchronous work across every account.

## Diagnostics

Stable diagnostic codes include:

```text
images.identity_pack.source_missing
images.identity_pack.source_changed
images.identity_pack.pending_conflict
images.identity_pack.no_usable_face
images.identity_pack.ambiguous_faces
images.identity_pack.invalid_crop
images.identity_pack.crop_too_small
images.identity_pack.crop_write_failed
images.identity_pack.finalize_race
images.identity_pack.profile_ineligible
images.identity_pack.manual_override
images.identity_pack.cleanup_failed
```

Expected unusable references are warnings, not server exceptions. Authorization
failures keep the normal route semantics and do not reveal whether a hidden pack
exists.

## Render provenance

When a render consumes an identity reference, provenance records:

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
}
```

The provenance belongs with the resolved provider payload, not only on the
character or image row. An old render must remain explainable after a pack is
superseded.

## Rollout flags

Pack persistence and preparation can ship before any provider behavior changes.

Use one consumer flag during rollout:

```text
IMAGE_IDENTITY_PACK_REFERENCES
```

Default off. When off, lanes preserve existing reference behavior while pack
creation, inspection, and trials run inertly. When on for an eligible profile,
shared render intent obtains identity candidates through the pack service.

Do not maintain a permanent second reference path. After the trial and rollout,
remove lane-local face recropping and retire the compatibility fallback.

## Tests

### Pure contract and geometry tests

Cover:

- crop normalization and source-pixel conversion;
- detector expansion, clamping, and lost-padding reporting;
- deterministic heuristic geometry across portrait and unusual ratios;
- multi-face refusal;
- zero-preserving metric parsing;
- threshold and warning evaluation;
- effective provider resize calculations;
- stale-hash decisions;
- status-transition exhaustiveness.

Golden fixtures pin every versioned crop policy. Changing expected boxes requires
a deliberate derivation-version bump.

### Server integration tests

Cover:

- row-before-file crop creation;
- pack creation without mutating the source image;
- canonical portrait success when pack generation fails;
- one current revision per character;
- concurrent `ensure` coalescing;
- source change during derivation;
- finalization-race cleanup;
- lazy backfill;
- manual revision and stale-editor conflict;
- owner/admin authorization;
- cross-owner copy isolation;
- character deletion and hidden-asset cleanup;
- malformed JSON degradation and diagnostics.

### Render integration tests

After shared render intent is live, cover:

- canonical and face-detail role emission;
- profile capacity and ordering;
- refusal before provider invocation;
- exact pack provenance in the resolved render attempt;
- feature-flag-off behavior preservation;
- removal of lane-local recropping.

## Trial contract

The identity-pack trial is distinct from general image-model tuning. It compares
reference strategies while holding prompt, model version, seed behavior, and
quality controls fixed within each cell.

Required cells for each supported identity-critical profile are:

- canonical portrait only;
- canonical portrait plus face detail when capacity permits;
- face detail only when the profile explicitly supports that strategy;
- manual crop versus automatic crop for known difficult sources;
- no-pack historical baseline where reproducible.

The corpus includes:

- several human faces with different framing and skin/hair contrast;
- at least one stylized character;
- at least one non-human but face-like character;
- glasses, partial hair occlusion, and profile/three-quarter examples;
- a deliberately ambiguous multi-person source to prove refusal;
- a low-resolution source to prove the pre-spend quality gate.

Review grades identity likeness, hair and age retention, edit fidelity,
composition drift, failure rate, latency, and owner preference. The report records
pack revision, source hash, crop method, policy version, effective provider face
size, and all provider controls.

A face-detail strategy is promoted only when it materially improves identity and
does not create an unacceptable increase in composition drift or failures. A
sharp crop alone is not a pass.

## Completion boundary

This spec is complete when the pack is a durable, authorized, versioned source of
identity reference candidates and every consumer uses it through shared render
intent.

The following remain separate systems even after completion:

- structured visual state and appearance attention;
- output face-similarity QA;
- regional face repair;
- multi-angle identity sets;
- user-trained LoRAs or embeddings;
- pose, depth, and segmentation controls.
