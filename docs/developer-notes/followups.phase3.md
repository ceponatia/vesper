# Phase 3 — follow-ups

Fixes and small improvements found in testing/play after
[phase-3-plan.md](phase-3-plan.md) shipped, per the repo convention:
dated entries with observation → investigation → verdict → proposed
fix. Feature-sized work goes to the next phase's plan, not here.

## 1. Image prompts: richer clothing text; waist-up portraits omit below-the-waist garments (2026-06-13)

**Request (user).** Two changes to the image prompt builders
([../images.md](../images.md)):

1. *Clothing phrasing.* For every garment, pass its **description** and
   **sensory appearance, untruncated** — not the bare item name. The
   name usually re-appears inside the description, and the description
   carries more useful visual information than the name alone.
2. *Portrait framing.* Giving the avatar model shoes and pants
   sometimes yields a full-body picture even though the prompt says
   "waist-up portrait". For the **portrait/avatar only**, omit garments
   worn entirely below the waist. The **in-session scene** generator
   must keep them — scene images should sometimes be full-body.

**Assessment.** Both touch `server/images/prompts.ts`, the single
source of image-prompt phrasing.

- *Data availability.* `description` and `sensory.appearance` already
  live on every `ItemDefinition`. The avatar path
  (`loadDefaultOutfit`, `avatar.ts`) and the scene path
  (`buildSceneComposerContext`, `engine/pipeline.ts`) both read the
  full definition when they build wardrobe items, so threading the two
  fields through is additive — `AvatarOutfitItem` / `AvatarWardrobeItem`
  / `SceneWornItem` gain optional `description` + `appearance`.
- *Below-the-waist.* The body-location tree
  (`contracts/body/locations.ts`) splits cleanly into five roots:
  head · torso · arms · pelvis · legs. "Waist-up" keeps head/torso/arms
  and drops pelvis/legs. The waist itself is a child of `torso`, so
  belts and waistbands stay; a garment that also covers the torso
  (dress, coat, abaya) stays; only garments whose coverage is
  *entirely* below the waist (pants, shorts, skirts, shoes) are
  dropped. This is the avatar's existing occlusion filter's natural
  home (`visibleAvatarOutfit`), which scene rendering never calls — so
  scenes keep full-body garments for free.

**Decisions (user, 2026-06-13).**

- *Rich clothing text everywhere* (not just the two image-model
  prompts): the scene **composer** prompt (the planning model that sees
  each present NPC's wardrobe) also uses description + appearance, for
  consistency. Visible garments render as `description (appearance)`
  with the name as fallback when a garment has no description; the
  appearance is **not** truncated. Hinted (sheer-covered) garments stay
  a compact name-only hint by design — a barely-visible layer should
  not pull full descriptive detail into the prompt.
- *Below-the-waist cutoff* = `pelvis` (hips/groin/buttocks) + `legs`
  (thighs/calves/ankles/feet/toes). Coverage-less props (jewelry) are
  unaffected and always show.

**Implemented (2026-06-13).**

- `contracts/body/locations.ts`: `belowWaistRootIds` (`["pelvis",
  "legs"]`), the derived `belowWaistLocationIds` set, and
  `isBelowWaist(id)`.
- `server/images/prompts.ts`: a private `formatGarment` helper
  (`description || name`, optional ` (appearance)`, untruncated) feeds
  `buildAvatarPrompt`, `wardrobeOutfitSummary` (final scene render),
  and `wardrobeLines` (composer). `AvatarOutfitItem`,
  `AvatarWardrobeItem`, and `SceneWornItem` carry optional
  `description`/`appearance`. `visibleAvatarOutfit` drops any garment
  whose coverage is non-empty and entirely below the waist.
- `server/images/avatar.ts`: `outfitExtrasSchema` parses
  `description`; `loadDefaultOutfit` threads `description` +
  `sensory.appearance` into each wardrobe item.
- `engine/pipeline.ts`: `buildSceneComposerContext` looks each visible
  view back up to its item definition and attaches
  `description`/`appearance` to the `SceneWornItem`.
- Bio/personality excerpts are unchanged (still truncated) — only
  clothing text is untruncated.

Tests: new pure cases for below-the-waist omission, full-length
garments staying, and description+appearance rendering across the
avatar, composer, and render prompts; docs/images.md updated.

Status: **closed (implemented).**
