# Qwen advanced image subsystem — technical spec

Status: companion to
[qwen-advanced-image-subsystem.plan.md](qwen-advanced-image-subsystem.plan.md)

The implementation contract for coding agents. Product scope, priority, stages,
and open questions live in the plan; this document is how the decisions in it
get built. The lab is called the **Advanced Image Lab**; its code name is
`image-lab` throughout.

## Scope

This spec governs the admin-only Advanced Image Lab: its experiment record, its
control fixtures, its use of the shared Replicate transport, its admin routes
and settings page, and the Stage 0 control-probe protocol. It deliberately
leaves alone: the ordinary render lanes (portrait, variant, scene, item,
location, chat anchors), the profile/intent machinery owned by
[image-model-capabilities.spec.md](image-model-capabilities.spec.md), identity
packs and their gate, and the trial-harness internals owned by
[image-identity-packs.spec.md](image-identity-packs.spec.md). The lab consumes
those systems through their existing exports and adds no second copy.

## Implementation status

| Piece                                           | Status           |
| ----------------------------------------------- | ---------------- |
| Contracts (`image-lab.ts`)                      | built 2026-08-10 |
| `image_lab_experiments` table + image/job kinds | built 2026-08-10 |
| Lab service + shared-transport use              | built 2026-08-10 |
| Preprocessor runner (pose, depth)               | built 2026-08-10 |
| Edge-map computation                            | built 2026-08-10 |
| Admin routes (`/api/admin/self/image-lab`)      | built 2026-08-10 |
| Fixture review + delete route                   | built 2026-08-10 |
| Settings page (`/settings/image-lab`)           | built 2026-08-10 |
| Reference doc (`docs/images/` lab page)         | built 2026-08-10 |
| Stage 0 control probe run + recorded verdict    | run 2026-08-11   |
| Stage 1/2 recipes + controlled runner (intent)  | built 2026-08-11 |
| Controlled-kind create/verdict/comparison UI    | built 2026-08-11 |
| Stage 1/2 trial runs + recorded verdicts        | run 2026-08-11   |
| Stage 3 finishing recipe + runner (intent)      | built 2026-08-11 |
| Finishing create/verdict/comparison UI          | built 2026-08-11 |
| Stage 3 finishing trial runs + verdicts         | run 2026-08-11   |
| Stage 4 lab LoRA wiring (library consumption)   | built 2026-08-11 |
| Stage 4 connector registration + refusal checks | pending          |
| Stage 4 style-LoRA trial runs + verdicts        | pending          |

Stage 5+ work (the character-LoRA pilot, two-character recipes) is deliberately
absent from this table: Stage 5 waits on Stage 4's verdict, and Stage 6 on the
owner opening the two-character gate. The LoRA library itself is the
capabilities plan's slice 6
([image-model-capabilities.spec.md](image-model-capabilities.spec.md)
§"Slice 6 implementation rulings"); this table tracks only the lab's side.

## Rulings this build settles

- **Stage 0 renders bypass the render-intent path.** `renderImageIntent` and
  role-priority selection stay untouched; the Stage 0 lab runner calls
  `runRegistryImageModel` directly with an explicit ordered reference list and a
  pinned `versionId`, and records everything itself. Rationale: capabilities
  slices 3/9 are unbuilt, and half-consuming an unfinished vocabulary from the
  lab would smear the boundary the plan draws. When those slices land, lab
  renders move onto the intent path and this ruling expires. **Expired for
  controlled kinds 2026-08-11:** the slices landed, and `controlled_portrait` /
  `controlled_scene` run through `renderImageIntent` (see the Stage 1/2 rulings
  below). `control_probe` deliberately keeps the direct call — hand-ordered
  inputs and the raw `controlInput` escape hatch are probe tools, not a recipe.
- **Lab outputs are hidden image assets, not gallery items.** New `images.kind`
  values `lab_control` and `lab_output` join `HIDDEN_IMAGE_KINDS`, exactly like
  `identity_trial_output`.
- **Baseline experiments re-run the lane's own configuration, not the lane.**
  A `baseline_portrait` / `baseline_scene` experiment resolves the same profile
  the ordinary lane resolves and renders with identical settings, but saves its
  output as `lab_output` so no player-visible variant or scene appears from lab
  activity.

Rulings the build settled (2026-08-10):

- **Routes fire `startJob`, not the lab service** — `@/server/api` imports
  `@/server/images`, so a service-side `startJob` would close an import cycle.
  Every image lane is arranged this way; a refused job slot deletes the
  experiment row again.
- **Baseline parity is by construction**: baselines call the same
  `resolveImageProfileForTask` + reference ladder + `renderImageIntent` entry
  the lanes call, with `planImageRender` run first purely to capture the
  compiled prompt as `finalPrompt`. `requestedVersionId` stays null on
  baselines because `renderImageIntent` deliberately pins nothing.
- **`failureCode` is a bounded string, not a closed enum**: codes beyond the
  contract's list exist (`image_lab.profile_unavailable`, `image_lab.run_threw`
  — and, until Stage 3 made every kind runnable, `image_lab.kind_unsupported`),
  and provider classifications ride `meta.renderFailure`. A failed extraction *prediction*
  records `render_failed`; `preprocessor_output_invalid` is reserved for bytes
  sharp cannot decode.
- **Fixture review is explicit**: `PATCH /controls/[controlId]` (body
  `imageLabReviewControlRequestSchema`) stamps `reviewedAt` server-side and
  merges onto the raw image meta so the `hidden` flag, encode metadata, and the
  fixture's `originNote` survive; `DELETE /controls/[controlId]` removes a
  fixture, and a citing experiment keeps its recorded settings with
  `controlImageId` nulled by the FK. A row carrying `reviewNote` with no
  `reviewedAt` predates the note split, so that same write adopts the stranded
  string as `originNote` — an existing `originNote` always wins — rather than
  discarding it.
- **Client lists drop bad elements, not whole lists**: the UI parses list
  responses element-wise (`listOf`) rather than with the contracts'
  `.catch([])` wholesale fallback, so one corrupt row degrades to one missing
  tile.
- **Stage 1+ experiment kinds are refused at create time** (400), not accepted
  and failed later. **Spent 2026-08-11:** every declared kind is runnable as of
  Stage 3, so the guard and its code are gone (Stage 3 rulings below).
- **Only a reviewed fixture may be probed**: the runner refuses an unreviewed
  control with `image_lab.control_unreviewed` before any spend, and the
  experiment form greys the tile out with a "review it first" line rather than
  hiding it.
- **A settle that matches no row discards its output**: an experiment deleted
  mid-render leaves a `lab_output` nothing points at, so `storeLabRender`
  deletes it through the owned-image deleter and reports
  `image_lab.output_orphaned`. Deleting a live (`pending` / `running`)
  experiment stays allowed — a deploy-killed row must not become permanent.
- **Extraction is charged per PAID preprocessor call**: the budget count is
  sources × pose/depth kinds, not sources. Edge is computed locally and pays
  nothing, and which kinds are paid is read from `imageLabPreprocessorFor`
  rather than restated at the route.
- **A lab run tells the circuit breaker what actually happened**: `startJob`'s
  `run` takes a `JobRunContext` whose `reportProviderOutcome(true | false |
  null)` overrides the default "resolved means the provider answered" reading,
  and both lab runners return that reading in their payload for the route to
  report. Needed because the lab settles provider failures into rows and
  resolves anyway, so the default recorded a healthy lane for a dead Replicate
  and a successful call for work no provider saw. `false` is reserved for
  `transient` classifications (`imageFailureHealthOutcome`, beside
  `classifyImageFailure`) — the reading the scene chain already calls a possible
  service outage; `content_rejection` and `other` (billing, missing token)
  report nothing, because the provider answered and shedding fixes neither.
  Local edge extraction and every precondition refusal report nothing too.
- **Zero-cost image work opts out of the budget floor**: `imageRenderRejection`
  keeps `Math.max(1, count)` for every caller, and takes `allowZeroCount` for
  one that means it. The extract route passes it, so an edge-only batch charges
  no `provider_image_day` unit while still clearing backpressure and the storage
  reservation (which keeps its own floor of one — local work writes an image).
- **A probe must SEND the control it declares**: the runner refuses
  `image_lab.control_invalid` unless `controlImageId` is non-null and appears
  exactly once among the ordered inputs under a control-class role (`pose`,
  `depth`, `control` — `imageLabControlRole`'s image, which moved into the
  contracts file so the form and the runner cannot disagree). Without it a
  direct API call could declare fixture A, render fixture B, and record a
  verdict against a skeleton the provider never saw. The create schema refuses
  the same contradiction as a 400; the runner stays authoritative for rows that
  predate the rule.

Owner ruling (2026-08-11) — **an undisclosed executed version is
non-disclosure, not a disagreeing version**:

- Replicate answers the literal string `"hidden"` in a prediction's `version`
  field for an **official** model. Vesper reads that as "the provider does not
  disclose which version ran". The **evidence identity of such a run is the
  requested pin**, which Replicate validates at create time.
- Three empirical facts, verified against the live API on 2026-08-11, back the
  ruling. Official models expose **no versions list at all**: `GET
  /v1/models/{owner}/{name}/versions` answers `404 "This model does not expose
  a list of versions"`. A version that does not resolve is refused on
  `POST /v1/predictions` with `422 "The specified version does not exist"`,
  **before any spend** — so an accepted pinned create is itself proof the pin
  resolved. The settled prediction then reports `version: "hidden"` while
  `model` carries the slug. (Observed on prediction
  `kj2yrktvnnrmy0czy2h810cvt8`, requested pin
  `a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729`,
  experiment `g8lr8ogf0t4xbdhhaoruyhhs`.)
- **The record stays verbatim.** `executedVersionId` still stores exactly what
  the provider said, `"hidden"` included; the interpreting happens at one
  shared seam, `providerVersionsDisagree` in
  `src/contracts/images/image-models.ts`, which both the lab detail screen and
  the identity-pack trial's post-render audit call. It reports a disagreement
  only when both sides are present, differ, and the executed side is not
  undisclosed.
- **The lab screen shows a plain line, not the suspect banner**, when the echo
  is undisclosed and a pin was requested: the provider does not disclose which
  version ran, and the requested pin was validated when the prediction was
  created. A genuine disagreement keeps the red banner.
- Consequence for the trial harness: an undisclosed echo no longer settles a
  cell `failed`/`version_mismatch`, which had made the identity-pack trial
  unrunnable against every official model. A genuinely different echoed sha
  still refuses.

Ruling settled 2026-08-11 — **a probe may not be fed its own answer**:

- When the declared fixture's meta names a `sourceImageId`, the runner refuses
  `image_lab.control_source_sent` if that render appears anywhere among the
  ordered inputs — any role, not just `identity`, because the answer rides the
  pixels, not the label. Sending the render a control was extracted from lets
  the output match the control by copying that reference, so a
  `honours_control` verdict would record a pass the probe never earned.
  Refused before any provider spend, beside `control_unreviewed`. The
  exemption is the meta's, not the generator's: a fixture recording no
  `sourceImageId` has no render holding the answer to copy, and a
  hand-authored upload may record one (a skeleton traced over a render),
  which puts it under the same rule. The experiment form greys the source
  render out in the identity picker and clears a conflicting pick, so the
  refusal is reachable only through direct API calls.

## Stage 1/2 build rulings (2026-08-11)

The controlled kinds ride the shared machinery end to end; the lab's own code
declares intent and records outcomes, nothing more.

- **Recipes are code, not profile rows.** `src/contracts/images/image-lab-recipes.ts`
  defines one recipe per (controlled kind × control kind): a fully-shaped
  `ImageModelProfile` — operation `edit`, strategy `multi_reference_compose`,
  reference policy requiring `identity` + the control role and ordering
  identity → control → optionals (`outfit`/`style`/`object` for portraits,
  `location`/`outfit`/`style` for scenes, one of each) — materialized onto the
  registry's resolved model at run time under the id prefix `image-lab/`. A
  seeded row under task `variant`/`scene` would surface in the ordinary lane
  pickers and leak the experiment into the normal site; a code recipe is
  versioned by the repo the way prompt strategies are. The recipe key is
  recorded on every run.
- **The recipe's task drives eligibility.** `controlled_portrait` compiles as a
  `variant` profile and `controlled_scene` as a `scene` profile, so
  `profileEligibility`'s identity-critical screening applies: a weak-identity or
  img2img model refuses (`image_lab.profile_unavailable`) instead of rendering a
  stranger.
- **Controlled runs pin through the intent path.** `ImageRenderIntent` gained an
  optional `versionId` that `renderImageIntent` threads to the transport;
  production lanes never set it, and the lab sets it to
  `pinnedImageModelVersion`'s answer (refusing `version_unpinned` without one,
  exactly as the probe does).
- **Capacity trims and records instead of refusing.** The probe's
  `capacity_exceeded` refusal exists because the direct path's record could not
  say what was sent. On the intent path the plan itself is the record: required
  roles refuse before spend (`image_profile.required_reference_missing` and its
  siblings settle onto the row verbatim), optional references beyond the
  model's arity are dropped by `planIntentReferences`, and every drop is
  written down. The probe keeps its refusal.
- **The outcome is part of the record.** The runner writes
  `meta.outcome` — recipe key, sent roles in send order, each dropped reference
  with its reason, and the renumbered flag — on success and on `render_failed`
  alike, and the wire experiment exposes it as a nullable `outcome` field
  (absent on rows that predate it). Baselines record the same shape, recipe key
  absent, so both arms of a comparison carry the same evidence.
- **The raw `controlInput` bag is a probe tool.** A controlled experiment
  carrying a non-empty raw provider bag refuses before spend with
  `image_lab.settings_unsupported`: the recipe exists to prove a
  production-shaped run, and production has no raw bag. Normalized
  `settings.controls` still apply per render.
- **Verdicts extend to controlled kinds.** `imageLabVerdictKinds` = the probe
  plus both controlled kinds — each declares a control the output can be judged
  against — and the reviewer's explicit-ruling flow is unchanged. Baselines
  still refuse a verdict.
- **Stage 0's integrity gates carry over unchanged.** `checkControlBinding`
  guards controlled runs too: reviewed fixtures only, the declared fixture sent
  exactly once under a control role, and the fixture's source render barred
  from the ordered inputs.
- **`outfit` joined the reference-role vocabulary** for the wardrobe arm of
  Stage 1 — recorded in
  [image-model-capabilities.spec.md](image-model-capabilities.spec.md)
  §"Reference policy", which owns the tuple.
- **The form offers a subset of each recipe's optional roles.** Portraits offer
  `outfit` and `style` (both sourced from the character's renders); scenes
  offer `location` and `style` (the chat's scene renders) and `outfit` (the
  chat's primary character's portraits). `object` stays API-reachable only:
  no item-image source is reachable from the form, and offering the role with
  nothing to pick would be an empty select. The recipes allow it, so the form
  re-adds it the day a source exists.

## Stage 3 build rulings (2026-08-11)

The finishing pass rides the same intent path the controlled kinds ride. What
is new is where its references come from — one of them is another experiment's
output, the other is the identity pack — and what a reviewer is asked about it.

- **A finishing pass addresses its source by EXPERIMENT id, stored in the row's
  `meta`.** No migration: `image_lab_experiments.meta` already existed for
  per-run facts, `sourceExperimentId` is written there at create, and the wire
  experiment exposes it as a nullable field read back through `parseOr`. The
  pointer is to the experiment rather than to the base image because a finishing
  pass is one arm of a three-arm comparison and the arm it is read against is a
  record — instruction, recipe, pinned version, verdict — of which the image is
  the visible part.
  - Consequence, and the one behavior change to the existing kinds: every
    `meta` write in the runner now MERGES the stored bag instead of assigning
    it. Assignment was harmless while the bag only ever held the settle's own
    record; it would silently drop a create-time key. Provably inert for the
    other five kinds — they write no create-time meta, so the merge is over
    `{}`.
- **Finishable sources are the two baselines and the two controlled kinds.** A
  `control_probe` is refused because it is not a production-shaped render of
  anybody (hand-ordered inputs, possibly a raw provider bag, possibly no
  identity reference at all), and a `finishing_pass` is refused because a chain
  accumulates drift with nothing to attribute it to. Baselines ARE allowed: the
  direct-edit baseline is one of the three images the plan's comparison holds,
  and "did the second pass earn its cost?" is asked of it on the same terms.
  Three separate create-time refusals — `source_not_found`,
  `source_kind_unsupported`, `source_not_rendered` — because they ask three
  different things of the admin; the runner re-checks all of it and settles
  `image_lab.source_invalid`, since a source can be deleted between the queue
  and the render.
- **The subject is inherited, never sent.** The create schema refuses a
  `characterId`/`chatId` on a finishing pass and the service copies both from
  the source, so the two arms of a comparison can never be filed against
  different characters. Identity references are drawn for the experiment's own
  character, falling back to the primary character of its chat (a scene source
  files against a chat, not a character).
- **The ordered inputs are resolved by the RUNNER and written back onto the
  row.** Neither is a fact a client can supply honestly: the base is whatever
  the source actually rendered at run time, and the pack's selection is a
  versioned policy decision. The create schema therefore refuses any `inputs` on
  this kind. Writing the resolved list back is what keeps the record honest —
  the detail screen shows both references as thumbnails exactly as it does for a
  hand-ordered kind.
- **Pack references come from `evaluateIdentityPackForProfile` under
  `canonical_only`, purpose `admin_trial`.** The pack machinery already owns
  "which image is this character's identity", measurements and provenance
  included; re-deriving it in the lab would be a second answer to a settled
  question. `canonical_only` rather than `canonical_then_face_detail` because
  the base render already occupies a reference slot: canonical plus face detail
  would fill the model's three exactly, which is the configuration the Stage 1/2
  trial watched collapse identity in both of its three-reference runs. The
  recipe's policy allows a second identity reference so the face-detail arm is a
  one-value change — which must move `imageLabInputListSchema`'s one-identity
  cap with it. A pack that offers nothing refuses `image_lab.identity_unavailable`
  before any spend, carrying the pack's own blocking code in the message.
  - **The pack GATE (`imageIdentityPackReferencesEnabled`) is deliberately not
    consulted**, on the identity-pack trial's own precedent: that flag governs
    whether production lanes send pack references, and a bench measuring what
    those references are worth cannot be gated on the decision it exists to
    inform. Nothing here is player-visible; every render is a hidden
    `lab_output`.
- **The recipe is `finishing_pass/identity`, task `variant`, one profile for
  every source kind.** Roles `before` (the source's render) then `identity`,
  both required, `multi_reference_compose` on `edit` like the controlled
  recipes. `before` is the render-intent vocabulary's own word for "the starting
  state this render transforms", so the existing role binding describes it with
  no new wording. The task stays `variant` even when the source was a scene: the
  task decides which screening `profileEligibility` applies, and a finishing
  pass is an identity operation — screening it as a scene would test the model
  for composition the pass is under orders not to touch.
- **The instruction is fixed text plus an optional narrowing.** The runner sends
  `imageLabFinishingInstruction(row.instruction)` — a preamble naming both
  halves of the plan's promotion rule (correct the face toward the reference;
  keep pose, body, hands, clothing, camera, framing, lighting, colour and
  setting exactly as they are), then the admin's own text after a blank line
  when they wrote any. The rule is not editable, because a run whose claim is
  "one thing changed" cannot let that claim be deleted. Hair sits on the
  identity side of the preamble: hairline and hair colour are identity signal,
  and the Stage 1/2 drift the pass exists to fix included them.
- **The raw `controlInput` bag is refused here too** (`settings_unsupported`,
  the controlled kinds' own refusal, now shared) — a recipe run proves a
  production-shaped request, and production has no raw bag.
- **Verdicts split into two vocabularies over one column.**
  `imageLabProbeVerdicts` is unchanged; `imageLabFinishingVerdicts` is
  `improves_identity` / `identity_unchanged` / `changes_beyond_identity` /
  `inconclusive` — the outcomes the plan's promotion rule produces, since
  "honours the control" cannot be asked of a run that sends no control.
  `imageLabVerdicts` is the union the row's `verdict` column and the wire
  request speak, `imageLabVerdictOptions(kind)` is the per-kind gate, and the
  service refuses a ruling from the other kind's vocabulary
  (`verdict_not_in_vocabulary`). One column rather than a second field: an
  experiment records exactly one ruling whatever kind it is. No migration — the
  column is plain `text` (drizzle's `{ enum }` is a TypeScript refinement, not a
  check constraint).
- **`image_lab.kind_unsupported` is gone.** It existed only while
  `finishing_pass` was declared but unbuilt. Every declared kind now has a runner
  arm, which the exhaustive dispatch enforces at compile time, so the create-time
  kind guard and its code were removed rather than left as unreachable code (the
  2026-08-10 ruling "Stage 1+ experiment kinds are refused at create time" is
  spent).

## Stage 4 build rulings (2026-08-11)

Stage 4 consumes the capabilities plan's LoRA library (its slice 6 rulings own
the library machinery); what this stage settles is which endpoint carries LoRA
work and how the lab reaches it.

- **Qwen Image Edit 2511 exposes no LoRA input — the "integrated LoRA input"
  premise is void.** Verified against the live Replicate schema (read-only API,
  2026-08-11): the pinned-and-still-latest version `a0670a7f…` accepts exactly
  `seed`, `image`, `prompt`, `go_fast`, `aspect_ratio`, `output_format`,
  `output_quality`, `disable_safety_checker`. The model card's "integrated
  LoRAs" phrase describes acceleration baked into the weights, not a
  user-suppliable input. No other qwen-owner **edit** endpoint carries LoRA
  fields either (`qwen-image-edit`, `qwen-image-edit-plus` checked); only the
  text-to-image `qwen/qwen-image` does, and its `img2img` edit mode is screened
  out of identity-critical tasks, so it cannot be the finishing connector.
- **The LoRA finishing connector is `qwen/qwen-image-edit-plus-lora`** — the
  official qwen-owner "Qwen Image Edit 2509 LoRA explorer" (~553k runs at
  registration time). This is the plan's own fallback clause exercised, not a
  new decision: the owner ruling of 2026-08-10 registers "a dedicated Qwen LoRA
  endpoint only if 2511's integrated support proves insufficient", and it now
  provably is. The endpoint's `lora_weights` takes exactly the library's two
  locator shapes (a Hugging Face `owner/repo` slug or a direct
  safetensors/zip/tar URL) and an empty string means "run without a LoRA", so
  the SAME pinned model runs the no-LoRA comparison arm — which keeps the LoRA's
  contribution separable from the 2509-versus-2511 model difference.
  `lora_scale` is a number, provider range 0–4, default 1.
- **Registration is the ordinary admin flow, not a migration.** The endpoint is
  registered post-deploy through the add-by-slug probe on
  `/settings/image-models` (the probe derives the two LoRA bindings and records
  the pin), then rated by the model PATCH: `editKind: instruction_edit`,
  `identityPreservation: moderate` (the 2509 generation is documented as weaker
  at identity than 2511 — `moderate` keeps it eligible for the
  identity-critical finishing recipe while recording the step down),
  `maxReferences: 3`. Its reference page joins `docs/image-models/` when the
  registration happens.
- **LoRA selection rides the existing normalized-controls seam.** A lab
  experiment carries `settings.controls.lora` (`{ id, scale? }`) — the create
  request needed no new field. The runner resolves the selection against the
  library before any spend (in the shared recipe seam, so the controlled kinds
  accept a LoRA by API exactly as they accept other normalized controls) and
  the refusal codes settle onto the row **verbatim**, the same convention as
  the `image_profile.*` codes. The resolved binding travels on the intent
  (`resolvedLora`, the `versionId` precedent), so the recorded plan, outcome
  and final prompt all reflect the LoRA that actually ran.
- **The form offers the LoRA picker on `finishing_pass` only.** Stage 4's
  question is asked of the finishing connector; the controlled kinds stay
  API-reachable for a later arm (the `object`-role precedent — the recipes
  allow what the form does not yet offer). The picker lists enabled library
  rows; the scale input is bounded to the row's curated range and pre-filled
  with its default.
- **Verdict vocabularies are unchanged.** A LoRA-carrying finishing pass keeps
  the finishing vocabulary; a style LoRA deliberately changes more than
  identity, so its rulings are recorded in `verdictNote` and in this spec's
  trial section rather than through a third vocabulary. Stage 4 proves
  plumbing; Stage 5 judges value — inventing verdict values for a two-run
  plumbing trial would churn the per-kind gate for nothing.

## Stage 4 LoRA trial protocol

Owner work with agent assistance, on the Fly deploy with the uxtest admin
account, after the slice-6 build deploys. Everything before step 4 spends
nothing.

1. **Register the connector.** Add `qwen/qwen-image-edit-plus-lora` on
   `/settings/image-models` (the probe pins the version and derives the LoRA
   bindings), then set the reviewed ratings and `maxReferences: 3` per the
   build ruling above. Confirm the row records a `probedVersionId` and both
   LoRA bindings; give it a `docs/image-models/` page in a docs-only commit.
2. **Create the library row.** One style LoRA, `huggingface_repo` or a direct
   `https_url` locator, curated scale range around the author's recommendation,
   `allowedTasks: [variant]`, trigger words per the model card. Candidates
   researched 2026-08-11: a Qwen-Image-Edit-2509-trained style LoRA with an
   unmistakable, judgeable effect (the photo-to-anime family) first;
   `flymy-ai/qwen-image-edit-2509-inscene-lora` as the same-family alternate.
   The provider doc's own example `flymy-ai/qwen-image-lora` is a person LoRA
   ("Valentin" trigger) — compatibility-vouched but wrong for a style trial.
   Verify the exact repository, file layout and license before creating the
   row.
3. **Refusal checks — every one must fail before spend** (no `predictionId`,
   no result row): a finishing pass on 2511 carrying the LoRA
   (`image_lora.unreachable_configuration` — no bindings); one on the connector
   with a library row whose `compatibleModelSlugs` names only 2511
   (`image_lora.incompatible`); a requested scale outside the curated range
   (`incompatible`); the row disabled (`unreachable_configuration`); a
   nonexistent LoRA id (`unreachable_configuration`).
4. **Paid arms.** Over one Stage 3 source (the direct-edit baseline
   `ssuucjcm…` produced the cleanest Stage 3 result), run finishing passes on
   the connector: (a) no LoRA — the model-generation baseline, which also
   measures 2509-generation finishing against Stage 3's 2511 results; (b) the
   LoRA at its default scale; (c) optionally one more scale point. Every run
   carries the Stage 3 ruling's mandatory appearance-text instruction.
5. **Judge and record.** Did the style visibly apply, scaled by `lora_scale`?
   Did identity and structure survive relative to the no-LoRA arm? Is the run
   reproducible from its record (pin, LoRA id + scale, final prompt with the
   trigger additions)? Record verdicts with notes, write the results into this
   section, and flip the plan's Stage 4 status line when the owner accepts.

Exit: pinning, hosting, selection, strength limits, prompt additions and
diagnostics are each proven by a live run or a recorded refusal — the plan's
"prove the plumbing" bar — and the refusal list above all fired pre-spend.

## Contracts

New file `src/contracts/images/image-lab.ts` (pure; exported via
`src/contracts/index.ts` beside the other image contracts). It reuses — never
redeclares — `imageReferenceRoles` from `image-model-capabilities.ts`.

- `imageLabExperimentKinds = ["control_probe", "baseline_portrait",
  "baseline_scene", "controlled_portrait", "controlled_scene",
  "finishing_pass"]` — Stage 0 uses the first three; the rest are declared now
  so the record shape survives Stages 1–3 without migration.
- `imageLabModes = ["identity_priority", "controlled_composition", "balanced",
  "style_priority"]` (optional on Stage 0 experiments).
- `imageLabControlKinds = ["pose", "depth", "edge"]`.
- `imageLabControlGenerators = ["extracted_pose", "extracted_depth",
  "computed_edge", "hand_authored"]`.
- `imageLabInputSchema` — `{ position: number (1-based), role:
  ImageReferenceRole, imageId: string, note?: string }`; an experiment carries
  an ordered array of these. Validation: positions contiguous from 1, at most
  one `identity` role in Stage 0, roles limited to the reference-role
  vocabulary.
- `imageLabControlMetaSchema` — `{ controlKind, generator, sourceImageId?,
  preprocessorSlug?, preprocessorVersionId?, originNote?, reviewedAt?,
  reviewNote? }` — stored in `images.meta` for `lab_control` assets.
  `originNote` carries the annotation from whichever path created the fixture
  (the extraction request or the hand-authored upload) and records what it was
  made for; `reviewNote` carries the reviewer's ruling.
- `imageLabProbeVerdicts = ["honours_control", "ignores_control",
  "inconclusive"]` — recorded on `control_probe` experiments by the reviewing
  admin.
- `imageLabExperimentSchema` + list schema, and the route request schemas
  (create experiment, extract controls, upload control, review control, record
  verdict). Every DB read and route body goes through `parseOr` per
  `docs/resilience.md`.

Stage 1/2 additions (2026-08-11): `imageLabVerdictKinds` /
`isImageLabVerdictKind` (which kinds accept a verdict), `imageLabOutcomeSchema`
(+ the nullable `outcome` field on the wire experiment), the
`settings_unsupported` failure code, create-request rules requiring a character
on `controlled_portrait` and a chat on `controlled_scene`, and the sibling file
`image-lab-recipes.ts` carrying the recipe profiles (Stage 1/2 rulings above).

Stage 3 additions (2026-08-11):

- `imageLabFinishingVerdicts` and the `imageLabVerdicts` union both sub-tuples
  `satisfies`; `imageLabVerdictSchema` on the wire experiment's `verdict` and on
  the record-verdict request; `imageLabVerdictOptions(kind)` (the per-kind gate,
  `null` for baselines) and `isImageLabVerdictForKind`. `finishing_pass` joins
  `imageLabVerdictKinds`.
- `sourceExperimentId` on the wire experiment — nullable, `.catch(null)`,
  read out of `meta`.
- Create-request rules: a `finishing_pass` names `sourceExperimentId` and
  refuses `inputs`, `characterId`, `chatId`, `controlImageId` and `controlKind`;
  every other kind refuses `sourceExperimentId`.
- Failure codes `source_invalid` and `identity_unavailable`.
- In `image-lab-recipes.ts`: `IMAGE_LAB_FINISHING_RECIPE_KEY`,
  `IMAGE_LAB_FINISHING_IDENTITY_STRATEGY`, `imageLabFinishingRecipeProfile`,
  `imageLabFinishableKinds` / `isImageLabFinishableKind`.
- In `src/lib/images/image-lab-instruction.ts`:
  `imageLabFinishingInstruction(ownerInstruction)`.

Stage 4 additions (2026-08-11): none of the lab's own contracts changed — the
LoRA selection was already a member of the normalized controls the settings
schema accepts. The library contract (`src/contracts/images/image-loras.ts`:
the record, locator validation, redaction, the render evaluator, the
`image_lora.*` codes, `ImageLoraRenderBinding`, and the intent's `resolvedLora`
field) belongs to
[image-model-capabilities.spec.md](image-model-capabilities.spec.md); the lab
consumes it through the shared recipe seam.

## Ownership rules

- The lab module owns `image_lab_experiments` rows and every `lab_control` /
  `lab_output` asset. No other module reads or writes them.
- The lab never writes `characters`, `chats`, `image_identity_packs`, or any
  non-lab `images` row. Promotion of a lab result into a real portrait is out
  of scope until Stage 7 and absent from this build.
- The Replicate HTTP surface stays in `src/server/ai`. The lab adds
  `runReplicatePreprocessor` there rather than fetching provider URLs itself.
- Normal lanes must be provably untouched: no ordinary-lane file changes except
  additive enum/registry entries (`jobs.type`, `images.kind`, provider-lane
  mapping), and no lab import from any lane module except the profile
  resolution + quality seams named below.
- Cost and safety guards are shared, not lab-specific: experiment-creating
  routes pass `imageRenderRejection` (which layers backpressure, storage quota,
  and the `provider_image_day` daily budget) before any job starts.

## Algorithms

### Experiment run (`control_probe`, Stage 0)

1. Load the experiment row; `parseOr` its inputs; missing/invalid →
   `failed` + `image_lab.input_missing`.
2. Resolve the model by slug (default `qwen/qwen-image-edit-2511`) from the
   registry. `pinnedImageModelVersion(model)` must return a version id; `null`
   (slug/probe disagreement) → `failed` + `image_lab.version_unpinned`. Record
   the requested version id on the experiment.
3. Read each input image's bytes owner-scoped, in recorded order. The control
   image must be a `lab_control` asset whose meta parses; otherwise
   `image_lab.control_invalid`.
4. Build the prompt: the admin's instruction verbatim. The lab pre-fills (in
   the UI, not silently in the runner) a numbered-role template consistent with
   the Qwen dialect in `quality-presets.ts`, e.g. "Image 1 is the identity
   reference — preserve the exact face, hair, skin tone, body proportions, and
   apparent age. Image 2 is a pose skeleton diagram, not a person and not a
   style reference. Render the person from Image 1 in exactly the body pose
   drawn in Image 2." The runner sends what the admin approved and records the
   final prompt on the experiment.
5. Call `runRegistryImageModel` with the ordered buffers, the pinned
   `versionId`, the model's reviewed quality overlay
   (`withReviewedImageQuality`), and any per-experiment `controlInput` from
   settings. Record `predictionId` and `executedVersionId`.
6. Save the output as a `lab_output` image (trial-service precedent:
   `createImageAsset` + internal save; the internal-callers census `APPROVED`
   map in `scripts/image-internal-callers.test.ts` gains the lab service).
   Mark the experiment `succeeded`; failures classify via
   `classifyImageFailure` and record `image_lab.render_failed` with the
   classification.

### Baseline runs

`baseline_portrait`: resolve the `variant` profile via
`resolveImageProfileForTask` with the character's stored selection, take the
canonical avatar as the single identity reference, and render with the same
compiled settings the variant lane would use — then save as `lab_output` under
the experiment. `baseline_scene` does the same through the scene profile and
the chat's current reference anchor. Both record profile id, model version,
and final prompt so a later comparison can show settings parity. Neither
enqueues the lane's own job type nor writes lane-visible assets.

### Finishing pass run (`finishing_pass`, Stage 3)

Every step before the render is a refusal that costs nothing, in this order:

1. Read `meta.sourceExperimentId`; absent or unreadable → `source_invalid`.
2. Load that experiment owner-scoped and re-check it: finishable kind,
   `succeeded`, holding a `resultImageId` → otherwise `source_invalid`.
3. `pinnedImageModelVersion` → `version_unpinned` without one, exactly as the
   controlled kinds.
4. A non-empty raw `controlInput` → `settings_unsupported`.
5. Read the source's result bytes → `input_missing` if unreadable.
6. Resolve the subject (the row's character, else the chat's primary character)
   and evaluate its identity pack under `canonical_only` → `identity_unavailable`
   with the pack's own code when it offers nothing, or when no candidate's bytes
   can be read.
7. Write the resolved ordered inputs onto the row (`before` at position 1, then
   the identity references), then run the shared recipe path — eligibility,
   `planImageRender`, recorded outcome, pinned render, `storeLabRender` —
   under `imageLabFinishingRecipeProfile`. Provenance on the stored output is
   the BASE render, not the identity reference: the result is that image with
   one thing changed.

### Control extraction

`lab_control_extract` job, one per requested source image:

- **pose** / **depth**: `runReplicatePreprocessor` with the pinned
  preprocessor (table below), input = the source image bytes, output
  downloaded through the existing output-host allow-list, decoded by sharp to
  validate, saved as `lab_control` with full extraction meta. Invalid or
  undecodable output → `image_lab.preprocessor_output_invalid`.
- **edge**: computed in-process with sharp (grayscale → Sobel via `convolve`
  → threshold to white-on-black), no provider call.

Hand-authored skeletons arrive through the upload route (`saveOwnedImageBuffer`
with kind `lab_control`, generator `hand_authored`).

### Preprocessor pins

| Kind  | Model (Replicate)               | Version pin (2026-08-10) |
| ----- | ------------------------------- | ------------------------ |
| pose  | `fofr/controlnet-preprocessors` | `f6584ef7…625988e`       |
| depth | `chenxwh/depth-anything-v2`     | `b239ea33…ed88ebd4`      |

Full version ids live as constants in `image-lab-controls.ts` with provenance
comments. The pose cog defaults all fourteen of its preprocessor switches ON,
so the pin declares every switch and enables only `open_pose`; its output is an
array of URIs (first taken). The depth model answers an object — the runner
reads `grey_depth` via the transport's `outputField`. Pins are constants, not
registry rows — preprocessors are lab tools, not player-facing image models,
and must not appear in any picker.

## Persistence

New table `image_lab_experiments` (Drizzle: `imageLabExperiments`), following
the naming and id conventions of `image_identity_pack_trial_runs`:

- `id` (pk), `ownerId` (fk users, cascade), `kind`, `mode` (nullable),
  `characterId` (fk, set null), `chatId` (fk, set null);
- `modelSlug`, `requestedVersionId`, `executedVersionId`, `profileId`
  (nullable, baselines only);
- `instruction` (admin's text), `finalPrompt` (what was sent);
- `inputs` (jsonb ordered role list), `controlImageId` (fk images, set null),
  `controlKind` (nullable);
- `settings` (jsonb: controlInput overlay, seed once transport exists, LoRA
  fields in later stages), `resultImageId` (fk images, set null);
- `status` (`pending` / `running` / `succeeded` / `failed`), `failureCode`,
  `verdict` (nullable, probe kinds only), `verdictNote`;
- `predictionId`, `createdAt`, `startedAt`, `finishedAt`, `meta` (jsonb).

Enum/registry additions: `images.kind` += `lab_control`, `lab_output` (both
added to `HIDDEN_IMAGE_KINDS` and excluded from `GALLERY_IMAGE_KINDS`);
`jobs.type` += `lab_image`, `lab_control_extract` (mapped in
`providerLaneFor` to the image lane). Migration via the standard workflow —
edit `schema.ts`, `pnpm db:generate`, review SQL, `pnpm db:migrate`; if
drizzle-kit's create-vs-rename prompt appears, stop and hand the generate step
to the owner.

Lab assets ride the existing filesystem storage and the existing sweep;
`deleteImageLabExperiment` deletes its `lab_output`/`lab_control` orphans
through the owned-image deleters. Data-lifecycle ownership of lab rows joins
that plan's audit the first time it sweeps this table.

## Resilience

Trust boundaries and their degraded defaults, each with a degradation test
asserting fallback **and** code:

- Route bodies → `parseOr` → 400 with the schema's refusal, never a thrown 500.
- Experiment `inputs` / `settings` / control meta read-back → `parseOr` →
  experiment `failed` with `image_lab.input_missing` /
  `image_lab.control_invalid`; the runner never throws through `startJob`.
- Version pin absent → `image_lab.version_unpinned`, experiment refused before
  any provider spend.
- Control fixture readable but unreviewed → `image_lab.control_unreviewed`,
  experiment refused before any provider spend. Kept separate from
  `control_invalid`: one fixture is thrown away, the other is looked at.
- Fixture's source render among the ordered inputs →
  `image_lab.control_source_sent`, refused before any provider spend — the
  output could match the control by copying that reference, so the verdict
  would record copying, not obedience.
- Ordered inputs beyond the resolved model's reference capacity →
  `image_lab.capacity_exceeded`, refused rather than trimmed — the render path
  fits an overlong list to the model's arity, so a trimmed run would leave a
  record claiming a control the provider never received. **Probe only:** a
  controlled run's plan records what was sent, so it trims optionals and writes
  every drop into the outcome instead (Stage 1/2 rulings).
- Controlled run OR finishing pass carrying a raw `controlInput` bag →
  `image_lab.settings_unsupported`, refused before any provider spend.
- Finishing pass whose source experiment is missing, of an unfinishable kind, or
  holding no result image → `image_lab.source_invalid`, refused before any
  provider spend. Checked again at run time because a source can be deleted
  between the queue and the render.
- Finishing pass whose subject offers no identity-pack reference →
  `image_lab.identity_unavailable`, refused before any provider spend, with the
  pack's own blocking code carried in the recorded message.
- Recipe run naming a LoRA the library refuses → `image_lora.incompatible` /
  `image_lora.unreachable_configuration` settle onto the row verbatim, refused
  before any provider spend (the code split is the capabilities spec's).
- Controlled run whose plan refuses (required role missing, required control
  input unfilled, strategy uncompilable) → the intent path's own
  `image_profile.*` code settles onto the row verbatim, never a thrown 500.
- Preprocessor output → sharp decode validation →
  `image_lab.preprocessor_output_invalid`, no asset written.
- Render failure → `classifyImageFailure` recorded, `image_lab.render_failed`;
  a failed experiment leaves every source image and every ordinary lane
  untouched (nothing to roll back by construction).
- Lab page fetches → list schemas with `.catch([])` so a bad row degrades to
  an empty slot, not a broken admin page.

## Code organization

- `src/contracts/images/image-lab.ts` — contracts above; exported from
  `src/contracts/index.ts`.
- `src/contracts/images/image-lab-recipes.ts` — the controlled-kind recipe
  profiles and the Stage 3 finishing recipe (pure; exported from
  `src/contracts/index.ts`).
- `src/server/images/image-lab.ts` — experiment service (create, list, detail,
  delete, run, record verdict); exported via `src/server/images/index.ts`.
- `src/server/images/image-lab-controls.ts` — extraction service + edge-map
  computation + preprocessor pins.
- `src/server/ai/replicate.ts` — adds `runReplicatePreprocessor` (create
  prediction with pinned version, poll, download validated output; no retry
  loop, same timeout regime as image runs); exported via `src/server/ai`
  barrel.
- `src/app/api/admin/self/image-lab/experiments/route.ts` (GET list, POST
  create+run), `experiments/[experimentId]/route.ts` (GET detail, DELETE,
  PATCH verdict), `controls/route.ts` (GET list, POST upload),
  `controls/[controlId]/route.ts` (PATCH review, DELETE),
  `controls/extract/route.ts` (POST) — all `withOwnerAdmin`, all passing
  `pnpm lint:authz`'s census.
- `src/lib/images/image-lab-instruction.ts` — the pure numbered-role
  instruction-template builder the form pre-fills (identity sentence + per-kind
  control sentence + structure-only closing), `imageLabControlRole`
  (pose→`pose`, depth→`depth`, edge→`control`), and the finishing pass's fixed
  preamble (`imageLabFinishingInstruction`), which the runner sends and the form
  previews from the same function.
- `src/app/settings/image-lab/page.tsx` →
  `src/components/settings/image-lab-page.tsx` (+ small subcomponents beside
  the identity-trial ones): fixtures panel (extract form with portrait picker,
  upload, origin and review notes) and experiments panel (create form with
  instruction template pre-fill, painting-tile pending state per the PR #70
  pattern, list with side-by-side result/source/control, detail drawer showing
  the full recorded settings). Settings nav gains an admin-only "Image Lab"
  link. On the detail view every image renders through one `EnlargeableImage`
  (whole, never cropped, opening the shared lightbox): the three large panels
  and a role-labeled thumbnail per ordered input, so a reference the run sent
  is always viewable rather than only cited by id.
- `src/lib/client/api.ts` — `imageLabApi` client wrappers.

## Fixtures and tests

- Pure suite: contract round-trips (experiment, inputs ordering rule, control
  meta), instruction-template builder, edge-map kernel on a tiny generated
  buffer, route-schema refusals.
- Census/gate updates in the same change: `APPROVED` map in
  `scripts/image-internal-callers.test.ts`, route-authz census, barrel
  exports (no deep server imports anywhere).
- Postgres suite (`test:int` / `test:engine` as CI scopes them): experiment
  create → run with a stubbed renderer seam (trial precedent:
  `setTrialRendererForTesting`-style injection) → succeeded row + hidden
  output asset; each degradation case above asserting fallback + diagnostic.
- Control fixtures themselves are data, not repo files: extracted and uploaded
  on the deployed app, reviewed in the fixtures panel. The repo tracks no
  binary fixture images for the lab.

## Stage 0 control-probe protocol

Run on the Fly deploy with the uxtest admin account, after the lab ships:

1. Extract a pose skeleton and a depth map from one existing render whose pose
   is clearly different from the target; review both in the fixtures panel.
2. `control_probe` experiment: inputs `[1: identity = canonical portrait,
   2: pose = skeleton fixture]`, instruction from the template, model 2511,
   pinned version recorded. The **executed** version is whatever the provider
   echoes and need not equal the pin: an official model answers `"hidden"`,
   which is non-disclosure, and the run's identity is the pin Replicate
   validated at create time (owner ruling 2026-08-11, above). Only a real,
   different sha invalidates the probe.
3. Judge the output against the skeleton: limb-for-limb pose match, identity
   preserved. Record `honours_control` / `ignores_control` / `inconclusive`
   with a note on the experiment.
4. If `ignores_control`: register Qwen Image Edit Plus in the model registry
   (admin image-models page probe), give it a `docs/image-models/` page, rerun
   the probe there, and record both verdicts.
5. Repeat step 2 with the depth fixture (one more generation) once the pose
   verdict is recorded.
6. Write the verdict into this spec (below) and reflect the connector split in
   the plan if the fallback path was taken.

**Probe verdicts (run 2026-08-11 on the Fly deploy):**

- **Pose — honours the control.** Experiment `g8lr8ogf0t4xbdhhaoruyhhs`,
  prediction `kj2yrktvnnrmy0czy2h810cvt8`, pin `a0670a7f47d5…`. Full-body
  render in the skeleton's wide-V arms and A-stance with the skeleton's
  left/right asymmetry reproduced, from a waist-up identity reference carrying
  no arm or leg signal. Identity preserved; hair length the one drift.
- **Depth — honours the control.** Experiment `zn5o0qb1153ame54ok1nsfzj`,
  prediction `qpeb89h9vdrmr0czy2ns2gy28w`, same pin. Silhouette tracks the map
  within ~1% of image width at matched figure height (worst ~3% at an ankle),
  asymmetry reproduced, no tonal bleed from the grayscale map; identity drift
  smaller than the pose probe's.
- **Consequence:** every later stage runs on 2511 and Qwen Image Edit Plus is
  not registered — the protocol's fallback step is void. Full verdict notes
  live on the experiments themselves; screenshots from the run are in the
  untracked `screenshots/` folder.

## Stage 1/2 trial protocol

Owner work, on the Fly deploy with the uxtest fixtures (or any admin account
with a reviewed fixture set). Run 2026-08-11; the verdicts it produced are
recorded below the steps.

1. For each control kind with a reviewed fixture (pose, depth, edge): create a
   `controlled_portrait` — identity = a portrait that is NOT the fixture's
   source render, control = the fixture, instruction = the change being tested
   (the numbered role bindings are compiled by the strategy; the instruction is
   the base prompt).
2. Pair each with a `baseline_portrait` for the same character carrying the
   SAME instruction — the direct-edit arm the plan's Stage 1 exit names. The
   detail view's paired-baseline action pre-fills it.
3. Run the wardrobe arm once: identity + outfit reference + pose fixture.
4. For Stage 2, repeat with `controlled_scene` on a chat (identity anchor +
   fixture + optional location reference) paired with `baseline_scene`.
5. Judge each pair side by side — structure obedience, identity survival,
   unrelated drift — and record a verdict with a note on every controlled
   experiment. The recorded outcome (sent roles, drops) plus the pinned version
   is the settings evidence the comparison cites.
6. Write the verdicts into this spec and flip the plan's Stage 1/2 status lines
   when the owner accepts them.

**Stage 1/2 trial verdicts (run 2026-08-11 on the Fly deploy):**

Constant across every controlled run: model `qwen/qwen-image-edit-2511`,
requested pin `a0670a7f47d5…dee03ca6c729` on every run, executed version
`"hidden"` (provider non-disclosure per the ruling above), identity reference
`qqtzfaz9ii1v2k4q7xfnxif6`, and the three reviewed fixtures — pose
`qkg1bj6tdolj7vhxllu4jgfk`, depth `o34s05qcro1qet4u8mbv2uma`, edge
`gmcsw9q83adpydlzuqxfaqlc`. Every run's recorded outcome lists the sent roles
with zero drops.

**Controlled portraits.** Paired direct-edit baseline
`ssuucjcm6h5xew3z8c39gaw6`, carrying the same instruction:

- Pose `f8g32azmhbs10tehshuygs75` — **ignores_control**: rendered with no arms
  against a both-arms-raised-V skeleton.
- Pose `op1o2sh8b6nlofac8m2ww0rn` — **honours_control**: an exact configuration
  copy of the failed run above; perfect adherence, and face similarity better
  than the failed run. The pair demonstrates that pose obedience is stochastic,
  not a prompt defect.
- Pose `nhy61r90jqsb2a8ixnm03th0` — **honours_control**: shoulder→wrist within
  ~6° of the skeleton.
- Pose `n7tfm5essc6nfvy2p3nunlmt` — **honours_control**, the best structural
  match of the set: every leg segment within 3°, wrist-elevation ratio 0.355
  against the skeleton's 0.356.
- Depth `ilv0sd7v3sncf3xohl4rk2uu` — **honours_control**: hands within ~15 px
  and limbs within ~5° of the map at matched figure height.
- Edge `xtyuelauhebdns9rz7piasa5` — **honours_control**: contours within ~6%,
  and the edge fixture's own open-mouth smile did not transfer to the render.

**Controlled scenes.** Chat `kh4zqvf9x4t4ae9x5zj6a1ix`, run with no location
reference because that chat holds no scene renders. Paired scene baseline
`zo3hnihacrlfb6itxzxb6grx`, which runs the scene lane's own resolved profile
unpinned by design and rendered the default arms-at-sides stance:

- Pose `qtky796japtgzqmvtup8argz` — **ignores_control**: legs followed within
  ~2°, but the arms substituted a hands-behind-head pose (elbow interior
  112–116° against the skeleton's 168–178°, no hands rendered).
- Pose `e7h228i0u4xtrr39jyn0jpvr` — **ignores_control**: invented a gold fabric
  sheet above her head, present in no prompt and no reference.
- Depth `on9x9y874447p3xcyi9qvl67` — **honours_control**: perfect alignment with
  both the identity reference and the depth map (owner note).
- Edge `qnn65r2c4p85zp7o8ty87tuv` — **honours_control**: dark jeans and bare
  feet inherited from the edge map's contours. Recorded as a known property of
  edge control — the map encodes clothing silhouettes — and acceptable absent an
  outfit reference.

**Wardrobe arm.** Identity + pose control + outfit reference
`ljsoaj4j19jjp2f4a86hcp5y`, a full-body render of the character in slim denim
jeans and white canvas sneakers generated for this arm through the portrait
studio's variant kind `outfit` — the one variant kind whose compiled instruction
does not append "Keep the same outfit as the reference image":

- `f5atmf8k4hgfihul0k3admka` — **ignores_control**: a completely different
  character, the pose ignored (hands-behind-head again), and an invented cream
  dress keeping only the sneakers. All three roles verifiably sent, nothing
  dropped.
- `bktrh4dzy4m5hizbjzil1f9h` — **ignores_control**: the instruction rewritten to
  demand the exact wardrobe-reference outfit with no inferred additions; very
  odd face generation. Same three references.
- Both three-reference sends — exactly the model's reference capacity —
  collapsed identity under two different instructions, while every
  two-reference send preserved it at least moderately. Reference crowding at
  capacity is the standing explanation; the plan's open question carries the
  unresolved part.

**Cross-cutting findings.** A blind adjudication pass over the raw images
independently agreed with every owner verdict:

- Tally: depth 2/2 honours, edge 2/2 honours, pose two-reference 3/6 (portraits
  3/4, scenes 0/2), three-reference 0/2. Depth and edge are the reliable control
  kinds in both lanes; pose is stochastic, with hands-behind-head the recurring
  substitute pose.
- Expression drift: 2 of 9 reviewed renders opened the mouth against the
  reference's closed neutral, uncorrelated with the fixtures — the only fixture
  encoding an open mouth (edge) produced a closed-mouth render.
- Identity drift has a consistent direction on controlled renders: a slimmer
  face and tapered chin against the reference's rounder jaw. Baselines and the
  best pose pass kept identity closest.
- The pose fixture's elbows are near-straight (interior ~168°/178°), so renders
  showing straight arms are faithful to it. A future pose fixture must encode
  elbow bend explicitly if bend is wanted.
- Owner ruling (2026-08-11): the Stage 1/2 results are accepted. Identity plus
  control is the proven configuration; wardrobe/outfit delivery is deferred
  future work, carried as an open question on the
  [plan](qwen-advanced-image-subsystem.plan.md).

## Stage 3 finishing trial protocol

Owner work, on the Fly deploy with the uxtest fixtures. Run 2026-08-11; the
verdicts it produced are recorded below the steps.

1. Pick controlled results whose identity drifted while their structure held —
   the Stage 1/2 corpus names two directly (depth portrait
   `ilv0sd7v3sncf3xohl4rk2uu`, edge portrait `xtyuelauhebdns9rz7piasa5`, both
   structurally right with faces slimmer than the reference). That drift is
   exactly what a finishing pass is supposed to fix.
2. For each, create a `finishing_pass` naming it as the source. Leave the
   instruction blank on the first run of each pair, so the fixed rule is the only
   variable; add a narrowing ("the jaw is too narrow") only on a second run.
3. Run one finishing pass over the paired direct-edit BASELINE too
   (`ssuucjcm6h5xew3z8c39gaw6` is the Stage 1/2 pairing). The plan's comparison is
   three-armed, and a pass that improves the baseline as much as the controlled
   result says something about the pass rather than about control maps.
4. Read each detail screen's before/after pair side by side and record a ruling
   with a note: `improves_identity` only when the face is closer AND pose,
   clothing, body, camera, lighting and setting are unchanged;
   `changes_beyond_identity` the moment anything else moved, whatever happened to
   the face.
5. Judge the cost question explicitly in the notes: the plan warns that a second
   pass of the SAME model is a weak prior, so a tally weighted toward
   `identity_unchanged` is a real Stage 3 answer, not a failed trial.
6. Write the verdicts into this spec and flip the plan's Stage 3 status line when
   the owner accepts them.

**Stage 3 finishing verdicts (run 2026-08-11 on the Fly deploy):**

Constant across every run: model `qwen/qwen-image-edit-2511`, requested pin
`a0670a7f47d5…dee03ca6c729`, recipe `finishing_pass/identity`, and two resolved
inputs — `before` = the source experiment's own render, `identity` =
`qqtzfaz9ii1v2k4q7xfnxif6` drawn through the pack. Every run sent both roles
with zero drops. The three sources are the ones steps 1 and 3 name: the depth
portrait `ilv0sd7v3sncf3xohl4rk2uu`, the edge portrait
`xtyuelauhebdns9rz7piasa5`, and the direct-edit baseline
`ssuucjcm6h5xew3z8c39gaw6`.

**Round 1 — instruction blank, the fixed preamble alone.**

- Depth source → `f7h1ndu16bigdmx4ghpkdfvu` — **identity_unchanged**: hair
  rendered the wrong colour, the face no closer to the reference, and the whole
  image lightened.
- Edge source → `ymf03qdw8qutfzuoaf0a2zll` — **identity_unchanged**: hair
  rendered blonde against the reference's dark brown, and the face further from
  the reference than the before.
- Baseline source → `gyyzgx1pmkvsz11dqgwt04d5` — **identity_unchanged**: hair
  the wrong colour again, and the frame recropped from full-body to mid-thigh.
- Tally 0/3. With no appearance signal the pass invents hair colour and can
  break framing: the preamble tells the model to correct the face toward the
  reference but carries no description of what that face is.

**Round 2 — the same three sources with an appearance instruction.** The
protocol's second-run narrowing, shaped by owner direction as the text a
character's authored appearance attributes would supply in production. Written
in the portrait studio's Appearance format:

> Appearance: dark brown hair, center-parted, loose waves falling below the
> shoulders; brown almond eyes; thick, fairly straight brows; soft oval face
> with a broad rounded jaw, squared chin, and full cheeks.

- Depth source → `ycby0m8zea0of3bv4muatimg` — **changes_beyond_identity**: hair
  corrected and the face the closest of the round, but the composition
  collapsed — the head scaled to roughly half the frame, the torso deleted, the
  forearms disconnected.
- Edge source → `b4d7lskb7oihziqsn4vmzp48` — **improves_identity**: hair
  corrected to dark brown and the face moved toward the reference, with pose,
  clothing, framing, lighting and setting all held. Hair slightly longer than
  the before, in the reference's direction.
- Baseline source → `rk124aw3hupulcv2ixmyardo` — **improves_identity**, the
  round's cleanest result (owner note: perfect): the face refined toward the
  reference and the frame not recropped.
- Tally 2/3 improves, 1/3 structural collapse.

**Owner ruling (2026-08-11): the finishing pass is conditionally viable.** It
improves identity only when its instruction carries appearance-attribute text;
without that text it is useless and actively harmful. It is neither promoted nor
dropped now — it stays available to Stage 7's promotion decision under two
recorded conditions:

- **Appearance text is mandatory.** A blank instruction scored 0/3 across both
  controlled sources and the baseline.
- **A structural-collapse risk of roughly one run in three must be screened
  for.** The depth arm's collapse was not predictable from its before image, so
  any promoted path needs a check on the result rather than on the input.

Production wiring depends on characters carrying authored appearance
attributes. The trial character carries none — its only authored set is the feet
one — so the round-2 text was hand-derived from the canonical reference. Where
that text comes from in production is carried as an open question on the
[plan](qwen-advanced-image-subsystem.plan.md).

## Research record — character-LoRA dataset size (for Stage 5)

Researched 2026-08-10 against trainer docs and community guides (no controlled
Qwen-specific ablation exists; evidence is vendor-doc grade):

- Consensus recommended range for a Qwen-Image character LoRA is **20–30
  images** (documented hosted-trainer minimums are 5–10; diminishing returns
  past ~50).
- **Seven varied images is workable but marginal**: expect usable identity,
  weaker generalization to novel poses and lighting. Mitigations that matter,
  in order: expand the set by using Qwen-Image-Edit itself to synthesize
  additional consistent angles/outfits from the seven; train at low rank
  (8–16 — Qwen-specific, lower than SDXL/Flux habits); learning rate at or
  below 1e-4; 1,000–2,000 steps with checkpoints every 250–500 and best-pick.
- Captioning guidance conflicts (Replicate's trainer says descriptive real
  words, no rare trigger token; other guides say the opposite) — treat as a
  trial arm, not a settled rule.
- Hosted training: `qwen/qwen-image-lora-trainer` on Replicate (H100, ZIP of
  images + optional captions, ~15–30 min, roughly $1.40–$2.75 per run).
- Feeds the plan's open question: the pilot should plan on the seven images
  **plus a synthesized expansion to ~20+**, with the owner's go/no-go taken at
  Stage 5 kickoff.
