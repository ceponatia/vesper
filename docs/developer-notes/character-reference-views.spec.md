# Character reference views — technical spec

Status: companion to
[character-reference-views.plan.md](character-reference-views.plan.md)

The implementation contract for coding agents. Product scope, priority, and open
questions live in the plan; this document is how the decisions in it get built.

## Scope

This spec governs two new things and one seam. The new things are **portrait
acceptance** — an explicit owner claim that a specific canonical portrait is
final — and the **view set**, a small fixed family of rendered images of a
character from angles the canonical portrait does not show. The seam is
render-time **view selection**: turning a resolved scene camera into at most one
extra reference.

It deliberately leaves the identity pack alone. Packs keep deriving
automatically from the canonical portrait, keep costing nothing, and keep being
the only source of face-detail references
([docs/images/identity-packs.md](../images/identity-packs.md)). Views are a
**sibling** system that borrows the pack's shape — source-hash keyed,
one-current-per-slot, status codes, a hidden asset kind, projection on read —
without becoming revisions of it. The two derivations have nothing in common
mechanically: one is a deterministic crop, the other is a paid model render.

## Implementation status

- **Slice 1 — acceptance state and studio controls** — not started.
- **Slice 2 — view set built on accept, reviewed, replaceable** — not started;
  blocked on the plan's three open rulings.
- **Slice 3 — render-time selection** — not started; blocked on slice 2.
- **Slice 4 — comparison trial** — not started; blocked on slice 3.

## Contracts

### The view registry

`apps/web/src/contracts/images/reference-views.ts` — pure, the app tier, beside
`scene-camera.ts` and `scene-staging.ts` for the same reason those live there:
the phrasing IS the feature, and the vocabulary is Vesper's scene language rather
than provider-neutral engine knowledge.

```
referenceViewIds = ["front_full", "back_full", "side_left", "side_right"]
```

Each entry carries:

- `id` — the stable key stored on the row and on `images.meta`.
- `instruction` — a `{name}` template, the rotation asked of the edit model. Same
  three rules the camera registry holds itself to: no limb nouns, no gendered
  pronouns, positive phrasing only.
- `faceVisibility` — `full` / `partial` / `hidden`. Drives whether this view may
  substitute for the identity anchor under reference scarcity, and whether the
  view render itself can be identity-locked in the usual words.
- `framing` — `full_figure` for all four in the recommended set; the field exists
  so a waist-up side view is a data edit rather than a schema change.

**Open ruling (plan): the set may become six.** If three-quarter views are added
they are `three_quarter_left` / `three_quarter_right`, and the selection table
below gains the two rows marked as falling through today. Nothing else changes:
the registry is total over its own ids, and the cost text reads the registry's
length rather than a literal four.

### Semantic role

The pack's `IdentityReferenceRole` vocabulary in `@vesper/image-core`
(`canonical_identity` | `face_detail`) is **not** extended. Views carry their own
`ReferenceViewId` and travel to the transport in the existing `identity`
`ImageReferenceRole`, so no profile reference policy, per-role cap, or capability
row changes for this work. What distinguishes a view in the prompt is its own
binding sentence, emitted by the scene prompt builder, not a new transport role.

### Acceptance

`CharacterPortraitAcceptance` in `apps/web/src/contracts/images/` — the projected
answer the API returns, never a stored boolean:

```
{ acceptedImageId: string | null, acceptedAt: string | null, isCurrent: boolean }
```

`isCurrent` is `acceptedImageId !== null && acceptedImageId === avatarImageId`.

## Ownership rules

1. **Acceptance is a claim about an image id, not a flag.** Nothing writes an
   "accepted" boolean anywhere. Changing `characters.avatar_image_id` therefore
   un-accepts by construction, and no invalidation path can be forgotten — the
   same device as `latestChatLook` keeping its cache pointer in the images table.
2. **Only an accept builds views.** `queueReferenceViews` has exactly one caller,
   the accept route. Avatar generation, variant promotion, upload, and library
   clone must not call it — the mirror image of `queueIdentityPackPreparation`,
   which is called from all four and must keep being.
3. **A view is consumable only when it is `current`, `ready`, reviewed, and
   matches the character's currently accepted portrait id.** All four conditions
   are checked in one place, `reference-view-consume.ts`. No lane queries
   `kind: "reference_view"` by hand, recomputes the match, or substitutes a
   gallery image when a view is missing.
4. **A missing view is never an error.** Every failure to produce or select one
   degrades to today's behavior — the front-facing anchor — with an info
   diagnostic. This is the one hard rule the render lane must not break: a plan
   whose whole premise is "more references, better images" cannot be allowed to
   turn a missing reference into a missing image.
5. **Views may substitute for the identity anchor only when the shot hides the
   face.** Stated as a ruling rather than left implicit, because it reads as a
   violation of the identity-pack invariant that the pack is the only identity
   source. It is not: a view is derived from the same accepted canonical portrait
   the pack is derived from, and when `faceVisibility` is `hidden` the anchor's
   face contributes nothing the render can use.
   [docs/images/identity-packs.md](../images/identity-packs.md) gains a sentence
   naming this exception in the same change that lands slice 3.
6. **Hidden everywhere a face crop is hidden.** `reference_view` joins
   `HIDDEN_IMAGE_KINDS` (`server/images/assets.ts`): out of the portrait strip,
   out of `cloneEntityImages`, out of the public-widening branch of the file
   route, refused by `promoteVariant`. It is **not** added to
   `PORTRAIT_STUDIO_KINDS` or `GALLERY_IMAGE_KINDS`; the studio's view panel
   reads its own route, exactly as the identity trial's review UI does.

## What acceptance gates

Acceptance gates **paid** derivation only. The identity face crop keeps deriving
on every canonical portrait, because it costs nothing and because gating it would
refuse identity-critical renders for every character in the existing library
until someone clicked Accept. Two systems, two triggers:

| Derived thing        | Trigger                        | Cost         |
| -------------------- | ------------------------------ | ------------ |
| Identity face crop   | canonical portrait changes     | none (crop)  |
| Reference view set   | owner accepts the portrait     | four renders |

## What a view depicts

The recommended v1 answer, pending the plan's ruling: **whatever the accepted
portrait depicts, rotated.** The edit is asked to change the camera and nothing
else, which is the smallest instruction that produces the geometry the plan
wants, and it keeps the existing scene-prompt clothing machinery — the worn-
garment list plus "depict only the clothing described … add no garment that is
not listed" — as the authority over wardrobe, exactly as it is today with the
front anchor.

Each view render is assembled from, in order:

1. `PORTRAIT_IDENTITY_LOCK` (`prompts-variant.ts`), unchanged.
2. The `apparentAgeAnchor` sentence, immediately after the lock — the placement
   is load-bearing and already A/B'd (docs/images/pipelines.md §Avatar
   generation).
3. The registry's `instruction` for this view, name-bound.
4. The SFW half of `sceneRevealAppearance` — the below-the-portrait body line the
   chat scene lane already uses. A full-figure view is partly invention whatever
   angle it is at, and this is the text that constrains the invention. Its
   intimate half is **not** emitted: v1 views are clothed.
5. A plain background instruction, so the view reads as a reference sheet rather
   than a scene and carries no setting into the shots it anchors.

Aspect stays `IMAGE_TARGET_ASPECT` (3:4). The model is the character's
variant-task profile via `resolveImageProfileForTask("variant", …)` — a view is
a reference edit, and it must never be asked of a `canGenerate`-only model.

## Algorithms

### Selection

`selectReferenceView(camera, staging)` — pure, in the contracts module, driven by
the resolved `SceneCameraSpec` after `resolveScenePlan` has already spent every
evidence gate. Staging never enters directly: a surviving staging entry has
already overwritten the camera, so reading the camera reads the staging too.

| Resolved shot                             | View chosen       |
| ----------------------------------------- | ----------------- |
| orientation `away`                        | `back_full`       |
| orientation `away_glance_back`            | `back_full`       |
| orientation `profile`                     | a side, see below |
| orientation `three_quarter`               | none (v1)         |
| `toward_viewer` + `full_figure` or `wide` | `front_full`      |
| anything else                             | none              |

"None" means today's behavior, unchanged and un-degraded.

**Which side for a profile shot** is not a fact the camera carries, and a random
pick would flip a character's profile between two consecutive scenes in one
conversation. Resolve it deterministically: `fnv1a32(characterId + chatId)`
parity, the same device the identity trial uses for blinded left/right
assignment. Same character, same chat ⇒ always the same side.

### Reference ordering under scarcity

The scene lane already competes for slots: identity anchor(s), then the place,
capped by the model's `maxReferences`. A selected view enters as **optional**,
ordered:

1. required identity anchors (unchanged);
2. the selected view;
3. the place.

One exception, ruling 5 above: when the chosen view's `faceVisibility` is
`hidden` and only one slot exists, the view **replaces** the identity anchor
rather than being dropped. Anywhere else, a view that does not fit is simply not
sent.

### Convergence and dedupe

Reuse the pack's shape without reusing its code path: a keyed single flight
(`reference_views:<characterId>`), a reservation row per view, derivation outside
the transaction, and a compare-and-set finalize on the same accepted portrait id.
A second accept of the same portrait id is a **no-op** that returns the existing
set — this is what makes the cost story true, and it is the one behavior an
integration test must pin.

## Persistence

Next migration number is 0108 (0107 is `curated-model-profiles`). Follow the DB
workflow: edit `schema.ts`, `pnpm db:generate`, review the SQL, `pnpm db:migrate`.
**Do not** fake a TTY past drizzle's create-vs-rename prompt (root `CLAUDE.md`).

- **`characters`** gains `accepted_avatar_image_id` (text, nullable, soft pointer
  with no FK — same treatment as `avatar_image_id`, and for the same reason:
  deleting an image must not cascade into the character row) and `accepted_at`
  (timestamptz, nullable).
- **`images.kind`** gains `reference_view`. The drizzle enum is type-level, so
  this is not a migration by itself. Comment it beside the other hidden kinds.
- **`character_reference_views`** — one row per (character, view, attempt):
  - `id`, `character_id` (FK cascade), `view_id`, `current` (boolean).
  - `source_image_id` (FK set null) + `source_content_hash` — the accepted
    portrait these bytes were rotated from. The hash is what makes a stale set
    detectable even if an id is reused.
  - `image_id` (FK set null) — the rendered view asset; null while pending or
    after a failure.
  - `status` — `pending` / `ready` / `rejected` / `failed` / `stale` /
    `superseded`. `rejected` is the owner's verdict and is terminal for that row.
  - `method` — `rendered` / `uploaded`.
  - `generation_version` — bump when the instruction wording or assembly changes,
    so "the view moved" is always deliberate. Same role as the pack's
    `derivation_version`.
  - `failure_code`, `failure_message`, `reviewed_by_user_id` (no cascade — an
    audit trail that erases itself is not one), `reviewed_at`, timestamps.
  - Partial unique index: **one `current` row per (character_id, view_id)**,
    the storage-layer invariant, same device as
    `image_identity_packs_one_current_per_character`.
- **Jobs**: `jobs.type` gains `reference_views`. Unlike `identity_pack` this one
  **has** a provider lane (it renders through Replicate), so `providerLaneFor`
  returns the image lane and a failure counts against provider health.

### Lifecycle

- **Deletion**: hidden rows die with the character through
  `deleteCharacterIdentityAssets`, which already purges every hidden kind by
  entity. Deleting a view's source image invalidates through the same
  registration-hook ordering the pack uses — the hook fires **before** the rows
  go, or the character keeps a `current`, `ready` view over bytes that are gone.
- **Staleness**: read-time comparison of `source_image_id` against the character's
  currently accepted portrait, not a background write. A stale set is shown as
  stale and not consumed; it is never deleted, so re-accepting the old portrait
  brings it back.
- **Sweep**: the 6-hourly `image_sweep` gains a view pass on the identity pass's
  terms — retired revisions' assets cleaned after the same 7-day diagnostic
  window, the `current` row never touched, orphans collected.

## Cost and quota

An accept charges the daily image budget and storage backpressure for exactly the
views it will render, **inside the accept handler before the job is queued**, via
the route-supplied guard the identity trial established (`dailyBudgetRejection`,
`storageQuotaRejection`, `imageRenderRejection`). A refused accept sets the
acceptance state but queues nothing and reports why: acceptance is a claim about
a portrait, and it stays true whether or not the views could be paid for.

A per-view regenerate charges one render. A replacement upload charges none and
runs synchronously, like the avatar upload path.

## Resilience

Every boundary and its degraded default (docs/resilience.md — `parseOr`,
diagnostics over exceptions, degraded defaults over failed turns):

- **Unknown `view_id` read from a row** — `parseOr` against the registry, drop the
  row, `images.reference_views.unknown_view` (warn).
- **Selection finds no usable view** — no reference added,
  `images.reference_views.view_unavailable` (info, with the reason: none built,
  stale, rejected, or no rule for this shot).
- **A view render fails** — the row goes `failed` with the classified cause
  (`classifyImageFailure`), the other three views continue,
  `images.reference_views.build_failed` (warn). A failed view is regenerable from
  the studio; nothing retries it automatically.
- **Budget or storage refusal at accept** — nothing queued,
  `images.reference_views.budget_refused` (warn), and the studio says the
  acceptance stands but the views were not built.
- **Reference dropped for capacity** — `images.reference_views.dropped_for_capacity`
  (info). Never a refusal: the view is optional by construction (ruling 4).
- The build job is detached and has no diagnostic sink, so it drains its
  collector to the server log the way `renderResolvedScene` and the chat look
  mint do (`logDiagnostics`, scope `images.reference_views`).

**A new code requires copy.** `components/characters/reference-view-copy.ts` is
the single exhaustive code → English map, following
`identity-pack-copy.ts`: adding a code without copy is a compile error, not a raw
identifier on the owner's screen.

## Code organization

- `apps/web/src/contracts/images/reference-views.ts` — the registry, the id
  vocabulary, `selectReferenceView`. Pure.
- `apps/web/src/server/images/reference-view-store.ts` — rows, the current-row
  projection, staleness.
- `apps/web/src/server/images/reference-view-build.ts` — the accept-triggered job,
  the single flight, the per-view render through `renderImageIntent`.
- `apps/web/src/server/images/reference-view-consume.ts` — the lane entry:
  owner-scoped ready-only byte reads plus the provenance the lane persists.
- `apps/web/src/server/images/reference-view-maintenance.ts` — the invalidation
  hook registration and the sweep pass.
- Re-exported from `server/images/index.ts`; components import through
  `@/lib/client/api`, never `server/*`.

### Routes

Owner lane, authorized from the character in the URL:

- `POST /api/characters/:id/portrait/accept` — body carries the image id being
  accepted as a concurrency guard; 409 when it is no longer the canonical
  portrait.
- `DELETE /api/characters/:id/portrait/accept` — clears acceptance; does not
  delete views.
- `GET /api/characters/:id/reference-views` — the set plus its staleness.
- `POST /api/characters/:id/reference-views/:viewId/regenerate`
- `POST /api/characters/:id/reference-views/:viewId/upload`
- `POST /api/characters/:id/reference-views/:viewId/review` — `{ verdict }`.

No route returns image bytes; the studio reads assets through the normal
owner-scoped file route, which serves a hidden row to its owner.

### Provenance

`images.meta.referenceViews` on every scene render that sent one: view id, image
id, source portrait id, and whether it substituted for the identity anchor. The
lightbox's dev-only prompt panel shows it beside the resolved camera and staging
ids, which is what makes slice 4's grading possible without re-deriving anything.

## Fixtures and tests

- **Pure (`pnpm test`)**: the selection table above, exhaustively over
  orientation × distance; side-parity determinism pinned by golden; registry
  totality (every id has an instruction, no limb nouns, no gendered pronouns —
  the same assertions `scene-camera.ts` carries); the acceptance projection.
- **Integration (`pnpm test:int`)**: accept → four rows; a second accept of the
  same portrait is a no-op; changing the avatar un-accepts and marks the set
  stale; a rejected view is not consumed; a deleted source invalidates before the
  rows go; hidden-kind exclusion from the portrait strip, clone, and gallery.
- **Degradation**: every diagnostic above asserted with its fallback, per
  docs/resilience.md.
- **Reference-doc update**: [docs/images/pipelines.md](../images/pipelines.md)
  gains a view-set lane section and
  [docs/images/identity-packs.md](../images/identity-packs.md) gains the ruling-5
  sentence, in the change that lands slice 3.
