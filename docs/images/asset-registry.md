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
account as the image** (`isPublicEntityImage(entityKind, entityId, row.ownerId)`), and only for a
kind that may ever be shared: the route subtracts `UNSHAREABLE_IMAGE_KINDS` (the
[hidden kinds](#hidden-kinds) plus the [chat-private kinds](#chat-private-kinds)) through
`isShareableImageKind` before it asks about the entity.

The ownership half of that predicate is what makes it safe. The entity linkage is polymorphic
metadata with no FK, so without it the check reads "some public row has this id", and any path that
ever let a user write those columns would publish their own private asset by naming someone else's
public character. `Cache-Control` follows the same split — `public` for public-entity images,
`private` for owner-only — so a shared cache can never serve one user's asset to another.

Image rows returned **beside a public entity** (the character detail response's portrait strip) are
projected to `{ id, kind, entityKind, entityId, createdAt }` — never `path` (storage layout) or
`prompt` (prompts embed authored and chat text, which is why `deleteChat` scrubs them). The
portrait studio's full rows come from the owner-strict `GET /api/characters/:id/portraits`. A
foreign viewer's strip also omits the chat-private kinds; the owner's lists them.

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

## Chat-private kinds

`scene` (chat scenes and selfies), `chat_look`, `chat_place` and `chat_upload` rows are **chat
content**. Unlike the hidden kinds they are user-visible — their owner sees them in the chat, and
scenes in the Gallery — but `CHAT_PRIVATE_IMAGE_KINDS` keeps them from ever crossing an owner
boundary, even when they are filed under an entity the owner has published:

- the file route's public widening (an owner read gets `Cache-Control: private`);
- a foreign viewer's portrait strip in the character detail response; and
- a cross-account clone (`cloneEntityImages`). An owner duplicating their own character keeps the
  chat images on the copy (only hidden kinds are dropped); they keep their kind there, so they stay
  owner-only even if the copy is published.

A chat scene is filed under the chat's primary character, so without this rule publishing that
character would publish every picture its author's conversations produced. For the same reason no
chat image can become the character's avatar: `promoteVariant` accepts only the authored
`PORTRAIT_IMAGE_KINDS` (avatar, portrait variant), and acceptance only ever accepts the current
avatar, so a chat image can never become the identity source either.

The rule keys on the **kind**, never on `chat_id`, because it must survive chat deletion: a chat
delete nulls `images.chat_id` and the scene stays in the Gallery detached, as private as before. The
kind is durable provenance here: the character-chat scene lane is the only writer of `scene` rows
filed under an entity (including early chat scenes that never carried a `chat_id`), clone copies are
the only other source, and the retired session lane filed its scenes with no entity at all.
`UNSHAREABLE_IMAGE_KINDS` is the union of both lists, and is the one list a cross-owner read or copy
subtracts.

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
(`images/asset-deletion.ts`): select → invalidate derived sources → delete → best-effort unlink, once. The **caller** supplies the
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
file unlinked) and clears the soft entity pointers the way the Gallery's delete does.

**Two rails, both about the unrecoverable case:** at most 200 rows leave per pass, oldest failure
first; and when *most* of the rows in scope are expired failures, nothing is retired and the
disagreement is logged — a volume that did not mount marks every `ready` row failed, and that
reading is an environment fault, not a database full of garbage.

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
