# Advanced Image Lab

An admin-only experiment bench at `/settings/image-lab` (owner-admin routes
under `/api/admin/self/image-lab`) for controlled Qwen composition experiments —
a parallel path that never changes ordinary renders, pickers, or defaults.
Product direction and stages:
`developer-notes/qwen-advanced-image-subsystem.plan.md`; implementation
contract: its spec.

## Experiments

- **Experiments** (`image_lab_experiments`) run as `lab_image` jobs. Kinds:
  `control_probe` (explicit ordered role-tagged references — identity plus one
  control fixture — through the shared Replicate transport with a **required**
  version pin; an unpinnable model is refused with `image_lab.version_unpinned`
  before any spend), `baseline_portrait` / `baseline_scene` (re-run the
  ordinary lane's own resolved profile + render-intent configuration, so the
  recorded settings prove parity), `controlled_portrait` / `controlled_scene`
  (below), and `finishing_pass` (below). Every experiment records model slug, requested
  and executed version, final prompt, ordered input roles, settings, and
  prediction id — enough to compare or retry. Outputs save as hidden
  `lab_output` assets, so lab activity never mints a player-visible variant or
  scene.
- **Controlled experiments** run a code-defined recipe through the shared
  render-intent path with the same required version pin. A recipe
  (`contracts/images/image-lab-recipes.ts`) is a full model profile — operation
  `edit`, prompt strategy `multi_reference_compose`, a reference policy
  requiring `identity` plus the control role and allowing one optional
  reference (`outfit`/`style`/`object` for portraits; `location`/`outfit`/
  `style` for scenes) — materialized onto the resolved registry model under an
  `image-lab/` profile id, never stored as a row (a seeded row would surface in
  the ordinary lane pickers). The admin's instruction is the base prompt; the
  strategy compiles the numbered role bindings. A `controlled_portrait`
  compiles as a `variant` profile and a `controlled_scene` as a `scene`
  profile, so the registry's identity-critical eligibility screening applies.
- A controlled run records its **outcome** — recipe key, sent roles in send
  order, every dropped reference with its reason, and whether slots were
  renumbered — on success and on render failure alike; baselines record the
  same shape. Optional references beyond the model's capacity are dropped and
  written down rather than refused; required roles refuse before any spend with
  the intent path's own `image_profile.*` code on the row. The raw
  provider-shaped `controlInput` settings bag is a probe tool only: a
  controlled run carrying one refuses with `image_lab.settings_unsupported`.
- A **finishing pass** re-edits another experiment's result to correct identity
  and nothing else. It names its source experiment by id — a succeeded baseline
  or controlled run holding a result image; a probe and another finishing pass
  are both refused as sources — and inherits that run's character or
  conversation, so both arms of a comparison file against one subject. It picks
  no images at all: the runner sends the source's render under the `before` role
  plus the subject's identity-pack reference, writes that ordered list onto the
  record, and refuses before any spend when the source is gone
  (`image_lab.source_invalid`) or the pack offers no reference
  (`image_lab.identity_unavailable`). Its recipe is `finishing_pass/identity`,
  screened as an identity (`variant`) task whatever the source rendered, pinned
  like every recipe run. Its prompt is fixed text — correct the face toward the
  reference, keep pose, body, clothing, camera, framing, lighting and setting
  exactly as they are — previewed whole on the create form and not editable; an
  instruction the admin writes is appended to narrow it.
- The experiment screen shows **every ordered input as an image**, not only the
  identity reference and the control fixture: alongside the three large panels
  (identity, fixture, result) the ordered-input list renders a role-labeled
  thumbnail per slot, captioned with its position and role and enlargeable into
  the same lightbox. A reference the run sent is never judged from its id alone.
  An experiment outlives the assets it cites — deleting a control fixture drops
  its image row and leaves the ordered inputs intact — so a slot whose asset is
  gone says so in place of the image rather than rendering broken.
- A finishing pass is read as a pair: the detail screen puts the render it
  refined ("before"), the identity reference it was refined toward, and its own
  result side by side, and cites the source experiment as a record with an
  action that opens it.
- **Verdicts** are recordable on every kind that asks a question, with an
  explicit ruling and a required note; baselines have nothing to rule on and
  refuse. Two vocabularies share the one recorded field, and each kind may only
  use its own: `control_probe` / `controlled_portrait` / `controlled_scene` rule
  `honours_control` / `ignores_control` / `inconclusive`, while a
  `finishing_pass` rules `improves_identity` (the face is closer and nothing
  else moved — the only promotable outcome), `identity_unchanged`,
  `changes_beyond_identity`, or `inconclusive`. A ruling from the other kind's
  vocabulary is refused. A succeeded controlled experiment offers a paired
  direct-edit baseline action that pre-fills a `baseline_portrait` /
  `baseline_scene` with the same subject and instruction, so a comparison pair
  shares its text.
- The executed version is stored **verbatim**, and the two version ids sit side
  by side on the experiment screen. A requested pin and an executed version
  that genuinely differ raise a warning that the run's conclusions are suspect.
  Replicate's literal `"hidden"` — its answer for an official model, which
  publishes no versions list — is not such a difference: it is the provider
  declining to say, and the screen says so plainly, because the run's identity
  is the pin Replicate validated when it accepted the prediction. The single
  judgment is `providerVersionsDisagree` in `contracts/images/image-models.ts`.
- Every control-declaring kind must bind its declared fixture: `controlImageId`
  must appear exactly once among the ordered inputs under a control-class role,
  the fixture must be a reviewed `lab_control`, and its kind must match —
  otherwise the run is refused rather than judged against a fixture the
  provider never saw. Probe input lists that exceed the model's reference
  capacity are refused (`image_lab.capacity_exceeded`) instead of silently
  trimmed; controlled runs trim optionals and record the drops in their
  outcome.
- A probe may not be fed its own answer: when the fixture's meta names the
  render it was derived from (`sourceImageId` — recorded by extraction, and
  optionally by a hand-authored upload traced over a render), an experiment
  whose ordered inputs include that render is refused (`image_lab.control_source_sent`)
  before any spend — the output could match the control by copying that
  reference, so a pass would prove copying, not obedience. The experiment form
  greys that render out in the identity picker with the reason.

## Control fixtures

- **Control fixtures** are `lab_control` assets with generator provenance in
  `meta`: pose skeletons and depth maps extracted from existing renders through
  pinned Replicate preprocessors (`lab_control_extract` jobs; constants in
  `server/images/image-lab-controls.ts`), edge maps computed in-process (sharp
  Sobel threshold, no provider call), or hand-authored uploads.
- The path that creates a fixture — an extraction request or a hand-authored
  upload — may record an optional `originNote` saying what the fixture was made
  for; a fixture tile labels the origin and review notes separately, showing
  each only when present.
- Fixtures must be explicitly reviewed (`reviewedAt` + `reviewNote`, stamped
  server-side and merged over the stored meta, so `originNote` survives) before
  an experiment may use them — the runner refuses an unreviewed control before
  any provider spend — and can be deleted; a citing experiment keeps its
  recorded settings with the fixture pointer nulled. A note stored without a
  review date is an origin note, so recording the review keeps it as
  `originNote`; an already-present `originNote` wins.

## Cost and health accounting

- Experiment-creating routes pass the shared image cost guards; extraction is
  charged per **paid** preprocessor call (pose/depth), and edge-only batches
  charge nothing while still passing the backpressure and storage legs.
- Lab jobs report provider health explicitly: transient provider failures
  count against the image circuit breaker, provider answers (including content
  rejections) count as service health, and purely local or refused work
  reports nothing.
- Failures record `image_lab.*` diagnostics and classified provider failures;
  a failed or refused experiment leaves the source images, fixtures, and every
  ordinary lane untouched.
