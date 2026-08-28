# Manual editing

Every entity has a full manual editor — the forge review UI *is* the editor. AI-entered values are
visually marked (`source: "creation"` versus `"manual"`) until touched; provenance is already in
the data model.

## The character editor

- **Profile fields** plus a **species picker** that sets `speciesId` / `bodyPlanId`, selects any
  default subtype, and seeds species and subtype default `bodyFeatures` (succubus wings, horns,
  tail). Species overlays normally render as **Heritage**, while Android renders the same control
  as **Subtype** (Synthetic default or Organic).
- The **attribute picker** is registry-driven and a **single-open accordion**: every section starts
  collapsed, expanding one collapses the rest, and an open section shows **every** applicable
  attribute as a row. Set values edit in place; unset ones render blank controls — an enum "—"
  option, inactive chips, a dimmed slider — that write a value on first interaction, keeping
  storage sparse with no "add attribute" select. Intimate and body-feature toggles gate
  anatomy-specific groups and join the same accordion.
- The **Disposition** tab leads with the **"Desires & secrets" card** — up to 3 drives, each with
  want, why and secrecy plus a reveal-gate band picker on secrets (`DrivesEditor`; a row saved with
  an empty want drops alone at the trust boundary, never wiping the list). Below it sits the social
  disposition: per-trait **sliders** grouped by category with a live band readout (intimate traits
  labelled), plus a disposition-tag editor autocompleting the canonical registry. A slider edit
  writes a `manual`-source trait value that wins resolution over the forge's `creation` value.
- The **Personality** tab holds the expression and bearing attribute picker, the bespoke
  likes/dislikes list (concept or family target, like or dislike, 1–10 intensity, optional reaction
  hint — `PreferencesEditor`), and the **social-reaction cards** editor — the character's own
  taboos and social rules, with severity→tier, trigger concepts and tag-override flips, plus
  Import-from and Save-to the `/social-cards` library ([social-cards.md](social-cards.md)).
- The **Profile** tab also carries an **Intimate disposition** textarea (`profile.intimacy`, beside
  Voice notes, hinted *"surfaces only when a scene turns intimate"*) and the **"Daily rhythm"
  card** (`ScheduleEditor` — rows, not a timetable grid): each row a day-part preset
  (Morning/Afternoon/Evening/Night, or Custom with time inputs, where an earlier end wraps past
  midnight) plus activity, place and optional weekday chips (empty and full masks both normalize to
  "every day"). A row saved with a blank activity or place drops alone at the trust boundary — an
  element-wise catch on `profile.schedule` — never wiping the list.
- Then the outfit builder and the portrait studio
  ([../ui/library.md](../ui/library.md) §The portrait studio).

## Outfit presets

`profile.outfits` replaces the older single `defaultOutfit`: named looks `[{id, name, items}]`,
the first being the default. Legacy `defaultOutfit` rows lift into a single "Everyday" preset in
the profile schema's preprocess — a lazy migration, since writers only write `outfits` and zod
key-stripping drops the dead key on the next save.

Helpers in `contracts/world/profile.ts`: `resolveOutfitPreset` (named-or-default, unknown ids
degrade), `outfitItems`, `outfitPresetByName`, and `withItemsInDefaultOutfit` (the forge append).
The forge outfit leg drafts the default preset, with `matchOutfitAgainstLibrary` underneath.

Schedule rows may carry `outfitPresetId` for rhythm auto-dress (`rhythmOutfitPatch` in
`engine/chat-state.ts` re-dresses on chat time-skips), and the chat archivist's outfit tracking maps
"changes into her work clothes" onto the preset via `matchOutfitPresetInText` — conservative: an
exact name, or a name plus an outfit word.

## The item editor

The item editor header carries **✦ Draft from description**, the classify seam extended into
authoring. `POST /api/items/draft` proposes category, layer, wearer, color and opacity, **explicit
coverage with carve-outs**, and the three sensory lines from name and description. The server
grounds every proposal against the registries (`groundItemDraft` in
`server/api/item-classify.ts` — unknown ids drop per field, coverage explodes to the explicit-id
convention, intimate locations are filtered), and the client fill-merges **empty fields only** into
the unsaved form, so the SaveBar stays the review step. It is stateless: nothing is written
server-side.

## Per-value narrator glosses

`narratorGuidance` ([../contracts/attributes.md](../contracts/attributes.md)): authoring one is a
registry data edit in the attribute's category file, never a migration.

Glosses are **sparse by design** — gloss only members that are ambiguous or game-calibrated
(`cheesy`, `feral`, `heady`); self-evident ones (`average`, `clean`) stay bare, and exhaustive
glossing is rejected because it bloats prompts back toward list-shipping.

Keep a gloss short (≈≤12 words), in the trait-band hint voice — sensory or behavioral cues the
narrator can show, not dictionary definitions — and **orthogonal**, covering only its own
attribute's dimension. In-dimension ordinal context like "slimmer than lean" is fine;
"tall-reading" in a frame gloss is an entangled-vocabulary bug to fix in `allowedValues`.

One authored string serves three consumers: read-side prompts render it inline beside the value,
`describeConstraint` shows it to the forge per choice, and the attribute picker surfaces it as the
option or chip tooltip.
