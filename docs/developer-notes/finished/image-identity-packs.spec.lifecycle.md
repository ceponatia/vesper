# Image identity packs — lifecycle and authorization spec

Status: detail for [image-identity-packs.spec.md](image-identity-packs.spec.md)

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

Preparation is deduplicated to one live `identity_pack` job per character, so a
user clicking through three portraits does not start three derivations. The
invalidation above runs BEFORE that dedupe, always: a trigger that is about to be
suppressed must still have retired the pack for the portrait the character no
longer has.

### Convergence: settle, recheck, derive again (as built 2026-08-06)

Deduplication is only safe because the live job converges on the LATEST canonical
pointer rather than on the one it started with. Without that, the dedupe and the
derivation combine into a hole where each is individually correct:

1. portrait A's job is deriving;
2. portrait B becomes canonical, and B's trigger correctly invalidates A's pack;
3. B's trigger is correctly suppressed by A's live job;
4. A's derivation then loses its finalization compare-and-set — correctly, since
   the character no longer names A — and its crop is discarded;
5. nothing has prepared B, and the job that could have is the one that suppressed
   B's trigger.

So after its `ensureIdentityPack` settles, the job re-reads the character's
canonical pointer and the current pack row, and derives again when the current row
does not cover that pointer: no current revision, or a revision naming a different
source, or a `pending` revision past the staleness bound (which carries no answer
and has nobody producing one).

A pass is only ever repeated because the POINTER MOVED. If the recheck still names
the source the pass just targeted, that pass ran against exactly these inputs and
left nothing covering them — an unreadable or not-yet-ready portrait, most often —
and repeating it is the same call with the same arguments. The job stops there and
the retry policy governs the next attempt on its backoff clock, from the next
trigger. A blocked-but-covering outcome is not this case: a revision that finished
`unusable` for the canonical source DOES cover it, and the job stops having
converged, because "this portrait yields no usable face" is an answer.

The loop is bounded at three passes. Every pass re-reads the pointer as it stands
then, so a burst of portrait changes collapses into one pass against the final
one — converging on the latest source is the goal, and deriving every intermediate
portrait somebody scrolled past is not. Two passes is the ordinary worst case
(derive A, lose the finalize, derive B); the third is slack for one more change
landing inside the second. Past the bound the job stops with `source_changed` and
a log line, and the next trigger or the first identity render's lazy backfill
picks the character up. No unbounded retry loop, and no job per click — a job per
click is exactly what the dedupe exists to refuse.

Two rulings the loop depends on:

- **A live reservation for the canonical pointer stops the loop.** It cannot be
  this job's own — its `ensure` already settled — so another process owns that
  derivation, and a `background` caller declines those promptly by ruling
  (spec.derivation.md §"Cross-process coalescing"). Passing again would collect the
  same refusal on a timer, which is polling another machine's work from a job slot.
  That process's own convergence, or the next trigger, finishes the job.
- **A thrown pass does not recheck.** `ensureIdentityPack` contains its own
  failures and returns `blocked` rather than throwing, so a throw here means a
  database round trip failed — and every read the recheck would make is another
  one of those. The job row is marked `failed`, which is the honest record, and
  the character is covered by the next trigger or a lazy ensure.

The job row is the observability surface, because a detached job has no diagnostic
sink to write to. Its payload records the source image id each pass targeted, the
last pass's outcome (in the shape earlier rows already used), why the job stopped,
and the stable diagnostic code where one adds anything.

The stop reasons are distinct on purpose, since they call for different responses:
converged; another process is deriving the canonical pointer (`pending_conflict`);
one source refused to yield a pack, with that pass's own failure code as the
actionable part; the pass bound was reached while the pointer kept moving
(`source_changed`); or a database call threw, in which case the job row's error
column already says what happened.

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

### Ordering: retire, then delete

Every deletion path invalidates the pack BEFORE the images row goes. Because the
source foreign key sets null, an invalidation sequenced after the delete matches
nothing — a pack is reachable by source id only while that id still exists — and
the character is left with a `current`, `ready` revision whose source is null.

`purgeImagesWhere` owns the ordering for every path built on it (`deleteOwnedImage`,
`deleteOwnedImages`, the entity/chat purges, the pack service's own crop
reclamation). A route that deletes the row itself instead of going through those
helpers — the portrait studio's `DELETE` — repeats the ordering explicitly.
Pointer clearing may follow the delete, since `characters.avatar_image_id` is a
soft pointer with no foreign key of its own; the invalidation may not.

The ordering is deliberately NOT transactional. Invalidation runs through the
maintenance registry, and threading a transaction handle through that seam would
couple the image module to the pack service it exists to hold at arm's length. Three
defences cover the window instead:

- the ordering above, which is what makes the common paths correct;
- the set-null foreign key, so a bypassing delete can never leave a dangling id;
- the shared read seam. `projectIdentityPackPolicy` degrades any `ready` or
  `pending` revision whose source id is null to `unusable` with `source_missing`,
  so no reader — ensure's current-revision reuse, the owner summary, the render
  seam — can surface a sourceless pack as ready however the row reached that
  state. The owner summary additionally reports such a revision as stale: with
  both the revision's source id and the character's canonical pointer null, an id
  comparison alone reads them as agreeing.

The read seam projects; it never repairs. Retiring the row for real is
`cleanupIdentityPackRevisions`' job (below).

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
[data-lifecycle.plan.md](../data-lifecycle.plan.md). The same deletion can therefore
remove the pack/crop while preserving the user-visible source image.

## Superseded and failed revision cleanup

The current revision and its ready face crop are retained.

Superseded, stale, unusable, and failed revisions may remain for a short bounded
diagnostic window. After that window, cleanup removes hidden crop files and image
rows that are not referenced by a current ready pack.

Cleanup also retires any CURRENT revision whose source id is null, in a bounded
pass of its own. Nothing else can reclaim one: the retention pass takes retired
rows only, and the orphan pass takes crops no pack row names, so a sourceless
current revision would shield its hidden crop from both indefinitely. Retirement
is the whole action — the crop then ages out through the ordinary window, and the
pack row survives as audit. The delete paths make this a backstop rather than the
usual route (see §"Source deletion"), and the count is reported separately in the
sweep payload so a non-zero value reads as what it is: something reached the
database without going through them.

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

The shipped route operations are:

```text
GET  /api/characters/:characterId/identity-pack
POST /api/characters/:characterId/identity-pack/ensure
POST /api/characters/:characterId/identity-pack/manual-crop
POST /api/characters/:characterId/identity-pack/reset-automatic
```

The operations stay separate. A manual crop is not a generic image metadata edit.

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

The shipped operations are owner-admin and **self-scoped** — every character is
resolved against the requesting admin's own id, so an admin prepares their own
corpus and nobody else's. Cross-account preparation would be a support boundary,
not a flag on these routes, which is why they sit under `admin/self`:

```text
POST /api/admin/self/identity-packs/batch
GET  /api/admin/self/identity-packs/:packId/history
POST /api/admin/self/identity-packs/:packId/override
```

The slice-6 trial routes live beside them under
`/api/admin/self/identity-packs/trial`; see
[image-identity-packs.spec.trial.md](image-identity-packs.spec.trial.md).

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
- background preparation converging on a portrait promoted mid-derivation: the
  second trigger is suppressed by the live job, the first portrait never becomes
  authoritative, the second is prepared with no manual `ensureIdentityPack` call,
  one current revision survives, the abandoned crop leaves nothing behind once
  cleanup runs, and the character has one job row rather than one per change;
- the same loop refusing to chase a pointer that keeps moving: it stops at the
  pass bound with `source_changed` recorded in the job payload;
- lazy backfill for an existing portrait;
- source id and hash changes;
- current source deletion, through each user-facing delete route (Gallery single,
  Gallery bulk, portrait studio): the character pointer clears, no current ready
  revision survives, the owner summary reports no usable pack, profile evaluation
  refuses, and the hidden crop is reclaimed once the window elapses;
- a sourceless current revision that bypassed those routes: degraded by the read
  seam, retired by cleanup, crop reclaimed after the window;
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
