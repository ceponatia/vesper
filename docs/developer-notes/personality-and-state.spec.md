# Personality & evolving state — atomic traits that drive mood / affinity / arousal — spec

Status: **draft / analysis** (2026-06-17; +authored likes/dislikes layer §6, 2026-06-18). A design study, not a build plan: it
analyses the narrator + agent prompts and the current contracts, then proposes
how to represent **atomic personality fields** and wire them so they *shape how a
character's transient states (mood, affinity, arousal, …) evolve over time*. A
`personality-and-state.plan.md` should follow before code; open questions are
restated there at that point.

Reads on: [contracts.md](../contracts.md) §Attribute system / §Meters /
§Relationship stages, [prompts.md](../prompts.md), [turn-engine.md](../turn-engine.md)
§Post-turn agents, [resilience.md](../resilience.md). Overlaps and should be
reconciled with [cast-tiers-and-affinity-spec.phase3.md](cast-tiers-and-affinity-spec.phase3.md)
(affinity is already a state of this shape) and
[intimacy-notes.spec.md](intimacy-notes.spec.md) (the intimate-disposition note
is the prose sibling of the intimate *traits* proposed here).

---

## 1. The problem, and what already exists

The ask has two halves that the current code treats as unrelated:

1. **Atomic personality fields.** Today a character's personality is a single
   free-text blob, `CharacterProfile.personality` (`contracts/world/profile.ts:18`).
   It is **not surfaced to the in-session narrator or any post-turn agent** — the
   only characterization reaching the narrator is `bio` (NPC via
   `buildCanonicalFactsBlock`, `engine/scene.ts:686`; player via `playerContext`,
   `engine/prompts/narrative.ts:149`). The character-schema audit flags this as
   finding **C1** ("`personality` never reaches a prompt"). The *sessionless* Chat
   harness is the one consumer (`engine/prompts/character-chat.ts:106`) — so we
   already know prose personality *works* there; we just never wired it into play,
   and a blob is the wrong shape for the second half of the ask.

2. **Evolving states over time.** Two state families already exist and already
   "evolve," but with **no personality input** — every character metabolises
   events identically:
   - **Meters** (`contracts/meters/registry.ts`) — `hygiene`, `energy`, `stress`,
     `arousal`, `intoxication`: continuous 0–1, drift via a **fixed global
     `perHour`** toward a **fixed pole** (0 or 1), nudged per turn by the
     simulant's `meterAdjustments`, threshold `promptHint`s surfaced in
     `buildMeterConditionBlock` (`scene.ts:858`).
   - **Affinity** (`contracts/relationships/stages.ts`,
     `participant_relationships` table) — a per-edge −100..100 scalar → seven
     **stages**; evolves via the simulant's `affinityAdjustments` (±5 clamp) and a
     slow decay toward the current stage's edge; **stages, never numbers**, reach
     the prompt (`buildRelationshipBlock`, `scene.ts:1048`).
   - **Mood does not exist** at all.

The key observation: the machinery for "a number that drifts and responds to
events, surfaced to the prompt as a *band label*" is **already the dominant
pattern** (meters → threshold hints; affinity → stages). What is missing is (a) a
representation for personality that is itself atomic, and (b) a coupling so that
**personality parameterises the dynamics** of those states.

## 2. Thesis: traits parameterise state dynamics

Separate two things the word "personality" conflates:

| | **Traits** (stable disposition) | **States** (transient) |
|---|---|---|
| Examples | warmth, composure, libido, guardedness | mood, affinity, arousal, stress |
| Timescale | session-stable; rare slow "character arc" drift | move every few turns |
| Storage | `CharacterProfile` (profile/snapshot) | `ParticipantState` / `participant_relationships` |
| Surfacing | cache-stable disposition block | volatile turn-context state lines |

The thing that makes traits "facilitate evolving states" is exactly one idea:

> **A state today drifts toward a fixed pole at a fixed rate and responds to
> events with a fixed gain. Generalise all three to be per-character functions of
> that character's traits: a trait sets where a state *rests* (baseline), how hard
> an event *moves* it (reactivity/gain), and how fast it *returns* (recovery).**

Concretely:
- A **warm, optimistic** NPC: mood baseline high; affinity *gains* amplified.
- A **guarded, volatile** NPC: affinity gains damped but losses amplified; mood
  swings wide and recovers slowly.
- A **high-libido, uninhibited** NPC: arousal rises faster, decays slower, rests
  slightly elevated.

This is a deliberate, testable, token-cheap coupling, and it degrades to *exactly
today's behaviour* when a character has no traits (empty trait set ⇒ unit
coefficients ⇒ current fixed dynamics).

**Traits are one of two mechanisms this spec proposes.** Traits answer *how much*
and *how fast* — the generic dynamics every event rides. They do **not** say which
acts a character welcomes or resents: a warm, agreeable NPC still has things she
loves and things she can't stand. That second, content-specific axis — **authored
likes/dislikes** (§6) — is the most directly *game-like* piece, and the cleanest
answer to "stop relying on the narrator to improvise the reaction." Where traits
*scale* the response, preferences pick its **sign and base**, current affinity
*bends* it, and the two compose in the same deterministic merge.

## 3. Tier 1 — atomic traits: a parallel registry

**Recommendation: a new `contracts/personality/` registry, mirroring the
attribute registry, NOT a new `kind` inside `attributes/`.** Why separate:

- The attribute registry feeds the **image models** and is **body-gated**
  (`realizeBody`, `bodyLocationId`, `imageReveal`, `intimate.ts` fencing).
  Personality has none of that and must *never* leak to an image prompt; a
  separate registry makes that structural, not a filter we must remember.
- It lets the **intimate/sexual trait subset be fenced** exactly like
  `attributes/categories/intimate/` (withheld from moderation-prone routes).
- The registry *spine* (`buildRegistry`, `value.ts`'s provenance + precedence) is
  generic enough to **factor and share** — do that so jscpd stays green and so
  traits inherit base/narrative/manual overlays for free (which is also the
  mechanism a future "character-arc drift" rides). Under the hood: lift the
  `buildRegistry`/`valueSchemaFor` spine (`attributes/registry.ts:51`) and the
  `resolveAttributes` precedence (`attributes/value.ts:51`) into a shared
  generic the attribute and personality registries both call.

### Trait representation — scalar with bands (mirror affinity, not enums)

A trait is a **numeric scalar with registry-defined bands** — the affinity
pattern (`stages.ts`) applied per trait: **store the number, surface the band
label, compute from the number.** This is the single most consistent choice — it
matches affinity (number stored, stage shown, number computed) *and* meter
thresholds (value → `promptHint`), and unlike enums it gives the modulation math
a continuous knob.

```ts
type PersonalityTraitDefinition = {
  id: `${TraitCategory}.${string}`;       // e.g. "temperament.warmth"
  label: string; description: string;
  axis: "bipolar" | "unipolar";           // bipolar −100..100 (cold↔warm); unipolar 0..100
  default: number;                          // resting value at creation (forge may override)
  bands: Array<{ max: number; label: string; promptHint: string }>;  // like stages / thresholds
  mutability: "core" | "developable";      // core never drifts; developable allows slow arc (deferred)
  intimate?: boolean;                       // fenced + exposure-gated surfacing (see §7, intimacy-notes)
  promptHints?: readonly string[];          // phrasing guidance, deduped like attribute hints
  modulates?: readonly TraitModulation[];   // declarative link to state dynamics (§5)
};
```

Trait **values** reuse the `AttributeValue` provenance shape (`{ id, value,
source, sourceId?, note? }`) so `base`/`creation` (forge), `manual` (editor), and
later `narrative` (a director-proposed arc shift) compose with the same
last-write-wins precedence.

### Starter vocabulary (illustrative — the registry is the contract, not this list)

Conservative starter set, grouped into categories (one file each, like attribute
categories), every one a bipolar scalar unless noted:

- **temperament** — `warmth` (cold↔warm), `composure` (volatile↔even-keeled),
  `confidence` (timid↔assured), `optimism` (gloomy↔sunny — the **mood-baseline**
  driver).
- **social** — `extraversion`, `agreeableness`, `guardedness` (open↔guarded — the
  **affinity-gain damper**), `dominance` (submissive↔dominant).
- **intimate** (fenced subfolder, exposure-gated surfacing) — `libido` (low↔high,
  the **arousal** driver), `inhibition` (uninhibited↔inhibited), `possessiveness`
  (the jealousy axis).

Adding a trait is a one-file data edit + a registry-invariant test, identical to
adding an attribute or meter.

## 4. Tier 2 — states: add mood; generalise meter drift to a baseline

### Mood (new) = one stored valence axis + a derived descriptor

Don't build a bespoke multi-axis mood vector. The codebase already carries most
of a PAD (Pleasure–Arousal–Dominance) picture: `arousal` (a meter), `stress` and
`energy` (activation/tension), and `dominance` (a trait). The only missing piece
is **valence** (positive↔negative affect). So:

- **Store one new state, `mood` (valence)** — recommend reusing the **meter
  registry** (`mood` as a 0–1 or −1..1 meter in `ParticipantState.meters`) so
  drift, thresholds, world-overrides, and the simulant's `meterAdjustments`
  pipeline all apply with **zero new schema**.
- **Present a *derived* mood descriptor** by blending valence with the existing
  activation/tension meters in `buildMeterConditionBlock` — e.g. low valence +
  high stress → "tense and withdrawn"; high valence + high energy → "bright and
  playful". Mood is a *read* over the state, not a second source of truth.

### The load-bearing change: meters seek a trait-derived baseline

Today `applyMeterDrift` (`meters/registry.ts:92`) moves every value toward 0/1 by
a fixed `perHour`. Generalise:

```ts
type MeterDefinition = {
  // …existing…
  baseline?: number;            // resting target (default: today's implied pole)
  recoveryPerHour?: number;     // rate toward baseline (default: |perHour|)
};
```

- Drift becomes "move toward `baseline` at `recoveryPerHour`," clamped as now.
  Absent fields ⇒ today's pole-seeking behaviour exactly (backward compatible).
- The **per-character** baseline/recovery is then resolved from traits at drift
  time: `mood.baseline = f(optimism)`, `arousal.baseline & recovery = f(libido)`,
  `stress.recovery = f(composure)`. The global `MeterDefinition` value is the
  no-trait default; traits shift it per participant.

### Affinity: scale the delta and the decay by traits

Affinity already has the right storage and surfacing. Add trait coupling at the
two existing seams in the merge (`turn-engine.md` §Merge step 5):

- **Gain/loss asymmetry**: the simulant still emits a *raw* event-grounded
  `affinityAdjustments` delta; the merge **scales it per-character before the ±5
  clamp** — `warmth`/`agreeableness` amplify positive deltas, `guardedness` damps
  them, `composure` damps negatives. (This composes with norm-stance modulation,
  already planned in the affinity spec §Norm stances.)
- **Decay**: trait sets the decay target/rate — a `loyal` (high warmth + low
  volatility) character decays slower / toward a higher floor than a `fickle` one.

## 5. Tier 3 — the modulation layer (deterministic, pure, testable)

One pure module, `contracts/personality/modulation.ts`, maps trait values →
coefficients the merge applies:

```ts
affinityGain(rawDelta: number, traits: ResolvedTraits): number   // scaled, pre-clamp
meterBaseline(meterId: string, traits: ResolvedTraits): number   // drift target
meterReactivity(meterId: string, traits: ResolvedTraits): number // event-delta gain
```

Keep it **data-driven where it pays**: a trait def's `modulates` entry declares
`{ target: "affinity" | "meter:arousal" | "meter:mood", aspect: "gain" |
"baseline" | "recovery", curve }`, and the module sums contributions. For v1 a
small explicit table is acceptable; the declarative form is the extension point.

**Why deterministic merge math, not "let the agent decide"** (the load-bearing
architecture call):
- Matches [resilience.md](../resilience.md) §3 — clamp everything in the reducer,
  trust nothing from the model; the dynamics hold even when the agent degrades.
- Flat token cost: no extra agent output, no extra schema fields to validate.
- Clean separation of duties: **the agent grounds *whether and how much* an event
  happened in the narration; traits (in the merge) decide *how this particular
  character metabolises it*.** The simulant should not also be doing personality
  psychology — that is exactly the giant-schema anti-pattern the agent design
  avoids.

## 6. Preferences & reactions — authored likes/dislikes, affinity-aware

This is the literal "make it a game, not narrator improv" ask: a character declares
**what she likes and dislikes**, and a deterministic layer — *not* the narrator —
decides whether a player's act landed well or badly, then feeds the narrator the
verdict. It is the most directly *game-like* mechanism in this spec: authored data,
deterministic resolution, debuggable and tunable per character in the editor.

### Three jobs — and the pipeline already does two of them

A reaction to "the player complimented Sabrina; she didn't like it" is really three
steps, and the turn engine already owns the first and third:

1. **Classify** *(fuzzy ⇒ LLM)* — `"her dress looks lovely"` → the canonical concept
   `compliment`, targeted at Sabrina. This is exactly the **intake agent**'s job
   (`engine/intake.ts`, the only pre-narration LLM — turn-engine.md §Intake). Its
   `IntentBrief` already classifies `actionType` (`social_attempt`, `intimate`, …);
   we add one persisted seam, `socialAct: { concept, target }`, mirroring the
   existing `movement`/`appointment`/`check` seams.
2. **Match + evaluate** *(deterministic ⇒ data — the new part)* — concept ∩ Sabrina's
   declared dislikes → a verdict and a magnitude. **No LLM.** This is the
   "dictionary," modelled as a registry plus per-character preference data below.
3. **Narrate** *(the narrator — but instructed)* — it receives a reaction hint in the
   turn context and writes the prose. It no longer **decides the verdict**.

The split is the whole point. Classification *must* be fuzzy — only a model reads
"her dress looks lovely" as flattery. The verdict *must* be authored — that is what
"stop relying on the narrator" means. Keeping the match in **data** (not the agent,
not the narrator) is what makes it a game rule instead of a vibe.

### The interaction-concept registry (the "dictionary")

A new registry under `contracts/personality/` — a controlled vocabulary of
**interaction concepts** the intake classifier maps free text onto, and that surface
preferences point at:

```ts
type InteractionConcept = {
  id: string;                      // "compliment", "gift", "tease", "jealousy_trigger"
  label: string; description: string;
  family?: string;                 // cluster tag: "affection_display", "aggression", …
  triggers: readonly string[];     // examples that steer the intake prompt (NOT regex)
  defaultHint: string;             // narrator guidance when matched (per-pref overridable)
  intimate?: boolean;              // kiss/grope/proposition — fenced + exposure-gated like intimate traits (§3)
};
```

Your fawning/doting/gift-giving example is a **cluster, not synonyms**: each is its
own concept, all tagged `family: "affection_display"`. A dislike can then target a
single concept **or** a whole family — "dislikes affection-displays" catches
compliments, doting, *and* gifts at once. **Start flat** with ~8–12 concepts
(`compliment`, `gift`, `flirt`, `tease`, `reassure`, `confide`, `insult`,
`criticize`, `boundary_push`, `jealousy_trigger`, `physical_affection`,
`public_display`); `family` is the forward-compatible seam, populated lazily. Adding
a concept is a one-file data edit + a registry-invariant test, like any other
registry.

### The character's likes & dislikes

On `CharacterProfile` (JSONB, default `[]`, no migration) — the authored game data:

```ts
type Preference = {
  target: string;                  // a concept id OR a family id
  valence: "like" | "dislike";
  intensity: number;               // base magnitude (small; the curve scales it)
  hint?: string;                   // per-character override of the concept's defaultHint
};                                 // carries the AttributeValue provenance shape (base/creation/manual)
```

Inferred by the **forge** from the prose sketch (alongside trait values, §9) and
edited on the **Disposition tab** (§9) next to traits — intimate-concept preferences
fenced behind the same exposure gate as intimate traits.

### The affinity-aware response curve — the load-bearing rule

This is the refinement that makes reactions feel like a relationship rather than a
lookup table: **the realized magnitude is a nonlinear function of current affinity**
(the NPC's *perceived edge* toward the player — the `participant_relationships`
value, decision 41). One pure function:

```ts
evaluateSocialAct(concept, pref, currentAffinity, traits)
  → { valence, magnitude, band, hint }
```

- **Goodwill buys grace.** High current affinity damps a *dislike*: a friend gives
  you the benefit of the doubt. The tolerance band widens with affinity, so a
  **minor** infraction against someone who already likes you nets **zero** change —
  the deadband you called for.
- **Thin ice amplifies.** Low or negative current affinity sharpens the sting — the
  same act costs more when she already dislikes you.
- **Likes are gentler and asymmetric.** Diminishing returns near the top (she
  already adores you ⇒ less to gain) and a modest "pleasant surprise" bump when low —
  but **capped**, so a hostile NPC can't be flattery-spammed into friendship. Easy
  to lose, slow to win.

Illustrative shape (constants in `engine/constants.ts`; the curve is one tested pure
function), for a dislike with base `m₀` and affinity `a ∈ [−100, 100]`:

```
T     = κ · max(0, a)                  // goodwill → tolerance
raw   = max(0, m₀ − T)                 // deadband: a slip under T ⇒ 0 change
sting = raw · (1 + λ · max(0, −a)/100) // hostility amplifies
delta = −traitScale(traits) · sting    // §5 trait scaling on top, then clamp ±AFFINITY_DELTA_CLAMP
```

Trait scaling (§5) rides on top — `agreeableness` damps dislikes, `possessiveness`
amplifies `jealousy_trigger` — and the existing per-turn ±5 clamp is the final guard.
This is precisely §5's modulation **generalized from `f(traits)` to
`f(traits, currentState)`**: the same deterministic-merge philosophy, one more input.

**The same function is called twice — that is the key invariant.** Pre-narration
(prompt assembly, after intake) it yields the **band + hint** the narrator plays;
post-narration (merge) it yields the **number** applied to affinity/mood. One source
of truth ⇒ the narrator's "she lets it slide" can never contradict a silent −3. Both
calls have `currentAffinity` on hand — it is already loaded for the relationship-stage
block.

### Threading the pipeline

- **Classify** — intake writes `socialAct` into the persisted `IntentBrief` (empty on
  OOC/companion turns like the rest of the brief; the regex fallback leaves it empty
  ⇒ no preference fires).
- **Evaluate for the narrator** *(pre-narration, deterministic)* — a new pre-turn
  step, sibling to the relationship-stage block, emits a **reaction line** into the
  *volatile* turn context (never the cached prefix — see §7):
  > Brian complimented Sabrina; she finds flattery cloying — but you're close, so she
  > lets it pass with a wry look rather than a rebuff.
- **Apply** *(post-narration, merge §5 / step 5)* — the same function's delta is
  applied to the player→NPC edge after decay; for the recognized act the merge
  **suppresses the simulant's `affinityAdjustments` on that edge** (the preference
  layer is authoritative for acts it recognizes; the simulant still owns every
  *unrecognized* affinity event). A parallel nudge moves `mood` valence (like ↑,
  dislike ↓). v1 takes intake's **primary** concept per turn; richer multi-act turns
  (a compliment *and* an insult to the same NPC) are deferred — flag it, don't
  silently drop.
- **Degrade** — intake off, no concept, or no matching preference ⇒ no delta ⇒ today's
  behaviour (simulant owns affinity). `parseOr` at the JSONB boundary; empty
  `preferences` ⇒ no-op. The degradation test asserts the fallback **and** the
  diagnostic.

### Why this is the game, not improv

Authored + deterministic ⇒ the same act at the same affinity ⇒ the same outcome,
every time: debuggable, unit-testable, tunable per character in the editor. The
narrator's remaining job is **prose, not verdict** — the explicit ask. And it layers
cleanly with the rest of the spec: **preferences pick the sign + base, current
affinity bends it nonlinearly, traits scale it, the clamp guards it.**

## 7. Passing it to the characters — the surfacing design

This is the literal ask: *how do atomic personality fields reach the characters?*
Two consumers (narrator, agents) and a **caching split** that the two-block prompt
architecture (`prompts.md` §The two-block narrative prompt) forces.

### Narrator — stable disposition (cached) vs current state (volatile)

1. **Disposition block** (new, in the **static rulebook / canonical-facts**
   region — prefix-cache-stable because `core` traits don't change). Renders trait
   **bands** as behavioural guidance, never numbers:

   > **Lena** — Warmth: *guarded* (slow to show affection). Composure: *volatile*
   > (quick to flare, slow to settle). Confidence: *assured*.

   This finally wires personality into play (closes audit C1) — but as **atomic,
   structured guidance the model follows more reliably than a prose paragraph**.
   The free-text `personality` can survive as one trailing "colour" line, or be
   demoted to a forge input that *produces* the trait values.

2. **Current-state lines** (in the **volatile turn context** — never cached).
   Extend `buildMeterConditionBlock` with the **derived mood descriptor**, and
   keep the existing relationship-stage block:

   > **Lena** — mood: *tense, withdrawn*; activity: drying glasses; [arousal
   > threshold hint]; *close* toward Brian, believes Brian is *friendly*-warm.

   Stable traits in the cached prefix, transient mood/affinity in the uncached
   tail — so per-turn state changes never bust the prefix. (If `developable` trait
   drift is ever enabled, recompute disposition bands only at session boundaries to
   keep the prefix stable; rare drift busting the cache occasionally is acceptable.)

3. **Intimate traits** ride the **exposure gate** already designed for the
   intimacy note: surface `libido`/`inhibition`/`possessiveness` bands (and the
   intimacy prose note) only when the turn's `ExposureMask` reaches the intimate
   tier (`intimacy-notes.spec.md` §When it surfaces). One gate, both signals.

### Agents

- **Simulant** — its state slice (`buildSimulantPrompt`, `prompts/agents.ts:154`)
  gains each character's **trait bands + current mood** so its raw deltas read
  in-character ("a guarded person warms slowly; she's already tense"). The
  *scaling* stays deterministic in the merge — the agent reports the
  event-grounded raw delta, the merge applies the trait coefficient. Mood needs no
  new agent field if it's a meter (it rides `meterAdjustments`).
- **Director** — already emits `characterNotes` ("behavior/mood/relationship
  notes," `prompts/agents.ts:86`); traits give it grounded vocabulary, and a later
  hook lets it propose **`developable` trait drift** as a long-arc `narrative`-source
  overlay (deferred — see open questions).
- **Continuity** — unaffected; traits are dispositions, not canon to contradict.

## 8. Storage, migration, resilience

- **Traits** ride `CharacterProfile` JSONB — `traits: TraitValue[]` (default
  `[]`) on the profile and the participant snapshot. No DB migration.
- **Mood** rides `ParticipantState.meters` as a new `mood` meter id — no schema
  change beyond the registry entry.
- **Affinity/meter generalisation** is backward-compatible: empty traits ⇒ unit
  coefficients; absent `baseline`/`recoveryPerHour` ⇒ today's pole-seeking. So a
  character with no traits plays **byte-for-byte like today** — the
  resilience.md §3 "the fallback is the previously-live path" pattern, again.
- `parseOr` at the JSONB boundary with the empty defaults; all modulation results
  clamped in the merge regardless of trait values (meter [0,1], affinity ±5/turn).
- Degradation tests assert the fallback **and** the diagnostic, per testing.md.

## 9. Forge & editor

- **Forge** profile section infers atomic **trait values** the way it infers
  core-visual attributes today (`character-forge.ts`), instead of (or alongside) the
  prose sketch — the prose becomes a forge *input* that yields the numbers.
- **Editor** gains a "Disposition" tab with a slider + band readout per trait
  (mirrors the attribute picker), intimate traits fenced behind the same gate as
  intimate attributes.

## 10. Relationship to existing specs

- **`cast-tiers-and-affinity-spec.phase3.md`** — affinity *is* the first state of
  this shape (scalar → band, event-driven, decaying). This spec's only addition
  there is **trait-scaled gain/decay**; it should be folded in when affinity decay
  is built, not duplicated.
- **`intimacy-notes.spec.md`** — its per-character `intimacy` note is the **prose
  sibling** of the intimate *traits* here, and both want the **same exposure
  gate** and fencing. Recommend designing them together: intimate traits = the
  mechanical arousal driver; the `intimacy` note = the gated narrative flavour.
  Intimacy-notes may become a sub-section of the personality plan.

## 11. Open questions (restate in the plan)

- **Trait value type** — numeric-scalar-with-bands (recommended) vs enum (simpler
  authoring, no modulation knob)?
- **Mood shape** — single stored valence + derived descriptor (recommended) vs a
  multi-axis stored vector vs purely derived (no new stored state)?
- **Where modulation lives** — deterministic merge (recommended) vs agent-driven
  vs hybrid? *(Settled for preferences (§6): deterministic + affinity-aware curve,
  computed once and shared between the narrator hint and the merge delta.)*
- **Separate registry** (recommended) vs a new `kind` in the attribute registry?
- **Player traits** — surface the player's disposition to shape NPC reactions
  (mirrors the intimacy-notes open question), or NPC-only in v1?
- **`developable` trait drift (character arcs)** — ship the drift mechanism in v1
  or design the field now and defer the drift rule (cf. affinity tier-drift)?
- **Per-relationship mood/disposition** ("how she is *with this partner*") —
  defer (matches intimacy-notes out-of-scope), or model from the start?
- **`personality` blob fate** — keep as a trailing colour line, demote to a forge
  input, or remove once traits cover it?
- **(§6) Response-curve constants** — design the affinity-aware curve now, tune
  κ/λ/deadband + the like↔dislike asymmetry in playtesting later (recommended), or
  pin starting values in the spec?
- **(§6) Concept families** — ship family-level cluster targeting in v1, or flat
  concepts first with `family` as a written-but-unused seam?
- **(§6) Multi-act turns** — resolve only intake's *primary* concept per turn (v1),
  or several recognized acts against several preferences in one turn?
- **(§6) NPC→NPC acts** — intake only classifies *player* acts; do NPC-on-NPC social
  acts ever trigger preferences (needs a post-turn classifier), or player→NPC only
  in v1?
- **(§6) Mood coupling** — a like/dislike nudges `mood` valence too (recommended),
  or affinity only?
- **(§6) Simulant suppression granularity** — when a preference fires, suppress the
  simulant's affinity on the *whole* player→NPC edge for that turn (recommended,
  simplest), or only net it against the matched delta?
