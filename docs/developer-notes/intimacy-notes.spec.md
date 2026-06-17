# Intimacy notes — species/heritage + per-character disposition for intimate scenes — spec

Status: **draft / brainstorm, not implemented**. Graduated from a `TBD:` comment
in `src/contracts/species/catalog/faerie.ts` (the sprite record) on 2026-06-16.
Plan/build order: [intimacy-notes.plan.md](intimacy-notes.plan.md) — this doc is
the design truth it references. Plain-language first, with an _"under the hood"_
note per section.

Builds directly on the just-shipped **species note split** (`appearance` →
image+forge, `lore` → narrator) and the phase-4 **exposure mask** (the per-sense
intimate-tier gate). Read those first: [contracts.md](../contracts.md) §Body
model and
[intimate-anatomy-sensory-and-species-spec.phase4.md](intimate-anatomy-sensory-and-species-spec.phase4.md).

---

## The big idea (one paragraph)

A succubus, a sprite, and an ordinary shopkeeper do not behave the same way as
intimate partners — but that disposition is **only relevant once a scene actually
turns intimate**, and it is too sensitive to dump into the always-on personality
block. So we add a third **model-facing note** alongside `appearance` and `lore`:
an **`intimacy`** note, authored at the **species/heritage** level (how that kind
of being tends to read as a lover — innate temperament, instincts, quirks) and at
the **per-character** level (this individual's intimate disposition). The two
**merge** and are surfaced to the **narrator only when the turn's exposure mask
reaches the intimate tier** — invisible (and zero-token) in every ordinary scene.
This completes a clean trio of species notes, each with one audience and one
surfacing rule:

| Note | Audience | When surfaced |
|---|---|---|
| `appearance` | image models + forge | always (visual) |
| `lore` | narrator (canonical facts) | always (identity/culture) |
| **`intimacy`** | narrator | **only at the intimate exposure tier** |

> **Under the hood:** `intimacy` reuses the exact pattern the note split already
> established — an optional string on the species/heritage record + a resolver in
> `species/registry.ts` (`speciesIntimacyNote`, sibling to `speciesLorePhrase`),
> plus a new optional `profile.intimacy` on `characterProfileSchema`. The only
> genuinely new mechanic is the **gate**: a narrator block that emits nothing
> unless `engine/pipeline.ts`'s effective `ExposureMask` for the turn has crossed
> into `intimate`.

## Why a separate field, not just `personality` / `lore`

- **`personality`** is always in the prompt; intimate disposition is not wanted in
  a tavern negotiation and would bias every ordinary turn. Gating demands its own
  field.
- **`lore`** is identity/culture for the canonical-facts block — also always-on,
  and a different register (who they *are*, not how they *make love*).
- Keeping `intimacy` distinct lets the **content gate** live in one place: it is
  the only character/species text that is exposure-tier-gated, so a single block
  owns the rule.

## The two layers

### Species / heritage `intimacy` (the archetype)

A short model-facing note on the species (and, overriding it, the heritage) for
how members of that kind tend to read as partners. Examples:

- **succubus** — feeds intimately on her chosen mate; instinctively dominant and
  attuned to a partner's arousal.
- **sprite** (heritage) — *"mischievous and devious by nature; those who enjoy
  sass and very animated, playful intercourse find this makes them exciting
  lovers."* (the originating example)
- **human** — empty (the unmarked baseline; no archetype to assert).

> **Under the hood:** add `intimacy: z.string().default("")` to
> `heritageDefinitionSchema` **and** `speciesDefinitionSchema`
> (`src/contracts/species/types.ts`). Heritage **replaces** species (falls back to
> species when the heritage's is empty) — the same merge rule `lore` uses.
> `speciesIntimacyNote(speciesId, heritageId)` returns the resolved bare text
> ("" for human / unknown / unauthored). Unlike the other two helpers it returns
> **no label prefix** — the narrator block already names the character.

### Per-character `intimacy` (the individual)

`profile.intimacy` — this specific character's intimate disposition / preferences,
authored or forged. Merged **on top of** the species archetype (the species sets
the innate tendency; the character personalizes it).

> **Under the hood:** `intimacy: z.string().optional()` on
> `characterProfileSchema` (`src/contracts/world/profile.ts`). Optional ⇒ old rows
> and the save path (`characterProfileSchema` spread/merge) round-trip unchanged.

## When it surfaces — the exposure gate

The turn's effective `ExposureMask` (`brief.exposure`, possibly intent-raised by
`raiseExposureForIntent`) already drives every sensory permission in the narrator
prompt (`exposureRules`). The intimacy note rides the **same** signal.

- **Proposed trigger:** surface when **any axis reaches `intimate`** —
  `appearance === "intimate" || touch === "intimate" || taste === "intimate"`.
  Rationale: intimate *behavior* becomes relevant the moment the scene is
  physically intimate, even if line-of-sight detail (`appearance`) is still
  `close`. (See [Open questions](#open-questions) — the alternative is the
  narrower `appearance === "intimate"`, matching exactly where intimate *anatomy*
  detail unlocks.)
- Below the gate the block emits `""` — no tokens, no leakage.

> **Under the hood:** a new `buildIntimateDispositionBlock(bundle, exposure)` in
> `engine/scene.ts`, parallel to `buildCanonicalFactsBlock` /
> `buildGlanceImpressions`. For each **sight-present** NPC it composes
> `- <displayName>: <speciesIntimacyNote(species, heritage)> <profile.intimacy>`
> (each part optional), returns `""` when the gate is off or nothing is authored.
> Threaded into `buildTurnContext` (`engine/prompts/narrative.ts`) like the other
> blocks, built in `engine/pipeline.ts` where the effective mask is known.

## Merge semantics (summary)

- **species ↔ heritage:** heritage **replaces** species (fallback to species when
  empty) — identical to `lore`.
- **archetype ↔ character:** **append** — species/heritage note first, then the
  character's. Both contribute (innate tendency + individual). _Open question: vs
  character-overrides-archetype._

## Forge & editor

- **Forge:** the profile section (which already writes personality/voice) gains an
  optional `intimacy` line — short, tasteful, gated by the world's content
  setting. _Open question: always generate vs concept/rating-gated._
- **Editor:** an "Intimate disposition" textarea on the profile tab, beside
  Personality, hinted *"surfaces only when a scene turns intimate."*

## Out of scope

- **Per-relationship** intimacy ("how she is *with this partner specifically*") —
  a later layer; v1 is one note per character.
- Any **mechanic / meter** — this is narrative flavor only, never a stat.
- **Player** intimate disposition surfaced to the narrator — see open questions;
  v1 is NPC-only (the narrator's job is NPC portrayal).

## Open questions

- **Gate trigger** — any-axis-intimate (proposed) vs `appearance === "intimate"`
  only (matches intimate-anatomy unlock exactly)?
- **Archetype ↔ character merge** — append (proposed) vs character overrides?
- **Forge generation** — always (gated at surface) vs only when the concept/world
  rating calls for it?
- **Player note** — NPC-only (proposed) or also surface the player's own
  disposition to shape NPC reactions?
- **Field name** — `intimacy` (proposed) vs `intimateDisposition` / `boudoir`?
- **Helper shape** — bare text (proposed) vs labeled like the other two phrases?
- **Content rating** — does a world-level rating switch ever suppress the block
  entirely, independent of the exposure tier?
