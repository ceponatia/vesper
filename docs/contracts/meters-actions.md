# Meters and registered actions

## Meters

Continuous 0–1 state that drifts with time, defined as data (`meters/registry.ts`):

```ts
type MeterDefinition = {
  id: string;                       // "hygiene", "energy", "arousal", "stress", "intoxication", "mood"
  label: string;
  description: string;
  initial: number;
  perHour: number;                  // signed drift per game hour
  baseline?: number;                // resting target (absent ⇒ today's pole: perHour<0 ⇒ 0, else 1)
  recoveryPerHour?: number;         // rate toward baseline (absent ⇒ |perHour|)
  thresholds: Array<{ below?: number; above?: number; promptHint: string }>;
};
```

The engine applies drift on clock advance (`applyMeterDrift` — moves each value toward its baseline at `recoveryPerHour`, never overshooting, clamped [0,1]) and surfaces crossed-threshold `promptHint`s to the narrator. Worlds may override or disable meters in their style config. Drift is **per-character**: at drift time the merge resolves trait-shifted baseline/recovery via `personalizeMeters` ([relationships.md](relationships.md) §Modulation) — the global value is the no-trait default. Absent `baseline`/`recoveryPerHour` ⇒ exactly the old pole-seeking drift.

Starter meters: `hygiene` (1→0, −0.04/h, thresholds prompt scent/grime hints), `energy` (1→0 waking drain, restored by sleep via simulant), `stress` (0-seeking), `arousal` (0-seeking), `intoxication` (0-seeking, fast decay), and **`mood`** — emotional valence (0 low / 0.5 even / 1 bright; baseline 0.5, returns to an even keel). Mood is surfaced not as raw threshold hints but as a **derived descriptor** (`deriveMoodDescriptor` blends valence × stress/energy → "low and on edge", "bright and playful", …), and it couples with affinity: the social-reaction curve reads mood as its `μ` factor (`moodMeterToFactor`) and a reaction nudges mood back (`moodNudge`). The old app's 7-vector hygiene model becomes `hygiene` + conditions (`sweaty`, `soaked`, `unwashed` with region notes) — same play feel, no bespoke code path. Region-level scent composition is deliberately replaced by: item `sensory` text + hygiene threshold hints + exposure gating ([prompts.md](../prompts.md)).

## Registered actions

Common multi-minute activities pass authored game time instead of an LLM estimate (`actions/registry.ts`):

```ts
type ActionDefinition = {
  id: string;                          // "shower", "bathe", "nap", "meal", "snack", "workout", "groom"
  label: string;
  minutes: number;                     // turn clock advances max(this, travel, estimate)
  aliases: readonly string[];
  meterEffects: Array<{ meterId: string; delta?: number; set?: number }>;  // deterministic; agent deltas still win
  requiredTier?: ProximityTier;        // reserved for proximity gating, unused until that ships
};
```

`matchActions(text)` matches aliases whole-word, case-insensitive, longest-first, at most one match per definition; double-quoted spans are stripped so dialogue never matches ("I said I'd shower later").
