# Face jewelry, accessory subtypes & the attribute-form accordion

Status: active — started 2026-07-11 (owner request, planned in-session)

Owner batch of refinements around clothing/jewelry fidelity and the character
attributes tab. Rulings captured 2026-07-11 (Q&A in session):

- **Outfit picker keeps its hard slot scope** — the shipped library-UX behavior
  (slot-scoped picker + wearer pre-filter) is what the owner wanted; no change.
- **Registry defaults are stored at creation**, not display-only.
- **Piercings and jewelry keep distinct roles** — attributes describe the
  piercing holes (permanent body detail), jewelry items are the removable
  things worn in them; prompts mention both when present.
- **Subtype vocabularies for jewelry, headwear AND eyewear**, each in its own
  schema file under `contracts/items/` so they're easy to find and extend.

## Slices

1. **Lips + nose body locations** — `contracts/body/locations/everyday.ts`
   gains `lips` and `nose` under `face` (coverageRelevant). No migration:
   coverage expands per-id, so stored exploded sets and bare `face` coverage
   imply the new children automatically. The item form's coverage tree and the
   humanoid body plan pick them up from the registry.
2. **Accessory subtypes** — per-category vocabulary files
   `jewelry-subtypes.ts` / `headwear-subtypes.ts` / `eyewear-subtypes.ts` +
   a `clothing-subtypes.ts` aggregator (`clothingSubtypesForCategory`,
   `clothingSubtypeById`), reusing the existing `definition.subtype` field
   (previously objects-only). Each subtype may carry a coverage template
   (lip ring → `["lips"]`, choker → `["neck"]`, blindfold → `["eyes"]`);
   picking one in the item form pre-fills coverage the way categories do.
   The clothing item form shows a **Type** select when the category has a
   vocabulary; the classify backfill fills absent subtypes for those
   categories (and `MISSING_FACETS_SQL` / the library's `isMissingFacets`
   count them as missing).
   **Unlike category ids, subtype labels ARE prompt-bearing**: the avatar
   prompt's garment phrasing and the session narrator's Visible-wardrobe
   block lead with the subtype label ("nose ring — thin gold hoop"), which is
   the whole point — the image model was misreading bare jewelry names.
3. **Nose + lip piercing attributes** — new `nose` category (shape, size,
   piercings) + `lips.piercings`, following `ears.piercings`' "the jewelry
   itself is wardrobe" split. `ears.piercings` leaves the avatar-prompt omit
   list (face jewelry made it earn its tokens); `nose` joins the appearance
   category order next to face/lips.
4. **Registry defaults stored at creation** — `defaultValue` on
   `attributeDefinitionSchema`, curated (female-leaning where gendered) on the
   seven `coreVisual` attributes (gender=female, apparent_age=mid_twenties,
   height=average, frame=slight, eyes=brown, hair=brown, skin=light). A pure
   `seedCoreVisualDefaultValues` fills absent ones inside `POST
   /api/characters`, so blank characters are born with them (forge drafts
   already carry values — the seed is a no-op there). The **forge keeps its
   hash-varied unconstrained picks** (deliberate: fixed defaults would
   converge every unspecified character on the same look); registry defaults
   are for blank creation and the editor seed only.
5. **Attributes-tab accordion** — all sections collapsed initially; opening
   one closes the others (single-open, includes the Pelvis area and the
   body-config/features override sections); an open section renders **every**
   applicable attribute as a row (the "+ Add attribute…" select is gone).
   Unset rows show blank controls — enum select with a "—" option, empty
   text, inactive chips, unchecked flag, dimmed slider that sets on first
   drag — and setting/clearing moves a row between set and blank without
   losing sparseness (values stay sparse in storage). Forge-filled sheets
   simply show their values; collapse behavior is identical.

## Open questions

_None — the four rulings above closed them._
