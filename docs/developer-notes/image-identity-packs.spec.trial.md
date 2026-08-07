# Image identity packs — trial and promotion spec

Parent spec: [image-identity-packs.spec.md](image-identity-packs.spec.md)

This document defines the controlled evidence required to promote a face-detail
reference strategy or an identity-reference quality threshold. It is distinct
from general model tuning: the trial changes pack/reference behavior while
holding the selected model profile stable within each comparison.

## Trial questions

The trial answers:

1. Does a persistent face-detail crop improve recognisable identity over the
   canonical portrait alone?
2. Which profiles benefit from canonical plus face detail, face detail alone, or
   canonical only?
3. Do detector crops outperform the conservative heuristic enough to justify the
   detector dependency?
4. Can users rescue difficult sources with a manual crop?
5. Which intrinsic and effective-size measurements predict known failures before
   provider spend?
6. Does additional facial detail increase drift in hair, apparent age, body,
   wardrobe, pose, camera, lighting, or setting?

The trial does not choose a face-repair model, output similarity model, LoRA, or
visual-state contract.

## Fixed variables

Within one comparison cell, hold constant:

- pinned model and provider version;
- model profile;
- final prompt and negative prompt;
- seed behavior;
- render dimensions;
- inference steps, guidance, sampler, and other resolved controls;
- requested edit, wardrobe, pose, setting, and framing;
- non-identity references and their order;
- moderation and post-crop behavior.

The changed variable is the identity-reference strategy or crop revision named by
the cell.

A provider that cannot reproduce a seed still records the requested seed behavior
and uses paired runs created as close together as practical. That limitation is
part of the verdict.

## Required reference cells

For each supported identity-critical profile, run:

- canonical portrait only;
- canonical portrait plus face detail when capacity permits;
- face detail only when the profile explicitly supports it;
- automatic detector crop versus heuristic crop on the same source when both are
  available;
- manual crop versus automatic crop for known difficult sources;
- historical no-pack behavior when it can be reproduced without changing other
  controls.

Do not invent a face-detail-only cell for a profile whose provider contract or
reviewed prompt strategy cannot support it.

## Corpus

The checked-in trial manifest includes:

- several human faces with different skin/hair contrast and face size;
- close, waist-up, and looser canonical framing;
- at least one stylized character;
- at least one non-human but face-like character;
- glasses;
- partial hair or hand occlusion;
- front, three-quarter, and profile-like views;
- a deliberately ambiguous multi-person source;
- a low-resolution source;
- a source where the deterministic upper-centre heuristic succeeds;
- a source where that heuristic clearly needs manual correction.

Each character has explicit authority for apparent age, hair, distinctive facial
landmarks, intended morphology, and any authored absence/prosthetic that could be
misread as a defect.

The corpus remains small enough for owner pairwise review but broad enough that
one photogenic source cannot decide the policy.

## Trial manifest

Each cell records:

```ts
export interface ImageIdentityPackTrialCell {
  id: string;
  characterId: string;
  task: string;
  promptFixtureId: string;

  modelSlug: string;
  modelVersion: string;
  profileId: string;

  identityStrategy:
    | "canonical_only"
    | "face_detail_only"
    | "canonical_then_face_detail"
    | "face_detail_then_canonical";

  packId: string;
  packRevision: number;
  sourceImageId: string;
  sourceContentHash: string;
  cropMethod: "detector" | "heuristic" | "manual";
  crop: SourcePixelCrop | null;
  derivationVersion: string;
  policyVersion: string;

  effectiveReferenceSize: {
    widthPx: number | null;
    heightPx: number | null;
    faceWidthPx: number | null;
    faceHeightPx: number | null;
  };

  orderedReferenceRoles: string[];
  resolvedControlsHash: string;
  positivePromptHash: string;
  negativePromptHash: string | null;
  requestedSeed: number | null;
}
```

The result record adds provider id, output image id, latency, cost/render units,
moderation outcome, final dimensions, post-crop bounds, failure code, and any
advisory QA findings.

## Review procedure

Present pairwise outputs in randomized order without telling the reviewer which
reference strategy produced each image.

Review grades:

- exact facial identity likeness;
- retention of distinctive landmarks;
- hair colour, texture, length, and style;
- apparent-age retention;
- requested edit fidelity;
- body and intended-morphology retention;
- wardrobe/exposure fidelity;
- pose and camera retention;
- lighting and setting retention;
- anatomy relative to intended morphology;
- overall preference.

The reviewer also records catastrophic defects separately. A strong face does not
compensate for a changed outfit, body, character count, or setting.

Use a small ordinal scale with clear anchors rather than free-form scoring alone.
Free-form notes explain failures and identify crop/prompt interactions.

## Promotion rules

A strategy may become a profile default only when:

- it materially improves identity preference across the corpus rather than one
  character;
- it does not create an unacceptable increase in composition or state drift;
- provider failure and moderation rates do not regress materially;
- latency and render cost stay inside the profile's approved budget;
- required reference capacity remains practical for the target task;
- the result is reproducible on a repeat subset.

A sharp crop or higher detector confidence is not proof of improvement. Provider
outputs decide the strategy; measurements decide whether known-bad inputs can be
blocked cheaply.

One catastrophic regression can veto automatic promotion when it represents a
class of valid Vesper content, such as non-human morphology, intentional
occlusion, or ensemble reference pressure.

Ties preserve the simpler/current strategy. The trial does not promote extra
reference cost without measured value.

## Threshold calibration

Quality thresholds are calibrated from observed failure boundaries:

- intrinsic crop dimensions;
- source face dimensions;
- blur score;
- occlusion score;
- boundary padding;
- effective face dimensions after provider resizing.

Select a conservative blocking threshold only when the corpus shows that outputs
below it are reliably unusable. Borderline measurements remain warnings until
more evidence supports blocking.

Changing only thresholds increments `policyVersion`. Changing detector
interpretation, crop geometry, or encoded crop bytes increments
`derivationVersion` and reruns affected cells.

## Manual-crop verdict

Manual correction passes when it:

- converts an automatic unusable/poor source into an eligible reference;
- improves provider identity on the difficult-source cells;
- preserves source authorization and revision history;
- does not permit a user to select a different person's face without an explicit
  canonical-source change.

The product may ship manual correction even if the automatic detector remains
imperfect, because it is also the fail-safe for ambiguous and unusual faces.

## Version promotion

A pinned model-version change reruns every cell whose identity strategy depends on
that profile. A detector or crop-policy change reruns the affected crop-method
cells. A prompt compiler change belongs to the render-quality regression matrix
and may require a combined rerun when it changes numbered reference semantics.

The trial report records one verdict per profile/version/strategy:

```text
promoted
retained-current
experimental-admin-only
rejected
```

No result is described as generally superior without naming the tested profile
and pinned version.

## Storage and privacy

Trial images use the normal owner/admin asset and authorization rules. The manifest
contains ids, hashes, settings, and measurements rather than embedded image bytes.

Exports for owner review are bounded, access-controlled, and excluded from public
Gallery/library surfaces unless the underlying images were already user-visible.
No face embeddings or guessed demographic labels are added for the trial.

## Completion

The trial slice is complete when:

- every proposed v1 reference strategy has a recorded verdict;
- detector, heuristic, and manual crop behavior has been exercised;
- ambiguous and undersized sources prove pre-provider refusal;
- intrinsic/profile thresholds have an evidence-backed policy version;
- repeat cells confirm the selected strategy;
- the identity-pack plan and active model profiles record the promoted choices.

## Implementation (built 2026-08-06; hardened for the paid trial the same day)

The harness above is implemented; no paid cell has run and no verdict exists.
The first build (PR 60) was followed by a correctness pass before any money is
spent, closing the gaps its review found: planning now enforces real profile
eligibility, execution actually runs the compiled profile at a pinned provider
version, cell claiming is durable across processes, verdicts are normalized
rows behind review-completeness gates, and the comparison matrix can express
every cell family this spec requires. This section records what is true now
and the deliberate v1 limitations.

### Storage and code

- Tables (migrations 0102 + 0103): `image_identity_pack_trial_runs` (config
  snapshot, status), `image_identity_pack_trial_cells` (spec + result jsonb,
  unique per run/cell key, FK to the output image, durable claim columns
  `claim_token`/`claimed_at`, a `(run_id, status)` execute index),
  `image_identity_pack_trial_grades` (one per run/pair, persisted blind
  mapping, grader), and `image_identity_pack_trial_verdicts` — one row per
  ruling with a UNIQUE `(run_id, profile_id, identity_strategy)`, upserted on
  revision. The run row's old `verdicts_json` array is gone: two simultaneous
  verdict submissions used to be a read-modify-write race that silently
  dropped one; now both land as rows.
- Contracts in `src/contracts/images/identity-pack-trial.ts`; pure expansion,
  pairing, and aggregation in `src/lib/images/identity-pack-trial.ts`
  (including the six checked-in prompt fixtures — two per identity-critical
  task: `variant`, `scene`, `chat_look`); the shared multi-reference role
  compiler in `src/lib/images/identity-reference-prompt.ts`; the profile
  compile step in `src/server/images/render-profile.ts` with control mapping
  in `src/server/ai/image-control-mapping.ts` (both written as the
  capabilities plan's slice-2/4 kernel, for the production render intent to
  adopt); service in `src/server/images/identity-pack-trial.ts`; admin UI at
  Settings → Identity trials.
- Routes, all owner-admin, under `/api/admin/self/identity-packs/trial`:
  create/list at the root, then per run `GET` detail, `POST execute`,
  `GET`/`POST review` (next blinded pair / submit grade), `GET summary`,
  `POST verdict`, and `DELETE` (removes the run and its output images).

### Planning: eligibility, pinning, and the variant axis

- A run expands characters × profiles × fixtures × strategies × pack
  variants, still capped at 96 cells by refusal, never trimming.
- **Eligibility is production's, not a trial-local copy.** A cell only plans
  when `profile.task` matches the fixture's task and
  `imageProfileOffered(profile, model)` passes — the same one judgment the
  normal profile resolution uses: profile enabled, the legacy surface gates
  still in force during the capabilities migration, operation-vs-model
  support, `edit_kind_none`, `identity_too_weak`, and `img2img_identity_task`.
  Anything else refuses `profile_ineligible` before any budget or provider
  involvement.
- **Every cell pins a real provider version.** The pin is the probed version
  id or the slug's own `:version` suffix; a model with neither (or with both
  disagreeing) refuses `version_unpinned` — the old `"unprobed"` floor let a
  cell claim a pin it did not have. Execution posts that exact version to
  Replicate (`POST /predictions {version, input}`) and re-checks the pin
  first; drift is `cell_conflict`.
- **Pack variants are the second comparison axis** (`packVariants` on the
  create request, at most 4): `current` pins whatever revision is current at
  planning; `revision` pins one named revision of one character
  (manual-vs-automatic and old-vs-new crops on the same source); `none` is
  the no-pack baseline — zero identity references, a null strategy, only
  expressible on `generate`-operation profiles because zero-reference
  generation is the one historical behavior reproducible without changing
  other controls. Pinned-revision cells read their revision directly and
  NEVER fall back to the current pack; superseded revisions stay readable
  until the 7-day revision sweep, so cross-revision comparisons must run
  inside that window. Detector-method cells still refuse
  `detector_unavailable` until a reviewed detector ships.
- **Cells describe the compiled request, not the profile row's wishes.** The
  compile step resolves the profile's operation, prompt strategy, control
  defaults (mapped through the model's probed bindings — no binding, no
  send), provider overrides (validated fail-closed against
  `knownInputFields`), negative prompt, per-profile timeout, and the reviewed
  quality merge, then hashes the result. `resolvedControls` on the spec
  records the provider-shaped payload AND `droppedControls` with reasons, so
  nothing enters `resolvedControlsHash` that execution does not send.
  `positivePromptHash`/`negativePromptHash` hash the final compiled text —
  multi-reference cells get numbered role bindings through the shared
  compiler ("Image 1: the canonical identity reference…"), strategy-ordered
  to match send order exactly; single-reference cells stay the bare fixture.

### Execution: durable claims and settlement

- Cell statuses: `planned` → `running` → `rendered` | `failed` | `refused`.
  `running` is a durable database claim (compare-and-set from `planned`,
  stamping a claim token and clock) taken BEFORE the budget charge — so a
  second machine cannot select, charge, and render the same cells; the
  in-process run lock (`run_locked`) remains only as the double-click guard.
- The pass claims up to 1–20 cells in `cellKey` order — the key is
  `character:profile:fixture:strategy:variant`, so plain ascending order
  keeps every arm of one comparison group temporally adjacent (the unseeded
  pairing rule of §"Fixed variables").
- Malformed claimed cells settle terminally BEFORE the charge: an
  unparseable spec is `spec_invalid`, a parseable pre-compile spec is
  `cell_conflict`; both are free, never sent to a provider, and never
  re-charged by later passes.
- The budget is charged for exactly the validly claimed cells; a budget
  refusal releases the claims immediately. Charged slots remain a
  non-refunding reservation.
- Every settle is a compare-and-set on `(id, status='running', claim_token)`.
  A settle that loses (stale-claim takeover, another machine) is `skipped` —
  and if it was carrying a stored output image, that orphan is deleted on the
  spot (`images.identity_pack.trial.output_orphaned`), because nothing would
  ever reference it again. Claim columns stay on terminal rows as the audit
  trail.
- Stale claims (a dead worker's cells) are recovered to `planned` after 20
  minutes — longer than the 15-minute profile-timeout ceiling — with a loud
  diagnostic; recovery can pay a second time for a render whose result died
  with its process, which is the stated trade against wedging the run.
- Before rendering, each cell re-verifies its pinned world: compiled positive
  AND negative prompt hashes, the resolved-controls hash, the provider
  version pin, and the pack identity per variant (`current` via ensure,
  `rev:*` via the read-only revision fetch, `none` skipping packs). Any
  drift refuses `cell_conflict`.
- Outputs go through the normal row-before-file pipeline as hidden
  `identity_trial_output` images; `references_trimmed` renders settle
  `failed` with their output kept for audit and never pair. Result records
  carry the provider prediction id (now propagated through the shared render
  result), latency, and stored dimensions; `moderationOutcome` and `postCrop`
  are explicitly null because the Replicate adapter exposes neither, and
  `requestedSeed` stays null until seed transport exists.

### Blinding, grading, verdicts, and completion

- Pairs differ in exactly ONE identity-reference variable within
  (character, fixture, profile): same variant/different strategy, same
  strategy/different variant, or pack-vs-baseline. A pair differing in both
  is a confound and is never built. Left/right blinding is unchanged
  (derived parity, persisted on the grade row at submission).
- Verdicts are per (profile, strategy) rows. Recording one requires the run
  to be in `review` (or revising while `complete`), no cell `planned` or
  `running`, and — unless the submission carries an explicit
  `overrideIncompleteReview` — every reviewable pair already graded; refusals
  are `review_incomplete`. The override is persisted on the verdict row and
  surfaced in the summary as "decided on incomplete review", never silent.
- A run becomes `complete` only when every rendered (profile, strategy)
  combination has a ruling AND every reviewable pair is graded. Verdict slots
  report their pair coverage (`totalPairs`/`gradedPairs`), so a ruling whose
  counterpart cells all failed is visibly a ruling without pairwise evidence.
  The no-pack baseline is evidence, not a verdict slot.

### Recorded v1 limitations

- **No seed transport.** The registry's models declare no seed input; seed
  plumbing belongs to the image-model-capabilities plan. Cells record
  `requestedSeed: null`, and paired runs rely on the temporal adjacency the
  execution order now guarantees per group.
- **No cost field beyond latency.** No render-unit system exists; spend is
  bounded by the daily image budget counters only.
- **No moderation or post-crop observability.** The provider adapter exposes
  neither a structured moderation outcome nor crop geometry; both fields stay
  explicitly null rather than fabricated. Content rejections still classify
  into `failureCode: content_rejection`.
- **Detector-vs-heuristic cells are unbuildable** until a detector is chosen
  (an owner privacy decision) — the variant axis can express them, but
  detector-method revisions refuse `detector_unavailable` rather than faking
  a method.
- **`IMAGE_IDENTITY_PACK_REFERENCES` stays off and untouched.** The
  integration spec explicitly allows packs to be created, inspected, and
  trialed while the flag is off; the trial does not gate on it.
- **`IDENTITY_PACK_TRIAL_CORPORA` remains empty.** Runs accept explicit
  character ids; a named corpus can be registered once the owner builds the
  corpus characters.
