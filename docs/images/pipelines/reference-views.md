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
itself, which makes the explicit build action available.

## What a view depicts

- A view is the pair `{ angle, wardrobe }`, and the set is the **cross product** of the two
  registries in `contracts/images/reference-views.ts`. Every count in the app — the cost text, the
  studio grid, the quota charge — reads the registry's length; no surface spells a number.
- The four angles are `front_full`, `back_full`, `side_left`, `side_right`. Each carries its own
  `SceneCameraSpec` and a camera id the digest selection fingerprints. All four are `full_figure` at
  `eye_level`: below-waist morphology is exactly what a later render must stop inventing, and a
  waist-up frame would cut it. Every angle clause ends with the **same shared full-length clause**,
  which names the body's two ends as places — the top of the head, the floor underfoot — because the
  camera's framing line alone leaves an edit model free to return the portrait crop it started from.
- **Side handedness is subject-relative.** `side_left` turns the character's own left side toward
  the camera. The camera vocabulary has no left or right — `profile` says side-on and stops — so the
  instruction fixes it, and it fixes it against the body, because a mark on the character's left
  shoulder is on the character's left in both the sheet and the scene that anchors to it.
- **A side instruction states that handedness twice**: subject-relative first, then the
  camera-relative consequence it forces — a subject whose own left side is toward the lens faces the
  frame's left edge, with the own right side turned away from the camera, and `side_right` is that
  geometry mirrored. A model resolves a frame direction more reliably than a possessive one, and
  stating both means either half alone still lands the same picture. The two side entries are
  therefore exact left/right mirrors of each other, each naming its own side before the frame's.
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
the character's age reaches a model. The explicit build route charges the budget from the same
helper the job plans from, so the charge and the work can never be two numbers.

Eligibility is live character truth rather than a creation-time decision. If apparent age later
becomes minor or unresolved, every `bare` slot projects `ineligible` immediately, including an
older approved attempt. The studio keeps its image and review provenance visible but disables
review, restoration, regeneration, and upload for that slot. Reservation, finalization, review,
restoration, and upload installation all re-read the current plan while holding the character row
lock; a render that crossed the gate after reservation settles stale. Consumption holds that same
lock across the plan projection and asset read, so an age edit cannot commit between eligibility
approval and opening the bytes.

## Cost and slot leases

- Accepting a portrait writes the identity pointer only. It starts no reference-view job and spends
  no image budget. Re-accepting the current portrait remains a no-op.
- **Build N reference views** is a separate disclosed action. It charges the daily image budget for
  exactly the slots the request newly claims. Reference views are a hidden kind, so the storage leg
  is skipped; backpressure and the daily provider budget still apply.
- **Each slot has one heartbeat-backed lease.** A request may claim every requested slot that has no
  live lease while another job continues on disjoint slots. An overlapping slot converges on the
  current attempt and reports `busy`; partial admission reports one result per requested target.
- **A batch is one job, one admission and one charge over its newly claimed targets.** The character,
  the accepted portrait's bytes and the wardrobe are read once; from there every admitted target's
  provider request begins without waiting for another target in the same batch to settle. There is
  no render-count limit inside the job. What a sheet may cost is the daily image budget's question,
  and how many batches may run at all is the per-user job cap's.
- A job records its leased slots in its bounded payload. Reservation binds the new pending attempt
  id to that lease in the same short transaction that replaces the prior current row. Provider work
  runs after the transaction commits, and settlement releases that slot while the job's other slots
  may remain live.
- Lease liveness follows `heartbeat_at`, not job creation time. An expired job is failed, its
  abandoned pending attempts become retryable failures, and a later request may claim those slots.
  A late worker must still own the live lease and the current pending attempt to finalize or fail it;
  otherwise its write is fenced out.
- **Duplicate slots converge to one attempt.** A request naming the same slot twice is normalized
  (`normalizeReferenceViewTargets`) before admission, so it is charged once and rendered once: two
  simultaneous attempts on one slot would supersede each other mid-render, and the second render's
  only product would be a charge.
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
- **A row keeps its `verdict` through supersession.** Retiring a row overwrites its `status` with
  `superseded`, so the status of every attempt but the newest says nothing about what the owner
  decided; the stored verdict is the one review fact that outlives the retirement, and a slot's
  history is read from it.

## Review

- A rendered view arrives `unreviewed` and **is used by nothing** until the owner approves it: a
  rendered back nobody looked at is a guess, and a guess anchoring every later scene is worse than
  no anchor.
- The full-size viewer compares the current reference with the accepted portrait, side by side on
  desktop and through an image toggle on phone. Previous/Next and arrow keys move between slots;
  Approve, Reject and Undo stay in the viewer. Status and slot labels stay visible. Polling does not
  replace the displayed attempt; changed attempts offer Refresh before another verdict.
- Approve and Reject require the displayed attempt id and integer review revision. The server
  serializes reference writes on the character row and checks the current attempt, revision,
  accepted source bytes, generation version and readable asset. A replaced image or newer verdict
  returns a recoverable conflict. Undo clears the last verdict and review stamp only at that same
  revision; it makes the current attempt unreviewed again.
- Rejection optionally records Wrong outfit, Wrong angle, Identity mismatch, Image defect and a
  correction note of at most 1,000 characters. Feedback is stored on that attempt and shown in the
  viewer, current card and history. An unfinished note lives at the reference-panel session boundary,
  keyed to the exact attempt, so Escape, backdrop close, navigation to another view, and a failed
  request keep it for reopening. Keep for later closes the form without deleting it; Discard feedback
  removes it explicitly. A successful rejection clears only the submitted attempt's draft. The note
  is review provenance; it does not change generation instructions.
- An **owner upload** is the second way a slot is ever filled, and it produces the same row with
  `method: uploaded`, already reviewed: an owner who supplies a view has performed the review by
  supplying it. It runs no model, charges no render budget, and re-fits the image to the canonical
  3:4 portrait under the avatar upload's decode guards. An upload is unavailable while that slot has
  a live lease or pending attempt; work on another slot does not block it. After processing the bytes,
  installation rechecks generation activity, the
  accepted source and the current attempt/revision under the character lock before replacing the
  slot. A busy or changed result preserves the existing attempt and asks the owner to retry; only
  the refused upload's unclaimed asset is removed. A build admitted after installation can replace
  the upload through the ordinary attempt lifecycle.
- **Verdict and feedback survive supersession.** A review writes `approved` or `rejected`; an
  upload writes `approved`. Explicit Undo clears the current verdict while retaining feedback for
  correction and retry. A later attempt never overwrites an earlier attempt's review provenance.
- History offers **Use this version** for a retained compatible attempt. Restoration checks
  ownership, slot, current attempt and revision, accepted portrait id and content hash, generation
  version, available bytes, retention expiry and that slot's pending/live generation state. It copies the bytes
  into an independent asset and creates a new unreviewed current candidate. The original attempt
  keeps its verdict and feedback; its cleanup cannot delete the restored candidate's file. A failed
  restoration compensates only its own unused copy. A build admitted after restoration can replace
  the candidate through the ordinary attempt lifecycle.
- History explains unavailable, expired, incompatible and busy versions and offers Refresh. Its
  retention bound is stated alongside the list; attempts without retained ready assets are absent.
- **What a past attempt reads as is one pure function**, `referenceViewHistoryVerdict`: the stored
  verdict where there is one, otherwise a `rejected` status or a `ready` row's review stamp, and
  `unreviewed` for an attempt nobody ruled on. Rows retired before the column existed have no
  recoverable verdict and read as `unreviewed`.
- **Consumable** is one function, `isConsumableReferenceView`, and nothing else recomputes it: the
  slot's current row, `ready` under the current generation version, rendered from the portrait
  accepted right now, with a `ready` asset, reviewed, and still present in the character's current
  age-gated plan.

## Selection — which view a render sends

A scene render asks the sheet for the view that matches the shot it is about to make. The
question is pure (`selectReferenceView`, `contracts/images/reference-views.ts`) and resolves
two axes independently: the angle from the camera, the wardrobe from the subject's coverage.
Neither vetoes the other.

The **angle** comes from the RESOLVED camera — `SceneRenderPlan.camera`, after the plan has
spent every evidence gate and a surviving staging entry has already overwritten it:

| Resolved shot                                         | Angle           |
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
rather than recomputing it, and it holds the character lock across the current plan projection and
the owner-scoped asset read. No lane queries the `reference_view` kind by hand.

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

| Route                                                 | What it does                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/characters/:id/reference-views`             | `{ set, planned }` — every slot; withheld slots are `ineligible`                          |
| `POST /api/characters/:id/reference-views/build`      | Claims every available `missing` / `failed` / `stale` slot; reports each target outcome   |
| `POST /api/characters/:id/reference-views/regenerate` | `{ targets }` — claims available named slots; reports `queued` / `busy` for each target   |
| `POST …/reference-views/:angle/:wardrobe/regenerate`  | The one-target form of the batch route above                                              |
| `POST …/reference-views/:angle/:wardrobe/upload`      | `{ dataUrl }` ⇒ the settled slot, synchronously                                           |
| `POST …/reference-views/:angle/:wardrobe/review`      | `{ attemptId, expectedRevision, verdict, feedback? }` ⇒ settled slot                      |
| `GET …/reference-views/:angle/:wardrobe/history`      | `{ entries, retentionDays, currentAttemptId, currentRevision }`                           |
| `POST …/reference-views/:angle/:wardrobe/restore`     | `{ attemptId, expectedCurrentAttemptId, expectedCurrentRevision }` ⇒ unreviewed candidate |

All routes are owner-only and rooted at the character. A slot the registry has no entry for is a 404.
A plan-withheld regeneration is refused whole before anything is charged. A review, restoration, or
upload that loses eligibility after its initial read returns a recoverable 409 `ineligible`.

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
| `images.reference_views.lease_expired`        | An interrupted slot was reclaimed and is ready to retry       |
| `images.reference_views.view_unavailable`     | A wanted view could not be sent; the render goes on unchanged |
| `images.reference_views.dropped_for_capacity` | A consumable view did not fit the model's reference capacity  |
