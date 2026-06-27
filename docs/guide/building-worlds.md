# Building worlds

## Forge from a premise

1. **Worlds → Forge**, give it a premise. Agents draft the premise, map, lore, cast and item placements; each tab regenerates independently.
2. Diagnostics above the tabs are severity-coded: red means a section failed (regenerate or write it manually), amber means something was dropped or adjusted (e.g. a hallucinated map link — near-miss names are auto-resolved, real misses get a "did you mean" hint), muted/none means fine.
3. **Cast tab**: suggestions are either *library match* (linked to a saved character) or *new stub*. Use **+ From library** to add saved characters, **Link to library…** to attach a stub to one, or leave stubs for generation. Renaming a linked member unlinks it on purpose.
4. **Items tab**: placements live at a location or with a cast member (worn only works for clothing on someone). **+ From library** places saved items; a placement whose name matches a library item reuses it on save.
5. **Save world**. New cast stubs are forged into real characters during the save (capped at 5 — expect it to take a minute; the page says so). If a generation fails, the member is saved as a skeletal `stub`-tagged character with the concept note as bio — fix or regenerate it from the character library. Nothing fails the save.

## Editing a saved world

**World page → Edit** opens the same tabbed editor, loaded from the saved rows. Saves go through the same pipeline: cast/items/locations are resolved, library rows are reused (linked locations keep their base row — your edits become world-local overrides), and new stubs forge just like on create.

## Deleting

Deleting a world is refused with `in_use` while sessions reference it — delete the sessions first (see [running-sessions.md](running-sessions.md)).
