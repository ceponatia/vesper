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
- A `control_probe` must bind its declared fixture: `controlImageId` is
  required, must appear exactly once among the ordered inputs, and must carry a
  control-class role — otherwise the run is refused rather than judged against
  a fixture the provider never saw. Input lists that exceed the model's
  reference capacity are refused (`image_lab.capacity_exceeded`) instead of
  silently trimmed.

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
  recorded settings with the fixture pointer nulled.

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
