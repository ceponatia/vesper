# Chat body needs — satiation, hydration, and needs that push

Status: **draft** — nothing built. Planned 2026-07-16 from the owner's PM notes on
[chat-meter-economy.plan.md](chat-meter-economy.plan.md): "Eating is another facet we
haven't touched yet… Hydration would work similarly… Bathroom use is another simulation
I'd like to incorporate… What other meters can you think of that would help create a
hyper realistic living world?"

Outcome: A player can watch a character get hungry, thirsty, or need a moment to
herself and *do something about it* — suggest food, excuse herself — instead of a pip
changing colour while she talks as though nothing were happening.

Sequenced **after** [chat-meter-economy.plan.md](chat-meter-economy.plan.md), which is its
load-bearing dependency: this plan is the second use of that plan's clock-keyed drift,
typed rhythm kinds, derived-read seam, and reserve-meter shape. Building it first would mean
inventing all four badly. The taxonomy and the substrate/read law it leans on are in
[chat-meter-economy.spec.md](chat-meter-economy.spec.md).

## Goal

Three new meters the owner asked for — **satiation**, **hydration**, **bladder** — plus the
thing that makes them worth having: a **needs → behavior** channel, so a hungry character
*wants something* instead of merely displaying a pip. Along the way, give the chat lane's
action chips a real cost in story time, because without one no meter here can have an
honest source.

## Why this is one plan and not three meters

Two structural facts, both from the meter-economy spec:

- **Reserves are the push channel.** A load meter (arousal, intoxication) colors a scene.
  A reserve meter crossing a band creates a *want* — and wants are exactly what the drives
  and initiative systems already consume. Three more numbers with pips and no push would be
  simulation theater; the channel is the point.
- **Nothing can feed them, and there is no vocabulary left to borrow.** The chat lane's
  four hardcoded chips are the only action vocabulary in the app: the session lane's action
  registry — `meal`, `snack`, `shower`, `nap`, `workout`, `groom`, with durations and meter
  effects — was **deleted with the world model** in rollout R6 (2026-07-22). Earlier drafts
  of this plan proposed adopting it; there is nothing to adopt. The chips are the seed of
  the new vocabulary, not the fork of an old one.

## Design

### 1. Give the chips a registry, minutes, and data-driven effects

`applyChatAction` is a hand-written switch over four chip ids, each applying instant deltas
and costing zero story time. That was harmless when meters were exchange-keyed and is wrong
once they are clock-keyed: a shower that takes no time but sets hygiene to nearly clean is
a free lunch.

- Chips become **rows in a pure registry** with an id, a label, a chip hint, a duration in
  story minutes, and a list of meter effects. The hand-written switch collapses into
  applying the row's effects.
- **Chips gain minutes.** Freshening up costs the twenty story-minutes a shower takes.
- The registry is the extension point every later slice writes into: a meal row and a snack
  row for satiation, a non-alcoholic drink row for hydration, a restroom row for bladder.
- The successor engine's source vocabulary (`bodySourceKinds`: meal, drink, sleep credit,
  wash, exertion, climax, adjustment) is the nearest thing to a settled list. Align the
  chat ids with it where they mean the same thing, so the two lanes do not invent two
  spellings of "she ate".

### 2. Satiation

**Reserve meter**, clock-keyed, seeded around 0.8.

- **Drain**: linear, roughly −0.045 per story hour — a meal leaves her hungry in about
  eleven hours. Unlike energy this needs no proportional law; hunger is close enough to
  linear over a day, and the *felt* timing comes from the read, not the rate.
- **Sources**: a meal sets it near full, a snack tops it up.
- **The read is a deficit read, and this is the whole trick.** The owner: "an npc might have
  a lifestyle where they don't sit down and eat lunch and dinner at set times but they know
  when they're hungry (and it's roughly the same time every day)." That is precisely the
  meter-economy plan's energy shape with meal rhythm rows swapped in for sleep rows: zero at
  *her* usual mealtime, negative meaning overdue, both poles saturating — stuffed at one
  end, ravenous at the other, and it stops there rather than sliding forever. The successor
  engine already ships this shape as a general signed read, so the chat lane should reuse
  or mirror it rather than write a third one.
- **Generalize the pressure**, don't copy it: one rhythm-pressure function serves sleep and
  meals, and desire or a social battery after them. If this plan writes a second circadian
  curve by hand, that is the bug.
- **Off-screen meals ride rhythm self-care** — a crossed meal row feeds her, on the same
  crossed-slot rule as washing. "All NPCs should eat at least twice a day" is therefore an
  *authoring* invariant, not an engine rule: a schedule with fewer than two meal rows makes
  a character who is always hungry. Worth a forge check (§5).
- **Tags shape the rhythm, not the meter.** The owner's "doesn't eat breakfast" is a
  disposition tag — `contracts/personality/tags.ts` is a real 17-row registry — that
  suppresses the morning mealtime *pressure*, so she is fine without breakfast and hungrier
  by noon. The meter is untouched; only the read changes. This is the substrate/read law
  paying rent.

### 3. Hydration

Same reserve shape as satiation, tuned to the owner's note ("its effects are more
noticeable… people notice they're thirsty pretty quickly even when they can go quite a
while without eating"):

- **Drain** around −0.09 per story hour — twice satiation's rate, so thirst arrives in about
  five hours.
- **Sources**: the drink chip, which today only raises intoxication and should hydrate too
  (a non-alcoholic row is the obvious second entry), plus meals.
- **Couplings**: low hydration raises stress slightly and feeds the headache and grogginess
  condition family; **arousal and exertion drain it faster** — the concrete cash-out of the
  meter-economy spec's "arousal → heart rate → hydration" note.
- No circadian read — thirst is not scheduled. Reserve plus rate is enough.

### 4. Bladder — and the needs → behavior channel

**Load meter** (fills, unlike the reserves), and the one that forces the channel to exist:
a full bladder that only shows a pip is worse than no bladder at all.

- **Fills** from intake, not time: the drink chip and meals add to it (the owner: "drinking
  a lot makes them have to pee"), and alcohol adds disproportionately.
- **Empties** on a restroom action and on the rhythm slots a skip crossed.
- **The channel**: a deficit read going negative emits a **need** — a small, derived, never
  stored bundle of what she needs, how urgently, and what she wants to do about it, where
  the urgency is just how far below zero the read sits. This is why the signed shape is
  worth generalizing: the sign *is* the gate, so "she is overdue for X" needs no per-meter
  threshold table. Needs feed the *existing* consumers rather than a new system:
  - the **initiative cue**, which already assembles plans, open loops, wants and rhythm — a
    need is one more want, and this is how "she excuses herself" or "she suggests getting
    food" happens without a bespoke path;
  - the **narrator tail**, as a standing read, never a directive — the law holds;
  - the **pulse**, as context, so a need she just resolved stops being raised.
- **Urgency gates the interrupt.** A mild need is texture; a severe one earns a beat. The
  cap is the point — the failure mode here is a character who talks about nothing but her
  body. One need surfaces at a time, most urgent wins, mirroring the anti-repetition
  foreground/standing split the state cues already use rather than inventing a second gate.
- Nobody owns the initiative cue's budget today. That gap is named in
  [world-engine-refactor.plan.md](world-engine-refactor.plan.md) §6.3 and is the reason
  this slice adds a *ranking*, not just another producer.

### 5. Authoring

Three meters' worth of rhythm only works if characters *have* rhythms. Today a character's
schedule is optional prose and the forge fills it loosely.

- The character forge's rhythm leg should draft a sleep row, at least two meal rows, and a
  wash row with structured kinds. That field is added by
  [character-schema.plan.md](character-schema.plan.md) §2.1 or
  [chat-meter-economy.plan.md](chat-meter-economy.plan.md) §4, whichever moves first.
- A **schedule sanity check** in the editor, warn-not-block like the major-tier cast cap:
  no sleep row, or fewer than two meal rows, makes a character the body systems will read as
  permanently deprived.
- Sensible defaults for un-authored characters — the meter-economy plan's 23:00–07:00 sleep
  fallback, plus mealtimes around 08:00, 13:00 and 19:00 — so an old character is plausible,
  not starving.

## What other meters (the owner's question, answered as a shape)

The taxonomy answers "what else" better than a list does — a meter earns its place by being
**substrate something else reads**, not by being simulable. Ranked by romance-lane value:

- **`desire`** *(reserve/appetite)* — the strongest candidate, and already named in the
  meter-economy spec. Days without intimacy raise the arousal *baseline* (the
  personalization seam already does exactly this for libido) and feed initiative. It is
  what lets arousal's rate go physiologically honest, and it is the most on-brand meter in
  this document. The owner scheduled it in 2026-07-16; it still sits in no plan's slices.
- **Social battery** *(reserve)* — time in company drains it for a guarded or introverted
  character (the trait already exists). Explains why someone wants to leave, which the
  ensemble lane badly needs and currently has no honest reason for.
- **Warmth/temperature** *(load, environmental)* — cheap, high romance value, and both
  halves of the gate now exist: the wardrobe resolver's coverage-computed exposure knows
  what she is wearing, and the chat lane gained an authoritative environment (wind,
  precipitation, indoors) with the affordance work. Cold hands, huddling, a borrowed jacket.
- **Hormonal phase** *(phase)* — the "hyper realistic" ask, and the taxonomy's only phase
  meter: a slow cycle modulating libido and mood baselines and pain. Baselines, never
  values. A real product-judgment call before building; parked here deliberately.
- **Soreness/pain** *(load)* — after intimacy, workouts, injury. Probably **conditions, not
  a meter** (the catalog already exists) unless something needs to read a gradient.
- **Caffeine** *(load)* — masks low energy then crashes; pairs with intoxication and the
  drink chip. Fun, cheap, low priority.

Deliberately **rejected**: grooming as a meter (hair and makeup are conditions plus
wardrobe, not a gradient) and hangover as a meter (a consequence condition of intoxication,
which is what conditions are for).

## Open questions

- **OQ-A — does bladder survive contact with play?** It is the most simulationist meter here
  and the easiest to make tedious. Build it last, behind the needs channel, and be willing to
  cut it. A romance scene interrupted by a bathroom beat is either charming or fatal, and
  nobody knows which until it is played. The owner's 2026-07-16 ruling on realism gives the
  shape of the answer — allow *sway*, so a character doing something she finds important can
  hold off on eating or sleeping to a degree — but the beat itself still needs a playtest.
- **OQ-B — do needs interrupt, or only color?** §4 proposes urgency-gated interrupts through
  the initiative cue. The alternative (needs only ever color, never push) is safer and much
  less alive. Settle on the first playtest, not in this doc.
- **OQ-C — how much does a chip cost?** Giving chips minutes (§1) is right for the clock,
  but a freshen-up tap silently advancing twenty story-minutes may surprise a player
  mid-scene. Possibly the chip needs to say so in its hint.
- **OQ-D — do these meters land in the successor lane too, and who goes first?** The engine's
  body registry is six meters and its own comments say satiation, hydration, desire and
  bladder are "a data edit plus a bumped registry version" — cheaper there than here, and
  with the read seam already built. Whether the chat lane leads (the house rule) or follows
  the engine for this particular set is worth an explicit call before slice 2.
