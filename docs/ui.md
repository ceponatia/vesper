# UI

Next.js App Router pages + React 19 + Tailwind 4. Aesthetic: quiet dark "reading room" — ink background, warm paper accents, serif narrative type (`Source Serif 4` or similar variable font), sans UI chrome. Design tokens in `globals.css` `@theme`; no component library — small owned primitives in `src/components/ui/`.

## Pages

```
/                        Dashboard: continue-session hero, recent worlds, cast strip
/worlds                  Library grid (search/tags)
/worlds/forge            Prose prompt → draft review (tabs: premise/map/lore/cast/items) → save
/worlds/:id              Detail: synopsis, cast, map, lore, sessions; "Begin session"
/worlds/:id/edit         Same review UI as forge, loaded from saved world
/characters              Library grid
/characters/forge        Prose prompt → draft review → save
/characters/:id          Editor: profile · attributes (registry picker) · outfit · portrait studio
/locations, /locations/:id   Lean library + editor
/items, /items/:id           Lean library + editor
/sessions/new            Wizard: world → embodiment (play a character / observer) → title
/sessions/:id            The play screen
```

The world review/editor map tab (`components/worlds/world-editor.tsx`) renders each location as a collapsible card — the header is a real button (`aria-expanded`, caret) showing name, tags, and a scale/area hint; multiple cards can be open at once, existing cards load collapsed, and new/copied cards open expanded. Cards reorder by native HTML5 drag (grip handle, drop-indicator line) with per-card move up/down buttons as the keyboard-accessible path; the order is authored data, written as the array index to `world_locations.sort` on save and read back ordered everywhere (detail, edit, spawn). A per-card Copy duplicates the place itself (description, tags, scale, area, ambient) but not the name (left empty — duplicates break save resolution), links, or the library/world row references. Links are undirected at runtime, so each card also lists incoming connections added on other locations as read-only text, and adding a link whose reverse already exists is refused with a brief inline note instead of creating a doubled edge.

The world review/editor cast tab (`components/worlds/world-editor.tsx`) carries per-member relationship rows — a `toward` select (other cast names + "player", with a "(missing)" option keeping unresolved names visible) and a stage select fed by the `contracts/relationships/stages` registry (stages, never numbers), with add/remove affordances. Renaming a cast member rewrites other members' `toward` pointers, the same way map renames follow location links. When the cast would spawn more than `MAJOR_TIER_SOFT_CAP` (6) major-tier members, the tab shows a non-blocking warn-toned notice — the count uses `lib/cast-tiers.ts` (the same rule `engine/spawn.ts` applies: companions left at the default minor tier spawn as major), and spawn emits the matching `spawn.cast.major_soft_cap` diagnostic; nothing is ever blocked or trimmed. Scale and tier select options are derived from the contract enums in `lib/client/api.ts` (`worldLocationScaleSchema` / `worldCastTierSchema`), not inline literals.

## The play screen

Three regions:

1. **Feed** (center): narrator prose (serif, `*italic*`/`**bold**` inline rendering, no markdown lib) interleaved with character bubbles (avatar, name) and player messages (right-aligned). Streaming segments render live by `segmentIndex`. Hover actions per turn: edit / delete / rerun. Scroll pinning: *pinned* means the viewport bottom is within ~80px of the feed bottom; while pinned, new content auto-scrolls. When unpinned (reader scrolled up), new turns **append to the loaded range without refetching or moving the viewport**, and the "Jump to latest" pill appears — the reader is never yanked. The one exception: sending your own message re-pins (the echo appearing is the submit signal), so the reply always streams in view. Older history loads via the `?before` cursor; completing a turn never resets the cursor.
2. **Composer** (bottom): input with author mode — *player* (speak/act), *director* (out-of-world instruction), *companion* (pick an NPC to take the turn). Disabled with a subtle status line while the session is `narrating`/`processing`.
3. **Side panel** (right, tabbed):
   - **Scene**: current scene image, gallery, generate-now, interval control. Clicking the image opens `ImageLightbox` (`ui/image-lightbox.tsx`, also used by the portrait studio): full-screen enlarged view over a darkened backdrop, Escape/backdrop-click to close.
   - **Cast**: per-participant accordion cards — the header is a real button (`aria-expanded`); clicking expands the card in place, clicking again collapses it, and at most one card is expanded at a time. Collapsed: portrait, activity, tier chip (major/minor/extra, from the status payload), meters (compact bars), active conditions, visible outfit. Expanded adds the full inventory — every worn layer from the payload's `wornFull` list with hidden-under-other-layers items marked as such (`wardrobe` keeps its visibility-filtered semantics) — **dev-only display**: before production the expanded list must filter hidden layers so players can't see under-layers the fiction hides (UI-only change; the shared visibility resolution and state are unaffected — followups.phase2.md #7) — plus held items, the remaining time on timed conditions, and the character's current location when they're not co-located with the player. Expanded non-player cards also carry an **Inner note** section: a compact textarea (placeholder spells out the contract — inject a memory, feeling, or belief, never dialogue or actions) and submit button, disabled while submitting; accepted notes toast "«Name» will carry this from the next turn" (processing is a non-blocking background job — [turn-engine.md](turn-engine.md) §Jobs, [memory.md](memory.md) §Authored interior facts), errors toast the API message. Non-player cards show the NPC's relationship stage toward the player ("Friendly toward you", from `/relationships`; no edge reads as Stranger) plus what the NPC believes the player feels ("thinks you're friendly toward them") — the perceived line is hidden while the pair is mutually stranger (feeling stage stranger and perceived edge absent-or-stranger, where it carries no information); once either side shows a non-stranger signal both lines render, a missing perceived row displaying as "stranger" (`components/play/cast-relationship.ts`). Stage labels come from the `contracts/relationships/stages` registry; raw affinity values are never shown.
   - **World**: game clock with the latest turn's advance beside it ("+20m — Shower"; the generic "scene" cause renders as just "+20m", old turns without a delta render nothing), current location + items/containers, narrator model dropdown (options from the shared curated list in `lib/narrative-models.ts` — the same source the server's resolver defaults from; writes the world's `narrativeModel` via world PATCH; `/status` reports the resolved id, and an id outside the list renders as-is), open story threads.
   - **Inspector** (dev users only): per-turn agent results, diagnostics, retrieval scores.

## Conventions

- Server components fetch; client components interact. Data flows in through route handlers already shaped for the view (no client-side joins).
- Client data layer: plain `fetch` + small hooks (`useSessionStatus`, `useTurnStream`); no react-query unless pain demands it.
- Every async surface has a skeleton + error state; images always have the monogram fallback; missing/legacy data renders as absent, not broken ([resilience.md](resilience.md) §7).
- Forms: controlled state + zod validation on submit; shared `Field` primitives; sticky save bar with dirty-state indication on long editors (the old `EditPageChrome` pattern, rebuilt). Editor drafts seed from fetched data **exactly once per entity** (`components/hooks/draft-seed.ts`, applied during render): refetches and silent reloads never clobber in-progress edits, and navigating between entities drops the stale draft until the new one loads.
