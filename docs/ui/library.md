# Library surfaces

The grids, editors and pickers behind `/characters`, `/personas`, `/locations`, `/items` and
`/social-cards`.

## Character editing and Forge review

The character editor keeps its useful completion action in the header, with Duplicate and Delete
under **Character actions**. The sticky save bar reports author edits and saving; generated
suggestions have their own explicit review surface. Character section navigation sticks beneath
the global header, with a compact selector on phones. Field ownership and generation scopes share
one registry ([../authoring/in-sheet-forge.md](../authoring/in-sheet-forge.md)). Optional voice
examples and anchors, daily rhythm, and intimate disposition use shared disclosures. Detailed
anatomy remains in the attribute accordion.

After a full Forge, the generated character leads the page. Section revisions stay beside the tabs;
the original brief remains available as authoring context. New and Forge share a recoverable
creation draft and preserve its selected destination when saving
([../authoring/character-forge.md](../authoring/character-forge.md)). Generation notes remain
available through a summarized disclosure. These surfaces share the same editor and form
primitives as manual authoring.

## The portrait studio

`components/characters/portrait-studio.tsx` generates the canonical avatar from attributes,
accumulates pose/outfit/expression/setting variants, and promotes any variant to canonical.

The empty studio presents the portrait, acceptance, and reference-review sequence beside its
generation and upload controls. A responsive portrait card becomes the working surface once
an image exists. **Portrait acceptance** states whether the portrait on screen is the one the character's
identity comes from, in three badge states — *Accepted* (it is), *Not accepted* ("Conversations
keep rendering the last accepted portrait until you accept this one", the state a newly generated,
uploaded or promoted portrait lands in), and *No accepted portrait* ("Use this portrait to establish
the character's appearance in new images") — with **Use this portrait** attached to the image, disabled and labelled
**Portrait in use** when it is already accepted. When the candidate differs, a second card shows
the exact accepted image. **Clear acceptance** sits in **Portrait actions** only when something
is accepted. The image source, model, and generation prompt sit under **Details**.
Accepting names the image on screen, so a portrait that changed in another tab is refused with
"The portrait changed — review the new one and accept again" and the studio refetches instead of
accepting a picture nobody looked at.

Below the portrait cards, the **Identity reference** block appears when an accepted image exists
(`identity-reference-panel.tsx`): a status chip for the character's identity pack plus **Adjust
face crop**, which opens `identity-crop-dialog.tsx` — a draggable, resizable square over the
**accepted** portrait with live preview, plain-language warnings, save/retry/reset actions, and (for
admins) the lazily-loaded revision-history and override inspector
(`identity-pack-inspector.tsx`; [../images/identity-packs.md](../images/identity-packs.md)).

Under that, the **Reference views** panel (`reference-views-panel.tsx`;
[../images/pipelines/reference-views.md](../images/pipelines/reference-views.md)): a grid grouped by
wardrobe state, one tile per angle in responsive equal-width columns. The empty sheet stays hidden
before the first portrait is accepted; existing attempts and live builds remain accessible if
acceptance is cleared. Each tile carries the view or a placeholder and a prominent angle and state
chip from the exhaustive state map in
`reference-view-copy.ts` — *not built*, *building…*, *needs your eye*, *approved*, *rejected*,
*failed*, *out of date* — plus the actions that state allows: **Review** opens the full-size viewer, **Regenerate** appears on
anything already attempted, and **Upload** sits in its **More** menu.
Review guidance appears once above the grid; actionable failures remain on their tile. Clicking a
tile's image opens it in the shared `ImageLightbox` ([conventions.md](conventions.md)
§Image lightbox), captioned with its angle and wardrobe. The viewer offers comparison with the
accepted portrait, previous/next, approval, rejection and undo. Opening or closing it alone changes
no verdict. Rejection can capture optional reasons and a correction retained with that attempt;
the notes are review history and do not alter generation prompts. A **Build N reference views**
button appears when a portrait is accepted and any
slot is missing, stale or failed, labelled with the count the server will actually render. The
panel polls while a build is live or any slot is pending. Loading and retrieval errors remain
visible, with a retry action; a failed refresh keeps the last loaded views on screen.

**Regeneration is a selection, not a queue the owner works through.** Every already-attempted tile
carries a checkbox; ticking any of them raises **Regenerate N selected views** and **Clear
selection** above the grid, and that action submits the whole selection as one request. The per-card
**Regenerate** is the same request with one target, so both paths are admitted, charged and run
identically. The submit action is disabled while a build is live for the character, hinted with the
busy-refusal line from the same copy map the tiles read, but the selection can still be assembled
meanwhile, and only the slots a batch actually claimed read busy. A queued batch clears the
selection; a refused one keeps it, so the owner never has to tick the same slots twice. N is the size
of the selection, and every other count on this panel comes from the reference-view registries and
the character's plan.

**History** sits with Upload in the **More** menu on every tile that has been attempted, and opens that slot's past
images (`reference-view-history.tsx`): a dialog over the sheet listing every image the slot has
produced, newest first, rendered and uploaded alike, each carrying a verdict chip — *approved*,
*rejected* or *never reviewed* — a marker on the one the tile is showing now, how it was made, and
when. Clicking an entry enlarges it in the same shared `ImageLightbox`, and closing the enlargement
returns to the list. **Use this version** restores an eligible image as a new, unreviewed
candidate; the original attempt's verdict and feedback remain history. Availability and
compatibility explanations sit beside ineligible entries. The dialog shows how many days a
replaced image keeps its bytes, derived from the retention window
([../images/pipelines/reference-views.md](../images/pipelines/reference-views.md) §Lifecycle).

Accepting a portrait reports what happened to the views in the accept toast: *Building N reference
views…*, or *Accepted, but the views were not built* with the reason and an invitation to build them
later. The acceptance always stands.

**Create a variant** folds the optional pose, outfit, expression, and setting controls.
The **Portrait history** grid keeps non-canonical avatar attempts and variants visible; failed
rows render as error cards using `images.meta.error` so provider failures do not vanish after
polling.

**Upload image** opens the crop dialog (`avatar-upload-dialog.tsx`): a modal whose helper text
states the 768×1024 (3:4) target, then lets the user drag to reposition and a slider or scroll to
zoom inside a 3:4 crop window before the framed region is scaled, saved, and set as the avatar —
synchronous and demo-safe
([../images/pipelines/avatar-upload.md](../images/pipelines/avatar-upload.md)).

## The persona editor

`components/personas/persona-editor.tsx` is **Profile · Body · Wardrobe** — three tabs against
the character editor's eight, because a persona has a body, a wardrobe and a bio but no
personality, disposition, drives, relationships or schedule (the narrator never writes the
player's lines).

It **embeds `AttributePicker` and `OutfitEditor` unchanged** — both are pure props-in,
callback-out over contract shapes with no `characterId` coupling — and the species/heritage
re-seeding rule is shared with the character editor via
`speciesChangePatch` / `heritageChangePatch` (`components/characters/attribute-helpers.ts`), not
copied.

Its Profile tab is the one place a **title collision** surfaces: `(owner_id, title)` is UNIQUE,
so a duplicate title returns a typed 409 that renders **inline on the Title field** (not a toast)
and holds the draft dirty. Autosave pauses until the title changes, since retrying the same
conflicting title every 1.5s would only churn 409s.

## Item and location editors

The library **item** and **location** editors are split into **Details · Image** tabs
(`components/ui/tabs.tsx`).

The item Details tab shows a **Type** select when the picked clothing category has a subtype
vocabulary — jewelry, headwear, eyewear
([../contracts/items/README.md](../contracts/items/README.md) §Clothing subtypes). Picking one pre-fills
coverage like a category template, and cards and rows chip the type instead of the broad
category.

The Image tab is a minimal studio (`components/library/entity-image-studio.tsx`, shared by
both): a Generate/Regenerate button and the current image with click-to-enlarge — no variants, no
upload, regenerate if you dislike it. Generation runs as a background job and the tab polls until
it lands, so leaving the page never interrupts it. Items get a 1:1 product photo; locations a 3:2
establishing shot whose type follows the location's scale
([../images/pipelines/entity-images.md](../images/pipelines/entity-images.md)).

The **location** editor's Details tab carries the full location design, at parity with the world
map tab: **Scale**, **Area**, and a **Connections** section — undirected links to other library
locations added through the shared `EntityPickerDialog` (search + thumbnails), shown as removable
tags. Connections persist as `location_links` and propagate into a world's map when the linked
set is imported ([../database/README.md](../database/README.md)).

Every lean library editor (items, locations, social cards — every branch, including loading and
error) opens with a **`← <Library>` back link** (`components/library/back-link.tsx`,
`.touch-target` on phones) returning to its grid, the mobile escape hatch; the grid restores the
toolbar state the user left.

## The shared library grid

`components/library/entity-library.tsx` is config-driven per entity. The **Items** library is the
full faceted browse:

- Segmented **Clothing · Object · Container** buckets (live counts; no "All" — the page opens
  straight into Clothing, the closet view), then **registry-backed facet chip rows** that adapt to
  the bucket. Clothing gets category / wearer / layer chips plus color **swatches**; objects get
  subtype chips (`components/library/item-facets.ts`; wearer follows `wearerMatchesFilter`, so
  absent or unisex garments match every wearer chip). Facets filter the loaded set client-side
  with counts scoped to the other active filters; options absent from the data are hidden.
  Switching buckets clears facet picks.
- With nothing narrowing, the grid renders **grouped sections** — Clothing by category (the
  "closet" view), Object by subtype; any search, tag or facet goes flat. A single section renders
  flat too, since one group is noise rather than organization. The `buckets.defaultId` config also
  suppresses "All" and sets the initial bucket; items is the only entity using it, and
  social-cards still opens on "All".
- A **grid ⇄ list toggle** (persisted per entity in `localStorage`) swaps the rich cards for
  compact rows — small thumb, name, structured chips (category/subtype + color dot), tags — for
  hundreds-of-items scale, plus a **sort** select (Recent first / By name, applied server-side).
- The rest of the toolbar state (bucket, scope, sort, search, tags, facet picks) persists **per
  entity in `sessionStorage`**, restored through the lazy state initializers on mount — so
  opening an editor and coming back (its back link, the nav, or browser back) lands on the same
  view. Stored buckets and facet options absent from the vocabulary are dropped at read time, since
  a stale pick would silently empty the grid. **New** creates in the active bucket — a blank
  clothing item from the Clothing view, a taboo card from the Taboo tab (`config.create` receives
  the bucket; "All" falls back to the schema default).
- Free tags sit behind a **Tags** panel: multi-select chips (comma-joined into the `tag` param,
  ANDed server-side via jsonb containment), with a filter input past 15 tags. **Machine tags**
  (`suggested`, `seed:*`) are hidden from every filter UI and card chip row (`lib/tags.ts`); the
  data keeps them.
- Characters and items get a hover-revealed **Duplicate** action on cards and rows (the
  `config.clone` seam → the kind's `/clone` endpoint; it works on public entries too —
  copy-on-use) that opens the copy's editor. The character editor's **Character actions** menu and
  the item editor SaveBar carry the same **Duplicate**, save-first like the Forge. Wardrobe near-variants ("same
  top in three colors") and archetype characters start here.
- **New** opens the shared creation draft for characters. Other entity kinds are created
  immediately with a **randomized placeholder name** ("Untitled item
  k3f7" — concurrent drafts never collide) and routes to its editor: create-on-new means a draft
  can never be lost before its first save.
- **Editor autosave** (`components/hooks/use-autosave.ts`): the character and item editors save
  silently ~1.5s after the last change, and immediately when focus leaves a field (`onBlur` on
  the editable container — free text lands on field exit, never mid-typing). The Save button
  stays as a loud manual flush, and `beforeunload` warns only while something is unsaved or in
  flight. Character AI suggestions stay outside the authored draft until explicitly accepted, so
  pending review does not pause ordinary edits. The item editor retains its own staged-draft
  review through the SaveBar. Advisory inline validation never blocks: empty Name, a
  drive with a blank want, a schedule row with a blank activity ("this row is dropped on save").
- **Attribute accordion summaries**: each collapsed section header previews its set values
  ("auburn, shoulder-length, wavy"), prioritizing defining appearance from the registry's visual
  tiers. Long previews wrap to two lines with a secondary count; unauthored sections read *empty*.
  This shared picker gives characters and personas the same scannable appearance summaries.
- **Generate images** (Items and Locations): ids visible under the active filter that lack an
  image → confirm dialog → background batch, the grid polls, and the button is hidden on an empty
  library. Items adds **Organize** beside it — the facet classify backfill: visible items missing a
  facet go to `POST /api/items/classify`, a background `item_classify` job fills **only absent**
  category/layer/wearer/color/subtype fields from name and description via a cheap model
  (`server/api/item-classify.ts`), and the grid polls as chunks land. Present values are never
  overwritten, so it is always safe to press again.

## Facets on the other libraries

`components/library/library-facets.ts` runs the same `FacetDef` machinery, which grew an optional
multi-value `values` accessor: **characters** get species and gender (the natal-sex `…_born_*`
variants collapse into one browse chip), **locations** get scale, and **social cards** get
severity-tier plus trigger-concept chips — with matching card chips (a character's notable
species, a location's scale, a card's tier plus first triggers) and the grid ⇄ list toggle on all
of them.

The list payloads carry the facet columns explicitly: `/api/characters` SQL-extracts `speciesId`
and the `identity.gender` attribute value from the profile jsonb, and `/api/locations` ships
`scale` — keeping the explicit-columns posture rather than shipping whole jsonb blobs.

Server-side, the items list API takes the same facets as query params
(`category` / `subtype` / `layer` / `wearer` / `color`, plus `sort` and comma-ANDed `tag`),
applied **before** the result cap in `searchLibraryIds`, which is what the pickers lean on. List
endpoints select explicit columns — a bare row would ship the 1536-dim search embedding to the
browser. **Every shareable kind honors `?scope=all|public|owned` and `?sort`**, and the row
SELECTs widen to owner-or-public so the discovery scopes can return another owner's published
rows.

## Pickers

`components/library/entity-picker.tsx`: `EntityPickerDialog` is the one search-and-pick surface
behind every "add from library" flow — debounced server search, thumbnails, per-row structured
chips, optional **facet chip rows** that re-query, a **grouped empty-query browse** (clothing by
category), and a **multi-select basket mode** (pick several, confirm once).

Call sites: the character outfit tab, location connections, and the social-card import. The
**new-chat dialog** keeps its bespoke avatar grid, but its filter input re-queries the server
(`q`) rather than narrowing the capped first page
(`components/hooks/use-debounced-value.ts`).

## The outfit tab

`components/characters/outfit-editor.tsx` is a **preset switcher over wardrobe slots**
(`profile.outfits`, which supersedes a single `defaultOutfit`; legacy rows lift into an "Everyday"
preset at parse). Named looks — casual, work, date night, sleep — are selectable chips, the
**first preset is the default** (what the forge targets, the avatar wears, and a fresh chat starts
in), with add / rename / duplicate / make-default / delete controls.

The selected preset's items edit as wardrobe **slots** — Tops & dresses · Bottoms · Underwear ·
Footwear · Accessories (`lib/clothing-slots.ts`, a pure category→slot map; unresolved or
uncategorized references land in "Other"). Each slot's **+ Add** opens the EntityPicker
pre-filtered to that slot's categories **and the character's wearer target** (from
`identity.gender` via `wearerHintForGender`; always overridable in the picker's facet chips), so a
long clothing library arrives as "the tops that fit her". Empty slots read "Nothing worn." A
trailing "+ Add from the whole wardrobe…" opens the unscoped picker.

The Profile tab's Daily-rhythm rows gain a **Wearing** preset pick — rhythm auto-dress, so a
pickup skip landing in that window dresses the character for it. The chat Character sheet carries
a **structured Wardrobe editor** (`components/characters/chat-wardrobe-editor.tsx`) reusing this
same slot and picker design over the conversation's worn item ids
([conversation.md](conversation.md)).
