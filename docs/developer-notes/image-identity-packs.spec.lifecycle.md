# Image identity packs — lifecycle and authorization spec

Parent spec: [image-identity-packs.spec.md](image-identity-packs.spec.md)

This document owns creation triggers, lazy backfill, staleness, copy/publish
isolation, deletion, cleanup, authorization, privacy, user/admin routes, and
operational diagnostics.

## Creation after a canonical portrait

After a canonical portrait is successfully stored and assigned to the character,
Vesper starts best-effort pack preparation.

The ordering is:

```text
source image row ready
-> canonical pointer committed
-> identity-pack preparation requested
```

Pack preparation does not participate in the transaction that makes the portrait
canonical. A detector, crop, metric, or file-write failure therefore cannot roll
back a valid portrait.

The source assignment path marks any previous current pack stale before or while
requesting the new derivation. Read-time source/hash verification remains
mandatory because files and rows can change outside the happy path.

## Lazy backfill

Existing characters are not migrated by eagerly processing every image.

The first identity-critical request calls `ensureIdentityPack` before provider
reservation. The pack is derived locally, evaluated, and then supplied to render
intent when ready.

An admin batch may prepare a bounded trial corpus in advance. The batch accepts:

- explicit character ids; or
- a named, checked-in trial-corpus id.

It supports dry run, enforces a maximum count, limits concurrency, and returns a
per-character result. There is no unbounded synchronous “rebuild every character”
action.

## Staleness rules

A pack is stale when any of these is true:

- the character's canonical image id changed;
- the stored source hash differs;
- the source row or file disappeared;
- the schema version changed in a way that cannot be upcast;
- the derivation version changed and the new algorithm requires a new crop.

A policy-threshold change alone does not make the crop bytes stale. It re-evaluates
the same stored measurements under the new policy.

A detector-version change is treated according to the derivation version:

- if only confidence interpretation changed and stored observations remain
  sufficient, policy re-evaluation may be enough;
- if detection, landmark interpretation, or crop geometry changed, increment the
  derivation version and create a new revision.

Manual crop coordinates survive detector upgrades but not source-byte changes.

## Source deletion

Deleting the current source image must first detach or replace the character's
canonical pointer through the existing authorized image flow.

As a safety net, the source foreign key sets null. A pack with a null source id is
immediately unusable and emits `source_missing`; it cannot continue serving a
crop merely because the hidden file still exists.

If a user deletes a non-current source image, only pack revisions derived from
that image are affected. Current-pack selection remains based on the character's
canonical source.

## Copy and publish behavior

A copied or published character gets destination-owned image rows under the
existing clone policy. Identity-pack rows are not copied by foreign key and hidden
crop rows are not shared.

After the destination canonical image becomes ready:

1. create a new destination pack;
2. derive a destination face-crop image asset;
3. authorize both only through the destination character and owner.

When destination source bytes exactly match the origin hash, source-pixel crop
coordinates may be reused as a derivation hint. The destination still gets a new
pack id, revision sequence, image row, file, and policy evaluation.

Origin review actor ids, admin override authority, failure messages, and trial
status do not automatically transfer. A destination pack may record that its crop
geometry was seeded from a same-hash source without claiming the origin pack.

Public-library consumers never receive the source owner's hidden crop URL or pack
metadata. Copy-on-use creates local operational state.

## Character deletion

The pack record is operational character data and is deleted with the character.
The pack table uses cascade delete from `character_id`.

All associated `identity_face_crop` image rows and files are hard-deleted by the
character deletion path or cleanup worker. The broader policy that preserves
Gallery-visible images after character deletion does not apply to hidden identity
assets.

The canonical source image continues to follow the Gallery-retention decision in
[data-lifecycle.plan.md](data-lifecycle.plan.md). The same deletion can therefore
remove the pack/crop while preserving the user-visible source image.

## Superseded and failed revision cleanup

The current revision and its ready face crop are retained.

Superseded, stale, unusable, and failed revisions may remain for a short bounded
diagnostic window. After that window, cleanup removes hidden crop files and image
rows that are not referenced by a current ready pack.

Pack metadata may be retained longer than the hidden bytes when needed for audit,
provided it contains no image content or public URL. The retention period is
configured with the image lifecycle owner rather than embedded in the schema.

A crop that loses finalization compare-and-set has no valid consumer and is
removed immediately.

A failed image row follows normal failed-image cleanup. Cleanup itself is
idempotent: a missing file or already-deleted row is success with a diagnostic at
most, not a fatal task error.

## Image sweep integration

The image sweep recognizes `identity_face_crop` as an internal kind.

It may delete a ready crop only when all of these are true:

- no current ready pack names its image id;
- the diagnostic retention window has elapsed;
- no active derivation is finalizing that pack;
- authorization or filesystem inconsistency does not require operator review.

It flags, rather than silently repairs:

- a current ready pack whose crop row is missing;
- a crop whose `sourceImageId` disagrees with its pack source;
- a crop owned by a different user or character;
- two current pack rows for one character;
- a hidden crop exposed through a public image kind or listing.

## Authorization root

Every pack operation begins from an authorized character, not from a bare pack or
image id.

The server resolves:

```text
requesting user
-> visible/editable character
-> current canonical source
-> current identity pack
-> hidden crop
```

A pack id supplied by a client is a concurrency guard, not authorization.

Character owners may:

- read their current pack summary;
- request preparation;
- open the crop editor;
- save a manual crop;
- reset to automatic derivation.

Admins may additionally:

- inspect revision history;
- see intrinsic/profile evaluation detail;
- perform a recorded policy override;
- run bounded trial-corpus preparation;
- inspect cleanup and derivation diagnostics.

A public library viewer, another owner, or a user who can merely see a published
character may not access the source owner's hidden pack.

## Privacy boundary

V1 stores:

- source and derived image ids;
- crop geometry;
- image dimensions;
- detector method/version/confidence;
- blur, occlusion, face-count, and padding measurements;
- stable warning/failure codes;
- review actor/reason.

V1 does not store:

- face-recognition embeddings;
- guessed real-world identity;
- demographic labels;
- attractiveness scores;
- emotion classifications;
- facial descriptions generated by a model;
- image bytes or URLs in logs.

The local detector adapter must not send source images to an unreviewed third
party. Adding a hosted detector is a separate privacy/provider review, not a
configuration flip.

Logs contain ids, versions, dimensions, statuses, warning codes, and timings.
User-visible diagnostic text is generated from stable codes and does not expose
another user's source or crop.

## User routes

Proposed route operations are:

```text
GET  /api/characters/:characterId/identity-pack
POST /api/characters/:characterId/identity-pack/ensure
POST /api/characters/:characterId/identity-pack/manual-crop
POST /api/characters/:characterId/identity-pack/reset-automatic
```

Route nesting may follow the repository's final convention, but the operations
remain separate. A manual crop is not a generic image metadata edit.

The GET response includes only owner-safe information:

- status;
- source id and dimensions;
- crop image id through an authorized internal image route;
- crop coordinates;
- method;
- warnings and actionable failure code;
- revision and stale/current state.

It does not expose detector internals that are not needed by the editor.

Manual-crop writes include current pack id/revision and source hash. Stale writes
return a conflict response that instructs the client to reload.

## Admin routes

Proposed operations are:

```text
POST /api/admin/identity-packs/batch
GET  /api/admin/identity-packs/:packId/history
POST /api/admin/identity-packs/:packId/override
```

The batch request includes:

- explicit ids or trial-corpus id;
- dry-run flag;
- requested derivation version;
- maximum bounded concurrency;
- whether existing ready packs should be re-evaluated or regenerated.

The response reports counts and per-character stable outcomes. It never returns
raw image bytes in a bulk payload.

An override requires a non-empty reason. It cannot bypass source ownership,
missing bytes, invalid geometry, or stale hash. It may override reviewed quality
thresholds only when the profile policy permits admin override.

## Operational diagnostics

Lifecycle and authorization diagnostics include:

```text
images.identity_pack.source_missing
images.identity_pack.source_changed
images.identity_pack.copy_isolation_failed
images.identity_pack.hidden_asset_exposed
images.identity_pack.owner_mismatch
images.identity_pack.current_conflict
images.identity_pack.cleanup_failed
images.identity_pack.orphan_crop
images.identity_pack.missing_current_crop
images.identity_pack.manual_override
```

Authorization failures use the normal route response and do not reveal whether a
hidden pack exists. Internal details go to the diagnostic sink only after the
requesting user's authority is established.

## Lifecycle tests

Integration coverage includes:

- new canonical portrait success when preparation fails;
- lazy backfill for an existing portrait;
- source id and hash changes;
- current source deletion;
- one current revision per character;
- destination-owned copy/publish packs;
- no cross-owner hidden image access;
- character deletion with canonical Gallery retention and crop hard deletion;
- superseded revision cleanup;
- finalization-race immediate cleanup;
- image-sweep mismatch findings;
- bounded batch validation and dry run;
- stale manual-editor conflict;
- admin override reason/audit;
- malformed row degradation through `parseOr`.
