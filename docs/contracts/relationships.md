[← Contracts index](README.md)

# Relationships and disposition

Two related systems live here: **relationships** (how two people relate — represented one of two ways, per lane) and **disposition** (an NPC's authored personality — traits, preferences, and tags that shape how they react).

Relationships have **two representations**, one per lane:

- The **sessions lane** uses a single **affinity** scalar with readable **stage** labels (`stages.ts` — [Relationship stages](#relationship-stages-sessions-lane) below). Still the live model for `participant_relationships` / `world_cast` until the sessions refactor (relationship-model plan slice 7).
- The **character-chat lane** uses the shipped **two-axis** model — **familiarity × regard** (`record.ts` / `bands.ts` / `law.ts` / `history.ts`; migration 0028). See [Two-axis model](#two-axis-model-familiarity--regard).

## Relationship stages (sessions lane)

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

## Two-axis model (familiarity × regard)

The **character-chat lane** replaced the single affinity scalar with **two independent axes** (relationship-model.plan.md; migration 0028 renamed the `affinity` column to `regard` and added a `familiarity` column + a `relationship_record` jsonb to `character_chat_state`). Directed from day one — "A loves B, B secretly resents A" is a data state, never a schema change.

- **Familiarity** (`0..100`, slow **ratchet** — you can't un-know someone): how well two people know each other — address rights, what can be assumed/referenced, how well they read the other. It only ever climbs: exchange **trickle** (time together) lifts it at most to the top of `acquainted` (`FAMILIARITY_TRICKLE_CEILING`), while archivist **moments** (a real disclosure/shared experience) push past it, capped per scene (`FAMILIARITY_SCENE_CAP`). `tickFamiliarity` applies the ratchet.
- **Regard** (`−100..100`, volatile — this **is** the old affinity scalar): how they feel — warmth of tone, the desire to initiate, patience, the escalation floor.

**Bands, never raw values, go in prompts and gate behavior** (`bands.ts`; boundaries are data):

| Axis | Bands (low → high) |
| --- | --- |
| familiarity (5) | strangers · introduced · acquainted · familiar · deeply_known |
| regard (10) | hostile · wary · cool · neutral · friendly · warm · close · cherished · devoted · smitten |

The regard ladder is the old stage ladder minus its two familiarity-flavored rungs — `stranger` became `neutral`, `acquaintance` folded into `friendly` (knowledge is the other axis's job now). `regardBandForValue` / `familiarityBandForValue` map a scalar to its band; `*BandMidpoint` seeds a scalar from an authored band pick.

**The record** (`record.ts`) — ONE shape for every edge (character→player, character→character, library defaults):

- **live** (`RelationshipRecord`): both axes as **scalars** + texture — what state rows store and dynamics move.
- **authored** (`AuthoredRelationshipRecord`): both axes as **band picks** + texture — what authoring surfaces write; `authoredRecordToLive` seeds the scalars at band midpoints.
- **texture** (both forms): `kind` (the label both parties use), `history` (one line of shared past), `presented?` (a **mask** — `masks_warmth` = tsundere, `masks_dislike` = the professional mask — when performance differs from feeling), `looming` (an absent person who weighs on the character unprompted). Every field self-heals (`.catch`). `attraction` is a reserved third axis (a field addition, never a migration).

**The composed law** (`law.ts`) — `composeRelationshipLaw` turns the two live scalars into the prompt's relationship block, composing **two** band-profile tables (5 familiarity + 10 regard) rather than an M×N grid: openness = `min(familiarity ceiling, regard willingness)`, address register from familiarity / tone from regard, initiative (familiarity makes it easy, regard makes it wanted), and the **escalation floor keyed to regard** (`ESCALATION_TIER_PHRASES`; the D11 invariants hold — premise wins, disinhibition never raises the floor, authored values trump). The chat prompt builder calls it (slice 3); the sessions lane keeps `profile.ts` until slice 7.

**History + milestones** (`history.ts`) — capped jsonb rings on the chat state row, appended by the exchange finalizer: `RelationshipSample` (`regard` + band + `familiarity`, capped `RELATIONSHIP_HISTORY_CAP` = 200) draws the panel's arc; `Milestone` (kinds `first_exchange` / `stage_up` / `stage_down` / `familiarity_up` / `strong_reaction` / `player_marked`, capped `MILESTONES_CAP` = 100) marks the beats. The `stage_up` / `stage_down` kind ids are kept as stored wire ids and now mean **regard-band** crossings.

**Bridges to the old vocabulary** (`bands.ts`): `stageToAxes` / `stageToBandIds` seed both axes from an old stage id (state migration + authored-`{stage}` healing); `regardBandToStageId` maps back for contracts still keyed to stages (mood's touch welcomeness, emotion labels — shared with the sessions lane until slice 7).

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
| `defaultHint` | Fallback narrator flavour when a preference sets no `hint` (`""` is fine). |
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
| `regardDispositionOverlays(bandId, traits)` | Render-time **soft coloring** from the regard band (`REGARD_TRAIT_SHIFTS`): warm regard reads warmer/less guarded/less inhibited, hostile colder and walled-off. Shifts **only authored** traits (never fabricates one) as `source:"condition"` overlays; `neutral` shifts nothing; familiarity deliberately does *not* color disposition. Loosens tone only — never raises the escalation floor. |
| `stateDispositionOverlays(traits, meters)` | Transient **disinhibition** from live state: intoxication + arousal past a floor drop guardedness/inhibition, as `source:"condition"` overlays that recede as the meters drift back. Only authored traits shift. |

Empty traits ⇒ unit/identity (today's behavior). The two `*DispositionOverlays` are wired into the chat prompt builder (`character-chat.ts`).

### How it's stored and resolved

`tags: string[]`, `preferences: Preference[]`, `traits: TraitValue[]`, and `socialCards: SocialReactionCard[]` (the character's own cards) all ride `CharacterProfile` JSONB (default `[]` ⇒ a character with no disposition plays exactly as before).

Cards are also **library content** — a user-owned `social_cards` table reusable across worlds and characters (mirrors `items`: visibility + clone-on-use + semantic search). A `/social-cards` library page + standalone **builder** author cards directly; the inline `SocialCardsEditor` (world `style.socialCards` / character `profile.socialCards`) carries **Import from library** (snapshot a row into the array via `cardFromLibraryParts`) and **Save to library** (the reverse). Every layer holds its own snapshot copy — editing or deleting the library card never reaches a world/character already using it. Discovery uses the shared `searchLibraryIds` `scope` (All/Public/Owned). See [../developer-notes/social-reaction-cards.plan.md](../developer-notes/finished/social-reaction-cards.plan.md).

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
