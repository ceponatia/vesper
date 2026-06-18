# Personality & evolving state — plan

Status: **active** — Slice 1 (the social-reaction loop) and Slice 2 (the puppet
guardrail) **shipped 2026-06-18**; Slices 3–5 queued. The social-fabric **card layer is a
separate plan** (`social-reaction-cards.plan.md`) that Slice 1 built the resolution seam
for; the **full NPC-puppeting system** beyond Slice 2's deflection directive is parked in
`npc-puppeting.deferred.md`.

Design/decisions: [personality-and-state.spec.md](personality-and-state.spec.md) — read
it first; it is the truth. This plan is the task list and build order. It **front-loads
the social-reaction loop (spec §6)** — the most game-like, most self-contained slice —
and layers the puppet guardrail, traits, and mood behind it on the seams that loop
creates.

## Goal

Give characters **authored disposition** — reusable **tags** + **bespoke** likes/dislikes,
over a shared social fabric — that the engine resolves *deterministically*, so reactions
(and the drift of transient states) are driven by data, not narrator improvisation. v1
is the **social-reaction loop**: the intake agent concept-tags a player's social act, a
pure **affinity-aware** curve (mood and traits stubbed) decides how the character takes
it, and the narrator is handed the verdict plus a deterministic affinity delta. The
puppet guardrail, traits (generic dynamics + lexicon), and mood follow on the same seams;
the **importable taboo/social-rule cards** plug into the resolution seam from their own
plan.

## Build order

### 1. The social-reaction loop (v1 — the headline) — _shipped 2026-06-18_

The "she likes/dislikes this, and reacts on a curve" experience end to end, with **unit
trait-scaling** (`traitScale` seam returns 1), **neutral mood** (curve carries `mood` but
it's a no-op stub), and **`cards: []`** (only the bespoke character layer is live).
Ships the game feel by itself; everything later plugs into seams this slice creates.

> **Shipped 2026-06-18 — all 10 steps; `pnpm verify` green (1213 tests).**
> `contracts/personality/` (interactions · tags · preference · reactions) → `socialActs`
> on the intent brief → intake classification → `buildReactionLine` (pre-narration) →
> `planReactionAffinity` + `combineAffinityUpdates` (merge step 5: writes the NPC's
> **feeling** edge from the turn-start value, **whole-edge** simulant suppression) →
> forge disposition inference (tags + preferences, demo-seeded) → editor **Disposition**
> tab (autocompleting tag input + bespoke like/dislike list) → tests → docs
> (contracts/turn-engine/prompts/authoring).
>
> **Two deviations from the plan, both deliberate:** (1) the curve's tuning **constants
> live in `reactions.ts`**, not `engine/constants.ts` — `src/contracts` is IO-free and
> may not import server constants; the merge still applies `AFFINITY_DELTA_CLAMP`.
> (2) `evaluateSocialReaction` takes a **`traitScale: number`** (default 1), not trait
> objects — keeps the pure curve registry-agnostic, and Slice 3 computes the scale in
> the engine and passes it. The reaction writes the **feeling** edge (the relationship
> the act actually changes), not the perceived edge.

1. **Concept vocabulary** — `contracts/personality/interactions.ts` (pure). ~8–12 flat
   concepts (`compliment`, `gift`, `flirt`, `tease`, `reassure`, `confide`, `insult`,
   `criticize`, `boundary_push`, `jealousy_trigger`, `physical_affection`,
   `public_display`), each with `family?`, `triggers`, `defaultHint`, `intimate?`. The
   single stable classification target for intake and the key space bespoke preferences
   (and later cards) reference. Registry-invariant test.
2. **Disposition on the profile** — `tags: string[]` + `preferences: Preference[]`
   (default `[]`) on `characterProfileSchema` (`contracts/world/profile.ts`) and the
   participant snapshot. `parseOr` at the JSONB boundary; empty ⇒ no-op. No migration.
   Tags draw from a **dev-defined canonical registry** (`contracts/personality/tags.ts`)
   surfaced by **autocomplete** in the editor/forge; free-form tags are allowed but
   second-class (no autocomplete, no guaranteed card-override match).
3. **`socialActs` intake seam** — add `socialActs: Array<{ concept, target }>` to
   `intentBriefSchema` (`contracts/turns/intent-brief.ts`) — an **array** for forward
   headroom, `.default([])`/`.catch`ed like its siblings; extend `INTAKE_SYSTEM` /
   `buildIntakePrompt` (`engine/prompts/intake.ts`) to tag the player's social act(s)
   against the concept vocabulary. **v1 resolves only the primary** (highest-significance)
   entry. Persisted with the brief (no new column). Regex fallback leaves it empty ⇒
   nothing fires.
4. **Resolution seam** — `resolveSocialReaction(act, { tags, preferences, cards })`
   → `SocialReaction | null` in `contracts/personality/reactions.ts` (pure). Precedence:
   bespoke preference → card tag-override → card default → `null`. **v1 always passes
   `cards: []`**, so only the bespoke layer resolves; the card plan supplies world cards
   later with **no caller change**.
5. **The response curve** — `evaluateSocialReaction(reaction, currentAffinity,
   currentMood, traits) → { valence, magnitude, band, hint }` (pure, same file). The
   affinity-aware nonlinear curve (spec §6): goodwill deadband, thin-ice amplification,
   capped/asymmetric likes. `traitScale(traits)` returns **1**; `currentMood` is a
   **NEUTRAL stub** (factor 1); constants in `engine/constants.ts` with starting values
   (κ≈0.04, λ≈1.0, like-damping≈0.6 + a capped surprise bonus, mood factor 1±0.3,
   `intensity` 1–10) — placeholders, tuned in playtest. Heavily unit-tested — the
   load-bearing math.
6. **Pre-narration reaction line** — a deterministic pre-turn step (sibling to
   `buildRelationshipBlock`, `engine/scene.ts`): run `resolveSocialReaction` →
   `evaluateSocialReaction` with the **turn-start** perceived affinity (already loaded
   for the stage block), emit a reaction line into the **volatile** turn context (never
   the cached prefix) via `buildTurnContext` (`engine/prompts/narrative.ts`).
7. **Merge apply** — `engine/merge.ts` step 5 (affinity): recompute the delta from the
   persisted `brief.socialAct` + the **turn-start** affinity (same value the hint used
   ⇒ narrated reaction and applied number agree), apply it to the player→NPC edge, and
   **suppress the simulant's `affinityAdjustments` on that edge** (the disposition layer
   is authoritative for recognized acts; the simulant still owns unrecognized edges).
   Mood nudge is deferred (Slice 4). Clamp ±`AFFINITY_DELTA_CLAMP`; diagnostic on
   unresolved target/concept.
8. **Forge** — infer `tags` + `preferences` from the prose sketch
   (`authoring/character-forge.ts`). The full procedural-expansion ladder (spec §9,
   Note 3) lands in two parts: **tags + preferences here**; trait-scalar inference +
   lexicon expansion with the trait registry (Slice 3).
9. **Editor** — a "Disposition" tab on `character-editor.tsx`: a **tag editor** +
   a **bespoke like/dislike list** (concept/family picker + like/dislike + intensity +
   optional hint). Intimate concepts fenced behind the intimate exposure gate.
10. **Tests + docs** — pure-curve tests (deadband, grace, thin-ice, like cap/asymmetry,
    clamp); merge suppression + diagnostic; intake degradation (no `socialAct` ⇒ prior
    behaviour) asserting fallback **and** diagnostic. Docs: `contracts.md` (concept vocab
    + tags/`Preference` + the resolution seam), `turn-engine.md` (the `socialAct` seam,
    the reaction step, the merge suppression rule), `prompts.md` (the reaction line),
    `authoring.md` (forge + Disposition tab).

### 2. The disposition guardrail (puppet refusal) — _shipped 2026-06-18_

Spec §6, Note 2. Makes disposition *real* by reading it on the input side. Uses v1
disposition (tags + preferences); Slice 3 enriches it with full traits + affinity + mood.

> **Shipped 2026-06-18 — all 4 steps; `pnpm verify` green.**
> concept `polarity` + tag `warmth`/`wontInitiate` (the contradiction signal) →
> `narratedNpcBehaviors` on the intent brief + intake prompt → `checkPuppetContradiction`
> (`contracts/personality/puppet.ts`, pure: preference → tag → honour) →
> `buildPuppetDeflection` (`engine/scene.ts`, pre-narration, wired into the volatile
> stateBlock) → tests + docs (contracts/turn-engine/prompts) + the deferred-system doc.
>
> **Decisions made during the build (the docs left them open):**
> (1) The contradiction signal is **tag `warmth` + `wontInitiate` families + concept
> `polarity`**, with **preferences taking precedence** (a `dislike` ⇒ contradiction, an
> authored `like` ⇒ consent to puppet) — the first slice of the richer "what a tag means"
> model the user plans; free-form tags carry no machine affect and are invisible to the
> guardrail. (2) `narratedNpcBehaviors` is a **new brief field** (sibling to `socialActs`),
> not a reuse of `movement.kind:"narrated_npc"` — movement (physical relocation) stays the
> movement-authority spec's concern; "generalize" meant the same *concept* now covers
> dialogue/affection/action. (3) **No merge state-strip in v1**: the narrator's refusal
> means the puppeted act never reaches the post-turn agents, so there is nothing to drop;
> the **full puppet-handling system** (merge stripping, stronger refusal routed through the
> companion/narrator out-of-POV affordances, trait-enriched judging) is parked in
> `npc-puppeting.deferred.md` per the user's call to plan it separately.

1. **`narratedNpcBehaviors` intake flag** — a new `{ npc, concept?, summary? }[]` field on
   `intentBriefSchema` for player-authored NPC dialogue/affection/action, set by the intake
   prompt. (Movement's `narrated_npc` kind is left to movement-authority.)
2. **Contradiction check** *(deterministic, fed by intake)* — `checkPuppetContradiction`
   classifies the puppeted behaviour's affective direction (concept `polarity` + tag
   `warmth`/`wontInitiate`) against disposition, preference-first. Contradiction ⇒ refuse;
   consistent / unclassifiable ⇒ honour.
3. **Deflection directive** — on contradiction, `buildPuppetDeflection` adds a volatile
   turn-context directive telling the narrator **not to honour it** and to answer with an
   **overt cheeky meta aside**. **Consistent narration passes** (code comment + the deferred
   doc note that this leniency may later be strengthened). No merge state-strip in v1 (see
   the decision note above).
4. **Tests + docs** — contradiction fires the aside; consistent / unclassifiable puppeting
   passes; unresolved target ⇒ diagnostic; degradation (flag empty ⇒ prior behaviour). Docs:
   `contracts.md`, `turn-engine.md`, `prompts.md`, + `npc-puppeting.deferred.md`.

### 3. Atomic traits + scaling + lexicon — _not started_

Spec §3, §5, §7. Adds the generic dynamics, **fills the `traitScale` seam** Slice 1
stubbed, and powers forge expansion.

1. **Shared registry spine** — lift `buildRegistry`/`valueSchemaFor`
   (`attributes/registry.ts`) + `resolveAttributes` precedence (`attributes/value.ts`)
   into a generic the attribute **and** personality registries call (jscpd-safe; traits
   inherit base/creation/manual overlays for free).
2. **Trait registry** — `contracts/personality/` categories (temperament/social/
   intimate): governing traits as bipolar/unipolar scalars + bands, `mutability`,
   `intimate?`, `modulates?`, **and a scored member-term `lexicon`** (spec §3, Note 4).
   `traits: TraitValue[]` on the profile/snapshot.
3. **Disposition block (cached)** — render trait **bands** as behavioural guidance in the
   static rulebook region (`engine/scene.ts`) — closes character-schema audit **C1**.
   Intimate bands ride the exposure gate (shared with intimacy-notes).
4. **Wire `traitScale`** — `evaluateSocialReaction`'s `traitScale` reads real traits
   (`agreeableness` damps dislikes, `possessiveness` amplifies `jealousy_trigger`); the
   `modulation.ts` coefficient module (spec §5) lands here.
5. **Forge expansion via lexicon** — complete the Note 3 ladder: map sparse terms onto
   governing traits, pull sibling lexicon terms, infer/invent as input thins out.
6. **Enrich the guardrail** — Slice 2's contradiction check now reads full traits.
7. **Agents / editor** — simulant slice gains trait bands; editor sliders + band readout.
   Tests + docs.

### 4. Mood + meter generalization + affinity levels — _not started_

Spec §4. Adds valence, per-character drift, and the mood↔affinity coupling.

1. **Meter generalization** — `baseline?` / `recoveryPerHour?` on `MeterDefinition`,
   backward-compatible (absent ⇒ today's pole-seeking).
2. **`mood` meter + derived descriptor** — a new valence meter; `buildMeterConditionBlock`
   blends valence × stress/energy into a descriptor.
3. **Trait-derived baselines** — `optimism→mood.baseline`,
   `libido→arousal.baseline/recovery`, `composure→stress.recovery`.
4. **Mood↔affinity coupling** — wire the curve's `μ` mood factor to real mood; add the
   mood-update path (affinity scales how interactions/events move mood); the social
   reaction now also nudges mood (the deferred Slice-1 nudge). The event→mood table is
   its own later plan.
5. **More affinity levels** — widen `stages.ts` so progression reads less coarsely.
   Tests + docs.

### 5. Affinity trait-coupling — _not started; folds into affinity-decay work_

Spec §4 (affinity) / §10. Trait-scaled gain asymmetry + decay target/rate. **Do not
duplicate** — fold into
[cast-tiers-and-affinity-spec.phase3.md](cast-tiers-and-affinity-spec.phase3.md) when
affinity decay is built.

## Dependencies / parallel plans

- **Social-reaction cards** (`social-reaction-cards.plan.md`, to create) — the importable
  taboo/social-rule **card** layer the Slice-1 seam resolves against (modelled on the
  companion-app `TabooCard`: concept triggers, severity tiers, tag-keyed
  `reactionOverrides`). It is a build of its own (schema + DB + editor + cross-world
  import + forge). When it ships it **replaces and removes** today's `world.style.norms`,
  the rudimentary World-page social-rule editor + its world-forge hookup, and the
  continuity agent's `normBreaches` path. v1 here leaves all of those untouched and
  passes `cards: []`.

## Not in scope (v1 / this plan)

Deferred (spec §11): `developable` trait **drift** (design the field, defer the rule);
**per-relationship** mood/disposition; **NPC→NPC** social-act classification (intake is
player-only); **player** preferences surfaced to NPCs; **multi-act** turns (v1 takes the
primary concept); the **card layer** (own plan, above); the **event→mood** table (own
plan, with Slice 4).

## Open questions

**None block v1** — all gating questions were resolved 2026-06-18 (rulings recorded in
[spec §11](personality-and-state.spec.md#11-open-questions-restate-in-the-plan)): tag
governance (dev registry + autocomplete), `socialActs` array headroom (resolve primary),
whole-edge simulant suppression, deterministic puppet verdict fed by intake + honour
consistent puppeting, and **pure override** for cards × bespoke. Remaining unknowns are
**playtest tuning** (curve constants) and **future scope** (the event→mood table, and
strengthening the puppet guardrail via the companion/narrator out-of-POV affordances) —
none of which gate a build.
