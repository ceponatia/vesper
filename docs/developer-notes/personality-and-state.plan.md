# Personality & evolving state — plan

Status: **draft** (not settled — several v1 decisions still open; the spec is an
analysis, not yet ratified). No code yet.

Design/decisions: [personality-and-state.spec.md](personality-and-state.spec.md) —
read it first; it is the truth. This plan is the task list and build order. It
**front-loads the authored likes/dislikes loop (spec §6)** — the most game-like and
most self-contained slice — and layers traits, mood, and the dynamics
generalizations behind it on the seams that loop creates.

## Goal

Give characters **authored preferences** and **disposition** that the engine resolves
*deterministically*, so reactions and the drift of transient states are driven by
data, not narrator improvisation. v1 is the **preference loop**: the intake agent
concept-tags a player's social act, a pure **affinity-aware** curve decides how the
character takes it, and the narrator is handed the verdict (plus a deterministic
affinity delta). Traits (the generic dynamics), mood, and the meter/affinity
generalizations follow on the same seams.

## Build order

### 1. The preference loop (v1 — the headline) — _not started_

The whole "she likes/dislikes this, and reacts on a curve" experience, end to end,
with **unit trait-scaling** (no trait registry yet — the `traitScale` seam returns 1)
and **affinity only** (no mood yet). Ships the game feel by itself; everything later
plugs into seams this slice creates.

1. **Interaction-concept registry** — `contracts/personality/interactions.ts` (pure).
   ~8–12 flat concepts (`compliment`, `gift`, `flirt`, `tease`, `reassure`,
   `confide`, `insult`, `criticize`, `boundary_push`, `jealousy_trigger`,
   `physical_affection`, `public_display`), each with `family?`, `triggers`,
   `defaultHint`, `intimate?`. Registry-invariant test (unique ids, every concept
   reachable). Reuse the shared registry spine if Slice 2's extraction lands first;
   a standalone typed map is fine until then (it's small).
2. **`Preference[]` on the profile** — `preferences: Preference[]` (default `[]`) on
   `characterProfileSchema` (`contracts/world/profile.ts`) and the participant
   snapshot. `parseOr` at the JSONB boundary; empty ⇒ no-op. No migration (JSONB).
3. **`socialAct` intake seam** — add `socialAct: { concept, target }` to
   `intentBriefSchema` (`contracts/turns/intent-brief.ts`), `.default`ed/`.catch`ed
   like its siblings; extend `INTAKE_SYSTEM` / `buildIntakePrompt`
   (`engine/prompts/intake.ts`) to tag the player's **primary** social act against the
   concept vocabulary. Persisted with the brief (no new column). The regex fallback
   leaves it empty ⇒ no preference fires (today's behaviour).
4. **The response curve** — `evaluateSocialAct(concept, pref, currentAffinity, traits)
   → { valence, magnitude, band, hint }` in `contracts/personality/reactions.ts`
   (pure). The affinity-aware nonlinear curve (spec §6): goodwill deadband, thin-ice
   amplification, capped/asymmetric likes. `traitScale(traits)` is a seam returning
   **1** in v1; constants (`κ`, `λ`, the deadband, the like/dislike asymmetry, the
   cap) live in `engine/constants.ts`. Heavily unit-tested — this is the load-bearing
   math.
5. **Pre-narration reaction line** — a deterministic pre-turn step (sibling to
   `buildRelationshipBlock`, `engine/scene.ts`): for the brief's `socialAct`, look up
   the target NPC's matching preference, call `evaluateSocialAct` with the
   **turn-start** perceived affinity (already loaded for the stage block), and emit a
   reaction line into the **volatile** turn context (never the cached prefix) via
   `buildTurnContext` (`engine/prompts/narrative.ts`).
6. **Merge apply** — in `engine/merge.ts` step 5 (affinity): recompute the delta from
   the persisted `brief.socialAct` + the **turn-start** affinity (the same value the
   hint used ⇒ narrated reaction and applied number agree), apply it to the
   player→NPC edge, and **suppress the simulant's `affinityAdjustments` on that edge**
   for the turn (preferences are authoritative for recognized acts; the simulant still
   owns unrecognized edges). Clamp ±`AFFINITY_DELTA_CLAMP`; diagnostic on unresolved
   target/concept.
7. **Forge** — infer `preferences` from the prose sketch in the profile section
   (`authoring/character-forge.ts`), alongside the existing inference.
8. **Editor** — a "Disposition" tab on `character-editor.tsx`: a preference list
   (concept/family picker + like/dislike + intensity + optional per-entry hint).
   Intimate concepts fenced behind the same exposure gate as intimate attributes.
9. **Tests + docs** — pure-curve tests (deadband, grace, thin-ice, like cap/asymmetry,
   clamp); merge suppression + diagnostic; intake degradation (no `socialAct` ⇒ prior
   behaviour) asserting fallback **and** diagnostic, per testing.md. Docs:
   `contracts.md` (concept registry + `Preference`), `turn-engine.md` (the `socialAct`
   seam, the reaction step, the merge suppression rule), `prompts.md` (the reaction
   line in the volatile context), `authoring.md` (forge field + Disposition tab).

### 2. Atomic traits + trait scaling — _not started_

Spec §3, §5, §7. Adds the generic dispositional dynamics and **fills the `traitScale`
seam** Slice 1 stubbed.

1. **Shared registry spine** — lift `buildRegistry`/`valueSchemaFor`
   (`attributes/registry.ts`) + the `resolveAttributes` precedence (`attributes/value.ts`)
   into a generic the attribute **and** personality registries call (keeps jscpd green;
   traits inherit base/creation/manual overlays for free).
2. **Trait registry** — `contracts/personality/` categories (temperament/social/
   intimate), bipolar scalars + bands, `mutability`, `intimate?`, `modulates?` (spec
   §3). `traits: TraitValue[]` on the profile/snapshot.
3. **Disposition block (cached)** — render trait **bands** as behavioural guidance in
   the static rulebook / canonical-facts region (`engine/scene.ts`) — closes
   character-schema audit **C1**. Intimate trait bands ride the exposure gate (shared
   with intimacy-notes).
4. **Wire `traitScale`** — `evaluateSocialAct`'s `traitScale` now reads real traits
   (`agreeableness` damps dislikes, `possessiveness` amplifies `jealousy_trigger`);
   the `modulation.ts` coefficient module (spec §5: `affinityGain` / `meterBaseline` /
   `meterReactivity`) lands here too.
5. **Agents / forge / editor** — simulant slice gains trait bands; forge infers trait
   values (prose → numbers); editor sliders + band readout. Tests + docs.

### 3. Mood + meter-baseline generalization — _not started_

Spec §4. Adds valence and per-character drift.

1. **Meter generalization** — `baseline?` / `recoveryPerHour?` on `MeterDefinition`
   (`contracts/meters`), backward-compatible (absent ⇒ today's pole-seeking). Drift
   seeks `baseline` at `recoveryPerHour`, clamped.
2. **`mood` meter + derived descriptor** — a new valence meter; `buildMeterConditionBlock`
   blends valence × stress/energy into a descriptor (spec §4).
3. **Trait-derived baselines** — `optimism→mood.baseline`,
   `libido→arousal.baseline/recovery`, `composure→stress.recovery`, resolved at drift
   time.
4. **Mood coupling** — the Slice 1 preference reaction now also nudges `mood` valence
   (like ↑, dislike ↓). Tests + docs.

### 4. Affinity trait-coupling — _not started; folds into affinity-decay work_

Spec §4 (affinity) / §10. Trait-scaled gain asymmetry + decay target/rate. **Do not
duplicate** — fold into
[cast-tiers-and-affinity-spec.phase3.md](cast-tiers-and-affinity-spec.phase3.md) when
affinity decay is built.

## Not in scope (v1 / this plan)

Deferred to later slices or specs (spec §11): `developable` trait **drift** (character
arcs) — design the field, defer the rule; **per-relationship** mood/disposition;
**NPC→NPC** social-act classification (intake is player-only); **player**
traits/preferences surfaced to NPCs; **multi-act** turns (v1 takes intake's primary
concept). The `personality` free-text blob's fate (colour line vs forge input vs
removed) is decided when traits land (Slice 2).

## Open questions

Restated from
[spec §11](personality-and-state.spec.md#11-open-questions-restate-in-the-plan);
resolving one = remove it here and record the ruling in the spec. (The "where
modulation lives" question is **settled** for preferences — deterministic + affinity-
aware — so it is not relisted.)

**Gate Slice 1 (decide before/at build):**

- **Response-curve constants** — design the curve now and tune `κ`/`λ`/deadband + the
  like↔dislike asymmetry in playtesting (recommended), or pin starting values in the
  spec?
- **Concept families** — ship family-level targeting in v1, or flat concepts with
  `family` as a written-but-unused seam (recommended)?
- **Multi-act turns** — primary concept only in v1 (recommended), or several
  acts/preferences resolved per turn?
- **Mood coupling** — affinity only in v1 (mood doesn't exist until Slice 3), fold the
  mood nudge in then (recommended).
- **Simulant suppression granularity** — suppress the whole player→NPC edge for the
  turn (recommended, simplest), or net only against the matched delta?

**Gate later slices:**

- **Trait value type** — scalar-with-bands (recommended) vs enum.
- **Separate `contracts/personality/` registry** (recommended) vs a new attribute `kind`.
- **Mood shape** — stored valence + derived descriptor (recommended) vs multi-axis
  vector vs purely derived.
- **`developable` trait drift** — design the field now, defer the rule (recommended).
- **NPC→NPC acts / player preferences / per-relationship disposition** — player→NPC
  only in v1 (recommended).
- **`personality` blob fate** — colour line vs forge input vs remove once traits cover
  it.
