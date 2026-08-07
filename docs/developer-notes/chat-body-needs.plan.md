# Chat body needs — satiation, hydration, and needs that push

Status: **draft** (planned 2026-07-16 from the owner's PM notes on
[chat-meter-economy.plan.md](chat-meter-economy.plan.md): "Eating is another facet we
haven't touched yet… Hydration would work similarly… Bathroom use is another simulation
I'd like to incorporate… What other meters can you think of that would help create a
hyper realistic living world?")

Outcome: A player can watch a character get hungry, thirsty, or need a moment to
herself and *do something about it* — suggest food, excuse herself — instead of a pip
changing colour while she talks as though nothing were happening.

Sequenced **after** [chat-meter-economy.plan.md](chat-meter-economy.plan.md), which is its
load-bearing dependency: this plan is the second use of that plan's clock-keyed drift,
rhythm `kind`s, derived-read seam, and reserve-meter shape. Building it first would mean
inventing all four badly. The taxonomy and the substrate/read law it leans on are in
[chat-meter-economy.spec.md](chat-meter-economy.spec.md).

## Goal

Three new meters the owner asked for — **satiation**, **hydration**, **bladder** — plus the
thing that makes them worth having: a **needs → behavior** channel, so a hungry character
*wants something* instead of merely displaying a pip. Along the way, collapse the
chip/action fork that currently blocks any of them from having a source.

## Why this is one plan and not three meters

Two structural facts, both from the meter-economy spec:

- **Reserves are the push channel.** A load meter (arousal, intoxication) colors a scene.
  A reserve meter crossing a band creates a *want* — and wants are exactly what the drives
  and initiative systems already consume. Three more numbers with pips and no push would be
  simulation theater; the channel is the point.
- **Nothing can feed them yet.** The session lane's `contracts/actions/registry.ts` already
  holds the vocabulary — `meal` (30 min), `snack` (10), `shower` (20, `hygiene set 0.95`),
  `nap` (90, `energy +0.3`), `workout`, `groom`, `bathe` — and `meal`/`snack` carry **no
  `meterEffects` at all**, purely because no satiation meter exists. The registry has been
  waiting for this plan. Meanwhile the chat lane forked it into four hardcoded chips with
  instant deltas and no minutes.

## Design

### 1. Collapse the action fork

Chat's four chips (`drink`/`freshen`/`rest`/`fluster`) and the session's seven registered
actions are fully parallel, non-shared vocabularies for the same idea. The world model is
deprecated, so the registry gets taken rather than paralleled:

- `actions/registry.ts` becomes **the** action vocabulary for both lanes. It is already a
  pure contract registry with the right shape (`id`, `label`, `minutes`, `aliases`,
  `meterEffects`, `requiredTier`).
- A chip becomes a **registry row with a presentation flag** (`chip?: { label, hint }`) —
  `CHAT_ACTIONS` in `chat-pulse.ts` stops being a second hardcoded list, and
  `applyChatAction`'s hand-written switch collapses into applying `meterEffects`.
- **Chips gain `minutes`.** Today a chip costs zero story time, which was harmless when
  meters were exchange-keyed and is wrong now that they are clock-keyed: a shower that takes
  0 minutes but sets hygiene to 0.95 is a free lunch. `freshen` → `shower`'s 20 minutes.
- `fluster` is the one chip with no session analogue — it stays chat-only, a registry row
  with an empty `aliases` list.
- **Do not** port `matchActions` free-text alias matching to chat in this slice; chat's
  intent read is the pulse's job. The aliases ride along unused, as they do today.

### 2. Satiation

**Reserve meter**, clock-keyed, seeded ~0.8.

- **Drain**: linear, ~`−0.045/h` (a meal at 0.9 → hungry in ~11h). Unlike energy this needs
  no proportional law — hunger is close enough to linear over a day, and the *felt* timing
  comes from the read, not the rate.
- **Sources**: `meal` (`satiation set 0.9`), `snack` (`+0.25`). The registry rows exist and
  are empty; this slice fills them.
- **The read is a deficit read, and this is the whole trick.** The owner: "an npc might have
  a lifestyle where they don't sit down and eat lunch and dinner at set times but they know
  when they're hungry (and it's roughly the same time every day)." That is precisely the
  meter-economy plan's energy shape with `meal` rhythm rows swapped in for `sleep` rows:
  `read = clamp(−1, +1, satiation − pressure)`, zero at *her* usual mealtime, negative =
  overdue, both poles saturating (+1 stuffed, −1 ravenous — and it stops there rather than
  sliding forever).
- **Generalize the pressure**, don't copy it: `deriveRhythmPressure(profile, kind, clock)`
  serves `sleep` and `meal` from one function, and `desire`/social battery after it. If this
  plan writes a second circadian curve by hand, that is the bug.
- **Off-screen meals ride `rhythmBodyPatch`** — a crossed `meal` row feeds her, on the same
  crossed-slot rule as washing. "All npcs should eat at least twice a day" is therefore an
  *authoring* invariant, not an engine rule: a schedule with fewer than two `meal` rows
  makes a character who is always hungry. Worth a forge check (§5).
- **Tags shape the rhythm, not the meter.** The owner's `doesn't-eat-breakfast` is a
  disposition tag (`contracts/personality/tags.ts` — a real 17-row registry) that suppresses
  the morning mealtime *pressure*, so she is fine without breakfast and hungrier by noon. The
  meter is untouched; only the read changes. This is the substrate/read law paying rent.

### 3. Hydration

Same reserve shape as satiation, tuned to the owner's note ("its effects are more
noticeable… people notice they're thirsty pretty quickly even when they can go quite a
while without eating"):

- **Drain** ~`−0.09/h` — twice satiation's rate, so thirst arrives in ~5h.
- **Sources**: the `drink` chip (which today only raises intoxication — it should hydrate
  too, and a non-alcoholic variant is the obvious second row), plus `meal`.
- **Couplings**: low hydration raises `stress` slightly and feeds the headache/`groggy`
  condition family; **arousal and exertion drain it faster** — the concrete cash-out of the
  meter-economy spec's "arousal → heart rate → hydration" note.
- No circadian read — thirst is not scheduled. Reserve + rate is enough.

### 4. Bladder — and the needs → behavior channel

**Load meter** (fills, unlike the reserves), and the one that forces the channel to exist:
a full bladder that only shows a pip is worse than no bladder at all.

- **Fills** from intake, not time: the `drink` chip and `meal` add to it (the owner: "drinking
  a lot makes them have to pee"), and alcohol adds disproportionately.
- **Empties** on a `restroom` action (new registry row, 5 min) and on `rhythmBodyPatch`'s
  crossed slots.
- **The channel**: a **deficit read going negative** emits a **need** — a small, derived,
  never-stored `{ kind, urgency, want }` from the same read seam, where `urgency` is just
  the read's magnitude below zero. This is why the signed shape is worth generalizing: the
  sign *is* the gate, so "she is overdue for X" needs no per-meter threshold table. Needs
  feed the *existing* consumers rather than a new system:
  - the **initiative cue** (`buildInitiativeCue`), which already assembles plans / open loops
    / wants / rhythm — a need is one more want, and this is how "she excuses herself" or "she
    suggests getting food" happens without a bespoke path;
  - the **narrator tail**, as a standing read (never a directive — the law holds);
  - the **pulse**, as context, so a need she just resolved stops being raised.
- **Urgency gates the interrupt.** A mild need is texture; a severe one earns a beat. The
  cap is the point — the failure mode here is a character who talks about nothing but her
  body. One need surfaces at a time, most-urgent-wins, mirroring the anti-repetition
  `splitStateCues` foreground/standing split rather than inventing a second gate.

### 5. Authoring

Three meters' worth of rhythm only works if characters *have* rhythms. Today `profile.schedule`
is optional prose and the forge fills it loosely.

- The character forge's rhythm leg should draft `sleep` + ≥2 `meal` + a `wash` row with
  structured `kind`s (the meter-economy plan adds the field).
- A **schedule sanity check** in the editor, warn-not-block like the major-tier cast cap:
  no sleep row, or fewer than two meal rows, makes a character the body systems will read as
  permanently deprived.
- Sensible defaults for un-authored characters — the meter-economy plan's 23:00–07:00 sleep
  fallback, plus ~08:00/13:00/19:00 meals — so an old character is plausible, not starving.

## What other meters (the owner's question, answered as a shape)

The taxonomy answers "what else" better than a list does — a meter earns its place by being
**substrate something else reads**, not by being simulable. Ranked by romance-lane value:

- **`desire`** *(reserve/appetite)* — the strongest candidate, and already named in the
  meter-economy spec. Days without intimacy raise the arousal *baseline* (the
  `personalizeMeters` seam already does exactly this for libido) and feed initiative. It is
  what lets arousal's rate go physiologically honest, and it is the most on-brand meter in
  this document.
- **Social battery** *(reserve)* — time in company drains it for a guarded/introverted
  character (`social.guardedness` already exists as the trait). Explains why someone wants to
  leave, which the ensemble lane badly needs and currently has no honest reason for.
- **Warmth/temperature** *(load, environmental)* — cheap, high romance value, and the gate is
  **already built**: `resolveChatWardrobe`'s coverage-computed exposure knows what she is
  wearing. Cold hands, huddling, a borrowed jacket.
- **Hormonal phase** *(phase)* — the "hyper realistic" ask, and the taxonomy's only phase
  meter: a slow cycle modulating libido/mood baselines and pain. Baselines, never values —
  the `conditionMoodBaselineShift` seam is the precedent. Real product-judgment call before
  building; parked here deliberately.
- **Soreness/pain** *(load)* — after intimacy, workouts, injury. Probably **conditions, not a
  meter** (the catalog already exists) unless something needs to read a gradient.
- **Caffeine** *(load)* — masks low energy then crashes; pairs with intoxication and the
  `drink` chip. Fun, cheap, low priority.

Deliberately **rejected**: grooming-as-a-meter (hair/makeup are conditions + wardrobe, not a
gradient) and hangover-as-a-meter (a consequence condition of intoxication, which is what
conditions are for).

## Open questions

- **OQ-A — does bladder survive contact with play?** It is the most simulationist meter here
  and the easiest to make tedious. Build it last, behind the needs channel, and be willing to
  cut it. A romance scene interrupted by a bathroom beat is either charming or fatal, and
  nobody knows which until it is played.
- **OQ-B — do needs interrupt, or only color?** §4 proposes urgency-gated interrupts through
  the initiative cue. The alternative (needs only ever color, never push) is safer and much
  less alive. Settle on the first playtest, not in this doc.
- **OQ-C — how much does a chip cost?** Giving chips `minutes` (§1) is right for the clock,
  but a `freshen` tap silently advancing 20 story-minutes may surprise a player mid-scene.
  Possibly the chip needs to say so in its hint.

## Files touched (sketch — settle when this leaves draft)

`src/contracts/actions/registry.ts` (chips as rows; fill `meal`/`snack` effects; add
`restroom`), `src/contracts/meters/registry.ts` (+3 meters), `src/contracts/meters/reads.ts`
(hunger/thirst/needs reads; generalize `deriveRhythmPressure`),
`src/contracts/personality/tags.ts` (rhythm-shaping tags), `src/contracts/turns/chat-pulse.ts`
(retire the hardcoded `CHAT_ACTIONS`), `src/server/engine/chat-state.ts` (`applyChatAction`
→ registry effects; `rhythmBodyPatch` meal/wash slots), `src/server/engine/chat-pipeline.ts`
(needs → `buildInitiativeCue`), `src/server/authoring/character-fill.ts` (rhythm leg),
`src/components/characters/chat-status.tsx` (need pips), docs:
`docs/contracts/meters-actions.md`, `docs/character-chat/state.md`,
`docs/character-chat/initiative.md`.
