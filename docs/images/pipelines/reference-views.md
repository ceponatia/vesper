# Reference views

A character's **reference view set** is the accepted portrait re-rendered from the other sides:
four angles in two wardrobe states, built once, reviewed by the owner, and reused by every later
render that needs a body rather than a face. It is a sibling derivation of the accepted portrait,
beside the identity pack — [identity-packs.md](../identity-packs.md) owns the face crop; this page
owns the views.

## Owns / does not own

Owns the view vocabulary, the build lane, the review lifecycle, and the storage the set lives in.
Does not own: the shared render shell and asset rules ([../asset-registry.md](../asset-registry.md)),
the identity references every view render sends ([../identity-packs.md](../identity-packs.md)), the
compiled prompt program ([../character-prompts.md](../character-prompts.md)), or portrait acceptance
itself, which is the trigger.

## What a view depicts

- A view is the pair `{ angle, wardrobe }`, and the set is the **cross product** of the two
  registries in `contracts/images/reference-views.ts`. Every count in the app — the cost text, the
  studio grid, the quota charge — reads the registry's length; no surface spells a number.
- The four angles are `front_full`, `back_full`, `side_left`, `side_right`. Each carries its own
  `SceneCameraSpec` and a camera id the digest selection fingerprints. All four are `full_figure` at
  `eye_level`: below-waist morphology is exactly what a later render must stop inventing, and a
  waist-up frame would cut it.
- **Side handedness is subject-relative.** `side_left` turns the character's own left side toward
  the camera. The camera vocabulary has no left or right — `profile` says side-on and stops — so the
  instruction fixes it, and it fixes it against the body, because a mark on the character's left
  shoulder is on the character's left in both the sheet and the scene that anchors to it.
- The two wardrobe states are `clothed` (as the portrait is dressed) and `bare` (undressed).
  `bare` carries `intimate: true`, and that flag is the single gate for three things: the age
  refusal, the intimate reveal, and eligibility to be sent to a lane running without intimate
  allowance.
- Instruction phrasing obeys the three rules the camera registry holds itself to — **no limb nouns,
  no gendered pronouns, positive phrasing only** ([../../contracts/README.md](../../contracts/README.md)
  for where registries live; `scene-camera.ts` states each rule's scar). Every phrase is a `{name}`
  template, bound at assembly.
- A view is shot against a **plain, even studio backdrop**. A view anchors a body, not a place: a
  view rendered in the portrait's kitchen would carry that kitchen into every scene it anchors.

## How a view is rendered

The portrait-variant lane's machinery pointed at a fixed camera
([portrait-variants.md](portrait-variants.md) is the reference implementation). Four differences:

- The cut comes from `buildStandaloneSubjectCut` **directly**, under the angle's own camera and
  camera id — not `buildStandaloneLaneCut`, whose intimate consent gate is welded shut for every
  standalone lane.
- `clothed` loads the saved default outfit exactly as the variant lane does. `bare` passes **no
  garments**, so the coverage readout reads fully bare and the adapter's exposure facts state it;
  no prompt text asserts nudity.
- A `bare` view runs on the **anatomy LoRA**, paired the way the `nsfw_test` variant kind pairs it,
  because the scenes that consume these views run on those weights. A pairing that cannot be
  assembled fails that view alone, with the missing leg's own words; the clothed views are
  unaffected.
- The instruction is the angle clause, the wardrobe clause and the backdrop clause, name-bound. The
  compiler supplies the identity lock (adapted to the angle's face visibility), the age anchor and
  the exposure facts; none of them is hand-written.

References are the character's identity pack (`identityPackRenderReferences`), so an ineligible pack
refuses the view rather than substituting another image. The output is a `reference_view` asset
carrying the view, the generation version, the model, the LoRA, the identity provenance, the visual
digest and the program's own meta.

## The age gate

`plannedReferenceViews` drops every intimate view unless the character's `identity.apparent_age`
resolves to a value the image age vocabulary carries — the adult floor, with no exception. It is a
**gate in the plan**, never a prompt instruction: the view is simply not built, and nothing about
the character's age reaches a model. The accept route charges the budget from the same helper the
build job plans from, so the charge and the work can never be two numbers.

## Cost and single flight

- Accepting a portrait queues the set and charges the daily image budget for exactly the planned
  count. Reference views are a hidden kind, so the storage leg is skipped; backpressure and the
  daily provider budget still apply.
- **A refused build still accepts.** The acceptance pointer is committed before the build is
  decided, so a budget denial, a saturated queue or a build already in flight comes back as
  `views: { queued: false, reason }` on a 200 beside the acceptance. The studio says so and offers to
  build them later.
- Re-accepting the portrait that is already accepted writes nothing, queues nothing and charges
  nothing.
- **One build per character at a time**, staleness-bounded like every other job dedupe, so a deploy
  that kills a build cannot wedge that character forever.
- A view render that fails — a moderated `bare` view is the expected instance — fails its own row
  with a classified failure code and the provider's words, and the other views carry on.

## Lifecycle

- **Staleness is read-time comparison, never a background write.** A view is stale when it is not
  the slot's current row, when its source is not the portrait the character has accepted right now,
  when its asset is missing or unreadable, or when its generation version is behind. Because nothing
  is rewritten when the accepted portrait moves, re-accepting the earlier portrait revives exactly
  the views that were rendered from it.
- **Attempts are rows.** A new attempt marks the previous current row `superseded` and inserts its
  own, in one transaction; a partial unique index holds *one current row per (character, angle,
  wardrobe)* at the storage layer.
- Rows are never deleted. A retired row's **asset** is purged by the scheduled sweep seven days
  after it was retired — the same window the identity pack's retired crops use, and never for a
  `current` row, whatever its status. The whole set is deleted with the character.

## Review

- A rendered view arrives `unreviewed` and **is used by nothing** until the owner approves it: a
  rendered back nobody looked at is a guess, and a guess anchoring every later scene is worse than
  no anchor.
- Rejecting is terminal for that row — it keeps its bytes and its history, it is sent nowhere, and
  the way back is a regenerate, which supersedes it with a new attempt.
- An **owner upload** is the second way a slot is ever filled, and it produces the same row with
  `method: uploaded`, already reviewed: an owner who supplies a view has performed the review by
  supplying it. It runs no model, charges no render budget, and re-fits the image to the canonical
  3:4 portrait under the avatar upload's decode guards.
- **Consumable** is one function, `isConsumableReferenceView`, and nothing else recomputes it: the
  slot's current row, `ready` under the current generation version, rendered from the portrait
  accepted right now, with a `ready` asset, reviewed.

## Selection — which view a render sends

A scene render asks the sheet for the view that matches the shot it is about to make. The
question is pure (`selectReferenceView`, `contracts/images/reference-views.ts`) and resolves
two axes independently: the angle from the camera, the wardrobe from the subject's coverage.
Neither vetoes the other.

The **angle** comes from the RESOLVED camera — `SceneRenderPlan.camera`, after the plan has
spent every evidence gate and a surviving staging entry has already overwritten it:

| Resolved shot                                        | Angle           |
| ----------------------------------------------------- | --------------- |
| orientation `away`                                    | `back_full`     |
| orientation `away_glance_back`                        | `back_full`     |
| orientation `profile`                                 | a side, below   |
| orientation `three_quarter`                           | none            |
| `toward_viewer` at `full_figure` or `wide`            | `front_full`    |
| anything else                                         | none            |

"None" is today's behavior, unchanged: the front-facing portrait keeps anchoring the shot.
A three-quarter turn is deliberately none — there are **four angles, not six** (owner ruling),
and neither the front nor a side depicts an oblique turn honestly.

**Which side a profile shot takes is decided from a key, not picked.** `profile` says side-on
and nothing about handedness, so a random choice would flip a character between her left and
her right in two consecutive images of one conversation. The side is the parity of
`fnv1a32(sideKey)` — even is `side_left`, odd is `side_right` — and the caller passes the
character id joined to the chat id, so one character keeps one side for a whole conversation.

The **wardrobe** comes from the subject's own computed coverage — the same `RegionExposure` the
prompt derives its exposure claims from, never a manual flag. `bare` requires the torso AND the
pelvis both reading `bare` and the lane's intimate allowance; everything else is `clothed`.
**Default-shut in both directions**: a partial undress, a sheer region, coverage nobody computed,
and a lane without intimate allowance all take the clothed view. The threshold lives in that one
function.

## Consumption and reference ordering

`loadConsumableReferenceView` (`server/images/reference-view-consume.ts`) is the only way a
render gets a view's bytes. It is owner-scoped, it reads the store's own `consumable` verdict
rather than recomputing it, and it reads the asset through the shared owned-image reader. No
lane queries the `reference_view` kind by hand.

- A view enters the render's reference list as an **optional identity reference** for the member
  it depicts, ordered after the required identity anchors and before the place, then cut to the
  model's reference capacity like everything else.
- **One exception:** on a model with a single reference slot, a view whose angle hides the face
  replaces its member's anchor instead of losing to it (owner ruling). A portrait's face locks
  nothing in a shot taken from behind, and the substitute is derived from that same accepted
  portrait.
- The prompt introduces the extra image in the angle registry's own words — "seen from behind,
  the same person" — because two identity images bound to one subject otherwise say only that
  both show her, and two photographs of one person read as two people
  ([../prompt-programs.md](../prompt-programs.md) §Reference slots).
- **A missing view is never an error.** Nothing built, unreviewed, rejected, stale, unreadable
  bytes, no capacity: every one of them degrades to the front-anchored render with an INFO
  diagnostic. The feature may not turn a missing reference into a missing image.
- **A shot with no matching angle degrades silently.** Nothing was wanted, so nothing is
  reported: a three-quarter turn, a medium front shot and every other unmatched shot are the
  ordinary case, and a line on each would bury the misses that are worth reading. Only a view
  that was WANTED and could not be sent is diagnosed.

Every scene render that sent one records `images.meta.referenceViews` at reserve time, beside
the camera and staging that asked for it: one entry per view carrying `characterId`, `angle`,
`wardrobe`, `imageId`, `sourceImageId` and `substitutedAnchor`. It follows the identity
provenance's honesty rule exactly — a fallback rung that dropped the view records none — and the
lightbox's admin-only panel renders it ([../../ui/conventions.md](../../ui/conventions.md) §Image lightbox).

## Hidden everywhere

`reference_view` is a `HIDDEN_IMAGE_KINDS` member ([../asset-registry.md](../asset-registry.md)): it
is absent from the portrait strip, the Gallery, entity cloning, the file route's public widening and
the storage quota. Its owner reads the bytes through the ordinary owner file route, which is how the
studio's grid displays them.

## Routes

| Route                                                | What it does                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /api/characters/:id/reference-views`            | `{ set, planned }` — every slot, `missing` where no row exists       |
| `POST /api/characters/:id/reference-views/build`     | Builds every `missing` / `failed` / `stale` slot; 409 `not_accepted` |
| `POST …/reference-views/:angle/:wardrobe/regenerate` | Rebuilds one slot, a rejected one included                           |
| `POST …/reference-views/:angle/:wardrobe/upload`     | `{ dataUrl }` ⇒ the settled slot, synchronously                      |
| `POST …/reference-views/:angle/:wardrobe/review`     | `{ verdict: approve \| reject }` ⇒ the settled slot                  |

All five are owner-only and rooted at the character. A slot the registry has no entry for is a 404.

## Diagnostic codes

| Code                                          | Meaning                                                       |
| --------------------------------------------- | ------------------------------------------------------------- |
| `images.reference_views.build_failed`         | One view's render failed; the rest of the build continues     |
| `images.reference_views.not_accepted`         | The build ran against a character with no accepted portrait   |
| `images.reference_views.source_unreadable`    | The accepted portrait's bytes could not be read               |
| `images.reference_views.visual_cut_failed`    | A view's cut would not assemble; the row fails before spend   |
| `images.reference_views.provider_unavailable` | No image provider is configured, so nothing was rendered      |
| `images.reference_views.unknown_view`         | A stored row names an angle or wardrobe the registry dropped  |
| `images.reference_views.budget_refused`       | Admission refused the build; the acceptance still stands      |
| `images.reference_views.view_unavailable`     | A wanted view could not be sent; the render goes on unchanged |
| `images.reference_views.dropped_for_capacity` | A consumable view did not fit the model's reference capacity  |
