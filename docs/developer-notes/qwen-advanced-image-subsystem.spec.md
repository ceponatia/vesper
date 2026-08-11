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

Stage 1+ work (controlled recipes on the render-intent path, finishing passes,
LoRA trials) is deliberately absent from this table until the capabilities
plan's slice 3 remainder and slice 9 exist; per the plan's sequencing ruling
those are built next, under that plan.

## Rulings this build settles

- **Stage 0 renders bypass the render-intent path.** `renderImageIntent` and
  role-priority selection stay untouched; the Stage 0 lab runner calls
  `runRegistryImageModel` directly with an explicit ordered reference list and a
  pinned `versionId`, and records everything itself. Rationale: capabilities
  slices 3/9 are unbuilt, and half-consuming an unfinished vocabulary from the
  lab would smear the boundary the plan draws. When those slices land, lab
  renders move onto the intent path and this ruling expires.
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
- **`failureCode` is a bounded string, not a closed enum**: three codes beyond
  the contract's list exist (`image_lab.kind_unsupported`,
  `image_lab.profile_unavailable`, `image_lab.run_threw`), and provider
  classifications ride `meta.renderFailure`. A failed extraction *prediction*
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
  and failed later.
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
  Refused before any provider spend, beside `control_unreviewed`;
  hand-authored fixtures name no source and are exempt by construction. The
  experiment form greys the source render out in the identity picker and
  clears a conflicting pick, so the refusal is reachable only through direct
  API calls.

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
  record claiming a control the provider never received.
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
  control sentence + structure-only closing), and `imageLabControlRole`
  (pose→`pose`, depth→`depth`, edge→`control`).
- `src/app/settings/image-lab/page.tsx` →
  `src/components/settings/image-lab-page.tsx` (+ small subcomponents beside
  the identity-trial ones): fixtures panel (extract form with portrait picker,
  upload, origin and review notes) and experiments panel (create form with
  instruction template pre-fill, painting-tile pending state per the PR #70
  pattern, list with side-by-side result/source/control, detail drawer showing
  the full recorded settings). Settings nav gains an admin-only "Image Lab"
  link.
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
