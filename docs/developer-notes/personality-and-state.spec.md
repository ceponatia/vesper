# Personality & evolving state — atomic traits that drive mood / affinity / arousal — spec

Status: **draft / analysis** (2026-06-17; revised 2026-06-18 — social-reaction layer §6
over a deferred social-fabric **card** seam, character **tags** + bespoke preferences,
**mood↔affinity** coupling, and the out-of-character **puppet guardrail**, per the PM
notes). A design study, not a build plan: it
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

**Traits are one of two mechanisms this spec proposes.** Traits answer *how much* and
*how fast* — the generic dynamics every event rides — and, read on the *input* side,
they are the **guardrails** that refuse out-of-character player puppeting (§6, Note 2).
They do **not** say which acts a character welcomes or resents: a warm, agreeable NPC
still has things she loves and things she can't stand. That second, content-specific
axis — **social reactions** (§6): a shared social fabric of importable taboo/social-rule
cards plus each character's **tags** and **bespoke** likes/dislikes — is the most
directly *game-like* piece, and the cleanest answer to "stop relying on the narrator to
improvise the reaction." Where traits *scale* the response, the social fabric and the
character's disposition pick its **sign and base**, and current affinity/mood *bend* it
— all composed in the same deterministic merge.

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

### Authoring lexicon & tags (Note 4) — words in, scalars out

Each trait file is a **governing trait** (the axis — bipolar `temperament.warmth`, or a
unipolar `neurotic`) that *also* carries a **scored member-term lexicon**: the words a
user or the forge might type, each mapped to a position on the axis.

```ts
// inside a trait definition
lexicon: Array<{ term: string; value: number }>;
//   neurotic (unipolar): { "high-strung": 60, "anxious": 65, "paranoid": 90 }
//   warmth   (bipolar):  { "cold": -80, "aloof": -50, "kind": 55, "doting": 90 }
```

This is the load-bearing mechanism for **forge expansion** (§9, Note 3): "bratty" maps
onto a governing trait at a score, and the forge pulls *sibling* terms from the same
lexicon to flesh out a sparse sketch. It is also how **intake/authoring** turn free-text
personality into stored scalars without an enum. For now the scores feed a **simple
check when a trait is referenced in code**; richer score-weighted behaviour is a later
system (Note 4).

**Tags** are the coarse companion to scalar traits: short reusable labels (`bratty`,
`foot-fetish-positive`, `prudish`) that **social-reaction cards key their overrides on**
(§6). A tag is cheaper than a full trait and is the unit of content reuse across worlds;
a character carries both — scalars for dynamics, tags for card-driven reactions — and
the forge proposes tags from the same prose. Tags are a **dev-defined canonical
registry** (`contracts/personality/tags.ts`) so card `reactionOverrides` and character
tags match reliably; the editor and forge offer them by **autocomplete** as the author
types. Free-form tags are tolerated but **second-class in this stage** — no autocomplete,
and not guaranteed to match a card override.

**Traits are also guardrails.** The disposition that *colours* narration (the cached
block, §7) is read on the **input** side to **refuse** player narration that contradicts
it — the out-of-character puppet deflection in §6. That dual role is the whole point of
Note 2: a personality the player can override with one sentence isn't a personality.

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

**Mood ↔ affinity is a bidirectional couple (Note 5).** Affinity is how the character
sees the player *overall*; mood is how she *feels right now*, driven by interactions
**and** recent game events (the event→mood table is its own later plan). The two
modulate each other, both as deterministic merge math:

- mood **scales social-reaction magnitudes** — the `μ` factor in §6's curve (a bad mood
  damps a compliment's lift and sharpens a slight); and
- affinity **scales mood updates** — high-affinity presence lifts a low mood a little
  (it's not magic), and how much any event moves mood depends on standing.

The event→mood inputs and the full coupling matrix are planned with the mood slice; v1's
curve carries `mood` as a neutral stub (§6).

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

### Affinity: more levels, and scale the delta and the decay by traits

Affinity already has the right storage and surfacing. It also gains **more levels**
(Note 5) — the current seven stages widen so progression reads less coarsely; a
`stages.ts` data edit folded in with the affinity-decay work (§10). Add trait coupling at
the two existing seams in the merge (`turn-engine.md` §Merge step 5):

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

## 6. Social reactions — authored likes/dislikes over a shared social fabric

This is the literal "make it a game, not narrator improv" ask: a character's reaction
to a player's social act is decided by a **deterministic, layered** lookup — *not* the
narrator — which then feeds the narrator the verdict. It is the most directly
*game-like* mechanism in this spec. Two layers supply that verdict: a **shared social
fabric** (importable taboo / social-rule **cards**, world-scoped) and **per-character
disposition** (reusable **tags** that cards key overrides on, plus **bespoke**
likes/dislikes). **v1 builds the character layer + the resolution seam; the card layer
is deferred to its own plan** and plugs into the seam later, replacing today's
`world.style.norms`.

### Three jobs — classify, resolve, narrate

A reaction to "the player complimented Sabrina; she didn't like it" is three steps, and
the turn engine already owns the first and third:

1. **Classify** *(fuzzy ⇒ LLM)* — `"her dress looks lovely"` → the canonical concept
   `compliment`, targeted at Sabrina. The **intake agent**'s job (`engine/intake.ts`,
   the only pre-narration LLM — turn-engine.md §Intake); its `IntentBrief` already
   classifies `actionType`, so we add a persisted `socialAct: { concept, target }` seam
   beside `movement`/`appointment`/`check`.
2. **Resolve + evaluate** *(deterministic ⇒ data — the new part)* — the layered lookup
   below yields a verdict and a magnitude. **No LLM.**
3. **Narrate** *(the narrator — but instructed)* — it receives a reaction hint and
   writes the prose. It no longer **decides the verdict**.

Classification *must* be fuzzy (only a model reads "her dress looks lovely" as
flattery); the verdict *must* be authored (that is what "stop relying on the narrator"
means). Keeping the verdict in **data** is what makes it a game rule, not a vibe.

### The shared concept vocabulary (the "dictionary")

A small controlled vocabulary under `contracts/personality/` of **interaction
concepts** that intake classifies into, and that both bespoke preferences and (later)
card triggers reference — so intake has **one stable classification target** and the
two disposition layers speak the same language:

```ts
type InteractionConcept = {
  id: string;                      // "compliment", "gift", "tease", "jealousy_trigger"
  label: string; description: string;
  family?: string;                 // cluster: "affection_display", "aggression", …
  triggers: readonly string[];     // examples that steer the intake prompt (NOT regex)
  defaultHint: string;             // narrator guidance when matched (overridable)
  intimate?: boolean;              // kiss/grope/proposition — fenced + exposure-gated (§3)
};
```

Your fawning/doting/gift example is a **cluster, not synonyms**: each is its own
concept, all tagged `family: "affection_display"`, so a dislike can target one concept
**or** a whole family. Start flat (~8–12 concepts); `family` is a forward seam. (This
refines the companion-app card model, whose cards carry *free* `triggerKeywords` — here
cards reference concept ids instead, so intake never chases a moving target.)

### The layered disposition model (tags + bespoke + cards)

Character disposition rides `CharacterProfile` JSONB (defaults empty, no migration):

```ts
tags: string[]            // reusable labels cards' overrides key on: "bratty", "foot-fetish-positive", "prudish"
preferences: Preference[] // bespoke one-offs
type Preference = {
  target: string;         // a concept id OR a family id
  valence: "like" | "dislike";
  intensity: number;      // base magnitude (the curve scales it)
  hint?: string;          // per-character override of the concept's defaultHint
};                        // carries the AttributeValue provenance shape (base/creation/manual)
```

A classified `socialAct` resolves with a fixed **precedence** (most specific wins):

1. a matching **bespoke preference** on the character, else
2. a **card `reactionOverride`** whose tag the character carries — the foot-fetish flip:
   a world `foot-fetish` taboo defaults to revulsion, but a character tagged
   `foot-fetish-positive` overrides to *enjoy*, else
3. the **card's default reaction** for its severity tier, else
4. **nothing** — the narrator plays it straight (today's behaviour).

Resolution is **pure override**: the first matching layer wins outright — layers never
stack. (If the world disapproves of public affection and a character *also* dislikes it,
she simply shares society's view; there is nothing to add. If they disagree, her
personal view wins.)

One pure entry point hides the layering from callers:

```ts
resolveSocialReaction(act, { tags, preferences, cards }) → SocialReaction | null
```

**v1 passes `cards: []`** — only the bespoke character layer is live — so the card plan
later supplies world cards (and tag-keyed overrides) without touching a single caller.
`null` ⇒ play it straight. Intimate-concept preferences are fenced behind the same
exposure gate as intimate traits; forge infers `tags`/`preferences` and the editor's
Disposition tab edits them (§9).

### The social-reaction card seam — deferred to its own plan

The card layer mirrors the companion-app `TabooCard` (`taboo-reaction-engine.ts`):
importable across worlds **like items**; `triggers` (concept ids), `severity`→tier
(`odd`/`disapproval`/`shunning`/`ostracized`), tier `defaultReactions` (a reaction kind
+ narrator prompt + an **asymmetric** affinity/mood delta — easy to lose, slow to gain),
and `reactionOverrides` keyed on character **tags**. It is a build of its own (schema +
DB + editor + cross-world import + forge) and lands as `social-reaction-cards.plan.md`
(to create). When it ships it **replaces** today's `world.style.norms`
(`worldNormSchema`), the rudimentary World-page social-rule editor + its world-forge
hookup, and the continuity agent's `normBreaches` path — all removed then; v1 leaves
them untouched (§10).

### The response curve — affinity- and mood-aware (the load-bearing rule)

What makes reactions feel like a relationship rather than a lookup table: **the
realized magnitude is a nonlinear function of current state** — current **affinity**
(the NPC's perceived edge toward the player, `participant_relationships`, decision 41)
and current **mood** (Note 5). One pure function, fed whatever `resolveSocialReaction`
returned:

```ts
evaluateSocialReaction(reaction, currentAffinity, currentMood, traits)
  → { valence, magnitude, band, hint }
```

- **Goodwill buys grace.** High affinity damps a *dislike*; the tolerance band widens
  with affinity, so a **minor** infraction against someone who already likes you nets
  **zero** change — the deadband you called for.
- **Thin ice amplifies.** Low/negative affinity sharpens the sting.
- **Likes are gentler, asymmetric, capped.** Diminishing returns near the top, a modest
  "pleasant surprise" bump when low — but capped, so a hostile NPC can't be
  flattery-spammed into friendship. Easy to lose, slow to win.
- **Mood bends it too** (Note 5). A bad mood damps positive lift and sharpens negatives;
  a good mood the reverse. Mood and affinity are a **bidirectional** couple — affinity
  also scales how much an interaction moves *mood* (high-affinity presence lifts a low
  mood a little) — but that mood-update path ships with the mood slice (§4). **In v1
  `currentMood` is a NEUTRAL stub** (factor 1, no effect); the signature carries it now
  so wiring real mood later touches no callers.

Illustrative shape (constants in `engine/constants.ts`; one tested pure function), for a
dislike with base `m₀`, affinity `a ∈ [−100, 100]`, mood factor `μ` (neutral = 1):

```
T     = κ · max(0, a)                       // goodwill → tolerance
raw   = max(0, m₀ − T)                      // deadband: a slip under T ⇒ 0 change
sting = raw · (1 + λ · max(0, −a)/100) · μ  // hostility + bad mood amplify
delta = −traitScale(traits) · sting         // §5 trait scaling, then clamp ±AFFINITY_DELTA_CLAMP
```

Trait scaling (§5) rides on top (`agreeableness` damps dislikes, `possessiveness`
amplifies `jealousy_trigger`); the ±5 clamp is the final guard. This is §5's modulation
**generalized from `f(traits)` to `f(traits, currentState)`** — same deterministic-merge
philosophy, two more inputs. **Starting constants** (κ≈0.04, λ≈1.0, like-damping≈0.6 + a
capped surprise bonus, mood factor 1±0.3, `intensity` on a 1–10 scale) are proposed in
the plan and tuned in playtest — placeholders, not commitments.

**The same function is called twice — the key invariant.** Pre-narration it yields the
**band + hint** the narrator plays; post-narration (merge) it yields the **number**
applied to affinity (and, later, mood). One source of truth ⇒ "she lets it slide" can
never contradict a silent −3. Both calls have the current affinity/mood already loaded
for the relationship-stage block.

### The disposition guardrail — refusing out-of-character puppeting (Note 2)

A *different* failure than reacting to the player's own act: here the player authors the
**NPC's** behaviour — "Sabrina tells me I'm handsome and gives me a warm hug" to a
character authored *bratty*. Disposition is only real if the player can't simply narrate
it away, so traits/tags are **guardrails**, not just flavour:

- **Detect** — intake flags player-authored NPC behaviour, generalizing the existing
  `movement.kind: "narrated_npc"` seam to a `narratedNpcBehavior` signal (dialogue,
  affection, or action attributed to an NPC).
- **Judge** *(deterministic, fed by intake)* — intake classifies the *puppeted*
  behaviour into the same concept vocabulary as a `socialAct`; a deterministic rule
  compares its affective direction to the NPC's disposition (tags + bespoke preferences
  now; full traits + affinity + mood once they exist). Behaviour that **contradicts**
  disposition is refused; consistent behaviour is **honoured**. *(Shipped Slice 2:
  `checkPuppetContradiction` reads the act's concept **`polarity`** against the tag
  **`warmth`** lean + **`wontInitiate`** families, with **preferences taking precedence** —
  a `dislike` is a contradiction, an authored `like` is consent to puppet. Tag `warmth`/
  `wontInitiate` are the first slice of machine-readable "what a tag means"; free-form tags
  carry no affect and are invisible to the guardrail.)*
- **Deflect** — when it contradicts, the narrator is directed **not to honour it** and to
  answer with an **overt, cheeky meta aside** (the chosen handling — old-text-adventure
  flavour):
  > (Sabrina raises an eyebrow — she'll choose her own words, thanks.)

  The puppeted action never reaches state. The guardrail fires on *contradiction*, not on
  the mere act of writing an NPC — consistent, in-disposition narration is honoured. This
  is the input-side half of the same disposition data, and a node in the pre-narrator
  before/during/after guardrail mesh
  ([pre-narrator-agents.spec.md](pre-narrator-agents.spec.md)).

  **Forward note (record in code + docs).** Honouring consistent puppeting is a v1
  leniency: we may later strengthen this so the player cannot author NPC behaviour from
  the *player* prompt at all — routed instead through the companion / narrator
  out-of-player-POV affordances (which need their own improvement first).

### Threading the pipeline

- **Classify** — intake writes `socialAct` (and the `narratedNpcBehavior` guardrail
  flag) into the persisted `IntentBrief` (empty on OOC/companion turns; the regex
  fallback leaves it empty ⇒ nothing fires).
- **Resolve + evaluate for the narrator** *(pre-narration, deterministic)* — a new
  pre-turn step, sibling to the relationship-stage block, runs
  `resolveSocialReaction` → `evaluateSocialReaction` and emits a **reaction line** into
  the *volatile* turn context (never the cached prefix — see §7); when the puppet flag
  is set, it instead/also emits the deflection directive:
  > Brian complimented Sabrina; she finds flattery cloying — but you're close, so she
  > lets it pass with a wry look rather than a rebuff.
- **Apply** *(post-narration, merge §5 / step 5)* — the same function's delta is applied
  to the player→NPC edge after decay; for the recognized act the merge **suppresses the
  simulant's `affinityAdjustments` on that edge** (the disposition layer is
  authoritative for acts it recognizes; the simulant still owns every *unrecognized*
  affinity event — suppression is **whole-edge** for the turn). The **mood nudge ships
  with the mood slice** (v1 applies affinity only). The brief models `socialActs` as an
  **array** (forward-compatible headroom); v1 resolves only the **primary**
  (highest-significance) act — multi-act resolution is deferred, not silently dropped.
- **Degrade** — intake off, no concept, or no source match ⇒ no delta ⇒ today's
  behaviour (simulant owns affinity). `parseOr` at the JSONB boundary; empty
  `tags`/`preferences` ⇒ no-op. The degradation test asserts the fallback **and** the
  diagnostic.

### Why this is the game, not improv

Authored + deterministic ⇒ the same act at the same state ⇒ the same outcome, every
time: debuggable, unit-testable, tunable per character in the editor. The narrator's
remaining job is **prose, not verdict** — the explicit ask. It layers cleanly: **the
social fabric (cards) + the character's tags/preferences pick the sign + base, current
affinity and mood bend it nonlinearly, traits scale it, the clamp guards it** — and the
same disposition data, read on the input side, becomes the guardrail that refuses
out-of-character puppeting.

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
   The free-text `personality` is demoted to a forge *input* that produces the
   trait/tag/preference values (§9, Note 3), not a separately-surfaced paragraph.

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

4. **Social-reaction line + puppet-deflection directive** (§6) live in the
   **volatile** turn context (never cached). A character's `tags` themselves never
   surface to the model — they drive card/override lookups, not prose.

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
- **Tags & preferences** ride the same `CharacterProfile` JSONB — `tags: string[]`,
  `preferences: Preference[]` (default `[]`). No migration. The **social-reaction
  cards** they reference are a *separate* DB-backed plan
  (`social-reaction-cards.plan.md`), not part of this storage surface.
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

**Forge — procedural disposition with graceful degradation (Note 3).** The profile
section infers the structured disposition — **trait scalars, tags, and bespoke
preferences** — the way it infers core-visual attributes today (`character-forge.ts`),
so a creator can move fast and refine later. A ladder by how much the user gave:

1. **A few terms** ("kind," "bratty") — take each **literally** (map it onto a governing
   trait via that trait's lexicon, §3), then **expand**: pull sibling lexicon terms and
   let the model infer adjacent traits/tags, so one word becomes a rounded disposition.
2. **No personality terms, but other detail** — infer a disposition that *fits* what the
   user did give (role, species, look, backstory).
3. **Nothing useful** — invent a coherent disposition outright.

Everything it writes is a starting point the user can edit — the point is **rapid**
creation without forcing anyone through the minutiae. The free-text `personality` blob
becomes a forge *input* that yields the structured disposition (resolving the blob-fate
question, §11).

**Editor — a "Disposition" tab** with: a slider + band readout per trait (mirrors the
attribute picker); a **tag editor** (add/remove reusable labels); and a **bespoke
like/dislike list** (concept/family picker + like/dislike + intensity + optional hint).
Intimate traits and intimate-concept preferences are fenced behind the same exposure
gate as intimate attributes.

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
- **Social-reaction cards (new — `social-reaction-cards.plan.md`, to create)** — the
  deferred social-fabric layer §6 resolves against. Modelled on the companion-app
  `TabooCard` (importable like items; concept triggers; severity tiers; tag-keyed
  `reactionOverrides`). When it ships it **replaces** today's `world.style.norms`
  (`worldNormSchema`), the rudimentary World-page social-rule editor + its world-forge
  hookup, and the continuity agent's `normBreaches` path — all removed then.
- **`pre-narrator-agents.spec.md`** — the puppet guardrail (§6, Note 2) is a node in its
  before/during/after guardrail mesh, generalizing the existing `movement.kind:
  "narrated_npc"` seam to player-authored NPC *behaviour*.

## 11. Open questions (restate in the plan)

**Resolved this revision** (rulings now live in the cited sections; dropped from the
plan's open list). From the PM notes + earlier recommendations:

- *Trait value type* → **scalar with bands** (§3). · *Separate registry* → **yes,
  `contracts/personality/`** (§3). · *Mood shape* → **stored valence + derived
  descriptor** (§4). · *`developable` drift* → **design the field, defer the rule**
  (§3/§7). · *Player / NPC→NPC / per-relationship disposition* → **player→NPC only in
  v1** (§6). · *`personality` blob fate* → **demote to a forge input** (§9, Note 3). ·
  *Concept families* → **flat v1, `family` a forward seam** (§6). · *Where modulation
  lives* → **deterministic merge** (§5/§6).
- *Social-fabric sequencing* → **seam now, cards deferred** to
  `social-reaction-cards.plan.md` (§6/§10). · *Disposition data* → **tags + bespoke**
  (§3/§6). · *Puppet handling* → **overt cheeky meta aside** on out-of-character
  puppeting (§6, Note 2). · *Mood scope* → **seam now (neutral stub), mood later**
  (§4/§6).

**Resolved 2026-06-18 (second pass — nothing now blocks v1):**

- *Response-curve constants* → **design now with the starting values above** (§6),
  tuned in playtest.
- *Tag vocabulary governance* → **dev-defined canonical registry + editor/forge
  autocomplete**; free-form tolerated but second-class this stage (§3).
- *Puppet-contradiction judgment* → **deterministic verdict fed by intake's concept
  classification** (§6); **consistent puppeting is honoured** in v1, with a forward note
  to later strengthen it via the companion/narrator out-of-POV affordances (§6).
- *Multi-act turns* → **`socialActs` array headroom, resolve the primary in v1** (§6).
- *Simulant suppression granularity* → **whole player→NPC edge for the turn** (§6).
- *Cards × bespoke stacking* → **pure override**, no stacking (§6) — agreement adds
  nothing, disagreement lets the personal view win.

**Future scope (not v1 open questions):** curve-constant tuning is a playtest task;
the **event→mood table** is its own later plan (§4); strengthening the puppet guardrail
rides on improving the companion/narrator out-of-player-POV affordances (§6).
