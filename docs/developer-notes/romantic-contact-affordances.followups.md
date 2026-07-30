# Romantic contact affordances — follow-ups

Status: active — the slice-2 hardening list, ordered by the owner 2026-07-30
(step 1 of the post-slice-2 sequence; see the
[plan](romantic-contact-affordances.plan.md) for the full order). The five
hardening items plus the owner's review item all landed 2026-07-30; the
sequencing constraints below still bind slice 3. Items move to "Done" here as
they land.

## Hardening pass (owner-ordered, one small PR)

_Complete — all five landed 2026-07-30, plus item 6 from the owner's review of
that pass. See "Done" below._

6. **Per-side residuals (owner review of items 1–5).** Two follow-ons the owner
   found in the item-2 work: `undistinguishedInterdigitalClosure` treated a
   SINGLE supplied foot pose as "agreement" even though an unsided locus may
   belong to the other, unanswered foot; and the support/articulation payload
   arrays permitted duplicate sides despite their one-entry-per-foot comments.
   Both must land before slice 3.

## Sequencing constraints (owner, 2026-07-30)

- The [adult declaration](adult-eligibility.plan.md) ships before the first
  genuinely romantic foot trial; slice 3 starts with a genuinely
  affectionate/non-romantic integration case.
- Positive tactile texture/glide enable only after perceiver-specific
  perception channels (the core filter is sight-only today) and the ruled
  regional condition ownership are wired.

## Done

- **Rigid-footwear articulation leak** — 2026-07-30. `foot.articulation_observation`
  now gates its pose-detail tags (`toes_*`, `arch_*`) per surface on
  `footwearHidesDeformation`, marks a dropped detail with
  `pose_hidden_by_footwear`, and always keeps the externally observable
  `restricted_by_*` tag. The fixture matrix's flexible-fabric row became a full
  case (`sockTransmittedToeCurl`). Detail: [foot spec](romantic-contact-affordances.spec.foot.md#deltas-from-the-draft-above--this-section-is-the-authority).
- **Side-specific conditions** — 2026-07-30. The coarse condition read carries an
  optional `side` and the payload is a set with at most one answer per foot;
  effective mechanics became per-foot blocks and `footSurfaceMechanics` looks up
  by side. A foot nobody answered for reads unknown rather than borrowing the
  other foot's answer, and each foot's own pose now drives its own interdigital
  closure. Detail: [foot spec](romantic-contact-affordances.spec.foot.md#deltas-from-the-draft-above--this-section-is-the-authority).
- **Lifecycle material fingerprinting** — 2026-07-30. `contentKey` fingerprints
  each layer's content rather than its id, so a layer that changes under a stable
  id produces `contact_updated` with the fresh material; array order and evidence
  are deliberately not content. Detail: [contact-core spec](romantic-contact-affordances.spec.contact-core.md#deltas-from-the-draft-above--this-section-is-the-authority).
- **Duplicate-layer canonicalization** — 2026-07-30. `compileFootwearContact`
  merges rows sharing a `layerId` by a stated rule per field and reports the
  repair as a `FootwearAnomalyRead`, which the domain files as a
  `foot.footwear.anomaly` warning. Detail: [foot spec](romantic-contact-affordances.spec.foot.md#deltas-from-the-draft-above--this-section-is-the-authority).
- **Per-side residuals (owner review)** — 2026-07-30. The unsided-locus closure
  modifier now applies only when **two distinct feet are supplied and agree**;
  zero poses, one pose, and disagreement are all the structural-neutral `0` — a
  single left-foot pose says nothing about the right foot, and an unsided locus
  may be the right foot. The support and articulation payloads gained
  `footSupportSetSchema` / `footArticulationSetSchema`, so a repeated side fails
  the schema (⇒ `invalid`) instead of letting whichever entry was read first win.
  Detail: [foot spec](romantic-contact-affordances.spec.foot.md#deltas-from-the-draft-above--this-section-is-the-authority).
- **Stale ruling comments** — 2026-07-30. `contact/decisions.ts`,
  `contact/state.ts`, and the foot fixtures/tests now state the owner's
  2026-07-30 rulings (adult eligibility, permission scope split, contact storage
  home) as settled law and point at the
  [audit](romantic-contact-affordances.audit.md#owner-decisions-needed).
  Comments only — no behaviour change.
