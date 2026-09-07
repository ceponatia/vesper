# In-sheet forge: fill, rewrite, portrait

Character generation returns suggestions for a human to review. Ordinary edits keep their
normal save behavior while generated proposals remain separate until accepted. The same editor
sections serve newly forged drafts and saved characters.

## Owns / does not own

This page owns the section boundaries and merge guarantees for completing and rewriting a
character. [character-forge.md](character-forge.md) owns whole-character creation;
[manual-editing.md](manual-editing.md) owns the manual controls. Portrait production and reference
review belong to [../ui/library.md](../ui/library.md).

## Shared section contract

`lib/character-scopes.ts` defines labels, field ownership, generation legs, output keys and detail
counts. The editor uses those definitions for section navigation and actions. Counts describe
authored details; an empty optional section is not a validation failure.

- **Profile** owns background bio and daily rhythm. Name, real age, aliases, library tags and
  species controls live here but remain fixed during section generation.
- **Appearance** owns physical attributes and optional intimate anatomy. Established body
  configuration stays fixed. Attribute values, including manually authored ones, are reviewable
  during a rewrite.
- **Voice & manner** owns voice notes, examples, anchors and expression attributes. It runs the
  profile and attribute legs in parallel, each constrained to its own portion.
- **Personality** owns personality prose, intimate disposition, preferences, social cards,
  disposition tags, traits and drives.
- **Relationships** owns the player's starting relationship and premise note. Library links on
  the same section are stored separately, require **Save library relationships**, and are outside
  generation. Both relationship defaults apply to newly created conversations.
- **Outfit** owns outfit presets and suggested garments.

The stable scope identifiers are `profile`, `attributes`, `personality`, `disposition`,
`relationships` and `outfit`; labels are presentation, not generation routing keys. The original
creation brief remains part of generation context and is never rewritten by a section action.

The profile leg requests only a scope's declared output fields. The attribute leg constrains its
schema vocabulary to the selected section. Grounding uses the existing registry rules, and the
shared scope merge is the authoritative boundary even when a provider returns extra data.

## Complete missing details

`POST /api/characters/forge` with `mode: "fill"` accepts an optional `scope`. A scope completes
only its visible fields; omitting it completes the whole sheet. The server and client apply the
same additive merge, so a value entered during generation also survives.

- Non-empty scalars stay fixed. Text lists append with deduplication.
- Existing attribute and trait ids never change; preference targets remain exclusive.
- Drives append up to their cap, deduped by want. Existing cards stay intact and new cards dedupe
  by label.
- Any authored garment preserves the entire outfit cluster. Any authored schedule row preserves
  the entire daily rhythm, avoiding overlapping generated windows.
- The player relationship fills only while its bands, text, mask and flags are all at the blank
  default. Changing any part preserves the whole record.
- Whole-sheet fill can infer a species only while its body cluster is at the blank-create default.
  Scoped fill never changes species, body plan, name or real age.
- Whole-sheet fill skips the outfit leg when garments already exist.

## Rewrite this section

`mode: "redraft"` requires a `scope`. It proposes replacements for the selected section,
including manually authored text, attributes and traits. It does not rewrite identity facts,
body configuration, the creation brief or unrelated sections.

Generated changes enter explicit proposal review. Accept applies the chosen changes, Reject
leaves the authored draft alone, and Undo restores accepted values where subsequent edits do not
conflict. A save indicator is not a substitute for generation review.

## Complete using portrait

`POST /api/characters/:id/attributes/from-portrait` reads the owned character's ready canonical
avatar. It proposes only visible appearance attributes, excluding expression and intimate
categories. Registry grounding returns proposed additions and structured disagreements with
existing values for review before acceptance.

Keyless demo mode is a no-op for portrait understanding; it never invents an image reading.
