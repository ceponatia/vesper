# Chat meter economy — spec

Status: companion to [chat-meter-economy.plan.md](chat-meter-economy.plan.md)

Read the plan first for the goal and the slices. This spec records the owner's rulings on
OQ1–OQ3 (2026-07-16), the meter taxonomy they imply, the tuning tables, and what the
successor engine already ships that a chat-lane port can reuse.

The one-line frame: **a meter is physiological substrate on the story clock; the narrator
never sees a meter, only a derived, perception-gated read of one.**

This file is a **living reference, not a chat-lane-only design note.** The successor
engine's Gate 5 (`engine.spec` §25, ruling 15) names it the normative semantics source for
its body meters, and `src/contracts/simulation/bodies.ts` and
`src/lib/simulation/body-reads.ts` cite its sections in code comments. Section headings
here are load-bearing — rename them and those citations rot.

## The law: substrate vs. read

The load-bearing ruling, generalized from OQ2. Two layers, never conflated:

- **Substrate** — the stored 0–1 scalar. It models a *body fact* (sleep reserve, arousal,
  freshness) and moves only through drift and sources. It is never prose, never an
  instruction, and never band-specific.
- **Read** — a pure, total projection of substrate (+ context) into what a witness could
  actually perceive *this exchange*. Reads own all prose and every UI pip. They are gated
  on perceivability: exposure (the wardrobe resolver's coverage-computed exposed regions),
  frame (intimate vs. not), and proximity.

The chat lane already proves this pattern twice — `deriveMoodDescriptor` blends valence ×
stress × energy into a phrase, and `deriveEmotionLabel` is an explicitly "pure, **total**
projection". Mood is deliberately the meter with **no registry thresholds**
([../contracts/meters.md](../contracts/meters.md) §Mood). This spec makes
that the rule rather than the exception; the engine's `visibleBodySigns` registry is the
same law expressed as a closed vocabulary.

**What the law forbids**, and what the chat registry still violates:

| Chat registry hint today                                      | Verdict                                     |
| ------------------------------------------------------------- | ------------------------------------------- |
| hygiene "faint sweat and warm skin" *at close range*          | OK — body fact plus a perceivability gate   |
| energy "slower replies, longer blinks, yawns"                 | Illegal — behavior instruction; make a read |
| intoxication "warmer laughter, imprecise gestures"            | Illegal — behavior instruction; make a read |
| arousal "flushed skin, shallow breath, lingering eye contact" | Mixed — two body facts and one behavior     |

A read may still *describe* behavior ("she is fading") — the difference is that a read is
derived from context and gated on perceivability, while a threshold hint is an
unconditional directive stapled to a number.

## What the engine already ships

Gate 5 (E5.1–E5.2, shipped 2026-07-19/20) built this design for the successor lane. The
chat-lane port should treat these as the reference implementation and, where the units
allow, as importable code — `src/contracts` and `src/lib` are pure, so a chat-lane module
under `src/server/engine` may import either.

Built and running, engine-side:

- **Meter classes with a drift law per class** — `bodyMeterClassSchema`
  (`reserve` / `load` / `valence` / `rate` / `phase`) plus a per-meter `driftLaw` of
  `none`, `linear`, or `proportional_decay`, in `src/contracts/simulation/bodies.ts`. This
  is the taxonomy below, made mechanical.
- **The read seam** — `src/lib/simulation/body-reads.ts`: `deriveCircadianPressure`,
  `deriveDeficitRead` (the generalized signed shape), `deriveEnergyRead`,
  `deriveIntimacyRead`, `deriveVisibleBodySigns`, `resolveSleepWindow`.
- **Energy exactly as ruled in OQ1** — reserve on `proportional_decay` with
  `halfLifeSeconds: 39_925` (τ = 16h), linear sleep restore at +0.09/h capped at 0.95,
  and the signed saturating read over circadian pressure.
- **The OQ2 vocabulary** — `intimacyPhases`
  (`quiescent` / `kindled` / `flushed` / `wound_tight` / `cresting` / `afterglow`),
  `energyReadBands` (`bright` / `steady` / `winding_down` / `dragging` / `wrecked` /
  `collapsing`), and `visibleBodySigns` as a closed registry that deliberately omits
  contact-gated signs until the wear/exposure and consent layers can gate them.
- **The OQ3 rule** — `rhythmSelfCareEffects` credits a crossed `wash` rhythm row by setting
  hygiene to 0.95, with window-crossing integration and no blanket restore.
- **Climax, afterglow, exertion, and collapse** — `AFTERGLOW_DURATION_SECONDS`,
  `EXERTION_HYGIENE_FRACTION_FIXED_POINT`, `COLLAPSE_SLEEP_SECONDS`, and a collapse alarm
  solved analytically rather than ticked.

Deliberately **not** shared, and therefore still chat-lane work:

- **Units.** The engine stores meters as integers in 1/10 000 units and runs on story
  *seconds*; the chat lane stores floats and counts story *minutes*. Every reused read
  needs a conversion at the boundary.
- **The retuned rate table below.** The engine's registry kept the chat lane's stress,
  intoxication, and mood rates verbatim and chose its own hygiene (0.015/h) and arousal
  (0.20/h) values against its own band boundaries. **Neither lane runs the table below**,
  so a port must either adopt it, adopt the engine's, or state why they differ.
- **Afterglow duration.** This plan specifies 90 story-minutes; the engine ships 30
  (`AFTERGLOW_DURATION_SECONDS = 1_800`). Reconcile at port time.
- **Everything narrator-facing.** Prompt surfaces, status pips, and the chat pulse schema
  are lane-local by construction.

Plan OQ4 owns the reuse-versus-twin decision.

## The retuned rate table

One table, one meaning. These are the chat lane's `meters/registry.ts` rates, per story
hour, restated as a rate rather than a per-exchange nudge.

| Meter        | Rate today → retuned | What that buys                                  |
| ------------ | -------------------- | ----------------------------------------------- |
| hygiene      | −0.04 → **−0.03**    | lived-in ~13h after a shower; unwashed ~22h     |
| arousal      | −0.10 → **−0.30**    | a peak cools below flushed in ~1.5h             |
| stress       | −0.03 → **−0.10**    | off-edge in ~4h, calm in ~10h (was ~33h)        |
| intoxication | −0.12 (keep)         | one drink clears in ~2.5h — already right       |
| mood         | 0.06 → **0.10**      | an even keel returns over an evening, not a day |
| energy       | proportional         | the one meter on the exponential law, τ = 16h   |

Sanity check on a 100-exchange visit (= 100 story-minutes): hygiene −0.05, energy −0.01,
arousal −0.50, stress −0.17, mood +0.17.

**On arousal's rate**: −0.30/h is a deliberate compromise. The physiologically honest value
is nearer −0.50/h (acute arousal subsides in 10–30 minutes), but arousal is currently doing
double duty as the scene's *persistent charge*. −0.50 lands once a `desire` appetite meter
exists to hold that charge — see §Ruling OQ2.

## Migration

One additive column on `character_chat_state`: `meters_at_minutes`, `integer not null
default 0`. **The next free number is 0104** — the tree currently runs to `0103`. (The
number cited in earlier drafts of this topic, 0052, was taken by the persona library's
`player_state` / `default_persona_id` migration on 2026-07-16.)

One column, additive, so `db:generate` cannot hit the create-vs-rename prompt. Default 0
would make the first read of every existing row drift its entire history at once, so the
migration **must backfill from `character_chats.clock_minutes`** by hand before
`pnpm db:migrate`; the catch-up cap (7 story days) is belt-and-braces, not the fix.
`awake_since_minutes` is deliberately **not** a second column — see the ruling below.

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
  (the second wind), plus a brief post-waking bump (sleep inertia). Absent rows ⇒ a
  23:00–07:00 default.
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

The verified arc for a 7am wake / 11pm bedtime. Every number is emergent from τ and the
pressure curve; the engine's E5.2 slice 1 reproduces this table.

| Moment             | reserve − pressure | read  | Reads as        |
| ------------------ | ------------------ | ----- | --------------- |
| 11am (4h awake)    | 0.74 − 0.05        | +0.69 | bright          |
| 3pm (8h)           | 0.58 − 0.15        | +0.43 | afternoon dip   |
| 9pm (14h)          | 0.40 − 0.20        | +0.20 | winding down    |
| **11pm bed (16h)** | 0.35 − 0.35        | 0.00  | **the zero**    |
| 4am trough (21h)   | 0.26 − 1.05        | −0.79 | wrecked         |
| 8am next day (25h) | 0.20 − 0.55        | −0.35 | **second wind** |
| 11pm night 2 (40h) | 0.08 − 1.10        | −1.00 | the floor       |

The **nap case** the single axis could not answer: naps 2–6pm, so at her 11pm bedtime
reserve is ~0.70 against pressure 0.35 ⇒ read **+0.35**. She is past her bedtime and feels
it, but she has fuel — up, and a little wired.

τ is the tuning knob for the owner's "mentally tired by 5 or 6pm": at 11h awake the read is
+0.43, and lowering τ walks the whole evening arc down together.

**`reserve` decays proportionally, not linearly** — `reserve *= exp(−elapsed/τ)`, τ ≈ 16h.
This is a small registry extension (a `proportional` drift law beside the linear per-hour
one), and it earns it four times over:

- It is the biologically correct shape — Process S in the three-process model is exponential.
- It is **exactly composable**: `exp(−a)·exp(−b) = exp(−(a+b))`, so sixty 1-minute drifts
  equal one 60-minute drift by construction. The piecewise-curve version had a real
  path-dependence gotcha at band boundaries; this deletes it.
- **One knob (τ) replaces a five-row curve table.** The felt acceleration the owner
  originally described now comes from `pressure` rising through the night — which is where
  it actually comes from.
- **Sleep debt becomes free.** Restore is linear (+0.09/h, capped 0.95) onto a proportional
  tank, so the asymmetry *is* the debt mechanic:

| Sleep taken                     | Reserve after | Reads as                                 |
| ------------------------------- | ------------- | ---------------------------------------- |
| 8h from a normal bedtime (0.35) | **0.95**      | a full night fully refills               |
| 4h from a normal bedtime (0.35) | **0.71**      | a short night starts the day short       |
| 8h after a 40h bender (0.08)    | **0.80**      | one night does not clear a real debt     |
| 12h from 0.35                   | **0.95**      | oversleeping doesn't stack — the +1 pole |
| a 90-minute nap from 0.60       | **0.73**      | a nap is a top-up, no threshold needed   |

**Two things this deletes.** `awakeSinceMinutes` is unnecessary — a proportional rate does
not need to know hours awake, so **the reserve value *is* the debt ledger**, and the
migration drops to one column. And a minimum-sleep constant ("a nap is not a night") is
unnecessary — a 90-minute nap simply restores +0.135 because it is short. Both were
scaffolding for the piecewise model.

The energy read owns the vocabulary, so energy **joins mood** as a meter with no registry
thresholds. Sleep stays one concept with two sources — a rhythm `sleep` window a skip
crossed, and an `asleep` condition (how a collapse is stored) — unified by one pure
minutes-slept helper, so a collapse needs no bespoke wake path: the existing self-expiring
condition machinery already does the timing. Per the owner, waking carries **no debuffs**
for now; the energy-condition family (`groggy`, `wired`, `microsleeps`) gates on the read's
sign and is named in the plan's Later section.

### The generalization: deficit reads

The signed-with-a-meaningful-zero shape is **not energy-specific** — it belongs to the read
seam, and every reserve meter wants it. Hunger's zero is "when she'd normally eat"; thirst,
`desire`, and social battery all have an act-point. A **deficit read** is therefore the
reusable shape: signed, zero at the character's own act-point, negative meaning overdue,
both poles saturating. One seam serves all of them
([chat-body-needs.plan.md](chat-body-needs.plan.md) §2 is its second customer). The engine
shipped exactly this generalization as `deriveDeficitRead`.

This is also why the axis is a **read and not the storage**. Storing energy signed would
fork the meter registry (`initial`/`baseline` are `min(0).max(1)`, drift clamps `[0,1]`,
and the cue-intensity math assumes those bounds) for what is, in storage terms, a
coordinate change — and every reserve meter would then queue up to be forked the same way.
Reserve stays a legal 0–1 meter; the signed axis is what the narrator, the pips, and the
debug tools see.

## Ruling OQ2 — arousal is a driver, not a talk-switch

The owner: arousal "was supposed to increase wetness, swelling, blood pressure, heart
rate, etc. which could then be represented in narration or trigger other processes. It
wasn't supposed to be 'this character is now fully aroused so change the way they talk'."

The chat lane still does exactly the objectionable thing, in two places: one behavioral
threshold hint on arousal, and `stateDispositionOverlays`, which spends arousal (at 0.3 of
intoxication's weight) lowering `intimate.inhibition`, `social.guardedness`, **and**
`temperament.composure`.

Ruled — three moves, in the substrate/read shape:

- **Regrade the bands to body facts.** One behavioral hint becomes a graded physiological
  vocabulary (`kindled` / `flushed` / `wound-tight` / `cresting`) naming what the body is
  doing — pulse, breath, skin, focus — with no directive about diction.
- **Add perception-gated signs.** Signs resolve against the wardrobe resolver's
  coverage-computed exposure and the frame: flush and breath read at conversational range;
  swelling and wetness are gated on an intimate frame **and** exposure or contact, and bind
  to the body model rather than being assumed. This is the answer to "represented in
  narration": narration gets *facts a witness could perceive*, not a mood instruction.
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
The full triggered-response generalization is parked in
[deferred/physiology.plan.md](deferred/physiology.plan.md). `intercourse` as an interaction
concept stays unnecessary for meters — the intimacy read covers them — and remains a
registry data edit for the day a preference card needs to like or dislike the act itself
rather than the ask.

## Ruling OQ3 — no blanket self-care; the rhythm is the circumstance

The owner: the overnight reset "isn't really correct anyway *unless* the character is not
being narrated… when they go to sleep, their energy refills (based on how long they slept)
but they still need to take a shower, eat, etc."

A blanket `hygiene = max(current, 0.9)` on big skips is **cut**. But the naive opposite —
skips grant only sleep, hygiene drains on the clock — puts a character at hygiene 0 after
any multi-day skip, which is worse. The resolution collapses the owner's narrated /
unnarrated distinction into something cleaner:

**Off-screen self-care is a rhythm event, not a skip rule.** Whether twelve skipped hours
mean recovery or deterioration is circumstance, and the circumstance turns out to be
**already authored**: the character's daily rhythm. A skip credits only the rhythm slots it
actually crossed, at the clock minute they sit on. So:

- An `overnight` skip landing at **8am**, past a 7am `wash` row → she slept *and* showered.
- The same skip landing at **6am**, before it → she slept and has **not** showered, and
  that need stands in the scene for the fiction to play. This is precisely the owner's
  "they still need to take a shower."
- Drain resumes from the last crossed slot, so the tail is always a real, playable need
  rather than a blanket reset or a filthy character.

This makes the present/away branch unnecessary: the rhythm is the character's *own life*,
not an assumption a narrator has to license, so it applies to everyone. What differs is
only that a narrated character's unmet needs are visible.

The escape hatch the owner's note leaned toward is kept as a named seam, not built: an
active condition (a "trapped / rough night") suppressing rhythm self-care. Deferred until a
real scene hits it.

## The meter taxonomy

The classes the six existing meters and the PM-notes meters fall into. A class fixes a
meter's drift shape, its sources, and how it reaches behavior. The engine encodes this
directly as `bodyMeterClassSchema` plus a per-class drift law.

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

## Chat-lane groundwork this plan inherits

The world model is gone — rollout R6 (2026-07-22) deleted the session lane's code and
tables outright — so the "take the world model's systems rather than parallel them" plan
recorded here in 2026-07-16 no longer describes anything that exists. What is left:

- **There is no action registry to adopt.** `src/contracts/actions/registry.ts` — the pure
  registry of `shower` / `nap` / `meal` / `snack` / `workout` / `groom` with minutes and
  meter effects — was deleted with the session lane. The chat lane's four hardcoded chips
  are now the *only* action vocabulary in the app, and giving them minutes and data-driven
  effects is net-new work owned by [chat-body-needs.plan.md](chat-body-needs.plan.md) §1.
  The engine's `bodySourceKinds` and `rhythmSelfCareEffects` are the nearest surviving
  model.
- **There is no merge-phase meter pass to copy.** `engine/merge/phases/meters.ts` is gone.
  The pattern it demonstrated — per-hour rates over *real* elapsed minutes — now lives, far
  better developed, in the engine's piecewise integration.
- **`scheduleEntryAt` is already chat-local.** It survived the deletion as a *private*
  function inside `chat-state.ts`, used by the shipped rhythm auto-dress. Lifting it into
  contracts beside the schedule schema is an export-and-move, not a cross-lane migration.
- **The rhythm outfit patch is the precedent in shape, not in mechanics.** "A schedule row
  covering the skipped-to clock re-dresses the character" is shipped and motivates rhythm
  self-care — but that function is **arrival-covering**: it takes a single clock minute,
  asks which row *covers* it, and overwrites. Rhythm self-care is **window-crossing**
  (every row the skip passed through fires). They are different functions; copy the
  integration seam, write the crossing logic new. The engine's window-crossing integration
  is the worked example.

## Latent bugs found while speccing

Not this plan's scope; recorded so they are not rediscovered. Each is small, and all were
re-verified against the tree on 2026-08-07.

- **Condition→mood-baseline does not exist.** `driftChatState` drifts to personalized
  baselines with no condition input, and `conditionMoodBaselineShift` — the helper that
  would have supplied one — was deleted as dead code on 2026-08-07. If this plan's drift
  rewrite wants conditions to move the mood baseline, that is net-new work, not a wiring
  task.
- **The fluster chip's label misses every `flustered` key.** The chip mints the condition
  label "Flushed" (`chat-state.ts:3307`), which normalizes to `flushed`. This still bites
  **live** code: `mood/projection.ts` keys `FLUSTERED_CONDITION_LABELS` as
  `flustered`/`bashful`, so `deriveEmotionLabel` never reads the chip's own condition as
  flustered. Fix the key or the label; whichever, keep them in one vocabulary.
- **An away primary desynchronizes on skip**: `time-skip/route.ts:139` skips members whose
  presence is not `present`, so an away primary's state is never advanced while the shared
  clock is, and the route returns the un-skipped snapshot. Lazy clock-keyed catch-up
  removes the branch that causes it.
- **The skip route commits the scenario before the member loop**, so a mid-loop failure
  leaves the clock advanced with members un-skipped. Also healed by lazy drift — members
  catch up on next read regardless.
- **`docs/contracts/conditions.md` contradicts the code**: it says a condition `id` is "a
  random `newId()`, never semantic", but `chat-state.ts:3307` mints `id: "flushed"`
  deliberately, because the upsert dedupes on `id`. The afterglow condition will follow the
  code; the doc needs the correction.
