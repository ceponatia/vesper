# Image identity packs — durable references that preserve a character's face

Status: active (slices 1–4 and 5A shipped 2026-08-06; slice 6's trial harness
shipped 2026-08-06 and was hardened through 2026-08-07; slice 5B, the trial run
itself, and slice 7 remain)

Outcome: A player can recognize the same character's face in every image Vesper
makes of them, so that a newly generated picture stops looking like a different
person.

Technical companion: [image-identity-packs.spec.md](image-identity-packs.spec.md)

Related plans:

- [image-render-quality.plan.md](image-render-quality.plan.md) owns model-native
  prompting, quality settings, face-fidelity trials, repair, and output review;
- [image-model-capabilities.plan.md](image-model-capabilities.plan.md) owns
  role-aware reference capacity, profile eligibility, and the shared render
  intent that transports identity references to providers;
- [spatial-scene-images.plan.md](spatial-scene-images.plan.md) may later consume
  identity packs alongside pose, depth, and mask controls;
- [data-lifecycle.plan.md](data-lifecycle.plan.md) owns the broader image
  retention policy. This plan adds a narrower rule for hidden derived identity
  assets.

## Why this is an independent system

A canonical portrait and a face-detail crop are not merely two convenient image
files. They form a reusable, versioned identity reference with their own creation,
quality, invalidation, authorization, correction, and deletion rules.

Leaving that work inside the render-quality plan would make every image lane solve
it differently. One lane would crop at request time, another would trust a stale
file, and a third would silently use an unsuitable gallery image. The quality of
a provider prompt would then depend on whichever accidental crop implementation
ran first.

An identity pack makes the reference itself an owned product surface. Image
models consume a reviewed pack; they do not improvise one.

## Product outcome

When a character has a canonical portrait, Vesper can prepare a stable identity
pack that includes:

- the canonical portrait as the broad identity source;
- one tight face-detail crop derived from that portrait;
- the exact source and crop provenance;
- quality measurements and an eligibility verdict;
- warnings that explain why a pack is degraded or unusable;
- a manual correction path when automatic derivation is wrong.

An identity-critical render can then know, before spending provider money,
whether it has a usable identity reference and which image roles are available.

## Scope

This plan owns:

- durable identity-pack records;
- the hidden derived face-crop asset;
- source hashing and staleness detection;
- deterministic crop derivation;
- detector, heuristic, and manual-crop provenance;
- intrinsic reference-quality measurements;
- profile-aware eligibility checks before a provider call;
- lazy backfill for existing characters;
- manual review and correction;
- copy, publish, deletion, and cleanup behavior;
- pack-level diagnostics, audit, and render provenance.

This plan does not own:

- the character's authored facial attributes or broader visual-state contract;
- current clothing, pose, condition, visibility, or visual attention;
- image-model selection and reference-capacity rules;
- provider prompt wording;
- face-similarity scoring on generated outputs;
- face-repair model choice or masked repair;
- general gallery retention;
- arbitrary training sets, LoRAs, or embeddings built from a character's images.

Those systems may consume the pack, but they may not mutate its source truth.

## Settled v1 rulings

### The current canonical portrait is the source of truth

V1 has one active identity pack per character, derived from the character's
current canonical portrait. Gallery images, scene images, variants, and old
avatars are never silently substituted.

Changing the canonical portrait makes the previous pack stale immediately. A new
pack is derived from the new source. The old source image remains subject to the
normal Gallery policy; the operational pack no longer treats it as current.

V1 does not attempt to merge several camera angles into a synthetic identity.
Additional canonical views may become additive pack roles later, but they cannot
weaken the one-current-source invariant.

### The face crop is a hidden derived asset

The face-detail crop is stored through the normal image asset pipeline so it gets
row-before-file behavior, normalized WebP storage, authorization, and resilient
reads. It is marked as an internal identity asset and does not appear in the
Gallery, character image picker, public library, or ordinary image APIs.

It points back to the canonical source image and the identity-pack revision that
created it.

### Derivation is persistent, not repeated per render

A crop is created once for a particular source hash and derivation version. Every
later render reuses that reviewed asset until the source changes or the pack is
superseded.

Render-time cropping is only a degraded compatibility fallback during rollout.
It must carry a diagnostic and may not masquerade as a reviewed pack.

### Automatic derivation never guesses between people

When a detector finds more than one plausible face, Vesper does not pick the
largest or most central face. The pack is unusable until the character owner or
an admin selects the correct crop or supplies a clearer canonical portrait.

When no detector result is available, a deterministic upper-centre portrait
heuristic may be used only for the current canonical portrait and only when the
source shape and metadata do not contradict the expected single-character
portrait. The stored method remains `heuristic`; it is never promoted to
`detector` by inference.

As shipped, no face detector is chosen yet — which library to use is a trial
decision with a privacy review attached, so the first version deliberately runs
without one. In practice that means automatic preparation succeeds for
portrait-shaped canonical portraits and, for anything else, asks the owner for a
manual crop instead of guessing. The multi-face refusal above is the rule the
moment a detector is added.

### Quality is measured in two stages

The pack records intrinsic measurements such as crop dimensions, face dimensions,
blur, occlusion, face count, and edge padding.

A separate render-time eligibility check evaluates those measurements after the
selected model profile's effective reference resize. A crop may therefore be
valid as an asset but too small for a particular provider profile.

Vesper refuses a known-bad identity reference before reserving provider cost. It
returns an actionable explanation instead of hoping a more forceful prompt will
repair missing detail.

### Thresholds are versioned policy, not permanent schema facts

The schema stores measurements and warning codes. Reviewed thresholds live in a
versioned identity-reference policy so they can be tuned from the fixed trial
corpus without rewriting old measurements or migrating every pack.

Changing a threshold re-evaluates a pack. Changing the crop algorithm, detector,
or normalized source requires a new derivation revision.

### Manual correction creates a new revision

A manual crop never overwrites the automatic file or edits historical metadata in
place. It creates a new face-crop asset and pack revision, records the actor and
reason, and supersedes the previous revision.

Manual crop coordinates remain valid across detector upgrades but become stale
when the canonical source bytes change.

Character owners may correct their own canonical identity crop when automatic
preparation fails. Admins may review and override packs for trial and support
work. An admin override must record a reason and remains visible in provenance.

### No face embeddings are persisted in v1

V1 stores images, geometry, quality measurements, and provenance. It does not
store a face-recognition embedding or use the pack as a biometric identity
system.

A later output-QA system may compute similarity ephemerally or introduce a
separately reviewed storage contract. That decision does not belong to this
pack's initial schema.

### Packs do not cross ownership boundaries

Copying or publishing a character never makes the destination character point at
the source owner's pack or hidden crop asset. The copied canonical image becomes
the destination's source and receives a destination-owned pack.

Even when the bytes are identical, authorization and lifecycle remain local to
the new owner. Crop coordinates may be reused as a derivation hint only if the
new source hash matches, but a new pack record and image asset are still created.

### Operational packs die with the character

The canonical image follows Vesper's broader Gallery-retention policy. The
identity-pack record and hidden derived crops are operational character data and
are removed when the character is deleted.

Superseded and failed revisions may be retained for a short diagnostic window,
then swept. They are not permanent Gallery artifacts.

## User experience

### Normal path

After a canonical portrait becomes ready, Vesper prepares the identity pack in
the background. The character remains usable even if preparation fails.

When an identity-critical render begins, Vesper resolves the current pack before
calling the provider:

- a ready and eligible pack supplies its available reference roles;
- a missing pack is generated lazily and then re-evaluated;
- a stale pack is regenerated from the current source;
- an unusable pack stops before provider spend and explains the correction;
- a temporary internal failure degrades with a diagnostic rather than corrupting
  the canonical portrait.

### Correction path

The crop editor shows the canonical source with the current automatic or manual
crop. The user can reposition and resize a constrained crop, preview the stored
result, and save a new revision.

The editor warns when the crop excludes the hairline, jaw, or ears, is too small,
or contains more than one visible face. The server validates every coordinate;
the client preview is not authoritative.

### Admin path

Admins can inspect:

- source and crop side by side;
- pack and derivation versions;
- method and confidence;
- measured quality and effective profile eligibility;
- warning and failure codes;
- source hash and staleness;
- manual revision history;
- recent renders that consumed the pack.

An admin batch can prepare a named trial corpus or a bounded set of character ids.
There is no unbounded synchronous “rebuild every character” action.

## Failure and degraded behavior

Pack generation may not fail canonical portrait creation. A ready portrait with a
failed pack remains a valid character image.

A pack failure may not silently:

- replace the canonical source with another image;
- select one face from a multi-person source;
- reuse a crop whose source hash changed;
- send a rejected crop to a provider;
- overwrite a manual correction;
- cross an owner or character authorization boundary;
- spend a render unit before the known reference failure is reported.

All parse, file, detector, and metric failures produce stable diagnostics and a
degraded result. Unexpected exceptions are contained at the image boundary.

## Delivery slices

### Slice 1 — contracts, persistence, and hidden asset kind

Add the pure pack contracts, the pack status and warning vocabulary, the dedicated
identity-pack table, and the internal face-crop image kind. Add read APIs and
admin inspection without yet changing render behavior.

The migration uses the next available migration number at implementation time;
this plan does not reserve one while other image work is active.

Shipped 2026-08-06 (migration 0101): the pack vocabulary and contracts, the
versioned crop/quality policy, the `image_identity_packs` table with one current
revision per character, and the hidden face-crop kind kept out of the gallery,
the portrait studio, character copies, and public file serving.

### Slice 2 — deterministic derivation

Implement normalized source hashing, crop geometry, image creation, intrinsic
quality measurements, and the replaceable local detector adapter. Add the
conservative heuristic fallback and multi-face refusal.

Create packs after new canonical portraits become ready, but keep portrait save
successful when derivation fails.

Shipped 2026-08-06: preparation now runs after a portrait is generated, a variant
is promoted, or a character is copied, and never blocks any of them. The detector
seam is real but the adapter shipped with it finds nothing, so automatic
preparation is the conservative heuristic only — see the derivation ruling above.

### Slice 3 — lifecycle and lazy backfill

Add `ensureIdentityPack` for existing characters, source-change invalidation,
concurrency coalescing, supersession, bounded cleanup, deletion behavior, and
copy/publish isolation.

Prove that concurrent requests for the same source do not create competing ready
packs or duplicate crop files.

Shipped 2026-08-06: preparation on demand, invalidation when the portrait changes
or is cleared, coalescing with compare-before-promote, bounded retries, a
seven-day window before old revisions are swept, hidden crops removed with the
character, and copies that never share a pack across owners.

Repaired the same day, after the slices merged. Two machines preparing the same
portrait now join one derivation instead of each running the crop and throwing
one away, with an escape hatch so an explicit regenerate can still recover a
reservation left behind by a dead process. Background preparation now follows the
portrait: swapping portraits twice in quick succession used to leave the second
one with no pack at all, because the job that could have prepared it was the one
that suppressed its own trigger. And deleting the canonical portrait now retires
the pack before the image row goes, so a character can never be left holding a
reference to a picture that no longer exists.

### Slice 4 — manual review and correction

Add the character-owner crop editor, admin inspection, manual revision history,
explicit overrides, and a bounded admin preparation batch.

Shipped 2026-08-06: the portrait tab's reference panel and crop editor (with
plain-language warnings, a stale-save reload, and reset-to-automatic), the owner
routes behind them, and an admin-only inspector with revision history, a recorded
override, and a bounded batch over the admin's own characters.

### Slice 5 — reference-role integration

Expose `canonical_identity` and `face_detail` candidates to shared render intent.
The capabilities/profile layer remains responsible for ordering, capacity, and
whether a model uses one or both.

Remove any identity-critical lane's ad hoc face recropping once it consumes the
pack.

This slice is two halves with different statuses, and only the first is done:

**Slice 5A — pack-side evaluation. Shipped 2026-08-06.** A pack can be evaluated
for a model profile and answers with the candidate reference roles that profile
may use, profile-aware eligibility, and the provenance record behind that
answer.

**Slice 5B — render-lane consumption. Pending on the capabilities work.** The
shared render-intent transport that carries identity references to providers,
capacity enforcement across all references, provider ordering, lane migration,
and the removal of lane-local recropping all wait on
[image-model-capabilities.plan.md](image-model-capabilities.plan.md)'s shared
render intent, which is still being built. Until it lands, no production lane
consumes the pack — the flag that would allow sending references stays off — and
slice 5 as originally scoped is not end-to-end complete.

### Slice 6 — fixed identity-reference trial

Run the fixed corpus against canonical-only, canonical-plus-face-detail, and any
profile-specific reference strategies. Measure identity preference, edit fidelity,
composition drift, failure rate, provider latency, and effective reference size.

Promote only strategies that materially improve identity without unacceptable
regressions. Record the thresholds and policy version used for the verdict.

**The harness shipped 2026-08-06 and was hardened through 2026-08-07. The trial
itself has not run.** An admin has a Settings → Identity trials page where they
can define a run over their own characters, chosen model profiles, reference
strategies, crop revisions, and a small fixed set of checked-in prompts; execute
it in small bounded batches that charge the normal daily image budget before any
provider money is spent; review the finished outputs blind, in pairs that differ
in exactly one identity variable, grading the review dimensions and catastrophic
defects without knowing which strategy made which image; see the aggregated
results per profile and strategy; and record the verdict for each. Trial outputs
are hidden operational images — never in the gallery, never copied or published,
viewable only by their owner for review — and are deleted with the run.

The harness refuses rather than degrades, because evidence that merely looks
controlled is worse than none. A cell that would need a face detector, more
references than the model accepts, a blocked pack, a model whose exact provider
version cannot be pinned, a job the chosen profile could not run in production, a
prompt style the identity vocabulary cannot express, or a comparison arm that
would render identically to a shorter one, is refused up front with an
explanation rather than quietly trimmed. What a cell records is what was sent:
the settings, the exact provider version, and the numbered wording that tells the
model which image is the identity and which is the face detail. Two computers
cannot pay for the same render, a broken cell settles once instead of being
billed again on every click, and an output that loses its cell is deleted rather
than left as an invisible stored image. A verdict cannot be recorded while
renders are outstanding or the blind review is unfinished — recording one anyway
is an explicit, labeled override — and a run counts as complete only when both
the review and the rulings are.

**What remains is the trial, and it is owner work.** No corpus characters exist
yet, no paid renders have happened, no thresholds are calibrated, no detector is
chosen, and no verdict is recorded. One small setup step is also the owner's:
each image model must be re-probed once on the admin models page so it carries a
pinned provider version, because a controlled trial refuses to plan cells against
a model whose exact version it cannot pin.

Reference sending stays off throughout: the integration rules deliberately allow
packs to be trialed while it is off. Mechanics and recorded v1 limitations:
[image-identity-packs.spec.trial.md](image-identity-packs.spec.trial.md).

### Slice 7 — production close-out

Turn advisory measurements into the reviewed production gate, wire provenance and
telemetry, verify deletion/copy/publish paths, remove rollout fallbacks, and update
`docs/images.md` with the shipped operational contract.

## Acceptance criteria

The plan is complete when:

- every current canonical portrait can resolve to exactly one current pack state;
- pack creation is idempotent for a source hash and derivation version;
- the stored crop can be traced to source bytes, coordinates, method, and actor;
- stale, ambiguous, rejected, or undersized references cannot reach a provider by
  accident;
- a pack failure never damages or blocks the canonical portrait itself;
- manual correction is revisioned and auditable;
- copied/published characters never share hidden pack assets across owners;
- character deletion removes the operational pack and hidden derivatives while
  respecting Gallery retention for the canonical source;
- render provenance identifies the exact pack revision and role used;
- the fixed trial establishes whether face-detail references improve Vesper's
  supported identity-critical profiles;
- temporary render-time crop fallbacks are removed.

## Risks and controls

**A detector can be confidently wrong.** Multi-face ambiguity fails closed,
manual correction is first-class, and the method/confidence remain visible.

**A technically sharp crop may still be a poor identity reference.** The trial
judges actual provider behavior; intrinsic measurements are not treated as proof
of likeness.

**A face crop can overemphasize the face and weaken hair or body consistency.**
Profiles choose reference roles. The pack exposes both the canonical portrait and
the detail crop rather than declaring the crop universally superior.

**Pack regeneration can race with renders.** Source hashes, unique current-pack
rules, and compare-before-promote transactions prevent a stale result from
becoming current.

**Hidden face crops create sensitive duplicate files.** They are owner-scoped,
excluded from public surfaces, excluded from logs, not retained as Gallery
artifacts, and deleted with the character.

## Open questions

- **Do hidden identity crops count toward the user's storage quota?** Today they
  do: the storage quota sums every stored image byte an account owns, and the
  hidden face crop is a stored image like any other. Whether an internal derived
  asset the user never sees should consume user-visible quota is an owner
  decision (flagged in PR #57's review and deliberately left unchanged since):
  either subtract the hidden kinds from the quota or record the current behavior
  as intended. The slice-6 trial outputs (`identity_trial_output`, another
  hidden kind the user never sees in the gallery) are in the same boat: they
  count toward quota today and should follow whatever ruling the face crops
  get. Behavior stays as it is until ruled.

Detector library choice, crop expansion ratios, blur/occlusion thresholds, and
profile-specific minimum effective face size are implementation/trial decisions
governed by the contracts above rather than deferred product behavior.
