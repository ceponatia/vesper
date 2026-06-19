# Attribute mutability & change-path integrity — plan

Status: **next** — Slice 1 (enforcement) is fully specified and ready to build;
Slices 2–3 are scoped behind one open question each.

Spec: [attribute-mutability.spec.md](attribute-mutability.spec.md). Re-analysis
(2026-06-19) of [attribute-mutability.md](attribute-mutability.md) +
[attribute-mutability-user-notes.md](attribute-mutability-user-notes.md); the design
half of the user notes mostly shipped with **non-human-species** (2026-06-18), so this
plan covers only what is still unbuilt — see the spec's §1 reconciliation table.

## Why this exists

`AttributeDefinition.mutability` is documented in `contracts.md` as a binding rule
("inherent: narrative can't change it") and set on all 86 attributes (51 inherent /
35 mutable), but it is **read by nothing**. A single simulant turn can permanently
rewrite a character's eye color, gender, apparent age, or species via a `narrative`
overlay that outranks the authored value and re-applies every turn. Identity drift is
the exact failure the post-turn world model exists to prevent (spec §2).

## Slices

### Slice 1 — Enforce mutability at the write boundary (load-bearing, ready)

The minimal correct fix. ~spec §4. All design questions resolved.

1. **Policy primitive (D1).** Add pure `overlaySourceMayChange(mutability, source)` to
   `contracts/attributes/value.ts` (inherent admits only `manual`/`magic`; else true).
   Unit-test the truth table.
2. **Merge enforcement (D2).** In the `attributeChanges` loop (`engine/merge.ts:1721`),
   reject a disallowed inherent change with `merge.attribute.inherent_change_rejected`
   + a `droppedEvents` correction; short-circuit when the proposed value already equals
   the resolved value (no spurious correction on a re-assert). Precedent: the
   movement-drop at `merge.ts:1509`.
3. **Simulant prompt (D3, prompt half).** Tighten `SIMULANT_SYSTEM`
   (`engine/prompts/agents.ts`) so `attributeChanges` is named as mutable-only and
   inherent traits (eye color, gender, age, species, bone structure) are explicitly
   off-limits.
4. **Dispose of `temporary` (D4).** Drop `"temporary"` from `attributeMutabilities`
   (`attributes/types.ts:12`); fix any exhaustive `switch` the lint flags. No
   migration (static registry property, never persisted).
5. **Docs.** Update `contracts.md` so the `mutability` parenthetical points at real
   enforcement and names `magic`/`manual` as the deliberate-change escape hatch; note
   `temporary` is gone.

Tests (spec §9): pure truth table + merge degradation (fallback **and** diagnostic) +
the `manual`-still-honored regression + the registry-enum assertion. Run `pnpm verify`.

### Slice 2 — Free-text reduction (live gap, user-note #4)

Blocked on **Q1**. Convert the agreed `text` attributes to `enum`/`enum_list` with
authored allowed-value sets + prompt hints; **keep** `hair.style` and
`identity.heritage` as text (spec §6). Per-category vocabulary edit → `vitest
contracts`; not a migration. Sequence after Slice 1.

### Slice 3 — Editor narrows enums by species rule (live gap, §8)

Blocked on **Q2**. Point `attribute-picker.tsx` enum/enum_list controls at
`body.allowedValuesFor(def)` (the forge already does this) and seed `required`-rule
defaults on first render. Adjacent to Slice 1, independent of Slice 2.

### Deferred (forward-looking, not scheduled)

- **Resolver hardening (D5).** Defensive `overlaySourceMayChange` check inside
  `resolveAttributes` + a one-time scrub of pre-fix `narrative` overlays on inherent
  ids. Only after Slice 1.
- **Transformation seam (D6).** Simulant flags a transformative change → merge maps to
  `source: "magic"` (the never-produced source the policy already admits). Revives a
  dead source for "a curse turned her hair white" while keeping mundane drift blocked.
  Its own design doc when wanted.

## Open questions

- **Q1 — free-text conversions (spec §6, blocks Slice 2).** Which of `voice.accent`,
  `presentation.scent_baseline`, `horns.color`, `tail.color`, `wings.color` become
  enum/enum_list, and whether the three morphology colors share one authored palette?
- **Q2 — editor enum narrowing (spec §8, blocks Slice 3).** Hard-restrict the editor's
  enum options to the species-narrowed set (drop out-of-rule options), or soft-warn?
  Leaning hard-restrict + seed required defaults.

## Settled rulings (do not re-open without cause)

Recorded in spec §7 — anatomy is a fully-overridable **seed**, not a gender lock (R1);
**no DB sentinel** for inapplicable attributes — absence + applicability filtering is
the marker (R2). Both diverge from the 2026-06-15 user notes by deliberate choice.
</content>
