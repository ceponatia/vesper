# Reading GPT Sol's successor design against mine — a supplemental

Status: **supplemental analysis** — not a plan, carries no roadmap line, commits nothing.

Companion to [gpt-sim-design.plan.md](gpt-sim-design.plan.md) (GPT Sol, 2026-07-16) and
[world-engine-refactor.plan.md](world-engine-refactor.plan.md) (Claude, same day, same
brief). Two independent passes at "design a realistic world simulation for Vesper." This
doc is the diff: what survives contact between them, what each missed, and the one
reframing that I think resolves the disagreement.

**Headline:** GPT's diagnosis is better than mine and its prescription is too big for this
project. Every concrete code claim it makes checks out — I verified all of them, and one
of them falsifies a premise I built on. But its migration plan is a multi-year kernel
rewrite for a solo developer whose working asset is the thing the rewrite puts at risk.
The interesting question neither doc asks is in §6.

---

## 1. Verification first — GPT's claims all hold

This reprices everything below, so it goes first. I ran two adversarial passes over the
code against GPT's specific assertions. **Every one verified.** Three are worse than
stated.

| GPT's claim | Verdict | Evidence |
| --- | --- | --- |
| `witnessedBy` written but not consumed as a retrieval permission | **VERIFIED** | 6 write sites, **0 read sites**. Not one SQL filter. `schema.ts:1047`: _"write-only until the knowledge ledger ships."_ |
| `canon` always true, no belief/lie producer | **VERIFIED, worse** | **Nothing writes `canon` at all** — every row takes the DDL default. No agent schema can express it (`factDraftSchema` has no such field). And there's no *read* gate either: a `canon = false` row would be **retrieved and rendered to the narrator as truth**. |
| `FactHit` drops `subjectId`, witnesses, canon, temporal validity | **VERIFIED, understated** | `FactHit` keeps 7 of 24 columns — but it isn't what reaches the prompt. `retrieval.ts:61` and `chat-memory.ts:135` flatten it to `h.text`. **The narrator gets a bare unattributed sentence**: no subject handle, no provenance, no time. |
| Facts lack object identity and valid-time | **VERIFIED** | Zero `valid_from`/`valid_to` anywhere; only transaction time. Subject IS normalized — **session lane only**. `facts.ts:124`: _"When either side lacks an id (**all chat-lane drafts today**)… fall back to lowercased-name equality."_ Object identity exists in neither lane; facts are `(subject, prose)`, never `(subject, predicate, object)`. |
| Episodes lack actors/location/type/salience/affect/causality | **VERIFIED** | The column list is exactly as GPT enumerates. **Salience is computed and discarded** — `phaseWitness` derives it, persists neither it nor the perceivers as queryable data. |
| Keyed lock is single-machine | **VERIFIED** | `keyed-lock.ts:1-7` says so verbatim. **Nothing enforces it**: `fly.toml:21-23` sets `min_machines_running = 1` — a floor, not a ceiling. One `fly scale count 2` silently invalidates the premise with no failed assertion. |
| Job runner single-instance, claims atomic | **VERIFIED — and the "although" misleads** | Claims *are* atomic (`jobs.ts:182`), so no double-processing. But the comment's own headline guarantee — _"strictly serial per session"_ — **breaks** on two machines: `kickSession` dedupes via an in-process map, so both machines drain the same session concurrently, each claiming a different job. The scaling risk is **ordering**, not duplication, and atomicity does nothing for it. |
| Schedules are free-form strings; action registry has shallow preconditions | **VERIFIED / too kind** | `locationName` and `activity` are bare `z.string().min(1)`. Preconditions aren't shallow — **there are none.** The one precondition-shaped field, `requiredTier`, is self-documented as unused and **set by zero of the 7 definitions**. You can `shower` with no bathroom, no water, and no privacy. **And the chat lane doesn't use this registry at all** — `matchActions` has two consumers, both session-lane. |

GPT's `finished/` warning also lands: _"placement under `finished/` does not reliably mean
a design was fully implemented."_ Correct, and it's a live docs hazard —
`finished/offscreen-simulation-spec.phase3.md` describes an LOD world-tick that **was never
built in either repo**, sitting in a folder whose name asserts otherwise. Worth a real fix
(a `Status:` line on the inherited phase-3 specs, or a `finished/inherited/` split);
`CLAUDE.md`'s own wording — _"the historical record of already-run phases"_ — is what's
imprecise, since that phase never ran.

---

## 2. The big one — GPT saw that the narrator is the world's authority. I missed it.

This is the finding that matters most, and I want to be plain that I didn't have it.

My doc lists as **law #3 to respect**: _"the teamwork playbook — the agents propose, the
deterministic folds dispose."_ I treated that as a description of the architecture. GPT
read the same corpus and asked whether it's *true*.

It mostly isn't. I verified the chat lane field by field:

| Concern | Who actually decides | Can the narrator create it by writing prose? |
| --- | --- | --- |
| **Meters** | **Code** — pulse classifies, the §6 curve computes; `chat-pulse.ts:9-11`: _"the schema carries no deltas"_ | **No** |
| **Plans → `missed`** | **Code** — `advancePlans` off the clock; _"the archivist may set kept/canceled/upcoming but NEVER missed"_ | **No** |
| **Selfies** | **Code** — deterministic pre-narration arming; the prose read only confirms | **No** |
| Wardrobe / outfit | **Narrator** — `foldOutfitProposal` parses the reply | **Yes** |
| Presence (ensemble) | **Narrator** | **Yes** |
| Plans struck / kept / canceled | **Narrator** | **Yes** |
| **Drives / secrets revealed** | **Narrator** — and `revealed: drive.revealed \|\| update.revealed` **ratchets** | **Yes, permanently** |
| Facts / what happened | **Narrator** | **Yes** |
| Scene / location | **Narrator wins ties** — the pre-narration read is regex over *player input only* | **Yes** |
| Supporting cast | **Narrator** | **Yes** |
| Appearance overlays | **Narrator** | **Yes** |

"Propose and dispose" is real for **meters, `plans.missed`, and selfies**. Everywhere else
the "deterministic fold" is a *parser of the narrator's prose* — it caps and dedups what
the story said, it doesn't decide it. GPT's phrasing is exact: _"prose is effectively
executing game logic after the fact."_

**The detail that makes this indefensible as an oversight:** the codebase already knows the
right pattern, documents it in prose, and applies it to exactly one field.
`chat-state.ts:1461-1466`, on selfies:

> _"The pulse's `sentPhoto` read only queues a render when one of these armed it — a
> hallucinated 'sending you a pic' on an unarmed turn stays fiction."_

Arm deterministically before; let the prose read only confirm. That contract exists for
selfies and for nothing else that matters. A hallucinated secret reveal is **permanent**
(it ratchets, mints a `secret_shared` milestone, boosts callbacks, and gates trait
evolution). The reveal band is enforced in the *prompt* and not in the *fold*.

I built a 60-item catalog on top of an architecture whose authority model I hadn't checked.
That's the single biggest gap between the two documents, and it's mine.

### Which means GPT's executive line is a direct hit on my doc

> _"The target is causal realism: the player can observe consequences, investigate them,
> and receive a consistent answer about why they occurred. That produces more believable
> life than hundreds of disconnected meters."_

My doc is, substantially, hundreds of disconnected meters. Its best entries — derived
weather, illness emerging from sleep debt and cold exposure, `weatherOutfitPatch` — are
the ones that are *causal*. The rest are pips. GPT is right about the priority ordering and
I had it backwards: **causality first, then the ambient layer as its texture.**

---

## 3. Where we independently agree

Convergence from different starting points is the strongest signal in these two docs. Treat
this list as settled:

1. **Do not revive the session world model literally.** Both, emphatically.
2. **No per-minute, per-NPC simulation.** GPT: an event-driven priority queue draining to
   the target time. Me: lazy derivation, values computed analytically at read. **These are
   the same idea from two directions** — GPT's _"continuous values store their last
   integration time and calculate their current value analytically when read"_ is precisely
   my thesis, and it's also exactly what the meter-economy plan's `metersAtMinutes` +
   exponential decay already does. Three independent derivations of one design. That's the
   most load-bearing agreement here.
3. **Don't make everything a 0–1 meter.** GPT's ten state kinds vs. my five-class taxonomy
   (inherited from the meter-economy spec). GPT's is better — see §4.
4. **The meter registry conflates substrate, drift, UI bands, and prose.** Both say split;
   this is the meter-economy spec's substrate/read law, independently re-derived.
5. **`promptHint` prose must leave the physiological definition** and become a
   perception-gated derivation over value × clothing × lighting × distance × attention.
   Same conclusion, same reasoning.
6. **Environment is highly feasible in deterministic code.** Weather, daylight,
   temperature, noise, crowding, privacy. Both.
7. **`canon`/belief is dead weight awaiting a producer.** Both.
8. **LOD is necessary.** Both — for different reasons; see §5.
9. **Nothing slow before the reply.** GPT: _"normally only the narrator is on the
   synchronous model path."_ Me: T5 is closed. (With one exception — §6.4.)
10. **Places need properties** — privacy, access, occupancy, acoustics. GPT wants a full
    containment graph; I want inert property bags. Same need, different scope.

---

## 4. What GPT has that I don't

Beyond §2, honestly enumerated:

- **The three-layer separation: world truth / character belief / narrative presentation.**
  I had "belief vs. truth" as a one-line catalog entry (E.4). GPT makes it structural, and
  the verification says it's the right call: `witnessedBy` inert, `canon` never written,
  no ledger, retrieval unable to distinguish _"true now"_ from _"Alice believes"_ from
  _"Bob falsely told Alice."_ The narrator receiving belief as unlabeled truth is a real
  present-tense defect, not a future feature.
- **A better state taxonomy.** GPT adds **Resource** (conserved, transferable),
  **Capability** (slow-changing constraint), **Commitment** (a state machine), and
  **Belief** (per-knower, sourced) to the reserve/load/valence/phase/condition set. Those
  four are genuinely missing from the corpus's taxonomy and from my doc, and each names a
  thing that is *not* a meter and was going to get modeled as one.
- **Hunger ≠ mealtime.** The sharpest specific catch in either document, and it's an
  actionable correction to a **queued plan**. Body-needs proposes
  `read = clamp(−1, +1, satiation − pressure)` with zero at *her usual mealtime*, by
  analogy to energy. GPT: _"A usual mealtime can modify expectation, habit, and action
  selection; it should not redefine whether a body is physiologically hungry."_ **The
  analogy doesn't transfer.** Circadian pressure (Process C) is genuine physiology; a
  mealtime is a learned habit. Conflating them means a character who ate an hour ago reads
  as hungry when her usual mealtime arrives. The energy formula's justification is
  biological; the hunger version's is not. **This should be raised on body-needs before it
  leaves draft.**
- **The bladder/needs-channel inconsistency.** Body-needs makes bladder a **load** meter,
  and makes the needs channel fire when a **deficit read goes negative**. A filling load
  has no negative pole — its need is at the *top*. So either bladder can't emit a need or
  the channel needs a second shape. GPT flagged the seam; I adopted the channel without
  noticing it doesn't fit its own third member.
- **Utility AI / GOAP for background NPC choice.** Neither my doc nor the corpus has any
  answer to _"how does an off-screen NPC decide what to do?"_ — today it's the meanwhile
  agent inventing it. GPT's utility scoring with seeded tie-breaks is a real, cheap,
  deterministic answer. My salience bus ranks *which want surfaces in the prompt*; GPT's
  utility model chooses *which action an NPC takes*. Different problems; I only had one of
  them, and GPT's is the one that produces causality.
- **`character_chat_state` as a contention surface.** 30 columns, unrelated subsystems on
  one row, arrays without identity, "another take" on a single opaque snapshot. I never
  looked at the row as a scaling object.
- **Soft canon with explicit scope, expiry, and audited promotion.** The clean mechanism
  for keeping narrator freedom while removing narrator authority. My doc has no answer here
  at all.
- **The vertical-slice acceptance test.** A concrete falsifiable bar before broadening. I
  had a sequencing sketch and no test. (Though see §6.2 — it tests the wrong thing.)

---

## 5. What I have that GPT doesn't

- **An economic model.** GPT's feasibility column is High/Medium/Low with no cost. My T0–T5
  ladder prices every proposal in calls and latency. GPT's doc cannot answer "what does
  this cost per exchange," and for a project whose hard-won lesson is about turn latency,
  that's a real omission.
- **The live latency facts.** `CHAT_PULSE_TIMEOUT_MS`, `CHAT_EXTRACTOR_TIMEOUT_MS`, and
  `CHAT_PERSONAL_NOTES_TIMEOUT_MS` are **all at 60_000** right now — a dated, marked-REVERT
  diagnostic (`constants.ts:107-112`) to measure DeepSeek 4 Flash's real latency, because
  it was timing out at 8–10s on tiny structured calls. The settle holds the exchange lock.
  **Any proposal adding post-reply legs is blocked on that measurement landing**, and
  GPT's architecture adds several.
- **The actual scaling wall.** GPT's LOD section rations *NPC simulation*. But the live
  linear cost is the **settle**: a 4-member roster is ~10 model calls per exchange
  (narrator + pulse + 3 extractors + 3 members × 2), all inside the lock, linear in roster
  size — against an explicit direction of "less 1-on-1 focused." **The sim is not the
  scaling problem; the settle is.** GPT never counts this.
- **Romance-lane ranking.** GPT's doc is genre-neutral — factions, law, districts,
  employment, macroeconomy, illness prevalence, housing pressure. It would be the same
  document for a colony sim or a detective game. Vesper is an intimate two-person romance
  app. GPT's "infeasible or counterproductive" list has no entry for *"realistic, and
  irrelevant to the drama."* The most realistic world is not the most romantic one, and
  nothing in GPT's doc adjudicates that.
- **The D3/D8 reversibility corollary** — deriving keeps the wall-clock question open at
  zero cost.
- **Cross-chat continuity named as the open product question.** Interesting: GPT's
  world/branch ID model *implicitly answers* it (a world holds characters; chats are views)
  without ever asking it. **That's the strongest answer anyone has to my H.1**, arrived at
  sideways.

---

## 6. What both of us missed

### 6.1 — The project already ran this experiment, and neither doc cites the result

This is the most important thing in this document.

The session lane had authoritative state: real locations, real movement, schedules moving
NPCs between them. Per `developer-notes/CLAUDE.md`, it _"became somewhat broken — we
weren't able to get characters to move to locations in a timely fashion to keep the story
going, **which broke the narrative aspect of the game**."_ The team fled to a lane where
the narrator is authoritative over nearly everything — and narrative quality soared. It's
now the whole product.

That is not a coincidence, and it is not merely an engineering failure. **Narrative quality
and world authority are in tension, and Vesper has already measured it once, in the only
way that counts: by abandoning one side.**

GPT proposes swinging back toward authority with better engineering (stable IDs, event
resolution, a scheduler). Its answer to the old failure is implicit: the old system was
*badly built*. Maybe. But the failure mode wasn't a race condition — it was that
authoritative state **told the story it had to wait**. Better engineering makes the
authority *correct*; it doesn't make it *narratively free*. GPT's doc gives this one
sentence at the very end (_"Keep the current chat lane as the narrative-quality
benchmark"_), which is the right instinct and roughly 1% of the doc's weight. My doc
doesn't raise it at all.

**The reframe that I think resolves the disagreement.** Not all authority is alike. Split
it three ways by *when it acts*:

| | What it does | Narrative cost | Examples |
| --- | --- | --- | --- |
| **Authority as INPUT** (before) | Derives or arms a fact the narrator then plays | **Free — it grounds** | Weather, meters, needs, plan due-ness, privacy, selfie arming, what she's wearing now, circadian pressure |
| **Authority as VETO** (during) | Blocks or contradicts what the story wants | **Ruinous — this is what broke** | Movement gating, "she can't be here yet," precondition failures mid-scene |
| **Authority as ADJUDICATION** (after) | Decides whether prose became truth | **The live defect** | Secret revealed, plan kept, item moved, presence changed |

Read this way, the two docs stop conflicting on most of their surface. My entire catalog is
**category 1** — which is why it's cheap and safe, and also why it's *shallow*: inputs
alone don't make causality. GPT's diagnosis lands almost entirely on **category 3** — where
it's correct and the fix is small and local. GPT's *prescription* (a containment graph,
travel, access, preconditions, an action kernel) reintroduces **category 2**, which is the
thing with a body count.

**Design rule that falls out: derive and arm before; never veto during; gate ratchets
after.** Weather is authoritative and costs nothing narratively because it's an input.
Movement was authoritative and cost everything because it was a veto. A revealed secret is
the live bug because it's an unguarded ratchet.

### 6.2 — Neither doc proposes to measure whether any of this improves the product

The corpus's own record (my §C13 synthesis) is that it is **shipping faster than it
measures**: three shipped systems rest on unmeasured design arguments, all blocked on the
same owner-gated eval spend, and `CHAT_PROMPT_LAYOUT=turn_context` is *still default off
pending an A/B that hasn't run*.

Both docs then propose large additions with no measurement. GPT's vertical slice is
excellent and tests the **wrong axis** — replay determinism, event throughput, perspective
safety. All correctness. None of it asks whether a player *notices or cares*. A world that
replays deterministically and reads identically is a very expensive no-op.

The cheap test both docs should have proposed: **blind A/B on transcripts** with and
without the world reads, judged on the same enactment bar the corpus already uses (≥80%
blind identification). Weather, hunger, and privacy either change the prose in ways a judge
can detect, or they don't. That is a day of work and it gates everything else in both
documents.

### 6.3 — Neither doc has an interaction surface

Both design a world the player cannot touch. If it's raining, the player learns this only
if the narrator mentions it. They can't check, plan around it, or act on it. GPT gets
closest — _"the player can observe consequences, investigate them"_ — and then proposes
developer observability instead of a player surface.

There's a surface waiting: `chat-clock-calendar.plan.md`'s **open question C** ("right-aside
tenants — what else lands there? Lean: clock-only v1"). A sim with no interrogation surface
is set dressing, however causal it is underneath.

### 6.4 — Neither doc costs a single week, and GPT's quietly reopens T5

GPT's migration is six phases ending in factions, law, district markets, and illness
spread. That is years for a solo developer. Mine is "opportunistic." Neither says *this is
three days* or *this is six months*, which is the only number that decides anything here.

And GPT's **input interpreter** ("Only when needed: map free-form player language onto
candidate commands") is a **pre-reply model call** — T5, which the corpus closed after
intake's 91% timeout-fallback rate. A command-shaped world genuinely needs it, which makes
this a real, unnamed conflict: **GPT's architecture cannot be adopted without reopening the
one latency decision the corpus is most confident about.**

### 6.5 — The chat lane's quality is the asset, and both docs put machinery under it

Neither seriously assesses regression risk to the one thing that works.

---

## 7. Synthesis — the middle path neither doc proposes

GPT is right about **what's broken**. I'm right about **what's affordable**. Neither of us
proposed the cheap version of GPT's diagnosis, and it exists, because *the codebase already
has the pattern*.

**You don't need a kernel to fix category-3 authority. You need to extend arm-then-confirm
to the short list of state that ratchets.** In the current architecture, no rewrite:

1. **Gate the drive-reveal fold on the reveal band, not just the prompt.** Today the band
   is enforced in prose instructions and `revealed: drive.revealed || update.revealed`
   ratchets permanently on the narrator's word. A hallucinated reveal is forever. This is a
   handful of lines and it's the highest-severity item in either document.
2. **Gate `plans.kept` on the clock having reached the target.** `missed` is already
   deterministic; `kept` takes the narrator's word. Asymmetric for no reason.
3. **Write `canon`.** Give `factDraftSchema` the field, let the extractor mark a stated
   falsehood, and — critically — add the *read* gate, since a `canon = false` row today
   would be served to the narrator as truth. The drives system already ships a scoped lie
   license with no way to record that a lie was told.
4. **Consume `witnessedBy` in session-lane retrieval.** The perception machinery already
   computes it and a test already asserts concealment works. It buys nothing because
   nothing reads it. This is a `where` clause away from making an existing system real.
5. **Then, and only then**, the ambient layer (my §B) — derived weather, daylight,
   temperature, `weatherOutfitPatch`. It's cheap, it's category-1, and it's *texture on
   causality* rather than a substitute for it.

That sequence is weeks, not years. It captures most of GPT's diagnosis, adds zero category-2
veto surface, needs no new tables, no event journal, and no new agent legs. **If it lands
and the world still feels dead, GPT's kernel is the right next argument and will have earned
its evidence.** If it lands and the world feels alive, the kernel was never needed.

On the specific structural proposals: GPT's **belief ledger** is the one piece of its
architecture I'd promote independently of the kernel — the verification shows the columns
exist, are written, and have no reader, which means the design was already believed in and
just never finished. Its **soft canon** mechanism is the right way to keep narrator freedom
while removing narrator authority, and it's adoptable in isolation.

---

## 8. Questions for the owner

Ordered by how much they gate.

1. **Is narrative quality allowed to regress at all?** If no, GPT's kernel is out on
   arrival — every category-2 constraint spends narrative latitude, and the project has
   already run this experiment once (§6.1). If a temporary dip is acceptable in exchange
   for causal depth, the calculus changes completely. **Nothing else in either document
   can be decided before this.**
2. **Causality or texture?** GPT: the player should be able to ask "why did she leave?"
   and get a structured causal answer. Me: the world should feel lived-in without new
   machinery. These are not the same product. My §7 assumes texture-with-causal-fixes;
   GPT assumes causal-first.
3. **Does the sim get an eval before it gets more scope?** (§6.2) The corpus already ships
   faster than it measures; both docs make that worse.
4. **Is `character_chat_state` allowed to normalize?** GPT's contention argument is sound
   independent of everything else. This is decidable on its own.
5. **Do these three documents consolidate?** [gpt-sim-design.plan.md](gpt-sim-design.plan.md)
   carries `Status: proposal / architecture direction` — not one of the legal values
   (draft/next/active/shipped/parked) — and has **no roadmap line**, which
   `CLAUDE.md` requires of a `.plan.md`. Mine has a line as a draft umbrella. Two north-star
   docs pointing different directions is exactly the state the roadmap exists to prevent.
   Suggested: one survives as the umbrella, the other becomes its `.spec.md` or a
   `<topic>.deferred.md`; this supplemental folds into whichever wins.

---

## 9. Corrections owed to the existing docs

Independent of any decision above, these are findings that should reach their owners:

- **[chat-body-needs.plan.md](chat-body-needs.plan.md)** — the hunger/mealtime conflation
  (§4) and the bladder/needs-channel mismatch (§4). Both land while it's still **draft**,
  which is the cheapest moment they will ever be worth.
- **[world-engine-refactor.plan.md](world-engine-refactor.plan.md)** (mine) — law #3 is
  aspirational, not descriptive (§2). The doc should say so rather than cite the playbook
  as settled fact.
- **`CLAUDE.md` / `finished/`** — the folder asserts "shipped" over inherited phase-3 specs
  that were never built in either repo (§1).
- **`keyed-lock.ts` / `fly.toml`** — the single-machine premise is load-bearing, correct
  today, and enforced only by a comment (§1). A startup assertion would cost one line.
- **`docs/memory.md`** — honest that `witnessedBy` "waits on its reader" and `canon` is
  "ignored by retrieval for now." Worth stating the sharper form: a `canon = false` row
  written today would be **rendered to the narrator as truth**. That's a trap, not a
  pending feature.
