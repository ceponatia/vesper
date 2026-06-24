# Mood — design truth (spec)

Status: **draft** — the design detail behind [mood.plan.md](mood.plan.md). Owns the
**`EmotionLabel`** vocabulary (shared app-wide, incl. the avatar) and the pure
**emotion projection** + **event→mood** shapes. Read the plan first for scope/why.
The structure is settled (open questions resolved 2026-06-24).

Slug `mood`. Constants here are *starting values* tuned in playtest (the pattern
set by the reaction curve in `reactions.ts` / `modulation.ts`).

## 1. Two layers, one read

Mood produces two things on different timescales, both **derived** (no new stored
state beyond the existing `mood` meter):

- **Baseline emotion** (slow) — from the meter vector + affinity. Changes at beat
  boundaries; this is the sustained face.
- **Transient beat** (fast) — from the latest social-reaction result. A spike that
  plays then decays back to baseline (hysteresis). This is "she just reacted."

Consumers that want prose use the existing `deriveMoodDescriptor` (→ narrator).
Consumers that want a discrete label use the new **`deriveEmotionLabel`** (→ avatar
cue, UI mood chip). Both are pure reads over the same state.

## 2. `EmotionLabel` — the shared vocabulary

One enum, app-wide. Lives in `src/contracts/mood/` (mood owns it); the avatar,
UI, and any future consumer import it. **Locked at these 11 (decision 2026-06-24)** —
the avatar cue widens from its original 8 (`avatar-3d.notes.md`) to import the full
set, and `contracts/mood/` does not yet exist (this slice creates it).

| `EmotionLabel` | Feels like | Primary signal | VRM 1.0 preset (3D lane) | Gating |
| --- | --- | --- | --- | --- |
| `neutral` | even keel | valence ≈ 0.5, low activation | `neutral` | — |
| `happy` | bright, pleased | high valence | `happy` | — |
| `affectionate` | warm, tender | high valence + warm affinity stage, low stress | `happy`+`relaxed` blend | — |
| `playful` | teasing, flirty | high valence + energy + recent tease/flirt | `happy` (smirk variant) | — |
| `flustered` | bashful, blushing | flirt/compliment beat at low–mid affinity, or `flustered` condition | `surprised`+`happy` blend (+ blush texture) | — |
| `concerned` | worried, attentive | mid-low valence + mod stress, low arousal | `sad` (slight) | — |
| `sad` | down, hurt | low valence + low energy/arousal | `sad` | — |
| `angry` | cross, displeased | low valence + negative reaction / dislike hit / high dominance | `angry` | — |
| `afraid` | alarmed, anxious | low valence + high stress + high arousal | `surprised`+`sad` blend | — |
| `surprised` | startled | surprise/boundary beat (mostly transient) | `surprised` | — |
| `aroused` | flushed, heavy-lidded | high `arousal` meter | `relaxed`+ (custom) | **intimate context** (not undress — see note) |

Notes:
- **11 labels**: 10 ungated + `aroused`. `aroused` is gated on **intimate context**
  — the scene is in an intimate/romantic frame (same family of signal as the image
  pipeline's `allowIntimate`), driven by the `arousal` meter. It is **NOT** gated on
  *wardrobe exposure* (region `bare`/`sheer`): a clothed character can be aroused, so
  this is deliberately distinct from the image rule `intimateAttrRendersExposed`,
  which gates whether intimate *anatomy* is drawn. Lazy-gen means only labels that
  actually occur get a sprite frame.
- **VRM mapping is lossy** (presets are 6: neutral/happy/angry/sad/relaxed/surprised)
  — several labels need blends or custom expressions in the 3D lane. The **2D sprite
  lane has full freedom** (any expression we generate), a point in its favor.
- `surprised`/`flustered` are usually *beats*, not sustained baselines; `aroused`/
  `affectionate`/`sad` are usually baselines. The enum is unified; the layer (§1)
  decides whether a label is held or pulsed.

## 3. The emotion state vector (projection inputs)

`deriveEmotionLabel` is a pure function over already-computed state. It reuses the
**existing** types:

- `EvaluatedReaction` — `contracts/personality/reactions.ts:101` (`{ valence, magnitude, band, hint }`).
- `RelationshipStage` — `contracts/relationships/stages.ts` (ids `hostile`…`smitten`).
- `ActiveCondition` — `contracts/conditions/condition.ts`.

(Earlier drafts wrote `ReactionBand`/`AffinityStage`; those names don't exist — use
the types above.)

```ts
import type { EvaluatedReaction } from "@/contracts/personality/reactions";
import type { RelationshipStage } from "@/contracts/relationships/stages";
import type { ActiveCondition } from "@/contracts/conditions/condition";

type EmotionInputs = {
  mood: number;        // valence 0..1 (the meter)
  arousal: number;     // 0..1
  stress: number;      // 0..1
  energy: number;      // 0..1
  affinityStage: RelationshipStage["id"];    // warmth toward the player (hostile…smitten)
  reaction?: EvaluatedReaction;              // latest social-reaction result (the beat)
  conditions: readonly ActiveCondition[];    // tipsy / flustered / hurt …
  intimateContext: boolean;                  // scene is in an intimate frame — gates `aroused` (NOT wardrobe undress)
  dominance?: number;                        // trait, tilts low-valence → angry vs sad
};

deriveEmotionLabel(i: EmotionInputs): { emotion: EmotionLabel; intensity: number };
```

`intensity` = normalized distance from neutral (how hard the state pushes), `0..1`,
drives expression weight (slight smile → beam).

## 4. The projection (precedence ladder)

Resolve the **transient beat** first (it wins briefly), else the **baseline**.
Starting thresholds — tune in playtest.

**Transient beat** (if `reaction` present and `|magnitude|` ≥ ~0.3, hold ~1.5–2s):
1. surprise/boundary act, or an **unwelcome touch** (§5) → `surprised` (+ `gasp`/
   `flinch` recoil one-shot).
2. strong positive (liked, big magnitude) → `happy`/`affectionate` spike (+ `laugh`/`nod`).
3. flirt/compliment at low–mid affinity → `flustered` (+ `blush`).
4. negative (disliked) → flicker `sad` (low dominance) or `angry` (high dominance)
   (+ `flinch`/`sigh`).

**Baseline** (no active beat) by valence band:
- **High** (`mood` > ~0.65): warm affinity (`close`+) & low stress → `affectionate`;
  else high energy + recent playfulness → `playful`; else → `happy`.
- **Mid** (~0.40–0.65): low activation → `neutral`; rising stress → `concerned`.
- **Low** (`mood` < ~0.40): high stress + high arousal → `afraid`; high stress, mid
  arousal → `concerned`; low energy/arousal → `sad`; negative-reaction memory or
  high dominance → `angry`.
- **Override (gated):** `arousal` > ~0.6 **and** `intimateContext` → `aroused`
  (intimate frame — *not* contingent on being undressed).
- **Condition tints:** `tipsy`/high intoxication → loosen (nudge toward `playful`/
  `affectionate`, raise the high-band threshold); `flustered` condition → `flustered`.

`intensity` scales with band distance and reaction magnitude; clamp `0..1`.

### 4a. Mapping representation (keep it a clean grid, not a tangle)

The baseline above reads `stress`/`energy`/`arousal` ad hoc per band. Collapse that
into **one derived `activation ∈ 0..1`** — a weighted blend of `energy` (drive),
`stress` (tension), and `arousal` (charge) — so the baseline is a tidy **valence ×
activation** lookup plus a few gated overrides (`aroused`, condition tints), not a
nest of per-meter conditionals. Low activation + mid valence → `neutral`; high
valence + high activation → `playful`; high valence + low activation → `affectionate`;
low valence + high activation → `afraid`/`angry`; low valence + low activation →
`sad`. Same precedence (beat → override → baseline), cleaner to read and to tune.

Keep the projection an **imperative pure function with exported named constants**
(the activation weights, the ~0.40/~0.65 valence cuts, the activation bands, the 0.3
beat floor, the 1.5–2s hold) — mirroring `reactions.ts` / `modulation.ts`, where the
logic is code and only the tuning numbers are data. A full declarative label-registry
would be over-engineering for an 11-way map; the constant block is enough surface to
tune in playtest. (Not the `meterDefinitions`-style data registry — that pattern fits
open-ended vocabularies, not a fixed projection.)

## 5. The event→mood table (structure)

Generalizes the lone social-reaction nudge into a registry of event kinds → mood
delta, scaled by the coupling matrix. Shape (pure, like the reaction curve):

```ts
type MoodEvent =
  | { kind: "social_reaction"; magnitude: number }                 // v1 — exists today
  | { kind: "touch"; concept: string; intimate: boolean }          // v1 — welcome-ness gated below
  | { kind: "condition"; conditionId: string }                     // v1
  | { kind: "scene_atmosphere"; atmosphere: AtmosphereLabel }      // v1
  | { kind: "story_beat"; signal: "develop" | "resolve" | "betray" } // deferred
  | { kind: "presence"; companyStage: RelationshipStage["id"] }    // deferred
  | { kind: "physical"; meter: "energy" | "hygiene"; value: number }; // deferred

// ctx carries the existing types (RelationshipStage id + TraitValue[]); clamped.
moodDelta(event: MoodEvent, ctx: { affinityStage: RelationshipStage["id"]; traits: readonly TraitValue[] }): number;
```

Coupling matrix (extend what shipped): **affinity scales** how far an event moves
mood; **mood scales** reaction magnitude (`μ`, exists); **traits** damp/amplify
(`composure` steadies, `optimism` lifts the floor). Every path clamped; sums applied
in the merge alongside meter drift. v1 wires the subset tagged above (see the plan's
_Decisions_).

**Welcome/unwelcome touch** (v1, decision 2026-06-24). A touch act
(`physical_affection`, or an `intimate` touch concept) resolves a **welcome-ness**
from the affinity stage, with a preference override:

- **Welcome** — stage ≥ `warm`, *or* a `like` preference on the touch concept → mood
  ↑, a small stress ↓.
- **Unwelcome** — stage ≤ `cool`, *or* a `dislike`/boundary preference → mood ↓,
  stress ↑ (a `flinch` recoil beat in the projection, §4 beat #1).
- **Neutral band** — between `cool` and `warm` with no preference → a faint, mostly
  no-op nudge (ambiguous contact, neither tender nor a violation).

Trait-damped: `composure` steadies the swing, `agreeableness` softens the unwelcome
drop. The `warm`/`cool` gate stages are *starting values* tuned in playtest. This is
the existing reaction curve's affinity terms (the surprise/hostility amplifiers in
`reactions.ts`) specialized to touch — **no new authoring**. **Forward hook:** weight
by the body location touched (the phase-4 body model) once intimacy notes land — an
unwelcome intimate-location touch should hit harder than a hand on the arm. Deferred.

`AtmosphereLabel` is **owned by [avatar-3d.spec.md](avatar-3d.spec.md)** (it's a cue
channel); mood imports it here as a `scene_atmosphere` input. Atmosphere *nudges*
mood (trait-damped) but is **not** the character's emotion — a composed companion
holds calm in a tense room. `RelationshipStage`/`TraitValue` are the existing types
(`contracts/relationships/stages.ts`, `contracts/personality/traits/`).

## 6. Resilience

`parseOr` at the JSONB/turn boundary; unknown enum or missing input → degrade to
the meter-only baseline (and ultimately `neutral`), emit a diagnostic, never fail
the turn (`docs/resilience.md`). `deriveEmotionLabel` is total — it always returns a
label.

## Related

- [mood.plan.md](mood.plan.md) — scope, consumers, build order.
- [avatar-3d.spec.md](avatar-3d.spec.md) — the `AvatarCue` that consumes
  `EmotionLabel` + the projection; owns `AtmosphereLabel`/`PoseLabel`/`ReactionLabel`.
- `finished/personality-and-state.spec.md` §4 — the shipped mood meter + coupling
  this extends.
- `src/contracts/meters/registry.ts` (`mood`, `deriveMoodDescriptor`),
  `contracts/personality/reactions.ts` (`EvaluatedReaction`, `moodNudge`),
  `contracts/relationships/stages.ts` (`RelationshipStage`),
  `contracts/personality/traits/value.ts` (`TraitValue`),
  `contracts/conditions/condition.ts` (`ActiveCondition`).
