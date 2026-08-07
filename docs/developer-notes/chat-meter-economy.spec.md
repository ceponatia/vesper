# Chat meter economy — spec

Status: companion to [chat-meter-economy.plan.md](chat-meter-economy.plan.md)

Read the plan first for the goal and the slices. This spec records the owner's rulings on
OQ1–OQ3 (2026-07-16), the meter taxonomy they imply, and the world-model systems this work
reuses or redesigns.

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

| Registry hint (today)                                                | Verdict                                    |
| -------------------------------------------------------------------- | ------------------------------------------ |
| hygiene < 0.55 "faint sweat and warm skin" *at close range*          | ✅ body fact + a perceivability gate        |
| energy < 0.45 "slower replies, longer blinks, yawns"                 | ❌ behavior instruction — rewrite as a read |
| intoxication > 0.35 "warmer laughter, imprecise gestures"            | ❌ behavior instruction — rewrite as a read |
| arousal > 0.55 "flushed skin, shallow breath, lingering eye contact" | ⚠️ two body facts + one behavior; regrade  |

A read may still *describe* behavior ("she is fading") — the difference is that a read is
derived from context and gated on perceivability, while a threshold hint is an
unconditional directive stapled to a number.

## Ruling OQ1 — energy is a bidirectional read over a reserve and the circadian

The owner's first timeline: slow decay for the first few hours → normal → faster at 12–15h
→ faster at 24h → rapid at 36h → pass out at 48h; "mentally tired by 5 or 6pm but still
functional"; "not truly exhausted until over 24 hours".

**As one 0–1 meter this was unsatisfiable.** Requiring the value to cross `tired` (0.45) at
12h forces an average drain of 0.042/h, zeroing the meter at ~24h — the opposite of "not
exhausted until 24h+" and "pass out at 48h". The contradiction was diagnostic: **"tired at
5pm" and "wrecked at 30h up" are different phenomena.** (48h was later clarified as "a test
example", not a requirement — good, because the read below reaches collapse at ~40h
*emergently*, with no hardcoded hour anywhere.)

**Ruled (owner, 2026-07-16) — a bidirectional read: positive is fuel in the tank, negative
is how far the body is past wanting sleep.** The decisive framing is the owner's: "even if
people have energy they still feel more tired when they know it's past their normal
bedtime." So the two axes are not alternatives to choose between — one *subtracts from* the
other:

```
read = clamp(−1, +1, reserve − pressure)
```

- **`reserve`** — the stored 0–1 `energy` meter. Fuel. Decays **proportionally** (below),
  restored by sleep, floors at 0. A tank cannot hold a negative amount.
- **`pressure`** — circadian sleep pressure. Derived, never stored: a pure function of the
  story clock against the character's own `sleep` rhythm rows. Low by day, a small
  afternoon dip, ramping into bedtime, peaking at the ~4am trough, **falling after it**
  (the second wind), plus a brief post-waking bump (sleep inertia).
- **Zero is a definition, not a threshold.** At her normal bedtime, pressure exactly equals
  her remaining reserve — *that is what bedtime means*. It is per-character (a night owl's
  zero is 2am) and needs no magic number.

**Both poles saturate, which is the point** (owner: "a max negative energy point where it
doesn't keep decreasing… helps us develop systems around both polar maxes"):

- **+1** — maximally rested. The reserve cap (0.95) means sleeping longer does not stack, so
  the ceiling is a real state to hang systems off rather than an unreachable asymptote.
- **−1** — maximally sleep-demanding. Collapse hangs off *sitting at the floor*, not off an
  hour count — and how long a character can hold there is characterful (a trait seam), not
  a constant.

Verified against the cases that broke the single-axis version (7am wake / 11pm bedtime):

| moment       | h awake | reserve | pressure | read     | reads as             |
| ------------ | ------- | ------- | -------- | -------- | -------------------- |
| 11am         | 4       | 0.74    | 0.05     | +0.69    | bright               |
| 3pm          | 8       | 0.58    | 0.15     | +0.43    | the afternoon dip    |
| 9pm          | 14      | 0.40    | 0.20     | +0.20    | winding down         |
| **11pm bed** | 16      | 0.35    | 0.35     | **0.00** | **the zero**         |
| 4am trough   | 21      | 0.26    | 1.05     | −0.79    | wrecked              |
| 8am next day | 25      | 0.20    | 0.55     | −0.35    | **second wind**      |
| 11pm night 2 | 40      | 0.08    | 1.10     | −1.00    | the floor — collapse |

The **nap case** the single axis could not answer: naps 2–6pm, so at her 11pm bedtime
reserve is ~0.70 against pressure 0.35 ⇒ read **+0.35**. She is past her bedtime and feels
it, but she has fuel — up, and a little wired. Exactly the owner's framing.

**`reserve` decays proportionally, not linearly** — `reserve *= exp(−elapsed/CHAT_ENERGY_TAU)`,
τ ≈ 16h. This is a small registry extension (a `proportional` drift law beside the linear
`perHour`), and it earns it four times over:

- It is the biologically correct shape — Process S in the three-process model is exponential.
- It is **exactly composable**: `exp(−a)·exp(−b) = exp(−(a+b))`, so sixty 1-minute drifts
  equal one 60-minute drift by construction. The piecewise-curve version had a real
  path-dependence gotcha at band boundaries; this deletes it.
- **One knob (τ) replaces a five-row curve table.** The felt acceleration the owner
  originally described now comes from `pressure` rising through the night — which is where
  it actually comes from.
- **Sleep debt becomes free.** Restore is linear (`+0.09/h`, capped 0.95) onto a
  proportional tank, so a full night from a normal bedtime (0.35) refills to 0.95, but a
  full night after a 40h bender (0.08) reaches only **0.80** — day two starts short, with no
  debt mechanic written. Proportional decay is also start-point-independent, so a short
  night simply decays onward from wherever it left her.

**Two things this deletes.** `awakeSinceMinutes` is unnecessary — a proportional rate does
not need to know hours awake, so **the reserve value *is* the debt ledger** (migration 0051
drops to one column). And `CHAT_SLEEP_MIN_HOURS` ("a nap is not a night") is unnecessary — a
90-minute nap simply restores +0.135 because it is short. Both were scaffolding for the
piecewise model.

`deriveEnergyRead(reserve, pressure)` owns the vocabulary, so energy **joins mood** as a
meter with no registry thresholds. Sleep stays one concept with two sources — a rhythm
`sleep` window a skip crossed, and an `asleep` condition (how a collapse is stored) —
unified by `sleepMinutesBetween`, so a collapse needs no bespoke wake path: the existing
self-expiring condition machinery (`isConditionExpired`) already does the timing. Per the
owner, waking carries **no debuffs** for now; the energy-condition family (`groggy`,
`wired`, `microsleeps`) gates on the read's sign and is named in the plan's Later section.

### The generalization: deficit reads

The signed-with-a-meaningful-zero shape is **not energy-specific** — it belongs to the read
seam, and every reserve meter wants it. Hunger's zero is "when she'd normally eat"; thirst,
`desire`, and social battery all have an act-point. A **deficit read** is therefore the
reusable shape: signed, zero at the character's own act-point, negative meaning overdue,
both poles saturating. One seam serves all of them
([chat-body-needs.plan.md](chat-body-needs.plan.md) §2 is its second customer).

This is also why the axis is a **read and not the storage**. Storing energy signed would
fork the meter registry (`initial`/`baseline` are `min(0).max(1)`, `driftToward` clamps
`[0,1]`, the cue-intensity math assumes those bounds) for what is, in storage terms, a
coordinate change — and every reserve meter would then queue up to be forked the same way.
Reserve stays a legal 0–1 meter; the signed axis is what the narrator, the pips, and the
debug tools see.

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

| Class                | Shape                                     | Members (today → planned)                                        |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| **Reserve/appetite** | depletes → becomes a *need*               | `energy` → `satiation`, `hydration`, `desire`, social battery    |
| **Load**             | fills from sources → decays to a baseline | `arousal`, `intoxication`, `stress` → `bladder`, pain/soreness   |
| **Valence**          | an axis, not a resource; baseline-seeking | `mood`                                                           |
| **Rate**             | clock-keyed drain against a rhythm        | `hygiene`                                                        |
| **Phase**            | a cyclic driver that modulates others     | *(none yet)* → hormonal phase, circadian (derived, never stored) |

Two properties fall out and are worth stating as invariants:

- **Reserves are the push channel.** A load meter colors a scene; a reserve meter crossing
  a band creates a *want*, and wants are what the drives/initiative system already
  consumes. This is the difference between pips and a living world, and it is why
  satiation/hydration/bladder belong with a needs→initiative slice rather than as three
  more numbers.
- **Phase meters modulate baselines, never values.** The precedent exists —
  `personalizeMeters` shifts arousal's resting point by libido. A cycle is the same seam on
  a clock.

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
- **`merge/phases/meters.ts` — take the pattern, not the code.** It already did what chat
  should: `perHour` over *real* elapsed minutes, plus action `meterEffects`, plus a
  condition→mood-baseline shift. The file went with the session lane in R6, and its unused
  contract half (`conditionMoodBaselineShift` + `CONDITION_MOOD_BASELINE_SHIFTS`) was deleted
  2026-08-07 — so condition→mood-baseline is now **unbuilt**, not merely unwired. If this
  plan's drift rewrite wants it, it writes it fresh against the condition catalog.
- **The plan's Constraint #1 is void.** "`meterDefinitions` is shared with the session lane
  … do **not** fix chat by inflating `perHour`" was the reason for the exchange-keyed drift
  table. There is no parity left to protect, so rates get honest values in the registry —
  the one table where a rate per story hour has always belonged.
- **`rhythmOutfitPatch` is the precedent in shape, not in mechanics.** "A schedule row
  covering the skipped-to clock re-dresses the character" is already shipped and motivates
  rhythm self-care — but verification (world-engine-refactor.claude.md §5.2, 2026-07-16)
  showed the shipped function is **arrival-covering**: it takes a single `clockMinutes`,
  asks which row *covers* that minute, and overwrites — no `fromMinutes`, no window, no
  crossing check. The planned `rhythmBodyPatch` is **window-crossing** (every row the skip
  passed through fires). They are different functions; calling one the other's sibling
  understates the work. Copy the integration seam, write the crossing logic new.

## Latent bugs found while speccing

Not this plan's scope; recorded so they are not rediscovered. Each is small.

- **Condition→mood-baseline does not exist.** `driftChatState` drifts to personalized
  baselines with no condition input, and the helper that would have supplied one was deleted
  as dead code (2026-08-07). If this plan's drift rewrite wants conditions to move the mood
  baseline, that is new work, not a wiring task.
- **The fluster chip's label misses every `flustered` key** — `chat-state.ts:3307` mints
  `label: "Flushed"` → `conditionKey` = `"flushed"`. This still bites **live** code:
  `mood/projection.ts` `FLUSTERED_CONDITION_LABELS` keys `flustered`/`bashful`, so
  `deriveEmotionLabel` never reads the chip's own condition as flustered. Fix the key or the
  label; whichever, keep them in one vocabulary.
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
