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

## 2. Portrait studio: upload a profile image with crop/reposition (2026-06-13)

**Request (user).** Let users upload their own picture in the
characters portrait studio. Scale and crop it to the avatar
dimensions; if it needs cropping, show a modal where the user can
resize and move the image inside a crop window. The upload modal's
helper text should state the target dimensions and that cropping is
available.

**Assessment.** The avatar is 3:4. The whole pipeline already exists
(row-before-file assets, sharp webp conversion, `promoteVariant`) — an
upload is just a new buffer source that skips the model, so it also
works in demo mode / offline. Cropping is best done client-side (the
user frames it visually); the server re-fits as defense in depth.

**Implemented (2026-06-13).**

- *Shared dimensions + pure crop geometry* —
  `src/lib/images/crop.ts`: `AVATAR_WIDTH=768`, `AVATAR_HEIGHT=1024`,
  and pure helpers (`coverScale`, `displaySize`, `clampOffset`,
  `centeredOffset`, `sourceRect`, `aspectMatches`) so the live CSS
  preview and the output canvas are computed from the same numbers —
  what the user frames is exactly what is saved. 7 pure tests
  (`crop.test.ts`).
- *Crop dialog* — `components/characters/avatar-upload-dialog.tsx`: a
  `Dialog` that opens on a file picker (drop-zone + helper text naming
  the 768×1024 / 3:4 target), then — only when the file isn't already
  3:4 (`aspectMatches`) — shows a 3:4 crop window with pointer-drag
  pan, a zoom slider, and non-passive wheel zoom. "Use image" renders
  the framed region to a JPEG data URL. An already-3:4 image skips the
  crop step and uploads directly.
- *Server* — `server/images/upload.ts` `uploadAvatar`: decode the data
  URL, sharp `cover` resize to 768×1024 with EXIF `rotate()`, save via
  the normal row-before-file path (`kind: "avatar"`,
  `meta.source: "upload"`), promote to the character's avatar.
  Degrades with diagnostics on a bad data URL / undecodable image
  (`images.upload.bad_data_url`, `images.upload.decode_failed`) — the
  asset row is marked failed, never thrown.
- *Route + client* — `POST /api/characters/:id/avatar/upload`
  (synchronous, returns the new `avatarImageId`, 201);
  `charactersApi.uploadAvatar`. The studio refetches immediately, no
  polling.
- 2 integration tests (`assets.int.test.ts`): a 1200×800 source
  cropped to 768×1024 + promoted, and a non-image payload rejected
  without writing a row.

**Design notes / deviations.** Transport is a base64 JPEG data URL over
the existing JSON `apiPost` (the client always sends a small cropped
~768×1024 image, never the raw file), avoiding a multipart helper. An
upload becomes the canonical avatar immediately (the obvious intent of
"upload a profile picture"); a later generate/upload pushes the prior
one into the variant grid. The portrait-variant "outfit" path's
wardrobe-reconciliation gap (followups §earlier note) is unrelated and
untouched.

Status: **closed (implemented).**

## 3. Scene tab: "Here with you" present-cast section (2026-06-13)

**Request (user).** On the session Scene tab, below the scene-image
controls, show cast cards for the characters at the player's active
location (excluding the player) — a quick read on who can be interacted
with — reusing the exact Cast-tab cards.

**Implemented (2026-06-13).**

- Extracted the Cast tab's `ParticipantCard` (and its private helpers
  `MeterBar`/`SectionTitle`/`InnerNoteSection`/`stageLabel`) into
  `components/play/participant-card.tsx` so both tabs render the
  identical card with zero duplication; `cast-tab.tsx` now imports it.
- `scene-tab.tsx` gains a `PresentCast` section under the generate /
  auto-generate controls: co-located NPCs (composer.tsx's filter —
  `locationId` match when known, include otherwise; player excluded via
  `isUser` + `role`), each as a `ParticipantCard` with its own
  accordion and the same `sessionsApi.relationships` fetch keyed on the
  clock as the Cast tab. Heading "Here with you" with the current
  location name; empty state "No one else is at this location."

Pure presentational reuse — no schema, route, or data-shape change.
Gates: typecheck + lint clean, full pure suite green. docs/ui.md
updated.

Status: **closed (implemented).**
