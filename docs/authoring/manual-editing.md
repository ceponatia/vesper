# Manual editing

Every entity has a full manual editor — the forge review UI *is* the editor. AI-entered values are
visually marked (`source: "creation"` versus `"manual"`) until touched; provenance is already in
the data model.

## Owns / does not own

This page owns manual editing and the character suggestion review boundary. Creation-draft
persistence and original concept capture belong to [character-forge.md](character-forge.md).
Image generation and reference-image approval belong to [../ui/library.md](../ui/library.md).

## The character editor

The section registry owns placement, generation scopes and section detail counts:

- **Profile** contains identity, biography and Daily rhythm. Schedule rows describe activity,
  place, day-part or custom times and optional weekdays. An incomplete row drops independently.
- **Appearance** contains body configuration and physical attributes. The registry-driven picker
  shows applicable attributes with explicit empty values, preserving sparse storage. Species and
  subtype changes seed their body defaults; anatomy toggles control the applicable attribute rows.
- **Voice & manner** contains voice notes, voice anchors, dialogue examples and expression or
  bearing attributes.
- **Personality** contains personality and intimate-disposition prose, desires and secrets,
  traits, disposition tags, preferences and social-reaction cards. Intimate disposition reaches
  narration only in an intimate scene. Trait edits carry manual provenance.
- **Outfit** contains named outfit presets and pending garment suggestions.
- **Relationships** contains the character's starting relationship toward the player and saved
  links to other library characters. The latter keep their dedicated replace-set save operation.
- **Portrait** opens Portrait Studio. **Chat** contains narrator choice and the chat entry point.
  Narrator choice joins the character's ordinary authoring save queue.

## Reviewing character suggestions

- **Complete missing details** fills absent values. **Rewrite this section** can propose changes
  to authored values within the selected section. The visible section and generation scope agree.
- Completion, section rewrites, Forge regeneration and portrait-derived attributes return a
  reviewable proposal. The author draft stays unchanged until an explicit acceptance. The first
  full Forge of an untouched blank draft opens the editable preview directly; Create is its
  review boundary. Any author edits made during that request instead require proposal review.
- The review displays before and proposed values, with independent choices per change. Attributes
  and traits compare by id; provenance-only differences do not request an approval.
- Changes made during generation or review survive. A proposal changes only fields that differ
  from its original snapshot. Conflicting values require an explicit choice between the current
  and proposed value before acceptance can proceed.
- Rejecting a proposal changes no authored value. Review later keeps the proposal pending.
  Saving, changing tabs and starting another generation never accept an earlier proposal.
- Ordinary saved-character edits autosave during generation and while proposals wait. Explicit
  saves and narrator-model changes share the same serialized write queue; a save response does
  not clear the dirty state of edits made while it was in flight.
- Undo offers the inverse of the last accepted changes through the same conflict review. Later
  independent edits survive; later edits to the same field require a choice. Materialized outfit
  item ids join the undo receipt. Undo removes their character references, not the library items.
- Pending reviews and the undo receipt persist in browser storage under the authenticated account
  and character. Account or character navigation resets the editor and guards late async results.
  Reviews saved on this device are not synchronized between devices.

## Outfit presets

`profile.outfits` replaces the older single `defaultOutfit`: named looks `[{id, name, items}]`,
the first being the default. Legacy `defaultOutfit` rows lift into a single "Everyday" preset in
the profile schema's preprocess — a lazy migration, since writers only write `outfits` and zod
key-stripping drops the dead key on the next save.

Helpers in `contracts/world/profile.ts`: `resolveOutfitPreset` (named-or-default, unknown ids
degrade), `outfitItems`, `outfitPresetByName`, and `withItemsInDefaultOutfit` (the forge append).
The forge outfit leg drafts the default preset, with `matchOutfitAgainstLibrary` underneath.

Schedule rows may carry `outfitPresetId` for rhythm auto-dress (`rhythmOutfitPatch` in
`engine/chat-state/time.ts` re-dresses on chat time-skips), and the chat archivist's outfit tracking maps
"changes into her work clothes" onto the preset via `matchOutfitPresetInText` — conservative: an
exact name, or a name plus an outfit word.

## The item editor

The item editor header carries **✦ Draft from description**, the classify seam extended into
authoring. `POST /api/items/draft` proposes category, layer, wearer, color and opacity, **explicit
coverage with carve-outs**, a headwear **hair-occlusion override** when the description clearly
departs from the type default, and the three sensory lines from name and description. The server
grounds every proposal against the registries (`groundItemDraft` in
`server/api/item-classify.ts` — unknown ids drop per field, coverage explodes to the explicit-id
convention, intimate locations are filtered, a hair-occlusion band survives only for headwear and
only when it differs from the subtype default), and the client fill-merges **empty fields only**
into the unsaved form (`mergeItemDraft`, `lib/items/draft-merge.ts`), so the SaveBar stays the
review step. It is stateless: nothing is written server-side.

For headwear the editor shows a **Hair occlusion** select beside the type: "Use type default"
names the band the type resolves to and clears the override; `none` / `partial` / `full` store one
([../contracts/items/README.md](../contracts/items/README.md) §Hair occlusion). Changing the
category clears it with the subtype, and the save drops it on any non-headwear category.

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
