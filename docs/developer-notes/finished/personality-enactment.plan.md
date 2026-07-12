# Personality enactment — make the sliders (and age) drive dialogue & action

Status: **shipped — 2026-06-28**

The authored personality **sliders** (traits: warmth, guardedness, dominance,
composure, …) and the new real **age** field weren't visibly steering how
characters talk and act. This pass closes the gaps that made them inert,
focused on **character-chat first** (the iteration surface) and mirrored into
**session** play, which uses different code.

## Why they were inert

- **character-chat surfaced the sliders nowhere.** The chat prompt carried the
  free-text `personality` prose and the physical attributes, but the structured
  `profile.traits` were **never rendered** — a guarded/cold/dominant character
  read identically to a neutral one. (Root cause; the dominant one for testing.)
- **session surfaced them softly.** `buildDispositionBlock` rendered trait bands
  but headed them "play it consistently… never recite" — a consistency note, not
  an instruction to *enact* the temperament in word choice, what's said/done, or
  who leads.
- **age was a fact, not a driver.** Canonical facts / the chat identity line
  stated the age but nothing told the narrator to let age/life-stage shape
  diction, references, patience, or energy (`character-age-field.plan.md`).
- **agents:** the simulant got trait bands (soft); the **director** — which
  writes the next-turn `characterNotes`/`directives` — got none, so its steer
  could push a character against their temperament.

The trait→**state** math (`modulation.ts` slices 3/4/5 — affinity scaling, meter
baselines, decay retention) was already fully wired; the gap was the **prompt**
side (dialogue/action), not the numbers.

## What shipped

- **Shared renderer** — `dispositionBands(registry, traits, {intimateOnly})` in
  `contracts/personality/traits/disposition.ts` (pure). `engine/scene.ts`'s
  `dispositionParts` now delegates to it, and character-chat reuses it, so both
  surfaces render the sliders identically (no duplication).
- **character-chat** (`prompts/character-chat.ts`):
  - A **Disposition** section — everyday bands always; intimate bands behind a
    "When the moment turns intimate, these also drive you" framing (no exposure
    mask in chat, so the framing gates them).
  - Rule 5 rewritten to make Personality/Voice/Disposition **behavioral law**
    ("the two or three strongest pulls visibly shape THIS reply"); new Rule 6
    makes age/life-stage drive diction/energy.
- **session narrator**:
  - `buildDispositionBlock` heading is now an **ENACT** directive
    (`engine/scene.ts`).
  - New **Prose-style rule 7** (`prompts/narrative.ts`) — *Characterize from the
    blocks*: disposition drives behavior + age/life-stage drives diction.
- **director agent** (`prompts/agents.ts`, `agents.ts`): gets
  `presentDisposition` (present NPCs' bands) and **Rule 7** — characterNotes /
  directives must fit each character's temperament; never steer against it
  without an earned in-world cause. (DIRECTOR_SYSTEM char-budget bumped to fit.)

## Deliberately not in this pass

- **Per-character delta shaping by the simulant** beyond the existing
  `modulation.ts` math — the simulant already reads bands; reaction *magnitude*
  stays deterministic in the merge by design.
- **Continuity/Archivist disposition awareness** (they only flag/condense) — a
  candidate follow-up if out-of-temperament narration slips through.
- **Tuning** — wording is a first pass; the narration eval harness
  (`pnpm eval:narration`) is the place to measure whether slider extremes now
  visibly diverge, and re-tune.

## Touched

Contracts: `personality/traits/disposition.ts` (new) + `index.ts`. Engine:
`scene.ts`, `prompts/narrative.ts`, `prompts/character-chat.ts`,
`prompts/agents.ts`, `agents.ts`. Docs: `prompts.md`. Tests:
`character-chat.test.ts`, `narrative.test.ts`, `agents.test.ts`.

Related: [character-age-field.plan.md](character-age-field.plan.md) (the age
field this consumes).
