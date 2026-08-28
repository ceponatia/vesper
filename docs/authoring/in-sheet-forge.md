# In-sheet forge: fill, re-draft, portrait

Three editor-side operations on a **saved** character's sheet. All share the save-first
discipline: the edit page flushes unsaved edits through the normal PATCH **before** any LLM spend,
and the generated result lands as an *unsaved* dirty draft, so the save bar is the review and undo
step.

The prose-prompt forge page stays — it creates whole characters from a prompt
([character-forge.md](character-forge.md)); these build parts of an existing sheet.

## Fill — "✦ Forge the rest"

`POST /api/characters/forge` with `mode: "fill"`. It runs the forge legs with the authored sheet
rendered as a fixed concept (`renderSheetConcept`, `server/authoring/character-fill.ts`), then
applies the pure fill-merge (`lib/character-fill.ts`). The merge is the guarantee; the prompt
directive is an optimization.

- Non-empty scalars are fixed; lists are additive.
- Attribute and trait ids present on the sheet are never touched.
- Preference targets are exclusive.
- Drives fill additively up to the 3-drive cap, deduped by want — authored drives never change
  (owner ruling 2026-07-12).
- The species, outfit, and schedule clusters move all-or-nothing. Species is adopted only while
  still at the blank-create default, so a bio reading "a succubus barmaid" adopts the species on an
  otherwise untouched sheet via the same inference as create mode. A daily rhythm is one coherent
  day, so any authored row keeps the whole set.
- The **starting relationship** is adopted only while still the untouched default — any authored
  band, text, or mask freezes the record (`isPlayerRelationshipUnset`).
- **Social cards** append deduped by label; authored cards never change.
- The outfit leg is skipped entirely, with no spend, when any garment is authored.

## Per-tab re-draft — "↻ Re-draft tab"

`mode: "redraft"` plus a `scope`: a **full re-sync** of ONE tab from the rest of the sheet (owner
ruling 2026-07-12), narrator-formatted — misplaced personality prose moves out of the bio, and
disposition re-reads off the authored text.

Five scopes (`lib/character-scopes.ts`: `profile` | `attributes` | `personality` | `disposition` |
`outfit`) map onto the three legs (`server/authoring/character-redraft.ts`). The scope merge takes
only the target tab's fields, and player-set (`manual`-provenance) attribute and trait values ARE
revisable — the unsaved-draft review is the safety net, and "Forge the rest" remains the fill-only
tool.

Two scope limits stand:

- The `profile` scope rewrites ONLY bio, personality, voice, and the intimate disposition — never
  name, age, aliases, or library tags. The voice micro-exemplars, the structured voice anchors, and
  the `profile.intimacy` note ride this prose scope too ([profile-leg.md](profile-leg.md)).
- A re-draft never changes the species cluster: that cascade is too destructive for a formatting
  pass.

One deliberate scope/tab mismatch: the `disposition` scope still owns `preferences` — they ride the
profile forge leg with tags and traits — even though the editor shows likes and dislikes on the
Personality tab, so a Disposition re-draft re-derives them. The scope also owns `drives`, since the
Desires & secrets card lives on that tab. Social cards are never re-drafted.

## Portrait → attributes — "◉ From portrait"

`POST /api/characters/:id/attributes/from-portrait`: the codebase's first image-understanding
capability (`server/authoring/portrait-attributes.ts`; the vision model via `visionModelId()`,
image parts through `generateChecked`'s `images` option).

It reads the character's **ready canonical avatar** — the id taken from the owned row, never the
client — fills **unset appearance attributes only** (the vocabulary excludes personality-tab and
intimate categories, and output grounds against the registry and realized body like every forge
leg), and returns **structured results**: the auto-filled list plus every disagreement with an
existing value as `{attributeId, label, current, proposed}`.

The editor auto-opens a **"Review portrait changes"** dialog: each conflict is a pre-checked
`current → proposed` row, and the auto-fills are listed read-only as the debugging window into what
the vision pass read. Apply overwrites the checked values on the draft.

Keyless demo mode degrades to a no-op — it never invents a "reading" of an image nobody looked at.
