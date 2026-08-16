# Non-human species & additive body features — plan

Status: **shipped — 2026-06-18.** Every planned slice (F0–F5 in the spec) landed:
the feature mechanism, the three feature locations + morphology attributes, the
first species records, **image-gen feature surfacing on every route**, the
species/heritage editor controls + forge inference, and the docs. Two strands live
on past this plan, both always scoped as separate later work — **wardrobe
accommodation** (tail-holes / wing-slits; see _Leftovers_ below and
[deferred.plan.md](../deferred.plan.md)) and **incremental per-species attribute-rule
data** (only `succubus` still ships empty rules; finer coloration nudges are
ordinary data edits, no engine work). True _structural_ body plans
(mermaid/naga/quadruped) remain out of scope.

Design/decisions: [non-human-species.spec.md](non-human-species.spec.md) (the
former `non-human-races-and-features.deferred.md`) — it is the truth; this plan is
the task list. Builds on the phase-4 species scaffolding
([phase-4-plan.md](phase-4-plan.md)).

## Goal

Real non-human cast as **additive features on the humanoid body plan** (wings ·
horns · tail), gated by species — not novel structural body plans. A succubus is a
humanoid plus extra parts.

## What shipped

- **Feature mechanism (F0).** `featureGroup` body-location tag + the
  `FEATURE_GROUPS` list; per-character `bodyFeatures` on the profile (`parseOr`,
  default `[]`); `defaultFeatureGroups` on `SpeciesDefinition`; `realizeBody`
  generalized to gate both `intimateGroup` and `featureGroup` against their lists,
  with `hasFeature(group)` on the realized body. Degradation-tested.
- **Locations + morphology attributes (F1).** `body/locations/features.ts` adds
  `horns`→`head`, `wings`→`back`, `tail`→`pelvis`, all `coverageRelevant: false`.
  Attribute groups in `attributes/categories/morphology/` (`wings` ·
  `horns` · `tail`), each attribute bound to its feature location so realize gates
  it automatically. The shipped vocabulary is richer than the spec's starter list
  (e.g. `wings.type`/`shape`/`span`/`color`/`carriage`,
  `horns.shape`/`length`/`count`/`texture`/`color`,
  `tail.type`/`length`/`color`/`tip`). `FEATURE_ATTRIBUTE_CATEGORIES` +
  `isFeatureAttributeCategory` exist as the defense-in-depth gate the spec called
  for.
- **Species catalog of 8 (F2).** dwarf · elf · faerie · gnome · goblin · human ·
  orc · succubus (`contracts/species/catalog/`, one file each). `succubus`
  (`["wings","horns","tail"]`) and `faerie` (`["wings"]`) carry
  `defaultFeatureGroups`. **Every non-human species now also carries
  `attributeRules`** (elf pointed ears, faerie butterfly wings, dwarf/gnome/orc/
  goblin trait nudges) — this advanced past the plan's original "baseline records,
  traits later." Only `succubus` still ships empty rules (see _Leftovers_).
- **Model-facing species notes, split by audience.** `appearance` (generic visual
  morphology → image models + forge, via `speciesAppearancePhrase`) and `lore`
  (culture/identity → narrator, via `speciesLorePhrase`). Authored for all 7
  non-human species; `human` ships both empty (the unmarked default). The forge
  feeds `appearance` into both the profile and attribute passes so generated
  characters realize the species look as concrete attribute values.
- **Heritages (sub-groups within a species).** Optional `heritages` on a species —
  worked examples `dark_elf` inside `elf` and `sprite` inside `faerie`. A pure
  overlay realized by `realizeBody`'s `heritageId`: adds feature groups,
  **overrides** species attribute rules per `attributeId`, **combines** its
  `appearance` with the species look, **replaces** the species `lore`. Stored as
  `profile.heritageId`; forge inference (`inferHeritageFromText`) and a dependent
  editor picker resolve it; heritage names resolve the parent species too.
  Additive-only — never forks the body plan. More heritages are data.
- **Image-gen feature surfacing (F3 — "the real cost").** Visible features and the
  species look reach **both** image routes (Flux portrait + Qwen/Venice scene),
  never behind the exposure mask. See the divergence note below for how — the
  shipped mechanism differs from the spec's sketch. `docs/images.md` documents it
  (this also closes the F5 "docs/images.md belongs with F3" item).
- **Editor + forge (F4).** `character-editor.tsx` has a **Species select** (seeds
  `bodyFeatures` from `defaultFeatureGroups` on change) and a dependent **Heritage
  picker** (re-seeds combined feature groups); `attribute-picker.tsx` has a **Body
  features** toggle section parallel to `BodyConfigSection`, plus species/heritage
  rule notes shown as attribute helper text. The forge does deterministic,
  registry-based species **and** heritage inference (exact aliases + conservative
  fuzzy fallback) and seeds `speciesId` / `heritageId` / `bodyFeatures`, giving the
  attribute agent only the realized feature vocabulary.
- **Tests + docs (F5).** Contract tests (realize, registry, seed, targets),
  registry invariants, and `docs/contracts.md` / `docs/authoring.md` /
  `docs/images.md`.

## Divergences from the plan/spec worth knowing

- **Image surfacing took a different shape than the proposed
  `visibleFeatureAppearance(realizedBody, attributes)` helper — that helper was
  never built.** Instead surfacing splits in two: (1) the species' _generic_
  morphology is carried by `speciesAppearancePhrase` — a `Species:` line in
  `buildAvatarPrompt` and a per-character `species` field on the scene composer +
  render textual detail (`character-scene.ts`, `prompts.ts`); (2) the
  _per-character_ feature attributes (wings/horns/tail) flow through the **existing
  attribute loop**, gated by `realizedBody.isAttributeApplicable` and — being SFW,
  not intimate — never excluded from Flux. Net effect matches the spec's intent
  (features on both routes, outside the exposure fence) with no dedicated helper.
- **A waist-up portrait now _keeps_ a pelvis-rooted tail — the opposite of the
  spec.** The spec wanted the tail dropped from a head-and-shoulders shot (it's
  below-waist). The shipped `buildAvatarPrompt` exempts feature morphology from the
  below-waist cut via `isFeatureAttributeCategory`, reasoning that a succubus tail
  "sweeps up into frame" and defines the character. Documented in `docs/images.md`;
  treated as the better call, not a bug.

## Leftovers (past this plan)

- **Wardrobe accommodation** — garments that fit winged/tailed bodies (back slits,
  tail openings) so outfits don't clip or contradict features. Always scoped as its
  own later pass (spec §Wardrobe); features stay `coverageRelevant: false` and the
  `expand`/coverage seam under the `tail` location is where the nuance will live.
  Parked in [deferred.plan.md](../deferred.plan.md).
- **Incremental per-species attribute rules** — `succubus` still ships empty
  `attributeRules`, and finer species-typical skin/eye/coloration nudges can be
  added to any record. Pure data edits through the `attributeRule` seam, no engine
  work — promote to a real task only if play asks for it.

## Open questions — resolved

- **Field name.** Settled on `bodyFeatures` (parallel to `intimateRegions`).
- **Required vs default features.** Went **default-only** — `succubus`
  `bodyFeatures` is fully overridable (empty `attributeRules`), consistent with the
  "always overridable" principle. No hard feature requirement was added.
- **Left/right wing & horn splitting.** Kept **single** `wings`/`horns` locations;
  the `horns.count` attribute carries arrangement. Split with the `side` enum only
  if image quality later asks for it.
- **Tail under `pelvis` and `expand`.** Accepted the harmless-in-v1 "covered tail"
  notion (`coverageRelevant: false`); revisited only when wardrobe accommodation
  lands.
- **Own phase vs. fold into a "non-human v1" phase.** Became its own plan + spec.
- **Novel structural body plans** (mermaid/naga/quadruped) — still out of scope; a
  later effort with image-gen in the room from day one.
- **Species-specific wardrobe vs. prompt-only hinting** — deferred with wardrobe
  accommodation; unresolved until that pass.
