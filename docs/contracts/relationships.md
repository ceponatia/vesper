[← Contracts index](README.md)

# Relationships and disposition

Two related systems live here: **relationships** (how an NPC feels about the player, as a number with readable stage labels) and **disposition** (an NPC's authored personality — traits, preferences, and tags that shape how they react).

## Relationship stages

Affinity is a single number from −100 to 100. `relationships/stages.ts` puts readable labels over it — **eleven stages**, widened from the original seven in personality Slice 5 for finer, romance-leaning progression:

```
hostile · wary · cool · stranger · acquaintance · friendly · warm · close · cherished · devoted · smitten
```

(`stranger` still straddles 0.) The boundaries are data. `stageForValue()` maps a value to its stage; `stageMidpoint()` seeds authored edges.

> **Stages, never raw numbers, go in prompts and gate behavior.**

**Authored edges** (`relationships/authored.ts`) — the entry stored on `world_cast.relationships`:

```ts
{ toward, stage }
```

`toward` is a cast display name or the literal `"player"` (resolved case-insensitively at spawn); `stage` is a registry stage id. Unknown ids self-heal to `stranger` (= no seeded row), and the JSONB list reads through `parseOr` with fallback `[]`.

**Bond classification** (`relationships/bond.ts`) — `classifyBond(text)` is a deterministic keyword pass over a cast member's concept/bio text that classifies the player bond:

| Result | Triggers |
| --- | --- |
| `mutual` | Named kinds: family, sibling, partner, spouse, friend, coworker, … |
| `first-meeting` | "never met", "first meeting", "strangers" — **beats** mutual keywords |
| `indeterminate` | Nothing matched. |

Spawn seeds the NPC's `perceived` edge from this: `mutual` and `indeterminate` mirror the feeling midpoint, `first-meeting` seeds no row (`server/engine/relationship-seeds.ts`).

## Disposition (personality)

`contracts/personality/` holds an NPC's authored disposition: **atomic traits** that parameterize dynamics, plus **social reactions** decided deterministically (`docs/developer-notes/personality-and-state.spec.md` §3/§6). Everything here is registries + pure resolvers, all IO-free.

### Interaction concepts (`interactions.ts`)

The controlled vocabulary the intake agent classifies a player's social act into — `compliment`, `gift`, `flirt`, `insult`, `jealousy_trigger`, … Each concept carries:

| Property | Purpose |
| --- | --- |
| `verb` | Phrasing for the reaction line. |
| `family` | A cluster a preference may target wholesale (e.g. `affection_display`). |
| `polarity` | `warm` / `hostile` / `neutral` — the act's affective direction, read by the puppet guardrail. |
| `triggers` | Classifier keywords. |
| `intimate` | Whether the act is intimate. |

It is one stable classification target and the shared key space for preferences and (later) cards. Adding a concept is one data edit + the registry test.

### Disposition tags (`tags.ts`)

A **dev-defined canonical registry** of reusable labels (`bratty`, `prudish`, `foot-fetish-positive`) that social-reaction **cards** key their overrides on. Each tag carries the first slice of machine-readable affect:

- a `warmth` lean — `cold` / `neutral` / `warm`, and
- a `wontInitiate` list of concept families the character would not spontaneously perform — the signal the **puppet guardrail** reads.

The editor/forge autocomplete from this registry. Free-form tags are tolerated but second-class — carrying no machine affect, they're invisible to the guardrail. `normalizeTag` / `canonicalTagId` map free text onto the canonical id. **Social-reaction cards** (`cards.ts`, shipped `social-reaction-cards.plan.md`) key their `reactionOverrides` on these tags — the foot-fetish flip: a `foot-fetish` taboo defaults to revulsion, but a character tagged `foot-fetish-positive` overrides it to *enjoy*.

### Preferences (`preference.ts`)

A character's bespoke likes and dislikes:

```ts
{ target, valence: "like" | "dislike", intensity: 1–10, hint? }
```

`target` is a concept id **or** a family id. Leaf fields `.catch`, so one bad entry degrades rather than breaking the whole array.

### Traits (`traits/`)

A parallel registry on the shared spine ([attributes.md](attributes.md)), kept deliberately separate from attributes so it can **never** reach an image prompt. Categories are `temperament` / `social` / `intimate` (one starter set, ~11 traits). Each trait definition has:

| Part | Detail |
| --- | --- |
| scalar | A number — bipolar (−100..100) or unipolar (0..100). |
| `bands` | `{ max, label, promptHint }`, ascending, covering the axis max — **store the number, surface the band**. |
| `mutability` | `core` / `developable` (drift deferred). |
| `intimate?` | Flag. |
| `modulates` | Optional metadata. |
| `lexicon` | Scored `{ term, value }` pairs mapping free-text words onto the axis (`resolveLexicon` — the forge-expansion mechanism). |

`traitRegistry.bandFor(id, value)` clamps and reads the band. Trait **values** (`TraitValue`) reuse the attribute provenance shape (`resolveTraits` over the shared resolver). Adding a trait is a one-entry data edit + the registry test.

### Modulation (`modulation.ts`)

Pure trait → coefficient functions (spec §5), kept deterministic in the merge — never agent-decided:

| Function | What it does |
| --- | --- |
| `socialTraitScale(reaction, traits)` | Scales the reaction curve: agreeableness/composure soften (their negative poles sharpen) a **dislike**; possessiveness amplifies a **jealousy_trigger**. Clamped to `[0.4, 1.8]`. |
| `personalizeMeters(defs, traits)` | Resolves per-character meter dynamics ([meters-actions.md](meters-actions.md) §Meters): `optimism` → `mood.baseline`, `libido` → `arousal.baseline` + recovery, `composure` → `stress.recovery`. |
| `scaleAffinityGain(rawDelta, traits)` *(Slice 5)* | Scales a **simulant** affinity delta pre-clamp — warmth/agreeableness amplify gains, guardedness damps them, composure damps losses. Clamped to `[0.4, 1.8]×`. |
| `affinityDecayRetention(traits)` *(Slice 5)* | Returns a `[0, 0.7]` retention from warmth + composure that lifts the decay floor toward the current value (a constant character holds its regard). |

Empty traits ⇒ unit/identity (today's behavior).

### How it's stored and resolved

`tags: string[]`, `preferences: Preference[]`, `traits: TraitValue[]`, and `socialCards: SocialReactionCard[]` (the character's own cards) all ride `CharacterProfile` JSONB (default `[]` ⇒ a character with no disposition plays exactly as before).

Cards are also **library content** — a user-owned `social_cards` table reusable across worlds and characters (mirrors `items`: visibility + clone-on-use + semantic search). A `/social-cards` library page + standalone **builder** author cards directly; the inline `SocialCardsEditor` (world `style.socialCards` / character `profile.socialCards`) carries **Import from library** (snapshot a row into the array via `cardFromLibraryParts`) and **Save to library** (the reverse). Every layer holds its own snapshot copy — editing or deleting the library card never reaches a world/character already using it. Discovery uses the shared `searchLibraryIds` `scope` (All/Public/Owned). See [../developer-notes/social-reaction-cards.plan.md](../developer-notes/social-reaction-cards.plan.md).

The resolver lives in `reactions.ts` (cards in `cards.ts`):

- `resolveSocialReaction(act, { tags, preferences, cards })` applies **pure-override** precedence: bespoke preference → card tag-override → card default → null. The effective `cards` set is the character's own cards followed by the world's (`worldStyle.socialCards`) — the personal line wins; world-less chat passes only the character's. A card resolves to a `SocialReaction { source: "card" }` that rides the same curve as a preference.
- `evaluateSocialReaction(reaction, currentAffinity, currentMood, traitScale)` is the **affinity- and mood-aware curve** — goodwill deadband, thin-ice amplification, capped/asymmetric likes, `μ` from the mood meter (`moodMeterToFactor`), and `socialTraitScale` from the character's traits.

Curve constants live in `reactions.ts` (contracts is IO-free; the merge clamps the result to ±`AFFINITY_DELTA_CLAMP`). `matchPreference` (concept-then-family lookup) is shared with the guardrail.

### Puppet guardrail (`puppet.ts`)

`checkPuppetContradiction(behavior, { tags, preferences })` decides whether a *player-authored NPC behaviour* (intake's `narratedNpcBehaviors`, classified to a concept) clashes with who the character is. Precedence mirrors the reaction resolver — most specific wins:

1. **Bespoke preference** on the concept/family decides outright — a `dislike` ⇒ contradiction, an authored `like` ⇒ consent to puppet.
2. Else **tag affect** — a `wontInitiate` family match, or a warm act onto a `cold` character / a hostile act onto a `warm` one.
3. Else the **warmth trait band** — same warm/cold logic on the scalar.
4. Else **honour** it.

An unclassifiable behaviour (no concept — plain dialogue) is always honoured. The function is pure; it reads tags + preferences + the warmth trait — affinity + mood will join once they exist.
