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

Every law and rate is per story hour and matches the successor's body registry
(`bodyMeterRegistryV1`), so a meter drifts the same way in both lanes —
**`hygiene` alone excepted**: its rate deliberately diverges (owner ruling
2026-09-27, real-life timing; see below), and `@vesper/simulation-core`'s own
hygiene rate is untouched.

| Meter          | Behavior                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `hygiene`      | Linear ≈0.009/h toward 0 — washed to 0.95, noticeable odor at ≈10 h, unwashed at 72 h (see below).       |
| `energy`       | A reserve: proportional decay toward 0, half-life 16·ln2 h; sleep restores it; bands read its balance.   |
| `stress`       | Linear 0.03/h toward calm; composure speeds or slows it.                                                 |
| `arousal`      | Linear 0.2/h toward a libido-shifted resting point; held still while `heated` stands (see below).        |
| `intoxication` | Linear 0.12/h toward sober.                                                                               |
| `mood`         | Valence — 0 low / 0.5 even / 1 bright; linear 0.06/h back to an optimism-shifted keel.                    |

**Hygiene's own derivation** (owner ruling 2026-09-27, #303 review — real-life
timing, not the successor's pace): washed to 0.95 (`rhythmSelfCareEffects`'s
wash, and the "freshen" action chip), a noticeable-but-mild odor at ≈10 story
hours (not filthy yet — the shallower band, `below: 0.86`), and the
unwashed/filthy band (`below: 0.3`, unchanged, still the one `visibleEffects`
band) only after 72 story hours (3 days). One linear rate anchored to both
ends: `(0.95 − 0.3) / 72 ≈ 0.00903`/hour (named constants in
`meters/registry.ts`). A character on the default daily wash (once per sleep
cycle) reads mildly lived-in by evening and never approaches unwashed.

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
those render as stage makeup on several models, not a body state. The arousal meter's threshold
still carries three independent things: `pipLabel` ("flushed") still names the band for the UI
strip's pip chip (`chat-status.tsx`); `visibleEffects` ("parted lips") still feeds this image
projection; its own `promptHint` ("Visibly affected: flushed skin…") now renders NOWHERE — the
1-on-1 lane's narration reads the graded read below instead, and nothing else consumes
`promptHint` for this meter. See
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
chat-only number). None of its own narration prose uses "flush"/"blush" or a colour synonym,
even though the shared read's internal band id happens to be spelled "flushed".

**Rendered only inside an intimate scene** (owner ruling 2026-09-27): every phase, not just the
shallow ones, renders in the "Current state" section ONLY while `heated` or `afterglow` stands —
never from ordinary affection/attraction reading on the meter alone. Attraction is not arousal;
a broader trigger/curve rethink (when arousal itself should rise) is a separate, not-yet-built
follow-up issue, so today the meter can sit elevated from an ordinary romantic exchange with no
narration line at all until an actual intimate scene starts.

**Not yet perception-gated.** The read takes a `detailTier` parameter matching the shared read's
own axis (0 = nothing perceived, 2 = plain sight, 3 = engaged attention) so a future caller CAN
gate it, but the chat lane does not vary it today: `state-sections.ts` always passes 3 (full
engaged-attention perception) for the co-present primary. A witness who could not actually
perceive this (darkness, distance, not co-present) still reads the full phase text — a real
perception gate is a linked follow-up issue, not built here.

**Never for an authored minor** (P1, #301 review — a safety fix, not a follow-up): the narration
section takes the same `minor` flag every other intimate-capable prompt block already fences on
(disposition, intimate notes, disinhibition) and renders no arousal line at all when it is true,
whatever the meter or the standing conditions say. The pulse-side fence
(`applyChatPulse`'s `minor` option) is the primary guard — a minor's arousal never moves from any
concept and `intimateScene` is never consumed for them — so this is the narration's own
belt-and-suspenders check on top of it, not the only one.

**The one scene-level intimate-activity read.** The reaction pulse (`chat-pulse.ts`) reports
ONE optional field, `intimateScene: "active" | "completed" | null`, resolved once and shared
with the [hygiene cost](#hygiene-cost-of-an-intimate-scene) below — never a second detector or
model call off the same exchange. `applyChatPulse` never even inspects the field for an
authored minor (P1, #301 review, the `minor` option) — no arousal move, no heated/afterglow
condition, no hygiene cost, whatever the pulse read:

- **`"active"`** — an intimate/sexual act is ongoing this exchange. The ordinary
  concept-driven arousal bump (an intimate act raises arousal, courtship/physical affection
  half as much) still applies, and a self-expiring `heated` condition renews
  (`CHAT_HEATED_CONDITION_MINUTES`): while it stands, `integrateChatMeters`'s
  `suspendsMeterDrift` hook holds arousal's ambient drift still (so a scene spanning several
  exchanges — or one degraded pulse in the middle of it — doesn't read as visibly cooling
  between beats), and its sibling `heatedHygieneDriftMultiplier` hook accelerates hygiene's
  own drift instead (see [the hygiene cost](#hygiene-cost-of-an-intimate-scene) below).
- **`"completed"`** — the exchange resolves the scene to climax. Arousal SETTLES to at most
  `CHAT_AROUSAL_AFTERGLOW_SETTLE` (comfortably below the flushed floor, even for a
  high-libido profile cresting a moment before) — this REPLACES, never adds to, that same
  exchange's ordinary concept bump. Mood lifts and stress eases
  (`CHAT_AFTERGLOW_MOOD_LIFT` / `CHAT_AFTERGLOW_STRESS_EASE`), a small one-time hygiene cost
  lands, and the standing `heated` condition gives way to `afterglow`.
- **`null`** (most turns, and every missing/malformed read — the schema `.catch()`s it like
  every other pulse field) — neither branch runs. Ambient clock drift remains the backstop
  for a completion the pulse never classified: arousal keeps decaying toward baseline on its
  own once nothing is renewing `heated`. A genuinely ABSENT `intimateScene` degrades silently,
  same as any other pulse field; a PRESENT value that fails its leaf schema instead pushes
  `chat_state.pulse.intimate_scene_unreadable` through the sink (`pulse-agent.ts`'s
  `reportIntimateSceneIfUnreadable`) — distinguishable from silence, and from the whole-pulse
  `chat_state.pulse.degraded` — while still resolving to `null` and applying no new effect.

Neither `heated` nor `afterglow` ever reaches an image prompt as a bare condition word (P2,
#301 review — the #427 failure class): `contracts/visual-state/conditions.ts`'s
`projectActiveConditionFeatures` names them in a `CONDITIONS_EXCLUDED_FROM_IMAGES` set and
drops them before projection, since arousal's own image path (this doc's `visibleEffects` row)
already covers it. Both conditions are otherwise ordinary — `imageEligible` on their kind stays
true for every other condition, and no image effect changed.

#### Hygiene cost of an intimate scene

Real-life timing (owner ruling 2026-09-27, #303 review), replacing the original per-message
charges: while `heated` stands, hygiene simply drifts at `CHAT_HYGIENE_HEATED_DRIFT_MULTIPLIER`
times its own base rate — through the SAME `integrateChatMeters` condition seam
`suspendsMeterDrift` uses (`time.ts`'s `heatedHygieneDriftMultiplier`), so a scene of ordinary
length costs only a little more than the ambient drift it would have cost anyway. Completion
additionally charges a small, standalone one-time `CHAT_HYGIENE_COMPLETION_COST` directly in
`applyChatPulse` (a completion is a bigger, discrete event the smooth per-minute rate alone
underscores) — deliberately **not** stacked with an "active" charge, because "active" no longer
carries one of its own. One ordinary scene (a handful of exchanges plus its completion) moves
hygiene nowhere near a full band — comfortably under the odor band's own width (≈0.09, the
shallowest). A missing/degraded read leaves hygiene at its ordinary base drift, exactly as any
other elapsed-time meter. The one-time cost rides the same `ChatState.meters` object every
other pulse effect does, so it shares the same persistence and "another take" retake boundary
automatically.

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
