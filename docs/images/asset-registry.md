# Asset registry

One registry, one serving route, one lifecycle for every generated or uploaded image.

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

`identity_face_crop`, `identity_trial_output`, `lab_control`, `lab_output`, `generator_output`, and
`reference_view` rows are **internal derived assets, not user content**. `HIDDEN_IMAGE_KINDS` keeps them out of:

- the portrait strip and the portrait studio's routes;
- the Gallery;
- entity cloning;
- the file route's public widening; and
- the per-owner storage quota — the stored sum and the admission reservation alike, since
  `imageRenderRejection` skips its storage leg for a declared hidden `outputKind`.

`identity_face_crop` is hard-deleted with its character, one case of the Gallery-listable
survival rule below ([identity-packs.md](identity-packs.md)); the two lab kinds belong to the
[Advanced Image Lab](../image-lab/README.md) and are deleted with their experiment or by an admin's
explicit fixture delete; `generator_output` is an
[Image Generator](../image-generator/README.md) run's render, hard-deleted with its run;
`reference_view` is one slot of a character's reference view set
([pipelines/reference-views.md](pipelines/reference-views.md)), hard-deleted with its character by
the same Gallery-listable survival rule, and read by its owner through the ordinary owner file
route, which is how the portrait studio's view grid displays it.

## Deletes

Deleting a location or item **hard-deletes** its owned `images` rows and unlinks the files
immediately — best-effort `fs.unlink`, not a queued job (`deleteEntityImages`).

A **character** is the exception, and follows its own rule: **an image survives its character iff
its kind is Gallery-listable** (`GALLERY_IMAGE_KINDS` — scene, portrait_variant, entity). Those
kinds are deliberately never purged by `deleteEntityImages` — they survive the character as
owner-visible Gallery history, with `images.entity_id` left dangling by design. Everything else
hard-deletes with the character, in one call to `deleteNonGalleryCharacterImages`
(`images/assets.ts`): every `HIDDEN_IMAGE_KINDS` entry, **and the canonical `avatar`**, which is
reachable only through the character's own portrait studio and is therefore not Gallery history —
left uncovered, it would outlive its character with no surface left to view or delete it through,
while still counting against the owner's storage quota. `identity_face_crop`
([identity-packs.md](identity-packs.md)) is one case this same call covers, not a separate path.

**Every** delete path — the owned-image helpers, the chat cascades, the entity reclaim, the look
anchor's keep-latest purge, `deleteNonGalleryCharacterImages` — runs the same `purgeImagesWhere(where)`
(`images/assets.ts`): select → delete → best-effort unlink, once. The **caller** supplies the
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
warnings.

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

The clock is `meta.failedAt`, stamped by `failImage` at the choke point every failure passes
through, because `created_at` is when the row was *reserved*: a row that was `ready` for a month
before its file vanished fails today, and ageing it by creation would erase the tile in the same
tick it appeared. Rows failed before that stamp existed fall back to `created_at` and are past the
window by definition.

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
