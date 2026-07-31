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

- The [adult declaration](finished/adult-eligibility.plan.md) ships before the first
  genuinely romantic foot trial; slice 3 starts with a genuinely
  affectionate/non-romantic integration case.
- Positive tactile texture/glide enable only after perceiver-specific
  perception channels (the core filter is sight-only today) and the ruled
  regional condition ownership are wired.
- Slice-3 development may begin, but production registration does not deploy
  until the registration-review corrections (below, all landed 2026-07-30) and
  the Neon backfill are complete. Full slice-3 build order: the
  [plan](romantic-contact-affordances.plan.md) §Slice 3 sequencing.

## Done

- **Registration-review corrections (owner review of the foot-facts work)** —
  2026-07-30. Three fixes before the Neon backfill:
  1. *Materialized fields are non-clearable in the editor.* The attribute
     picker keys its "clear" button and blank "—" enum option off the new
     `isClearableAttribute` helper: a `materializeDefault` field offers
     neither (unset, its control rests dimmed on the registry default the
     server will store; any pick is `source: "manual"`), while ordinary sparse
     attributes stay clearable. Regression in `attribute-helpers.test.ts`,
     which also pins that every flagged field is an enum (the only control
     with the non-clearable branch).
  2. *`feet.nails` defaults to `trimmed`, not `neat`* — the neutral baseline
     states ordinary nail length without assuming additional grooming. The
     exact four-value default map (`average/average/trimmed/average`) is
     pinned in `registry.test.ts`; local rows seeded as `neat` were reseeded.
  3. *The backfill is compare-and-set.* Each JSONB profile replace is guarded
     by `WHERE profile = <blob the plan was computed from>`; a row edited
     concurrently is re-read, re-planned, and retried (3 attempts), with
     still-conflicted rows reported and a non-zero exit — safe to run against
     the live application.
- **Pre-slice-3 foot facts and registration hardening** — 2026-07-30. Four
  pieces, all pinned by tests:
  1. *Persisted-baseline foot facts.* `feet.size/arch/nails/toes` gained
     `defaultValue` + the new `materializeDefault` registry tier: every
     grounding (blank, forged, imported, cloned, persona create, profile
     PATCH — which re-materializes a removed row) stores the missing facts as
     low-precedence `creation` rows with sourceId `registry-default:feet:v1`,
     respecting species/body-plan applicability; `feet.smell` deliberately
     unflagged. Existing bodies:
     `pnpm db:backfill-registry-defaults [--dry-run]` (counts by field and
     site before applying; characters + personas only). Detail:
     docs/contracts/attributes.md.
  2. *Partial foot profiles.* `compileFootProfile` lost its all-or-nothing
     gate — each axis omits only its own surfaces (arch subtree / toenail /
     interdigital spaces), pressure needs no `feet.*` attribute, and the
     compiler never substitutes a default. Detail:
     [foot spec](romantic-contact-affordances.spec.foot.md#deltas-from-the-draft-above--this-section-is-the-authority).
  3. *Optional-invalid dependency law.* Core `unmetDependencies`: optional +
     unavailable continues; optional + invalid now SUPPRESSES with the invalid
     code and diagnostic (an unparseable "trapped" support no longer reads as
     unrestricted). Audited across hair/garment/foot.
  4. *Eligibility follow-ups closed* (the adult plan's leftovers): an explicit
     `minor` declaration arms the existing minor-safe prompt fence
     (`minorFenceApplies`; declaration text still never serialized), the
     declaration is public on profiles/previews (owner ruling), per-participant
     verdicts ride `contactParticipantEligibility` and
     `adultEligibilityBlockerLinks` routes a blocked action to the persona
     editor / character editor / "Duplicate to edit" for foreign characters,
     and the age parser recognizes the tight "17 years" / "17 years old"
     whitelist.
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
