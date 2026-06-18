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

## 4. Image generators for items & locations + library/location follow-ons (2026-06-13)

**Request (user).** A larger batch, delivered in parts:

1. Add a portrait-studio-style **image generator** to the Items and
   Locations editors. Items → product photos (clothing/objects/
   furniture); locations → the right kind of shot (landscape outdoors,
   interior indoors), using the location **scale** to decide.
2. Add the **missing location-design fields** from the Worlds map tab
   to the standalone Locations editor — **connections, area, scale** —
   and (user ruling) **propagate connections into a world** when those
   locations are imported.
3. The Items **library** needs **Clothing / Object / Container** tabs
   (shadcn-informed design) for visual browsing.
4. On **saving a new world**, auto-generate every missing image
   (avatars, items, locations) in **background** jobs that survive
   navigation — and (user ruling) only for entities whose `imageId` is
   **null**, so reused library entities keep their existing image.

**Ruling (user).** The per-entity studios stay minimal: **generate
only** (Flux-2), no Venice variant edits, no upload; regenerate if you
dislike the result; click the image to enlarge.

**Part 1 implemented (2026-06-13) — entity image studios.**

- `server/images/entity.ts` `generateEntityImage({ entityKind, entityId,
  userId })`: prompt from fields → `kind: "entity"` asset → generate
  (demo monogram) → set the row's `imageId` and reclaim all other images
  for that entity (single image, no gallery). Prompt builders in
  `prompts.ts`: `buildItemImagePrompt` (catalog product shot; clothing
  on a ghost mannequin, 1:1) and `buildLocationImagePrompt` (landscape
  for `open`/`expanse`, interior otherwise; 3:2, no people).
- `POST/GET /api/{items,locations}/:id/image` (background `entity_image`
  job + latest-row poll); `itemsApi`/`locationsApi` `.image`/
  `.generateImage`.
- `components/library/entity-image-studio.tsx` (shared): Generate/
  Regenerate + click-to-enlarge, polls while pending. Wired into the
  item/location editors behind new **Details · Image** tabs.
- Tests: 4 pure (prompt builders), 2 integration (generate + regenerate
  reclaim for item; location establishing image). docs/images.md +
  ui.md updated.

**Part 3 + library batch implemented (2026-06-13).** The Items library
gains an **All / Clothing / Object / Container** segmented bucket filter
(live counts, shadcn-informed segmented control; client-side filter by
`kind`). The Items and Locations libraries gain a **Generate images**
button beside "New blank": it gathers the ids visible under the active
filter still missing an image, confirms via a dialog naming the count
(Ok/Cancel), then `POST /api/{items,locations}/images` (id-scoped) runs
`generateEntityImagesBatch` in parallel batches of 5 in a background job;
the grid polls so images appear as they land. `missingEntityImageIds`
gained an `ids` scope; +1 integration test (only-missing batch). User
follow-ons folded in: batch respects the selected bucket; confirm modal.

**Part 4 implemented (2026-06-13) — new-world auto-generation.** The two
world-create routes (`POST /api/worlds/from-draft`, `POST /api/worlds`)
fire `queueWorldImageGeneration` (worlds.ts): one background job that
backfills every still-missing image the new world references — cast
avatars (`generateAvatarsBatch`, new in avatar.ts) + item/location images
(`generateEntityImagesBatch`) — in parallel batches of 5, **only where
the image is null** (reused library entities keep theirs; a reused entity
with no image still gets one — user ruling). Fired from the route, not
`createWorld`, so direct-call tests don't spawn image work. +1
integration test (avatar batch). docs/images.md updated.

**Part 2 implemented (2026-06-13) — location library fields +
propagation.** The standalone Locations editor reaches parity with the
world map tab: **Scale** (was a column, now exposed), **Area** (new
`locations.area` column), and **Connections** — undirected links to other
library locations, stored in a new **`location_links`** table
(`drizzle/0001_*.sql`). Server: `locationCreate/PatchSchema` gain
scale/area/links; the location PATCH reconciles links
(`setLocationLinks`/`loadLocationLinks`/`connectedLocationIds` in
library.ts) and the GET returns them. Client: `locationDetailSchema` +
the editor's Connections picker (dropdown of other library locations,
removable tags). **World propagation (user option B):**
`materializeLocations` recreates `location_links` between imported library
locations as `world_links`, deduped against authored links. +3
integration tests (link reconcile ×2, world propagation). docs/database.md
+ ui.md updated.

Status: **all parts (1–4 + library batch) closed.** §5 (world edit-save
location duplication) remains queued.

## 5. World edit-save duplicates library locations (queued fix, 2026-06-13)

**Observed (user).** Many duplicate library locations — "Bayview Clinic
Exam Room 2" (×6), "Bayview Clinic Break Room" (×4) — all with images.

**Investigation (read-only, prod DB).** The image-generation button is
**not** the cause: the entity-image pipeline only `SELECT`s locations and
`UPDATE`s `imageId`; it never inserts a `locations` row. The owner has **1
world but 28 library locations, 10 orphaned** (no `world_locations`
link); the orphans are exactly the redundant copies (Exam Room 2 ×5,
Break Room ×3, a renamed "Breakroom", a stray "Brian's Office"). The
still-linked copy was created on a later re-save, not at world creation.

**Root cause (committed code).** `updateWorld` (worlds.ts:511) **deletes
all `world_locations` and re-materializes** on every save;
`materializeLocations` reuses a library row **only when the draft location
carries a `locationId`** (line 229), else `INSERT`s a new one (235). The
world **edit page seeds its draft exactly once** (`world-edit-page.tsx`)
and never re-seeds after a save — so a location **added in the editor**
(or renamed) has no `locationId`, never learns the id its first save
assigned, and is re-created (and the prior copy orphaned) on every
subsequent save. The "Generate images" batch then filled images for all
the orphans, which is why they became newly visible.

**Fix applied (2026-06-13) — server-side reuse-by-name.** `updateWorld`
captures the world's `effective-name → library-id` map **before** it
deletes `world_locations` (`existingLibraryIdByName`) and threads it into
`materializeLocations` as `reuseLibraryIdByName`. A draft location with no
`locationId` whose name matches one this world already created now reuses
and refreshes that library row instead of inserting a duplicate. Covered
by a new integration test (re-save a name-only location twice → one
library row) and the existing world-update route test (now asserts the
re-sent "Quay" reuses, `+0` library rows, not `+1`).

Residual: **renaming** an editor-added location across saves still misses
the name match and orphans the old-name row once (the lone one-word
"Breakroom" orphan). The complete rename-safe fix is the client carrying
each location's `locationId` back into the draft after a save (so it
rides the existing `locationId` reuse path) — left as a smaller follow-on.

**Cleanup of the existing 10 orphans:** done separately (a targeted
delete of orphaned library locations whose name matches a still-linked
one); the lone uniquely-named "Breakroom" handled by hand.

Status: **fixed (re-save dedup); rename-residual + client round-trip
remain a smaller follow-on.**

## 6. Scene images keep a removed top on the character (bare-region phrasing, 2026-06-14)

**Observed (user).** A scene render "suddenly" keeps characters in a
shirt even after the top was removed in-session and only an undershirt
remains.

**Investigation.** Not a regression — nothing in the image/wardrobe path
or the image-model defaults changed since the early commits
([../images.md](../images.md)). The cause is a design gap: both the scene
composer prompt and the render prompt **only ever enumerate worn
garments** (`wardrobeOutfitSummary`), and never assert that a body region
is *bare*. Image models default every subject to fully clothed, and the
Venice **edit** path is additionally anchored to the (fully-dressed)
canonical avatar — so a removed outer layer produces no visible change.
Two sub-cases: (a) garment fully removed → no "exposed" signal exists at
all; (b) swapped down to a lesser garment → the edit re-paints the
heavier reference clothing.

**Verdict.** Make the prompt assert coverage state positively, not just
list garments.

**Fix applied (2026-06-14).**
- `exposedRegions` (`contracts/items/visibility.ts`) classifies torso
  (`chest`), lower body (`pelvis`), legs (`thighs`), feet — `covered` /
  `sheer` / `bare` — from worn coverage, reusing the same expand rule as
  `resolveWardrobeVisibility`.
- `formatExposure` (`server/images/prompts.ts`) turns that into explicit
  phrasing ("topless, bare chest", "bare below the waist", "bare legs",
  "barefoot", or a single "fully nude"). Injected into the composer line,
  the reference block, and textual others. **head/hands omitted** (bare
  there is the default and would fire on everyone); **feet included by
  user choice** — and since pants stop at `ankles`, an NPC with no
  modelled footwear reads barefoot (accepted trade-off; drop `feet` from
  `formatExposure` to revert).
- Gated on `wardrobeTracked` (NPC owns ≥1 garment, worn or removed), set
  in `buildSceneComposerContext` — a world that never modelled clothing
  reads as *unknown*, never nude.
- Render prompt now closes with "depict each person in exactly the
  clothing described … add no garment that is not listed" so the edit
  model can't restore a shed garment from the reference (sub-case b).
- Covered by `exposedRegions` / `formatExposure` unit tests and new
  `buildSceneRenderPrompt` cases.

Not applied to the **avatar** pipeline (it builds from the default outfit,
not live session state); easy to extend with the same helper if wanted.

**Follow-on (same day) — Venice 1500-char prompt limit.** Clicking
"generate" in a session ("NM Test") started then stopped with no image
and no surfaced error. The job recorded `done`; the **image row** was
`failed` with `venice 400: Prompt exceeds 1500 character limit for model
'qwen-edit-uncensored'`. `renderSceneImage` catches the 400, marks the row
failed, and returns — so the session never errors and the UI just stops.
The prompt was **1592** chars: a four-garment outfit with **untruncated**
descriptions (§1) dominated it, and the clothing-authority clause above
tipped an already-borderline prompt (~1480) over. Root issue: the render
prompt had **no length budget** for Venice's hard 1500 cap (flux
text-to-image is far roomier). Fix: shortened the authority clause and gave
`buildSceneRenderPrompt` a budget on the reference-edit path
(`VENICE_RENDER_PROMPT_LIMIT`) — it progressively excerpts the outfit and
setting text until the prompt fits, with a word-boundary hard clamp as a
final net; identity lock, POV rule, pose, and bare-region phrasing are
never dropped. Text-to-image is left unbudgeted. Covered by two new
`buildSceneRenderPrompt` tests (rich outfit on the Venice path stays
≤1500; t2i keeps full detail).

Status: **fixed** (bare-region phrasing + Venice length budget).
