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
| Stage 4 connector registration + refusal checks | run 2026-08-11   |
| Stage 4 style-LoRA smoke arms (no-LoRA / LoRA)  | run 2026-08-11   |
| Stage 4 arm verdicts                            | run 2026-08-11   |
| Stage 5 LoRA-only arm + training runbook        | built 2026-08-11 |
| Stage 5 dataset + character-LoRA training run   | run 2026-08-11   |
| Stage 5 hosting + comparison arms               | run 2026-08-11   |
| Stage 5 owner verdicts                          | run 2026-08-11   |
| Stage 6 two-character kind, recipe, runner      | built 2026-08-12 |
| Stage 6 subject-aware compose bindings          | built 2026-08-12 |
| Stage 6 create/verdict/comparison UI            | built 2026-08-12 |
| Stage 6 two-character trial runs + verdicts     | not run          |

Stage 7 (the promotion decision) is deliberately absent from this table: it
closes the plan. Stages 0–5 are all closed; Stage 6's machinery is built and
its trial has not run. The LoRA library itself is the capabilities plan's
slice 6 ([image-model-capabilities.spec.md](image-model-capabilities.spec.md)
§"Slice 6 implementation rulings"); this table tracks only the lab's side, and
the subject-aware compose bindings belong to the capabilities spec
(§"Prompt strategies", §"Reference policy") with the lab as first consumer.

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

## Stage 5 build rulings (2026-08-11)

Stage 5 adds one comparison arm and one piece of operator tooling; everything
else it runs on already exists.

- **A finishing pass declares which ARM it runs.** `imageLabFinishingVariants =
  ["identity", "lora_only"]`; the create request takes an optional
  `finishingVariant` (refused on every other kind), stored in the row's `meta`
  beside `sourceExperimentId` and exposed on the wire as a nullable field. Null
  means "declared none": every Stage 3 row predates the vocabulary, and
  flattening the default into those records would erase the difference between
  a pass that chose the identity arm and one that was never asked. The RUNNER
  applies the default (`identity`) in one place, where the recipe is chosen.
- **The `lora_only` arm isolates by disallowing, not by capping.** Recipe
  `finishing_pass/lora_only`: `requiredRoles: ["before"]`, `allowedRoles:
  ["before"]` — identity is not allowed at all, so it cannot be smuggled back
  by a future edit (the identity recipe's `maxPerRole.identity: 2` headroom
  made a zero-cap approach fragile). The runner skips pack resolution entirely
  on this arm — no `identity_unavailable` path, because nothing is asked of the
  pack.
- **A LoRA-only pass without a LoRA is refused.** At create
  (`finishingVariant: "lora_only"` with no `settings.controls.lora` is a 400 —
  with no weights and no identity reference the run would only re-render its
  source), and again pre-spend in the runner (`image_lab.input_missing`) for
  rows that predate the rule or bypass the schema. The refusal is lab
  vocabulary, not `image_lora.*`, because no library resolution ever ran —
  nothing was resolved, so nothing refused.
- **The finishing preamble forks per arm — the one substantive change to Stage
  3 text.** The Stage 3 preamble orders the model to correct the face "so it
  matches the identity reference"; on an arm that sends no such image that
  sentence names a slot that does not exist, and the run would measure prompt
  confusion rather than the LoRA. `imageLabFinishingInstruction(instruction,
  variant)` swaps only that target sentence (`lora_only`: correct toward the
  character the prompt names; no identity reference image is supplied); the
  change-nothing-else half is shared verbatim between arms and a test asserts
  the shared half is identical, so the comparison's constant stays constant.
- **Training stays outside the application.**
  `scripts/train-image-lora.ts` is on-demand operator tooling — the plan rules
  automatic in-app LoRA training out of scope — that stages a dataset without
  mutating it, writes missing caption sidecars, zips flat, uploads, starts a
  training against the PINNED trainer version, polls, and downloads/extracts
  the result. Trainer: `qwen/qwen-image-lora-trainer`, version
  `f28eb39544f2c0dff4fbd9d50588fd75789f7ef26f6118456a96c2eedddddf90` (probed
  2026-08-11). Spending is opt-in (`--yes` / TTY confirm), `--dry-run` makes no
  network call, and the token is never printed.
- **Trainer facts that bind the pilot** (verified against the trainer's code
  and live schema, 2026-08-11): the dataset ZIP is FLAT (nested directories are
  silently ignored — the script says so out loud), formats `.jpg/.jpeg/.png/
  .webp` only; captions are same-basename `.txt` sidecars, optional, with
  `default_caption` filling the gaps — and its `<>` placeholder is NOT
  substituted by the trainer, so the real name must be written in. Captioning
  doctrine is the vendor's, unambiguous: descriptive real words and a real
  first name, never rare tokens — which settles the research record's
  "captioning as a trial arm" as unnecessary. Only the FINAL checkpoint is
  kept (`max_step_saves_to_keep: 1`), so the research record's
  best-pick-from-checkpoints mitigation is unavailable; a step-count comparison
  is two trainings. Output is `{ weights: <url> }` — a durable
  `replicate.delivery` ZIP (training outputs are hosted indefinitely;
  prediction outputs are the ones that expire) containing `lora.safetensors`.
  The plus-lora endpoint's README refuses zip archives while its field
  description claims to accept them; the protocol tests the ZIP URL empirically
  once and re-hosts the extracted safetensors when refused.

Owner rulings (2026-08-11), recorded here because the pilot runs on them:

- **The pilot subject is Sabrina Vale** — the existing lab fixture character
  with the canonical portrait, reviewed identity pack, and the Stage 1–4
  comparison corpus. An external seven-image set originally offered for the
  pilot is NOT used, and the ruling generalizes: **a training set is assembled
  only from images whose generation provenance is verifiable** — the app's own
  renders qualify by construction; external sets without generation records do
  not.
- **The training set is the curated existing corpus plus synthesis to ~20**:
  the trial-verdict-faithful renders of Sabrina (the honours/improves results;
  never the identity-collapse or wrong-hair failures) plus fresh variant
  renders targeting the corpus's variety gaps (wardrobe, setting, framing).
- **Hyperparameters**: rank 32, learning rate 2e-4, 1500 steps, batch 1, adamw
  — the trainer README's recommendation reconciled against the research
  record's lower-rank advice; a second training at different settings only if
  the first underfits.
- **Hosting fallback is snarebox.com S3/CloudFront** when the durable ZIP URL
  is refused by the endpoint: a public durable `https_url` locator under
  owner-controlled hosting, in preference to a public model-hub upload.

## Stage 6 build rulings (2026-08-12)

Stage 6 puts two people in one render. The build adds one experiment kind, one
recipe family, and the prompt vocabulary that makes two same-role references
distinguishable; everything else rides the Stage 1–5 machinery unchanged.

- **`two_character_scene` is its own kind, not a `controlled_scene` carrying a
  second identity.** The two ask different questions: a controlled scene's
  subject is the CONTROL (declared, required, ruled on for obedience), a
  two-character scene's subject is the CAST (both people surviving, unswapped
  and undoubled, with the control optional). One kind covering both would need a
  verdict column that meant different things depending on how many identity
  inputs the row carried. Widening the kinds tuple was code-only — the column is
  plain `text` — exactly the bet the Stage 0 declaration made.
- **Subjects ride the identity INPUTS, not the row.** `imageLabInputSchema`
  gained an optional `characterId`; a two-character create names its chat,
  refuses a top-level `characterId`, and sends exactly two identity inputs
  naming two DIFFERENT owned characters (each checked for ownership at create,
  the same authorization weight as the top-level checks). Only identity inputs
  of this kind may carry the binding — every other kind's runner reads no
  per-input subject, so the create request refuses one there.
- **The one-identity cap moved out of `imageLabInputListSchema`** into the
  kind-aware create-request refinements, with the runner re-checking. It could
  not stay and be relaxed per kind: the stored read-back derives from the list
  schema via `.catch([])`, so a stored two-identity list refused there would
  read back as NO inputs and settle `input_missing` — a valid experiment failing
  with a reason describing nothing. Every kind but this one still refuses a
  second identity, at create and in the runner.
- **The prompt vocabulary is the capabilities spec's, consumed here.**
  `ImageRenderReferenceSpec.subject` (sent, unlike the diagnostics-only `name`),
  the subject-bearing identity binding, and the cast clause — emitted at two or
  more DISTINCT subjects, never at two identity references, because the
  finishing recipe sends two identity images of one person — are owned by
  [image-model-capabilities.spec.md](image-model-capabilities.spec.md)
  (§"Reference policy", §"Prompt strategies"). The runner resolves both
  characters' names owner-scoped, all-or-nothing (a partial cast would bind one
  face by name and leave the other anonymous), and falls back to the stored id
  if a name is somehow blank; the form's preview compiles through the same pure
  function with the same fallback.
- **Recipes: `two_character_scene/<pose|depth|edge|none>`.** Task `scene`,
  `edit` on `multi_reference_compose`, policy requiring identity (max 2) plus
  the declared control (max 1), NO optional content roles — two identities and
  a control are 2511's whole capacity, so an allowed fourth role could only
  ever be dropped. The uncontrolled arm is a real recipe key, not a degenerate
  case: "do two people survive at all?" is answered by a run that sends no
  fixture, and one key covering both arms would make their verdicts
  indistinguishable. The kind stays out of `imageLabControlledKinds` (those
  recipes are indexed by a REQUIRED control) and out of
  `imageLabFinishableKinds` (a finishing pass refines one face toward one pack;
  a two-person render has no single subject to finish).
- **Capacity refuses rather than trims.** The plan's rule ("if all required
  identities and the selected control do not fit, the workflow is ineligible
  rather than silently dropping a character") is enforced twice. The runner
  counts its required references — two identities plus the declared control —
  against the effective model's capacity and settles
  `image_lab.capacity_exceeded` pre-spend, in the lab's own vocabulary with the
  plan's wording; the code is no longer probe-only. Behind it, the intent path
  refuses any plan that drops a reference marked `required: true`
  (`image_profile.required_reference_dropped` — the capabilities spec
  §"Reference policy" owns the mechanism), which closed the planner's
  per-role-presence gap for every caller; the runner's earlier check stays as
  the first-line refusal because its message and code are the ones the lab's
  record and tests cite. A consequence ratified with that fix: an API-built
  two-character row carrying an extra input beyond the recipe's roles now
  refuses (every input is marked required, and the recipe allows nothing else)
  instead of dropping it while the stored input list claimed it was sent.
- **The control is optional, and its integrity gates are unchanged.** A declared
  fixture passes every Stage 0 gate (reviewed, sent exactly once under a
  control role, source render barred). The runner adds two refusals of its own,
  both `control_invalid`: half a control pointer (image without kind or kind
  without image, mirroring the create schema's pairing rule), and a
  control-class role among the ordered inputs of a run that declares NO fixture
  — an undeclared skeleton would send structure the record does not name, the
  Stage 0 "verdict about an image nobody can identify" failure reached from the
  other direction.
- **Verdicts: a third vocabulary, `imageLabTwoCharacterVerdicts`** —
  `both_identities_held` (the only promotable outcome), `identities_swapped`,
  `character_missing`, `character_duplicated`, `identity_degraded`, and the
  shared `inconclusive`. The five substantive values are the plan's own failure
  modes, kept separate because each points at a different fix (a swap is a
  binding failure, a merge-or-drop is a capacity one). **Control obedience is
  deliberately NOT in the vocabulary**: the row has one verdict column, and a
  controlled two-character run wants two questions answered — so the column
  carries the kind's defining question (the cast) and pose ownership is
  recorded in `verdictNote`. A render that obeyed the skeleton and merged both
  faces is a failure; one that held both faces and ignored the pose is a result
  worth having.
- **Subject bindings are verified, not trusted** (added 2026-08-12 from the
  PR #91 review). Two refusals guard the binding itself, both settling
  `image_lab.subject_invalid` pre-spend: a cast whose two names are blank or
  case-insensitively identical (character names are not unique, and prompt
  text cannot bind two different faces to one name at any length — the honest
  answer is a refusal naming the remedy, renaming one character, and the
  compiler's distinct-subject trigger stays untouched), and an identity input
  whose image row is not filed under its bound character
  (`images.entityKind = "character"`, `entityId` equal — the columns the
  portrait picker's own listing selects on, so every form-pickable image
  passes by construction; it also closes one-portrait-for-both, since an
  image files under at most one entity). The name collision is additionally
  refused at create (`characters_share_name`) so the form answers immediately;
  the image association is deliberately runner-only, since assets can change
  between the queue and the render.
- **Subjects are any two distinct owned characters, not the chat's members.**
  The chat says where the evidence is filed, exactly as `controlled_scene`'s
  identity reference is any portrait of its character rather than the chat's
  anchor — bench looseness the Stage 1/2 rulings already accepted. Constraining
  the cast to chat membership would add trial setup (a real two-character chat)
  for no evidentiary gain.

## Stage 5 pilot protocol

Owner work with agent assistance, on the Fly deploy, after the Stage 5
machinery deploys. Fire every paid call SEQUENTIALLY (the Stage 4 throttle
finding).

1. **Assemble the dataset (~20 images).** The curated existing set (17), by
   image id — canonical `qqtzfaz9ii1v2k4q7xfnxif6`; baseline
   `nbvj0pqs7t30afwxudtv0hzu`; pose portraits `v1g9pqytr6rxfrznp5ci185i`,
   `ihl4nn19vfh2d29w84gegh14`, `nqu5ph8ifltfcitixo58lh91`; depth/edge portraits
   `g6zewqgusjg6330rlo927hih`, `qe4tldfbw8ygilawztwho2d7`; Stage 0 probe
   results `mbeamkkgmhwdfjugvs4ylon9`, `mzra0gfsyy8qoytrcclsx21z`; honours
   scenes `jjz3xf7pdbr75g0xh1o58lzi`, `mjpywru4xjedaad0w4rahsvv`; baseline
   scene `jf8lvlpbx2cttazxoxouvriu`; Stage 4 no-LoRA arm
   `f317yd8fc44tfbt046o1trwp`; improves-identity finishing results
   `gp5aknj857hh5jzgtfxupdnp`, `avpcp0hjuqnzk5kaezvthhm5`; portrait variants
   `ljsoaj4j19jjp2f4a86hcp5y` (outfit), `s2jt8bebuwkiy8pbsds7b9hy` (pose) —
   plus ~5 fresh variant renders for wardrobe/setting/close-framing variety.
   Visual dedupe before zipping; captions are short descriptive sentences
   naming "Sabrina".
2. **Train** via `scripts/train-image-lora.ts` (destination
   `<replicate-user>/vesper-sabrina-qwen-lora`, created with
   `--create-destination`; the ruling's hyperparameters are the script's
   defaults). Record the training id, duration, cost, and the durable weights
   URL here.
3. **Host.** Test the ZIP URL on the connector once (~2¢). Expected refusal →
   extract `lora.safetensors`, upload to snarebox S3/CloudFront, and use that
   `https_url` as the locator.
4. **Register the library row** — label "Sabrina (character)",
   `compatibleModelSlugs: ["qwen/qwen-image-edit-plus-lora"]`, curated band
   0.6–1.2 default 0.9 (character LoRAs overpower above ~1.2; adjust from the
   smoke), `allowedTasks: ["variant"]`, trigger word "Sabrina" (the caption
   name IS the trigger under the vendor doctrine).
5. **Key-compat smoke before any judgement** (~2¢): one finishing pass with
   the LoRA; the prediction must load the weights (the endpoint's key remapper
   handles ai-toolkit naming, but this is the two-cent check that it did).
6. **Comparison arms** over one controlled source and the direct-edit
   baseline, all on the connector at one pin, all with the Stage 3 appearance
   instruction, LoRA scale at the row default: (a) identity arm, no LoRA —
   the pack-only baseline; (b) identity arm + LoRA — pack plus weights;
   (c) `lora_only` arm — weights alone; (d) a controlled_portrait ± LoRA pair
   (API-created; the form's Model box must name the connector — its default
   2511 has no LoRA inputs and refuses pre-spend). Judge per the plan: face
   identity, build consistency, outfit/background leakage, edit obedience,
   structural control, latency, failure rate, overall preference — against
   the pack-only arm, not against memory of Stage 3.
7. **Record everything here** (ids, verdicts, notes); flip the plan's Stage 5
   line when the owner accepts.

**Stage 5 pilot run — dataset and training (2026-08-11):**

The dataset that actually trained is **20 images**: fifteen of the seventeen
curated ids in step 1 — `nqu5ph8ifltfcitixo58lh91` and
`mbeamkkgmhwdfjugvs4ylon9` were dropped as near-duplicate raised-arm poses —
plus five variant renders made for the gaps: `hlub8i65jfzidmpw7gmywbf1` (red
satin slip dress), `n66yvuf2taly5plzlf7fv403` (cream cable-knit and boots),
`c159q2vrz5d3fcfljaaoscmd` (city park at golden hour),
`pbfifmtdovtyhhys5fb66g42` (open laugh, close portrait),
`puc7vtogi3m0rekgt5f9jm3y` (dim café, chest-up). Every image carries a
descriptive caption naming "Sabrina"; the trainer recorded twenty captions and
generated none of its own.

| Training fact   | Value                                                     |
| --------------- | --------------------------------------------------------- |
| Training id     | `0q8vz9f389rmw0czydkbb670r8`                              |
| Trainer version | `f28eb39544f2…` (the pinned default)                      |
| Hyperparameters | 1500 steps, rank 32, alpha 32, LR 2e-4, batch 1, adamw    |
| Duration / cost | 18.7 min predict (20.9 min total) ≈ $1.71 on gpu-h200      |
| Destination     | `ceponatia/vesper-sabrina-qwen-lora:9324083579d2…`        |
| Artifact        | `lora.safetensors`, 590 MB, 1680 F16 tensors              |

**The artifact's key convention is native.** Every tensor is
`transformer.<block>.…lora_A/lora_B.weight` — diffusers/peft naming, already
`transformer.`-prefixed — so the connector's remapper (which prefixes
`transformer.` and drops `.default.` segments) has nothing to correct. The
naming-mismatch risk the research flagged for ai-toolkit exports does not
apply to this trainer's output.

**The durable ZIP URL is refused, as predicted.** Prediction
`hyyacj0cgnrp00czydy8zvgmx4` on the connector with `lora_weights` set to the
training's `replicate.delivery` zip failed with
`Error while deserializing header: header too large` — the endpoint downloads
whatever the locator names and parses it as safetensors, so an archive is
refused by the parser rather than by a format check. The connector README's
"unsupported: zipped/tar archives" is the authority; its `lora_weights` field
description claiming otherwise is stale. **Consequence: the extracted
`lora.safetensors` must be re-hosted, and a library row may never point at a
training's zip URL.**

**Hosting and the library row (2026-08-11).** The extracted `lora.safetensors`
was uploaded to the owner's public S3 bucket — key
`s3://snarebox-pub/lora/vesper-sabrina-qwen-lora-0q8vz9f3.safetensors`,
`us-east-2`, served by the bucket's own `AllowPublicRead` policy at a plain
HTTPS URL with no query string, which is what the library's `https_url`
locator wants and what the connector can fetch unauthenticated. Hosting cost is
about two cents a month: $0.013/month of storage, with each 0.58 GB fetch
inside AWS's 100 GB monthly free egress tier. Library row
`w9v1o24wdk6hr5vg38lyf5ky` — "Sabrina (character)", compatible with the
connector only, curated band 0.6–1.2 default 0.9, trigger word "Sabrina", task
`variant`.

**Comparison arms (run 2026-08-11, all on the connector at pin `b37d69a6…`,
all over source `ssuucjcm6h5xew3z8c39gaw6` with the Stage 3 appearance
instruction, LoRA at 0.9) — awaiting owner verdicts:**

- **(a) pack only, no LoRA** — `c1fiaht1pg018zeq3f30yx2c`, result
  `f317yd8fc44tfbt046o1trwp`. Reused from the Stage 4 smoke: same connector,
  same instruction, no LoRA, so it is the pack-only arm without re-rendering.
- **(b) pack + LoRA** — `cg7zw2k70ltmenrm5pv6hwfj`, prediction
  `zkk1azx555rp20czyebva75mew`, result `h55zhh57s02rtstznlq45gu5`. **The
  key-compatibility smoke passed here**: the weights loaded on first attempt,
  which the artifact's native `transformer.…lora_A/lora_B` naming predicted,
  and the recorded final prompt ends with the woven trigger word.
- **(c) LoRA only** — `b1akug8wxjtuj3sajw3scx42`, result
  `x1hwl593xos24j6rku5s0afx`, recipe `finishing_pass/lora_only`, sent roles
  `["before"]`. The isolation is proven by the record: one reference, no
  identity-pack image, no pack evaluation.

All three arms recropped the full-body source to chest-up, so that framing
violation is a property of the finishing pass on this connector rather than of
the LoRA. Arm (c) is visibly the LoRA acting alone — smoother, warmer-lit and
more idealized than the photographic (a) and (b), with fuller cheeks and a
rounder jaw than either. Evidence images: `screenshots/stage5-*.webp`.

**Owner verdicts (2026-08-11):**

- Arm (b), pack + LoRA — **`improves_identity`**. The LoRA earns its place when
  identity-pack references are sent alongside it.
- Arm (c), LoRA alone — **`inconclusive`**. The owner sees drift from the
  original and attributes it to the training set rather than to the technique:
  fifteen of the twenty images were the same beige shirt in the same sunlit
  studio, because that is what the lab corpus is made of. Accepted on that
  basis. The verdict is `inconclusive` rather than `changes_beyond_identity`
  because the run cannot separate the LoRA from its dataset — not because the
  render was unjudgeable.

**The dataset is the limitation this pilot actually found.** The plan's own
safeguard — vary pose, expression, lighting and clothing so the LoRA does not
learn one costume or background as identity — was only partly satisfied: the
five commissioned variants broke the pattern, the fifteen corpus renders did
not. A sharper answer on what a character LoRA is worth needs a deliberately
varied training set, which is the first thing the training tool below should
make cheap.

**Owner ruling (2026-08-11): Stage 5 closes here.** A character LoRA improves
identity alongside pack references, its whole pipeline is proven end to end —
dataset, training, durable hosting, curated library row, prompt additions,
isolation arm — and the open question about how good a character LoRA can get
is handed to a **LoRA training tool in the admin dashboard**, parked in
[deferred.plan.md](deferred.plan.md) §"Character-LoRA training as an in-app
tool" and wanted specifically so a more sophisticated LoRA can be trained.

**Operational finding — a 500 from trainings-create may still have created the
training.** Three consecutive script runs answered
`500 {"detail":"An unexpected error ocurred"}` on
`POST /v1/models/…/trainings` while each in fact created a running training;
the Replicate status page reported no incident, and the failure is at the
response layer rather than in validation (a canary on a different version of
the same trainer answered 201 for an identical body). The keeper ran on the
pinned default version, so no trainer version was ever at fault. **Before
retrying a create that answered 500, list `/v1/trainings` and cancel the
duplicates** — two surplus trainings were cancelled here, and an uncancelled
one bills in full. Cancellation goes through
`POST /v1/trainings/<id>/cancel`; the predictions-scoped cancel path answers
503 for a training id.

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

**Stage 4 registration, refusal checks, and smoke arms (run 2026-08-11 on the
Fly deploy, v187) — awaiting owner rulings:**

Registration: model `ld63cvczi7x6fyqebwn2nwxy`, slug
`qwen/qwen-image-edit-plus-lora`, probed pin
`b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200`, both LoRA
bindings derived by the probe on first registration (`lora_weights` string;
`lora_scale` number 0–4), rated `instruction_edit` / `moderate`,
`maxReferences` 3, every player surface off. Reference page:
`docs/image-models/qwen-image-edit-plus-lora.md`. Library row
`h6z6cg2ateq0489ikqe4682i` — `Photo-to-Anime (2509)`, Hugging Face repo
`autoweeb/Qwen-Image-Edit-2509-Photo-to-Anime` (MIT), curated band 0.5–1.5
default 1, task `variant`, `promptSuffix` "transform into anime".

Refusal checks — all five settled their code onto the row with `predictionId`
null (zero provider spend), on scratch rows deleted after verification:

- bindings absent (2511-compatible scratch row run on 2511) →
  `image_lora.unreachable_configuration`;
- slug incompatible (the real row run on 2511) → `image_lora.incompatible`;
- scale 3 outside the curated 0.5–1.5 (inside the provider's 0–4) →
  `image_lora.incompatible`;
- row disabled → `image_lora.unreachable_configuration`;
- nonexistent LoRA id → `image_lora.unreachable_configuration`.

Smoke arms — finishing passes over the Stage 1/2 direct-edit baseline
`ssuucjcm6h5xew3z8c39gaw6` (result `nbvj0pqs…`), both on the connector at the
pin above, both carrying the Stage 3 round-2 appearance instruction:

- **No-LoRA arm** `c1fiaht1pg018zeq3f30yx2c` (prediction `bxd126x3…`, result
  `f317yd8fc44tfbt046o1trwp`) — succeeded; photographic; the face tracks the
  appearance text, but the frame recropped full-body → chest-up, the violation
  Stage 3 saw once on 2511. Its final prompt carries no LoRA addition.
- **LoRA arm @ 1.0** `nb2e7xfyoo59az0bl3ocn5hn` (prediction `mm0b9p9v…`,
  result `i2y1kt0eavjnifjhrfu88bh2`) — succeeded; the output is fully
  anime-styled while keeping the before's outfit, center-parted dark-brown
  waves, backdrop light shapes, and a less aggressive waist-up crop. The
  recorded `finalPrompt` ends with the woven suffix ("…full cheeks.\n\ntransform
  into anime") — the prompt-addition weave proven in the record and honoured in
  the output. Executed version echoed `"hidden"` (official-model
  non-disclosure, per the standing ruling).

**Stage 4 verdicts (agent rulings 2026-08-11, at the owner's direction).** Both
arms record `changes_beyond_identity`, for opposite reasons — the vocabulary
describes what happened to the image, and the notes carry why:

- **(f) no-LoRA** `c1fiaht1pg018zeq3f30yx2c` — the face is good, among the
  closest the finishing pass has produced, with hair, eyes and brows all
  tracking the appearance instruction. It fails the promotion rule on
  everything else: full-body recropped to chest-up, and the source's sunlit
  cream studio became a dark grey-green backdrop, so framing, lighting and
  setting all moved.
- **(g) style LoRA @1.0** `nb2e7xfyoo59az0bl3ocn5hn` — the whole render became
  a flat anime illustration, which is what a style LoRA is for and therefore
  the intended result of a plumbing test rather than a regression. The
  finishing vocabulary has no value meaning "deliberately stylised", so the
  ruling records the image while Stage 4's real question is answered below.

**The style arm preserved MORE of the source than the plain arm did** — the
grey button-up with its pocket and rolled sleeves, the centre-parted dark hair,
the diagonal sunlight shape on the wall, and a gentler waist-up crop. A LoRA
that transforms every pixel of style held composition better than a pass told
to change nothing but the face, which is worth carrying into Stage 7: the
recrop is the finishing pass's own failure mode on this connector, and it is
not caused by, nor cured by, the LoRA.

Findings worth carrying: the plumbing bar is met end to end (selection,
pinning, hosting by HF slug, curated and provider strength limits, prompt
additions, diagnostics, reproducibility from the row). Two operational facts:
the connector runs `go_fast: true` (no reviewed quality overlay exists for its
row — 2511's overlay does not apply), so cross-generation comparisons against
Stage 3's 2511 runs carry that variable; and a low-credit Replicate account is
throttled to a burst of ONE prediction create per ~10s window, so concurrent
lab arms 429 as `transient` at create — fire arms sequentially. Evidence
images: `screenshots/stage4-*.webp`. Owner verdicts on the two arms are the
remaining Stage 4 step.

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

Stage 6 additions (2026-08-12):

- `two_character_scene` in `imageLabExperimentKinds`; `characterId` on
  `imageLabInputSchema`; the one-identity cap relocated from
  `imageLabInputListSchema` to the kind-aware create-request refinements (the
  build ruling above records why it could not stay).
- `imageLabTwoCharacterVerdicts` + the widened `imageLabVerdicts` union; the
  kind in `imageLabVerdictKinds` and `imageLabVerdictOptions`.
- The `subject_invalid` failure code (subject-binding refusals, from the PR #91
  review) and the create route's `characters_share_name` refusal.
- In `image-lab-recipes.ts`: `imageLabTwoCharacterRecipeKey`,
  `imageLabTwoCharacterRecipeProfile` (both arms, `/none` included).
- Outside the lab's contracts, consumed from the capabilities vocabulary:
  `ImageRenderReferenceSpec.subject`, `CompileReferenceBinding`, and the
  `render_intent` arm of `PromptReferenceBinding` now carrying bindings rather
  than bare roles ([image-model-capabilities.spec.md](image-model-capabilities.spec.md)).

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
  record claiming a control the provider never received. **Probe and
  two-character only:** a controlled run's plan records what was sent, so it
  trims optionals and writes every drop into the outcome instead (Stage 1/2
  rulings); a two-character run refuses over its REQUIRED references — two
  identities plus the declared control — because the planner's per-role
  presence gate would otherwise drop one character silently (Stage 6 rulings).
- Two-character row whose identity inputs are not exactly two, each naming a
  different owned character → `image_lab.input_missing` with the rule restated,
  refused before any provider spend; the create schema refuses the same shapes
  as a 400, and per-input character ownership is checked at create.
- Two-character row carrying half a control pointer, or a control-class role
  among its ordered inputs when it declares no fixture →
  `image_lab.control_invalid`, refused before any provider spend.
- Two-character cast whose names are blank or case-insensitively identical, or
  an identity input whose image is not filed under its bound character →
  `image_lab.subject_invalid`, refused before any provider spend (the name
  collision also refuses at create as `characters_share_name`).
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

## Stage 6 two-character trial protocol

Owner work with agent assistance, on the Fly deploy, after the Stage 6 build
deploys. Fire every paid call SEQUENTIALLY (the Stage 4 throttle finding). The
verdicts it produces are recorded below the steps when the trial runs.

1. **Stand up the second character.** The uxtest account holds one fixture
   character (Sabrina Vale). Create or pick a second with a clearly different
   look — hair colour and length, face shape, build — and give it a canonical
   portrait through the ordinary portrait flow; visibly distinct casts make
   swaps and merges legible. Record both character ids here.
2. **Uncontrolled arm first** (`two_character_scene`, no fixture): both
   identities, an instruction naming both characters and what each is doing.
   This is the kind's baseline — it measures swap, duplication, and loss with
   nothing else in the send. Run it at least twice; Stage 1/2 showed obedience
   is stochastic, so a single render proves little either way.
3. **Depth arm** (identity ×2 + a reviewed two-person depth fixture): depth was
   the reliable control kind in both Stage 1/2 lanes, so it asks "can one
   control guide both people?" with the strongest prior. A two-person fixture
   needs extracting first — render or pick a two-person image, extract, review.
4. **Pose-ownership arm** (identity ×2 + a reviewed SINGLE-person pose
   skeleton): deliberately ambiguous — the skeleton describes one body and the
   scene holds two, and the note records whose body the structure claimed, or
   whether it bled onto both. Record pose ownership in `verdictNote`; the
   verdict column stays the cast ruling.
5. **Judge with the two-character vocabulary** — count the people, then match
   each face to its own reference: `both_identities_held` /
   `identities_swapped` / `character_missing` / `character_duplicated` /
   `identity_degraded` / `inconclusive`, control obedience and pose ownership
   in the note. The recorded outcome (sent roles, subjects in the final
   prompt, zero drops) plus the pin is the settings evidence.
6. **Write the verdicts into this spec**, tally per arm, and update the plan's
   Stage 6 status line when the owner accepts. Stage 6's exit feeds Stage 7:
   whether two-character scenes are reliable enough to consider promoting at
   all, and under which control.

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

Superseded in part (2026-08-11): the captioning and checkpoint-best-pick items
above are settled by the verified trainer facts in §"Stage 5 build rulings"
(vendor captioning doctrine is binding; only the final checkpoint is kept), and
the kickoff ruling recorded there replaced the seven-image set with the curated
Sabrina corpus.
