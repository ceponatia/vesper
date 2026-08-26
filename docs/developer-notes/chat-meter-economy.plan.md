# Chat meter economy — the body on the story clock

Status: next — not started in the chat lane. The design is settled and **already
running in the successor engine** (Gate 5, shipped 2026-07-19/20, which cites this
topic's spec as its normative semantics source), so the remaining work is a port
into the character-chat lane rather than a fresh design.

Outcome: A player can see a character's body keep time with the story rather than with
the message count — she cools down after an intimate scene, feels it when it is past her
own bedtime, and comes back from an overnight skip washed only if her own routine says
she washed.

## Goal

Since the clock change (`chat-clock-calendar.plan.md`:
one exchange became one story minute, and skips became the primary time mover), the chat
lane's meter economy is visibly broken in three ways: **hygiene never decays**, **arousal
never resolves** after an intimate scene completes, and **skips carry no meter
consequences** even though skips are now how story time passes.

The cause is not mistuning. A drop of `−0.04` hygiene per story hour is already
physiologically right; the meter looks frozen because **drift is keyed to exchanges
instead of the clock** — a legacy of the old 4-minute tick — so a meter's pacing tracks
how much the player types rather than how much story time passed. Keying pacing to
exchanges makes "talking to her" the thing that dirties her.

Deliverable: **meters drift on the story clock at honest rates**, energy becomes a real
sleep model read as a **bidirectional axis** (positive = fuel in the tank, negative = past
wanting sleep, both poles saturating), arousal resolves after intimacy, and skips get their
consequences from the character's own authored routine rather than a flat rule.

## The economy as it stands

Drift applies four story-minutes of each meter's hourly rate per **exchange**, personalized
by the character's traits. Sources are the reaction pulse (arousal on intimate or courtship
concepts; mood and stress through the reaction curve) and the four action chips — offer a
drink, freshen up, take a breather, heat things up. **Skips contribute nothing.** Nothing
lowers hygiene but invisible drift; nothing raises energy but the chips.

What that costs the player, at today's rates:

| Meter        | What it takes to see a change            | Reads as       |
| ------------ | ---------------------------------------- | -------------- |
| hygiene      | ~131 exchanges from a shower to lived-in | never decays   |
| energy       | ~135 exchanges from rested to tired      | never decays   |
| arousal      | ~67 exchanges to cool from a peak        | never resolves |
| intoxication | ~37 exchanges to clear one drink         | roughly right  |

So the failure modes are structural: hygiene has no visible sink and no sources, arousal
has a strong source and no resolution, and skips move the clock without moving the body.

## What the successor engine already settled

Every ruling below was implemented engine-side during Gate 5 and is running in successor
chats today: clock-keyed drift with a drift law chosen per meter class, energy as a
reserve that decays proportionally and is restored by sleep, circadian pressure derived
from the character's own sleep window, the bidirectional energy read with its band
vocabulary, arousal regraded to a physiological phase vocabulary with perception-gated
signs, climax → afterglow, collapse as forced sleep, and window-crossing rhythm self-care
with no blanket restore.

That changes what this plan is. It is no longer "invent a meter economy" — it is **bring
the character-chat lane up to the behavior the successor lane already has**, reusing the
pure modules the engine build produced wherever they fit. The inventory of what exists and
what the chat lane must supply itself lives in
[chat-meter-economy.spec.md](chat-meter-economy.spec.md) §"What the engine already ships".

## Constraints

- **Resilience**: the new pulse read degrades to nothing — a missed detection costs one
  resolution beat, never a turn. The intimacy read's drift suppression keys on a
  **condition**, not on this exchange's pulse, so a single dropped pulse can never cool an
  active scene.
- **Personalization stays**: rates and baselines still resolve per character (libido
  shifts arousal's resting point; composure speeds stress recovery). The climax reset
  targets the **personalized** baseline, not zero.
- **Rollback safety**: every new field rides the stored chat-state snapshot, so all of
  this stays "another take"-safe.
- **This one needs a migration** — one additive integer column on the chat-state table,
  plus a hand-checked backfill so no existing row drifts its entire history on first read.
  Numbering and SQL are the spec's.

## Design

### 1. Drift moves to the story clock (the keystone)

Drift stops counting exchanges and starts counting **story minutes elapsed since this
character's meters were last moved**, capped so a long-abandoned chat cannot integrate a
year at once.

This is worth doing for pacing alone, but the reason it is the keystone is that **it
deletes three special cases**:

- **The "advance" flag goes.** Lazy drift is idempotent on read — nothing elapsed means
  nothing moves — so the read-only projection path and the exchange path become one call.
- **The away-freeze goes.** Freezing an off-screen character's body encoded a world-model
  assumption that off-screen bodies pause. They don't, and
  `chat-offscreen-life.plan.md` already
  ruled the cast keeps living. Away members simply catch up when next read. **Ruled: drift
  is presence-independent; presence gates narration, not physiology.**
- **Skips need no meter code at all.** A skip advances the clock; the next drift covers
  it. It also heals two latent bugs on the way — an away primary desyncing on skip, and
  the skip route committing the scenario before the member loop.

Rates get honest per-story-hour values in the registry, which is where a rate per story
hour always belonged. The retuned table and its band-crossing arithmetic are the spec's.
In player terms: a shower reads lived-in after about half a day rather than never; a peak
of arousal cools below the flushed band in about ninety minutes; an even keel returns over
an evening rather than a day; and a hundred-exchange visit — a hundred story minutes —
barely moves anything, because talking is not what dirties or exhausts anyone. **Skips do
the heavy lifting, which is what they are for.**

### 2. Energy: a bidirectional read over a reserve and the circadian

Energy cannot live on one 0–1 meter. Requiring the number to read "tired" twelve hours
after waking forces a drain that zeroes it at about a day — the opposite of "not truly
exhausted until over 24 hours". **Ruled 2026-07-16: energy is a signed read — positive is
fuel in the tank, negative is how far the body is past wanting sleep.** The two axes don't
compete; one subtracts from the other, because even a person with energy feels more tired
once they know it is past their normal bedtime.

- **The reserve** is the stored energy meter — fuel. It decays proportionally, so sixty
  one-minute drifts equal one sixty-minute drift exactly, and it is restored by sleep up
  to a cap short of full.
- **The pressure** is circadian, derived from the story clock against the character's own
  authored sleep window and never stored: low by day, a small afternoon dip, ramping into
  bedtime, peaking around the pre-dawn trough, **falling after it** (the second wind), plus
  a brief bump right after waking.

**Zero is a definition, not a threshold**: at her normal bedtime, pressure exactly equals
her remaining reserve — that is what bedtime means. A night owl's zero is 2am. No magic
number, no hardcoded hour anywhere. **Both poles saturate**, which is what makes them
useful to build on: the top means maximally rested, and sleeping longer does not stack; the
bottom means maximally sleep-demanding, and collapse hangs off *sitting at the floor* rather
than off an hour count — how long a character holds there is characterful, a trait seam.

Because the restore is linear onto a proportional tank, **sleep debt comes free**: a full
night from a normal bedtime refills her; a full night after a forty-hour bender does not,
so day two starts short. A nap is a top-up, with no threshold needed to say so. The verified
arc, the restore table, and the tuning constant are the spec's (§Ruling OQ1).

**Collapse** resolves through machinery that already exists: it mints a self-expiring
"asleep" condition, and the drift that crosses it restores the reserve. Per the owner,
**no debuffs on waking for now**; the energy-condition family is named under §Later.

Rather than hardcode a second exception where mood's pips live today, this slice adds the
shared **derived-read seam** that mood, energy, and the arousal signs all resolve through.

### 3. Arousal: resolution, and body facts instead of a talk-switch

Two problems, one slice. The concept vocabulary has the *ask* but nothing for the act or
its completion, and the pulse only classifies the **player's** act — completion usually
lands in the narrator's reply. And arousal currently reads as "she's aroused so she talks
different" rather than as physiology.

**The scene-level read** — no new concepts. The pulse gains one field answering "is this
exchange inside an active intimate scene, and did it complete?"

- **While the scene is active**: a short self-expiring "heated" condition stands, and
  ambient arousal drift is suppressed **while that condition stands**. Keying suppression
  on the condition rather than on this exchange's pulse is what makes a dropped pulse
  survivable — the scene holds, and the condition's expiry *is* the natural cooldown.
  Hygiene takes a small hit for the sweat.
- **On completion**: arousal drops to just above her personalized baseline — sated, not
  switched off, and always below the flushed band — and a self-expiring "afterglow"
  condition is minted. Stress falls, mood lifts, hygiene takes a larger hit. The intimate
  bump is skipped on that exchange; the reset wins.
- **Degradation**: no read means exactly today's behavior, and slice 1's faster ambient
  drift is the backstop — a missed completion cools in about ninety minutes of story time
  instead of sticking for fifty exchanges.

**The physiology half** — the substrate/read law applied. One behavioral threshold hint
becomes a graded physiological vocabulary naming what the body is doing, with no directive
about diction. Signs resolve through the read seam against what a witness could actually
perceive: flush and breath at conversational range; contact- and exposure-gated signs only
when the frame and the coverage model allow them. And disinhibition is **re-scoped, not
deleted**: arousal loosens what she will do, not who she is — being turned on does not
make her a different person or slur her words. Intoxication keeps the wider reach.

### 4. Skips: the rhythm is the circumstance

Per slice 1 the cooling half is already free — a skip advances the clock and the next
drift covers it. What remains is what a skip *implies*, and the owner's ruling cuts the
old blanket hygiene restore outright: the narrated character should be *shown* washing,
not silently reset.

But the naive opposite — skips grant only sleep — puts a character at filthy after any
multi-day skip. The resolution: **off-screen self-care is a rhythm event, not a skip
rule.** Whether twelve skipped hours mean recovery or deterioration is circumstance, and
the circumstance is **already authored** in her daily rhythm. A skip credits only the
rhythm slots the skipped window actually crossed, at the clock minute they sit on:

- An overnight skip landing at 8am, past a 7am wash row → she slept **and** showered.
- The same skip landing at 6am, before it → she slept and has **not** showered, and that
  need stands in the scene for the fiction to play.
- Drain resumes from the last crossed slot, so the tail is always a real, playable need —
  never a blanket reset, never a filthy character.

This makes the present/away branch unnecessary: the rhythm is the character's *own life*,
not a narrator's assumption, so it applies to everyone.

**Enabler — the one authored-schema change this plan needs.** A rhythm row's activity is
free-form prose today, so the routine is something the narrator reads and nothing else
can. It gains an optional structured kind (sleep, wash, meal, work, leisure) so already-
authored schedules light up. That field is shared with
[character-schema.plan.md](character-schema.plan.md) §2.1, which owns its authoring
surface; whichever plan moves first adds it.

### 5. Hygiene sources (small, rides slice 3)

Give the sink something to answer: an active intimate exchange costs a little hygiene, a
completed one costs more. Nothing else — no new detection surface. Exertion from a workout
waits for that action to reach the chat lane with
[chat-body-needs.plan.md](chat-body-needs.plan.md).

## Verification

- **Unit**: drift is idempotent on zero elapsed time, and sixty one-minute drifts equal one
  sixty-minute drift for **both** drift laws; a hundred-exchange visit barely moves hygiene;
  band crossings pinned to the spec's retuned table.
- **Unit, energy** — pin the whole arc, since every number in it is emergent and a tuning
  edit should have to restate its intent: the read is zero at her bedtime **for a character
  with a non-default sleep row too**; the pre-dawn trough is deep; the morning read is
  strictly **above** the trough (the second wind — the one behavior a naive monotonic model
  would lose); the floor arrives around forty hours; a napper reads positive at bedtime; and
  the four sleep restores from the spec's table.
- **Unit, the rest**: completion lands below the flushed band even for a high-libido
  profile; the heated condition suppresses drift **and survives a degraded pulse**; rhythm
  self-care credits a crossed wash row and not an uncrossed one; an away member's meters
  catch up on next read; a missing pulse read is byte-identical to today plus the mandated
  diagnostic.
- **Migration**: verify the backfill on a database branch first, not production.
- **Playtest on Fly** (deploy first — the UI-testing surface): one long flirt through
  intimacy to aftermath, watching the status pips; then an overnight skip, checking that
  hygiene is restored **only** if the landing crossed a wash row; then a multi-day skip,
  checking she is still not filthy.

## Later (named, not built)

- **Energy conditions** — groggy, wired, microsleeps at the floor. Waking carries no
  debuffs until these exist.
- **Condition-gated self-care suppression** — a "trapped / rough night" condition that
  suppresses rhythm self-care. The seam is named; deferred until a real scene hits it.
- **A desire meter** — the appetite meter that lets arousal's rate go physiologically
  honest. Graduates with [chat-body-needs.plan.md](chat-body-needs.plan.md).
- **Intercourse as an interaction concept** — unnecessary for meters; a registry data edit
  for the day a preference card must like or dislike the act itself rather than the ask.
- **Generalizing the triggered-response layer** — parked in
  `physiology.plan.md`, which builds on this plan's
  substrate/read law.

## Open questions

- **OQ4 — reuse the engine's pure read modules, or write chat-native twins?** The
  successor's circadian pressure, deficit read, energy read, intimacy read, and visible
  body signs are pure and importable, but they speak fixed-point units and story *seconds*
  while the chat lane speaks floats and story *minutes*. Reuse means an adapter at the
  boundary and one behavior for both lanes; a twin means two tunings that can drift apart.
  Settle before slice 2; the trade-off is laid out in
  [chat-meter-economy.spec.md](chat-meter-economy.spec.md) §"What the engine already ships".
