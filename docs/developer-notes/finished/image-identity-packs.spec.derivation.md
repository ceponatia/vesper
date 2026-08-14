# Image identity packs — derivation and quality spec

Status: detail for [image-identity-packs.spec.md](image-identity-packs.spec.md)

This document owns `ensureIdentityPack`, concurrency, detector interpretation,
crop geometry, image encoding, intrinsic quality measurements, policy evaluation,
manual correction, and retry behavior.

## `ensureIdentityPack`

The server entry point is idempotent and authorization-aware:

```ts
export type EnsureIdentityPackResult =
  | {
      status: "ready";
      pack: ImageIdentityPackV1;
      warnings: ImageIdentityPackWarningCode[];
    }
  | {
      status: "blocked";
      pack: ImageIdentityPackV1 | null;
      code: ImageIdentityPackFailureCode;
      retryable: boolean;
    };

export interface EnsureIdentityPackInput {
  ownerId: string;
  characterId: string;
  purpose: "background" | "identity_render" | "admin_trial";
  sink?: DiagnosticSink;
}
```

Flow:

1. Resolve and authorize the character and current canonical source.
2. Read and hash the source bytes.
3. Return the current ready revision when source hash and derivation version match.
4. Return the matching current unusable revision when no retry condition changed.
5. Coalesce with an existing matching `pending` revision — join it, never open a
   second one beside it.
6. Otherwise create a new current `pending` revision and mark the previous current
   revision stale or superseded as appropriate.
7. Derive outside the promotion transaction.
8. Finalize only if the character still points at the same source and the pending
   revision is still current.
9. If finalization loses the race, mark the revision stale and hard-delete its
   hidden crop.

Within one process, matching calls use a single-flight promise keyed by character
id, source hash, schema version, and derivation version. The database current-row
constraint remains the cross-process authority.

An identity render waits only for bounded local derivation. It does not call an
image provider while a pack is unresolved. A background caller may return after
reserving work, but status inspection must expose `pending` explicitly.

### Cross-process coalescing (as built 2026-08-06)

An in-process lock on one Fly machine proves nothing about another, so step 5's
decision is made where it can be trusted: inside `reservePendingRevision`'s
advisory-lock transaction, on the one read of the current row that no concurrent
writer can move underneath it. A pre-reserve read of the current row catches the
common case more cheaply, but only the in-transaction decision can see a
reservation that was inserted after that read — which is exactly the interleaving
that used to produce two derivations of one portrait.

Three cases for a current `pending` row:

- **A live matching reservation** — same character, same source image id, same
  source content hash, same schema and derivation versions, and younger than
  `JOB_STALE_MS` (the same fifteen minutes the job dedupe and the cleanup sweep
  presume a process dead by) — is NOT retired. Reservation returns an `in_flight`
  result naming that row.
- **A reservation past that bound** belonged to a process that is gone. Retired
  `stale`; reservation proceeds.
- **A reservation for a different source or different versions** describes a
  portrait the character no longer has. Retired `stale`; reservation proceeds. The
  loser's own finalize compare-and-set refuses its write and `abandonRevision`
  hard-deletes its crop, which is the correct outcome there and stays.

Retiring a live matching reservation is the defect this replaces. It is a legal
write and the one-current index does not catch it: the loser then fails its
finalize compare-and-set, its freshly encoded crop is deleted, and two machines
have run one character's detector and two `sharp` passes to produce one rectangle.

**Joining.** A caller told `in_flight` holds no DATABASE transaction while it
waits — a transaction held open across somebody else's detector run would trade a
duplicate crop for a held row lock, which is worse. It does still hold the
in-process character key, which is why the join has its own five-second budget
rather than sharing the 30-second acquisition window: every second a join waits
is a second other local callers of the same character queue behind it, and five
seconds already covers any real derivation. It polls the character's current row
every 250ms until the reservation settles (the same row is no longer `pending`,
or something replaced it, or no current row remains). It then answers through
the ordinary current-revision path — `answerFromCurrent` and
`projectIdentityPackPolicy` — so a joined answer and a first-hand one cannot
disagree about a verdict.

- `identity_render` and `admin_trial` join: somebody is waiting for the answer.
- `background` does not. It returns `blocked` / `derivation_failed` / retryable
  with the `pending_conflict` diagnostic, promptly, and without starting a
  duplicate derivation on the way there. Its caller — the preparation job — treats
  that as a stop rather than something to poll: a live reservation for the
  character's canonical pointer means another process is already producing the
  answer (spec.lifecycle.md §"Convergence"). The job converges on the pointer, not
  on any particular reservation.
- A caller that forced a new revision (reset-to-automatic, an admin regenerate)
  waits but does not answer from what settled: the revision it waited for is
  precisely what it was asked to replace. Waiting is still right — not clobbering a
  live derivation is the whole point. A forced caller whose join TIMES OUT is the
  one exception to "never retire a live matching reservation": it re-enters with
  leave to reclaim the reservation, because an explicit human act to regenerate is
  the operator's escape hatch from a wedged row, and without it a reservation
  orphaned by a deploy would dead-end the reset button until the fifteen-minute
  staleness bound elapsed. A remote derivation slower than the join budget can
  lose to it; its finalize compare-and-set refuses the write and its crop is
  cleaned, exactly as when the source moves on. That leave is bound to the row it
  waited on, by id, and covers no other: two forced callers can time out on the
  same wedged reservation, and the second one — arriving to find the first's
  brand-new reservation standing there — joins it or is told busy like anybody
  else, because clobbering it is the very failure the wait exists to prevent.

**Bounded, never a loop.** If what settled does not answer the caller — retired,
replaced, or itself settled into another reservation — the caller re-enters the
normal flow exactly once. A second consecutive `in_flight` degrades to `blocked` /
`derivation_failed` / retryable with the same `pending_conflict` diagnostic. Two
passes, never more.

`saveManualIdentityCrop` shares the reservation path and therefore the ruling: a
live reservation returns the existing `busy` conflict, which the editor already
handles as "reload and retry". It never retires one. A save that happens a second
later costs nobody anything; deleting a crop somebody is mid-way through producing
does.

## Detector contract

The detector adapter returns observations without making product decisions:

```ts
export interface DetectedFaceCandidate {
  box: SourcePixelCrop;
  confidence: number;
  landmarks?: {
    leftEye?: { x: number; y: number };
    rightEye?: { x: number; y: number };
    mouth?: { x: number; y: number };
  };
  occlusionScore?: number;
}

export interface IdentityFaceDetector {
  version: string;
  detect(image: Buffer): Promise<DetectedFaceCandidate[]>;
}
```

The first implementation uses a local detector adapter. It must not upload the
canonical portrait to an unreviewed third-party face-analysis service.

Detector selection remains replaceable. The fixed corpus determines whether the
chosen adapter is good enough; the pack contract does not depend on one library.

### V1 implementation ruling (2026-08-06)

The shipped adapter is `nullIdentityFaceDetector` (`version: "null_v1"`,
`packages/image-core/src/identity/identity-pack-detector.ts`): a real seam whose `detect()`
returns no observations. Automatic derivation therefore runs the labelled
conservative heuristic only — a portrait-shaped canonical source gets the
`heuristic_v1` crop, every other shape fails closed with `no_usable_face` — while
the detector-crop, candidate-floor and multi-face refusal paths are exercised
against injected detectors in tests (`setIdentityFaceDetectorForTesting`).
Selecting a real local detector library is deferred to the trial slice (slice 6)
and remains a privacy-reviewed decision, not a configuration flip.

## Candidate ruling

- Exactly one candidate above the reviewed confidence floor may produce a
  detector crop.
- More than one plausible candidate produces `ambiguous_faces`.
- Zero accepted candidates may use the heuristic only when the image is the
  current canonical character portrait, has portrait-like dimensions, and no
  metadata contradicts a single-subject portrait.
- Otherwise the result is `no_usable_face` and requires manual correction or a
  clearer source.

The service never chooses the largest face, centre face, or highest-confidence
face from a multi-person result without user action.

A low-confidence second face still matters when it is plausible enough to make
identity ambiguous. The candidate policy therefore has separate confidence floors
for “usable primary face” and “possible additional face.” Both are versioned.

## Crop geometry

Detector crop geometry is controlled by a versioned pure policy. It expands the
face candidate to preserve:

- the full hairline;
- both ears when visible;
- the complete jaw and chin;
- limited neck and shoulder context;
- enough edge padding to survive provider resizing.

The expansion creates a square crop, shifts it only through explicit policy
values, clamps it to the source, and records lost requested padding. A crop that
can only be satisfied by clipping load-bearing boundaries becomes unusable rather
than silently accepted.

The policy object contains the horizontal expansion, vertical expansion,
vertical-centre shift, minimum output size, maximum stored output size, and
acceptable lost-padding fractions. Those constants are not scattered through a
route or detector adapter.

### Initial heuristic

The fallback is deterministic:

1. choose a square whose side is the source width for a normal portrait image, or
   the smaller source dimension otherwise;
2. centre it horizontally;
3. place it within the upper portion of the portrait using the versioned
   `heuristic_v1` vertical offset;
4. clamp to source bounds;
5. label it `heuristic` and attach the `heuristic_crop` warning.

The exact offset is pinned by golden geometry tests. Tuning it increments the
derivation version.

The heuristic is not accepted merely because it produced legal coordinates. It
still passes intrinsic quality and profile evaluation. A portrait-like shape is
an eligibility precondition, not proof that the face is inside the crop.

## Crop encoding

The crop is extracted with `sharp` under the same decode limits used by normal
image storage. It is:

- square;
- downscaled only when its longest side exceeds the reviewed storage ceiling;
- never enlarged merely to look higher resolution;
- encoded through the normal WebP write path;
- stripped of source metadata;
- stored with actual output dimensions.

The storage ceiling belongs to the derivation policy, not provider behavior.
Provider adapters may resize the crop again for their effective reference input.

The image row is reserved only after crop geometry is valid. A write failure marks
the hidden image row failed and finalizes the pack revision with
`crop_write_failed`; it does not leave a ready pack with a missing file.

## Intrinsic quality measurement

The pack records measurements even when the current policy accepts the crop. This
allows threshold changes to re-evaluate old packs without rerunning every detector.

V1 measures when available:

- detected face count;
- detector face box;
- face width and height in source pixels;
- face area as a fraction of the crop;
- crop dimensions;
- padding between the face box and crop edges;
- blur score with an algorithm/version label;
- occlusion score from the detector when supported;
- detector confidence.

A missing optional metric is `null`, not zero. Zero is a real measurement.

Blur measurement uses a deterministic local algorithm. Its raw score is meaningful
only with the stored algorithm version; warning thresholds belong to policy.

`quality.accepted` is not persisted as eternal truth. Read code evaluates stored
measurements against the named policy version and returns current blockers and
warnings.

Implemented as `projectIdentityPackPolicy` (`server/images/identity-pack-*.ts`),
one helper shared by all three read seams — `ensureIdentityPack`'s current-ready
reuse path, `getIdentityPackForOwner`, and `evaluateIdentityPackForProfile` — so
the ensure result, the owner summary and the render seam cannot disagree after a
policy bump. Two rulings the section above leaves open:

- **It is a projection, not a repair.** A revision stamped with an older
  `policyVersion` is re-judged for READERS; its row keeps the status, warnings
  and code it was finalized with, because the row is the historical claim admin
  history exists to show. A re-judged block therefore reaches the caller as
  `blocked` (non-retryable — only a policy or source change can move it) over a
  row that still reads `ready`.
- **Warnings split by origin.** `heuristic_crop` and `manual_admin_override`
  record how the crop was AUTHORED and survive a re-judgment unchanged;
  everything else is a verdict recomputed from the stored measurements. The
  projected contract also carries the policy version that produced the verdict,
  since render provenance copies that field verbatim.
- **A revision with no source is refused ahead of any threshold.** A `ready` or
  `pending` revision whose `source.imageId` is null is projected as `unusable`
  with `source_missing` and a warn diagnostic. It sits in this function rather
  than in each caller precisely because all three seams pass through here: the
  deletion paths retire such a row before the source row goes, and this is what
  makes that ordering a convenience rather than the only defence
  (spec.lifecycle.md §"Source deletion"). Still a projection — the row is not
  rewritten from a read path.

Only `ready` revisions are projected. A LOOSENED policy cannot promote a stored
`unusable` one — a refused revision has no crop bytes to hand anybody — so that
direction is a re-derivation, not a read-time verdict.

## Versioned reference policy

The pure policy has intrinsic and profile layers:

```ts
export interface IdentityPackIntrinsicPolicy {
  version: string;
  detectorConfidenceFloor: number;
  possibleAdditionalFaceFloor: number;
  minimumCropWidthPx: number;
  minimumCropHeightPx: number;
  blurWarningThreshold: number | null;
  blurBlockThreshold: number | null;
  occlusionWarningThreshold: number | null;
  occlusionBlockThreshold: number | null;
  minimumBoundaryPaddingPx: number;
}

export interface IdentityPackProfilePolicy {
  minimumEffectiveFaceWidthPx: number;
  minimumEffectiveFaceHeightPx: number;
  allowHeuristic: boolean;
  allowAdminOverride: boolean;
}
```

Numeric values are established by the fixed trial corpus and checked into a
versioned policy module. They are not database columns or provider-schema facts.

### Effective provider size

A render-profile evaluation receives the model's actual reference resize behavior
when known. It scales the stored face box into the effective provider input and
checks minimum face dimensions there.

When resize behavior is unknown, the profile remains conservative and may warn or
refuse the optional face-detail role. The evaluator does not assume that uploading
a 1024-pixel file means the model sees 1024 pixels.

The evaluation records:

- source crop dimensions;
- provider effective reference dimensions;
- effective face width and height;
- policy version;
- blockers and warnings.

This evidence travels into render provenance when a candidate is selected.

## Manual crop revisions

The client submits normalized crop coordinates and the current pack id/revision.
The server:

1. re-authorizes the character;
2. verifies the pack is still current and the source hash still matches;
3. resolves normalized coordinates to integer source pixels;
4. validates bounds, minimum size, and square aspect;
5. re-runs intrinsic measurements on the proposed crop;
6. creates a hidden crop image;
7. creates a new `manual` revision;
8. atomically promotes it and supersedes the previous revision.

A stale editor save returns a conflict and reloads the current source; it never
applies old coordinates to new bytes. A save that meets another process's live
reservation returns the same shape of conflict (`busy`) rather than retiring it —
see §"Cross-process coalescing".

Character-owner corrections may not bypass hard source, bounds, or minimum-geometry
checks. A user crop that is still intrinsically unusable is rejected with the
measured reason.

Admins may override reviewed blur, occlusion, or effective-size policy for a trial
or support case, but the revision records:

- admin actor id;
- reason;
- `manual_admin_override` warning;
- original blockers;
- policy version.

The override does not change the underlying measurements.

### Reset to automatic

Reset does not resurrect an old detector revision blindly. It runs the current
derivation version against the current source and creates a new automatic
revision. The old manual revision becomes superseded but remains in history until
normal cleanup.

## Retry policy

Retryable failures are file-read, decode, detector-runtime, and local image-write
failures. Ambiguous faces, invalid manual geometry, and a known-small source are
not retried until the source, policy, detector version, or user crop changes.

A retry creates a new revision after bounded backoff. It does not reset a terminal
row or spin on every render request.

Backoff state may live in the existing jobs machinery or the pack row's failure
metadata, but the service exposes one result contract either way. The choice must
not create two independent retry schedulers.

**As built (2026-08-06):** backoff state is derived from the revision rows
themselves — the number of revisions for these source bytes under these versions
is the attempt count, and the newest row's `updated_at` is the last attempt's
clock — so no metadata blob and no second scheduler exist (60s doubling to a
one-hour ceiling, five attempts per set of source bytes). `EnsureIdentityPackResult`
stays the two-variant `ready` | `blocked` union: derivation is bounded local work
that every caller waits out, and `pending` — a revision reserved by another
process — is surfaced by the summary read rather than by this result. A waiting
caller that meets one of those reservations is not handed it either; it joins the
reservation and answers from what that derivation settles on (§"Cross-process
coalescing"). Joining is not an attempt: it opens no revision, so it neither
consumes the retry budget nor advances the backoff clock.

## Derivation diagnostics

Expected diagnostic codes include:

```text
images.identity_pack.source_missing
images.identity_pack.source_changed
images.identity_pack.pending_conflict
images.identity_pack.no_usable_face
images.identity_pack.ambiguous_faces
images.identity_pack.invalid_crop
images.identity_pack.crop_too_small
images.identity_pack.crop_write_failed
images.identity_pack.finalize_race
```

Expected unusable references are warnings, not unhandled server errors. Detector
or metric exceptions are converted into a failed pack revision and diagnostic.

## Derivation tests

Pure tests cover:

- crop normalization and source-pixel conversion;
- detector expansion, clamping, and lost-padding reporting;
- deterministic heuristic geometry across portrait and unusual ratios;
- candidate ambiguity floors;
- zero-preserving metric parsing;
- threshold and warning evaluation;
- effective provider resize calculations;
- stale-hash decisions;
- status-transition exhaustiveness.

Golden fixtures pin every versioned crop policy. Changing expected boxes requires
a deliberate derivation-version bump.

Server integration tests cover:

- row-before-file crop creation;
- canonical portrait success when pack generation fails;
- concurrent `ensure` coalescing, in-process (the keyed lock) and across
  processes. The cross-process cases drive contenders through
  `deriveIdentityPackWithoutProcessLockForTesting`, a narrow test-only entry that
  skips the in-process key and nothing else — without it a `Promise.all` is
  serialized before it reaches the database and proves only that the lock works.
  Pinned: two contenders over identical bytes produce one `detect()` call, one
  settled revision, one crop and no duplicate; a `background` contender is refused
  promptly without a second `detect()`; a reservation met inside the reserve
  transaction (a forced re-derivation) is waited out rather than retired; a
  forced re-derivation whose join times out reclaims the wedged reservation and
  the displaced holder loses its finalize, while a replacement reservation that
  took the wedged row's place is refused rather than reclaimed; a reservation
  older than `JOB_STALE_MS` is retired and re-derived;
- source change during derivation;
- finalization-race cleanup;
- detector, heuristic, and manual methods;
- manual revision and stale-editor conflict;
- retryable versus non-retryable failures;
- malformed measurement degradation and diagnostics.
