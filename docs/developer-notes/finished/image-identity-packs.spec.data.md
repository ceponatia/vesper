# Image identity packs — data and persistence spec

Status: detail for [image-identity-packs.spec.md](image-identity-packs.spec.md)

This document owns the pure contract vocabulary, persistent pack model, hidden
image asset, source identity, parsing behavior, and state machine.

## Invariants

The data model must preserve these invariants:

1. A character has at most one current identity-pack revision.
2. The current revision names the current canonical source image and exact stored
   source hash.
3. A face-detail asset is never reused after its source hash changes.
4. A hidden face crop never crosses an owner boundary.
5. Manual corrections are new revisions, not in-place edits.
6. Every reference sent to a provider can be traced to a pack revision and role.
7. No face-recognition embedding is persisted by v1.

## Module boundaries

Pure contracts belong in:

```text
packages/image-core/src/identity/identity-pack.ts
```

Pure crop geometry and measurement helpers belong in:

```text
packages/image-core/src/identity/identity-pack-crop.ts
packages/image-core/src/identity/identity-pack-quality.ts
```

They may accept decoded dimensions or pixel arrays, but they do not read files,
use the database, inspect environment variables, or call a detector service.

Server ownership belongs in:

```text
src/server/images/identity-pack-*.ts
packages/image-core/src/identity/identity-pack-detector.ts
```

`src/server/images/index.ts` is the only server import surface. Image lanes do not
import another server module directly.

## Status and provenance vocabulary

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
or failed revision. Human-readable copy is produced at the UI boundary; stored
logic depends on stable codes.

## Application contract

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

Optional measurements use `null` when unavailable. Zero remains a valid measured
value and must survive parsing and persistence.

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
- an indexed derivation key covers character id, source hash, schema version,
  derivation version, and revision attempt for coalescing and diagnostics.

Shipped as migration 0101.

### Why revisions are rows

A detector result, heuristic crop, manual correction, and retry are distinct
claims. Separate rows provide:

- auditable correction history;
- deterministic supersession;
- retained failure evidence;
- inspection of an older crop without making it current;
- cleanup rules that distinguish current from obsolete assets.

The current row may be `ready`, `unusable`, `failed`, or `pending`. “Current” means
“the authoritative pack state for the canonical source,” not “successful.”

## Hidden image asset

Add an internal image kind consistent with the existing image-kind vocabulary,
such as:

```text
identity_face_crop
```

The crop uses the normal row-before-file sequence:

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

It then passes through `saveImageBuffer` for normalized WebP storage and resilient
failure handling.

The kind is excluded from:

- Gallery listings;
- character image pickers;
- public-library copy surfaces;
- social cards;
- normal delete-retention exceptions intended for user-visible images;
- the per-owner storage quota. Owner ruling (2026-08-13): hidden image kinds
  are operational bookkeeping the user never sees and cannot delete, so they do
  not consume user-visible storage. `checkStorageQuota` excludes every
  `HIDDEN_IMAGE_KINDS` member — the face crop, `identity_trial_output`, and the
  lab kinds alike. Admission agrees: `imageRenderRejection` skips its
  storage-reservation leg when the route declares a hidden `outputKind`, so an
  account at its visible quota is not refused trial or lab work whose bytes
  would never have counted against it.

The pack row is authoritative. `images.meta` is diagnostic provenance and may not
be used to discover the current crop.

## Source identity and hashing

The source is the image row currently named by the character's canonical portrait
pointer. The service verifies:

- the image belongs to the same authorized character/owner scope;
- the row is `ready`;
- the file bytes are readable;
- decoded dimensions are valid;
- the source has not changed while preparation is in progress.

`sourceContentHash` is SHA-256 over the stored normalized image bytes. Vesper's
image write path already rasterizes and stores WebP, so the hash refers to the
actual durable input every later crop reads.

A byte-level change invalidates the pack even when the new image looks similar.
The system must never claim a crop was derived from bytes it did not read.

Coordinates are integer source-pixel coordinates in the stored image orientation.
Clients may submit normalized coordinates, but the server resolves and persists
source pixels.

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

## Current-revision promotion

Promotion is compare-and-set, not last-write-wins:

1. lock or otherwise serialize the character's current-pack row;
2. verify the character still names the same source image;
3. verify the source hash still matches;
4. verify the pending revision is still current;
5. mark the old current revision non-current and stale/superseded;
6. promote the new revision and its crop in one transaction.

Step 5 has one exception: a current `pending` revision that matches this source
and is younger than the job staleness bound is another process's live reservation
and is left standing, because retiring it would make the promotion above lose ITS
race for no reason. The caller joins that reservation instead (a forced
re-derivation that has already waited out the join window may reclaim it) — see
[image-identity-packs.spec.derivation.md](image-identity-packs.spec.derivation.md)
§"Cross-process coalescing". Because that decision is part of the same locked read
as step 5, it is the only place it can be made correctly.

A derivation that loses this race cannot become current. Its hidden crop is
removed through the cleanup rules in
[image-identity-packs.spec.lifecycle.md](image-identity-packs.spec.lifecycle.md).

## Schema-version behavior

Three versions are distinct:

- `schemaVersion` changes when the serialized pack contract changes;
- `derivationVersion` changes when source normalization, detector interpretation,
  crop geometry, or encoded output changes;
- `policyVersion` changes when the same stored measurements are judged under new
  thresholds.

A policy change re-evaluates existing packs. A derivation change creates a new
revision. A schema change requires an upcaster or a regenerated pack according to
the compatibility decision recorded with that version.
