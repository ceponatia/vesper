# Sensory grounding — target-aware sensory focus in character chat — plan

Status: **shipped — 2026-07-12** (core slices 1–3 + the allowance-degrade fix + the
session-lane suffix gate; leftovers listed at the end). Decisions recorded inline —
no separate spec. Post-ship fixes:
[sensory-grounding.followups.md](sensory-grounding.followups.md) (2026-07-13 —
the focus block's own "clean"/"salt" wording was overriding authored scents).

## The problem

The chat lane's Sensory-focus block (`buildSensoryFocusSection`) detected the
player's sense-targeted beat ("I lick her foot" → taste × foot) but **never used
the target to fetch data**: whatever the region, it handed the narrator the same
generic lines (perfume baseline + hygiene band). `feet.smell` — a 21-value palette
authored exactly for that beat — never reached the block, the directive capped the
prose at "ONE short paragraph" without saying *open the reply with it*, and nothing
forbade echoing enum values verbatim. Weak sensory prose was the model responding
correctly to an under-grounded prompt. (Owner report, 2026-07-12.)

## What shipped

1. **Target-aware data join (the core fix).** `SensoryFocusHint` gains a resolved
   registry **`region`** (`chat-intent.ts`): colloquial intimate nouns map through
   `INTIMATE_REGION_BY_NOUN` (pussy → vulva, panties/thong → groin — an intimate
   garment carries the region it covers), everyday non-registry nouns through
   `EVERYDAY_REGION_BY_NOUN` (throat → neck, sole/heel → feet, belly → waist),
   garments carry none. The builder joins the region to the character's authored
   attributes via `expandBodyTarget` (contracts/species/targets.ts — the resolver
   body.md always said was "pending wiring"), realized-body filtered, **sense-ranked**
   (`focusSenseRank`: the beat's sense leads — `.scent`/`.smell` first on a smell
   beat, `.taste` then scent (retronasal) on a taste beat, `.texture` then shape on
   touch; scent/taste values DROP from a study beat), capped at 6 region lines.
   The old target-blind "first 4 intimate attributes" loop is replaced by the same
   join (intimate categories still gated by the hint's `intimate` flag + realized
   body). `resolveBodyTarget` now also resolves **singular forms** of plural
   locations ("foot" → `feet`, irregulars + naive trailing-s), and the detector's
   noun lists grew the registry gaps (chest, sole/heel/toe, eyes/nose, tail/wings/
   horns, palm, nape, chin…).
2. **Composed "right now" state.** The generic lines stay (baseline scent + hygiene
   for smell/taste; outfit + grooming + hygiene for touch/study; conditions always)
   and the directive instructs the narrator to **compose** authored baseline ×
   current state ("freshly washed mutes a scent; a long day deepens it") — the
   evolving-scent behavior the `feet.smell` placeholder comment wished for, done in
   prose instead of a brittle value matrix.
3. **The opener directive.** The block now instructs: **OPEN the reply** with 2–4
   sentences of what the player directly perceives (per-sense experience clause —
   `focusExperienceClause`), written as sensation landing in the player's senses,
   *before* the character reacts — then the scene continues. Verbatim guard
   hardened: values are "guide-rails, not vocabulary — never repeat them verbatim
   and never contradict them". The one-short-paragraph cap is gone.
4. **Allowance-degrade fix.** A `focused_description` allowance whose focus block
   rendered "" (nothing authored grounds a touch/study beat) used to leave the turn
   with NO grant — rule 11's default-none then forbade sensory detail on the one
   turn that most earned it. The builder now degrades that case to
   `close_range_hook`.
5. **Session-lane suffix gate generalized** (`engine/scene.ts`
   `intimateAttrAllowed`): `.scent`/`.smell`/`.taste` id suffixes are sense-gated
   whatever their category, so `feet.smell` (category `feet`, previously ungated
   there) needs the scent axis earned like the intimate region senses always did.

## Decisions

- **No model call added** — detection stays regex-first, region resolution and the
  join stay pure registry lookups; same cost profile as before.
- **Intimate garments resolve to their region** for the join (panties → groin →
  vulva subtree, realized-body filtered) — the colloquial intent of a sense beat on
  them; `lingerie`/everyday garments stay garment-only (outfit lines).
- **`heels` reads as the body part** (feet region), not the shoe, when a sense verb
  targets it — the outfit line still grounds the shoe reading on touch/study.
- **Cross-sense bundling lives in the header clause** (a taste beat's experience
  clause names texture/warmth/scent), not in extra data lines — rank 1 scent lines
  already ride along on taste beats.

## Leftovers (not shipped here)

- **Sparse vocabulary pass** (design slice 4): a few more per-location sensory
  attributes where beats commonly land (hair scent distinct from perfume, breath,
  skin warmth). Registry data edits; fold into the
  [attribute-narrator-guidance.plan.md](attribute-narrator-guidance.plan.md)
  authoring pass.
- **`feet.smell` → `feet.scent` rename** for suffix consistency: needs the
  stored-value sweep infrastructure that attribute-narrator-guidance slice 3
  builds — deferred there (the `.smell` suffix is handled everywhere in the
  meantime).
- **Eval fixture** beside `chat-pov-sensory`: assert a focus-turn reply opens with
  second-person sensation rather than dialogue (deterministic opening-paragraph
  metric).
- **Session-lane look/touch surfacing** via the same `expandBodyTarget` join
  (glance impressions are still category-level) — body.md still marks it pending.
