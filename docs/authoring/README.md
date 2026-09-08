# Authoring (AI-first, human-final)

`apps/web/src/server/authoring/` plus the forge pages. The principle: **the AI drafts, the human
owns.** Every field an agent fills is editable before and after save; nothing is locked behind
generation.

## Reading order

| Doc                                      | What it covers                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| [character-forge.md](character-forge.md) | `POST /api/characters/forge`: species matching, the attribute and outfit legs |
| [profile-leg.md](profile-leg.md)         | Everything the profile agent drafts and how each family is grounded           |
| [in-sheet-forge.md](in-sheet-forge.md)   | Fill, per-tab re-draft, and portrait → attributes on a saved sheet            |
| [social-cards.md](social-cards.md)       | The social-reaction card contract, severity ramp, triggers, and storage       |
| [manual-editing.md](manual-editing.md)   | The manual editors every entity carries, outfit presets, narrator glosses     |

## Saving drafts (draft → create-input)

A forge **draft** and a create endpoint's **input** are different shapes by design: drafts use
names and suggestions, inputs use ids and definitions. Every forge ships a typed conversion, and
the create endpoints use `.strict()` bodies — a draft posted to a create route is a loud 400
(`invalid_body`), never a silently empty save. Do not add a forge without its conversion path.

For a **character**, the create body **and the PATCH body** carry `suggestedItems`, because the
in-sheet forge drafts them on an existing character whose save is a PATCH.
`materializeSuggestedItems` (`server/api/library.ts`) turns them into library items — reuse by
name, then a conservative embedding backstop, with the `suggested` tag — and appends the ids to
the character's default outfit preset ([character-forge.md](character-forge.md) §Saving a draft).

## Guardrails

- **All** forge agent outputs validate against registry and contract schemas — attribute ids, body
  locations, trait ids, preference targets, social-card triggers. A failed field or section is
  omitted from the draft with a diagnostic shown inline ("couldn't draft — regenerate or write
  manually"), never a broken draft. Each section regenerates independently via `generateChecked`
  (validate → one repair → omit).
- Diagnostics render severity-aware (`components/forge/diagnostic-list.tsx`): **error** is a
  failure with the regenerate call-to-action, **warn** is a degradation already applied (a dropped
  or cleared value), and **info** is a muted notice that the forge pages hide entirely. A
  successful repair round-trip is info — recovery is not a problem to report loudly.
- Model-written cross-references resolve through `fuzzyResolveName` (exact →
  punctuation-normalized → unique containment); genuine misses are dropped with a "did you mean"
  hint in the diagnostic.
- New and Forge share a recoverable creation draft. The original creation brief remains
  available across section revisions; saving creates the library character. Draft persistence
  and destination handling belong to [character-forge.md](character-forge.md).
- Generated revisions are proposals until explicitly accepted. Ordinary author edits continue
  autosaving independently; saving or starting another operation never accepts a proposal.
  [in-sheet-forge.md](in-sheet-forge.md) owns completion, rewrite, review, and undo semantics.
- Forge calls are rate-limited per user — cheap insurance, since they are the most expensive
  non-play operations.
