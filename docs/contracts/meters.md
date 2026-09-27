[← Contracts index](README.md)

# Meters

**Meters** are continuous numbers (0–1) that drift over time — hygiene, energy, arousal, and so on. They and the mood module below are pure registries the character-chat lane and the successor engine both read.

## Meters

A meter is continuous 0–1 state that drifts with elapsed story time, defined as data in `meters/registry.ts`:

```ts
type MeterDefinition = {
  id: string;
  label: string;
  description: string;
  initial: number;
  perHour: number;                  // signed linear drift per story hour
  baseline?: number;
  recoveryPerHour?: number;
  law?: { kind: "linear" } | { kind: "proportional"; halfLifeHours: number };
  read?: { kind: "stored" } | { kind: "circadian_balance" };
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
| `perHour`               | Signed linear drift per story hour; its sign names the default pole. A `proportional` meter leaves it 0.                                                                                                                                                                                                                 |
| `baseline`              | The resting target. *Absent* ⇒ today's pole: `perHour < 0` ⇒ 0, else 1.                                                                                                                                                                                                                                                  |
| `recoveryPerHour`       | Linear rate of movement toward `baseline` per story hour. *Absent* ⇒ `\|perHour\|`.                                                                                                                                                                                                                                      |
| `law`                   | The drift law. *Absent* ⇒ `linear` (constant rate, stopping at `baseline`); `proportional` halves the distance to `baseline` every `halfLifeHours`.                                                                                                                                                                      |
| `read`                  | What the thresholds are evaluated against. *Absent* ⇒ `stored`; `circadian_balance` reads the stored reserve against sleep pressure (§Reads).                                                                                                                                                                            |
| `thresholds`            | Crossing one surfaces its `promptHint` to the narrator; `pipLabel` is the same band's short UI chip ("tipsy") — the chat status strip derives from it, so a band edit moves narration and UI together. `visibleEffects` is a third, independent consumer — see [§Visible effects in images](#visible-effects-in-images). |

**Drift.** `applyMeterDrift` integrates each meter's law across an elapsed span of story time in one closed-form step of the shared fixed-point kernel (`@/lib/fixed-point` — the one the successor's body substrate integrates with), toward its baseline, never overshooting, clamped to `[0, 1]`. One step is exact to within `METER_DRIFT_STEP_PRECISION` (two 1/10 000 units), so an interval split into n steps agrees with one step to within n of it. The chat lane decides WHEN a span is integrated — per character, from the minute its meters hold at ([../character-chat/state.md](../character-chat/state.md) §Elapsed-time meter drift). A consumer may override or disable individual meters in its config (`meterOverrides`).

**Drift is per-character.** At drift time the consuming lane resolves trait-shifted baseline/recovery via `personalizeMeters` ([relationships.md](relationships.md) §Modulation); the global value is the no-trait default. Absent `baseline` / `recoveryPerHour` ⇒ exactly the old pole-seeking drift.

### Starter meters

Every law and rate is per story hour and matches the successor's body registry (`bodyMeterRegistryV1`), so a meter drifts the same way in both lanes.

| Meter          | Behavior                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| `hygiene`      | Linear 0.015/h toward 0; lived-in after a day without washing, unwashed after about two.               |
| `energy`       | A reserve: proportional decay toward 0, half-life 16·ln2 h; sleep restores it; bands read its balance. |
| `stress`       | Linear 0.03/h toward calm; composure speeds or slows it.                                               |
| `arousal`      | Linear 0.2/h toward a libido-shifted resting point.                                                    |
| `intoxication` | Linear 0.12/h toward sober.                                                                            |
| `mood`         | Valence — 0 low / 0.5 even / 1 bright; linear 0.06/h back to an optimism-shifted keel.                 |

### Reads

Stored meters are where drift and sources act. Every consumer of their band vocabulary — the narrator's state cues and mood phrase, the anti-repetition bands, the chat strip's chips, the emotion chip, image visible effects — reads the values `readChatMeters` (`meters/reads.ts`) returns instead; it is the one derived-read path, and no surface special-cases a meter.

- A meter reads as stored unless its `read` declares otherwise.
- `energy` reads its **circadian balance**: the reserve minus the character's sleep pressure — simulation-core's `deriveCircadianPressure` and `deriveEnergyRead`, never a second formula — a signed read in −1…1 carried onto the band scale as (read + 1) / 2. Zero (0.5) is the character's own bedtime on a normal day; `tired` (below 0.5) is a negative read, `exhausted` (below 0.3) a read under −0.4.
- Pressure is derived at read time, never stored, from the character's typed `sleep` schedule rows (weekday masks honored; the window that last began governs), falling back to 23:00–07:00, on the chat calendar (story second 0 is midnight of the `calendarStart` day). It escalates from the last real sleep on record; with none, it assumes the routine was kept.
- `meterReadPips` gives the strip's chips from read values: each meter's deepest crossed band that names a chip, then mood's valence (`bright` at 0.65, `low` at 0.35).
- A world-routed chat's meters are the successor's, already read by its own engine: they read as stored.

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

| Meter          | Band (bound)                 | `visibleEffects`                                   |
| -------------- | ---------------------------- | -------------------------------------------------- |
| `intoxication` | `drunk` (above 0.7)          | "glassy, unfocused eyes"                           |
| `hygiene`      | `unwashed` (below 0.3)       | "lank, greasy hair", "grimy skin"                  |
| `energy`       | `exhausted` (read below 0.3) | "heavy-lidded eyes", "dark circles under the eyes" |
| `arousal`      | `flushed` (above 0.55)       | "parted lips"                                      |

No `visibleEffects` phrase ever uses "flushed", "blush" or a colour synonym — the owner reports
those render as stage makeup on several models, not a body state — even though the arousal
meter's own narrator `promptHint` keeps "flushed skin": that phrase is narrator prose only and
never reaches `visibleEffects`. The projected fact is `current`-layer, so it is scene-current
state, not the stable chat-look identity anchor: the chat-look pack suppresses
`subject.current_state` the same way it suppresses a wet cut or an active condition
([../images/pipelines/chat-images.md](../images/pipelines/chat-images.md) §The look anchor).

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
