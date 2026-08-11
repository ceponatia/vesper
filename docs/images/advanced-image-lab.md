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
  before any spend) and `baseline_portrait` / `baseline_scene` (re-run the
  ordinary lane's own resolved profile + render-intent configuration, so the
  recorded settings prove parity). Every experiment records model slug,
  requested and executed version, final prompt, ordered input roles, settings,
  and prediction id — enough to compare or retry. Outputs save as hidden
  `lab_output` assets, so lab activity never mints a player-visible variant or
  scene.
- The executed version is stored **verbatim**, and the two version ids sit side
  by side on the experiment screen. A requested pin and an executed version
  that genuinely differ raise a warning that the run's conclusions are suspect.
  Replicate's literal `"hidden"` — its answer for an official model, which
  publishes no versions list — is not such a difference: it is the provider
  declining to say, and the screen says so plainly, because the run's identity
  is the pin Replicate validated when it accepted the prediction. The single
  judgment is `providerVersionsDisagree` in `contracts/images/image-models.ts`.
- A `control_probe` must bind its declared fixture: `controlImageId` is
  required, must appear exactly once among the ordered inputs, and must carry a
  control-class role — otherwise the run is refused rather than judged against
  a fixture the provider never saw. Input lists that exceed the model's
  reference capacity are refused (`image_lab.capacity_exceeded`) instead of
  silently trimmed.
- A probe may not be fed its own answer: when the fixture's meta names the
  render it was extracted from (`sourceImageId`), an experiment whose ordered
  inputs include that render is refused (`image_lab.control_source_sent`)
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
