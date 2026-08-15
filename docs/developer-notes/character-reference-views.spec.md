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

It changes exactly one thing about the identity pack: **what triggers it**. The
crop, the measurements, the revisions, the projection-on-read and the role of
sole face-detail source are all untouched
([docs/images/identity-packs.md](../images/identity-packs.md)). Views are a
**sibling** system that borrows the pack's shape — source-hash keyed,
one-current-per-slot, status codes, a hidden asset kind, projection on read —
without becoming revisions of it. The two derivations have nothing in common
mechanically: one is a deterministic crop, the other is a paid model render.

## Implementation status

- **Slice 1 — acceptance state, trigger move, backfill, studio controls** — not
  started.
- **Slice 2 — view set built on accept, reviewed, replaceable** — not started;
  blocked on slice 1.
- **Slice 3 — render-time selection** — not started; blocked on slice 2.
- **Slice 4 — comparison trial** — not started; blocked on slice 3.

## Owner rulings (2026-08-15)

1. **Four angles.** No three-quarter views; `three_quarter` falls through to the
   existing front anchor rather than being approximated by a neighbour.
2. **Two wardrobe states per angle** — `clothed` (as the accepted portrait is
   dressed) and `bare`. Eight rows per accept.
3. **Acceptance gates every derivation**, the identity pack included, with the
   last-accepted-portrait rule and the backfill below making that safe.

## Contracts

### The view registry

`apps/web/src/contracts/images/reference-views.ts` — pure, the app tier, beside
`scene-camera.ts` and `scene-staging.ts` for the same reason those live there:
the phrasing IS the feature, and the vocabulary is Vesper's scene language rather
than provider-neutral engine knowledge.

```
referenceViewAngleIds = ["front_full", "back_full", "side_left", "side_right"]
referenceViewWardrobes = ["clothed", "bare"]
```

A view is the **pair** — `{ angle, wardrobe }` — and the set is the cross
product, eight rows. Keeping them as two axes rather than eight flat ids is what
lets selection resolve them independently: the camera picks the angle, the
subject's coverage picks the wardrobe, and neither has to know the other's
vocabulary.

Each angle entry carries:

- `id` — the stable key stored on the row and on `images.meta`.
- `instruction` — a `{name}` template, the rotation asked of the edit model. Same
  three rules the camera registry holds itself to: no limb nouns, no gendered
  pronouns, positive phrasing only.
- `faceVisibility` — `full` / `partial` / `hidden`. Drives whether this view may
  substitute for the identity anchor under reference scarcity, and whether the
  view render itself can be identity-locked in the usual words.
- `framing` — `full_figure` for all four; the field exists so a waist-up side
  view is a data edit rather than a schema change.

Each wardrobe entry carries its own prompt fragment and one flag: `intimate`,
true for `bare`. That flag is the single gate deciding whether a view may be
built on a censored profile, whether its render emits intimate anatomy text, and
whether a lane running with `allowIntimate: false` may receive it — the same
shape `intimateSceneAppearance` already uses, so there is one rule and not three.

**Growing the set is a data edit.** If the slice-4 trial argues for
three-quarter angles they join `referenceViewAngleIds` and the selection table
below gains the rows that fall through today. Nothing else changes: the registry
is total over its own ids, and every count — cost text, studio grid, quota
charge — reads the registry's own length rather than a literal.

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
A character whose newest portrait is unaccepted has `isCurrent: false` and a
non-null `acceptedImageId` — the state the studio badge and the pack both read.

## Ownership rules

1. **Acceptance is a claim about an image id, not a flag.** Nothing writes an
   "accepted" boolean anywhere. Changing `characters.avatar_image_id` therefore
   un-accepts by construction, and no invalidation path can be forgotten — the
   same device as `latestChatLook` keeping its cache pointer in the images table.
2. **Only an accept derives anything.** `queueReferenceViews` and
   `queueIdentityPackPreparation` have exactly one caller between them after
   slice 1: the accept route. Avatar generation, variant promotion, upload, and
   library clone must stop calling the pack trigger — which is the whole
   behavioral change of ruling 3, and the one thing an integration test has to
   pin per lane.
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

**Everything derived** (ruling 3). One trigger, one source of truth:

| Derived thing      | Trigger                    | Cost          |
| ------------------ | -------------------------- | ------------- |
| Identity face crop | owner accepts the portrait | none (crop)   |
| Reference view set | owner accepts the portrait | eight renders |

### The last-accepted rule, which is what makes that safe

The naive reading of ruling 3 — derive nothing until accept — breaks live chats:
a portrait change would stale the pack, and identity-critical renders would
refuse until someone clicked a button. So the pack's **source pointer moves from
`avatar_image_id` to `accepted_avatar_image_id`**:

- The identity pack is derived from, and hash-verified against, the **accepted**
  portrait.
- An unaccepted newer portrait changes nothing. The existing pack stays current
  and valid, because the image it names is still the accepted one.
- Accepting is what invalidates the old pack and derives the new one — the same
  `ensureIdentityPack` call, the same convergence loop, a different pointer read.
- A character with **no** accepted portrait has no pack, exactly as a character
  with no portrait has none today, and its identity-critical renders refuse with
  the existing actionable code.

The behavior a reader will find surprising, stated plainly: a newly generated
portrait shows on the character card immediately, and conversations keep
rendering the last accepted face until the owner accepts. That is the feature,
not a lag — the studio badge says so in those words.

### Backfill

A one-time pass sets `accepted_avatar_image_id = avatar_image_id` and
`accepted_at = now()` for every character that has an avatar. Without it, ruling
3 retroactively un-accepts the entire library and every existing chat's
identity-critical renders start refusing. It runs in the migration rather than as
a script — there is no correct partial state to leave behind, and a script that
has to be remembered is a script that will not be.

**No view rows are backfilled.** Existing characters are accepted, not
retroactively charged eight renders each; their view sets are built on their next
real accept.

## What a view depicts

Each angle exists in two wardrobe states (ruling 2):

- **`clothed`** — whatever the accepted portrait depicts, rotated. The edit is
  asked to change the camera and nothing else, which is the smallest instruction
  that produces the geometry the plan wants.
- **`bare`** — the same rotation, undressed. This is the state that stops a
  clothed reference arguing with an intimate scene, and it is also the truest
  geometry reference the app can hold: the body line the render currently rebuilds
  from `imageReveal` attributes on every scene becomes a picture instead.

Each view render is assembled from, in order:

1. `PORTRAIT_IDENTITY_LOCK` (`prompts-variant.ts`), unchanged.
2. The `apparentAgeAnchor` sentence, immediately after the lock — the placement
   is load-bearing and already A/B'd (docs/images/pipelines.md §Avatar
   generation).
3. The registry's angle `instruction`, name-bound.
4. The wardrobe fragment: nothing for `clothed` beyond the lock's own
   change-nothing-else force; for `bare`, the undressed instruction plus the
   bare-region phrasing `exposedRegions`/`formatExposure` already produce for a
   fully nude subject, so the wording is the vocabulary the scene lane has
   already tuned rather than a second dialect.
5. `sceneRevealAppearance` — the below-the-portrait body line the chat scene lane
   already uses. A full-figure view is partly invention whatever angle it is at,
   and this is the text that constrains the invention. The SFW half rides both
   wardrobe states; **the intimate half rides `bare` only**, gated by the
   wardrobe entry's `intimate` flag, exactly as `renderResolvedScene` gates it on
   the uncensored rungs.
6. A plain background instruction, so the view reads as a reference sheet rather
   than a scene and carries no setting into the shots it anchors.

Aspect stays `IMAGE_TARGET_ASPECT` (3:4). The model is the character's
variant-task profile via `resolveImageProfileForTask("variant", …)` — a view is
a reference edit, and it must never be asked of a `canGenerate`-only model.

**The age floor applies with no exception.** A bare full-figure render is exactly
the case the image age floor exists for: `apparentAgeAnchor` rides every view,
the `eighteen` band is the youngest wording any of them may state, and a
character in a minor band emits no age text and — since a bare view of one is
not a thing this app produces — **builds no `bare` set at all**. That refusal is
a gate in the build job, not a prompt instruction.

## Algorithms

### Selection

`selectReferenceView(camera, exposure, allowIntimate)` — pure, in the contracts
module. Two axes resolved independently.

**The angle**, from the resolved `SceneCameraSpec` after `resolveScenePlan` has
spent every evidence gate. Staging never enters directly: a surviving staging
entry has already overwritten the camera, so reading the camera reads the staging
too.

| Resolved shot                             | Angle chosen      |
| ----------------------------------------- | ----------------- |
| orientation `away`                        | `back_full`       |
| orientation `away_glance_back`            | `back_full`       |
| orientation `profile`                     | a side, see below |
| orientation `three_quarter`               | none (ruling 1)   |
| `toward_viewer` + `full_figure` or `wide` | `front_full`      |
| anything else                             | none              |

"None" means today's behavior, unchanged and un-degraded.

**Which side for a profile shot** is not a fact the camera carries, and a random
pick would flip a character's profile between two consecutive scenes in one
conversation. Resolve it deterministically: `fnv1a32(characterId + chatId)`
parity, the same device the identity trial uses for blinded left/right
assignment. Same character, same chat ⇒ always the same side.

**The wardrobe**, from the subject's own computed coverage — the same
`exposedRegions` classification the render prompt already derives, never a manual
flag and never the composer's opinion:

- torso **and** pelvis both `bare`, and the route allows intimate content ⇒
  `bare`.
- anything else, or a route running `allowIntimate: false` ⇒ `clothed`.

Default-shut in both directions: a route that may not carry intimate content
never receives a `bare` view whatever the fiction says, and missing coverage
counts as covered, matching `resolveViewerParts`.

**Partial undress is the plan's open question.** Topless-but-clothed-below falls
to `clothed` today because that is the conservative arm, and the slice-4 trial
grades whether a `bare` anchor with the garment list asserted beats it. Whichever
way it lands is a one-line change to the rule above, which is why the threshold
lives here and not spread across the render builders.

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
  (timestamptz, nullable). The **same migration** runs the backfill
  (`UPDATE characters SET accepted_avatar_image_id = avatar_image_id, accepted_at
  = now() WHERE avatar_image_id IS NOT NULL`); shipping the column without it
  un-accepts the library.
- **`images.kind`** gains `reference_view`. The drizzle enum is type-level, so
  this is not a migration by itself. Comment it beside the other hidden kinds.
- **`character_reference_views`** — one row per (character, angle, wardrobe,
  attempt):
  - `id`, `character_id` (FK cascade), `angle_id`, `wardrobe`, `current`
    (boolean).
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
  - Partial unique index: **one `current` row per (character_id, angle_id,
    wardrobe)**, the storage-layer invariant, same device as
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
views it will render — **eight** under ruling 2, or four for a character whose
age band bars a `bare` set — **inside the accept handler before the job is
queued**, via the route-supplied guard the identity trial established
(`dailyBudgetRejection`, `storageQuotaRejection`, `imageRenderRejection`). The
count is read from the registry, never written as a literal.

**A refused accept still accepts.** The acceptance state is set, the identity
pack derives (it costs nothing), and the view job is not queued, with the reason
reported: acceptance is a claim about a portrait, and it stays true whether or
not the views could be paid for. The studio then offers to build the set later.

A per-view regenerate charges one render. A replacement upload charges none and
runs synchronously, like the avatar upload path.

**The open question about making the undressed set optional** (plan) lands here
if it is taken: as a per-accept choice it is a second parameter on the accept
route and a checkbox on a one-click button; as a per-character setting it is a
character-profile field the accept reads. Neither is built until it is ruled.

## Resilience

Every boundary and its degraded default (docs/resilience.md — `parseOr`,
diagnostics over exceptions, degraded defaults over failed turns):

- **Unknown `angle_id` or `wardrobe` read from a row** — `parseOr` against the
  registry, drop the row, `images.reference_views.unknown_view` (warn).
- **Selection finds no usable view** — no reference added,
  `images.reference_views.view_unavailable` (info, with the reason: none built,
  stale, rejected, wardrobe barred by the route, or no rule for this shot).
- **A view render fails** — the row goes `failed` with the classified cause
  (`classifyImageFailure`), the other views continue,
  `images.reference_views.build_failed` (warn). A failed view is regenerable from
  the studio; nothing retries it automatically. A `bare` view refused by
  moderation is the expected instance of this and must not fail the accept.
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
- `POST /api/characters/:id/reference-views/:angleId/:wardrobe/regenerate`
- `POST /api/characters/:id/reference-views/:angleId/:wardrobe/upload`
- `POST /api/characters/:id/reference-views/:angleId/:wardrobe/review` —
  `{ verdict }`.

No route returns image bytes; the studio reads assets through the normal
owner-scoped file route, which serves a hidden row to its owner.

### Provenance

`images.meta.referenceViews` on every scene render that sent one: angle,
wardrobe, image id, source portrait id, and whether it substituted for the
identity anchor. The lightbox's dev-only prompt panel shows it beside the
resolved camera and staging ids, which is what makes slice 4's grading possible
without re-deriving anything.

## Fixtures and tests

- **Pure (`pnpm test`)**: the angle table above, exhaustively over orientation ×
  distance; the wardrobe rule over coverage × `allowIntimate`, including that
  `allowIntimate: false` never yields `bare`; side-parity determinism pinned by
  golden; registry totality (every angle has an instruction, no limb nouns, no
  gendered pronouns — the same assertions `scene-camera.ts` carries); the
  acceptance projection.
- **Integration (`pnpm test:int`)**: accept → eight rows, four for a minor-band
  character; a second accept of the same portrait is a no-op; **generating,
  uploading, or promoting a portrait queues nothing** (one test per lane — this
  is ruling 3's whole behavioral surface); an unaccepted newer portrait leaves
  the pack current and identity renders working; the migration backfill marks an
  existing character accepted; a rejected view is not consumed; a deleted source
  invalidates before the rows go; hidden-kind exclusion from the portrait strip,
  clone, and gallery.
- **Degradation**: every diagnostic above asserted with its fallback, per
  docs/resilience.md.
- **Reference-doc update**: [docs/images/pipelines.md](../images/pipelines.md)
  gains a view-set lane section, and
  [docs/images/identity-packs.md](../images/identity-packs.md) gains **two**
  amendments — the moved trigger and accepted-portrait source pointer (slice 1),
  and the ruling-5 substitution exception (slice 3). That doc currently states
  the trigger as "queued fire-and-forget after avatar generation, variant
  promotion and library clone", which slice 1 makes false.
