# Image lane consolidation — visual-state selection and provenance

Status: companion to [image-lane-consolidation.plan.md](image-lane-consolidation.plan.md)

This spec owns the application adapter from the lane-neutral visual-state
snapshot to character-bearing image requests. The visual-state plan owns the
snapshot and selection primitives; this spec owns only their image-lane use.

## Implementation status

- Stage 2 contracts: largely built 2026-08-16 under the visual-state plan —
  `VisualImageDigest` / `VisualImageFact` / `VisualImageProvenance` in
  `apps/web/src/contracts/images/visual-digest.ts` realize this spec's
  `ImageVisualDigest` / `ImageVisualFact` / `ImageVisualProvenance` sketch
  (names follow visual-state conventions, as §Contract allows). Remaining for
  Stage 2: the server-side assembly that feeds a live snapshot in and persists
  provenance, and route consumption.
- Avatar and scene consumers: remaining.
- Visual provenance persistence: remaining.

## Ownership boundary

`apps/web` owns the adapter because it understands character, garment, anatomy,
scene, camera, and visual-state contracts. `@vesper/image-core` receives only
provider-neutral render intent, semantic prompt segments, role-aware references,
and compact opaque provenance supplied by the app.

The adapter is a projection. It must not write canonical state, update observer
memory, or persist another copy of all feature values.

## Contract

The concrete names may follow existing visual-state conventions, but the
boundary must express this information:

```ts
interface ImageVisualDigest {
  snapshot: {
    fingerprint: string;
    sourceVersion: string;
    committedCut: string;
  };
  subjects: ImageVisualSubject[];
  selected: ImageVisualSelection[];
  suppressions: ImageVisualSuppression[];
}

interface ImageVisualSubject {
  subjectId: string;
  displayName: string;
  required: {
    identity: ImageVisualFact[];
    morphology: ImageVisualFact[];
    apparentAge: ImageVisualFact[];
    wardrobe: ImageVisualFact[];
    exposure: ImageVisualFact[];
  };
  optional: {
    presentation: ImageVisualFact[];
    currentState: ImageVisualFact[];
    bodyLanguage: ImageVisualFact[];
  };
}

interface ImageVisualFact {
  featureKey: string;
  truthFingerprint: string;
  kind: string;
  locus?: string;
  value: unknown;
  source: {
    owner: string;
    version?: string;
  };
  visibility: {
    tier: "identity_required" | "camera_visible";
    evidence: string[];
  };
  priority: number;
}

interface ImageVisualSelection {
  featureKey: string;
  required: boolean;
  segmentKind: string;
}

interface ImageVisualSuppression {
  featureKey?: string;
  reason:
    | "covered"
    | "outside_frame"
    | "occluded"
    | "unavailable"
    | "nonvisual"
    | "unsupported_owner"
    | "optional_budget";
}
```

Use repository fixed-point and deterministic comparison conventions. Do not
introduce locale-dependent ordering or change the frozen
`ProjectedFeatureTruth` key/fingerprint shapes.

## Required selection

For every rendered subject, select all applicable facts for:

- stable identity anchors;
- intended morphology and authored absences;
- apparent age;
- authoritative visible wardrobe;
- exposure/coverage;
- subject identity and subject count.

The requested operation/action belongs to render intent and is mandatory, but
is not a visual-state truth.

A required fact may be suppressed only because it is genuinely inapplicable or
unavailable. Prompt fitting cannot demote it to optional.

## Optional selection

Optional presentation, current-state, and proved body-language facts are
camera-relative. They may be omitted for distance, angle, frame, occlusion, or
profile budget. They never use narrator mention cooldown and never update
observer visual memory.

No emotion may be inferred from posture. No prose, biography, narrator output,
or semantic memory may be parsed into current truth.

## Exposure and wardrobe

Consume the canonical garment coverage/readout and visual-state composition.
Do not recompute exposure independently inside avatar, scene, edit, or chat-image
routes. A garment fact appears once in the digest even when the source owner can
provide both a structural read and a scene note.

Covered anatomy is not emitted as optional detail. Identity anchors needed to
preserve a person may remain mandatory without being phrased as visible anatomy;
the prompt compiler owns that distinction.

## Viewer and point of view

An embodied viewer is a subject only for body regions in frame. Resolve those
regions through the same camera-aware adapter; do not pass raw player attributes
to a later prompt formatter.

Camera visibility and observer awareness remain separate. An image render does
not notice a feature on behalf of the player.

## Determinism and restore

The digest is pure over a committed snapshot/cut plus camera and render task.
The same inputs produce byte-equal ordering, keys, fingerprints, and selection.

Retake and branch tests must prove that later state, later wardrobe, and later
knowledge do not leak backward.

## Provenance

Keep package render provenance in `meta.render`. Store app-owned visual
provenance as a sibling, conceptually `meta.visualState`:

```ts
interface ImageVisualProvenance {
  snapshotFingerprint: string;
  sourceVersion: string;
  committedCut: string;
  subjects: Array<{
    subjectId: string;
    selected: Array<{
      featureKey: string;
      truthFingerprint: string;
      required: boolean;
      segmentKind: string;
    }>;
  }>;
  cameraFingerprint: string;
  suppressions: Array<{
    featureKey?: string;
    reason: string;
  }>;
}
```

Persist identifiers and fingerprints, not a second full copy of visual values.
Success and failure records must retain enough information to explain what was
selected before provider execution.

If the image metadata shape requires a migration or parser change, follow the
repository's resilience rules and degrade old rows to absent visual provenance,
not fabricated provenance.

## Diagnostics

Diagnostics must distinguish at least:

- required owner unavailable;
- required fact inapplicable;
- optional fact suppressed by camera;
- optional fact dropped by budget;
- duplicate feature key;
- conflicting required facts;
- nonvisual fact rejected;
- later-cut input rejected.

Names follow the existing visual-state/image diagnostic namespace. A degraded
path returns conservative silence for the affected fact and preserves the rest
of the digest.

## Fixtures and tests

Cover:

- sparse and heavily authored humans;
- non-human intentional appendage count;
- absent, altered, and prosthetic anatomy;
- realistic and stylized presentation;
- covered and newly exposed regions;
- wet hair and garment wetness;
- rolled/displaced garment;
- garment left at a scene locus;
- body-language change proven by scene relations;
- embodied viewer with partial frame;
- dim/distant/occluded optional detail;
- retake and branch restore;
- missing owner and malformed source input.

Tests assert selection and provenance, not model prose.
