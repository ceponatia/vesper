# Non-human species & additive body features — plan

Status: **active** (dev ongoing) — graduated from
[deferred.plan.md](deferred.plan.md) 2026-06-16.

Design/decisions: [non-human-species.spec.md](non-human-species.spec.md) (the
former `non-human-races-and-features.deferred.md`) — read it first; it is the
truth. This plan is the task list. Builds on the phase-4 species scaffolding
([phase-4-plan.md](phase-4-plan.md)).

## Goal

Real non-human cast as **additive features on the humanoid body plan** (wings ·
horns · tail), gated by species — not novel structural body plans. A succubus is a
humanoid plus extra parts.

## Shipped already

- Species catalog of 8 — dwarf · elf · faerie · gnome · goblin · human · orc ·
  succubus (`contracts/species/catalog/`, one file each).
- Additive **morphology** feature groups (`attributes/categories/morphology/`:
  wings · horns · tail) + `featureGroup` / `bodyFeatures` + feature body locations.
- Species drives body realization; deterministic forge species inference (exact
  aliases + conservative fuzzy fallback) seeds species-default body features and
  unlocks realized morphology attributes.
- Editor species/feature controls; contract tests; contract + authoring docs.
- **Model-facing species notes, split by audience** — `appearance` (generic
  visual morphology → image models + forge, via `speciesAppearancePhrase`) and
  `lore` (culture/identity → narrator, via `speciesLorePhrase`). Authored for all
  7 non-human species; `human` ships both empty (the unmarked default, and a
  generic human note can't fit realistic/sci-fi/fantasy worlds alike). The forge
  feeds `appearance` into both the profile and attribute passes so generated
  characters realize the species look as concrete attribute values.
- **Heritages (sub-groups within a species)** — optional `heritages` on a species
  (worked example: `dark_elf` inside `elf`). A pure overlay realized by
  `realizeBody`'s `heritageId`: adds feature groups, **overrides** species
  attribute rules per `attributeId`, **combines** its `appearance` with the
  species look, **replaces** the species `lore`. Stored as `profile.heritageId`;
  forge inference (`inferHeritageFromText`) and a dependent editor picker resolve
  it; heritage names resolve the parent species too. Additive-only — never forks
  the body plan. Authoring more heritages (Wood Elf, Pixie/Sprite, …) is data.

## Remaining work

1. **Image-gen feature surfacing.** Visible features (wings/horns/tail) are SFW +
   always-visible, so they must surface in the appearance prompt on **both** image
   routes (Flux + Qwen) — unlike the exposure-gated, Flux-excluded intimate set.
   `speciesAppearancePhrase` is the shared seam; verify features reach the avatar
   and scene prompts.
2. **Richer per-species attribute rules** beyond the starter morphology
   (species-typical skin/eye/coloration constraints) via the `attributeRule` seam.
3. **Wardrobe accommodation** — clothing that fits winged/tailed bodies (back
   slits, tail openings) so outfits don't clip or contradict features.

## Open questions

- Novel **structural** body plans (mermaid/naga/quadruped) stay out of scope — a
  later effort with image-gen in the room from day one (spec §Out of scope).
- How much species-specific wardrobe to model vs. prompt-only hinting — resolve
  during task 3.
