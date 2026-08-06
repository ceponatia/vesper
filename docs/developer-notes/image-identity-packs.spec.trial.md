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
