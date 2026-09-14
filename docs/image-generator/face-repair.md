# Face repair

A flagged, owner-admin-only action: explicitly repair one character's face in one selected source
image, over the ordinary Image Generator run path ([runs.md](runs.md)). The source image is never
changed — the repair is a new, separate run output linked to it by provenance, so an admin can
compare the two directly.

Repair is never an automatic fallback after another render fails, and never a silent model
substitution: the admin picks the character, the source image, and (optionally) the repair model,
and the whole effective request the run sent is recorded exactly like any other Generator run. The
action produces the comparison pair only; deciding whether a repaired image is ever shown to a
player is a separate concern this action does not touch.

## The flag

`IMAGE_FACE_REPAIR` (`apps/web/src/server/images/face-repair-flag.ts`, `imageFaceRepairEnabled()`)
gates the whole action, in the house style every experimental switch uses: only the literal `"on"`
enables it. Off is the default, and the action is entirely absent — `POST` answers the same hidden
404 `withOwnerAdmin` gives a caller outside its namespace, and the admin Settings page's Face
repair section (`/settings/face-repair`) states the flag is off instead of rendering the form.

## The route

`GET /api/admin/self/face-repair` reports `{ enabled }` regardless of the flag, so the client can
render the explanation. `POST /api/admin/self/face-repair` takes
`{ characterId, sourceImageId, modelId? }` and runs the checks below, in order, all before any
provider spend:

1. The flag is on.
2. `characterId` names a character this admin owns.
3. `sourceImageId` names an image this admin owns, `ready`, and not one of the hidden system kinds
   (`identity_face_crop`, `identity_trial_output`, `lab_control`, `lab_output`, `generator_output`,
   `reference_view`).
4. The multi-person check (below) passes.
5. The identity references resolve (below).
6. The repair method resolves (below).
7. The ordinary render cost guard (`imageRenderRejection`, hidden `generator_output` output kind).

A refusal at any step is a typed JSON error at 400 — `{ code: "face_repair.<code>", message }` —
except the flag-off case, which answers the anonymous hidden 404 instead of naming itself, so a
disabled action is indistinguishable from a route that does not exist:

| Code                               | Meaning                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `face_repair.disabled`             | the flag is off (hidden 404, not a typed 400)                               |
| `face_repair.character_not_found`  | no character matches that id for this admin                                 |
| `face_repair.source_unavailable`   | the source is missing, not owned, not ready, hidden, or another character's |
| `face_repair.multi_person`         | the source depicts, or asserts, more than one person                        |
| `face_repair.identity_unavailable` | the identity-pack render lane refused before any byte was read              |
| `face_repair.model_unavailable`    | no image model profile is offered for a repair                              |
| `face_repair.method_unavailable`   | a masked repair is declared on the model but no mask source exists          |

Once accepted, the route builds an ordinary `imageGeneratorCreateRunRequestSchema` request and
calls `createImageGeneratorRun` + `startJob` exactly as
`POST /api/admin/self/image-generator/runs` does — a repair run is a Generator run in every way
that matters, including settling through the same runner and being visible in the same run list.

## The multi-person check

A multi-person source is refused before any byte is spent.
`apps/web/src/server/images/face-repair.ts`'s `planFaceRepair` checks, in order:

| Source                                                                                                                          | Outcome                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| a `scene`/`chat_place` row whose `image_references` names 2+ distinct characters                                                | refuse `multi_person`, evidence method `reference_cast`                                                  |
| the render's own recorded world-digest asserts more than one subject                                                            | refuse `multi_person`, evidence method `render_contract`                                                 |
| the character's identity pack records `ambiguous_faces` or `detectedFaces > 1`                                                  | refuse `multi_person`, evidence method `pack_quality`                                                    |
| an avatar / portrait variant / chat look / reference view / single-cast scene, or an uploaded avatar, with no contrary evidence | accept, recording the evidence honestly (`none` means no evidence either way, never a claimed detection) |
| the source names a different character outright, and isn't a scene that includes this one                                       | refuse `source_unavailable`                                                                              |

`render_contract` reads `meta.worldState.subjectRefs` (one entry per cast member the render's
world-digest compile step enumerated — the embodied viewer is excluded from that list by
construction) rather than the compiled prompt program's `operation.subject_count` claim id: that id
is pushed onto every render's provenance unconditionally, so its presence alone cannot distinguish
a solo render from an ensemble one, while `subjectRefs` is the actual persisted cast enumeration.

The accepted subject-count evidence rides the run's `purpose.subjectCheck` (below) — `{ method,
subjects }`, where `subjects` is `null` when no evidence existed either way.

## Identity references and the repair profile

The repair profile resolves from `modelId` (default: the task's default `variant` profile) through
`resolveImageProfileForTask("variant", modelId)`, then is paired **in memory** — no new registry
row — with `referencePolicy.identityStrategy` set to `canonical_then_face_detail`
(`pairFaceRepairIdentityProfile`), the same in-memory pairing shape `pairProfileWithNsfwLora` uses
for the intimate-scene LoRA. A model whose registry row caps it at one reference (a
single-reference candidate such as PuLID) degrades explicitly to `canonical_only` instead of asking
for a strategy the model has no slot for.

`identityPackRenderReferences` then resolves the character's canonical portrait (and face crop,
where the strategy sends one) exactly as every other identity-critical lane does
([../images/identity-packs.md](../images/identity-packs.md) §Render-lane consumption) — a blocked
pack refuses `face_repair.identity_unavailable` before any provider spend, with the pack's own
message.

## The repair method

`resolveFaceRepairMethod` reads the resolved model's probed `advancedCapabilities`:
`regional_mask` when a `mask` role is bound to a dedicated provider field, otherwise
`full_frame_identity_edit`. Masked repair has no registered taker — no model declares a mask
input — so the resolver always returns `full_frame_identity_edit` in practice; a model that DOES
declare one refuses `face_repair.method_unavailable` rather than running full-frame silently under
the "regional" label. The chosen method rides the run's `purpose.method`.

## The request

The Generator request sends the source image first, then the identity references, all under the
neutral `reference`/`identity` purposes (provenance only — ordering routes, purpose does not). The
whole positive prompt is a fixed instruction naming the numbered slots, following
[../image-models/models/qwen-image-edit-2511.md](../image-models/models/qwen-image-edit-2511.md)
§Numbered-reference instruction policy's wording for "one person, several images":

> Repair the face in Image 1 to match the person shown in Images 2 through 3; keep the pose,
> clothing, background, lighting and composition of Image 1 unchanged.

`imageCount` is fixed to 1 and no seed is sent.

## Provenance: `purpose`

Every run this action creates writes an optional `purpose` bag onto the Generator run's own record
(`apps/web/src/contracts/images/image-generator.ts`, `imageGeneratorRunPurposeSchema` — a
discriminated union with headroom for a future non-repair purpose):

```
purpose: {
  kind: "face_repair",
  characterId,
  sourceImageId,
  method,           // "regional_mask" | "full_frame_identity_edit"
  subjectCheck: { method, subjects },
  identityReferences,  // the same IdentityReferenceProvenance list identity-critical
                        // renders persist to meta.identityReferences
}
```

This is on top of, not instead of, everything a Generator run already records about itself
([runs.md](runs.md) §What a run records about itself): the exact model/version, every reference by
slot, the controls, and the final prompt. The output row's own `sourceImageId` column is not
threaded through the settle path for a face repair — the `purpose.sourceImageId` link is what the
comparison arm reads.

## The comparison arms

The action makes three arms runnable against the untouched source, for an owner-run paid trial:

- **Baseline** — the untouched source image; no run.
- **Full-frame identity edit** — `qwen/qwen-image-edit-2511` with the portrait and face crop, the
  only method the resolver returns while no model declares a dedicated mask input.
- **Single-reference** — a model capped at one identity reference (PuLID is a selectable
  candidate; no winner is chosen in advance), which degrades to `canonical_only`.

Grading and a verdict over these arms are owner work this action does not perform.

## The admin UI

`/settings/face-repair` (`components/settings/face-repair-section.tsx`), linked from the Settings
page's Admin section next to Identity trials
([../ui/pages.md](../ui/pages.md)) rather than crowding the Settings page itself: a character
select, the owned-image picker for the source, a model select limited to profiles offered for
`variant`, a Repair button, and this account's repair runs (the Generator run list, filtered
client-side to `purpose.kind === "face_repair"`), each opening the shared image lightbox with the
source as the comparison image. The section states the flag is off, and hides the form, when it is.

## Related

- [README.md](README.md) — the Image Generator bench this action runs over.
- [runs.md](runs.md) — the immutable run record, fan-out, and what a run stores about itself.
- [refusals.md](refusals.md) — the Generator's own pre-spend refusal vocabulary this action's run
  request is still subject to, beside the `face_repair.*` codes above.
- [../images/identity-packs.md](../images/identity-packs.md) §Render-lane consumption: the
  identity-reference resolution this action reuses unmodified.
