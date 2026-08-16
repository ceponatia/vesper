# Attribute mutability & change-path integrity — plan

Status: **shipped — 2026-06-19**. All three slices landed; `pnpm verify` green
(lint + typecheck + 1313 tests + jscpd). Completion notes:
- **Slice 1 (enforcement)** — `overlaySourceMayChange` (value.ts), merge-boundary guard
  + `merge.attribute.inherent_change_rejected` diagnostic + `droppedEvents` correction
  with the equality short-circuit, simulant prompt tightened, `temporary` dropped,
  `contracts/attributes.md` updated. Covered by new pure (`value.test.ts`) + merge degradation tests.
- **Slice 2 (shared vocab)** — `shared-values.ts` (`HAIR_DENSITY`, `INTIMATE_SCENT_BASE`,
  `MATERIAL_COLORS`); arms/legs hair + vulva/penis scent/taste DRYed; 3 morphology colors
  `text → enum_list`; faerie sprite `wings.color` rule migrated to a palette value.
- **Slice 3 (editor hard-restrict)** — picker enum/enum_list controls now narrow to
  `allowedValuesFor` and flag out-of-rule stored values; `required` defaults seed on
  species/heritage change (`seedRequiredAttributes`, not a render effect). The logic was
  **extracted into pure helpers** (`attribute-helpers.ts`: `allowedOptionsFor`,
  `isOutOfRuleValue`, `seedValueFor`, `seedRequiredAttributes`) and **unit-tested**
  (`attribute-helpers.test.ts`, against the real registry/species — faerie wings,
  elf ears, human) so the original "no rendered editor test" gap is closed for the logic;
  only the thin JSX wiring is left to typecheck. Deferred items D5 (resolver hardening +
  overlay scrub) and D6 (transformation seam) remain forward-looking.

Spec: [attribute-mutability.spec.md](attribute-mutability.spec.md). Re-analysis
(2026-06-19) of [attribute-mutability.md](attribute-mutability.md) +
`attribute-mutability-user-notes.md`; the design
half of the user notes mostly shipped with **non-human-species** (2026-06-18), so this
plan covers only what is still unbuilt — see the spec's §1 reconciliation table.

## Why this exists

`AttributeDefinition.mutability` is documented in `contracts/attributes.md` as a binding rule
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
   - a `droppedEvents` correction; short-circuit when the proposed value already equals
     the resolved value (no spurious correction on a re-assert). Precedent: the
     movement-drop at `merge.ts:1509`.
3. **Simulant prompt (D3, prompt half).** Tighten `SIMULANT_SYSTEM`
   (`engine/prompts/agents.ts`) so `attributeChanges` is named as mutable-only and
   inherent traits (eye color, gender, age, species, bone structure) are explicitly
   off-limits.
4. **Dispose of `temporary` (D4).** Drop `"temporary"` from `attributeMutabilities`
   (`attributes/types.ts:12`); fix any exhaustive `switch` the lint flags. No
   migration (static registry property, never persisted).
5. **Docs.** Update `contracts/attributes.md` so the `mutability` parenthetical points at real
   enforcement and names `magic`/`manual` as the deliberate-change escape hatch; note
   `temporary` is gone.

Tests (spec §9): pure truth table + merge degradation (fallback **and** diagnostic) +
the `manual`-still-honored regression + the registry-enum assertion. Run `pnpm verify`.

### Slice 2 — Shared value-vocabulary + free-text reduction (live gap, user-note #4)

Q1 resolved (spec §6). Build the shared-vocabulary seam and the morphology-color
conversion:

1. **Shared module.** New pure `contracts/attributes/shared-values.ts` exporting
   `HAIR_DENSITY` (`none·fine·light·moderate·thick`), `INTIMATE_SCENT_BASE`
   (`clean·musky·salty`), and `MATERIAL_COLORS` (non-skin surface palette).
2. **DRY extraction (no value changes).** `arms.hair` + `legs.hair` → `HAIR_DENSITY`
   (byte-identical today). `vulva.scent`/`penis.scent`/`vulva.taste` → base+augment off
   `INTIMATE_SCENT_BASE`, reproducing each field's current set/order.
3. **Morphology colors.** `horns.color` / `tail.color` / `wings.color`: `text` →
   `enum_list` drawing from `MATERIAL_COLORS` (+ optional per-field terms). Add prompt
   hints. **Keep** `voice.accent`, `presentation.scent_baseline`, `hair.style`,
   `identity.heritage` as text.
4. **Scope guard.** `eyes.color`/`hair.color`/`skin.tone` and `arms.build`/`legs.build`
   stay **local** (curated coreVisual / not byte-identical) — do not fold onto a base.

Per-category vocabulary edit → `vitest contracts`; not a migration (the morphology
colors had no closed vocabulary, so no persisted value breaks). Sequence after Slice 1.

### Slice 3 — Editor narrows enums by species rule, hard-restrict (live gap, §8)

Q2 resolved (spec §8). Point `attribute-picker.tsx`'s enum/enum_list controls at
`body.allowedValuesFor(def)` and **hard-restrict** (drop out-of-rule options); show an
already-stored out-of-rule value as a flagged invalid selection rather than silently
rewriting it. Seed `required`-rule `defaultValue`s where species/heritage is set
(mirror `character-editor.tsx` `setHeritage`), **not** in a render effect (react-hooks
lint). Adjacent to Slice 1, independent of Slice 2.

### Deferred (forward-looking, not scheduled)

- **Resolver hardening (D5).** Defensive `overlaySourceMayChange` check inside
  `resolveAttributes` + a one-time scrub of pre-fix `narrative` overlays on inherent
  ids. Only after Slice 1.
- **Transformation seam (D6).** Simulant flags a transformative change → merge maps to
  `source: "magic"` (the never-produced source the policy already admits). Revives a
  dead source for "a curse turned her hair white" while keeping mundane drift blocked.
  Its own design doc when wanted.

## Resolved questions

- **Q1 — free-text / shared vocab (spec §6).** Build a shared value-vocabulary module
  (`contracts/attributes/shared-values.ts`) on a **base + per-field augment** pattern —
  the user's "central palette, augmented per field" idea. First constants: `HAIR_DENSITY`
  (DRY of `arms.hair`/`legs.hair`), `INTIMATE_SCENT_BASE` (vulva/penis scent+taste), and
  `MATERIAL_COLORS`. Convert the three morphology colors (`horns`/`tail`/`wings.color`)
  from `text` → `enum_list` off `MATERIAL_COLORS`; keep `voice.accent`,
  `presentation.scent_baseline`, `hair.style`, `identity.heritage` as text. Color-sharing
  scope = **morphology only**: `eyes`/`hair`/`skin` are curated coreVisual lists and stay
  local (the user's own "many body areas need their own lists" caveat), and
  `arms`/`legs.build` aren't byte-identical so they stay local too. The module is the
  seam for future shared axes.
- **Q2 — editor enum narrowing (spec §8).** **Hard-restrict** the editor to
  `allowedValuesFor(def)` (drop out-of-rule options; flag an already-stored out-of-rule
  value rather than rewriting it); seed `required` defaults when species/heritage is set.

## Settled rulings (do not re-open without cause)

Recorded in spec §7 — anatomy is a fully-overridable **seed**, not a gender lock (R1);
**no DB sentinel** for inapplicable attributes — absence + applicability filtering is
the marker (R2). Both diverge from the 2026-06-15 user notes by deliberate choice.
</content>
