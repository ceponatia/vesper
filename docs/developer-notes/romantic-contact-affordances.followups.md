# Romantic contact affordances — follow-ups

Status: active — the slice-2 hardening list, ordered by the owner 2026-07-30
(step 1 of the post-slice-2 sequence; see the
[plan](romantic-contact-affordances.plan.md) for the full order). Items move to
"Done" here as they land.

## Hardening pass (owner-ordered, one small PR)

1. **Rigid-footwear articulation leak.** `footwearHidesDeformation`
   (`src/contracts/affordances/domains/foot/footwear.ts:341`) has no phenomenon
   consumer: `foot.articulation_observation` emits `toes_*`/`arch_*` tags with
   `sourceLocationId: "feet"` regardless of footwear, and the core perception
   filter is sight-only over the source location — a visible booted foot leaks
   the toe position rigid footwear physically hides. Gate the observation's
   pose-detail tags (or the observation itself) on deformation transmission;
   keep the restriction tag, which IS externally observable.
2. **Side-specific conditions.** The coarse condition read is subject-wide
   while support/articulation are per-foot (recorded limitation in the
   [foot spec](romantic-contact-affordances.spec.foot.md#as-built--slice-2)).
   Key the condition read by side so a soaked left sole and a dry right sole
   are representable, consistent with the per-side reads.
3. **Lifecycle material fingerprinting.** `contentKey`
   (`src/contracts/affordances/contact/lifecycle.ts:115-130`) fingerprints
   `materialBetween` by `layerId` only, so a layer whose properties change
   mid-contact under a stable id (a sock soaking through, permeability
   changing) takes the `contact_continued` path and observations keep reading
   the stale material snapshot. Fingerprint the material content, not just the
   id list, so a property change produces `contact_updated`.
4. **Duplicate-layer canonicalization.** `compileFootwearContact`
   (`src/contracts/affordances/domains/foot/footwear.ts`) unions duplicate
   `layerId` rows silently. Canonicalize instead: merge duplicates
   deterministically and surface the anomaly, rather than quietly accepting a
   malformed wardrobe read.
5. **Stale ruling comments.** `src/contracts/affordances/contact/decisions.ts`
   still says adult eligibility is unresolved, calls the permission rule "the
   conservative half", and says unknown ages remain unresolved "until the owner
   rules". Runtime behavior already matches the 2026-07-30 rulings; sweep the
   contact and foot code for pre-ruling comment language and point it at the
   audit's recorded rulings.

## Sequencing constraints (owner, 2026-07-30)

- The [adult declaration](adult-eligibility.plan.md) ships before the first
  genuinely romantic foot trial; slice 3 starts with a genuinely
  affectionate/non-romantic integration case.
- Positive tactile texture/glide enable only after perceiver-specific
  perception channels (the core filter is sight-only today) and the ruled
  regional condition ownership are wired.

## Done

_(nothing yet)_
