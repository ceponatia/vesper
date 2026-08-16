# World engine refactor — a simulated world under the chat lane

Status: draft — an umbrella, never a build item. Written 2026-07-16 as a brainstorming
superset; **its architectural half was then built**, as the successor engine
([engine.plan.md](finished/engine/engine.plan.md), gates 0–6, closed 2026-07-21, rolled out 2026-07-22).
Re-audited against the tree 2026-08-07 and rewritten so the catalog says where each idea
actually lives. Nothing is committed *as* this doc; its remaining pieces promote out into
their own plans.

Outcome: A developer can tell, for any proposed world-simulation feature, whether it is
free to compute from the story clock or costs a model call on the turn, so that the next
ten features get scheduled by what they actually cost rather than by how appealing they
sound.

**What this doc is for, now that the engine exists.** It was written to answer "what could
a world under the chat lane be?", and the successor engine answered a large part of that
question by building it. Two things keep it alive:

- **It is the ledger of unowned ideas.** A dozen entries below are built in neither lane
  and sit in no plan. The catalog is where they stay findable, with an honest cost tag.
- **The two lanes are separate, and the legacy chat lane is still the live product for
  ordinary chats.** An idea being built engine-side does *not* make it available to a
  legacy chat. Each catalog entry therefore records both lanes.

The cost ladder in §2 and the thesis in §1 are the doc's actual contribution and are
unchanged by the engine's arrival.

---

## 1. The thesis: derive the world, remember the people

The old world model stored the world and needed a tick to move it. That tick never
shipped, and the session lane's movement problem ("characters couldn't move to locations in
a timely fashion, which broke the narrative") was the symptom of one choice: **the world was
state, so something had to advance it.**

The chat lane already has the escape. Its story clock plus a real-calendar anchor give an
authoritative story time. Anything that is a **pure function of (authored data, a seed, the
clock)** needs no storage, no tick, no job, and no agent — you compute it at read time, it
is consistent across skips, replayable, and free.

That covers far more of a "realistic living world" than it looks: weather, season, daylight
and sunset, ambient temperature, circadian pressure, hunger against her own mealtime, sleep
debt, age and birthdays, lunar phase, the tide, whether she'd normally be at work right now,
whether it's a holiday. None of that is state. All of it is a function of the clock.

What genuinely cannot be derived is **history**: what she actually did, who saw it, how she
felt about it, what she now believes. That is path-dependent state, and it is exactly what
the shipped machinery handles — facts, episodes, drives, plans, the meanwhile pass.

**So: derive the world, remember the people.** The world layer is code and costs nothing.
The model is spent only where meaning is required.

**The engine agreed and went further.** Its third decision is "there is no per-minute world
tick — a durable scheduler jumps between due triggers, integrates continuous rates
analytically, and records only material outcomes." That is this thesis with durability
added: derived where possible, and where state is unavoidable, advanced by solving for the
next material moment rather than by ticking to it.

### Corollary: lazy derivation keeps the no-wall-clock ruling reversible

The standing law is no wall clock in the fiction, and wall-clock absence is not a trigger.
A **stored, ticked** world welds that decision shut — you would have to backfill every tick
you didn't run — while a **derived** world leaves it open: flipping to real time later would
mean mapping elapsed real minutes into story minutes at one seam and changing nothing else.
That is not an argument to flip it. It is an argument that deriving costs us no options.

---

## 2. The cost ladder — the doc's organizing device

Every candidate below is tagged with the tier it lands in. The tier *is* the feasibility
argument.

| Tier   | Mechanism                                          | Cost per turn         |
| ------ | -------------------------------------------------- | --------------------- |
| **T0** | Pure derivation from authored data + seed + clock  | none                  |
| **T1** | Deterministic fold on a write that already happens | none                  |
| **T2** | One more field on an agent leg that already runs   | a few tokens          |
| **T3** | A new parallel leg in the post-reply settle        | +1 call, holds lock   |
| **T4** | A detached background job                          | +1 call, eventual     |
| **T5** | Anything before the reply                          | +1 call, on turn time |

The house rule already exists: cheap deterministic checks decide what runs, never an AI
call to decide whether to make an AI call, and nothing slow runs before the reply. **T5 is
closed.**

**T3 is not actually free, and this still matters.** The settle holds the per-chat exchange
lock; a slow settle surfaces to a fast-typing player as a busy error. The chat pulse,
extractor and personal-notes timeouts are **still at 60 seconds** — a deliberate, dated,
marked-REVERT diagnostic from 2026-07-15 to measure real model latency, and it has not been
reverted. Until it is, the lock can be held for a minute, so **any T3 proposal is blocked on
that measurement landing.** Budget T3 slots as scarce; prefer T2. **Reverting those three
constants is currently in no plan** — the nearest neighbour is
[chat-reply-latency.plan.md](chat-reply-latency.plan.md), which covers pre-reply latency and
not the settle's budget.

If a thing can be T0, it is a bug to make it T2.

---

## 3. Substrate as it stands

Terse, so the catalog doesn't re-invent it. Detail lives in the linked docs. Note which
lane each item belongs to — the legacy chat lane and the successor engine are separate
codebases with separate substrate.

**Legacy chat lane** — the live product for ordinary chats:

- **Clock** — story minutes plus a real-calendar anchor (real months, leap years,
  author-editable), one minute per exchange, four day parts as the one time vocabulary, and
  skips as the primary time mover.
- **Meters** — six (hygiene, energy, stress, arousal, intoxication, mood), all 0–1, one flat
  linear drift law, threshold hints and pip labels, traits coupled to baselines.
- **Rhythm** — a character's schedule: day-part rows, custom windows, weekday masks, plus
  the shipped rhythm auto-dress on skips. Rows carry free-form activity text and no kind.
- **Body** — a 48-node location tree, realized bodies, coverage sets stored exploded,
  exposed regions computed from worn items, and the affordance layer built on top of it
  (garment interaction, recognizable features, hair phenomena including wetness).
- **Environment** — wind, precipitation and an indoors flag, chat-wide, proposed by the
  continuity leg and committed deterministically. The lane's first authoritative weather
  owner, and narrator-sourced rather than derived.
- **Conditions** — free-label instances, self-expiring on the story clock, deduped on id.
- **Relationship** — familiarity (ratchets, never down) × regard (volatile); attraction
  reserved as an unbuilt third axis.
- **Mind** — drives with a secrecy and reveal band, plans with salience and deterministic
  missed-ness, open loops, a mind note, a feeling.
- **Off-screen** — the detached meanwhile job, the lane's world tick: a cumulative
  story-day gate, a small number of developments, a whereabouts phrase, and per-member fact
  routing so members know *different things*.
- **Perception** — exposed regions plus a sensory allowance and regex focus reads.
- **Agents** — pre-reply: none but regex and one embed. Settle: pulse in parallel with the
  memory, continuity and character legs. Detached: summary fold, scene sketch, meanwhile.

**Successor engine** — authoritative for successor chats, and where most of this doc's
catalog was actually built. Event-sourced and branch-scoped, with a durable scheduler,
zones and access, perception and observation, assertions/beliefs/gossip, a relationship
ledger with consent scopes, bodies and materials, households and means, and per-actor level
of detail. See [engine.spec.md](engine.spec.md)'s § index.

**Deleted, and no longer available to take** (rollout R6, 2026-07-22): the session lane's
action registry, its merge-phase meter pass, its exposure mask and witness matrix, its
atmosphere resolver, and the generic world-map graph layout. Several catalog entries below
were written assuming those could be adopted; they cannot.

**The load-bearing observation still holds:** the character's schedule is quietly the
world-sim spine. Six shipped or planned consumers key off it, and nearly every idea below
plugs into it. Its one missing field — a **typed kind** on a rhythm row (sleep, wash, meal,
work, leisure) — is the cheapest unlock in the entire corpus: it is a jsonb profile field,
so **no migration**, and it is owned by [character-schema.plan.md](character-schema.plan.md)
§2.1 and consumed by [chat-meter-economy.plan.md](chat-meter-economy.plan.md) §4. The engine
already runs typed rhythm rows; the authored side is what is missing.

---

## 4. Inherited law — what to respect, what has since been answered

**Respect, unchanged:**

1. **The substrate/read law** ([chat-meter-economy.spec.md](chat-meter-economy.spec.md)) —
   a meter is physiological substrate on the story clock; the narrator never sees a meter,
   only a derived, perception-gated read of one. Plus the taxonomy (reserve, load, valence,
   rate, phase) and its two invariants: **reserves are the push channel**; **phase modulates
   baselines, never values**. This remains the most valuable idea in the corpus, and the
   engine adopted it verbatim as the normative source for its body meters.
2. **The rhythm is the circumstance** — off-screen effects are credited from crossed rhythm
   slots, not from skip rules. Circumstance is *authored*, never assumed. The same move
   recurs everywhere and should keep recurring: "doesn't eat breakfast" is a disposition tag
   suppressing morning pressure, not a meter edit; "NPCs eat twice a day" is an authoring
   invariant, not an engine rule.
3. **The teamwork playbook** — deterministic gates decide; focused agents propose in
   parallel *after* the reply; plain code folds; slow work detaches; no AI call before the
   reply. With the standing correction that "agents propose, code disposes" is
   **aspirational for the legacy lane, not descriptive**: it holds for meters, plan
   missed-ness and selfies, but for wardrobe, presence, plans struck or kept, drives
   revealed, facts, scene and cast, the "deterministic fold" only *parses the narrator's
   prose* — the narrator is the de facto authority there, and a hallucinated secret reveal
   ratchets permanently. The successor engine is the answer to that gap and enforces the
   law properly; the legacy lane still doesn't.
4. **Authored canon is never machine-edited; evolution is bounded and rolls back.** The
   relationship matrix, authored traits and cast relations are read-only to agents.
   Overlays clamp to one band step. Everything rides the pre-exchange snapshots.

**Answered since:**

5. ~~"The world model is spoils, not a parallel."~~ **Void.** There are no spoils. The
   session lane's code and tables were deleted outright; anything it once offered must now
   be written new or borrowed from the engine.
6. **"No location model."** Answered by owner ruling (2026-07-16) and then built: locations
   came back in the successor lane, simpler — zones with access and privacy policies, and
   movement resolved by a scheduler rather than by making narration wait. §D below records
   what that means for the legacy lane, which still has no location model and should keep
   not having one.
7. **"Every meter is a character meter."** Answered by owner ruling (2026-07-16): the player
   gets a body. The persona library shipped the identity and wardrobe half — who the player
   is in this conversation and what they are wearing. Player *meters* remain unbuilt.

---

## 5. The catalog

Each entry carries its cost tier, its taxonomy shape, and — the part that matters now —
**where it stands in each lane**. "Unowned" means it is in neither lane and in no plan.

### §A — Physiology (the body)

- **A.1 · energy** — reserve on an exponential law minus circadian pressure, read
  bidirectionally. T1. **Engine: built** (Gate 5). **Chat: planned**
  ([chat-meter-economy.plan.md](chat-meter-economy.plan.md) §2). The template for every
  reserve below.
- **A.2 · satiation** — T1, reserve. **Unbuilt both lanes; planned**
  ([chat-body-needs.plan.md](chat-body-needs.plan.md) §2). Zero at *her* mealtime, not a
  global hour.
- **A.3 · hydration** — T1, reserve. **Unbuilt both; planned** (body-needs §3). Drains about
  twice as fast as satiation; arousal and exertion drain it faster.
- **A.4 · bladder** — T1, load. **Unbuilt both; planned** (body-needs §4), with an honest
  open question about whether it survives contact with a romance scene.
- **A.5 · desire** — days without intimacy raise the *arousal baseline* and feed initiative.
  T1, reserve. **Unbuilt both, owner-scheduled 2026-07-16, and still in no plan's slices** —
  the clearest unowned item in the corpus. It is the load-bearing unblocker: arousal's rate
  is knowingly wrong in both lanes purely because arousal is doing desire's job. **Promote
  it.**
- **A.6 · exertion / breath** — fast load. T1. **Engine: built as a coupling** (an exertion
  source costs energy and drains hygiene at half that rate). **Chat: unbuilt.** As a
  standalone meter with its own decay it is unbuilt everywhere — the engine models the
  *cost*, not the breathlessness.
- **A.7 · warmth / body temperature** — T1, load. **Unowned, and now cheaper than when this
  was written**: the exposure half was already built (coverage-computed exposed regions) and
  the environment half arrived with the chat lane's wind / precipitation / indoors state.
  Crossing bands mints shivering or overheated conditions. Still the best-value new meter in
  this doc.
- **A.8 · social battery** — T1, reserve. **Unowned.** Extraversion sets the time constant.
  Explains why someone wants to *leave*, which the ensemble lane needs and has no honest
  reason for.
- **A.9 · caffeine** — T1, load. **Unowned.** Suppresses circadian pressure without
  restoring reserve — it lies to the read, which is what caffeine does. Nearly free once A.1
  lands. Low priority.
- **A.10 · worn scent** — T1, load. **Unowned.** Distinct from hygiene; applied by an action
  or item, decays over hours, consumed by a sense-gated read.
- **A.11 · hair-wet / makeup** — T1, conditions rather than meters. **Partly built**: hair
  wetness is a real affordance phenomenon with bands and clumping behavior. Makeup
  degradation over time, crying, sweat and sex is **unowned** and remains high felt-realism
  per unit of effort.
- **A.12 · player body** — T1. **Half built.** The owner ruled yes; the persona library
  shipped the player's identity and worn state. Player *meters* — intoxication, energy,
  arousal — are unbuilt, and the middle path still stands: the sim tracks only what the
  player *did* and never contradicts them.
- **A.13 · illness with a course** — T1, condition. **Unowned**, and still a genuinely good
  pure-code sim: risk derived from sleep debt, stress, hydration, cold exposure and season;
  a **seeded** roll at a skip crossing (seed from the chat and clock ⇒ deterministic and
  replayable) mints an unwell condition with a multi-day course. She gets sick *because*
  she's been running on four hours' sleep in the rain. Zero calls.
- **A.14 · injury / soreness** — T1, condition with a healing course on the clock.
  **Unowned.** Conditions, not a meter.
- **A.15 · hormonal phase** — T2, phase. **Deliberately parked** as a product-judgment call.
  Modulates baselines, never values. Same bucket: fertility, pregnancy arcs. Needs an owner
  ruling before design, not after.

**Rejected as over-modeling:** blood sugar (folds into satiation), grooming and hangover as
meters (conditions and attributes cover them), garment-level laundry state (a whole second
wear economy for a detail prose handles).

### §B — Environment (the world's body)

**Still the biggest genuine gap for the legacy chat lane, explicitly asked for, and almost
entirely T0.** One thing changed since this was written: the chat lane now has an
authoritative environment record — wind, precipitation and an indoors flag, chat-wide,
proposed by the continuity leg. So there is a **consumer and a commit path**; what is
missing is a *derived source* for it.

- **B.1 · derived weather** — **T0. Unowned.** A pure, seeded, clock-keyed function to
  temperature, precipitation, wind, cloud and a band, built from a daily cycle plus synoptic
  fronts plus a seasonal envelope, with an authored climate picking the envelope. **No
  storage, no tick, consistent under any skip, identical on replay, queryable at any past or
  future moment for free.** This one function is the entire weather system, and it would now
  *feed an existing record* rather than needing one invented. (Weather is also named as a
  candidate package in the engine's optional Gate 7, which is owner-gated and uncommitted —
  the two are different builds for different lanes.)
- **B.2 · season** — **T0. Unowned.** Free from the real calendar. Feeds B.1's envelope,
  daylight, wardrobe, food, holidays, mood baseline.
- **B.3 · daylight** — **T0. Unowned.** Real sunrise and sunset from a short solar
  approximation, or a sinusoid. Feeds a light level → perception gating → intimacy staging.
- **B.4 · ambient temperature** — **T0. Unowned.** A function of weather, season, time of
  day and the indoors flag. The input to A.7.
- **B.5 · lunar phase** — T0. **Unowned.** Free from the calendar. Cheap enough that the
  only question is whether anything reads it.
- **B.6 · holidays and calendar events** — T0. **Unowned.** Authored per world; the calendar
  already resolves real dates. Feeds plans, rhythm exceptions, mood, gift beats.
- **B.7 · weather-driven dressing** — T1. **Unowned.** The deterministic sibling of the
  shipped rhythm auto-dress, same crossed-slot pattern: **she dresses for the weather.** One
  of the highest realism-per-line ideas here, and it composes with rhythm — work clothes
  *and* a coat.
- **B.8 · weather → mood baseline** — T1. **Unowned, and now write-new.** The session lane's
  atmosphere resolver is deleted, so there is nothing to port. The shape is the same as the
  condition mood shift: a **standing** drift target, never a per-turn impulse.
- **B.9 · weather → plans** — T1. **Unowned.** Rain cancels the pier. Plan salience already
  computes due-ness; a due outdoor plan in a storm is a *beat*, not a failure. Feeds the
  pulse as context, never a deterministic cancel.
- **B.10 · weather and season → off-screen life** — T2. **Unowned.** One line in the
  meanwhile dossier. She had a week of rain. Zero new calls.
- **B.11 · place properties: noise, crowding, air** — T1. **Engine: built** as zone
  attributes. **Chat: unbuilt**, and needs §D.

**Why this is the right shape:** an environmental "meter" is not a character meter and must
not enter the meter registry. The body **stores** — it has hysteresis, she stays cold after
coming inside — while the world **derives**. Clean split, and it keeps the registry honest.

### §C — Time, rhythm, calendar

- **C.1 · typed rhythm kinds** — T0. **Engine: built** (typed rhythm rows). **Chat:
  unbuilt** — a jsonb profile field, so no migration. Owned by
  [character-schema.plan.md](character-schema.plan.md) §2.1. Everything in §A and half of §B
  depends on it.
- **C.2 · one rhythm-pressure curve** — T0. **Engine: built for sleep**; the generalization
  that serves meals and later desire from the *same* function is **unbuilt**. Body-needs
  says it plainly: if that plan writes a second circadian curve by hand, that is the bug.
- **C.3 · rhythm self-care on crossed slots** — T1. **Engine: built** (window-crossing, no
  blanket restore). **Chat: planned** (meter-economy §4).
- **C.4 · weekly / seasonal rhythm** — T0. **Partly built**: weekday masks exist. Weekends
  and seasonal schedule shifts are **unowned**.
- **C.5 · aging and birthdays** — T0. **Unbuilt.** The clock runs; nobody ages. A structured
  birthday makes age a derivation, and **a birthday is a calendar event she knows about and
  can be hurt if the player forgets** — plan-shaped, milestone-shaped, and almost free.
  Owned by [character-schema.plan.md](character-schema.plan.md) §2.2.

### §D — Space (places without a map)

The distinction this doc drew — the old world model failed at **navigation**, not at
**places having properties** — was accepted by the owner and then settled by construction:
the successor engine built zones, access, privacy and scheduler-resolved movement, and it
works, because narration never waits on it. That closes the argument for the successor lane
and changes nothing for the legacy one.

- **D.1 · place properties** — T1/T2. **Engine: built.** **Chat: partly** — the indoors
  flag exists chat-wide, but the scene-memory places (name, details, connections) carry no
  properties. Adding them is a jsonb field on a leg that already runs. **No graph, no
  pathfinding, no travel time, no movement authority** in the legacy lane.
- **D.2 · privacy → the escalation gate** — T1. **Unbuilt in the legacy lane**, and the
  successor answered the question differently: consent there is **ledger-gated** — a
  boundary or permission entry under a named scope — and privacy zones gate access and
  observation rather than escalation. The legacy lane's escalation floor is still keyed to
  regard only, so a crowded café and a locked bedroom remain mechanically identical. That
  is still the romance-lane gap this entry names.
- **D.3 · a composed scene frame** — T1. **Unbuilt by that name in either lane.** See §6.4.
- **D.4 · proximity within a scene** — T2. **Engine: built** via zones and perception.
  **Chat: unbuilt** — across the room versus in her lap. A continuity-tracker field, not a
  system.
- **D.5 · a read-only chat story map** — **Cost has gone up.** The generic graph layout and
  map component this entry assumed "would just work" were deleted with the session lane, so
  it is now a build rather than a rewire. Still garnish; still listed only for completeness.
- **D.6 · travel time / pathfinding / movement authority in the legacy lane** — **Do not
  build.** This is the thing that broke. Skips are the time mover, and the plan
  arrival/exit license is the one principled don't-teleport exception, granted by a
  commitment rather than computed from a path. The successor engine builds the authoritative
  version properly; that is not a licence to retrofit it here.

### §E — Social

- **E.1 · the attraction axis** — T1/T2. **Engine: built** — trust, attraction and
  resentment are derived from the relationship ledger. **Chat: still a reserved, unbuilt
  record field.** In a romance product that is a conspicuous gap and the cheapest axis
  anyone will ever add. Owned by [character-schema.plan.md](character-schema.plan.md) §2.3.
- **E.2 · jealousy / audience effects** — **T2. Unowned.** Affection toward one character in
  front of another should move the second. A pulse field — the pulse already sees the
  exchange and proposes regard deltas. **Zero new calls, high drama yield, ensemble-lane
  native.** Probably the best value-to-cost ratio in this section, and it is still nobody's.
- **E.3 · knowledge propagation (gossip)** — **T4. Engine: built** — assertions, beliefs and
  gossip chains with teller provenance. **Chat: unbuilt**, and the shape still holds: facts
  already route per-member so members know *different things*, so gossip is a meanwhile
  development that copies a fact into another member's memory group with a heard-from tag.
  Fold it into the pass that already runs; do not build a sibling.
- **E.4 · belief versus truth** — T1. **Engine: built.** **Chat: the column is sitting
  there** — a fact can already be marked non-canonical (a told lie) and is underused, and
  drives already ship a scoped lie licence. Wiring the two is cheap and unowned.
- **E.5 · NPC↔NPC relationship state** — T2. **Engine: built** — the ledger is directional
  between any two actors. **Chat: unbuilt**; the authored matrix is still never
  machine-edited, so NPC social life can only accrete facts. A **derived** read over
  accumulated NPC-to-NPC facts respects the ruling and still lets things move.
- **E.6 · reputation** — T2. **Unowned.** What the wider cast believes about the player. A
  derived read over facts tagged by subject, not a new store.
- **E.7 · cast promotion (supporting → roster)** — T3. **Engine: built** (cohort member
  promoted to a full actor). **Chat: unbuilt** — the meanwhile pass explicitly never
  promotes.
- **E.8 · group dynamics** — T2. **Partly built**: a quiet-exchange counter and an
  extraversion-keyed threshold exist. Who is talking to whom is unowned.

### §F — Mind & motivation

- **F.1 · the salience bus** — **T0. Unbuilt in either lane, and still the corpus's clearest
  unowned seam.** The chat lane's initiative cue has accreted five input classes with **no
  priority model and no budget owner**, and the successor lane has no initiative cue at all
  (parked as [deferred/successor-npc-initiative.plan.md](deferred/successor-npc-initiative.plan.md)).
  Every idea in this doc wants to push a want into it. **This is the prerequisite for the
  catalog, not an item in it.** See §6.3.
- **F.2 · needs → wants** — T0. **Unbuilt; planned** (body-needs §4). A deficit read going
  negative emits a need — the sign *is* the gate, so "she is overdue for X" needs no
  per-meter threshold table. Generalize it to every reserve.
- **F.3 · attention / what she noticed** — T2. **Engine: built** (perception and
  observation). **Chat: regex focus reads only.** Not obviously needed at one-on-one; needed
  at N characters.
- **F.4 · theory of mind** — T2. **Unowned.** What she thinks *the player* feels. A pulse
  field at most; easy to over-build, and the narrator already does this implicitly and
  probably better.
- **F.5 · anticipation / dread** — T0. **Unowned.** Falls out of plan salience: an
  approaching plan she *doesn't* want is dread. Free.

### §G — Objects & means

- **G.1 · an authored means band** — **T0. Engine: built** (means bands with a derived read
  and an explicit unknown default). **Chat: unbuilt** — no authored band exists, so the
  narrator invents affordability every time. **90% of the value of an economy for 1% of the
  cost.** Owned by [character-schema.plan.md](character-schema.plan.md) §2.5, which should
  adopt the engine's six-key vocabulary rather than invent a coarser one.
- **G.2 · money and transactions** — T3+. **Engine: built at level of detail** (households,
  means and money). **Chat: parked** — a ledger every agent can desync. Ask what beat needs
  it that G.1 can't serve.
- **G.3 · item acquisition during play** — T2. **Engine: built** (materials with holding
  loci). **Chat: unbuilt** — characters acquiring items in play that become owned at
  acquisition time is a second provenance path the chat items model still lacks.
- **G.4 · gifts** — T1. **Unowned.** A fact, an item, a milestone. Romance-lane native, and
  it composes with G.1 (what she can afford), B.6 (holidays) and C.5 (birthdays).
- **G.5 · consumables** — T1. **Unowned in chat.** The drink chip consumes nothing from
  nowhere. Minor; only worth it if G.3 lands.

### §H — Life & continuity

- **H.1 · cross-chat continuity** — **Answered structurally.** The owner ruled many worlds
  (2026-07-16), and the successor lane realized it: a successor chat is bound to its own
  simulated world, with the engine authoritative. So the question "is a character one person
  or one per conversation?" has a shipped answer *for successor chats*. The **legacy** lane
  still keys everything to the chat, and a character in two legacy conversations still has
  two lives, two bodies and two clocks. That is now a known, bounded limitation of the
  legacy lane rather than the corpus's largest unscoped question.
- **H.2 · long arcs** — T4. **Unowned.** Life events over story-months; the meanwhile pass is
  the vehicle and nothing new is needed.
- **H.3 · session-lane fate** — **Resolved: deleted** (rollout R6, 2026-07-22). This entry
  is closed.

---

## 6. Architecture seams the catalog needs

Six seams. Four have since been built — **in the engine, not in the chat lane** — which
makes them worked examples rather than open designs. Two remain genuinely open, and both
are prerequisites rather than features.

### 6.1 — Meter law by class — BUILT (engine)

The proposal was to put the drift law on the meter's *class* rather than on the meter, so a
new physiological meter is a registry row again. The engine did exactly this: a class field
(reserve / load / valence / rate / phase) plus a per-meter drift law of none, linear, or
proportional decay, with the registry versioned so adding satiation or desire is a data edit
and a version bump.

**The chat lane's registry is still one flat array with one linear law.** So this seam is
now a *port with a reference implementation*, not a design question — and the warning still
applies: it is a genuine registry redesign, not an additive field. Do it *with*
[chat-meter-economy.plan.md](chat-meter-economy.plan.md) or after it, never in parallel.

### 6.2 — The read seam — BUILT (engine), unbuilt (chat)

The corpus's most-depended-on module was `meters/reads.ts`, to be created by the meter
economy and consumed by body-needs. **In the chat lane it still does not exist.** The engine
built its equivalent and generalized it further than the plan asked: circadian pressure, a
generic signed deficit read, the energy read, the intimacy read, and a closed registry of
witness-visible signs.

Everything environmental lands here too — a warmth read is a function of ambient temperature
and exposure, which is a read, not a meter. **Nothing in §A or §B is designable chat-side
until this exists there**; the open question is whether to import the engine's pure modules
across the unit boundary or write chat-native twins
([chat-meter-economy.plan.md](chat-meter-economy.plan.md) OQ4).

### 6.3 — The salience bus — STILL UNBUILT, and still the prerequisite

The chat lane's initiative cue is the universal motivation aggregator: loops, wants, rhythm,
plans, cast, meanwhile — and this doc wants to add needs, weather, jealousy, birthdays and
illness. **Nobody owns its budget.** Meanwhile the lane has a whole anti-noise regime the cue
does not participate in: the surfaced-cue band-change gate, the foreground/standing state-cue
split, the tiered "right now" digest with pre-burn deferral, and the callback ring's cooldown.

Proposal, unchanged: every producer emits a kind, an urgency, a want and a source; a pure
ranking picks **one foreground plus standing context**, mirroring the existing state-cue
split; a recently-surfaced ring prevents repetition, mirroring the callback history.
Consumers are the initiative cue, the narrator tail digest and the pulse's context.

Note what this fixes: the digest's tiers are a **prompt-assembly** priority; there is no
**motivation** priority anywhere. Body-needs names the failure mode — a character who talks
about nothing but her body — and body-needs is only one producer. With a dozen, hand-tuning
is not an option. **Build this before the catalog, or the catalog is noise.**

### 6.4 — A composed scene frame — STILL UNBUILT in both lanes

The chat lane has no single composed frame object, which is why perception-gated arousal
signs have nothing to gate on and why intimacy staging is assembled ad hoc. The session
lane's four-axis exposure mask, which this entry proposed porting, **is deleted** — so this
is a write-new, and it should be chat-native anyway: coverage-computed exposed regions, plus
the environment's indoors flag, plus proximity, plus the intimate-frame signal the emotion
label already gates on.

The engine has the same ingredients arranged differently — zones with privacy policies,
perception and observation, consent scopes — but no single frame object either, and its
visible-sign registry deliberately omits contact-gated signs *because* the frame to gate
them on isn't composed yet. One derived object would unblock, in the chat lane: arousal
signs, privacy-gated escalation, weather exposure, and light-gated perception.

### 6.5 — Composite-subject extraction

The chat field library is **single-subject** — every extractor field's instruction closure
bakes in one character name. The meanwhile pass already hit this wall and had to become a
sibling module in the library's *style* rather than a fourth leg. Any ensemble-wide or
world-wide agent hits the same wall. If §E's gossip or §H's arcs extend the pass, plan for a
composite-subject shape rather than assuming library reuse. **Unchanged and unowned.**

### 6.6 — LOD: ration the settle, not the world — BUILT (engine), unbuilt (chat)

Reverie specced level-of-detail tiers to ration a *world tick*; §1 says there is no tick. The
real budget wall is in the other direction: a four-member roster settles at roughly ten model
calls per exchange, all inside the exchange lock, and that cost is **linear in roster size**
while the direction is explicitly "less one-on-one focused". The world sim is not the scaling
problem; **the settle is.**

The engine built the general answer at Gate 6: per-actor level of detail with **two** axes —
a simulation tier and an **inference tier** (no model / small model / deliberator /
narrator) — with demotion guards and dependency wake trains, so an actor's model budget is a
first-class, assignable property.

**The chat settle rations nothing.** Applying the same idea there is unbuilt and unowned:
present and engaged → full settle; present but quiet → pulse only; away → nothing
per-exchange, since the meanwhile pass covers them. This is also exactly the owner's caveat
on parking the tier and companion system — in large worlds with many background characters,
tiers become necessary. **The 4→N path for the legacy lane runs through here, and nothing
else in this doc is blocked on it.**

---

## 7. The agent budget

The point of §1 and §2, stated as a roster.

**What stays code — no model, ever:**

Weather · season · daylight · ambient temperature · lunar phase · circadian pressure ·
hunger against her mealtime · sleep debt · aging · birthdays · every meter's drift · every
read · which need is most urgent · whether a plan is due · whether she showered off-screen ·
what she'd wear given the weather and her rhythm · illness risk · condition expiry · band
crossings · the salience ranking.

**What genuinely needs a model:**

| Job                       | Why code can't              | Where it runs          |
| ------------------------- | --------------------------- | ---------------------- |
| The reply                 | —                           | the stream             |
| What happened off-screen  | invention grounded in state | the meanwhile job      |
| How she feels about it    | judgment                    | the pulse              |
| What's worth remembering  | salience judgment           | the memory scribe      |
| What changed in the scene | comprehension               | the continuity tracker |

**Proposed new agent legs: zero.**

Everything in the catalog is T0/T1/T2 or extends the one detached job that already exists.
Jealousy is a pulse field. Gossip is a meanwhile development. Place properties are a
continuity-tracker field. This is not a coincidence or restraint — it is what §1 predicts. A
world that is *derived* needs no one to describe it; it only needs someone to *live* in it,
and those agents already exist.

The engine's inference tiers are the same argument made general: model spend became an
assignable per-actor property rather than a per-feature negotiation. If a candidate here
seems to need a new leg, that is the signal to re-examine whether it should be derived
instead.

---

## 8. Open questions

All seven were ruled on by the owner in 2026-07-16. Recorded with what happened to each.

- **OQ1 — Is the world one place or many?** **Ruled: many worlds**, pursuing whichever
  design proves better among: characters as isolated entities reusable across worlds; worlds
  with their own lore and mechanics over shared core simulation; or characters associated
  with a world *type* at creation, with template types plus user-created ones, so a
  character's attributes align with her world's settings. **Realized** for the successor
  lane — a chat is bound to its own world. The legacy lane is unchanged (H.1).
- **OQ2 — Do places get properties?** **Ruled: locations come back, but simpler** — rich
  locations with furniture, linked characters as owners or inhabitants, inclusion in
  routines, and mapping between locations; procedurally generable in-game with strong
  guardrails against hundreds of duplicate or erroneous locations. **Realized** engine-side
  as zones with access and privacy. The legacy lane still has none (§D).
- **OQ3 — Where's the ceiling on realism?** **Ruled: there is no ceiling.** Order the work
  most-useful-to-the-game first, but leave room for niche and advanced systems later. On the
  romance scene interrupted by a bathroom beat: allow some *sway*, so a character doing
  something she finds important can hold off on eating or sleeping — to a degree; an
  exhausted person probably wouldn't want sex. **The sway mechanic is unbuilt** and belongs
  with body-needs OQ-A.
- **OQ4 — Does the player have a body?** **Ruled: yes.** It was modelled in world sessions
  and simplified while testing character chat; the player character must abide by most of
  the same rules as NPCs, though its contracts are simpler because personality and demeanor
  need not be stored — the player acts the character out. **Half realized** (A.12).
- **OQ5 — Does `desire` get scheduled?** **Ruled: yes**, slotted wherever is logical.
  **Not done** — it is still in no plan's slices (A.5). This is the one ruling with nothing
  behind it.
- **OQ6 — What arbitrates the salience bus?** **Ruled** in favor of starting to break up the
  over-siloed state management. **Not done** (§6.3) in either lane.
- **OQ7 — Which overlay path wins?** Three separate paths move dispositions today —
  arousal/intoxication state overlays, regard overlays, and trait overlays — with **no
  declared composition order**, and every meter in §A adds a potential fourth. (A fourth
  path, condition mood shifts, was deleted unused on 2026-08-07.) **Ruled: these paths may
  need redesigning entirely so they compose more elegantly;
  a deeper look is still owed.** Unchanged, and the in-house precedent to reuse is still
  attribute provenance's source precedence — same shape, plus a total band-step budget so
  overlays cannot stack into a different person.

---

## 9. What to build next, from this doc

The dependency order, restated against what now exists:

1. **The salience bus** (§6.3) — small, pure, testable, and the only true prerequisite left.
   Every catalog entry that produces a want is noise without it, and it is unbuilt in both
   lanes. Build it first.
2. **`desire`** (A.5) — owner-scheduled, unowned, and the unblocker for honest arousal
   tuning in both lanes.
3. **Environment core** (B.1–B.4, B.7) — all T0/T1, and cheaper than when this was written
   because the chat lane now has a place to put the answer. The single biggest felt change
   per line of code in this doc.
4. **A composed scene frame** (§6.4, D.1–D.2) — unblocks perception-gated arousal signs and
   privacy-gated escalation in the legacy lane.
5. **The chat-lane ports of what the engine proved** — meter law by class (§6.1), the read
   seam (§6.2), and settle rationing (§6.6). Each now has a working reference
   implementation, which changes them from designs into ports.

The queued [chat-meter-economy.plan.md](chat-meter-economy.plan.md) and
[chat-body-needs.plan.md](chat-body-needs.plan.md) remain the first two steps of items 2–5
and should stay ahead of anything promoted from here.

Everything else is opportunistic: makeup degradation (A.11), birthdays (C.5), jealousy
(E.2), gifts (G.4) are each a day's work with no dependencies and disproportionate felt
effect. Good candidates to fold into whatever plan is adjacent rather than to plan on their
own.

---

## 10. Relationship to sibling plans

**This doc supersedes nothing and is superseded by nothing.** It is the umbrella the queued
plans build toward, plus the ledger of what nobody owns.

- [chat-meter-economy.plan.md](chat-meter-economy.plan.md) and its
  [spec](chat-meter-economy.spec.md) own the substrate/read law, the taxonomy and the read
  seam. **This doc adopts all of it wholesale**; §A and §B are downstream of it. The engine
  adopted it too, which is why several catalog entries now read "built".
- [chat-body-needs.plan.md](chat-body-needs.plan.md) owns the needs channel and the action
  vocabulary. §A.2–A.4 are its slices, not this doc's.
- [character-schema.plan.md](character-schema.plan.md) owns the authored fields this doc
  keeps naming: typed rhythm kinds (C.1), birthdays (C.5), the attraction band (E.1) and
  the means band (G.1).
- [engine.plan.md](finished/engine/engine.plan.md) and [engine.spec.md](engine.spec.md) own the successor
  lane, where much of this catalog was built. Read them for *how* an entry marked "built"
  works; this doc only records that it does.
- [finished/chat-offscreen-life.plan.md](finished/chat-offscreen-life.plan.md) owns the
  legacy lane's world tick. §E.3 and §H.2 extend it rather than parallel it.
- [finished/chat-plans-promises.plan.md](finished/chat-plans-promises.plan.md) owns
  commitments and the one don't-teleport exception. §B.9 and §C.5 feed it.
- [deferred.plan.md](deferred.plan.md) — this doc is the world-simulation plan its "Old
  World-Model Plans" section anticipated. Related parked stubs:
  [deferred/physiology.plan.md](deferred/physiology.plan.md) (§A's triggered-response
  generalization) and
  [deferred/successor-npc-initiative.plan.md](deferred/successor-npc-initiative.plan.md)
  (the successor lane's missing initiative cue, which §6.3 would serve).

**If this doc ever leaves draft**, it should split rather than grow: a rulings companion,
and an environment doc for §B, which is the part most likely to become a real plan first.
