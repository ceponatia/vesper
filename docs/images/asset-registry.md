# Asset registry

One registry, one serving route, one lifecycle for every generated or uploaded image.

## Ownership

`images/assets.ts` coordinates generation through `runImagePipeline`.
`asset-storage.ts` owns byte IO, exact-row writes, metadata and image-kind
vocabulary, reusing `paths.ts` for containment. `asset-deletion.ts` owns guarded
purges and pointer cleanup, `asset-chat-files.ts` owns attachment claims and chat
file cascades, and `asset-clone.ts` copies eligible entity assets.

`asset-maintenance.ts` owns orphan reconciliation, failed-row retirement and the
request-driven schedule. The single `asset-lifecycle-hooks.ts` registry supplies
derived-state invalidation and maintenance callbacks. `images/index.ts` installs
them before external callers can delete or sweep; leaves never initialize hooks
or import that public aggregate. Trusted mutation aliases in `images/internal.ts`
point to the storage and chat-file owners; route code uses owner-scoped adapters.

## Rows and files

File path: `data/images/<ownerId>/<imageId>.webp` — always webp, converted on save. The `images`
row carries `kind`, entity linkage, `prompt`, `source_image_id` (edit lineage), `status`
(`pending`/`ready`/`failed`), and `meta` (model, dimensions, timings; render-attempt provenance
under `meta.render`, and — on the character-fact lanes — visual provenance under
`meta.visualState`, both in [pipelines/README.md](pipelines/README.md)).

**Row before file**: insert the row as `pending` → write `<imageId>.pending.webp` → fsync → rename
→ update the row to `ready`. Every file on disk is always explained by a row; a crash leaves a
`pending` or `failed` row, never a mystery file.

## Serving

`GET /api/images/:id/file`, with immutable cache headers, since content never changes for an id.

**The gate is owner-first:** you always get your own images. A cross-owner read is allowed only
when the image's `entity_kind` / `entity_id` name a **public** shareable entity **owned by the same
account as the image** (`isPublicEntityImage(entityKind, entityId, row.ownerId)`).

The ownership half of that predicate is what makes it safe. The entity linkage is polymorphic
metadata with no FK, so without it the check reads "some public row has this id", and any path that
ever let a user write those columns would publish their own private asset by naming someone else's
public character. `Cache-Control` follows the same split — `public` for public-entity images,
`private` for owner-only — so a shared cache can never serve one user's asset to another.

Image rows returned **beside a public entity** (the character detail response's portrait strip) are
projected to `{ id, kind, entityKind, entityId, createdAt }` — never `path` (storage layout) or
`prompt` (prompts embed authored and chat text, which is why `deleteChat` scrubs them). The
portrait studio's full rows come from the owner-strict `GET /api/characters/:id/portraits`.

## Hidden kinds

`identity_face_crop`, `identity_trial_output`, `lab_control`, `lab_output`, `generator_output`,
`reference_view` and `body_reference` rows are **internal operational assets, not user content**.
`HIDDEN_IMAGE_KINDS` keeps them out of:

- the portrait strip and the portrait studio's routes;
- the Gallery;
- entity cloning;
- the file route's public widening; and
- the per-owner storage quota — the stored sum and the admission reservation alike, since
  `imageRenderRejection` skips its storage leg for a declared hidden `outputKind`.

`identity_face_crop` is hard-deleted with its character, one case of the Gallery-listable
survival rule below ([identity-packs.md](identity-packs.md)); the two lab kinds belong to the
[Advanced Image Lab](../image-lab/README.md) and are deleted with their experiment or by an admin's
explicit fixture delete; `generator_output` is either an
[Image Generator](../image-generator/README.md) run's render, hard-deleted with its run, or a
reference/control image the admin uploaded directly to the bench (`meta.source` is
`generator_upload` or `admin_files_import` rather than absent), explicitly deletable through its own
uploads panel and never through a run's own delete path — the two subtypes share the hidden kind but
never the `meta.source` value, which is the entire authorization boundary between them;
`reference_view` is one slot of a character's reference view set
([pipelines/reference-views.md](pipelines/reference-views.md)), hard-deleted with its character by
the same Gallery-listable survival rule, and read by its owner through the ordinary owner file
route, which is how the portrait studio's view grid displays it; `body_reference` is one of a
character's full-body images, an owner-supplied input to the reference-view build and never a
scene's reference ([pipelines/body-reference-images.md](pipelines/body-reference-images.md)),
hard-deleted with its character by the same rule, collected by the reference-view sweep a week
after it is replaced or removed, and read by its owner through the owner file route, which is how
Portrait Studio's body-image area displays it.

## Deletes

Deleting a location or item **hard-deletes** its owned `images` rows and unlinks the files
immediately — best-effort `fs.unlink`, not a queued job (`deleteEntityImages`).

A **character** is the exception, and follows its own rule: **an image survives its character iff
its kind is Gallery-listable** (`GALLERY_IMAGE_KINDS` — scene, portrait_variant, entity). Those
kinds are deliberately never purged by `deleteEntityImages` — they survive the character as
owner-visible Gallery history, with `images.entity_id` left dangling by design. Everything else
hard-deletes with the character, in one call to `deleteNonGalleryCharacterImages`
(`images/asset-deletion.ts`): every `HIDDEN_IMAGE_KINDS` entry, **and the canonical `avatar`**, which is
reachable only through the character's own portrait studio and is therefore not Gallery history —
left uncovered, it would outlive its character with no surface left to view or delete it through,
while still counting against the owner's storage quota. `identity_face_crop`
([identity-packs.md](identity-packs.md)) is one case this same call covers, not a separate path.

**Every** delete path — the owned-image helpers, the chat cascades, the entity reclaim, the look
anchor's keep-latest purge, `deleteNonGalleryCharacterImages` — runs the same `purgeImagesWhere(where)`
(`images/asset-deletion.ts`): select → invalidate derived sources → delete → best-effort unlink, once. The
delete re-evaluates the predicate, and only the rows it actually removed lose their files and are
counted, so a row that stopped matching after the select keeps both. The **caller** supplies the
predicate and therefore owns every guard (owner id, kind, chat/entity), and the helper adds nothing
to it, so a purge can never be wider than the call site asked for. Route handlers are barred from
importing it (ESLint) and use the owner-scoped `deleteOwnedImage(s)` instead.

Reading an asset's bytes is likewise one helper, `readImageBytes(row)` — null when the file is
lost, never a throw, because the sweep below reconciles it.

A **chat** deletion and a **character** deletion both differ from the location/item rule, in the
same direction: a chat deletion nulls `images.chat_id` (`SET NULL`) and keeps the asset, which
survives in the Gallery; a character deletion leaves `images.entity_id` dangling and keeps every
Gallery-listable asset the same way. The Gallery's own list queries join outward to the character
by that id — a LEFT JOIN, not an inner one — so a surviving image still lists once its character is
gone, with no character id or name (the row lists; nothing links): the DTO carries the JOINED
character's id, never the image's own dangling `entity_id`, so a gone character can never surface
as a link with nowhere to go.

## The sweep

An idempotent `image_sweep` job reconciles rows against files in both directions, logging orphans as
warnings. What it reclaims:

- A `ready` row whose file is gone is marked `failed`.
- A `pending` row is marked `failed` only once its render is presumed dead (owner ruling
  2026-10-01). A row reserved by `runImagePipeline` carries a **render lease** and is failed once
  that lease has been silent for **15 minutes** (`JOB_STALE_MS`), however long the render itself
  runs — a Civitai queue wait, every rung of a scene chain. A row with no lease was reserved by a
  direct `createImageAsset` caller (the image lab, the Image Generator settle, identity-pack trial
  and derive, reference-view upload and copy, body-reference upload, uploads), which reserves once
  its bytes are in hand; it is failed once it is **2 hours** old.
- A file with no row, or a crash-leftover `*.pending.webp` temp, is removed once its mtime is
  **10 minutes** old.

**The pending reclaim is decided at write time.** It is one guarded `UPDATE` whose own `WHERE`
re-checks `status = 'pending'` and the lease (or, for an unleased row, its age) — never a row the
sweep read earlier — so a save or a heartbeat that commits first wins, and the sweep counts only the
rows that statement actually failed. Its failure stamp (`error`, `failedAt`) merges into `meta` in
SQL, and a lease value that is not a JSON number reads as no lease rather than failing the
statement.

**The render lease** is `meta.renderLeaseAtMs`, epoch milliseconds. `runImagePipeline` stamps it on
its own row as generation starts, then every 30 seconds (`JOB_HEARTBEAT_INTERVAL_MS`) until the
render settles — saved, failed or thrown. Each beat merges that one key into `meta` in SQL, guarded
by `status = 'pending'`, so it never overwrites what a save or a failure wrote and never touches a
row that already left `pending`. Beats are best-effort and independent: a failed write is
swallowed, a beat stuck on a dead connection never holds back the next one, and a lease that stops
beating — a crashed process, a database that stays unreachable — ages until a sweep reclaims the
row. Only a `pending` row carries a lease; saving and failing remove it.

**A paid output's ids land before its download.** Once a Civitai workflow has succeeded and the lane
has chosen its output, and before the download starts, the lane records the workflow
(`predictionId`), the output (`undeliveredOutputId`) and the model (`modelSlug`) under the render's
`meta.render`. The lane does not know the row: `runImagePipeline` installs a recorder around
`produce` (`withPaidRenderOutputRecorder`, `server/ai`), carried by the render's own async context,
so concurrent renders each reach only their own row and a render outside the pipeline records
nothing. The write merges into `meta.render` in SQL, guarded by `status = 'pending'`, like a lease
beat. It is best-effort: a failed write is logged and the render carries on, and the lane waits for
it at most 5 seconds before downloading anyway. A settle that records the attempt replaces
`meta.render` whole, so on a saved row, or one failed with the attempt's own record, the early ids
are gone. They outlive the render only where nothing replaced them: a produce that threw, or a
process that died mid-download.

**A reclaimed row keeps its render record.** The pending reclaim merges only the failure stamp and
retires the lease, so a render that recorded its paid output's ids and then died becomes a
`failed` row whose `meta.render` still names both ids. That row offers the output for recovery
exactly as a render that failed its download does (`paidOutputOffer`, `paid-output.ts`), whatever
its kind: `failed`, both ids, a Civitai model, and no `recoveryUnavailableAt`. The surface that owns
the row decides what to do with the offer.

**A late landing is a save.** When a render lands on a row that is already `failed` — the sweep
reclaimed it while the render was still running — the image is real, so the save marks the row
`ready` with `meta.error` and `meta.failedAt` removed, pushes an `images.save_late_landing` warn
diagnostic, and the lane's `onReady` hooks run as for any save. A `ready` row never carries `error`,
`failedAt` or a lease.

**It is kicked by image work, not by a timer** (`kickImageSweep`, called at the top of
`runImagePipeline`): fire-and-forget, at most one pass per 6h — an in-process throttle plus a
durable one, since an `image_sweep` job row inside the window means someone already swept, which
survives restarts and covers a second instance. The same tick also reclaims orphaned `jobs` rows
(`reclaimOrphanedJobs`).

It is request-driven rather than a `setInterval` for the same reason the durable time-jobs sweep is
(`engine/sim-time-jobs.ts`): a timer inside a Next server has no owner, no visibility, and silently
doubles under a second instance, while a kick off work the app is already doing needs no
infrastructure and runs precisely when orphans are being created. It is deliberately kicked BEFORE
the generation — a render that dies mid-flight is the row a later sweep must reclaim, so the kick
must not depend on reaching the end.

The render lease's interval is not that kind of timer. It belongs to one render, lives exactly as
long as that render, and is cleared in the pipeline's `finally` and unref'd — the job heartbeat's
shape (`launchInsertedJob` in `server/api/jobs.ts`). It has an owner, never outlives its work, and a
second instance beats only for its own renders.

**Derived-asset passes ride the same tick.** The identity-pack service contributes its consistency
findings and its bounded retired-crop cleanup, and the reference view set contributes its own
retired-asset pass: assets belonging to a **superseded** view older than **7 days** are purged and
their pointers nulled, while a `current` row's asset is never touched whatever its status — a stale
or failed current view is what the studio is showing its owner right now. Both passes are registered
into the sweep rather than imported by it, contain their own failures, and report plain counters into
the `image_sweep` job row's payload.

**Safety rail:** if the images table has NO rows while files exist on disk, the file side is skipped
entirely and logged. That reading means the database and the volume disagree — a fresh or branched
database, a mis-set `DATABASE_URL` — not that every file is an orphan, and wiping the volume on it
would be unrecoverable.

## Retention

The same tick's third pass hard-deletes rows that failed more than **24 hours** ago (a constant,
retunable), so a row goes `pending` → `failed` → gone rather than staying `failed` forever. A failed
row is real feedback for a while — the scene strip, the portrait studio and the entity studio each
paint a "this render failed" tile from one — and garbage afterwards: no file, no bytes, no reader.

The clock is `meta.failedAt`, stamped wherever a failure is recorded — `failImage`, and the sweep's
pending reclaim through the same `failureStamp` — because `created_at` is when the row was
*reserved*: a row that was `ready` for a month before its file vanished fails today, and ageing it
by creation would erase the tile in the same tick it appeared. Rows failed before that stamp
existed fall back to `created_at` and are past the window by definition.

Retirement runs LAST, so a row this pass just marked failed always survives it. It goes through
`purgeImagesWhere` like every other delete path (identity-pack derivations invalidated, any stray
file unlinked) and clears the soft entity pointers the way the Gallery's delete does. The purge is
guarded on `status = 'failed'`, so a row an in-place recovery claims after the pass read it
(§Recovering a paid output in place) survives with its file, and pointers are cleared only for the
rows actually removed.

**Two rails, both about the unrecoverable case:** at most 200 rows leave per pass, oldest failure
first; and when *most* of the rows in scope are expired failures, nothing is retired and the
disagreement is logged — a volume that did not mount marks every `ready` row failed, and that
reading is an environment fault, not a database full of garbage.

## Recovering a paid output in place

A failed `portrait_variant`, `avatar` or `scene` row (selfies included) whose render was billed but
never delivered is recovered onto **its own row**, with no new render
(`recoverImageOutput`, `image-output-recovery.ts`; `POST /api/images/[id]/recover`). Reference
views keep their own recovery, because their attempt rows are what the sheet reads
([pipelines/reference-views.md](pipelines/reference-views.md) §Recovering a paid output); this
service answers `ineligible` for them.

- **The offer** is the shared reading of a failed row (`paidOutputOffer`, `paid-output.ts`):
  `failed`, `meta.render` names the workflow and the output on a Civitai model, and no
  `recoveryUnavailableAt`. The portraits and chat scenes lists project it as each row's
  `recoverable` flag.
- **The claim is the row.** One guarded `failed → pending` transition takes it: its own WHERE
  re-checks the owner, a kind recovered in place, `failed`, the same workflow and output ids, and
  no withdrawal stamp. It stamps a render lease, beaten every 30 seconds while the recovery runs,
  and the run's claim token (`meta.recoveryClaim`). The row keeps its `error` and `failedAt`.
  From there it reads as a live render: the sweep leaves it alone while the lease beats, retention
  never sees a `failed` row, the studio and the chat poll it, and a second recovery answers `busy`.
- **The bytes** come read-only from the stored ids (`recoverPaidOutput`: the decode rule, then
  the output shape the lane's live render would have made — the row's recorded `meta.render.shape`,
  else the lane's own 3:4 request on its task). They are written through the one webp writer at
  the row's own path.
- **Every write that ends the claim is guarded on the token**, on a row that is `pending`, or
  `failed` when the sweep reclaimed it under this run:
  - **recovered:** `→ ready` with its byte count and file facts, the output's shape recorded where
    a render records its own, `recoveredFrom` (`workflowId`, `blobId`), and the failure, lease,
    withdrawal and claim keys retired;
  - **transient failure:** `→ failed` with the lease and the claim retired; the original `error`
    and `failedAt` stand, so retention's clock does not move, and the offer stands;
  - **permanent failure** (the provider shows the output is gone, or its bytes can never be
    decoded): `→ failed` with `recoveryUnavailableAt`; the offer is withdrawn.
- **A recovery whose process dies** leaves a leased `pending` row; the sweep reclaims it after
  `JOB_STALE_MS`, keeping `meta.render`, so the offer stands. **A row its owner deletes
  mid-recovery** answers `not_found`; a file already written is an orphan the sweep removes.
  Retention never deletes a claimed row (§Retention).
- **Nothing else settles** (owner ruling 2026-10-02). No lane's `onReady` runs and no pointer
  moves: a recovered avatar is a ready candidate the owner promotes with the existing action, and
  a recovered scene or selfie is drawn under its anchor message like any ready scene. A recovered
  row carries no render advisories; those are measured only on a live render's output.
- **It is free:** no admission, budget or job cap, and never a new workflow. Diagnostics:
  `images.output_recovery.recovered` (info), `.expired` and `.unavailable` (warn), each with
  `imageId`, `kind` and `workflowId`, always logged.

## Retry and dedupe

Failed generations show a "regenerate" affordance: the same prompt and parameters re-queued.

Chat scene renders are deduped to **one live render per chat** — `queueChatScene` short-circuits
when a `queued` or `running` `chat_scene_image` job already exists for the conversation. The guard
is keyed on chat + type + status, not on turn number or prompt text.

**"Live" is age-bounded, and that bound is load-bearing** (`hasLiveChatJob`,
`server/db/job-liveness.ts` — `JOB_STALE_MS` = 15 min, the same cutoff the per-user concurrency cap
uses). A job row only reaches a terminal status because the process that started it survives to
write one, so a **Fly deploy replacing the machine mid-render leaves it `running` forever**.

Unbounded, that wedges the feature permanently for that conversation: the dedupe keeps seeing a live
job, every later request is refused, and the GET route's `rendering` flag — which reads the same
predicate — never clears, leaving a spinner that can never finish (owner report 2026-08-02, a scene
render killed one second in by a deploy).

The same helper backs every one-live-per-chat enqueue: scene render, scene sketch, summary fold,
meanwhile pass, and the look and place mints. The orphaned row itself is reclaimed by the periodic
sweep (`reclaimOrphanedJobs`) rather than by the dedupe, which only stops being blocked by it.
