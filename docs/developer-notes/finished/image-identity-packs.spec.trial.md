# Image identity packs — trial and promotion spec

Status: detail for [image-identity-packs.spec.md](image-identity-packs.spec.md)
— the paid trial itself was waived by owner ruling (2026-08-13; recorded in
the plan's slice 6): the harness below is built and remains available, but no
run executed and no verdict rows exist.

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

## Implementation (built 2026-08-06; hardened through 2026-08-07)

The harness above is implemented; no paid cell has run and no verdict exists.
The first build (PR 60) was followed by two pre-spend correctness rounds, closing
the gaps their reviews found. The first: planning enforces real profile
eligibility, execution runs the compiled profile at a pinned provider version,
cell claiming is durable across processes, verdicts are normalized rows behind
review-completeness gates, and the comparison matrix can express every cell
family this spec requires. The second (PR 61 review response, 2026-08-07): the
profile's prompt strategy is dispatched or fails closed, the durable claim
became a queue-wide heartbeat, and the degraded-evidence override is reachable
from the summary. This section records what is true now and the deliberate v1
limitations.

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
- Contracts in `packages/image-core/src/identity/identity-pack-trial.ts`; pure expansion,
  pairing, and aggregation in `packages/image-core/src/identity/identity-pack-trial-planning.ts`
  (including the six checked-in prompt fixtures — two per identity-critical
  task: `variant`, `scene`, `chat_look`); the shared multi-reference role
  compiler in `packages/image-core/src/references/identity-reference-prompt.ts`; the profile
  compile step in `src/server/images/render-profile.ts` with control mapping
  in `packages/image-core/src/capabilities/image-control-mapping.ts` (both written as the
  capabilities plan's slice-2/4 kernel, for the production render intent to
  adopt); service in `src/server/images/identity-pack-trial-*.ts`; admin UI at
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
  Replicate (`POST /predictions {version, input}`), re-checks the pin first,
  and compares the prediction's own version echo after the render (a mismatch
  settles `failed`/`version_mismatch`); planning-time drift is
  `cell_conflict`. Two echoes are **not** mismatches: silence, and the literal
  `"hidden"` an official model answers, which is non-disclosure rather than a
  disagreeing version — such a run's identity is the requested pin, which
  Replicate validated at create time (owner ruling 2026-08-11,
  [qwen-advanced-image-subsystem.spec.md](qwen-advanced-image-subsystem.spec.md)).
  Both readings live in `providerVersionsDisagree`
  (`packages/image-core/src/models/image-models.ts`). **Operator note:** the seeded built-in models carry no
  probed version, so a fresh registry plans nothing until each model is
  re-probed once (the admin model page's reprobe action) — that is a
  deliberate refusal, not a bug.
- **Two-role strategies refuse when the face detail cannot resolve.** A
  `canonical_then_face_detail` cell whose pack cannot supply the face-detail
  role would render byte-identically to `canonical_only`; it refuses
  `profile_ineligible` instead of silently becoming a degenerate duplicate
  arm, and the pairing rule independently refuses to pair two arms whose
  compiled role lists are identical.
- **The profile's `promptStrategy` is EXECUTED, or the cell fails closed.**
  The compile step dispatches on it through an exhaustive switch — the seed
  of the code registry image-model-capabilities.spec.md §"Prompt strategies"
  calls for. `instruction_edit` and `text_to_image_description` add the
  numbered bindings only when two or more references need disambiguating;
  `multi_reference_compose` names every reference from one upward, which is
  what makes it a genuinely different compiled prompt rather than the same
  text under a second name. `text_repair`, `example_transform`,
  `style_render` and `coherent_set` refuse: each needs a contract the
  identity-reference vocabulary does not carry (a text region and its
  replacement, a before/after role pair, style and LoRA language, the ordered
  image-set path). Planning records `profile_ineligible` naming the strategy
  and spends nothing; meeting one at execution means the profile row moved
  under the cell, so that is `cell_conflict`.
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
  numbered role bindings come from the shared compiler ("Image 1: the
  canonical identity reference…"), strategy-ordered to match send order
  exactly. Which cells get them is the prompt strategy's decision (above):
  two or more references always, a single reference only under
  `multi_reference_compose`, and the zero-reference baseline never.

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
- **The claim is a heartbeat over the WHOLE REMAINING QUEUE, re-stamped at
  every cell boundary** — the head cell plus every cell still waiting behind
  it. A pass claims and charges its whole batch up front, so without this a
  queued cell wore the batch-start timestamp and could age into recovery on
  QUEUE POSITION alone, while the pass holding it was alive and about to
  render it. With it, a live pass's oldest claim is one cell span old, so
  staleness measures pass death rather than queue depth. A queued cell the
  heartbeat does not get back has been taken over: it is recorded `skipped`
  with zero provider calls and never settled, because the row belongs to
  whoever took it.
- Stale claims (a dead worker's cells) are recovered to `planned` after 26
  minutes — the 15-minute profile-timeout ceiling plus the per-call deadlines,
  the output download, and margin for the rest of one cell span — with a loud
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
  (character, fixture, profile): same variant/different strategy, or same
  strategy/different variant. A pair differing in both is a confound and is
  never built; cross-variant pairs additionally require the SAME source
  content hash (a revision pinned from before a portrait change compares a
  different photograph, not a different crop, and does not pair), and two
  arms whose compiled role lists are identical never pair. The no-pack
  baseline is the one deliberate exception: it pairs against each pack arm
  of its group as a labeled baseline comparison — the bucket names the exact
  pack arm, so nothing aggregates across arms. Left/right blinding is
  unchanged (derived parity, persisted on the grade row at submission).
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
  The no-pack baseline is evidence, not a verdict slot. Degraded evidence
  wedges rather than completes: a rendered cell whose output image is gone or
  whose stored spec no longer parses keeps the run in `review` (and makes
  verdicts review-incomplete, override-able but recorded) — completion is the
  claim that the blinded procedure ran, and evidence that no longer exists
  cannot support it. The summary wire carries that count as `degradedCells`,
  read from the SAME derivation the verdict gate refuses on, because
  degradation REMOVES the affected pair: every count the client can still see
  reads complete precisely when the server will refuse, so the client needs
  the number to offer the override rather than surface a bare refusal.
  Grading the final pair settles the run without needing another verdict
  write. Same-slot verdict revisions are last-write-wins on the one ledger
  row.

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
- **No profile-level face-detail-only support signal exists yet.** The
  reviewed `referencePolicy.allowedRoles` floor is honored where a policy is
  reviewed (a profile whose policy excludes identity references refuses), but
  nothing distinguishes "this profile's prompt strategy supports a
  face-detail-only reference" — that gating belongs to the capabilities
  plan's strategy threading. Until then the run author chooses strategies
  deliberately on this admin-only surface.
- **The no-pack baseline currently has no runnable profile.** It requires a
  `generate`-operation identity-critical profile, and every seeded
  variant/scene/chat_look profile is `edit`-operation; the admin creates a
  generate-operation profile when the baseline arm is wanted. The refusal
  message says exactly that.
- **The trial never gated on render-lane sending.** It was designed to run
  with the rollout flag off, and the flag's later removal (slice 7 — pack
  consumption is now unconditional) changes nothing here: packs are created,
  inspected, and trialed independently of what production lanes send.
- **`IDENTITY_PACK_TRIAL_CORPORA` remains empty.** Runs accept explicit
  character ids; a named corpus can be registered once the owner builds the
  corpus characters.
