# World engine refactor — a simulated world under the chat lane

Status: **partly superseded** — engine.plan.md was built from this plan but may not cover
100% of what this contains. This will be sorted out after the engine plan is shipped.

A brainstorming superset, not a build queue. Everything here is a
candidate to tune, cut, or promote into its own `<topic>.plan.md`. Nothing in this doc is
committed; the roadmap line points here as the north star that the meter-economy and
body-needs plans are already walking toward.

This is the `world-simulation.plan.md` that [deferred.plan.md](deferred.plan.md) §"Old
World-Model Plans" anticipated — re-derived, per that section's instruction, now that the
direction is settled. It is **not** a revival of the session lane. Per the owner's lean
recorded there: _"we will eventually incorporate all desired features into character chat
and character chat will become less 1-on-1 focused."_ The successor is **chat,
generalized**. This doc asks what a world underneath that lane could be.

---

## 1. The thesis: derive the world, remember the people

The old world model stored the world and needed a tick to move it. That tick never
shipped — in reverie it was specced (`finished/offscreen-simulation-spec.phase3.md`: LOD
tiers, a batched world-tick, hysteresis, eviction) and abandoned with the rest of the
phase-3 cluster; in vesper the session lane's movement problem ("characters couldn't move
to locations in a timely fashion, which broke the narrative") is the same failure wearing
different clothes. Both are symptoms of one choice: **the world was state, so something
had to advance it.**

The chat lane already has the escape. `character_chats.clock_minutes` + `calendar_start`
give an authoritative, real-calendar story time. Anything that is a **pure function of
(authored data, a seed, the clock)** needs no storage, no tick, no job, and no agent — you
compute it at read time, it is consistent across skips, replayable, and free.

That covers far more of a "realistic living world" than it looks:

> Weather. Season. Daylight and sunset. Ambient temperature. Circadian pressure. Hunger
> against her own mealtime. Sleep debt. Age and birthdays. Lunar phase. What the tide is
> doing. Whether she'd normally be at work right now. Whether it's a holiday.

None of that is state. All of it is a function of the clock. The meter-economy plan
already found this shape independently — `deriveCircadianPressure` is "derived, never
stored," and the spec's argument for exponential decay includes "**exactly composable**:
`exp(−a)·exp(−b) = exp(−(a+b))`", which is precisely the property that lets you jump the
clock without integrating through it.

What genuinely cannot be derived is **history**: what she actually did, who saw it, how
she felt about it, what she now believes. That is hysteresis — path-dependent state — and
it is exactly what the shipped machinery already handles (facts, episodes, drives, plans,
the meanwhile pass).

**So: derive the world, remember the people.** The world layer is code and costs nothing.
The model is spent only where meaning is required. This is the answer to "don't drop
everything on a custom agent" — most of this doc's catalog needs _no agent at all_.

### Corollary: lazy derivation keeps D3/D8 reversible

The standing law is no wall clock in the fiction (D8) and wall-clock absence is not a
trigger (D3), cited in every time-touching plan. Worth noting for the record: a **stored,
ticked** world welds that decision shut (you'd have to backfill every tick you didn't
run), while a **derived** world leaves it open — flipping to real time later would mean
mapping elapsed real minutes into story minutes at one seam and changing nothing else.
That is not an argument to flip it. It is an argument that deriving costs us no options.

---

## 2. The cost ladder — the doc's organizing device

Every candidate below is tagged with the tier it lands in. The tier _is_ the feasibility
argument; "we can build new agents as needed, but not for everything" is the whole reason
this ladder exists.

| Tier   | Mechanism                                                                      | Marginal cost | Turn latency                     |
| ------ | ------------------------------------------------------------------------------ | ------------- | -------------------------------- |
| **T0** | Pure derivation from authored data + seed + clock                              | none          | none                             |
| **T1** | Deterministic fold on a write that already happens (drift, skip, action)       | none          | none                             |
| **T2** | One more field on an agent leg that already runs                               | a few tokens  | none                             |
| **T3** | A new parallel leg in the post-reply settle                                    | +1 call       | none _perceived_ — but see below |
| **T4** | A detached background job (the `chat_meanwhile` / `chat_scene_sketch` pattern) | +1 call       | none (eventual)                  |
| **T5** | Anything before the reply                                                      | +1 call       | **directly on turn time**        |

The house rule already exists — the agent-improvements playbook: _"cheap deterministic
checks decide what runs… never an AI call to decide whether to make an AI call"_, and
_"nothing slow runs before the reply."_ **T5 is closed.** The session lane's intake is the
only pre-narration LLM in the codebase and it bought a 3s budget, `disableReasoning`,
`repair: false`, and a regex fallback that _is_ the previously-live path. Nothing in a
world sim earns that.

**T3 is not actually free, and this matters.** The settle holds the `chat_exchange:{chatId}`
keyed lock; a slow settle surfaces to a fast-typing player as a 409 `chat_busy`. Right now
`CHAT_PULSE_TIMEOUT_MS`, `CHAT_EXTRACTOR_TIMEOUT_MS`, and `CHAT_PERSONAL_NOTES_TIMEOUT_MS`
are all at **60_000** — a deliberate, dated, marked-REVERT diagnostic
(`constants.ts:107-112`, 2026-07-15) to measure DeepSeek 4 Flash's real latency. Until
that reverts, the lock can be held for a minute. **Any T3 proposal is blocked on that
measurement landing.** Budget T3 slots as scarce; prefer T2.

The scoring below is deliberately blunt: if a thing can be T0, it is a bug to make it T2.

---

## 3. Substrate already in place

Terse, so the catalog doesn't re-invent it. Detail lives in the linked docs.

| Layer            | What exists                                                                                                                                                                                                                                                                                 | Where                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Clock**        | `clock_minutes` (per-exchange tick **1 min**), `calendar_start` (`Date.UTC`-backed, real months/leap years, author-editable), `timeOfDayFor`, `SCHEDULE_DAY_PARTS` as the one time vocabulary, skips as the primary time mover (`moments` 30 / `hours` 180 / `overnight` 540 / `days` 4320) | `contracts/turns/chat-clock.ts`, `lib/clock.ts`                    |
| **Meters**       | Six (`hygiene`, `energy`, `stress`, `arousal`, `intoxication`, `mood`), all 0–1, `perHour` drift, optional `baseline`/`recoveryPerHour`, threshold `promptHint`/`pipLabel`; `personalizeMeters` couples traits → baselines                                                                  | `contracts/meters/registry.ts`                                     |
| **Rhythm**       | `profile.schedule` — day-part rows, custom windows, weekday masks; `formatScheduleRhythm`, `groundSchedule`, `rhythmOutfitPatch` (auto-dress on skips)                                                                                                                                      | `contracts/world/profile.ts`                                       |
| **Body**         | 48-node location tree with `expand()`, realized bodies (plan → species → heritage → body-config), coverage sets stored exploded, `exposedRegions` computed from worn items                                                                                                                  | `contracts/body/`, `contracts/items/visibility.ts`                 |
| **Conditions**   | Free-label instances, self-expiring on the story clock, `upsertCondition` dedupes; three small label-keyed effect tables                                                                                                                                                                    | `contracts/conditions/`                                            |
| **Relationship** | `familiarity` (0–100, ratchets, never down) × `regard` (−100..100, volatile); `attraction` reserved as a third axis                                                                                                                                                                         | `contracts/relationships/bands.ts`                                 |
| **Mind**         | `drives` (≤3, secrecy + reveal band, ships a scoped lie license), `plans` (`derivePlanSalience`, `advancePlans`, deterministic `missed`), `open_loops`, `mind_note`, `feeling`                                                                                                              | `contracts/turns/chat-plans.ts`, `contracts/personality/drives.ts` |
| **Off-screen**   | `chat_meanwhile` detached job — the lane's world tick; cumulative 1440-minute gate; ≤3 developments; `whereabouts` (a phrase, ≤120 chars); per-member fact routing so members know _different things_                                                                                       | `engine/chat-meanwhile.ts`                                         |
| **Perception**   | Session lane: 4-axis `ExposureMask`, attention × salience witness matrix, `darknessVerdict`, proximity. Chat lane: `exposedRegions` + `deriveChatSensoryAllowance` + regex focus reads                                                                                                      | `contracts/perception/`, `engine/chat-intent.ts`                   |
| **Agents**       | Pre-reply: none (regex only) + one embed. Settle: pulse ‖ [memory scribe ‖ continuity tracker ‖ character tracker]. Detached: summary fold, scene sketch, meanwhile                                                                                                                         | `docs/character-chat/pipeline.md`                                  |

**The load-bearing observation:** `profile.schedule` is quietly the world-sim spine. Six
shipped or planned consumers already key off it (initiative cue, `rhythmOutfitPatch`,
rhythm line, weekday fix, meanwhile dossier, and the proposed `deriveCircadianPressure` /
`rhythmBodyPatch` / `deriveRhythmPressure`). Nearly every idea below plugs into it too.
The meter-economy spec calls its one enabler — `ScheduleEntry.activity.kind`
(`sleep`|`wash`|`meal`|`work`|`leisure`) — "the one field that makes the awake clock,
off-screen self-care, and circadian hunger possible." It is a jsonb profile field: **no
migration.** That field is the cheapest unlock in the entire corpus and this doc leans on
it everywhere.

---

## 4. Inherited law — what to respect, what to challenge

The corpus has seven standing decisions. A world-sim design must respect each or supersede
it out loud.

**Respect, unchanged:**

1. **The substrate/read law** (meter-economy spec) — _a meter is physiological substrate
   on the story clock; the narrator never sees a meter, only a derived, perception-gated
   read of one._ Plus the taxonomy (reserve · load · valence · rate · phase) and its two
   invariants: **reserves are the push channel**; **phase modulates baselines, never
   values**. This is the most valuable idea in the corpus and everything below obeys it.
2. **The rhythm is the circumstance** (OQ3) — off-screen effects are credited from crossed
   `profile.schedule` slots, not from skip rules. D14 is deleted, not revised. Circumstance
   is _authored_, never assumed. The same move recurs everywhere and should keep recurring:
   `doesn't-eat-breakfast` is a disposition tag suppressing morning pressure, not a meter
   edit; "NPCs eat twice a day" is an authoring invariant, not an engine rule.
3. **The teamwork playbook** — deterministic gates decide; focused agents propose in
   parallel _after_ the reply; plain code folds; slow work detaches; **no AI call before
   the reply**.
   > **Correction (2026-07-16, [gpt-sim-design.claude.md](gpt-sim-design.claude.md) §2):**
   > the "agents propose, code disposes" half of this is **aspirational, not descriptive** —
   > this doc cited it as settled fact and was wrong. Verified: it holds for **meters,
   > `plans.missed`, and selfies**. For wardrobe, presence, plans struck/kept/canceled,
   > drives/secrets revealed, facts, scene, and cast, the "deterministic fold" only _parses
   > the narrator's prose_ — the narrator is the de facto authority, and a hallucinated
   > secret reveal **ratchets permanently**. The catalog below is unaffected (it is almost
   > entirely derive-and-arm, which sits upstream of narration), but the law as stated
   > overclaims. See that doc's §7 for the small in-place fixes and §6.1 for why the
   > distinction between authority-as-input and authority-as-veto is the whole argument.
4. **Authored canon is never machine-edited; evolution is bounded and rolls back.** The
   relationship matrix, authored traits, cast `relation` — read-only to agents. Overlays
   clamp to one band step. Everything rides `pre_exchange_state` / `pre_exchange_scenario`.
5. **The world model is spoils, not a parallel.** `actions/registry.ts` gets taken;
   `scheduleEntryAt` moves to contracts; `merge/phases/meters.ts` donates its pattern. No
   parity to protect.

**Challenge — with a narrow, specific counter-proposal:**

6. **"No location model."** Respect the _reason_, reject the _scope_. See §D — the old
   model didn't fail because places existed; it failed because **movement between them was
   authoritative and the narration had to wait for it.** Places as inert property bags have
   none of that failure mode and are the missing hook for the entire environmental layer.
7. **"Every meter is a character meter."** The player has `playerPersona` — a name and a
   blob — and no body. In a lane where "I lick her foot" is a first-class beat and the
   `drink` chip exists, the asymmetry is real. See §A.12. This is a product call, not an
   engineering one.

**Keep, but note the cost:** D3/D8 (no wall clock). See §1's corollary — deriving keeps the
option open at zero cost, which is reason enough not to store.

---

## 5. The catalog

Tier tags are per §2. **Shape** uses the meter-economy taxonomy. "Seam" names the existing
thing it plugs into — an idea with no seam is a red flag, not a feature.

### §A — Physiology (the body)

| #    | Candidate                                                                           | Tier | Shape     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------- | ---- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A.1  | **energy** — `reserve × exp(−t/τ)` minus circadian pressure, read bidirectionally   | T1   | reserve   | **Planned** (meter-economy §2). τ=16h, sleep restores linearly (the asymmetry _is_ the debt mechanic). The template for every reserve below.                                                                                                                                                                                                                                                                                          |
| A.2  | **satiation**                                                                       | T1   | reserve   | **Planned** (body-needs §2). Zero at _her_ mealtime, not a global hour.                                                                                                                                                                                                                                                                                                                                                               |
| A.3  | **hydration**                                                                       | T1   | reserve   | **Planned** (body-needs §3). Drains ~2× satiation; arousal and exertion drain it faster.                                                                                                                                                                                                                                                                                                                                              |
| A.4  | **bladder**                                                                         | T1   | load      | **Planned** (body-needs §4), with an honest open question about whether it survives contact with a romance scene (OQ-A).                                                                                                                                                                                                                                                                                                              |
| A.5  | **desire** — days without intimacy raise the _arousal baseline_ and feed initiative | T1   | reserve   | **Named in three docs, scheduled in none.** It is the load-bearing unblocker: arousal's −0.30/h is knowingly wrong ("honest value is nearer −0.50/h") purely because arousal is doing desire's job. Rides the `personalizeMeters` baseline seam. The most on-brand meter available and the clearest unowned item in the corpus. **Promote it.**                                                                                       |
| A.6  | **exertion / breath** — fast load, τ in minutes                                     | T1   | load      | Fills from physical beats (stairs, a run, sex), decays in minutes. Feeds hydration drain, arousal signs (breathlessness is already in the arousal hint), and energy cost. The spec's OQ2 explicitly wants "**exertion → energy** so an intimate scene actually costs something." Cheap, and it gives physical scenes a body.                                                                                                          |
| A.7  | **warmth / body temperature**                                                       | T1   | load      | **The physiology↔environment bridge, and the best-value new meter in this doc.** Driven by `ambientTemp × exposedRegions` — and _the gate is already built_ (`resolveChatWardrobe`). Crossing bands mints `shivering` / `overheated` conditions. This is what makes weather matter to a body instead of being scenery.                                                                                                                |
| A.8  | **social battery**                                                                  | T1   | reserve   | `social.extraversion` sets τ (the `personalizeMeters` seam again). Explains why someone wants to _leave_ — which the ensemble lane badly needs and currently has no honest reason for.                                                                                                                                                                                                                                                |
| A.9  | **caffeine**                                                                        | T1   | load      | Suppresses circadian pressure without restoring reserve — i.e. it lies to the read, which is exactly what caffeine does. Falls out of A.1 nearly free. Fun, low priority.                                                                                                                                                                                                                                                             |
| A.10 | **worn scent (perfume)**                                                            | T1   | load      | Distinct from `hygiene`. Applied by an action/item, decays over hours. Sensory-grounding's leftovers explicitly want "hair scent distinct from perfume, breath, skin warmth." An item-conferred load meter that a sense-gated read consumes.                                                                                                                                                                                          |
| A.11 | **hair-wet / makeup**                                                               | T1   | condition | Not meters — conditions with durations, which the machinery already self-expires. Wet hair after a shower (~45 min). Makeup degrades with time, crying, sweat, sex. Very romance-lane, nearly free, high felt-realism per unit of effort.                                                                                                                                                                                             |
| A.12 | **player body (minimal)**                                                           | T1   | —         | The asymmetry from §4.7. A minimal set (intoxication, energy, arousal?) driven by declared actions and chips. **Product call:** is the player's body the sim's to model or the player's to declare? A middle path: the sim tracks only what the player _did_ (the `drink` chip already implies it) and never contradicts them.                                                                                                        |
| A.13 | **illness with a course**                                                           | T1   | condition | **A genuinely good pure-code sim.** `deriveIllnessRisk` from sleep debt + stress + hydration + cold exposure + season; a **seeded** roll at a skip crossing (seed = chatId + clockMinutes ⇒ deterministic and replayable, matching the house style of `scheduleJitter` and `world-graph-layout`) mints an `unwell` condition with a multi-day course. She gets sick _because_ she's been running on 4h sleep in the rain. Zero calls. |
| A.14 | **injury / soreness**                                                               | T1   | condition | Healing courses on the clock. Body-needs already rules soreness is "probably conditions, not a meter" — agreed.                                                                                                                                                                                                                                                                                                                       |
| A.15 | **hormonal phase**                                                                  | T2   | phase     | The "hyper realistic" ask. Modulates baselines, never values (the invariant). **Deliberately parked** as a product-judgment call — and note the taxonomy is very good at saying what a meter _is_ and has no rule for what a meter _should be_ in a romance product. Same bucket: fertility, pregnancy arcs. Needs an owner ruling before design, not after.                                                                          |

**Rejected as over-modeling:** blood sugar (folds into satiation), grooming-as-a-meter and
hangover-as-a-meter (already rejected in body-needs — conditions and attributes cover
them), garment-level laundry state (a whole second wear economy for a detail prose handles).

### §B — Environment (the world's body)

**The biggest genuine gap, explicitly asked for, and almost entirely T0.** The chat lane
has no weather, no temperature, no season, no ambient anything. The session lane has
`atmosphere` (`resolveAtmosphere`, `atmosphereMoodBaselineShift`) with no chat twin.

| #    | Candidate                                                    | Tier   | Notes                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B.1  | **`deriveWeather(seed, climate, clockMinutes)`**             | **T0** | Pure, seeded, clock-keyed → `{ tempC, precip, wind, cloud, band }`. Layered value noise: a daily cycle + synoptic fronts (~3–7 day period) + a seasonal envelope. **No storage, no tick, consistent under any skip, identical on replay, queryable at any past or future moment for free.** An authored `climate` on the chat/world picks the envelope. This single function is the entire weather system. |
| B.2  | **`deriveSeason(calendarStart, clockMinutes)`**              | **T0** | Free from the real calendar. Feeds B.1's envelope, daylight, wardrobe, food, holidays, mood baseline.                                                                                                                                                                                                                                                                                                      |
| B.3  | **`deriveDaylight(calendarStart, clockMinutes, latitude?)`** | **T0** | Real sunrise/sunset — a ~20-line solar approximation, or a sinusoid if that's too much. Feeds a light level → the **existing** `darknessVerdict` machinery → perception gating → intimacy staging. `lib/clock.ts`'s `daylightBand` already exists session-side.                                                                                                                                            |
| B.4  | **ambient temperature**                                      | **T0** | `f(weather, season, timeOfDay, indoor)`. The input to A.7.                                                                                                                                                                                                                                                                                                                                                 |
| B.5  | **lunar phase**                                              | **T0** | Free from the calendar. Matters for some species, tides, and atmosphere. Cheap enough that the only question is whether anything reads it.                                                                                                                                                                                                                                                                 |
| B.6  | **holidays & calendar events**                               | T0     | Authored per world; the calendar already resolves real dates. Feeds plans, rhythm exceptions (she's off work), mood, gift beats.                                                                                                                                                                                                                                                                           |
| B.7  | **`weatherOutfitPatch`**                                     | T1     | The deterministic sibling of the shipped `rhythmOutfitPatch`, same crossed-slot pattern: **she dresses for the weather.** Rain, cold, heat. One of the highest realism-per-line ideas here — and it composes with rhythm (work clothes _and_ a coat).                                                                                                                                                      |
| B.8  | **atmosphere, ported to chat**                               | T1     | `atmosphereMoodBaselineShift` exists and is session-only. Weather → mood baseline is the same shape. Note the shift must be **standing** (a drift target), never a per-turn impulse — the existing constant caps at ±0.2.                                                                                                                                                                                  |
| B.9  | **weather → plans**                                          | T1     | Rain cancels the pier. `derivePlanSalience` already computes due-ness; a due outdoor plan in a storm is a _beat_, not a failure. Feeds the pulse as context (T2), never a deterministic cancel.                                                                                                                                                                                                            |
| B.10 | **weather/season → off-screen life**                         | T2     | One line in the meanwhile dossier. She had a week of rain. Zero new calls.                                                                                                                                                                                                                                                                                                                                 |
| B.11 | **place properties: noise, crowding, air**                   | T1     | Needs §D. Feeds stress, social battery, and the perception gate.                                                                                                                                                                                                                                                                                                                                           |

**Why this is the right shape:** an environmental "meter" is not a character meter and must
not enter `meterDefinitions`. The body **stores** (it has hysteresis — she stays cold after
coming inside); the world **derives** (it has none). Clean split, and it keeps the registry
honest.

### §C — Time, rhythm, calendar

| #   | Candidate                                        | Tier | Notes                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C.1 | **`ScheduleEntry.activity.kind`**                | T0   | The one enabler. `sleep`\|`wash`\|`meal`\|`work`\|`leisure` + `inferScheduleKind`. jsonb ⇒ **no migration**. Everything in §A and half of §B depends on it.                                                                                                                                                                                                                 |
| C.2 | **`deriveRhythmPressure(profile, kind, clock)`** | T0   | **One** circadian curve serving sleep, meals, and later desire. Body-needs says it plainly: _"If this plan writes a second circadian curve by hand, that is the bug."_ Also resolves C8 in the corpus (the proliferation of time granularities) by making the continuous curve the _derived_ layer under the four `SCHEDULE_DAY_PARTS`, not a fifth vocabulary beside them. |
| C.3 | **`rhythmBodyPatch`**                            | T1   | **Planned** (meter-economy §4). Credits only rhythm slots the skipped window crossed. Overnight → 8am past a 7am `wash` row = slept _and_ showered; → 6am = slept, not showered.                                                                                                                                                                                            |
| C.4 | **weekly / seasonal rhythm**                     | T0   | Weekday masks exist. Weekends, seasonal schedule shifts.                                                                                                                                                                                                                                                                                                                    |
| C.5 | **aging + birthdays**                            | T0   | The clock runs; nobody ages. Add `profile.birthday` (month/day) → `deriveAge` from `calendar_start`. **A birthday is a calendar event she knows about and can be hurt if the player forgets** — plan-shaped, milestone-shaped, and almost free. Strong romance beat for a tiny field.                                                                                       |

### §D — Space (places without a map)

**The narrow challenge to law #6.** The distinction the corpus hasn't drawn:

> The old world model failed at **navigation** — authoritative movement between located
> entities, which the narrative had to wait on. It did not fail at **places having
> properties.** Those are different features and only one of them broke.

`scene_memory` already stores places and connections (migration 0030). They carry no
properties. Proposal: **places as inert property bags.**

| #   | Candidate                                                        | Tier  | Notes                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D.1 | **`{ indoor, privacy, noise, shelter }` on scene-memory places** | T1/T2 | jsonb ⇒ no migration. `indoor` gates weather exposure (the hook §B needs). The continuity tracker already reads the scene — this is one more field on a leg that runs (T2). **No graph, no pathfinding, no travel time, no movement authority.** The narrator still imagines and moves freely. |
| D.2 | **`privacy` → the escalation gate**                              | T1    | **The romance-lane payoff, and it's missing today.** The escalation floor is keyed to regard only — a crowded café and a locked bedroom are mechanically identical. Privacy is exactly the environmental factor this product wants and it costs one field.                                     |
| D.3 | **`SceneFrame`**                                                 | T1    | See §6.4 — the composed read `{ indoor, privacy, proximity, intimate, temp, light, noise }`. Resolves corpus tension C6 (chat has no `ExposureMask`, which blocks `deriveArousalSigns` and the intimacy-notes chat port).                                                                      |
| D.4 | **proximity within a scene**                                     | T2    | Across the room vs. in her lap. The session lane has `proximity.ts`; chat has nothing. Feeds `SceneFrame` and intimacy staging. A continuity-tracker field, not a system.                                                                                                                      |
| D.5 | **chat story map (places graph, read-only)**                     | T4/UI | Already parked in `deferred.plan.md` as "garnish." `lib/world-graph-layout.ts` + `world-map-graph.tsx` were written generically and would just work. Agreed: garnish. Listed for completeness.                                                                                                 |
| D.6 | **travel time / pathfinding / movement authority**               | —     | **Do not build.** This is the thing that broke. Skips are the time mover; the plan arrival/exit license is the one principled don't-teleport exception and it is _granted by a commitment, not computed from a path_. That design is correct — leave it.                                       |

### §E — Social

| #   | Candidate                                  | Tier   | Notes                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E.1 | **`attraction` — the reserved third axis** | T1/T2  | Already a reserved record field (a record addition, never a migration). Familiarity ratchets, regard is volatile, attraction is… unbuilt. In a romance product this is a conspicuous gap and the cheapest axis anyone will ever add.                                                                                                |
| E.2 | **jealousy / audience effects**            | **T2** | Affection toward X in front of Y should move Y. A pulse field — the pulse already sees the exchange and proposes regard deltas. **Zero new calls, high drama yield, ensemble-lane native.** Probably the best value/cost ratio in this section.                                                                                     |
| E.3 | **knowledge propagation (gossip)**         | **T4** | Facts already route per-member so members know _different things_ (offscreen-life ruling C). Gossip = a meanwhile development that **copies a fact into another member's memory group** with a `heardFrom` tag. Real information spread, riding the job that already runs. Fold it into the meanwhile pass; do not build a sibling. |
| E.4 | **belief vs. truth**                       | T1     | `facts.canon = false` (belief-only, a told lie) **already exists and is underused**. Drives already ship a scoped lie license. Wire the two: she believes X, X is false, the divergence persists and can be discovered. The column is sitting there.                                                                                |
| E.5 | **NPC↔NPC relationship state**             | T2     | Ruling D (matrix never machine-edited) is right for _authored canon_ but caps how much NPC social life can actually change — today it can only accrete facts. A **derived** relationship read over accumulated NPC↔NPC facts respects the ruling and still lets things move.                                                        |
| E.6 | **reputation**                             | T2     | What the wider cast believes about the player. A derived read over facts tagged by subject, not a new store.                                                                                                                                                                                                                        |
| E.7 | **cast promotion (supporting → roster)**   | T3     | Deferred in two docs; the meanwhile pass explicitly never promotes. A living world needs the path. Blocked on §6.6 (LOD), not on this doc.                                                                                                                                                                                          |
| E.8 | **group dynamics**                         | T2     | Who's talking to whom; who's been quiet. `ensembleQuietThreshold` and `quiet_exchanges` exist.                                                                                                                                                                                                                                      |

### §F — Mind & motivation

| #   | Candidate                        | Tier   | Notes                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F.1 | **The salience bus**             | **T0** | See §6.3. The corpus's clearest unowned seam (tension C5): `buildInitiativeCue` has accreted five input classes with **no priority model and no budget owner**. Every idea in this doc wants to push a want into it. **This is the prerequisite for the catalog, not an item in it.** |
| F.2 | **needs → wants**                | T0     | **Planned** (body-needs §4): a deficit read going negative emits `{ kind, urgency, want }` — _"the sign is the gate, so 'she is overdue for X' needs no per-meter threshold table."_ Elegant; generalize it to every reserve.                                                         |
| F.3 | **attention / what she noticed** | T2     | The session lane has the attention × salience witness matrix; chat has regex focus reads. Not obviously needed at 1-on-1; needed at N characters.                                                                                                                                     |
| F.4 | **theory of mind**               | T2     | What she thinks _the player_ feels. A pulse field at most. Easy to over-build; the narrator already does this implicitly and probably better.                                                                                                                                         |
| F.5 | **anticipation / dread**         | T0     | Falls out of `derivePlanSalience`'s `imminent` — an approaching plan she _doesn't_ want is dread. Free.                                                                                                                                                                               |

### §G — Objects & means

| #   | Candidate                        | Tier   | Notes                                                                                                                                                                                                                         |
| --- | -------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G.1 | **`means` as an authored band**  | **T0** | Broke / getting by / comfortable / wealthy, as an authored attribute the narrator respects. **90% of the value of an economy for 1% of the cost**, and no transaction ledger to keep consistent. Strongly preferred over G.2. |
| G.2 | **money & transactions**         | T3+    | Parked. A ledger every agent can desync. Ask what beat needs it that G.1 can't serve.                                                                                                                                         |
| G.3 | **item acquisition during play** | T2     | Parked in `deferred.plan.md`: _"characters acquire items in play (purchases, gifts) that become owned at acquisition time — a second provenance path the items model doesn't have yet."_                                      |
| G.4 | **gifts**                        | T1     | A fact + an item + a milestone. Romance-lane native. Composes with G.1 (what she can afford), B.6 (holidays), C.5 (birthdays).                                                                                                |
| G.5 | **consumables**                  | T1     | The `drink` chip consumes nothing from nowhere. Minor; only worth it if G.3 lands.                                                                                                                                            |

### §H — Life & continuity

| #   | Candidate                 | Tier | Notes                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H.1 | **cross-chat continuity** | T?   | **The largest unscoped question in the corpus.** Everything keys to `(chatId)`; a character in two conversations has two lives, two bodies, two clocks. If chat becomes "less 1-on-1 focused," this stops being theoretical. Needs an owner ruling on the _product_ question (is a character one person or one per conversation?) before any design. Flagged, not proposed. |
| H.2 | **long arcs**             | T4   | Life events over story-months. The meanwhile pass is the vehicle; nothing new needed.                                                                                                                                                                                                                                                                                       |
| H.3 | **session-lane fate**     | —    | Not deleted, not maintained, not planned. "Batch 2 & 4 (session-side remainder)" sits in Next with no plans — and §C of it would port chat improvements _into_ the deprecated lane. Out of scope here; worth an explicit ruling somewhere.                                                                                                                                  |

---

## 6. Architecture seams the catalog needs

Six seams. The catalog is mostly cheap **if these exist** and mostly awkward if they don't.
Four of the six already have a partial owner in a queued plan.

### 6.1 — Meter law by class

The registry is one flat array with one drift law (`driftToward`, linear toward a pole).
The taxonomy already names five classes wanting different laws — the meter-economy plan
carves out energy as "the one meter on the exponential law, not `perHour`," which is the
tell that the law belongs on the class, not the meter.

Proposal: `class: "reserve" | "load" | "valence" | "rate" | "phase"` on the definition,
with the law selected per class (reserve → exponential τ; load → decay to baseline; rate →
linear; valence → baseline-seeking; phase → derived, never stored). Then **a new
physiological meter is a registry row again** — which is the whole promise of the
registries as extension points, and what makes §A's list of a dozen candidates tractable
instead of a dozen bespoke code paths.

Watch: this is a genuine registry redesign, not an additive field. Do it _with_
meter-economy or _after_ it, never in parallel.

### 6.2 — The read seam (`meters/reads.ts`)

**The corpus's most-depended-on unbuilt module.** Created by meter-economy §2 (mood,
energy, arousal signs), second customer is body-needs (hunger, thirst, needs), generalized
by the spec's deficit-read section: `read = clamp(−1, +1, reserve − pressure)`, signed,
zero at the character's own act-point, both poles saturating.

Everything environmental lands here too — the warmth read is `f(ambient, exposure)`, which
is a read, not a meter. **Nothing in §A or §B is designable until this exists.**

### 6.3 — The salience bus (F.1)

`buildInitiativeCue` is becoming the universal motivation aggregator: loops, wants, rhythm,
plans, cast, meanwhile — and this doc wants to add needs, weather, jealousy, birthdays,
illness. Nobody owns its budget. Meanwhile the lane has a whole anti-noise regime the cue
doesn't participate in: the `surfaced_cues` band-change gate, `splitStateCues`'s
foreground/standing split, the "Right now" digest's tiers (binding → gate → license →
flavor) with **pre-burn** deferral, the callback ring's cooldown.

Proposal: every producer emits `{ kind, urgency, want, source }`; a pure `rankSalience()`
picks **one foreground + standing context**, mirroring `splitStateCues` exactly; a
recently-surfaced ring prevents repetition, mirroring `callback_history`. Consumers: the
initiative cue, the narrator tail digest, the pulse's context.

Note what this fixes: the digest's tiers are a **prompt-assembly** priority; there is no
**motivation** priority anywhere. Body-needs names the failure mode ("a character who talks
about nothing but her body") and body-needs is only one producer. With a dozen, hand-tuning
is not an option. **Build this before the catalog, or the catalog is noise.**

### 6.4 — `SceneFrame` (D.3)

Resolves C6. The chat lane has no four-axis `ExposureMask`, which is why intimacy-notes
shipped session-only and why `deriveArousalSigns` has no frame to gate on. Rather than port
the session mask, compose a chat-native frame from what chat already has: coverage-computed
`exposedRegions` + place properties + proximity + the intimate-frame signal that the
`aroused` emotion label already gates on.

One derived object, and it unblocks: `deriveArousalSigns`, the intimacy-notes chat port,
privacy-gated escalation, weather exposure, and light-gated perception.

### 6.5 — Composite-subject extraction

The field library is **single-subject** — "every `ExtractorField` instruction closure bakes
in one `ctx.characterName`." The meanwhile pass already hit this wall and had to become a
sibling module in the library's _style_ rather than a fourth leg. Any ensemble-wide or
world-wide agent hits the same wall. If §E's gossip or §H's arcs extend the pass, plan for a
composite-subject shape rather than assuming library reuse.

### 6.6 — LOD: ration the settle, not the world

**Reverie's abandoned idea, finally earning its place — for a different reason than it was
designed for.** Reverie specced LOD tiers (live/active/background/dormant) to ration a
_world tick_. §1 says there is no tick. But there is a real budget wall in the other
direction:

A 4-member roster settles at roughly **1 streamed narrator + pulse + 3 extractors + 3
members × (pulse + personal notes) ≈ 10 calls per exchange** — all inside the lock. That
cost is **linear in roster size**, and the direction is explicitly "less 1-on-1 focused."
The world sim is not the scaling problem; **the settle is.**

So: LOD rations the settle. Present + engaged → full settle. Present + quiet → pulse only.
Away → nothing per-exchange; the meanwhile pass covers them. This is also exactly the owner's
own caveat on parking the tier/companion system — _"in large worlds with many characters
running in the background, this would become an issue and tiers / companion flags would be
necessary."_ The parked system and this need are the same system. **The 4→N path runs
through here, and nothing else in this doc is blocked on it.**

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

| Job                       | Why code can't              | Where it runs                 |
| ------------------------- | --------------------------- | ----------------------------- |
| The reply                 | —                           | the stream                    |
| What happened off-screen  | invention grounded in state | `chat_meanwhile` (T4, exists) |
| How she feels about it    | judgment                    | pulse (T2 slot, exists)       |
| What's worth remembering  | salience judgment           | memory scribe (exists)        |
| What changed in the scene | comprehension               | continuity tracker (exists)   |

**Proposed new agent legs: zero.**

Everything in the catalog is T0/T1/T2 or extends the one detached job that already exists.
Jealousy is a pulse field. Gossip is a meanwhile development. Place properties are a
continuity-tracker field. This is not a coincidence or restraint — it's what §1 predicts.
A world that is _derived_ needs no one to describe it; it only needs someone to _live_ in
it, and those agents already exist.

If a candidate here seems to need a new leg, that is the signal to re-examine whether it
should be derived instead.

---

## 8. Open questions

- **OQ1 — Is the world one place or many?** (H.1) Does a character in two conversations
  have one body and one clock, or two lives? Everything keys to `(chatId)` today. The
  answer gates cross-chat continuity, and "chat becomes less 1-on-1" makes it urgent. **A
  product ruling, not a design one.**
  - It will be many worlds so we should try to do one or more of the following things, whichever is a better design:
    - 1 Keep characters as isolated entities and put as much world-related design on sessions so characters can be used in many worlds.
    - 2 Allow worlds to have different lore and gameplay mechanics but the core simulation mechanics stay the same.
    - 3 Require characters to be associated with a world _type_ on creation. There can be template types and users can create their own. Characters are nested in those worlds so their attributes align with the world's settings
- **OQ2 — Do places get properties?** (§D) The narrow challenge to "no location model." The
  claim is that properties ≠ navigation and only navigation broke. If that's accepted, §B
  has a hook and D.2's privacy gate lands cheaply. If not, the environmental layer has
  nowhere to attach and §B shrinks to weather-as-mood-tint.
  - We will bring back locations but they'll be simpler. It was quite tedious and messy the old way, but I still like the ability to build rich locations with furniture, linked characters as owners or inhabitants, inclusion in routines, mapping between locations, etc. Whatever we design will have to be able to be procedurally generated in the game as well but with strong guardrails to reduce false positives and prevent worlds with hundreds of duplicate or erroneous locations that are never used or confuse the game logic.
- **OQ3 — Where's the ceiling on realism?** (A.4, A.15) Bladder, hormonal phase, fertility.
  The taxonomy says what a meter _is_; nothing says what a meter _should be_ in a romance
  product. Body-needs already frames it honestly: _"A romance scene interrupted by a
  bathroom beat is either charming or fatal, and nobody knows which until it is played."_
  Needs a rule, not case-by-case rulings.
  - There's no ceiling. We should order things as most useful to the game and develop those first but leave room to implement more niche and advanced systems as development continues. To your example about a romance scene being interrupted by a bathroom beat, we would allow some degree of _sway_ within these systems so if an npc is doing something it finds important (such as making love) they can hold off on eating, sleeping, etc. (to a degree. An exhausted person probably wouldn't want to have sex).
- **OQ4 — Does the player have a body?** (A.12, §4.7) Sim-tracked or player-declared?
- Yes. This was modelled in the world sessions but we simplified it while testing character chat. I think we're ready to think about starting to bring this back and fleshing it out. The character must abide by most of the same rules as npcs but their initial contracts are simpler because we don't need to store personality and demeanor fields, since the player will be acting out the player character.
- **OQ5 — Does `desire` get scheduled?** (A.5) Arousal is knowingly mistuned until it lands,
  and it currently sits in no plan's slices. Either schedule it or accept the compromise
  permanently and say so.
  - Yes it should get scheduled but we're still at a brainstorming phase, so slot it in where you think is logical and we'll move it if needed.
- **OQ6 — What arbitrates the salience bus?** (6.3) Urgency alone, or a kind priority? And
  does a need _interrupt_ or only _color_? Body-needs OQ-B says "settle on the first
  playtest, not in this doc" — agreed, but the bus has to exist to be playtested.
  - GPT recommends we start breaking up the state management system as it is too siloed and I tend to agree. We will review its recommendations soon.
- **OQ7 — Which overlay path wins?** Four separate paths move dispositions today
  (`stateDispositionOverlays` for arousal/intoxication, `regardDispositionOverlays`,
  `applyChatTraitOverlays`, `conditionMoodBaselineShift`) with **no declared composition
  order** — and two shipped fixes (fidelity's one-band clamp, meter-economy's arousal
  re-scope) are both chipping at it from different sides. Every meter in §A adds a
  potential fifth. In-house precedent to reuse: attribute provenance already has
  `SOURCE_PRECEDENCE` + `resolveProvenance`. Same shape, plus a total band-step budget so
  overlays can't stack into a different person.
  - We may need to redesign these paths entirely so they function more elegantly, we'll take a deeper look at this soon.

---

## 9. Sequencing sketch (not a commitment)

Dependency order, since much of it is already implied by the queue:

1. **meter-economy** (queued) — lands `meters/reads.ts`, clock-keyed drift, `ScheduleEntry.kind`,
   `rhythmBodyPatch`. **Nothing here is designable before it.**
2. **body-needs** (queued) — proves the reserve template a second time, lands
   `deriveRhythmPressure` and the needs channel, collapses the action fork.
3. **The salience bus** (6.3) — before the catalog can push into it. Small, pure, testable.
4. **Environment core** (B.1–B.4, B.7) — all T0/T1, no dependencies beyond the read seam.
   The single biggest felt change per line of code in this doc.
5. **`SceneFrame` + place properties** (D.1–D.3) — unblocks privacy, the intimacy-notes chat
   port, and `deriveArousalSigns`.
6. **`desire`** (A.5) — unblocks honest arousal.
7. **Meter law by class** (6.1) — once there are enough meters to justify it. Probably
   after §A has four or five more members, not before.
8. **LOD** (6.6) — when roster > 4 is real, and not one day sooner.

Everything else is opportunistic: A.11 (wet hair, makeup), C.5 (birthdays), E.2 (jealousy),
G.1 (means) are each a day's work with no dependencies and disproportionate felt effect.
Good candidates to fold into whatever plan is adjacent rather than to plan on their own.

---

## 10. Relationship to sibling plans

**This doc supersedes nothing.** It is the umbrella the queued plans are already building
toward, written down so the next ten features have a shape to fit.

- [chat-meter-economy.plan.md](chat-meter-economy.plan.md) + [spec](chat-meter-economy.spec.md)
  — owns the substrate/read law, the taxonomy, and the read seam. **This doc adopts all of
  it wholesale**; §A and §B are downstream of it.
- [chat-body-needs.plan.md](chat-body-needs.plan.md) — owns the needs channel and the action-fork
  collapse. §A.2–A.4 are its slices, not this doc's.
- [chat-offscreen-life.plan.md](chat-offscreen-life.plan.md) — owns the world tick. §E.3 and §H.2
  extend it rather than parallel it.
- [chat-plans-promises.plan.md](chat-plans-promises.plan.md) — owns commitments and the one
  don't-teleport exception. §B.9 and §C.5 feed it.
- [deferred.plan.md](deferred.plan.md) §"Old World-Model Plans" — this doc is the
  `world-simulation.plan.md` that section anticipated; that entry now points here.
- [world-map.plan.md](world-map.plan.md) — stays demoted. §D.5 agrees it's garnish; §D.6
  agrees the navigation half should never come back.

**If this doc leaves draft**, it should split rather than grow: `world-engine-refactor.spec.md`
for rulings, and `world-engine-refactor.environment.md` for §B, which is the part most
likely to become a real plan first.
