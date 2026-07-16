# Reviewing GPT's review — verification, corrections, and what to steal

Status: **supplemental analysis** — not a plan, carries no roadmap line, commits nothing.

Fourth doc in the thread: [world-engine-refactor.plan.md](world-engine-refactor.plan.md)
(mine) → [world-engine-refactor.gpt.md](world-engine-refactor.gpt.md) (GPT's review of it) →
this. Sibling thread: [gpt-sim-design.plan.md](gpt-sim-design.plan.md) →
[gpt-sim-design.claude.md](gpt-sim-design.claude.md). Named per the established
`<topic>.<reviewer>.md` pattern.

**Headline: GPT's review is the strongest document in the thread, and verification killed
my best counter-argument.** I claimed the project had already run the authority experiment
and that it failed. It didn't run. The record says the opposite of what I said it said, and
GPT's inference — _"it does not follow that authoritative location is inherently wrong"_ —
is supported while mine isn't. That correction (§1) is worth more than the rest of this doc.

But GPT's review also contains one substantive misfire against the #1 queued plan (§3.1),
a structural impossibility in its own sequencing that its own dependency order proves
(§3.2), and a "first slice" that cannot fail cheaply (§3.3). And verification turned up a
live data-integrity bug that neither of us found (§5.1).

---

## 1. The correction: my §6.1 was built on a false premise

My [gpt-sim-design.claude.md](gpt-sim-design.claude.md) §6.1 argued — as its central,
self-described best contribution — that _"the project already ran this experiment"_:
authoritative movement broke the narrative, the team fled to a narrator-authoritative lane,
quality soared, therefore authority costs story. I called it _"measured once, in the only
way that counts."_

I checked the record. **The experiment never ran.**

**The schedule half never executed once, for any character.** `profile.schedule` was
write-orphaned — nothing in the app ever wrote it — so `scheduleEntryAt` always returned
`null` and the schedule tick was a **no-op for every character in every session**. The
deleted `schedule-authoring-gap.md` named it exactly:

> _"It can only ever be `[]` … `scheduleEntryAt` always returns `null` → the schedule tick
> is a no-op for every character. It is a silent dead end: the code looks complete and the
> specs reference it, so the gap is invisible until someone asks 'why does no NPC ever
> follow a routine?'"_

Schedule authoring finally shipped **2026-07-12** — for the *chat* lane. The
movement-authority and scheduled-arrivals specs were deleted **2026-07-13**. The missing
piece arrived the day before the design was retired.

**The one real failure had a diagnosed, designed, never-built fix — and it doesn't
implicate authoritative location.** The deleted `movement-authority.spec.md` is a forensic
post-mortem of a real session, turn by turn. The decisive corruption was **turn 32: a
player narrating an NPC out of a room**, committed verbatim because — the spec's words —
_"there is no symmetric rule that an NPC can't be moved by player narration."_ That is an
**ungated write path**, which is an argument *for* authority, not against it. The spec's
own verdict on the cascade:

> _"On turn 34 the player literally typed 'main street' (one hop, adjacent, would have
> applied), but the simulant emitted the cafe (two hops)… **Had the engine routed one hop
> along the path, the chain would have self-healed by turn 35.**"_

Every named root cause is still live and unbuilt: the authority gate, one-hop routing, the
in-node no-op, the anchor dead zone, appointments. The intake agent **already classifies**
`narrated_npc`, `implied_subspace`, `co_travel_request`, and full appointment records —
`intent-brief.ts:44-46` calls them _"persisted seams: written in v1, enforced later."_
Nothing reads them. The enforcers were the two deleted specs.

**And the retirement was a portfolio decision, not a verdict** (`deferred.plan.md:477-479`):
the specs were retired _"rather than built against the possibly-deprecated session model."_

There is no retrospective anywhere in `finished/` on why the world model was abandoned. The
only causal analysis the project ever had was in the two files that were deleted.

### What this corrects, beyond my doc

**`developer-notes/CLAUDE.md`'s account is inaccurate in a load-bearing way.** It says the
system _"attempted to use map locations and **schedules** to have NPCs move around the
world"_ and _"became somewhat broken."_ The schedules half structurally could not fire. The
lived experience — characters don't show up, the story stalls — was real and is exactly
what an unwired system predicts. The attributed mechanism is not what happened.

This does **not** argue for reviving the session lane. But the deprecation's stated premise
is weaker than every doc in this corpus (including both of mine) has assumed, and it is
quoted as settled history in the roadmap, the deferred plan, and the meter-economy spec's
"world-model deprecation license." **Worth an owner correction in `CLAUDE.md` regardless of
what gets built** — a wrong reason for a right decision quietly justifies the next decision
too.

### What survives of the rule

The input/veto/adjudication split may still be a useful *design* frame, but I have to
retract its evidence and grade its own veto column honestly:

- **Turn 32** — an ungated write corrupted state. Argues *for* authority.
- **`stagedLocationAnchor`** — built precisely to reconcile engine state with narrator
  freedom across the pre/post-turn boundary, and it **worked**. Direct evidence the coupling
  is manageable.
- **`prompts/narrative.ts:77`** — _"Wanting an absent character in the scene is a setup, not
  a teleport: this turn, narrate the world reaching for them… and let them arrive in a later
  turn."_ **The narrator is bridled by state today, in the shipped product, and it's fine.**

So: **the veto column's cost is unproven, and the one time it was tested it held.** I
overstated it. The residual concern is narrower and real — the spec's *implied sub-space*
finding, that prose narrates at a finer grain than any node graph ("Eleanor steps out of her
zoning meeting"; the council chamber has no node). The spec treated it as fixable and never
fixed it. That is the one tension with a structural flavor, and it's the only part of my
argument the record supports.

If the case against space rests on _"we tried it and it broke"_ — **that case is closed
against me.** If it rests on _"space is expensive and derivation is cheaper"_ — that's
defensible, and it needs its own justification, which no doc has yet given.

---

## 2. Where GPT's review is right (conceded, briefly)

Already conceded in [gpt-sim-design.claude.md](gpt-sim-design.claude.md) §0b and not
relitigated: the derived-value-causes-history capture rule; skip-partition invariance
(`advance(t0→t3) == advance(t0→t1→t2→t3)` — a real bug in my A.13 illness roll); the T0–T5
ladder pricing model latency only; T5 as closed-by-default rather than forbidden; and the
reconciled thesis. Add to that list, from this doc:

- **The two-LOD split** (simulation LOD vs. inference/narrative LOD) is correct and my
  single LOD conflated them. _"A politically important off-screen character may receive
  active simulation without appearing in the prompt"_ — my version can't express that.
- **The `Dynamics` discriminated union** beats my `class` field. One law per class is still
  too coarse; reserves can be linear, exponential, event-only, or piecewise.
- **The signal bus refinement is necessary, not speculative.** Urgency / action utility /
  narrative salience / observability genuinely differ — _"a severe private need may dominate
  the character's action choice without being visible to the player or deserving direct
  narration."_ My single foreground signal cannot represent that, and ensemble scenes need
  per-character budgets.
- **The modifier engine** is a better answer to my OQ7 than "declare a precedence order."
- **The sway formalization** — `deferrability` + `hardLimitAt`, _"deferral never restores
  the underlying reserve"_, and the four gates (notices hunger / wants food / mentions food /
  interrupts the scene to eat) — is exactly what the owner meant and neither plan had it.
- **The identity model composes the owner's three options** rather than picking one. Clever,
  and probably right (with a caveat in §3.4).

---

## 3. Where GPT's review is wrong

### 3.1 — The `rhythmBodyPatch` critique attacks a strawman, and re-litigates a fresh ruling

GPT's §"Schedules are intentions" says a schedule row _"must not directly feed, wash,
dress, move, or pay a character"_ and names `rhythmBodyPatch` as **"silently laundering
away"** missed meals. Three problems:

**It attacks behavior OQ3 already cut.** The blanket restore (`hygiene = max(current, 0.9)`)
is what OQ3 *removed*. What the plan actually specifies is the opposite of laundering:

> _An `overnight` skip landing at **6am**, before the 7am wash row → she slept and has
> **not** showered, **and that need stands in the scene for the fiction to play**._

That *is* GPT's "actual cause." The plan already produces it — sourced from authored rhythm
rather than resolved preconditions. GPT is arguing for an outcome the plan already delivers,
against a mechanism it mischaracterizes.

**It demands resolution against six primitives the chat lane has zero of.** Verified:
locations (none — `whereabouts` is documented _"**Never a location entity**"_), access/hours
(none), resources/money/items (none), interruption (none), occupancy (none), travel (none).
The `locations`/`location_links` tables exist — **in the session lane, which is being
deleted**. GPT is asking the chat lane to resolve intents against a model that exists only
in the lane being removed.

**It re-litigates a closed owner ruling without saying so.** OQ3 is dated 2026-07-16 and is
explicit: off-screen self-care is a rhythm event; the schedule *is* the circumstance; _"it
costs no LLM call"_; the one escape hatch (a condition suppressing self-care) is
**deliberately deferred as a named seam**. GPT's position isn't a refinement of that — it's
a reversal, aimed at the **#1 roadmap item, status `next`, design-complete**. It may be the
right reversal *eventually*; GPT never acknowledges it is one, or prices what re-opening it
does to the queue.

**The honest synthesis:** GPT's critique is correct *in the target architecture* and vacuous
*today* — an "intent" that nothing can resolve is a deferred no-op. Given today's available
state, `rhythmBodyPatch` **is** the resolution. It becomes wrong the moment locations and
resources exist — which, per OQ2, is now direction. So this is a **sequencing** finding, not
a design error: the plan is correct now and has a known expiry.

### 3.2 — "Both tracks can proceed" is structurally false, by GPT's own ordering

GPT lists seven Track A constraints. Verified: four are already true or fine (purity,
budgets, provenance, no `ChatState` expansion — 29 whole-row fields is a real smell). One
re-litigates a shipped ruling (clock-keying vs. the deliberate `CHAT_METER_DRIFT_MINUTES`
decoupling — and it's what meter-economy *intends to fix*, so it's satisfiable **by** Track
A, not **as a precondition on** it). **Two presuppose the kernel they precede:**

| Constraint | Requires |
| --- | --- |
| "schedules produce intent, not guaranteed completed actions" | Track B **item 4** (locations, affordances, preconditions, resources, interruptions) |
| "derivation functions are versioned when their output can cause history" | Track B **item 2** (the command/event kernel — versioning needs something to replay against; an event log's absence makes a "version" a number in a jsonb blob) |

GPT's own dependency order proves it: kernel at item 2, space at item 4, and Track A
precedes both. **So Track A is not parallel — it's gated.** "Adapt behind Track B's
interfaces" means "wait for interfaces that don't exist." That should be said plainly,
because for a solo developer the difference between *parallel* and *gated* is the whole
plan.

Worth noting the second constraint **retroactively condemns shipped code it doesn't name**:
`rhythmOutfitPatch` writes `wornItemIds` → the narrator renders it → the archivist extracts
facts → history. Unversioned, today.

### 3.3 — The "first integrated slice" is the entire architecture at N=2

GPT's slice: one `WorldType`, two worlds, a template instantiated in both, a player
character, three locations with opening hours + privacy + weather exposure + furniture
affordances, seven body systems, a work schedule + meal intent + appointment + gift,
authoritative departures/arrivals, item ownership, perception events, a private fact, a
seven-day fast-forward, and a narrator reply compiled from a perspective-safe view — with
replay-hash equality, skip composability, world isolation, and derivation versioning.

**That is not a slice. It is every subsystem, with N=2.** Identity, kernel, scheduler,
space, actions, perception, belief, narrative view, and LOD must *all* exist before it runs
once. There is no smaller version and **no failure mode short of building everything**. A
vertical slice exists to de-risk early and cheaply; this one can only report its verdict
after the risk has been fully taken. If it fails in month five, the finding is "this was
hard."

GPT is right that it _"tests the disagreements between the two plans."_ It just can't test
them until they're moot.

### 3.4 — The identity model reads a maximal mandate into a menu

The owner's OQ1 answer offers **three options** and says _"one or more of the following
things, **whichever is a better design**."_ Option 1 (characters stay isolated, world design
rides sessions) is close to today and nearly free. Option 2 (worlds differ in lore and
mechanics, core sim shared) is cheap. Option 3 (characters bound to a world type at
creation) is the expensive one — and it's in tension with option 1.

GPT composes all three into a six-entity hierarchy
(`WorldType`/`World`/`WorldBranch`/`CharacterTemplate`/`WorldCharacter`/`PlayerCharacter`).
The composition is elegant and resolves the tension. But it is the **maximal** reading of a
menu that explicitly licensed a cheaper one, and the migration — _"existing chats can
migrate by creating a private world and one world-character instance per participant"_ — is
**the largest migration in the project's history, stated in one sentence**, with no
mention of what happens to memory groups, the 51 existing migrations, or the live data.

---

## 4. Gaps that persist across all four documents

1. **Nobody has costed anything.** Track B is seven foundations that together are a game
   engine. No weeks, no months. My plan says "opportunistic." For a solo developer with a
   working product, the estimate *is* the decision, and four documents and ~2,400 lines have
   not produced one number.
2. **Still no quality eval.** GPT's admission contract asks _"what is its player-facing
   value relative to complexity and noise?"_ — the right question, with **no instrument
   behind it**. Its acceptance properties are all correctness (replay hashes, isolation,
   causation chains). A world that replays deterministically and reads identically is an
   expensive no-op. The corpus already ships faster than it measures; four docs now propose
   to make that considerably worse.
3. **Nobody asks whether the product survives the transition.** One developer, two tracks,
   and the asset at risk is the only thing that works.
4. **Silence on the live latency crisis.** `CHAT_PULSE_TIMEOUT_MS` /
   `CHAT_EXTRACTOR_TIMEOUT_MS` / `CHAT_PERSONAL_NOTES_TIMEOUT_MS` are **all at 60_000** — a
   marked-REVERT diagnostic measuring why DeepSeek 4 Flash times out at 8–10s on tiny
   structured calls. The settle holds the exchange lock. Neither GPT doc mentions it.
5. **Silence on the session lane's fate.** It's still in the codebase, still in `Next`
   (batches 2 & 4, no plans). Track B would make a **third** lane. I raised this as H.3; no
   doc and no ruling has answered it.

---

## 5. What verification found that no document had

### 5.1 — The rerun snapshot is primary-only. Ensemble state leaks on every group regenerate.

**A live data-integrity bug, in shipped code.** `savePreExchangeSnapshot` is only ever
called with the primary's `characterId`. The roster loop calls plain `saveChatState(...)`
for every other member — **no snapshot**. So in a group chat, "another take" rolls back the
primary and **persists every non-primary member's `regard`, `mood`, `mindNote`, `openLoops`,
`drives`, `milestones`, `quietExchanges`, `presence`, and `whereabouts` from the discarded
reply.** Rollback is per-primary; the roster is not transactional.

Related, also unnamed: **reach-back rerun silently doesn't roll back state at all**
(`successors.length === 1` fails → `chat_state.rerun.no_rollback`, a warn diagnostic the
player never sees). And images from a discarded take survive in the Gallery.

This is the strongest argument *for* GPT's position — a snapshot that isn't an invariant —
and GPT didn't make it. It's also fixable today without a kernel.

### 5.2 — `rhythmOutfitPatch` is not the precedent the spec says it is

The meter-economy spec calls it _"the precedent to copy"_ and says `rhythmBodyPatch` _"is
its sibling, not a new idea."_ Verified: **shipped `rhythmOutfitPatch` is
arrival-covering** — it takes a single `clockMinutes`, asks which row *covers* that minute,
and overwrites. No `fromMinutes`, no window, **no crossing check**. The planned
`rhythmBodyPatch` is **window-crossing**. They are different functions, and "sibling, not a
new idea" understates the work in the #1 queued plan. A docs fix independent of any
architectural decision.

(Ironically, the shipped arrival-covering behavior is the one that *actually* matches GPT's
"laundering" complaint — and GPT doesn't mention it.)

### 5.3 — GPT's best warning lands on GPT's blind spot

GPT's closing danger — _"letting tactical features create more state and **text-matching
contracts** that later have to be unwound"_ — is well-aimed. The codebase is full of them:
`mentionsCharacter` and `spokeInReply` decide pulse scoping by string-matching names;
`matchOutfitPresetInText` maps _"changes into her work clothes"_ onto a preset;
`ScenePlace.connections` are free-text.

And the sharpest instance is **inside the plan GPT is reviewing**: `inferScheduleKind(activity)`
— the meter-economy spec's own named enabler, _"the one field that makes the awake clock,
off-screen self-care, and circadian hunger possible"_ — is **explicitly designed to
text-match** `"Sleeping"` / `"Shower and coffee"` into a typed `kind`, specifically to avoid
a migration. That is a brand-new text-matching contract, in the #1 queued plan, that Track B
would have to unwind. GPT's own best argument applies precisely there and it aimed at
`rhythmBodyPatch` instead.

---

## 6. Opportunities — what to take from GPT's review now

Ranked by value ÷ cost. All four are **independently shippable with no kernel**:

1. **The modifier engine** (GPT's answer to my OQ7). Immutable authored base + explicit
   `Modifier` records + a declared resolution order. Kills four hidden precedence rules,
   makes every effective value explainable and reversible. Pure contracts-layer. In-house
   precedent already exists: `SOURCE_PRECEDENCE` + `resolveProvenance`. **The best "do it
   now" item in either GPT document**, and the owner has already said these paths may need
   redesigning entirely (OQ7).
2. **Procedural-location guardrails.** `provisional | canonized | merged | retired`, plus
   embedding-similarity dedup, reachability, bounded counts per type/region, and an
   idempotency key. This is **the single best answer anyone has given to the owner's own
   stated fear** — _"hundreds of duplicate or erroneous locations"_ — and the corpus already
   owns the tool (semantic dedup at 0.86 cosine, as story-threads uses). Ships before, and
   independently of, any spatial kernel.
3. **The `Dynamics` union — fold into meter-economy rather than after it.** That plan
   *already* needs energy on an exponential law while five others are linear, and it carves
   energy out as a special case. The union removes the special case. Same work, better shape,
   and it lands with the thing that needs it.
4. **The signal bus's four scores** — `urgency`, `actionUtility`, `narrativeSalience`,
   `observability`. Necessary, not speculative. Adopt the scores; **defer the event-coupled
   fields** (`sourceEventIds`, `candidateActionIds`, `cooldownKey`) that presuppose the
   kernel. That's the shippable 40% of GPT's design.

Plus two framing devices worth adopting wholesale: the **admission contract** (seven
questions before a system is allowed in) and the **sway/interruption model** with its four
gates.

---

## 7. The methodology gap: nobody proposed an experiment that could change the decision

This is the thing four documents are missing, and it's cheap.

GPT's slice tests everything at once (§3.3). My plan tests nothing. Neither proposes a
**spike**: a sub-day experiment, run in the live app, whose *result* changes what gets built
next. Three exist, and each targets one of the load-bearing unknowns:

| Spike | Cost | Tests | If it works | If it doesn't |
| --- | --- | --- | --- | --- |
| **Private fact** — make `witnessedBy` a `WHERE` clause in session retrieval. It's written on every row, read by nothing; the perception machinery already computes concealment and a test already asserts it. Play a 3-character scene where one learns something the others don't. | ~1 day | GPT's entire belief tier — does perspective-safe retrieval visibly improve fiction? | The knowledge ledger is earned; Track B §5 gets priority | The belief tier is speculative and waits |
| **Privacy gate** — one field on scene-memory places; gate the escalation floor on it. Today a crowded café and a locked bedroom are mechanically identical. | ~1 day | Whether space matters *to this product* before building any of it | Locations earn their return through the romance lane, not realism | The spatial layer is scenery and OQ2 should be re-examined |
| **Authority gate** — gate the drive-reveal fold on the reveal band (it's enforced in the prompt, not the fold; a hallucinated reveal is permanent). | ~hours | Whether removing narrator authority costs anything narratively | The §6.1 veto fear is dead for real, on evidence — take authority further | We learn the cost's shape on the cheapest possible case |

Each runs against the live app, on the existing ≥80% blind-enactment bar. **Together they
cost less than a week and they discriminate between the two architectures** — which four
documents and 2,400 lines have not managed to do by argument.

The private-fact spike is the one I'd run first: it's the cheapest, it tests the most
expensive proposal in either GPT doc, and the machinery is already built and inert.

---

## 8. Recommendation

1. **Correct the record** (§1). `developer-notes/CLAUDE.md`'s account of the world-model
   failure is inaccurate in a way that is quoted as settled history in three other docs and
   underwrites the "deprecation license." Fix the account; keep the decision if it's right
   for other reasons.
2. **Fix the ensemble rollback bug** (§5.1). Live, shipped, data-integrity, no kernel
   required. Nothing here is more urgent.
3. **Run the three spikes** (§7). Under a week, and they turn this argument into evidence.
4. **Take the four independently-shippable pieces** (§6) — modifier engine first.
5. **Then decide the kernel**, with spike results in hand and a cost estimate attached —
   which is still the one number nobody has produced.
6. **Consolidate the docs.** Four documents, ~2,400 lines, two north stars, one roadmap
   line, and one `Status:` value that isn't legal (`gpt-sim-design.plan.md` carries
   `proposal / architecture direction`). Also fix the `rhythmOutfitPatch` precedent claim in
   the meter-economy spec (§5.2) and flag `inferScheduleKind` as a knowing text-matching
   debt (§5.3) while that plan is still `next`.

**On the central disagreement:** I came into this thread arguing that authority costs
story, and I had the only apparent evidence. The evidence dissolved on inspection —
the experiment never ran, the one real failure argues *for* gated writes, and the one time
engine authority was reconciled with narrator freedom (`stagedLocationAnchor`), it worked.
GPT's direction has better support than mine. What it still lacks is a cost, a quality
measurement, and a first step that can fail cheaply — and §6 and §7 are those.
