# Render advisories

Vesper measures a small set of deterministic signals on every successful render and, when one
crosses a named threshold, attaches an ADVISORY annotation beside the render's own provenance.
An advisory never gates a render, never substitutes a model, and never touches what is stored as
the image — it is a readable reason, the measurement behind it, and what the owner might try
next. The owner's own agree/disagree review is the evidence that eventually promotes, narrows,
rejects, or proposes a narrowly defined promotion check for a signal; a threshold crossing alone
never does.

## Owns / does not own

- Owns: the two shipped signals and their thresholds, where an advisory attaches, the owner
  review affordance, and the comparison summary that review produces.
- Does not own: the render pipeline itself, `images.meta.render` (the attempt record) or
  `images.meta.shape` (the crop/shape record) — [providers/render-intents.md](providers/render-intents.md)
  §Seeds and the render record owns those; the identity-pack quality contract (blur score, face
  measurement) — [identity-packs.md](identity-packs.md) owns that.

## Measuring versus judging

Every evaluator splits into two steps, and the split is permanent even when a threshold moves:

- **Measuring** computes a plain fact about the render — a trimmed-area fraction, a pixel
  variance — independent of any threshold. A measurement that cannot be taken (an unknown
  pre-crop aspect, a buffer too small to convolve) is skipped, never fabricated as a judgment of
  zero.
- **Judging** compares a measurement against a named constant to decide whether an advisory is
  worth showing. `RENDER_ADVISORY_VERSION` is what changes when a threshold moves; the
  measurement's own shape does not have to.

## The two signals

### `harmful_crop_loss`

Reads the shape record `providers/render-intents.md` already writes on every render
(`images.meta.render.shape`) — no pixels are read. The trimmed-area fraction is computed from the
two ASPECT RATIOS the shape record carries (`shape.expectedAspect`, the pre-crop ratio, and
`shape.crop.targetRatio`, the ratio the crop reached), using the ratio identity
`1 - min(a,b)/max(a,b)`, which gives the exact area fraction a crop-to-ratio removes regardless of
resolution — the pre-crop buffer's own pixel dimensions are not persisted, only its ratio and the
post-crop size are.

`CROP_LOSS_ADVISORY_FRACTION = 0.15` (`packages/image-core/src/quality/render-advisories.ts`).
An 832×1216 model default trimmed to 3:4 removes ≈0.088 of the frame and does not trigger — an
ordinary aspect-ratio correction, not a loss. A square render trimmed to 3:4 removes exactly 0.25
and does trigger. The evidence recorded is `{ trimmedFraction, placement }`; the offer is
`new_variation` only — retrying the same source crops the same way, so `retry_same` is
meaningless here.

Skipped (no advisory, not even a sub-threshold record) when no crop was performed, or when the
render's pre-crop expected aspect is unknown.

### `blank_output` and `severe_blur`

Read the render's own decoded output: after a successful render, the returned buffer is decoded
once through `sharp`, resized to a 256px-wide thumbnail without enlargement, converted to
grayscale, and read as raw pixels — cheap, in-process, and never sent anywhere. Two measurements
come off that thumbnail: `grayVariance` (variance of the grayscale pixel values themselves) and
`laplacianVariance` (variance of the Laplacian response, the identity pack's own blur measure,
reused here).

`BLANK_OUTPUT_GRAY_VARIANCE_FLOOR = 4` — below this, the image's tonal variance is
indistinguishable from one flat fill (a standard deviation under 2 of 255 levels), the signature
of an empty or solid-color output. `SEVERE_BLUR_LAPLACIAN_VARIANCE_FLOOR = 50` — below this, the
thumbnail has no measurable edges anywhere, where a genuinely sharp render's edges put it in the
thousands at the same resize width. Blank is checked first: a flat fill also measures zero
Laplacian variance, and the honest statement about it is "nothing is there", not "it is out of
focus". Both offer `retry_same` and `new_variation`.

Skipped when the decoded pixels are too small to measure at all. A decode failure on the returned
buffer (the transport returned bytes `sharp` cannot read) reports the `images.advisory.unmeasured`
diagnostic and attaches nothing — it never fails the render.

Both signals are versioned together under `RENDER_ADVISORY_VERSION = 1`
(`packages/image-core/src/quality/render-advisories.ts`); a threshold change bumps that constant.

## The deferred candidate: face count

Duplicated faces and extra people are the failure with the most recorded evidence in this
codebase — the `single_subject_integrity` negative block, the `character_duplicated` lab verdict,
the identity pack's `ambiguous_faces` rule — but no signal for it ships today. The production
identity detector is a deliberate null seam (`packages/image-core/src/identity/identity-pack-detector.ts`,
a privacy stance, not a gap to fill), and the only image-understanding path in this codebase is an
OpenRouter VLM call that sends the image off-machine and needs its own review before it can feed
an advisory. A face-count signal stays a recorded candidate, not a shipped one, until one of those
two facts changes.

## Where an advisory attaches

`apps/web/src/server/images/render-intent.ts` is the one seam: after a successful render,
`renderImageIntent` runs both evaluators and returns the result carrying `advisories` beside
`attempt`. `renderAttemptMeta` writes `images.meta.advisories` as a THIRD sibling key beside
`images.meta.render` and `images.meta.shape` ([providers/render-intents.md](providers/render-intents.md)
§Seeds and the render record) — present only when the list is non-empty, so a clean render's
`meta` stays byte-identical to a render with no advisory support at all. No lane file reads
`advisories` to refuse anything: a render carrying every advisory this module can produce still
returns successfully and is still stored.

## Owner review

`PATCH /api/images/:imageId/advisories` (`apps/web/src/app/api/images/[imageId]/advisories/route.ts`)
records the owner's verdict on one advisory: `{ code, verdict: "agree" | "disagree", note?: string }`
merges as `review: { verdict, note?, at }` onto the matching entry in `images.meta.advisories`. An
unknown code — one this render never measured — is a 404, the same shape as a missing or foreign
image. A second review on an entry that already has one REPLACES it; reviews never stack or
average.

`components/ui/image-lightbox.tsx` shows one quiet line per advisory for the image's owner,
outside the admin-only provenance panel: the code's copy
(`components/images/advisory-copy.ts`, an exhaustive switch — a code without copy is a compile
error), its offers as short text, and Agree/Disagree buttons. A reviewed advisory shows its
recorded verdict instead of the buttons.

## The comparison record

`GET /api/admin/self/image-advisories/summary` (`apps/web/src/app/api/admin/self/image-advisories/summary/route.ts`)
is the table an owner reads to write a verdict: per code, how many of the owner's renders were
annotated, how many were agreed or disagreed with, and how many are still unreviewed, plus the 20
most recently reviewed rows. `apps/web/src/app/settings/image-advisories/page.tsx` renders it.

A recorded verdict, written from that table, states one of three things for a signal:

- **Annotate** — the signal's agreement rate is high enough that it should keep annotating renders
  as it does today.
- **Reject** — the signal's disagreement rate, or a recorded misleading result, means it should
  stop annotating.
- **Propose a narrowly defined promotion check** — the evidence supports a specific, bounded gate
  proposal for a future change; the advisory itself remains a signal, not a gate, until that
  proposal is separately reviewed and implemented.

No automatic gate or model substitution exists anywhere in this design, at any signal-agreement
rate: a verdict is written by the owner from the comparison record, never computed from a
threshold.

## Diagnostics

- `images.advisory.unmeasured` (warn) — the returned buffer could not be decoded to measure
  pixel-based signals; the render is unaffected and no advisory attaches.
