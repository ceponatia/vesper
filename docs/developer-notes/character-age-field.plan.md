# Character real age vs apparent age

Status: **shipped — 2026-06-28**

Split a character's **real / chronological age** from how old they **look**, and
take apparent age out of the scene-image path so scene renders lean on the
portrait avatar as the source of truth for age.

## Problem

`identity.apparent_age` (an enum attribute: `forties`, `late_thirties`, …) was
doing double duty — it fed the **portrait studio** (correct: it's a visual band),
the **scene image generators** (wrong: it competes with the avatar reference the
scene edit is identity-locked to), and the **narrator** (wrong for the romance
cast: a 500-year-old succubus who reads late-thirties has a real age the narrator
should know). Age and apparent age aren't always aligned, but there was only one
field for both.

## Shape

- **New `profile.age`** — free text on `characterProfileSchema`
  (`src/contracts/world/profile.ts`), the character's *real* age. Free text so
  fantasy ages ("ancient", "312 years", "immortal") sit beside a plain number;
  `formatAge` reads a bare number as years (`"312"` → `"312 years old"`).
  `default("")` ⇒ old rows / pre-feature session snapshots parse unchanged and
  surface no age line (degraded-safe).
- **Narrator reads `age`, never apparent age.** `buildCanonicalFactsBlock`
  (`engine/scene.ts`) emits the real age; `buildGlanceImpressions` and the
  character-chat identity block (`engine/prompts/character-chat.ts`) drop
  `identity.apparent_age` entirely. Apparent age is no longer a narrator signal.
- **Scene image generators drop apparent age.** `characterAppearanceSummary`
  (`images/prompts.ts`) skips `identity.apparent_age` — scene composer + render
  textual descriptions no longer state an age band, so they defer to the avatar.
- **Portrait studio keeps apparent age.** `buildAvatarPrompt`'s subject line and
  the portrait-variant `PORTRAIT_IDENTITY_LOCK` are unchanged — apparent age is
  now a portrait-studio-only concept.
- **Authoring.** Profile-tab **Age** input (`character-editor.tsx`); the forge's
  profile section generates it (`character-forge.ts` schema + prompt + mapping +
  demo); harbor-house fixtures + the seed carry it.

## Why free text, not a number

The product is romance/fantasy-first (immortal beings, ancient mages); a number
field can't hold "ageless" / "centuries old". The narrator reads it as text
either way, and `formatAge` keeps bare numbers reading naturally.

## Deliberate call: narrator loses the apparent-age visual cue

Per the split, the narrator no longer sees apparent age at all. Appearance the
narrator still gets from the other attributes (hair/eyes/build via
`buildGlanceImpressions`) and from the avatar; how old a character *looks* is the
image stack's job now. Pre-feature characters with no `age` set surface no age
line until an author/forge fills it (apparent age is intentionally **not** a
fallback — that would re-conflate the two for exactly the characters this
separates).

## Touched

Contracts: `world/profile.ts` (`age` + `formatAge`). Engine: `scene.ts`,
`prompts/character-chat.ts`. Images: `prompts.ts`. Authoring:
`character-forge.ts`, `components/characters/character-editor.tsx`. Seed:
`scripts/fixtures/harbor-house.ts`, `scripts/db-seed.ts`. Docs: `images.md`,
`authoring.md`, `prompts.md`, `guide/creating-characters.md`. Tests:
`scene.test.ts`, `character-chat.test.ts`, `prompts.test.ts`.
