# Chat meter economy — spec

Companion to [chat-meter-economy.plan.md](chat-meter-economy.plan.md) (read that first for
the goal and the slices). Records the owner's rulings on OQ1–OQ3 (2026-07-16), the meter
taxonomy they imply, and the world-model systems this work reuses or redesigns.

The one-line frame: **a meter is physiological substrate on the story clock; the narrator
never sees a meter, only a derived, perception-gated read of one.**

## The law: substrate vs. read

The load-bearing ruling, generalized from OQ2. Two layers, never conflated:

- **Substrate** — the stored 0–1 scalar. It models a *body fact* (sleep reserve, arousal,
  freshness) and moves only through drift and sources. It is never prose, never an
  instruction, and never band-specific.
- **Read** — a pure, total projection of substrate (+ context) into what a witness could
  actually perceive *this exchange*. Reads own all prose and every UI pip. They are gated
  on perceivability: exposure (`resolveChatWardrobe`'s coverage-computed `exposedRegions`),
  frame (intimate vs. not), and proximity.

The lane already proves this pattern twice — `deriveMoodDescriptor` blends valence ×
stress × energy into a phrase, and `deriveEmotionLabel` is an explicitly "pure, **total**
projection". Mood is deliberately the meter with **no registry thresholds**
([../contracts/meters-actions.md](../contracts/meters-actions.md) §Mood). This spec makes
that the rule rather than the exception.

**What the law forbids**, and what today violates it:

| Registry hint (today)                                              | Verdict                                     |
| ------------------------------------------------------------------ | ------------------------------------------- |
| hygiene < 0.55 "faint sweat and warm skin" *at close range*         | ✅ body fact + a perceivability gate         |
| energy < 0.45 "slower replies, longer blinks, yawns"                | ❌ behavior instruction — rewrite as a read  |
| intoxication > 0.35 "warmer laughter, imprecise gestures"           | ❌ behavior instruction — rewrite as a read  |
| arousal > 0.55 "flushed skin, shallow breath, lingering eye contact" | ⚠️ two body facts + one behavior; regrade   |

A read may still *describe* behavior ("she is fading") — the difference is that a read is
derived from context and gated on perceivability, while a threshold hint is an
unconditional directive stapled to a number.

## Ruling OQ1 — energy is sleep reserve; tiredness is a read

The owner's timeline: slow decay for the first few hours → normal → faster at 12–15h →
faster at 24h → rapid at 36h → **pass out at 48h**; "mentally tired by 5 or 6pm but still
functional"; "not truly exhausted until over 24 hours"; wake after 8h, no debuffs for now.

**These are not all the same axis, and one linear meter cannot hold them.** Requiring the
value to cross `tired` (0.45) at 12h forces an average drain of 0.042/h, which zeroes the
meter at ~24h — the exact opposite of "not exhausted until 24h+" and "pass out at 48h".
Monotonically *increasing* decay that lands at 0 exactly at 48h mathematically requires
the meter to still sit near ~0.88 at hour 12. The contradiction is real and it is
diagnostic: **"tired at 5pm" and "wrecked at 30h up" are different phenomena.**

Ruled — three axes, which is the standard three-process model of sleep regulation:

1. **`energy` = homeostatic sleep reserve.** Drains on hours awake via the owner's
   piecewise curve, restored by sleep. Its bands mean *sleep deprivation*, so they move to
   that scale (`tired` < 0.70 ≈ 25h awake, `exhausted` < 0.40 ≈ 37h). At hour 12 it reads
   ~0.87 and shows **nothing** — correct: being up 12 hours is not sleep-deprived.
2. **Circadian pressure** — derived, never stored: a pure function of the story clock
   against the character's own `sleep` rhythm rows. Peaks inside the sleep window, ramps in
   the ~2h before it, decays over the ~2h after waking (sleep inertia — grogginess). This
   is what makes 3am hard and what makes a short night felt.
3. **Time-on-task** — hours awake, read directly. This is the owner's 5–6pm: the end of a
   long day, gone after a night's sleep, invisible to the reserve.

`deriveEnergyRead(energy, hoursAwake, circadian)` blends all three into the one phrase the
narrator sees and the one pip the strip shows. Energy therefore **joins mood** as a meter
with no registry thresholds — the read owns its vocabulary.

Consequences ruled with it:

- **Pass-out fires on `energy` reaching 0, not on a 48h timer.** Hours-awake only sets the
  *rate*, so a nap legitimately buys real time (+0.2 at the 0.037/h band ≈ 5 more hours)
  without resetting the debt. 48h is the no-naps case, which is what the owner described.
- **Sleep is one concept with two sources**: a rhythm `sleep` window a skip crossed, and an
  `asleep` condition (how a pass-out is stored). `sleepMinutesBetween` unifies them, so the
  pass-out needs no bespoke wake path — the existing self-expiring condition machinery
  (`isConditionExpired`) already does the timing.
- **A nap is not a night.** Only a sleep episode ≥ `CHAT_SLEEP_MIN_HOURS` resets the awake
  clock; below it, the `rest` chip's energy top-up stands alone.
- **Short sleep carries debt forward.** Waking sets `awakeSinceMinutes = now − carried`,
  where sleeping *h* hours clears `h × CHAT_SLEEP_DEBT_CLEAR_RATIO` hours of prior
  wakefulness. Eight hours clears a full day; four hours leaves you four hours "already
  into" the next one. The awake clock *is* the debt ledger — no second field.
- Per the owner, waking carries **no debuffs** for now. The energy-condition family
  (`groggy`, `wired`, `microsleeps`) is named in the plan's Later section, not built.

## Ruling OQ2 — arousal is a driver, not a talk-switch

The owner: arousal "was supposed to increase wetness, swelling, blood pressure, heart
rate, etc. which could then be represented in narration or trigger other processes. It
wasn't supposed to be 'this character is now fully aroused so change the way they talk'."

Today it does exactly the objectionable thing, in two places: one behavioral threshold hint
at > 0.55, and `stateDispositionOverlays`, which spends arousal (at
`AROUSAL_DISINHIBITION_WEIGHT = 0.3` of intoxication's weight) lowering
`intimate.inhibition`, `social.guardedness`, **and** `temperament.composure`.

Ruled — three moves, in the substrate/read shape:

- **Regrade the bands to body facts.** One behavioral hint becomes a graded physiological
  vocabulary (`kindled` / `flushed` / `wound-tight` / `cresting`) naming what the body is
  doing — pulse, breath, skin, focus — with no directive about diction.
- **Add `deriveArousalSigns`** — the perception gate. Signs resolve against
  `resolveChatWardrobe`'s coverage-computed exposure and the frame: flush and breath read
  at conversational range; swelling and wetness are gated on an intimate frame **and**
  exposure/contact, and bind to the body model rather than being assumed. This is the
  answer to "represented in narration": narration gets *facts a witness could perceive*,
  not a mood instruction.
- **Re-scope disinhibition, don't delete it.** The mechanic is legitimate — it is the
  "trigger other processes" the owner wants — but its reach is wrong. **Arousal loosens
  `intimate.inhibition` only.** Guardedness and composure stay intoxication's business:
  being turned on lowers what you'll do, it does not make you a different person or slur
  your words. Intoxication keeps all three traits.

The `aroused` emotion label is already gated on an intimate frame (not undress) and needs
no change — it was built to this law before the law was written.

**Where the driver goes next** (the "other processes" half): climax → afterglow (plan
slice 3); exertion → energy, so an intimate scene actually costs something; arousal →
heart rate → hydration, once [chat-body-needs.plan.md](chat-body-needs.plan.md) lands; and
a **desire** appetite meter (days without intimacy raising the arousal *baseline* and
feeding initiative), which is the romance-lane meter this taxonomy most obviously wants.
`intercourse` as an interaction concept stays unnecessary for meters — the `intimacy` read
covers them — and remains a registry data edit for the day a preference card needs to
like/dislike the act itself rather than the ask.

## Ruling OQ3 — no blanket self-care; the rhythm is the circumstance

The owner: the overnight reset "isn't really correct anyway *unless* the character is not
being narrated… when they go to sleep, their energy refills (based on how long they slept)
but they still need to take a shower, eat, etc."

The plan's `hygiene = max(current, 0.9)` on big skips is **cut**. But the naive opposite —
skips grant only sleep, hygiene drains on the clock — puts a character at hygiene 0 after
any `days` skip, which is worse. The resolution collapses the owner's narrated/unnarrated
distinction into something cleaner:

**Off-screen self-care is a rhythm event, not a skip rule.** D14's rationale — "whether
twelve skipped hours mean recovery or deterioration is circumstance" — was right, and the
circumstance turns out to be **already authored**: `profile.schedule`. A skip credits only
the rhythm slots it actually crossed, at the clock minute they sit on. So:

- An `overnight` skip landing at **8am**, past a 7am `wash` row → she slept *and* showered.
- The same skip landing at **6am**, before it → she slept and has **not** showered, and
  that need stands in the scene for the fiction to play. This is precisely the owner's
  "they still need to take a shower."
- Drain resumes from the last crossed slot, so the tail is always a real, playable need
  rather than a blanket reset or a filthy character.

This makes the present/away branch unnecessary: the rhythm is the character's *own life*,
not an assumption a narrator has to license, so it applies to everyone. What differs is
only that a narrated character's unmet needs are visible. **D14 is deleted rather than
revised** — the "full circumstance-aware time-effects system" it deferred is this, and it
costs no LLM call.

The escape hatch the owner's note leaned toward is kept as a named seam, not built: an
active condition (a "trapped/rough night") suppressing rhythm self-care. Deferred until a
real scene hits it.

## The meter taxonomy

The classes the six existing meters and the PM-notes meters fall into. A class fixes a
meter's drift shape, its sources, and how it reaches behavior.

| Class                | Shape                                     | Members (today → planned)                                             |
| -------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| **Reserve/appetite** | depletes → becomes a *need*               | `energy` → `satiation`, `hydration`, `desire`, social battery          |
| **Load**             | fills from sources → decays to a baseline | `arousal`, `intoxication`, `stress` → `bladder`, pain/soreness         |
| **Valence**          | an axis, not a resource; baseline-seeking | `mood`                                                                 |
| **Rate**             | clock-keyed drain against a rhythm        | `hygiene`                                                              |
| **Phase**            | a cyclic driver that modulates others     | *(none yet)* → hormonal phase, circadian (derived, never stored)       |

Two properties fall out and are worth stating as invariants:

- **Reserves are the push channel.** A load meter colors a scene; a reserve meter crossing
  a band creates a *want*, and wants are what the drives/initiative system already
  consumes. This is the difference between pips and a living world, and it is why
  satiation/hydration/bladder belong with a needs→initiative slice rather than as three
  more numbers.
- **Phase meters modulate baselines, never values.** The precedent exists —
  `personalizeMeters` shifts arousal's resting point by libido; `conditionMoodBaselineShift`
  shifts mood's. A cycle is the same seam on a clock.

## World-model systems: reuse and redesign

The world model is being deprecated and the session lane is not in use, so its systems are
available to take rather than parallel (owner, 2026-07-16). What this work claims:

- **`contracts/actions/registry.ts` — reuse wholesale, eventually.** It is already a pure
  contract registry of *exactly* the self-care vocabulary this needs (`shower` 20min
  `hygiene set 0.95`, `nap` 90min `energy +0.3`, `meal`/`snack`/`workout`/`groom`), and the
  chat lane forked it into four hardcoded chips with instant deltas and no minutes. `meal`
  and `snack` carry **no** `meterEffects` today purely because no satiation meter exists —
  the registry has been waiting for it. Collapsing the fork belongs to
  [chat-body-needs.plan.md](chat-body-needs.plan.md), not here; this plan only stops making
  the fork worse.
- **`profile.schedule` — redesign (additively).** `ScheduleEntry.activity` is a free-form
  string, so the rhythm is prose the narrator reads and nothing else can. It gains an
  optional structured `kind` (`sleep`/`wash`/`meal`/`work`/`leisure`), plus
  `inferScheduleKind(activity)` so already-authored schedules ("Sleeping", "Shower and
  coffee") light up with no re-authoring and no migration. This one field is what makes the
  awake clock, off-screen self-care, and circadian hunger possible.
- **`scheduleEntryAt` — move to contracts.** It is a pure helper marooned in
  `engine/merge/phases/schedule.ts` (the session lane); the chat lane already reaches across
  the boundary for it via `rhythmOutfitPatch`. Its home is beside the schema.
- **`merge/phases/meters.ts` — take the pattern, not the code.** It already does what chat
  should: `perHour` over *real* elapsed minutes, plus action `meterEffects`, plus
  `conditionMoodBaselineShift`. That last one is wired **only** session-side —
  `driftChatState` ignores condition mood shifts entirely, a gap this plan closes.
- **The plan's Constraint #1 is void.** "`meterDefinitions` is shared with the session lane
  … do **not** fix chat by inflating `perHour`" was the reason for the exchange-keyed drift
  table. There is no parity left to protect, so rates get honest values in the registry —
  the one table where a rate per story hour has always belonged.
- **`rhythmOutfitPatch` is the precedent to copy.** "A schedule row covering the skipped-to
  clock re-dresses the character" is already shipped and already the exact shape of rhythm
  self-care. `rhythmBodyPatch` is its sibling, not a new idea.

## Latent bugs found while speccing

Not this plan's scope; recorded so they are not rediscovered. Each is small.

- **`conditionMoodBaselineShift` never fires in chat** (`chat-state.ts:853-866` drifts to
  personalized baselines with no condition input) — closed by this plan's drift rewrite.
- **Its table can never match anyway**: `CONDITION_MOOD_BASELINE_SHIFTS` keys `flustered`,
  but the fluster chip mints label `"Flushed"` → `conditionKey` = `"flushed"` ⇒ contributes
  0 even session-side.
- **An away primary desynchronizes on skip**: `time-skip/route.ts:115` `continue`s on
  `presence !== "present"`, so an away primary's state is never skipped while the shared
  clock advances, and the route returns the un-skipped snapshot. The drift rewrite's lazy
  `metersAtMinutes` catch-up removes the branch that causes it.
- **The skip route commits the scenario before the member loop** (`:82` vs `:102`), so a
  mid-loop failure leaves the clock advanced with members un-skipped. Also healed by lazy
  drift — members catch up from `metersAtMinutes` on next read regardless.
- **`docs/contracts/conditions.md:30` contradicts the code**: it says a condition `id` is
  "a random `newId()`, never semantic", but `chat-state.ts:2265` mints `id: "flushed"`
  deliberately, because `upsertCondition` dedupes on `id`. The afterglow condition follows
  the code; the doc needs the correction.
