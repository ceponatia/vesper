# Romantic contact affordances — follow-ups

Status: **complete — shipped 2026-07-31.** Every item on this list has landed:
the five slice-2 hardening items and the owner's review item (2026-07-30), the
registration-review corrections and the Neon backfill (2026-07-30), and the
final foot side/unsided regressions closed in the slice-3A pass (2026-07-31).

Nothing here is outstanding. The live sequencing that governs what happens next
is in the [plan](romantic-contact-affordances.plan.md) §"Slice 3A" and its
continuation order — this document is now history, kept for the record of what
each fix was and why.

## Hardening pass (owner-ordered, one small PR)

_Complete — all five landed 2026-07-30, plus item 6 from the owner's review of
that pass. See "Done" below._

6. **Per-side residuals (owner review of items 1–5).** Two follow-ons the owner
   found in the item-2 work: `undistinguishedInterdigitalClosure` treated a
   SINGLE supplied foot pose as "agreement" even though an unsided locus may
   belong to the other, unanswered foot; and the support/articulation payload
   arrays permitted duplicate sides despite their one-entry-per-foot comments.
   Both must land before slice 3. ✅ landed 2026-07-30 (see "Done"); the last
   side/unsided regressions closed 2026-07-31 in slice 3A.

## Sequencing constraints (owner, 2026-07-30) — all satisfied

- Positive tactile texture/glide enable only after perceiver-specific
  perception channels (the core filter is sight-only today) and the ruled
  regional condition ownership are wired. ✅ still binding, and carried into the
  plan as the LAST step of the continuation order — it is future design, not an
  outstanding follow-up.
- Slice-3 development may begin, but production registration does not deploy
  until the registration-review corrections and the Neon backfill are complete.
  ✅ **both preconditions met.** The corrections landed 2026-07-30 and the Neon
  backfill ran clean the same day (11 rows, zero conflicts, idempotent re-run
  verified), with the foot registry defaults deployed. **The production-registration
  gate now waits only on slice-3 wiring order**, not on any correction or data
  migration. Full order: the
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
     the live application. Ran clean on Neon 2026-07-30 (11 rows, zero
     conflicts, idempotent re-run verified), so the deploy gate above is
     satisfied.
- **Pre-slice-3 foot facts and registration hardening** — 2026-07-30. Three
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
  2026-07-30 rulings (permission scope split and contact storage home) as
  settled law and point at the
  [audit](romantic-contact-affordances.audit.md#owner-decisions-needed).
  Comments only — no behaviour change.
