[← Contracts index](README.md)

# Meters

**Meters** are continuous numbers (0–1) that drift over time — hygiene, energy, arousal, and so on. They and the mood module below are pure registries the character-chat lane and the successor engine both read.

## Meters

A meter is continuous 0–1 state that drifts with the clock, defined as data in `meters/registry.ts`:

```ts
type MeterDefinition = {
  id: string;
  label: string;
  description: string;
  initial: number;
  perHour: number;                  // signed drift per game hour
  baseline?: number;
  recoveryPerHour?: number;
  thresholds: Array<{
    below?: number;
    above?: number;
    promptHint: string;
    pipLabel?: string;
    visibleEffects?: readonly string[];
  }>;
};
```

| Field                   | Meaning                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                    | e.g. `hygiene`, `energy`, `arousal`, `stress`, `intoxication`, `mood`.                                                                                                                                                                                                                                                   |
| `label` / `description` | Display text.                                                                                                                                                                                                                                                                                                            |
| `initial`               | Starting value.                                                                                                                                                                                                                                                                                                          |
| `perHour`               | Signed drift per game hour.                                                                                                                                                                                                                                                                                              |
| `baseline`              | The resting target. *Absent* ⇒ today's pole: `perHour < 0` ⇒ 0, else 1.                                                                                                                                                                                                                                                  |
| `recoveryPerHour`       | Rate of movement toward `baseline`. *Absent* ⇒ `\|perHour\|`.                                                                                                                                                                                                                                                            |
| `thresholds`            | Crossing one surfaces its `promptHint` to the narrator; `pipLabel` is the same band's short UI chip ("tipsy") — the chat status strip derives from it, so a band edit moves narration and UI together. `visibleEffects` is a third, independent consumer — see [§Visible effects in images](#visible-effects-in-images). |

**Drift.** On every clock advance, `applyMeterDrift` moves each value toward its baseline at `recoveryPerHour` — never overshooting, clamped to `[0, 1]` — and surfaces any crossed-threshold `promptHint`s to the narrator. A consumer may override or disable individual meters in its config (`meterOverrides`).

**Drift is per-character.** At drift time the consuming lane resolves trait-shifted baseline/recovery via `personalizeMeters` ([relationships.md](relationships.md) §Modulation); the global value is the no-trait default. Absent `baseline` / `recoveryPerHour` ⇒ exactly the old pole-seeking drift.

### Starter meters

| Meter          | Behavior                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `hygiene`      | 1 → 0 at −0.04/h; thresholds prompt scent/grime hints.                                                                                        |
| `energy`       | 1 → 0 waking drain; restored by sleep.                                                                                                        |
| `stress`       | 0-seeking.                                                                                                                                    |
| `arousal`      | 0-seeking; graded physiology + intimate-scene reads — see [§Graded arousal physiology](#graded-arousal-physiology-intimate-scenes-afterglow). |
| `intoxication` | 0-seeking, fast decay.                                                                                                                        |
| `mood`         | Emotional valence — 0 low / 0.5 even / 1 bright; baseline 0.5, returns to an even keel.                                                       |

### Visible effects in images

A threshold's optional `visibleEffects: readonly string[]` names the paintable phrases an image
prompt may state for that band; absent (every threshold but four) means the band is silent in
images. It is a **third consumer of `thresholds`**, independent of `promptHint` (the narrator's
prose) and `pipLabel` (the UI chip): a band can carry all three, and `visibleEffects` never
derives from the other two — the registry is the one owner of the exact image wording.

`contracts/visual-state/meters.ts`'s `projectMeterFeatures` asks `meterStateCue` for a subject's
single deepest crossed band per meter (the same read the chat strip and the narrator cue split
use) and mints a `meter.visible_effect` current-layer visual-state fact only when that band
declares `visibleEffects`. A shallower band, a meter with no ruled band, or a raw scalar never
reach an image prompt this way. The owner's ruling (issue #427) authors exactly four bands:

| Meter          | Band (bound)            | `visibleEffects`                                   |
| -------------- | ----------------------- | -------------------------------------------------- |
| `intoxication` | `drunk` (above 0.7)     | "glassy, unfocused eyes"                           |
| `hygiene`      | `unwashed` (below 0.3)  | "lank, greasy hair", "grimy skin"                  |
| `energy`       | `exhausted` (below 0.2) | "heavy-lidded eyes", "dark circles under the eyes" |
| `arousal`      | `flushed` (above 0.55)  | "parted lips"                                      |

No `visibleEffects` phrase ever uses "flushed", "blush" or a colour synonym — the owner reports
those render as stage makeup on several models, not a body state. The arousal meter's own
registered `promptHint` ("Visibly affected: flushed skin…") still names that band for the UI
strip's pip chip (`chat-status.tsx`, keyed off `pipLabel`) and this `visibleEffects` row alone;
the 1-on-1 lane's OWN narration no longer reads it — see
[§Graded arousal physiology](#graded-arousal-physiology-intimate-scenes-afterglow), which
replaces it with a richer, flush/blush-free read. The projected fact is `current`-layer, so it is
scene-current state, not the stable chat-look identity anchor: the chat-look pack suppresses
`subject.current_state` the same way it suppresses a wet cut or an active condition
([../images/pipelines/chat-images.md](../images/pipelines/chat-images.md) §The look anchor).

### Graded arousal physiology (intimate scenes, afterglow)

The single flat arousal threshold above still drives the UI pip and the image
`visibleEffects` row, but the 1-on-1 lane's own "Current state" narration section instead
reads a graded physiology (`contracts/meters/arousal-signs.ts`, `deriveChatArousalRead`) — a
thin adapter over the successor simulation's intimacy read
([../engine/bodies.md](../engine/bodies.md)): `quiescent → kindled → flushed → wound_tight →
cresting`, with an active `afterglow` condition overriding the scale outright. Units convert
at the boundary (the chat meter is 0..1; the shared read is fixed-point 0..10 000), so both
lanes share one set of phase boundaries and one afterglow duration
(`CHAT_AFTERGLOW_DURATION_MINUTES` = 30 story minutes, mirroring the successor's
`AFTERGLOW_DURATION_SECONDS` — owner ruling 2026-09-27: one shared value, never a second
chat-only number). The read is perception-gated by a `detailTier` (0 = nothing perceived, 2 =
plain sight, 3 = engaged attention); the 1-on-1 lane always passes 3 for its co-present
primary. None of its own narration prose uses "flush"/"blush" or a colour synonym, even
though the shared read's internal band id happens to be spelled "flushed".

**The one scene-level intimate-activity read.** The reaction pulse (`chat-pulse.ts`) reports
ONE optional field, `intimateScene: "active" | "completed" | null`, resolved once and shared
with the [hygiene cost](#hygiene-cost-of-an-intimate-scene) below — never a second detector or
model call off the same exchange:

- **`"active"`** — an intimate/sexual act is ongoing this exchange. The ordinary
  concept-driven arousal bump (an intimate act raises arousal, courtship/physical affection
  half as much) still applies, and a self-expiring `heated` condition renews
  (`CHAT_HEATED_CONDITION_MINUTES`): while it stands, `integrateChatMeters`'s
  `suspendsMeterDrift` hook holds arousal's ambient drift still, so a scene spanning several
  exchanges — or one degraded pulse in the middle of it — doesn't read as visibly cooling
  between beats.
- **`"completed"`** — the exchange resolves the scene to climax. Arousal SETTLES to at most
  `CHAT_AROUSAL_AFTERGLOW_SETTLE` (comfortably below the flushed floor, even for a
  high-libido profile cresting a moment before) — this REPLACES, never adds to, that same
  exchange's ordinary concept bump. Mood lifts and stress eases
  (`CHAT_AFTERGLOW_MOOD_LIFT` / `CHAT_AFTERGLOW_STRESS_EASE`), and the standing `heated`
  condition gives way to `afterglow`.
- **`null`** (most turns, and every missing/malformed read — the schema `.catch()`s it like
  every other pulse field) — neither branch runs. Ambient clock drift remains the backstop
  for a completion the pulse never classified: arousal keeps decaying toward baseline on its
  own once nothing is renewing `heated`. A genuinely ABSENT `intimateScene` degrades silently,
  same as any other pulse field; a PRESENT value that fails its leaf schema instead pushes
  `chat_state.pulse.intimate_scene_unreadable` through the sink (`pulse-agent.ts`'s
  `reportIntimateSceneIfUnreadable`) — distinguishable from silence, and from the whole-pulse
  `chat_state.pulse.degraded` — while still resolving to `null` and applying no new effect.

#### Hygiene cost of an intimate scene

The same `intimateScene` read costs a little hygiene (#303): `"active"` costs
`CHAT_HYGIENE_INTIMATE_ACTIVE` each exchange it continues, `"completed"` costs the larger
`CHAT_HYGIENE_INTIMATE_COMPLETED` — a standalone cost, deliberately **not** stacked with the
active cost the same exchange (the two are mutually exclusive reads of one field). A
missing/degraded read leaves hygiene untouched apart from the elapsed-time drift already due.
The update rides the same `ChatState.meters` object every other pulse effect does, so it
shares the same persistence and "another take" retake boundary automatically.

Arousal's render-time disinhibition is narrower than intoxication's: it lowers only
`intimate.inhibition`, never `social.guardedness` or `temperament.composure` (see
[relationships.md](relationships.md) §Modulation, `stateDispositionOverlays`).

### Mood

Mood is surfaced not as raw threshold hints but as a **derived descriptor**: `deriveMoodDescriptor` blends valence × stress/energy into phrases like "low and on edge" or "bright and playful". It also couples with affinity:

- the social-reaction curve reads mood as its `μ` factor (`moodMeterToFactor`), and
- a reaction nudges mood back (`moodNudge`).

#### The mood module — labeled emotion + event→mood (`apps/web/src/contracts/mood/`)

A second, discrete read sits beside the prose descriptor:

- **`EmotionLabel`** — the locked app-wide 11-label vocabulary (`neutral`/`happy`/`affectionate`/`playful`/`flustered`/`concerned`/`sad`/`angry`/`afraid`/`surprised`/`aroused`; `aroused` is gated on an *intimate frame*, not undress). Owned here; the avatar cue + UI mood chip import it.
- **`deriveEmotionLabel`** — a pure, **total** projection: a *transient beat* (the latest `EvaluatedReaction`) wins briefly, else a *baseline* from a derived `activation` axis (energy/stress/arousal) × valence + affinity stage + conditions. Surfaced via the shared `MoodChip` on the **character-chat strip** (`chatStateSnapshot` → `ChatStateSnapshot.emotion`, with the character's dominance + intimate-capable context).
- **Event→mood table** — generalizes the lone reaction nudge, as pure contract helpers the consuming lane wires into its drift/reaction step. **Impulse** events apply one-time deltas: the social reaction (above) and **welcome/unwelcome touch** (`resolveTouchWelcomeness` + `touchMoodDeltas`, affinity-stage gated with a preference override — a touch with no preference swings mood/stress by warmth). **Standing** influences shift the mood *baseline* (no per-turn compounding): `atmosphereMoodBaselineShift`. Conditions reach mood through the discrete projection instead — `deriveEmotionLabel` tints its baseline from condition labels — not through a meter-baseline shift.

> The old app's 7-vector hygiene model becomes `hygiene` + conditions (`sweaty`, `soaked`, `unwashed`, with region notes) — same play feel, no bespoke code path. Region-level scent composition is deliberately replaced by: item `sensory` text + hygiene threshold hints + exposure gating ([../character-chat/perception-gates.md](../character-chat/perception-gates.md) §The chat intimate gate).
