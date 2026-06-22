# Mood — design truth (spec)

Status: **draft** — the design detail behind [mood.plan.md](mood.plan.md). Owns the
**`EmotionLabel`** vocabulary (shared app-wide, incl. the avatar) and the pure
**emotion projection** + **event→mood** shapes. Read the plan first for scope/why.

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
UI, and any future consumer import it.

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

`deriveEmotionLabel` is a pure function over already-computed state:

```ts
type EmotionInputs = {
  mood: number;        // valence 0..1 (the meter)
  arousal: number;     // 0..1
  stress: number;      // 0..1
  energy: number;      // 0..1
  affinityStage: AffinityStage;        // toward the player (warmth)
  reaction?: ReactionBand;             // latest social-reaction result (the beat)
  conditions: ActiveCondition[];       // tipsy / flustered / hurt …
  intimateContext: boolean;            // scene is in an intimate frame — gates `aroused` (NOT wardrobe undress)
  dominance?: number;                  // trait, tilts low-valence → angry vs sad
};

deriveEmotionLabel(i: EmotionInputs): { emotion: EmotionLabel; intensity: number };
```

`intensity` = normalized distance from neutral (how hard the state pushes), `0..1`,
drives expression weight (slight smile → beam).

## 4. The projection (precedence ladder)

Resolve the **transient beat** first (it wins briefly), else the **baseline**.
Starting thresholds — tune in playtest.

**Transient beat** (if `reaction` present and `|magnitude|` ≥ ~0.3, hold ~1.5–2s):
1. surprise/boundary act → `surprised` (+ `gasp` reaction one-shot).
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

## 5. The event→mood table (structure)

Generalizes the lone social-reaction nudge into a registry of event kinds → mood
delta, scaled by the coupling matrix. Shape (pure, like the reaction curve):

```ts
type MoodEvent =
  | { kind: "social_reaction"; magnitude: number }   // exists today
  | { kind: "scene_atmosphere"; atmosphere: AtmosphereLabel }
  | { kind: "condition"; conditionId: string }
  | { kind: "story_beat"; signal: "develop" | "resolve" | "betray" }
  | { kind: "presence"; companyAffinityStage: AffinityStage }
  | { kind: "physical"; meter: "energy" | "hygiene"; value: number };

moodDelta(event: MoodEvent, ctx: { affinityStage; traits }): number; // clamped
```

Coupling matrix (extend what shipped): **affinity scales** how far an event moves
mood; **mood scales** reaction magnitude (`μ`, exists); **traits** damp/amplify
(`composure` steadies, `optimism` lifts the floor). Every path clamped; sums applied
in the merge alongside meter drift. v1 wires a subset (open questions in the plan).

`AtmosphereLabel` is **owned by [avatar-3d.spec.md](avatar-3d.spec.md)** (it's a cue
channel); mood imports it here as a `scene_atmosphere` input. Atmosphere *nudges*
mood (trait-damped) but is **not** the character's emotion — a composed companion
holds calm in a tense room.

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
  `contracts/personality/reactions.ts` (`ReactionBand`).
