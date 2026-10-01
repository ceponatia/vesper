# Body reference images

Up to two full-body images an owner gives Portrait Studio so the reference views follow the
character's real body while the face still comes from the accepted portrait. Each image is tagged
**Clothed** or **Unclothed**, every reference view is built with the images its wardrobe takes, and
nothing else reads them — no scene, no portrait variant, no listing.

## Owns / does not own

Owns the body-image vocabulary (`contracts/images/body-references.ts`), its storage
(`character_body_references`), the routing of images to views, the `body` reference role's
binding, and the body-image staleness rule. Does not own: the view build, review and lifecycle
([reference-views.md](reference-views.md)), how a slot is numbered and worded
([../prompt-programs.md](../prompt-programs.md) §Reference slots), reference authority over text
([../character-prompts.md](../character-prompts.md) §Identity on a reference-anchored render), or
the hidden-asset rules ([../asset-registry.md](../asset-registry.md) §Hidden kinds).

## The images

- There are two fixed **slots**, `1` and `2`. One current image per (character, slot) is held by a
  partial unique index and the slot by a check constraint, so a third image cannot be stored; a
  route naming any other slot is a 404.
- Each image carries a **tag**, `clothed` or `unclothed`. A new image in slot 1 starts Clothed and
  one in slot 2 starts Unclothed (owner ruling 2026-10-01); either may hold either tag, the same
  tag twice included, and the tag can change after upload.
- Setting an image is **not an approval step**: a current image is in use, and each view built
  from it is reviewed as any view is.
- Every write — upload into a slot, re-tag, remove — runs under the character row lock the
  reference-view store also takes, and names the image the owner saw (`expectedImageId`, null for
  an empty slot). A write that crossed another is a 409 `changed` and writes nothing.
- Every write waits while a reference-view build is live for the character — a slot leased by a
  heartbeat-live job, or a pending attempt (`referenceViewBuildLive`) — and answers 409 `busy`, as
  the view upload does. A change mid-build would strand that build's renders: the ones not yet
  reserved are already charged and render nothing, and the ones rendering land stale. The studio
  disables the body-image controls while the sheet builds and says why.
- A replaced or removed image's row is **retired** (`current = false`), never rewritten. The
  reference-view sweep purges a retired image's asset after the views' retention window, and the
  image FK cascades its row away with it; a current image is never collected.
- An upload follows the reference-view upload's path: the shared 3:4 crop dialog, the same decode
  guards and cover-fit, row-before-file, and an install that rechecks the slot under the lock and
  removes only its own unclaimed asset when refused. It runs no model and charges nothing.
- The asset is the hidden `body_reference` kind, deleted with its character
  ([../asset-registry.md](../asset-registry.md) §Hidden kinds).

## The adult gate

- An `unclothed` image is sent only when the character passes the gate the undressed views use
  (`imageAgeAllowsIntimate`, [reference-views.md](reference-views.md) §The age gate).
- Uploading or re-tagging an image as Unclothed for a character that fails it is refused with a
  409 `ineligible`. An Unclothed image stored before the character's age moved stays stored and
  is never sent; the studio marks it *not used*.

## Routing

The images a view sends follow its wardrobe (`referenceViewBodyReferences`), after the identity
pack and the view's approved upstream view:

| View wardrobe | Body images sent                |
| ------------- | ------------------------------- |
| `clothed`     | every image, Clothed ones first |
| `bare`        | the Unclothed images only       |

Within a tag, images keep slot order. Each one is an **optional** reference of role `body`, so a
model with too little capacity, a profile whose reference policy does not allow the role, or a
dialect with no wording for it drops it with an info diagnostic and the view renders from the
rest. A view records only the images it actually sent (`meta.referenceView.bodyReferences`, each
`{ slot, imageId, tag }`).

**Whether the current route sends them** is read with the sheet, once per read and outside the
character lock (`referenceViewBodyRoutes`): the `variant` profile a build resolves for dressed
views and the bare route resolved from it for undressed views, each judged by the prompt seam's own
rule (`characterPromptSendsBodyReferences` — a binding whose dialect words the role, and a
reference policy that admits it). The answer travels as `bodyReferences.routes`, `{ clothed, bare }`,
or null when it could not be read. The studio marks an image *not used by the current image
model* when no view it would reach takes body images, says which kind of view does not when only
one does, and words each tag's hint from the same facts. The routes are a fact about the
deployment's image model and play no part in staleness.

## The role binding

- A body image is never an `identity` reference. The portrait owns the face (owner ruling
  2026-10-01), and a dialect's identity lock asks face, skin tone and apparent age to agree across
  every identity slot of a subject — so a body image stays out of that set by construction.
- A dialect declares whether it words the role (`bindsBodyReferences`). The character prompt seam
  drops a body image before planning on one that does not, and reports it as dropped with the
  reason `dialect_unbound`; neither the prompt nor the payload carries it.
- `civitai/qwen-image-2.1`'s dialect binds it: the image supplies the subject's body shape,
  proportions and height only, the face comes only from the identity images, and the clothing and
  backdrop come from the prompt — which is what dresses an Unclothed image on a dressed view.
  Its identity lock names the body images as the build's second source beside the text.
- The `variant-standard` profile on that model allows the role in its reference policy, ranked
  after `identity` and `style`. No model-level capability gates it: the planner consults a model
  only for its reference capacity and its dedicated control inputs.
- A body image never supersedes the text: it plays no part in the reference-authority selection,
  so build and hair attributes stay in the prompt. Portrait Studio shows the character's
  build-aspect attributes beside the upload so the owner can make the two agree.

## Out of date

- A view row records the body-image set it was rendered against (`body_reference_set`): the id and
  tag, in slot order, of the sendable images ROUTED to its wardrobe (`referenceViewBodySetKey`),
  or null for none. The build records it and the sheet compares with that one function, over the
  character's images now — never over the image model, so the key does not move with the profile.
- A **rendered** view is stale once that set differs — an image it takes added, replaced, removed
  or re-tagged, or an Unclothed image the adult gate starts withholding. A dressed view takes every
  image, so any change moves it; an undressed view takes the Unclothed ones alone, so a change to a
  Clothed image leaves it standing. Null is the empty set, so a view's first routed image makes it
  stale and a character that never adds one sees no change. An uploaded view was rendered from
  nothing and is never stale by this rule.
- Nothing is rebuilt and nothing is charged: the owner's next build starts at the root, as
  [reference-views.md](reference-views.md) §Build order describes.
- A build reads the images once per job. Its reservation confirms under the character lock that
  the set has not moved since; otherwise the slot reserves and renders nothing.
- Approving or restoring an attempt rendered against another set is refused as `incompatible`.

## Routes

| Route                                                   | What it does                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/characters/:id/reference-views`               | Also returns `bodyReferences`: images, gate, attributes, routes |
| `POST /api/characters/:id/body-references/:slot/upload` | `{ dataUrl, tag, expectedImageId }` ⇒ `{ bodyReferences }`      |
| `PATCH /api/characters/:id/body-references/:slot`       | `{ tag, expectedImageId }` ⇒ `{ bodyReferences }`               |
| `DELETE /api/characters/:id/body-references/:slot`      | `?imageId=` ⇒ `{ bodyReferences }`                              |

Every route is owner-only and rooted at the character. A write answers 409 `busy` while a build is
live, `changed` when the slot no longer holds the image the owner saw, and `ineligible` for an
Unclothed tag below the adult gate.

## Diagnostic codes

| Code                                            | Meaning                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `images.reference_views.body_reference_dropped` | A body image did not ride a view's render; `context.reason` says why    |
| `images.body_references.unreadable`             | A sendable image's bytes could not be read; the views render without it |
| `images.body_references.unknown_row`            | A stored row names a slot or tag the vocabulary dropped                 |
