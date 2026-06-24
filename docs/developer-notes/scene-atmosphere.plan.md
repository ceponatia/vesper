# Scene atmosphere — a derived scene-tone signal (plan)

Status: **next** — settled (open questions resolved 2026-06-24; see _Decisions_). Queued to
unblock the mood remainder (and later the avatar). The `AtmosphereLabel` enum + the
`atmosphereMoodBaselineShift` consumer already shipped with the [mood core slice](mood.plan.md)
(2026-06-24); they sit unwired because **nothing in the engine produces a scene tone**. This
plan builds that producer.

Design detail: [scene-atmosphere.spec.md](scene-atmosphere.spec.md) — the source
precedence, persistence shape, and the director field.

Topic slug `scene-atmosphere`. Drafted 2026-06-24 at the user's request ("flesh out the
atmosphere sources first so we can tackle the roadmap in order").

## Why now

Mood's v1 vocabulary (decision 2026-06-24) included **scene atmosphere** as an input, but
it couldn't ship: `atmosphereMoodBaselineShift(atmosphere, traits)` is built and tested,
yet there's no `atmosphere` value to feed it. Building the source:

1. **Unblocks the mood remainder in roadmap order** — wires the last v1 mood input
   (a tense room drags a present character's mood down, trait-damped; a romantic one lifts
   it), without compounding (it shifts the mood *baseline*, not a per-turn delta).
2. **Serves the avatar later** — the `AvatarCue.environment.atmosphere` channel
   ([avatar-3d.spec.md](avatar-3d.spec.md) §1/§3: "location ambient + director scene tone →
   `AtmosphereLabel`") reads the same signal. One producer, two consumers.

## What already exists (do not rebuild)

| Piece | State | Source |
| --- | --- | --- |
| **`AtmosphereLabel`** | enum `calm`/`warm`/`romantic`/`tense`/`ominous`/`melancholy`/`hopeful` + `.catch("calm")` schema | `src/contracts/mood/atmosphere.ts` |
| **`atmosphereMoodBaselineShift`** | pure: tone → resting-mood shift, composure-damped | `src/contracts/mood/events.ts` |
| **Director leg** | post-turn scene reasoner; already emits `sceneSummary`, `exposure`, `imageMoment` → assembled into the next brief | `contracts/turns/agent-results.ts` (`directorResultSchema`), `merge.ts:1385` |
| **Brief flow** | `exposure: input.director.exposure` → persisted `NextTurnBrief` → read next turn | `merge.ts:1390`, `contracts/state/brief.ts` |
| **Intimate frame** | `exposure.touch/appearance === "intimate"` (mood already reads it for `aroused`) | `status-payload.ts`, `brief.ts` |

## The design in one line

The **director emits an `atmosphere`** each turn (one enum field — no new agent leg, no new
token call); the merge assembles it onto the **next-turn brief** (mirroring `exposure`),
**sticky** so a quiet turn doesn't reset the tone; a cheap **deterministic floor** catches
the intimate frame; consumers read `brief.atmosphere`.

## Sources & precedence (detail in spec §2)

1. **Director-emitted** (primary, dynamic) — a new `atmosphere: AtmosphereLabel` on
   `directorResultSchema`, `parseOr`'d. The director already classifies the scene (summary,
   exposure, image-worthiness); tone is a natural one-field addition.
2. **Deterministic floor** (no-LLM) — an intimate frame forces at least `romantic` unless the
   director named something darker (a tense intimate scene stays tense). Cheap, catches the
   romance case even if the director is terse.
3. **Carry-forward (hysteresis)** — if the director doesn't speak a tone, the prior brief's
   atmosphere persists (scene tone is sticky; it shouldn't flicker to `calm` every quiet beat).
   Scene start / no prior ⇒ `calm`.

## Consumers

- **Mood** (this plan wires it) — `atmosphereMoodBaselineShift` added to the mood drift
  baseline, **gated to participants co-located with the player** (the brief describes the
  player's scene; off-scene NPCs get their own tone later, see Scope).
- **Avatar** (later) — `environment.atmosphere` cue channel reads `brief.atmosphere` directly.
- **Status payload / debug** (optional) — surface the current atmosphere for the dev panel /
  a future scene chip.

## Scope boundaries (v1)

- **One atmosphere per active scene** (the player's location), carried on the brief. Per-NPC /
  per-off-scene-location atmosphere is deferred (ties to world-simulation).
- **No authored location tone** in v1 — locations have free-text `ambient` + `tags` but no
  tone field. Deriving a baseline from tags, or adding an authored `atmosphere`, is a
  deferred enhancement (the director + deterministic floor cover v1).
- **Token-light** — exactly one enum field on an existing leg; no narration re-read, no new agent.
- Atmosphere is an **input** to mood, never an override (a composed companion holds calm in a
  tense room — the shift is composure-damped). It is **not** the character's emotion.

## Build order

1. **Contract** — add `atmosphere: AtmosphereLabel` to `directorResultSchema` (default `calm`,
   `.catch`) and to `NextTurnBrief` (`brief.atmosphere`, defaulted so old briefs parse).
2. **Director prompt** — one line asking for the scene's emotional tone from the enum.
3. **Merge assembly** — `atmosphere: resolveAtmosphere(director, prior, exposure)` in the
   brief builder (director → floor → carry-forward). A pure helper + tests.
4. **Wire mood** — add `atmosphereMoodBaselineShift(brief.atmosphere, traits)` to the drift
   mood-baseline shift (alongside the condition shift), gated to co-located participants.
   Degradation test (absent/odd atmosphere ⇒ no shift + diagnostic).
5. **Surface (optional)** — atmosphere on the status payload for the dev/Inspector panel.
6. **Docs** — `turn-engine.md` (director field), `prompts.md` (the director line),
   `contracts/state.md` (brief field), `contracts/meters-actions.md` (atmosphere now wired);
   mark mood's atmosphere row shipped.

## Decisions (resolved 2026-06-24)

- **Producer = director-emitted + intimate floor.** One `atmosphere` enum field on the
  existing director leg (no new leg, no narration re-read); plus a deterministic floor —
  an intimate frame forces ≥`romantic` unless the director named something darker. (Detail:
  spec §2/§3.)
- **Sticky (carry-forward).** Atmosphere holds until the director changes it (hysteresis);
  a quiet turn keeps the prior tone. Scene start ⇒ `calm`. (Spec §2 layer 3.)
- **Persistence = `NextTurnBrief.atmosphere`** — mirrors `exposure`, rebuilt each merge from
  director output; carry-forward keeps it sticky. (Spec §4.)
- **Mood shift gated to co-located NPCs** — the brief describes the player's scene, so the
  atmosphere shift applies only to participants in the player's location. (Spec §5.)
- **Authored location tone deferred** — the director + intimate floor cover v1; an optional
  `location.atmosphere` baseline is a later enhancement.
- **Deterministic danger→`tense` floor deferred** — no threat/combat signal exists yet; the
  director carries danger tone for now.

## Related

- [mood.plan.md](mood.plan.md) / [mood.spec.md](mood.spec.md) §5 — the consumer
  (`atmosphereMoodBaselineShift`) + the `AtmosphereLabel` enum this feeds.
- [avatar-3d.spec.md](avatar-3d.spec.md) §1/§3 — the `environment.atmosphere` cue channel,
  the second consumer.
- `docs/story-threads.md`, `docs/turn-engine.md` — the director leg this extends.
