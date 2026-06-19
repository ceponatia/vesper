# Social-reaction cards — plan

Status: **draft** (design carried inline below — promote to `social-reaction-cards.spec.md`
if it grows; no code yet). Sequenced **after the personality §6 resolution seam**
(`personality-and-state.plan.md` Slice 1 builds `resolveSocialReaction(act, {…, cards})`
with `cards: []`); this plan fills that argument and can run in parallel with personality
Slices 2–4.

Context: [personality-and-state.spec.md](personality-and-state.spec.md) §6 (the seam this
feeds) / §10 (what this removes). Reference implementation: the companion-app
`taboo-reaction-engine.ts` + `world-lore-schemas.ts` (`TabooCard`, `severityToTabooTier`,
`resolveWitnessReaction`).

## Goal

Replace today's freeform `world.style.norms` with **importable social-reaction cards**
(taboos + social rules) — **library content, reusable across worlds like items** — that
resolve **deterministically** with per-character **tag overrides**, feeding two consumers:

1. the personality **`resolveSocialReaction`** seam (§6) — the player→target reaction; and
2. the **witnessed-breach** reactions across *all* present NPCs — the deterministic
   replacement for the continuity agent's freeform `normBreaches` path.

## The card model

`SocialCard` (mirrors companion-app `TabooCard`, adapted to Vesper's concept vocabulary +
canonical tags):

```ts
type SocialCard = {
  id: string; label: string; description: string;
  kind: "social_rule" | "taboo";          // authoring/UX bucket; mechanics unified by severity
  triggers: ConceptId[];                    // concept ids from the shared vocabulary — NOT free keywords
  severity: number;                         // 0–100 → tier (severityToTier)
  defaultReactions: Record<Tier, Reaction>; // tier → reaction
  reactionOverrides: Array<{ tag: TagId; fromTiers: Tier[]; toReaction: Reaction }>;
};
// Tier        = "odd" | "disapproval" | "shunning" | "ostracized"
// Reaction    = { kind: ReactionKind; prompt: string; affinityDelta: number; moodDelta?: number }
// ReactionKind= revulsion | disapproval | shunning | fear | accepting | enjoy | kindred_spirit | indifferent
```

- **Triggers are concept ids** (the personality concept vocabulary), so **intake's
  classification is the trigger** — no second, free-text keyword path to drift. Grow the
  vocabulary as taboos require non-interpersonal acts (e.g. `public_exposure`,
  `consumption_taboo`); see Open questions.
- **`reactionOverrides` key on canonical tags** (the dev-defined tag registry, personality
  §3) — the **foot-fetish flip**: a `foot-fetish` taboo defaults to revulsion, but a
  character tagged `foot-fetish-positive` overrides to *enjoy*.
- Reaction deltas are **asymmetric** (easy to lose, slow to gain) and clamped in the merge
  (±`AFFINITY_DELTA_CLAMP`), like every other affinity write.
- Port the pure helpers `severityToTier` + `resolveWitnessReaction` from companion-app.

## Storage & import (the library pattern)

Cards are library content, exactly like `items` → `world_items`:

- **`social_cards`** library table (user-owned, reusable) + **`world_social_cards`** join
  (a world selects which cards apply). DB workflow per `CLAUDE.md`
  (`schema.ts` → `db:generate` → review `drizzle/` → `db:migrate`).
- **Spawn** snapshots a world's cards into the session bundle (like cast/items), so play
  reads session-frozen rows — consistent with "spawn is a full instantiation."
- **Import** = add a library card to a world; the same cross-world reuse path characters
  and items already use.

## Resolution — two integration points

**1. Player→target reaction (personality seam).** `resolveSocialReaction(act, { tags,
preferences, cards })` now receives the world's cards. Precedence is already specced and
is **pure override**: bespoke preference → card tag-override → card default → none. The
result rides the §6 affinity/mood curve + the pre-narration reaction line.

**2. Witnessed breach (replaces continuity `normBreaches`).** A card-triggering act seen by
present NPCs makes **each witness react by their own tags**:

- **Detect** — re-point the continuity agent's `normBreaches` slot to **`cardBreaches`**:
  it already receives the world's social rules and flags witnessed breaches + witnesses;
  swap the freeform `normRule` for a matched card id (+ concept).
- **Resolve** *(merge, deterministic)* — for each eligible witness,
  `resolveWitnessReaction(card, tier, witnessTags)` → a reaction; fold its `affinityDelta`
  into that witness→player edge and its `prompt` into the next-turn reaction directives
  (the existing `normBreach → brief.corrections` path, re-pointed).
- **Witness eligibility** is perception-gated (present **and** perceived the act), reusing
  the witness machinery ([perception.md](perception.md)) — the analog of companion-app's
  exposure-gated `defaultEligibleWitnesses`.
- For consistency, witness affinity deltas should run through the **same §6 curve**
  (per-witness affinity/mood), not a flat tier number — see Open questions.

**Narrator surfacing.** Cards relevant to present characters surface as **scene guidance**
in the turn context (so the narrator plays the social fabric proactively), distinct from
the post-turn breach detection. Stable cards ride the cached prefix; per-turn breach
directives ride the volatile tail.

## Forge & editor

- **World forge** proposes a starter card set for a premise (replacing today's norm
  generation) — pulled from a common-card library + bespoke.
- **Editor** — a card library view + a per-world card picker (like the item picker) +
  tag-override authoring on each card. Character forge already proposes the **tags** these
  cards key on (personality Slice 1).

## Removals when this ships (personality §10 — prefer removal over deprecation)

- `worldNormSchema` + `world.style.norms` (`contracts/world/profile.ts:57`).
- The World-editor **Norms** UI (`components/worlds/world-editor.tsx` §Norms, ~line 226).
- World-forge norm generation (`server/authoring/world-forge.ts` — the norms section, lines
  ~122/128/135/159).
- The continuity agent's freeform `normBreaches` schema + path
  (`contracts/turns/agent-results.ts` ~160, `engine/prompts/agents.ts`, `engine/merge.ts`
  ~1236) — **re-pointed** to `cardBreaches`, not merely deleted.
- **Migration** of existing `world.style.norms`: backfill to equivalent low-severity social
  cards, or drop (dev has no real users) — decide at build (Open questions).

## Build order

1. **Card model + pure helpers** — `SocialCard` schema (concept triggers, canonical-tag
   overrides) in `contracts/`; port `severityToTier` + `resolveWitnessReaction`. Tests.
2. **Storage + spawn** — `social_cards` + `world_social_cards` tables; snapshot into the
   session bundle. DB workflow.
3. **Wire the personality seam** — pass world cards into `resolveSocialReaction` (replace
   the `cards: []` stub). Player→target reactions now honour the social fabric.
4. **Witnessed-breach path** — re-point continuity `normBreaches` → `cardBreaches`; merge
   resolves perception-gated witness reactions → affinity (via the §6 curve) + directives.
5. **Forge + editor** — world-card proposals; card library + per-world picker + tag-override
   authoring.
6. **Removals + migration** — delete the freeform norms surface (above); migrate/seed.
7. **Tests + docs** — pure helpers + resolution precedence + witness gating + degradation;
   docs `contracts/relationships.md`, `turn-engine.md`, `database.md`, `authoring.md`,
   `perception.md` (witness reuse), and personality §10 (mark removed).

## Open questions

- **Card vs concept boundary** — do all taboos express as concept triggers, or do some need
  non-interpersonal triggers (public nudity, consumption, ritual) that grow the **concept
  vocabulary** vs a separate behaviour vocabulary? (Lean: grow the one vocabulary.)
- **Severity → tier thresholds** — reuse companion-app's (26/51/76), or re-tune to Vesper's
  affinity scale + the §6 curve?
- **Witness delta path** — run witness affinity deltas through the §6 curve (per-witness
  affinity; recommended for consistency) or apply the card's flat tier delta?
- **Snapshot vs live** — snapshot cards at spawn (consistent with cast; recommended) vs read
  world cards live each turn (they change rarely)?
- **`world.style.norms` migration** — backfill to cards vs drop (dev has no real users)?
- **Tag registry scope for overrides** — cards reference canonical tags; do imported cards
  ever introduce *new* tags, and how do those reconcile with the dev registry?

## Not in scope

- The personality **preference loop** (its own plan) — this supplies only the card layer.
- **Mood deltas** from cards beyond the affinity path — fold in with the mood slice
  (personality Slice 4).
