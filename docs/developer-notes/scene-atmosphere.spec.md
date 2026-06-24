# Scene atmosphere — design truth (spec)

Status: **draft** — the design detail behind [scene-atmosphere.plan.md](scene-atmosphere.plan.md).
Owns the **producer** of `AtmosphereLabel` (the enum itself is owned by
[mood.spec.md](mood.spec.md) §2 / `contracts/mood/atmosphere.ts`). Read the plan first
for scope/why. Structure settled (decisions 2026-06-24): director-emitted + intimate floor,
sticky carry-forward on the brief.

Slug `scene-atmosphere`. Constants/thresholds here are *starting values* tuned in playtest.

## 1. The signal

Atmosphere is the **emotional tone of the player's current scene** — `calm` / `warm` /
`romantic` / `tense` / `ominous` / `melancholy` / `hopeful`. It is a property of the *room
and moment*, **not** of any character: a composed companion holds calm in a tense scene
(mood reads it as a composure-damped *input*, never an override — [mood.spec.md](mood.spec.md)
§5). One value per active scene, carried on the brief and refreshed each turn.

## 2. Source precedence (`resolveAtmosphere`)

A pure helper resolves the next brief's atmosphere from three layers, highest wins:

```ts
function resolveAtmosphere(input: {
  director?: AtmosphereLabel;     // the director's classification this turn (parseOr'd)
  prior: AtmosphereLabel;         // last brief's atmosphere (sticky carry-forward)
  exposure: ExposureMask;         // for the intimate floor
}): AtmosphereLabel;
```

1. **Director-emitted** (primary). The director leg classifies the scene tone into the enum
   each turn. Present ⇒ it wins (the live read). The director is already a high-level scene
   reasoner (`sceneSummary`, `exposure`, `imageMoment`), so tone is a natural one-field add —
   **no new agent leg, no narration re-read**, one enum of output.
2. **Deterministic intimate floor** (no-LLM). When `exposure.touch === "intimate"` or
   `exposure.appearance === "intimate"` and the resolved tone is a *neutral/positive* one
   (`calm`/`warm`/`hopeful`), force `romantic`. A director-named **darker** tone
   (`tense`/`ominous`/`melancholy`) is **kept** — an intimate scene can still be fraught.
3. **Carry-forward** (hysteresis). No director tone this turn ⇒ keep `prior`. Scene start /
   no prior ⇒ `calm`. Scene tone is sticky; it must not flicker to `calm` on a quiet beat.

`resolveAtmosphere` is **total** and pure (`src/contracts/mood/` or a small engine helper —
see §5); unit-tested over each precedence path.

## 3. Producer — the director field

Add to `directorResultSchema` (`contracts/turns/agent-results.ts`):

```ts
  /** The scene's emotional tone (scene-atmosphere.spec §1) — the room, not any character. */
  atmosphere: atmosphereLabelSchema.optional(),   // absent ⇒ carry the prior tone
```

`atmosphereLabelSchema` already `.catch("calm")`s an unknown string, so a hallucinated tone
degrades, not rejects. The director prompt gains one line (see `docs/prompts.md` on build):
_"Name the scene's emotional tone (calm/warm/romantic/tense/ominous/melancholy/hopeful) — the
room's mood, not any one character's."_ Optional output, so a terse director simply carries
the prior tone.

## 4. Persistence — the brief

Mirror `exposure`. Add to `nextTurnBriefSchema` (`contracts/state/brief.ts`):

```ts
  atmosphere: atmosphereLabelSchema.default("calm"),   // defaulted ⇒ old briefs parse unchanged
```

In the merge brief builder (`merge.ts` ~1390, beside `exposure: input.director.exposure`):

```ts
  atmosphere: resolveAtmosphere({
    director: input.director.atmosphere,
    prior: input.prior.atmosphere,
    exposure: input.director.exposure,
  }),
```

The director runs post-turn (turn N) and writes the brief read at turn N+1 — a one-turn lag,
fine for a slowly-drifting scene property. The brief is the player's active scene, so
`brief.atmosphere` is the player-scene tone.

## 5. Consumer wiring — mood drift

The mood baseline shift (`atmosphereMoodBaselineShift`, already built) joins the condition
shift in the drift loop (`merge.ts`, where `conditionMoodBaselineShift` is applied):

```ts
const moodBaselineShift =
  conditionMoodBaselineShift(participant.state.conditions) +
  (coLocatedWithPlayer(participant) ? atmosphereMoodBaselineShift(bundle.brief.atmosphere, participant.snapshot.traits) : 0);
```

- **Co-location gate**: the atmosphere shift applies only to participants in the player's
  location — the brief describes *that* scene. Off-scene NPCs keep their own (flat) baseline
  until per-location atmosphere lands (deferred, world-simulation).
- **Standing, not impulse**: it shifts the mood *resting target*, so drift pulls toward it
  without compounding (mood.spec §5). A tense scene settles a present, low-composure NPC a
  little lower each turn toward the shifted floor; it recovers when the tone lifts.
- Clamp the summed baseline as today (`0..1`).

## 6. Resilience

`parseOr` the director's atmosphere at the agent boundary (already `.catch("calm")`); an
absent field carries the prior tone; an unknown enum degrades to `calm`; a missing
`brief.atmosphere` (old brief) defaults to `calm` ⇒ a zero mood shift. No path fails the turn
(`docs/resilience.md`). Emit a `merge.atmosphere.degraded` diagnostic on a non-parsing tone.

## 7. Surfacing (optional, v1-stretch)

Carry `atmosphere` onto the status payload (`SessionStatusPayload`) for the dev/Inspector
panel and a possible scene-tone chip. Read-only; no new state.

## Related

- [scene-atmosphere.plan.md](scene-atmosphere.plan.md) — scope, sources, build order, open
  questions.
- [mood.spec.md](mood.spec.md) §2/§5 — `AtmosphereLabel` (owned there) +
  `atmosphereMoodBaselineShift` (the consumer).
- [avatar-3d.spec.md](avatar-3d.spec.md) §1/§3 — the `environment.atmosphere` cue channel.
- `contracts/turns/agent-results.ts` (`directorResultSchema`), `contracts/state/brief.ts`
  (`NextTurnBrief`), `merge.ts` (brief assembly + drift).
