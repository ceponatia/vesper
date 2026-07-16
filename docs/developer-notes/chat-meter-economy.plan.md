# Chat meter economy — the body on the story clock

Status: **next** (planned 2026-07-15 after the chat-clock-calendar time change: "hygiene
never seems to decay, and arousal needs to reset after intercourse completes"; re-scoped
2026-07-16 on the owner's OQ1–OQ3 rulings and the world-model deprecation license —
rulings and rationale in [chat-meter-economy.spec.md](chat-meter-economy.spec.md))

## Goal

Since the clock change ([chat-clock-calendar.plan.md](chat-clock-calendar.plan.md):
`CHAT_TICK_MINUTES` 4 → 1, skips promoted to the primary time mover), the chat lane's meter
economy is visibly broken in three ways: **hygiene never decays**, **arousal never
resolves** after an intimate scene completes, and **skips carry no meter consequences**
(D14) even though skips are now how story time passes.

The first re-plan treated this as mistuning and proposed a per-meter *exchange-keyed* drift
table. That was the wrong axis. `−0.04/h` hygiene is already physiologically right; the
meter looks frozen because **drift is keyed to exchanges instead of the clock** — a legacy
of the 4-minute tick — so a meter's pacing tracks how much the player types rather than how
much story time passed. Keying pacing to exchanges makes "talking to her" the thing that
dirties her.

The owner's OQ1 answer ("energy should tick down… based on our time system") and the
deprecation of the world model (no session-lane parity left to protect, owner 2026-07-16)
together license the real fix.

Deliverable: **meters drift on the story clock at honest rates**, energy becomes a real
sleep model read as a **bidirectional axis** (positive = fuel in the tank, negative = past
wanting sleep, both poles saturating), arousal resolves, and skips get their consequences
from the character's own authored rhythm rather than a flat rule.

## The current economy (measured 2026-07-15)

Drift applies `CHAT_METER_DRIFT_MINUTES = 4` story-minutes of each meter's `perHour` per
**exchange** (`driftChatState` → `applyMeterDrift`, personalized by `personalizeMeters`):

| Meter                  | perHour       | Δ/exchange | First band                        | Exchanges to reach it |
| ---------------------- | ------------- | ---------- | --------------------------------- | --------------------- |
| hygiene (seed 0.9)     | −0.04         | −0.0027    | lived-in < 0.55                   | **~131**              |
| energy (seed 0.9)      | −0.05         | −0.0033    | tired < 0.45                      | ~135                  |
| stress (seed 0.15 → 0) | −0.03         | −0.002     | — (decays)                        | —                     |
| arousal (→ baseline)   | −0.10         | −0.0067    | cooling from 1.0 below flushed    | **~67 to cool**       |
| intoxication (→ 0)     | −0.12         | −0.008     | one drink chip (+0.3) clears in   | ~37                   |
| mood (→ 0.5)           | 0.06 recovery | 0.004      | —                                 | —                     |

Sources today: the **pulse** (arousal +0.18 per intimate concept, +0.09 courtship/physical
affection, unless disliked; mood/stress via the reaction curve) and the four **action
chips** (`drink` +0.3 intoxication · `freshen` hygiene = 0.95, +0.05 energy · `rest` +0.2
energy, −0.2 stress · `fluster` +0.25 arousal + the 90-min `flushed` condition). **Skips
contribute nothing** (D14). Nothing lowers hygiene but invisible drift; nothing raises
energy but the chips.

So the failure modes are structural: hygiene has no visible sink and no sources, arousal
has a strong source and no resolution, and skips move the clock without moving the body.

## Constraints

- **Resilience**: the new pulse read degrades to `null` — a missed detection costs one
  resolution beat, never a turn. Critically, the intimacy read's drift suppression keys on
  a **condition**, not on this exchange's pulse (§3), so a single dropped pulse can never
  cool an active scene.
- **Personalization stays**: rates/baselines resolve through `personalizeMeters` (libido
  shifts arousal's resting point up to +0.2 and halves its recovery at +100; composure
  speeds stress recovery). The climax reset targets the **personalized** baseline, not 0.
- **Rollback safety**: every new field rides `storedChatStateSchema`, so all of this stays
  "another take"-safe.
- **This one needs a migration** (0052 — the first in this plan's family; persona-library.plan.md took 0051). One additive
  integer column, so `db:generate` cannot hit the create-vs-rename prompt; the SQL needs a
  hand-checked **backfill** (see §1) before `pnpm db:migrate`.
- ~~`meterDefinitions` is shared with the session lane — do not fix chat by inflating
  `perHour`.~~ **Void** (owner, 2026-07-16): the world model is deprecated and the session
  lane is not in use. Rates get honest values in the registry, which is where a rate per
  story hour always belonged.

## Design

### 1. Drift moves to the story clock (the keystone)

Delete `CHAT_METER_DRIFT_MINUTES`. `driftChatState` drifts by **real elapsed story
minutes** since the last drift, read from a new per-character `metersAtMinutes`:

```ts
const elapsed = Math.min(CHAT_MAX_CATCHUP_MINUTES, clockMinutes - state.metersAtMinutes);
const meters = applyMeterDrift(state.meters, elapsed, personalizeMeters(defs, profile.traits));
// → { ...state, meters, metersAtMinutes: clockMinutes }
```

This is worth doing for pacing alone, but the reason it is the keystone is that **it
deletes three special cases**:

- **The `advance` flag goes.** Lazy drift is idempotent on read (elapsed 0 ⇒ no-op), so the
  read-only projection path (`/state/route.ts`) and the exchange path are the same call.
- **The away-freeze goes.** `advance: resolved.presence === "present"` (`chat-pipeline.ts:745`)
  encoded a world-model assumption that off-screen bodies pause. They don't — and
  chat-offscreen-life already ruled the cast keeps living. Away members simply catch up from
  `metersAtMinutes` when next read. **Ruled: drift is presence-independent; presence gates
  narration, not physiology.**
- **Skips need no meter code at all.** A skip advances the clock; the next drift covers it.
  This is most of the old slice 3, for free — and it heals two latent bugs on the way (an
  away primary desyncing at `time-skip/route.ts:115`, and the route committing the scenario
  before the member loop; see the spec's §Latent bugs).

**Migration 0052** (`character_chat_state`): **one** column — `meters_at_minutes`,
`integer not null default 0`. (§2's proportional reserve deleted the second one:
`awake_since_minutes` is unnecessary once decay needs no hours-awake input.) Default 0 would
make the first read of every existing row drift the entire history at once, so the migration
**must backfill from `character_chats.clock_minutes`**; `CHAT_MAX_CATCHUP_MINUTES` (7 story
days) is the belt-and-braces guard, not the fix.

**The retuned table** — one table, one meaning, in `meters/registry.ts`:

| Meter        | perHour        | → what that means                                             |
| ------------ | -------------- | ------------------------------------------------------------- |
| hygiene      | −0.04 → **−0.03** | lived-in (< 0.55) ~13h after a shower; unwashed ~22h        |
| arousal      | −0.10 → **−0.30** | 1.0 cools below flushed in ~1.5h; a proposition fades in ~36m |
| stress       | −0.03 → **−0.10** | 1.0 eases off-edge in ~4h, calm in ~10h (was ~33h)          |
| intoxication | −0.12 (keep)      | one drink clears in ~2.5h — already right                    |
| mood         | 0.06 → **0.10** recovery | an even keel returns over an evening, not a day     |
| energy       | *proportional* — see §2 | the one meter on the exponential law (τ = 16h), not `perHour` |

Sanity check on a **100-exchange visit** (= 100 story-minutes): hygiene −0.05, energy
−0.01, arousal −0.50, stress −0.17, mood +0.17. Nothing about talking dirties or exhausts
anyone; arousal genuinely cools mid-scene; skips do the heavy lifting, which is what they
are for.

> **On arousal's rate**: −0.30/h is a deliberate compromise. The physiologically honest
> value is nearer −0.50/h (acute arousal subsides in 10–30 minutes), but arousal is
> currently doing double duty as the scene's *persistent charge*. −0.50 lands once the
> `desire` appetite meter exists to hold that charge — see the spec's §Ruling OQ2.

### 2. Energy: a bidirectional read over a reserve and the circadian

The owner's OQ1 timeline could not live on one 0–1 meter (spec §Ruling OQ1 — requiring
"tired at 12h" forces a drain that zeroes the meter at ~24h). **Ruled 2026-07-16: energy is
a signed read — positive is fuel in the tank, negative is how far the body is past wanting
sleep.** The two axes don't compete; one subtracts from the other, because "even if people
have energy they still feel more tired when they know it's past their normal bedtime":

```ts
read = clamp(-1, +1, reserve - pressure);
```

**(a) `reserve`** — the stored 0–1 `energy` meter. Fuel. **Decays proportionally**:
`reserve *= Math.exp(-elapsedHours / CHAT_ENERGY_TAU)`, τ = **16h**, restored by sleep,
capped at `CHAT_ENERGY_WAKE_CAP` (0.95). One knob, not a five-row curve. This is a small
registry extension — a `proportional` drift law beside the linear `perHour` — and it pays
for itself: it is the biologically correct shape (Process S is exponential), it is
**exactly composable** (`exp(−a)·exp(−b) = exp(−(a+b))`, so sixty 1-minute drifts equal one
60-minute drift *by construction*), and it makes sleep debt free (below).

**(b) `pressure`** — circadian sleep pressure. Derived, never stored:
`deriveCircadianPressure(profile, clockMinutes, calendarStart)`, a pure function of the
story clock against the character's own `sleep` rhythm rows (§4). Low by day, a small
afternoon dip, ramping into bedtime, peaking at the ~4am trough, **falling after it** (the
second wind), plus a brief post-waking bump (sleep inertia). Absent rows ⇒ a 23:00–07:00
default. No storage, no migration, and it rebases for free if the calendar anchor is edited.

**Zero is a definition, not a threshold**: at her normal bedtime, pressure exactly equals
her remaining reserve — *that is what bedtime means*. Per-character (a night owl's zero is
2am), no magic number. **Both poles saturate**, which is what makes them useful to build on:
**+1** = maximally rested (the 0.95 cap means sleeping longer doesn't stack), **−1** =
maximally sleep-demanding (collapse hangs off *sitting at the floor*, not an hour count —
and how long a character holds there is characterful, a trait seam).

The arc for a 7am wake / 11pm bedtime — every number below is emergent from τ and the
pressure curve, with **no hardcoded hour anywhere**:

| moment       | h awake | reserve | pressure | read     | reads as             |
| ------------ | ------- | ------- | -------- | -------- | -------------------- |
| 11am         | 4       | 0.74    | 0.05     | +0.69    | bright               |
| 3pm          | 8       | 0.58    | 0.15     | +0.43    | the afternoon dip    |
| 9pm          | 14      | 0.40    | 0.20     | +0.20    | winding down         |
| **11pm bed** | 16      | 0.35    | 0.35     | **0.00** | **the zero**         |
| 4am trough   | 21      | 0.26    | 1.05     | −0.79    | wrecked              |
| 8am next day | 25      | 0.20    | 0.55     | −0.35    | **second wind**      |
| 11pm night 2 | 40      | 0.08    | 1.10     | −1.00    | the floor — collapse |

τ is the tuning knob for the owner's "mentally tired by 5 or 6pm": at 11h awake the read is
+0.43, and lowering τ walks the whole evening arc down together.

**Read bands** (the read owns the vocabulary, so energy **joins mood** as a meter with no
registry thresholds): ≥ +0.5 bright · +0.5…+0.2 fine, no cue · +0.2…0 winding down ·
0…−0.35 past it · −0.35…−0.75 running on fumes · ≤ −0.75 at the floor, collapse risk. Rather
than hardcode a second exception in `chat-status.tsx` (where mood's `bright`/`low` pips live
today), this slice adds the shared **derived-read seam** (`meters/reads.ts`) that mood,
energy, and §3's arousal signs all resolve through.

**Sleep** is one concept with two sources — a rhythm `sleep` window a skip crossed, and an
`asleep` condition (how a collapse is stored) — unified by a pure
`sleepMinutesBetween(profile, conditions, from, to)`. Restore is **linear**
(`+CHAT_SLEEP_RECOVERY_PER_HOUR (0.09)` per hour slept, capped 0.95) onto the proportional
tank, and that asymmetry is the whole debt mechanic, for free:

| sleep                            | result   |                                        |
| -------------------------------- | -------- | -------------------------------------- |
| 8h from a normal bedtime (0.35)  | **0.95** | a full night fully refills             |
| 4h from a normal bedtime (0.35)  | **0.71** | a short night starts the day short     |
| 8h after a 40h bender (0.08)     | **0.80** | one night does not clear a real debt   |
| 12h from 0.35                    | **0.95** | oversleeping doesn't stack — the +1 pole |
| a 90-min nap from 0.60           | **0.73** | a nap is a top-up, no threshold needed |

**Collapse** fires on the read sitting at the floor, and resolves through machinery that
already exists: it mints an `asleep` condition (`durationMinutes: 480`) which self-expires
via the clock-keyed expiry, and `sleepMinutesBetween` restores the reserve on the drift that
crosses it. Per the owner, **no debuffs on waking for now** — the energy-condition family
gates on the read's sign and is named in §Later.

> **Two things this model deletes.** `awakeSinceMinutes` is unnecessary — a *proportional*
> rate needs no hours-awake input, so the reserve value **is** the debt ledger, and
> migration 0052 drops to one column (`meters_at_minutes`). `CHAT_SLEEP_MIN_HOURS` ("a nap
> is not a night") is unnecessary too — a short sleep simply restores less. Both were
> scaffolding for the piecewise curve.

### 3. Arousal: resolution, and body facts instead of a talk-switch

Two problems, one slice. The concept vocabulary has `proposition` (the ask) but nothing for
the act or its completion, and the pulse only classifies the **player's** act — completion
usually lands in the narrator's reply. And per the owner's OQ2, arousal currently reads as
"she's aroused so she talks different" rather than as physiology.

**The scene-level read** — no new concepts:

- **Pulse schema** (`contracts/turns/chat-pulse.ts`): `intimacy:
  z.enum(["active", "climax"]).nullable().catch(null).default(null)` — "is this exchange
  inside an active intimate scene, and did it complete?" Prompt guidance beside the existing
  pulse fields; the pulse already sees both sides of the exchange.
- **On `active`**: upsert a short `heated` condition (15 min) and suppress ambient arousal
  drift **while that condition stands**. Keying suppression on the condition rather than on
  this exchange's pulse is what makes a dropped pulse survivable — the scene holds, and the
  condition's expiry 15 minutes after the last active read *is* the natural cooldown. Also
  hygiene −0.02 (sweat, §5).
- **On `climax`**: `arousal = min(current, personalizedBaseline + CHAT_AROUSAL_AFTERGLOW_RESIDUE
  (0.15))` — sated, not switched off, and always below the `flushed` band. Upsert a
  self-expiring **`afterglow`** condition (90 min, hint "sated and loose-limbed, warm,
  unhurried"), inline like the fluster chip's `flushed`. Stress −0.15, mood +0.10 (composing
  with the exchange's curve deltas), hygiene −0.05 (§5). The intimate-act arousal bump is
  **skipped** on a climax exchange — the reset wins. Clears `heated`.
- **Trace**: extend `ChatPulseTrace.changed` + an `intimacy` field so the state tools and
  inspector show the read.
- **Degradation**: `null` = today's behavior exactly; §1's faster ambient drift is the
  backstop, so a missed climax cools in ~1.5h of story time instead of sticking for 50+
  exchanges.

**The physiology half** (spec §Ruling OQ2) — the substrate/read law applied:

- **Regrade the bands to body facts.** One behavioral hint ("flushed skin, shallow breath,
  lingering eye contact") becomes a graded physiological vocabulary — `kindled` / `flushed` /
  `wound-tight` / `cresting` — naming what the body is doing, with no directive about diction.
- **`deriveArousalSigns`** (through §2's read seam) is the perception gate: signs resolve
  against `resolveChatWardrobe`'s coverage-computed exposure and the frame. Flush and breath
  read at conversational range; swelling and wetness are gated on an intimate frame **and**
  exposure/contact, and bind to the body model rather than being assumed.
- **Re-scope disinhibition, don't delete it.** `stateDispositionOverlays` currently spends
  arousal lowering `intimate.inhibition`, `social.guardedness`, **and** `temperament.composure`.
  Ruled: **arousal loosens `intimate.inhibition` only** — being turned on lowers what you'll
  do; it doesn't make you a different person or slur your words. Intoxication keeps all three.

### 4. Skips: the rhythm is the circumstance (D14 deleted)

Per §1 the cooling half is already free — a skip advances the clock and the next drift
covers it. What remains is what a skip *implies*, and the owner's OQ3 ruling cuts the
previous plan's `hygiene = max(current, 0.9)` blanket restore outright: the narrated main
NPC should be *shown* washing, not silently reset.

But the naive opposite (skips grant only sleep) puts a character at hygiene 0 after any
`days` skip. The resolution: **off-screen self-care is a rhythm event, not a skip rule.**
D14's rationale — "whether twelve skipped hours mean recovery or deterioration is
circumstance" — was right, and the circumstance is **already authored**: `profile.schedule`.

`rhythmBodyPatch(profile, fromMinutes, toMinutes)` — the deterministic sibling of the
shipped `rhythmOutfitPatch` ("a schedule row covering the skipped-to clock re-dresses the
character") — credits only the rhythm slots the skipped window actually crossed, at the
clock minute they sit on:

- An `overnight` skip landing at **8am**, past a 7am `wash` row → she slept *and* showered.
- The same skip landing at **6am**, before it → she slept and has **not** showered, and that
  need stands in the scene for the fiction to play. Exactly the owner's "they still need to
  take a shower."
- Drain resumes from the last crossed slot, so the tail is always a real, playable need —
  never a blanket reset, never a filthy character.

This makes the present/away branch unnecessary: the rhythm is the character's *own life*,
not a narrator's assumption, so it applies to everyone. No LLM call, pure, and it is the
"fully circumstance-aware time-effects system" D14 deferred.

**Enabler — the one world-model redesign this plan needs.** `ScheduleEntry.activity` is a
free-form string, so the rhythm is prose the narrator reads and nothing else can. It gains
an optional structured `kind` (`sleep` | `wash` | `meal` | `work` | `leisure`), plus
`inferScheduleKind(activity)` so already-authored schedules ("Sleeping", "Shower and
coffee") light up with **no re-authoring and no migration** (it is a jsonb profile field).
`scheduleEntryAt` moves from `engine/merge/phases/schedule.ts` (session lane) to contracts,
beside the schema — the chat lane already reaches across the boundary for it.

### 5. Hygiene sources (small, rides §3)

Give the sink something to answer: hygiene −0.02 per `intimacy: "active"` exchange, −0.05
on `climax`, constants beside the afterglow residue. Nothing else — no new detection
surface; workout/exertion dirtying waits for the `workout` action to reach the chat lane
with [chat-body-needs.plan.md](chat-body-needs.plan.md).

## Verification

- **Unit** (`chat-state.test.ts`, `registry.test.ts`): drift is idempotent on a zero elapsed
  and equals one 60-minute call for sixty 1-minute calls — assert this for **both** drift
  laws (the proportional one satisfies it by construction; it is the linear one's clamp that
  could regress); a 100-exchange visit moves hygiene < 0.06; band crossings pinned to §1's
  table (hygiene 0.95 → lived-in in 12–14h; arousal 1.0 → below flushed in 1.3–1.7h).
- **Unit, energy** — pin the §2 arc, since every number in it is emergent and a τ or
  pressure-curve edit should have to restate its intent: `read ≈ 0` at her bedtime (±0.05)
  **for a character with a non-default sleep row too** (the zero is per-character, not 11pm);
  the 4am trough below −0.7; the 8am second wind strictly **above** the 4am trough (the
  property, not the number — this is the one behavior a naive monotonic model would lose);
  the floor reached in 38–42h; the nap case reading positive at bedtime; and the four sleep
  restores from §2's table (0.35+8h → 0.95, 0.35+4h → 0.71, 0.08+8h → 0.80, 12h → capped).
- **Unit, the rest**: climax lands at personalized baseline + residue and below 0.55 for a
  high-libido profile; a `heated` condition suppresses arousal drift **and survives a
  degraded pulse**; `rhythmBodyPatch` credits a crossed `wash` row and *not* an uncrossed
  one; an away member's meters catch up on next read; degradation: null `intimacy` ⇒
  byte-equal to the no-read fold **and** the mandated diagnostic on a degraded pulse.
- **Migration**: verify the 0052 backfill on a **branch** first (`neonctl branches create`),
  not prod — an un-backfilled row drifts its whole history on first read.
- **Playtest on Fly** (deploy first — the UI-testing surface): one long flirt → intercourse →
  aftermath, checking the strip pips: heated during, arousal clears on the completion
  exchange, afterglow chip shows; then `overnight` skip → arousal/intoxication cleared,
  energy restored per hours slept, hygiene restored **only** if the landing crossed a wash
  row; then a `days` skip → still not filthy.
- Full gate (lint → lint:cycles → typecheck → test → jscpd, one at a time) before claiming done.

## Later (named, not built)

- **Energy conditions** — the owner's "many conditions related to energy": `groggy` (sleep
  inertia), `wired`, `microsleeps` at `spent`. Waking carries no debuffs until these exist.
- **Condition-gated self-care suppression** — a "trapped/rough night" condition suppressing
  `rhythmBodyPatch`. The seam is named; deferred until a real scene hits it.
- **`desire`** — the appetite meter that lets arousal's rate go physiologically honest
  (−0.50/h). Graduates with [chat-body-needs.plan.md](chat-body-needs.plan.md).
- **`intercourse` as an interaction concept** — unnecessary for meters (the `intimacy` read
  covers them); a registry data edit for the day a preference card must like/dislike the act
  itself rather than the ask.

## Files touched

`src/contracts/meters/registry.ts` (the retuned rate table, energy curve, band re-placement),
`src/contracts/meters/reads.ts` (**new** — the derived-read seam: mood, energy, arousal signs),
`src/contracts/world/profile.ts` (`ScheduleEntry.kind` + `inferScheduleKind`),
`src/contracts/world/schedule.ts` (**new** — `scheduleEntryAt`, moved from the merge lane),
`src/contracts/turns/chat-pulse.ts` (the `intimacy` field + `ChatPulseTrace`),
`src/contracts/turns/chat-skip.ts` (delete the D14 comment),
`src/contracts/personality/modulation.ts` (re-scope arousal's disinhibition reach),
`src/server/engine/constants.ts` (delete `CHAT_METER_DRIFT_MINUTES`; add the sleep/afterglow/catchup constants),
`src/server/engine/chat-state.ts` (`driftChatState`, `applyChatPulse`, `applyTimeSkip`, `rhythmBodyPatch`),
`src/server/engine/chat-pipeline.ts` (drop the away-freeze `advance` branch),
`src/app/api/chats/[chatId]/time-skip/route.ts` (drop the presence `continue`),
`src/server/db/schema.ts` + `drizzle/0052_*.sql` (`meters_at_minutes` — one column, **+ backfill**),
`src/components/characters/chat-status.tsx` (pips through the read seam),
tests beside each. Docs: `docs/character-chat/state.md` (time-model + tracked-state),
`docs/contracts/meters-actions.md` (the classes + the substrate/read law),
`docs/contracts/conditions.md` (the `id`-is-semantic correction — see the spec).
