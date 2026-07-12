# Library UX — faceted browse, item facets, shared entity picker

Status: **shipped — 2026-07-12** — core pass built 2026-07-08 (commit
`4add351`, all seven slices below), deployed to Fly the same day; core review
passed 2026-07-12 and the **§Follow-up pass was built + shipped the same day**:
other-library facets (characters species/gender/world-usage, locations
scale/world-usage, social-card tier/trigger — `library-facets.ts`), the tabbed
Gallery image hub (scenes/portraits/entity art, view modes, avatar chip
filters, favorites migration 0036, multi-select delete, keyset paging), the
Library nav hub (Chats · Worlds · Library · Gallery + shared collection tab
strip), and the scope+sort fast-follow (all shareable list APIs honor
`?scope`/`?sort` end-to-end). Leftover: **list keyset pagination** stays
deferred until real catalog scale (facet-scoped caps removed the worst
truncation). Docs: `docs/ui.md` §library grid/pickers + §Pages/§Mobile,
`docs/images.md` §Gallery, `docs/contracts/items.md` §Wearer/§Color,
`docs/guide/creating-items.md`.

The library list pages and every "pick an entity" form flow lean entirely on
free-form tags and flat capped lists, while the data model already carries the
structure that should organize them (clothing `category`, object `subtype`,
`layer`, `opacity`). This plan surfaces that structure, adds the two missing
clothing facets the owner asked for (**gender target** and **primary color**),
and replaces the flat pickers with one searchable, facet-aware component.

Origin: 2026-07-08 UX review of `/items`, `/characters`, `/locations`,
`/social-cards`, `/gallery` and all picker call sites (live Fly site + code
map). Key findings:

- `/items` at 43 items already renders a 35-chip flat tag cloud mixing garment
  types, styles, occasions, and machine bookkeeping (`suggested`, `seed:*`).
  Single-select tag filter, no sort, jumbo cards (~8/screen).
- Clothing `category` (15-entry registry) and object `subtype` (10) exist in
  `itemDefinitionSchema` but are neither populated by seed/forge flows nor
  surfaced anywhere in list UI or filters.
- Pickers split two ways: three call sites use the searchable
  `LibraryPickerDialog` (world cast, world item placement, social-card import);
  the rest are flat dumps of the capped list — the character **outfit tab is a
  native `<select>` over every clothing item**, location connections likewise,
  and the new-chat dialog / session wizard grids filter client-side only.
- `LIST_LIMIT = 100` + no pagination silently truncates at production scale.
- List endpoints (`/api/items`, `/api/characters`) return bare `select()` rows
  — including the 1536-dim `search_embedding` vector, megabytes of dead payload.

## Owner rulings (2026-07-08)

- **Core first, then pause**: this pass ships the items browse rework, the new
  facets end-to-end (contracts → editor → forge → backfill), and the shared
  picker. The rest (below, §Follow-up pass) is approved in direction but waits
  for review of the core.
- **Library nav hub: yes** — Chats · Worlds · Library · Gallery, with the four
  collection pages as tabs inside one shell (follow-up pass).
- **Gallery: tabbed image hub** — Scenes · Portraits · Entity art (follow-up
  pass).
- Subagents on this work run Opus/Sonnet, never Fable.

## New item facets (contracts)

Both live in the `items.definition` jsonb — **no DB migration**. Vocabulary is
registry-file data per the registry doctrine.

- **`wearer`** (clothing): `"feminine" | "masculine" | "unisex"` via a small
  registry (`contracts/items/wearer.ts` — id + label, extensible for future
  values e.g. per-species fits). Optional; **absent = unspecified, treated as
  unisex by filters**. Filter semantics: the "Women's" facet matches
  `feminine ∪ unisex ∪ absent`; same shape for "Men's"; "Unisex" matches
  `unisex ∪ absent`. Unisex is additive, never a third silo — this is what
  makes the facet work for gender-neutral characters too.
- **`color`**: `{ family, shade?, accent? }` — `family`/`accent` are ids from a
  new `contracts/items/colors.ts` registry (~15 families, each with a `swatch`
  hex for UI chips/dots; UI-only, never prompts), `shade` is free text
  ("aqua", "olive") preserved for display and image prompts. Applies to any
  item kind (a red car sorts too); primary UI surface is clothing.

Contract fields stay lenient strings with `.catch(undefined)` (same posture as
`category`/`subtype`); editors offer only registry values, filters match
strings, unknown values render as absent.

## Core pass — slices

1. **Contracts** — `colors.ts` + `wearer.ts` registries, `itemDefinitionSchema`
   `wearer`/`color` fields, `itemExtrasSchema` pick-list, client
   `itemDefinitionPartsSchema` mirror; `itemSummarySchema` gains the definition
   parts (the route already ships `definition`; the client schema just drops
   it today). Unit tests.
2. **Server list API** — `searchLibraryIds` item facet options (`category`,
   `subtype`, `layer`, `wearer` with the unisex/absent semantics,
   `colorFamily` — jsonb `->>'` conditions applied **before the cap**, same
   correctness rationale as the existing `itemKind`), multi-tag AND
   (`tag` param accepts comma-separated values), `sort=updated|name`.
   `/api/items` passes them through and **selects explicit columns** (drops
   `search_embedding` from list payloads; same fix for `/api/characters` +
   `/api/locations` while there). Int tests.
3. **Items library UI** — `entity-library.tsx` grows config-driven facet
   support (generic `FacetDef`: options + card-value + optional match override
   + per-bucket visibility — the follow-up pass reuses this for the other
   libraries):
   - facet chip rows under the kind buckets: clothing → category chips, layer,
     wearer, color swatches; object → subtype chips; counts from the loaded
     set.
   - **Grouped sections when no facet/search is active**: All → by kind;
     Clothing → by category ("closet" view); Object → by subtype. Flat results
     whenever a facet, tag, or search narrows.
   - **Grid ⇄ list density toggle** (persisted, `lib` pattern like nav-mode):
     list = compact rows (small thumb, name, category/layer chip, color dot,
     wearer, tags) for hundreds-of-items scale.
   - free tags demoted to a collapsible **"More filters"** multi-select panel
     with its own filter input; **machine tags** (`suggested`, `seed:*`) hidden
     from all filter UI and card chips (pure helper `lib/tags.ts`).
   - sort dropdown (Recent / Name).
4. **Editor + forge write the facets** — item editor: Wearer select (clothing)
   + Color family/shade row (all kinds). Character-forge outfit agent: garment
   schema + prompt gain `wearer` (from the character's presentation) and
   `color`; `materializeSuggestedItems` persists them.
5. **Classify backfill** — owner-triggered **"Organize items"** button on
   `/items` (beside Generate images): background job over the owner's items,
   filling **only absent** facet fields (clothing: category/layer/wearer/color;
   object: subtype/color) from name+description via a cheap model through the
   `server/ai` gateway; per-item degradation diagnostics; grid polls while it
   runs. Never overwrites a present value, so it's safe to re-run.
6. **Shared `EntityPicker`** — `library-picker.tsx` evolved (renamed
   `entity-picker.tsx`, old export removed): thumbnails (`EntityImage`), chip
   metadata per row, optional facet chip row (config per call site), grouped
   empty-query state (clothing by category), **multi-select basket mode**
   (pick several, confirm once). Call sites:
   - **outfit tab** becomes slot-aware: current outfit grouped by slot
     (Tops / Bottoms / Underwear / Footwear / Accessories — a pure
     category→slot map in `lib/clothing-slots.ts`), per-slot "+ Add" opening
     the picker pre-filtered to that slot's categories **and the character's
     gender target + unisex** (from the gender attribute; overridable in the
     picker). Empty-slot hints fall out free.
   - location connections select → single-pick EntityPicker with search.
   - world cast / world items / social-card import migrate to the same
     component (same UX, richer rows).
   - **new-chat dialog + session wizard keep their bespoke avatar/card grids**
     (good UX) but their filter inputs re-query the server (`q`) instead of
     filtering the capped 100 client-side.
7. **Docs + verify per slice** — `docs/ui.md`, `docs/contracts/items.md`,
   `docs/guide/creating-items.md`; `pnpm verify` green; conventional commit
   per slice.

## Owner UX pass (2026-07-11, shipped)

Two owner requests against the deployed core pass, built directly:

- **Bucket-aware New** — `EntityConfig.create` now receives the active type
  bucket, so New creates a blank item of the kind being browsed (items:
  bucket id = kind; social cards: `definition.kind`, "All" falls back to the
  schema default). Previously every new item was born an `object` even from
  the Clothing view.
- **Editor back link + restored view** — every lean library editor (items,
  locations, social cards; all branches incl. loading/error) opens with a
  `← <Library>` breadcrumb (`components/library/back-link.tsx`,
  `.touch-target`) — the mobile escape hatch that previously required the nav
  menu — and the grid persists its whole toolbar state (bucket, scope, sort,
  search, tags, facets) per entity in sessionStorage, restored via lazy state
  initializers, so any way back lands on the view the user left. Stale
  buckets/facet options are dropped at read time. (Chosen over the lightbox
  editor idea: the editors are deep tabbed pages — image studio, coverage
  tree, save bar — that fit modals poorly on mobile, and route-based editing
  keeps URLs deep-linkable; state restoration covers the "return with my
  settings" requirement for every path back, not just a modal close.)

## Follow-up pass (approved direction; built + shipped 2026-07-12 — all but list pagination)

- **Facets for the other libraries** on the slice-3 machinery: characters
  (species, gender, world-usage), locations (scale, world-usage), social cards
  (severity tier, trigger concept; tier/trigger chips on cards).
- **Gallery → tabbed image hub** (Scenes · Portraits · Entity art) + view
  modes (session/character/world/timeline), avatar chip filters, multi-select
  delete, favorites (needs a tiny migration), pagination past the 500 cap.
- **Library nav hub** — header becomes Chats · Worlds · Library · Gallery;
  collection routes unchanged, shared tab strip; mobile More-sheet slims down.
- **Scope tabs fast-follow** — `/api/characters`, `/api/locations`,
  `/api/items` honor `scope` (the auth.plan.md deferral; social cards already
  do).
- **List pagination** — keyset (`updated_at`,`id`) "Load more" past
  `LIST_LIMIT`; facet-scoped caps (core pass) remove the worst truncation, so
  this waits for real catalog scale.

## Open questions

_None blocking. Two recorded judgment calls:_

- Chip counts are computed from the loaded (capped) set; exact once pagination
  lands. Acceptable at current scale.
- The picker's "recently used" strip collapsed into the default recency
  ordering of the grouped empty-query state — a separate strip only earns its
  space once libraries are large enough that groups push recent items below
  the fold.
