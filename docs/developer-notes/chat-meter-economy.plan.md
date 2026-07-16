# Chat meter economy — visible decay, arousal resolution, skips with consequences

Status: **next** (planned 2026-07-15 — owner request after the chat-clock-calendar time
change: "hygiene never seems to decay, and arousal needs to reset after intercourse
completes")

## Goal

Since the clock change ([chat-clock-calendar.plan.md](chat-clock-calendar.plan.md):
`CHAT_TICK_MINUTES` 4 → 1, skips promoted to the primary time mover), the chat lane's
meter economy is visibly mis-paced in three ways:

1. **Hygiene never decays.** Within-visit drift is negligible and skips don't touch
   meters at all, so the meter is effectively frozen at its seed value forever.
2. **Arousal never resolves.** Accumulation is fast (+0.18 per intimate act) but the
   only sink is slow ambient drift — after an intimate scene completes the character
   stays "flushed" for the next ~50+ exchanges. There is no climax/completion event.
3. **Skips carry no meter consequences** (D14 flavor-only ruling), which was tolerable
   when exchanges moved the clock 4 minutes each; now that skips are the main way story
   time passes, "overnight" leaving arousal at 1.0 and energy unmoved reads as a bug.

Deliverable: a **retuned, testable rate scheme** — every pacing number in one tunable
table so a rate experiment is a one-line constant edit — plus the arousal-resolution
event and a scoped revision of D14.

## The current economy (measured 2026-07-15)

Drift applies `CHAT_METER_DRIFT_MINUTES = 4` story-minutes of each meter's `perHour`
rate per exchange (`driftChatState` → `applyMeterDrift`, personalized by
`personalizeMeters`). Per-exchange deltas and time-to-first-band from seed:

| Meter | perHour | Δ/exchange | First band | Exchanges to reach it |
| --- | --- | --- | --- | --- |
| hygiene (seed 0.9) | −0.04 | −0.0027 | lived-in < 0.55 | **~131** |
| energy (seed 0.9) | −0.05 | −0.0033 | tired < 0.45 | ~135 |
| stress (seed 0.15 → 0) | −0.03 | −0.002 | — (decays) | — |
| arousal (→ baseline) | −0.10 | −0.0067 | flushed > 0.55 (cooling FROM 1.0 back below it) | **~67 to cool** |
| intoxication (→ 0) | −0.12 | −0.008 | one drink chip (+0.3) clears in | ~37 |
| mood (→ 0.5) | 0.06 recovery | 0.004 | — | — |

Sources (accumulation) today:

- **Pulse** (`applyChatPulse`): arousal +0.18 per intimate concept (+0.09 courtship /
  physical affection) unless disliked; mood/stress via the reaction curve.
- **Action chips** (`applyChatAction`): drink +0.3 intoxication; freshen → hygiene
  = 0.95, +0.05 energy; rest +0.2 energy / −0.2 stress; fluster +0.25 arousal +
  the 90-min `flushed` condition.
- **Skips**: nothing (D14). **Nothing lowers hygiene** except the invisible drift, and
  nothing raises energy except the chips.

So the failure modes are structural, not just mistuned: hygiene has no visible sink and
no dirtying sources; arousal has a strong source and no resolution sink; skips move the
clock without moving the body.

## Constraints

- **`meterDefinitions` is shared with the session lane.** The session merge
  (`merge/phases/meters.ts`) applies `perHour` over REAL elapsed turn minutes (1–480),
  where −0.04/h hygiene is correctly paced. Do **not** fix chat by inflating `perHour`
  — chat-lane pacing must live on the chat side.
- Personalization stays: rates/baselines resolve through `personalizeMeters` (libido
  shifts the arousal resting point up to +0.2 and halves its recovery at +100;
  composure speeds stress recovery). The reset event must target the **personalized**
  baseline, not 0.
- Resilience rules: the new pulse read degrades to `null` (`.catch`) — a missed
  detection costs one resolution beat, never a turn; ambient drift stays the backstop.
- Rollback safety: meters + conditions already ride `storedChatStateSchema`, so all of
  this is "another take"-safe with **no migration**.

## Design

### 1. Per-meter drift pacing — the tunable table

Replace the single `CHAT_METER_DRIFT_MINUTES` with a per-meter map in
`engine/constants.ts` (fallback 4 for unlisted meters, so world-override/custom meters
keep today's pacing):

```ts
/** Story-minutes of drift applied per exchange, PER METER (chat-meter-economy.plan.md).
 *  These are the chat lane's pacing knobs — perHour stays session-owned. */
export const CHAT_METER_DRIFT_MINUTES: Record<string, number> = {
  hygiene: 15, // −0.01/exchange → lived-in in ~35 exchanges of active play
  arousal: 8,  // −0.013/exchange → a heated-then-interrupted scene cools in ~25
};
export const CHAT_METER_DRIFT_DEFAULT_MINUTES = 4; // energy/stress/intoxication/mood unchanged
```

`driftChatState` applies each meter's own minutes (a small loop over
`applyMeterDrift`-per-definition, or extend `applyMeterDrift` to take a per-id minutes
map — implementer's choice, keep it pure). **These first-test values are hypotheses**;
the point of the table is that the next experiment is a one-line edit.

Targets the test values encode (adjust here, not in prose, when retuning):

- hygiene: first band inside one long session (~35 exchanges), second band only after
  neglecting it across ~60 more — freshen/shower beats become worth taking.
- arousal: ambient cooling from a fully heated state in ~25 exchanges — the backstop
  when the resolution event (slice 2) misses; slow enough that a flirty mood lingers.

### 2. Arousal resolution — the intimacy read + reset

The concept vocabulary has `proposition` (initiation) but nothing for the act or its
completion, and the pulse only classifies the **player's** act — completion usually
lands in the narrator's reply. Add a scene-level read instead of new concepts:

- **Pulse schema** (`contracts/turns/chat-pulse.ts`): new field
  `intimacy: z.enum(["active", "climax"]).nullable().catch(null).default(null)` —
  "is this exchange inside an active intimate scene, and did it reach/complete a
  climax?" Prompt guidance in `prompts/` beside the existing pulse fields; the pulse
  already sees both sides of the exchange.
- **On `climax`** (`applyChatPulse`):
  - `arousal = min(current, personalizedBaseline + CHAT_AROUSAL_AFTERGLOW_RESIDUE)`
    with `CHAT_AROUSAL_AFTERGLOW_RESIDUE = 0.15` — sated, not switched off, and always
    below the 0.55 "flushed" band;
  - upsert a self-expiring **`afterglow`** condition (90 min via
    `CHAT_ACTION_CONDITION_MINUTES`, hint like "sated and loose-limbed, warm,
    unhurried") — inline like the fluster chip's `flushed` condition, no catalog work;
  - stress −0.15, mood +0.10 (composing with the exchange's curve deltas), hygiene
    −0.05 (slice 4's rationale);
  - the intimate-act arousal bump is **skipped** on a climax exchange (reset wins).
- **On `active`**: suppress ambient arousal drift for this exchange (the scene sustains
  itself; drift resuming the moment `intimacy` returns to null is the natural cooldown)
  and hygiene −0.02 (sweat — slice 4).
- Trace: extend `ChatPulseTrace.changed` values + an `intimacy` field so the state
  debug tools and inspector show the read.
- Degradation: `null` (missed/degraded pulse) = today's behavior exactly; the slice-1
  faster arousal drift is the backstop, so a missed climax cools in ~25 exchanges
  instead of sticking for 50+.

### 3. Skips get bounded meter effects (D14, revisited and scoped)

D14's rationale ("whether 12 skipped hours mean recovery or deterioration is
circumstance") ruled out a flat rule when exchanges were the time mover. Post-calendar,
skips ARE time; keeping them meter-inert decouples body state from story time
completely. Revision — flat rules **only where circumstance doesn't plausibly flip the
sign**, in `applyTimeSkip`:

- **Cooling meters always cool.** Run baseline-seeking drift (`applyMeterDrift`, real
  skipped minutes, personalized defs) for **arousal, intoxication, stress, mood**.
  There is no circumstance where nine skipped hours preserve arousal or drunkenness;
  `driftToward` never overshoots the baseline, so no caps needed. (An `overnight` skip
  = 540 min fully clears all four at current rates.)
- **Self-care on big skips.** For `overnight` and `days` only: `hygiene =
  max(current, 0.9)`, `energy = max(current, 0.9)` — assume the character slept and
  washed, the same "the cast keeps living" default the meanwhile pass and rhythm
  auto-dress already apply at skip boundaries. `moments`/`hours` skips leave hygiene
  and energy on plain drift (hygiene DOWN over a 3-hour skip is correct).
- The pure fall-through keeps D14's virtues: no LLM call, no new wiring — the skip
  route already calls `applyTimeSkip` per member, and away members already share it.
- Update the D14 comment blocks (`applyTimeSkipToScenario`, `contracts/turns/chat-skip.ts`)
  to point here; the fully circumstance-aware time-effects system stays deferred.

### 4. Hygiene accumulation (small, rides slice 2)

Give hygiene sources so the sink means something: −0.02 per `intimacy: "active"`
exchange, −0.05 on `climax` (both in the slice-2 fold, constants beside the residue).
Nothing else — no new detection surface; workout/exertion dirtying waits for evidence
it's missed.

## Verification

- **Unit** (`chat-state.test.ts`, `registry.test.ts`): band-crossing exchange counts
  pinned to the table ("hygiene from 0.9 crosses lived-in within 32–38 exchanges",
  "arousal 1.0 cools below flushed within 22–28"); climax reset lands at personalized
  baseline + residue and below 0.55 for a high-libido profile; `active` suppresses
  arousal drift; skip policy per amount (hours cools intoxication, overnight restores
  hygiene/energy, moments does neither); degradation test: null `intimacy` ⇒ byte-equal
  to today's fold **and** the mandated diagnostic on a degraded pulse.
- **Playtest on Fly** (deploy first — the UI-testing surface): one long flirt →
  intercourse → aftermath conversation checking the strip pips: flushed appears during,
  clears on the completion exchange, afterglow chip shows, hygiene pip dips after
  ~35 exchanges, freshen chip restores it; then `overnight` skip → arousal/intoxication
  cleared, hygiene/energy back to ~0.9.
- Full gate (lint → lint:cycles → typecheck → test → jscpd, one at a time) before
  claiming done.

## Open questions

- **OQ1 — energy within-visit pacing.** Unchanged here (a conversation shouldn't
  exhaust anyone), but late-night play never showing "tired" may feel wrong once the
  clock is visible. Revisit with the same table once slice 1's values are validated.
- **OQ2 — an `intercourse` interaction concept.** The intimacy read makes it
  unnecessary for meters, but preference/social-card matching can only target
  `proposition` today (a character can't like/dislike the act itself, only the ask).
  Registry data edit if wanted — decide when a card needs it.
- **OQ3 — circumstance overrides for skip self-care.** A "trapped/rough night" scene
  makes the overnight reset wrong. A condition-gated override (an active condition
  suppressing self-care) is the natural shape; deferred until a real scene hits it.

## Files touched

`src/server/engine/constants.ts` (pacing table + residue), `src/server/engine/chat-state.ts`
(`driftChatState`, `applyChatPulse`, `applyTimeSkip`), `src/contracts/turns/chat-pulse.ts`
(+ its prompt module and `ChatPulseTrace`), `src/contracts/turns/chat-skip.ts` (comment),
tests beside each, docs: `docs/character-chat/state.md` (time-model + tracked-state
paragraphs), `docs/contracts/meters-actions.md` (chat pacing note).
