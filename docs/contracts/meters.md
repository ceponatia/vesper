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
  thresholds: Array<{ below?: number; above?: number; promptHint: string; pipLabel?: string }>;
};
```

| Field                   | Meaning                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                    | e.g. `hygiene`, `energy`, `arousal`, `stress`, `intoxication`, `mood`.                                                                                                                                 |
| `label` / `description` | Display text.                                                                                                                                                                                          |
| `initial`               | Starting value.                                                                                                                                                                                        |
| `perHour`               | Signed drift per game hour.                                                                                                                                                                            |
| `baseline`              | The resting target. *Absent* ⇒ today's pole: `perHour < 0` ⇒ 0, else 1.                                                                                                                                |
| `recoveryPerHour`       | Rate of movement toward `baseline`. *Absent* ⇒ `\|perHour\|`.                                                                                                                                          |
| `thresholds`            | Crossing one surfaces its `promptHint` to the narrator; `pipLabel` is the same band's short UI chip ("tipsy") — the chat status strip derives from it, so a band edit moves narration and UI together. |

**Drift.** On every clock advance, `applyMeterDrift` moves each value toward its baseline at `recoveryPerHour` — never overshooting, clamped to `[0, 1]` — and surfaces any crossed-threshold `promptHint`s to the narrator. A consumer may override or disable individual meters in its config (`meterOverrides`).

**Drift is per-character.** At drift time the consuming lane resolves trait-shifted baseline/recovery via `personalizeMeters` ([relationships.md](relationships.md) §Modulation); the global value is the no-trait default. Absent `baseline` / `recoveryPerHour` ⇒ exactly the old pole-seeking drift.

### Starter meters

| Meter          | Behavior                                                                                |
| -------------- | --------------------------------------------------------------------------------------- |
| `hygiene`      | 1 → 0 at −0.04/h; thresholds prompt scent/grime hints.                                  |
| `energy`       | 1 → 0 waking drain; restored by sleep.                                                  |
| `stress`       | 0-seeking.                                                                              |
| `arousal`      | 0-seeking.                                                                              |
| `intoxication` | 0-seeking, fast decay.                                                                  |
| `mood`         | Emotional valence — 0 low / 0.5 even / 1 bright; baseline 0.5, returns to an even keel. |

### Mood

Mood is surfaced not as raw threshold hints but as a **derived descriptor**: `deriveMoodDescriptor` blends valence × stress/energy into phrases like "low and on edge" or "bright and playful". It also couples with affinity:

- the social-reaction curve reads mood as its `μ` factor (`moodMeterToFactor`), and
- a reaction nudges mood back (`moodNudge`).

#### The mood module — labeled emotion + event→mood (`src/contracts/mood/`)

A second, discrete read sits beside the prose descriptor (see `docs/developer-notes/mood.spec.md`):

- **`EmotionLabel`** — the locked app-wide 11-label vocabulary (`neutral`/`happy`/`affectionate`/`playful`/`flustered`/`concerned`/`sad`/`angry`/`afraid`/`surprised`/`aroused`; `aroused` is gated on an *intimate frame*, not undress). Owned here; the avatar cue + UI mood chip import it.
- **`deriveEmotionLabel`** — a pure, **total** projection: a *transient beat* (the latest `EvaluatedReaction`) wins briefly, else a *baseline* from a derived `activation` axis (energy/stress/arousal) × valence + affinity stage + conditions. Surfaced via the shared `MoodChip` on the **character-chat strip** (`chatStateSnapshot` → `ChatStateSnapshot.emotion`, with the character's dominance + intimate-capable context).
- **Event→mood table** — generalizes the lone reaction nudge, as pure contract helpers the consuming lane wires into its drift/reaction step. **Impulse** events apply one-time deltas: the social reaction (above) and **welcome/unwelcome touch** (`resolveTouchWelcomeness` + `touchMoodDeltas`, affinity-stage gated with a preference override — a touch with no preference swings mood/stress by warmth). **Standing** influences shift the mood *baseline* (no per-turn compounding): `atmosphereMoodBaselineShift`. Conditions reach mood through the discrete projection instead — `deriveEmotionLabel` tints its baseline from condition labels — not through a meter-baseline shift.

> The old app's 7-vector hygiene model becomes `hygiene` + conditions (`sweaty`, `soaked`, `unwashed`, with region notes) — same play feel, no bespoke code path. Region-level scent composition is deliberately replaced by: item `sensory` text + hygiene threshold hints + exposure gating ([../character-chat/prompts.md](../character-chat/prompts.md) §The chat intimate gate).
