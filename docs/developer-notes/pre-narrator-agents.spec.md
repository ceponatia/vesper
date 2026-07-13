# Pre-narrator intent & guardrail agents — findings + recommendations

> **Sibling specs retired 2026-07-13:** `movement-authority.spec.md` and
> `scheduled-arrivals.spec.md` were deleted — character chat is now the test
> bed for what the world/session model will eventually look like (see
> `CLAUDE.md`), so world-sim design against the current session model was
> retired rather than kept current. References to those specs in this doc are
> **historical**; the brief's `movement`/`appointment`/`check` fields remain
> persisted-not-enforced seams until the direction settles. This doc survives
> because its intake half shipped.

> **Resequenced 2026-06-14:** this work is now **phase 5**. A standalone **phase 4**
> (the body-model build) was inserted ahead of it — see
> [intimate-anatomy-sensory-and-species-spec.phase4.md](finished/intimate-anatomy-sensory-and-species-spec.phase4.md).
> This file was renamed from `*.phase4.md` and its body now reads "phase 5" throughout.

Status: **findings / draft for discussion** (2026-06-14). Phase 5 ("the world
moves"). This report analyses a proposal to run small agents **between the
player's input and the narrator's turn** — to extract intent, resolve targets,
pick relevant attributes, and pre-check the systems the narrator is about to be
asked to honor. It is a sibling of

> **Post-ship reliability follow-ups (2026-06-18):** intake shipped but is
> falling back to regex on **91% of turns** (reasoning-token budget exhaustion +
> an orphaned-call diagnostic leak). Measurement + ordered fixes in
> [pre-narrator-agents.followups.md](pre-narrator-agents.followups.md). Until
> those land, the §4.1 latency estimates and §4.2 resilience ladder do **not**
> describe the agent's behaviour in practice.


> **Update (2026-06-14): Stack A approved and in implementation.** The
> recommendation in §7 is accepted. We are building **Stack A — the single
> latency-hidden intake agent that degrades to today's regex** — scoped to
> **classifier + plumbing only**: the `IntentBrief`, `runIntake` concurrent in
> the pre-turn fan-out, persistence on the turn row, and rewiring the existing
> regex consumers (exposure/glance/awareness) plus the post-turn continuity
> awareness rebuild to read the brief. The brief's `movement`, `appointment`,
> and `check` fields ship as **persisted seams** — recognized and stored, not
> yet enforced; the movement-authority and scheduled-arrivals specs (and a
> future skill-check resolver) consume them later. Explicitly **not** in this
> slice: the movement-authority gate, multi-hop routing, the appointment tick,
> retrieval re-seeding (Stack B), and the mid-stream tag gate (Stack C). Docs
> updated per §10. Open questions B/C (authority owner, appointment creation
> site) remain for those consuming specs.
[movement-authority.spec.md](movement-authority.spec.md) and
[scheduled-arrivals.spec.md](scheduled-arrivals.spec.md): those
two specs each end with a gap that an input-side understanding layer is the
natural place to close.

`phase-5-plan.md` does not exist yet (step 3 of the
[phase-3→4 migration](finished/phase-3-to-4.md)). When it is authored, the open questions
at the bottom fold into its `## Open questions` per the docs convention.

---

## Bottom line up front

- **The idea is sound and now worth building** — but it is a *reversal* of a
  decision the team made deliberately two months ago (followups.phase2.md
  #15/#16), so it has to clear that bar. What changed: phase 5 introduces
  several systems (movement authority, co-travel consent, scheduled arrivals,
  attribute-relevant resolution) whose **trigger lives in the player's input**,
  not in the narration. The post-turn director can't see them in time, and the
  regex intent detector can't understand them. That is a genuinely new need the
  earlier analysis did not have in front of it.
- **The cost is latency to first token, and it is real but bounded.** Today
  nothing blocks narration except deterministic assembly + RAG retrieval. A
  pre-narrator LLM call adds a round-trip *before the player sees any text*. The
  saving grace: the pre-turn already does network round-trips (embeddings +
  pgvector), so an intake agent run **concurrently** with retrieval adds only
  `max(0, intake − retrieval)` to first token, not its full duration.
- **Get the division of labour right and most of the risk evaporates.** The LLM
  should *recognise and classify*; deterministic engine code should *adjudicate
  and enforce*. The narrator should keep receiving a **deterministic digest**
  (today's `buildTurnDigest`), now computed from richer, input-grounded signals
  — never raw LLM prose. This kills the "hallucinated plan" failure mode the
  earlier review (rightly) worried about.
- **Recommendation: build Stack A (a single latency-hidden "intake" agent that
  degrades to today's regex), structured so it can grow into the full guardrail
  mesh of Stack C.** Avoid Stack B (serialising retrieval behind the agent) for
  v1 — it doubles the critical path for a benefit we can get more cheaply.

---

## 1. The proposal, restated

> The player enters their prompt; small agents then determine *what the player
> is trying to do*, *who the target(s) are*, *what attributes are most
> relevant*, and run other pre-narrator checks to facilitate as-yet-unimplemented
> systems — strengthening the guardrails for the narrator before it generates,
> rather than only cleaning up after (today's post-turn director).

Two distinct claims are bundled here, and they have different feasibility:

1. **Intent & entity extraction** ("what is the player doing, to whom, with
   which attributes"). High value, clearly feasible, and the regex layer it
   would replace is already the weakest seam in the pipeline.
2. **Proactive narrator guardrails** ("keep the narrator on track when it
   deviates"). Partly feasible. A pre-turn pass can make the *guardrails the
   narrator receives* much tighter and input-aware — but it **cannot** by
   itself stop the narrator from deviating *mid-generation*; deviations born
   inside the narrator's own stream need a live or post-hoc guard (see §4.5).

Keeping these two claims separate is the single most important framing in this
report. The first is the real prize; the second is achievable but only in
concert with the guards that already exist.

---

## 2. Current state — how a turn flows today

Full detail in [turn-engine.md](../turn-engine.md) and [prompts.md](../prompts.md);
the parts that matter for this proposal:

### 2.1 The critical path to first token has no LLM in it

`pipeline.ts › runNarrationTask › assemblePreTurn` (≈`pipeline.ts:408`) is the
gate. Everything before `streamText` is either deterministic or RAG retrieval:

```
submitTurn → CAS ready→narrating → create turn row → assemblePreTurn:
  • detectIntent (regex, engine/intent.ts) · detectCommsIntent · isOocInput
  • detectDeclaredRest · matchActions (chain cap)
  • stagedLocationAnchor (movement staging + access)  ← deterministic
  • preTurnRetrieve  (episodes ∥ facts ∥ lore — embeddings + pgvector)  ← network
  • recentTurnHistory · recentEpisodes · activeRelationshipFacts (DB)
  • build static rulebook + turn context (pure builders)
→ streamText (narrative model)  ← first token here
```

The retrieval leg (`memory/retrieval.ts:44`) already issues parallel network
round-trips: one `embedText`/`embedTexts` per leg to the embedding API, then a
pgvector query. So **the pre-turn is not latency-free today** — there is already
a network-bound window before first token. This is the window an intake agent
can hide inside (§4.1).

### 2.2 Intent detection today is regex, and it is brittle by design

`engine/intent.ts` is deterministic, case-insensitive regex over quote-stripped
input:

- `detectIntent` → `lookTarget` / `touchTarget` / `smellTarget` / `examineItem`
  / `enterLocation`, with targets matched against participant + item names
  (longest-name-first, nearest-after-verb).
- `detectCommsIntent` → call/text + target NPC.
- `detectDeclaredRest` → sleep/wait with a parsed endpoint.
- `isOocInput` → leading OOC marker.

It is fast, free, and predictable — and that is exactly why it is limited. It
recognises a fixed verb vocabulary and cannot:

- Resolve a target by description or relationship ("kiss her", "ask the
  bartender", "follow him out") — only by literal name match.
- Tell **flavor from command** ("Eleanor steps out of the meeting" reads
  identically to "Eleanor, come with me") — the precise distinction
  [movement-authority-spec](movement-authority.spec.md) §Root-cause #2
  identifies as the corruption that broke session `pyfb0…`.
- Recognise a *negotiated* outcome ("it's a date — my place at 5:30") — the
  trigger [scheduled-arrivals-spec](scheduled-arrivals.spec.md) needs.
- Classify an action's **type or stakes** ("I try to pick the lock", "I make my
  case to her father") — needed for any attribute-relevant resolution.

Every one of these is a phase-5 requirement. The regex layer is at the end of
what it can cheaply express.

### 2.3 Prompt building is already a clean, pure seam to extend

`engine/prompts/` is the one place all prompt text lives; builders are pure
functions of typed inputs (`narrative.ts`, `agents.ts`). The turn context is
assembled block-by-block in `assemblePreTurn` and authority-ordered
([prompts.md](../prompts.md) §Authority ordering). Crucially, the proactive
guardrail already exists in deterministic form:

- **`scene.buildTurnDigest`** — the "This turn" digest, the first block the
  narrator reads: *"Voice freely: Maya." / "May bring in only via a narrated
  arrival: Fatima." / "Never enact: Dr. Green." / blocked-threshold line.* It is
  a pure restatement of the authority blocks below it. This is the **shipped,
  deterministic version of the user's "enumerate what the narrator may do"
  guardrail** (followups.phase2.md #16).

An intake agent does not replace the digest — it *feeds* it. The digest stays
deterministic; its inputs get richer.

### 2.4 The agents that exist, and their timing

Four post-turn agents (`engine/agents.ts`), all `generateChecked` on
`STATE_MODEL` (`google/gemini-2.5-flash`), temperature 0, small single-concern
schemas, run in parallel **after** narration:

| Agent | Concern | Timing problem for guardrails |
| --- | --- | --- |
| simulant | what physically changed | post-hoc; reads the narration |
| archivist | what to remember | post-hoc |
| continuity | what the narration got wrong | post-hoc → *next* turn's correction |
| director | where the story goes next | post-hoc → seeds *next* turn's brief/retrieval |

The director is the closest thing to the user's intent — but it runs at the
*wrong end of the turn*. It pre-games turn N+1 from the end-state of turn N,
before the player has typed N+1's input. The moment the player swerves, the
director's plan is stale: its brief is advisory by design (followups.phase2.md
#16). **That staleness is precisely the gap the user is pointing at, and it is
structural — no amount of director tuning fixes "it ran before it could see the
input it was supposed to guard."**

There is also an unused-for-this `tool` model slot (`toolModelId()`,
`provider.ts:40`, also gemini-flash) — currently only the image scene composer
uses it. It is a natural home for an intake agent's model id.

---

## 3. Prior art — what was decided, and why (intellectual honesty)

This proposal was effectively raised and **passed over** in
followups.phase2.md #15 and #16 (2026-06-12). The reasoning then:

1. **#15:** "No LLM runs between player input and the narrator today — pre-turn
   is retrievals + deterministic checks only, keeping the critical path to first
   token fast. A pre-turn checker can't solve [absent-cast dialogue] anyway: the
   violations are born from the narrator's own mid-generation choices, invisible
   to any input-side check… If richer proactive LLM checking is ever wanted, the
   idiomatic zero-latency slot is a fifth post-turn agent writing next-turn
   constraints into the brief, not a blocking pre-turn call."
2. **#16:** shipped `buildTurnDigest` as "the deterministic version of the
   allowed-actions guardrail," explicitly rejecting "a pre-turn LLM [that] adds a
   blocking round-trip plus a hallucinated-plan risk."

Both conclusions were **correct for the problem in front of them** — keeping a
*present-but-absent-speaker* from being enacted. That problem is born inside the
narration, so an input-side agent genuinely can't catch it, and a deterministic
digest genuinely is the better tool.

What those entries did not have in front of them, and what changes the calculus:

- The phase-5 movement-authority post-mortem (`pyfb0…`), which traces an
  unrecoverable session corruption to an **input-side** misread ("steps out of
  the meeting" → committed NPC displacement) that *no* post-turn agent caught in
  time. This is exactly the class an input-side classifier addresses.
- Scheduled arrivals, whose trigger ("let's meet at 5:30") is a **negotiation in
  the input** the regex cannot parse and the post-turn director sees only after
  the fact.
- The romance-core "consequence loop" (a rebuffed advance → affinity hit +
  memory; [phase-3-to-4.md](finished/phase-3-to-4.md) Bucket 1) — the first system that
  needs *"what attributes are most relevant"* decided **before** the narrator
  resolves the beat.

So this report does not contradict #15/#16; it argues their boundary has moved.
The deterministic digest stays. We add an input-side **classifier** whose output
*feeds* that digest and the new phase-5 deterministic systems.

---

## 4. Feasibility analysis

### 4.1 Latency — the crux (and the parallel-with-retrieval escape)

The only first-order cost is **time to first token**. There are three ways to
place an intake agent relative to retrieval:

| Placement | First-token cost | Can intake re-seed retrieval queries? |
| --- | --- | --- |
| **Concurrent** with retrieval (recommended) | `max(0, T_intake − T_retrieval)` | No (retrieval uses today's brief.memoryQueries) |
| **Before** retrieval (serial) | `T_intake + T_retrieval` | Yes (input-grounded queries) |
| **After** retrieval (serial) | `T_intake` added in full | Yes |

Rough numbers (gemini-flash, temp 0, ≤512 output tokens, small schema): intake
≈ 400–1200 ms; a retrieval leg ≈ 150–400 ms. So **concurrent** placement adds
on the order of a few hundred ms to first token in the worst case, and *zero*
when retrieval is the long pole. **Serial-before** placement roughly doubles the
pre-narration wait — the option #15 was right to reject as a default.

Mitigations, in priority order:

1. **Run concurrent with `preTurnRetrieve`** — fold the intake call into the
   existing `Promise.all` fan-out in `assemblePreTurn` (`pipeline.ts:468`).
2. **Fast model, tiny schema, capped output** — use `toolModelId()`, a
   single-screen schema, `maxOutputTokens` ~512. (The agents already cap at
   4096; intake should be far smaller.)
3. **Hard timeout → deterministic fallback** — wrap with a timeout
   (e.g. 1.5 s); on timeout/failure, fall back to today's `detectIntent` output
   and stream anyway. This is the resilience.md "degraded default over a failed
   turn" rule applied to a new boundary. The turn never blocks on the agent.
4. **Skip when nothing is at stake** — OOC turns, companion-authored turns, and
   trivially-classified inputs (a bare "I wait") can bypass the agent entirely.

The honest residual: even concurrent, there will be turns where intake is the
long pole and the player waits a few hundred ms longer for the first token than
they do today. Whether that is acceptable is a product call (§Open question A).
Streaming masks *total* latency well, but *time-to-first-token* is the felt
metric and this proposal spends some of it.

### 4.2 Resilience & demo mode

`generateChecked` already gives the exact ladder this needs: typed output → one
repair → degraded default, never throws into the pipeline. Demo mode (no API
key) must keep working: intake degrades to `detectIntent` and the turn proceeds.
The fallback path is not an afterthought — it is the *same* code path the engine
runs today, so "intake disabled" is always a safe, tested state.

### 4.3 Cost

One extra flash-class call per player turn. At gemini-2.5-flash pricing with a
small prompt + small output this is a minor fraction of the narration call.
Real, but not a blocker; worth a `log`/diagnostic counter so it is visible.

### 4.4 The hallucinated-plan risk, and how the architecture defuses it

#16's concern: a pre-turn LLM that *plans the turn* can invent a plan the player
didn't ask for, and the narrator may follow it off a cliff. The defuse is to
**never let intake output reach the narrator as instructions**. Intake emits
*typed signals*; deterministic code consumes them:

- Target/attribute/action-type → consumed by the **merge** and the new phase-5
  resolvers (movement authority, attribute checks), never streamed as prose.
- Allowed-actions → folded into the **deterministic** `buildTurnDigest`, which
  by construction only restates authoritative state blocks, never new facts.
- Movement/appointment signals → become `stagedIntents` / `appointments`
  records the engine adjudicates — same pattern scheduled-arrivals already
  endorses ("the LLM recognises *that* an appointment was made; the engine does
  the *when-to-set-out* math").

The narrator's freedom is unchanged. Intake tightens the *constraints*
(deterministically derived) and *enriches the state* the narrator reasons over;
it does not hand the narrator a script.

### 4.5 The honest limit — input-side checks can't catch mid-stream deviations

#15's other point still stands: if the *narrator itself* enacts an absent
character or invents player dialogue mid-generation, no input-side agent sees
it. Those need:

- the **mid-stream tag gate** (followups.phase2.md #15, still open) — pure
  per-chunk code in the pipeline loop, zero added latency, aborts at the
  violating speaker tag; and/or
- the **post-turn continuity** correction (already shipped).

So "keep the narrator on track" is a **three-position** problem — before (intake
guardrails), during (tag gate), after (continuity). Intake owns *before*; it
strengthens but does not subsume the other two. The maximal answer (Stack C)
wires all three.

### 4.6 Division of labour with the director (avoid duplication)

A pre-turn intent pass and the post-turn director would overlap if both "plan
the turn." Resolve by splitting cleanly along the turn boundary:

- **Intake (pre, sees the input):** *this* turn's semantics — action type,
  targets, relevant attributes, movement/co-travel/appointment/comms signals,
  input-grounded memory queries, the allowed-actions inputs.
- **Director (post, sees the narration):** *next* turn's trajectory —
  story-so-far, threads, exposure arc, character notes, staged movement for
  beats not yet earned. Retrospective bookkeeping + forward staging.

Net effect: the director keeps everything it does *well* (it has the finished
narration to summarise) and sheds the thing it does *badly* (guessing the next
input). Intake can also produce better `memoryQueries` than the director's
stale guess — but only if placed serial-before retrieval (§4.1 tradeoff).

---

## 5. The core primitive — an `IntentBrief`

Every stack below is a different amount of machinery around one new typed
object. Sketch (final shape in `contracts/turns/`):

```ts
interface IntentBrief {
  // What the player is doing
  actionType: "converse" | "move" | "observe" | "touch" | "manipulate_item"
            | "comms" | "rest" | "social_attempt" | "intimate" | "meta" | "other";
  // Who/what it is aimed at — RESOLVED to session ids, with confidence
  targets: { participantId?: string; itemId?: string; locationId?: string;
             raw: string; confidence: number }[];
  // Movement authority (movement-authority-spec §1–4)
  movement?: {
    kind: "self" | "narrated_npc" | "co_travel_request" | "implied_subspace";
    destinationLocationId?: string;        // willed destination (may be multi-hop)
    coTravelTargets?: string[];            // NPCs the player invites along
  };
  // Scheduled arrival (scheduled-arrivals-spec) — recognise the deal only
  appointment?: { withParticipantId: string; locationId: string;
                  arrivalMinute: number; reason: string };
  // Attribute-relevant resolution (deferred consequence loop / future checks)
  check?: { relevantAttributeIds: string[]; against?: string; stakes: "low"|"med"|"high" };
  // Retrieval seed (only used if intake runs serial-before retrieval)
  memoryQueries?: string[];
  // Pure-restatement guardrail inputs (NOT prose) for buildTurnDigest
  allowed?: { voiceFreely: string[]; bringInViaArrival: string[]; neverEnact: string[] };
}
```

Two rules keep it safe: (1) **every field is optional and defaulted** — a
degraded/empty `IntentBrief` is exactly today's behaviour; (2) **names resolve
to ids inside the agent boundary** against the session roster, so unresolved
references become diagnostics (like the merge's `*.unresolved`), never invented
entities.

---

## 6. Recommended system stacks

Three options, increasing in ambition. They are **a progression, not
alternatives** — A is the foundation B and C build on.

### Stack A — "Intake" (minimal, latency-hidden) — *recommended for v1*

One pre-narrator agent, run **concurrent** with retrieval, producing the
`IntentBrief`. Consumers:

- `buildTurnDigest` gets richer `allowed` inputs (input-aware: "the player asked
  Eleanor to lunch — co-travel proposal" instead of regex silence).
- The merge / movement authority resolver consumes `movement` to distinguish
  self-move vs. narrated-NPC vs. implied-subspace vs. co-travel
  (movement-authority-spec §1, §3) — the deterministic adjudication stays in the
  merge; intake only *classifies*.
- `appointment` is handed to the scheduled-arrivals tick as a proposal.
- Degrades to `detectIntent` on timeout/failure/demo.

**What it buys:** robust target resolution; the movement-authority misread fixed
at its source; appointment recognition; an input-grounded digest. **Cost:** one
flash call concurrent with retrieval; a few hundred ms worst-case first-token.
**Risk:** low — it is additive, fully degradable, and changes no narrator
freedom.

### Stack B — "Plan-and-narrate" (serial, retrieval re-seeding) — *not recommended for v1*

Stack A, but placed **serial-before retrieval** so the `IntentBrief.memoryQueries`
(input-grounded) drive `preTurnRetrieve` instead of the director's stale seed,
and the director's planning role shrinks to bookkeeping.

**What it adds over A:** materially better retrieval relevance (queries match
what the player *just said*, not what the director guessed last turn). **Cost:**
roughly doubles pre-narration latency (`T_intake + T_retrieval` serial) — the
exact thing #15 rejected. **Verdict:** keep as a *future* option gated on
measured retrieval-miss data; do not pay its latency until A proves the miss is
real. A cheaper partial win: run intake concurrent (Stack A) but fire a *second*
small retrieval leg keyed on intake's queries only when intake lands fast enough
— complexity that should wait.

### Stack C — "Guardrail mesh" (defense in depth) — *the destination*

Stack A **plus** the two complementary guards from §4.5, giving a check at every
temporal position:

- **Before:** intake → tightened deterministic digest (Stack A).
- **During:** the mid-stream tag gate (followups.phase2.md #15) — pure per-chunk
  code, aborts-and-retries once on an absent-speaker tag, zero added latency.
- **After:** continuity correction (shipped) + the movement-authority
  convergence fixes (movement-authority-spec §5).

**What it buys:** the strongest answer to "keep the narrator on track," because
it acknowledges deviations arise at all three positions and guards each with the
*cheapest tool that can*. **Cost:** the tag gate touches the streaming protocol +
feed UX (its own open item). **Verdict:** the right end-state; reach it by
shipping A first, then the tag gate, independently.

| | Stack A | Stack B | Stack C |
| --- | --- | --- | --- |
| Pre-narrator LLM | 1 (concurrent) | 1 (serial) | 1 (concurrent) |
| First-token cost | low | high | low |
| Re-seeds retrieval | no | yes | no |
| Mid-stream gate | no | no | yes |
| Risk | low | medium | medium (protocol) |
| Recommend | **v1** | later, data-gated | end-state |

---

## 7. Recommendation

1. **Ship Stack A.** One intake agent, concurrent with retrieval, emitting a
   fully-defaulted `IntentBrief`, degrading to `detectIntent`. Wire its first
   two consumers to the two phase-5 specs that are already blocked on input-side
   understanding: **movement authority** (classification of self / narrated-NPC
   / implied-subspace / co-travel) and **scheduled arrivals** (appointment
   recognition). These give immediate, demonstrable value against the real
   `pyfb0…` failure.
2. **Measure first-token latency** with intake on vs. off (it is a flag away,
   since the fallback is the live path). Decide the product tolerance
   (§Open question A) on data, not vibes.
3. **Then add the mid-stream tag gate** (Stack C's "during") as an independent
   change — it is zero-latency and orthogonal.
4. **Defer Stack B** until retrieval-miss data justifies paying serial latency.
5. **Re-divide director labour** (§4.6) in the same change that lands intake, so
   the two never duplicate planning.

Sequencing note: intake is also the cleanest substrate for the **attribute /
skill-check** work the user flagged ("what attributes are most relevant"). That
system (the romance "consequence loop", [phase-3-to-4.md](finished/phase-3-to-4.md)
Bucket 1) is not yet specced; intake's `check` field is where it plugs in when
it is. Don't build the resolver now — just leave the seam.

---

## 8. Open questions

- **A. First-token latency tolerance.** What added time-to-first-token is
  acceptable for the intent/guardrail gain? Drives concurrent-vs-serial and
  whether intake is default-on or opt-in per world. (§4.1)
- **B. Authority classification owner.** Movement-authority-spec §1 Open-question
  A asks merge-inferred (pure) vs. simulant `willedBy` (LLM). Intake offers a
  *third* answer: an input-side classifier decides flavor-vs-command **before**
  the merge, which is where the distinction is actually visible. Does intake
  subsume that open question, or feed it? (§5, movement-authority §1)
- **C. Appointment creation site.** Scheduled-arrivals-spec §A puts appointment
  creation on the post-turn director. Intake can recognise the deal *in the
  input* a turn earlier. Director, intake, or both-with-dedup? (§5)
- **D. Retrieval re-seeding (Stack B).** Worth the serial latency? Gate on a
  measured retrieval-miss rate; needs an experiment, not a guess. (§6 Stack B)
- **E. Skip heuristics.** Which inputs bypass intake entirely (OOC, companion
  turns, bare rests, single-clause conversational turns)? Each skip is reclaimed
  latency but a missed classification. (§4.1)
- **F. Schema scope creep.** `IntentBrief` will be tempting to grow. What is the
  v1 minimum (targets + movement + appointment), and what waits (check, emotional
  read, etc.)? (§5)

## 9. What Stack A moves and trims (cleanup map)

The governing constraint: **every post-turn agent reads the narration**, which
does not exist until the narrator runs. So nothing narration-derived can move
earlier — Stack A does **not** let us delete an agent. What it does is (a)
**relocate input-side classification** into the intake slot, demoting the regex
layer to a fallback; (b) **trim now-redundant input-derived guesses** out of the
post-turn agents; and (c) **de-duplicate one derivation** that currently runs
twice. The narration-reading work stays exactly where it is.

### 9.1 Moves into the intake slot (between player and narrator)

| Capability | Today | Under Stack A |
| --- | --- | --- |
| Intent / target resolution | `detectIntent` regex (pre, `engine/intent.ts`) drives glance, exposure, awareness, staging | Intake `IntentBrief.targets` (resolved to ids); **regex demoted to fallback** on timeout/failure/demo |
| Comms staging | `detectCommsIntent` regex (pre) classifies "I call/text X" | Intake `actionType:"comms"` + target; regex → fallback. (Link *persistence* is narration-derived → stays with simulant) |
| Exposure raise / awareness / glance inputs | `raiseExposureForIntent` + `buildAwarenessBlocks`/`buildGlanceImpressions` consume the regex intent (`pipeline.ts:375`, `:651`) | Same builders, now fed `IntentBrief` instead of the regex `SceneIntent` |
| Movement **authority** (flavor vs. command, self / narrated-NPC / implied-subspace / co-travel) | Not modelled — the merge commits any prose-implied move (the `pyfb0…` root cause) | Intake `movement.kind` classifies it **at the input**, where the distinction is visible; merge enforces |
| Player-struck **appointment / co-travel** recognition | Would have to be inferred post-hoc by the director from the narration | Intake `appointment` / `movement.coTravelTargets` recognise the deal from the input a turn earlier |

Note the first three are **relocations within the pre-turn** (deterministic →
LLM-primary, regex kept as the degraded path), not post→pre moves. Only the last
is genuinely lifted off the post-turn director.

### 9.2 Trims from post-turn processing

- **Simulant — player movement becomes redundant.** Today the simulant reports
  `movements` by reading the prose, and the merge applies them with only an
  adjacency + player-not-author check (`merge.ts:1365`, `:1379`). With intake
  classifying the player's *willed* destination and the merge routing it
  deterministically (movement-authority §4), the merge should **prefer the
  intake-derived player move** and stop trusting the simulant's prose-guess for
  the player. The simulant keeps reporting genuine *NPC* end-positions it
  observes in the scene; the player's location stops being an LLM guess. This
  also retires the misread class that stranded `pyfb0…`.
- **Don't add `willedBy` to the simulant.** Movement-authority §1 Open-question A
  floats a simulant `willedBy`/`kind` field (option b) to distinguish "the NPC
  decided to leave" from "the player narrated it." Intake makes that field
  unnecessary — the classification lives at the input, not in a post-turn agent
  re-reading the prose. *Net cleanup: a planned schema growth we now skip.*
- **Don't add a player-deal `scheduleArrival` to the director.** Scheduled-arrivals
  §A proposes the director recognise "it's a date, 5:30, my place" post-hoc.
  Intake recognises it in the input. The director keeps only **director-originated**
  staging (`stageMovement` for beats *it* invents, e.g. "Maya texts: come let me
  in"); player-struck deals route through intake. *Net cleanup: the director's
  remit narrows to what it sees well — the finished narration.*

### 9.3 De-duplication: `detectIntent` runs twice today

The regex intent is derived **twice per normal turn**: once pre-turn in
`assemblePreTurn`, and again post-turn in `agents.ts:142`
(`continuityIntent = detectIntent(...)`) to rebuild the awareness blocks the
continuity agent audits against — deliberately, so the auditor sees what the
narrator saw. With intake, the `IntentBrief` must be **persisted on the turn
row** (alongside `agent_results`) and the post-turn continuity rebuild reads it
back, instead of re-deriving via regex. This both removes the second derivation
*and* guarantees the pre/post consistency the `agents.ts` comments work hard to
preserve. (Persisting it is one small plumbing requirement, not a trim — but it
is the mechanism that makes the trim safe.)

### 9.4 What explicitly stays — and why

**Stays post-turn (narration-derived — cannot move):** the simulant's physical
changes (item events, meters, conditions, activity, affinity-from-deeds, comms
link open/close *persistence*); the archivist (episode + facts); the continuity
agent (all violation detection, incl. `narrated_absent_character` and invented
player dialogue); the director's `storySoFar` / threads / exposure arc /
`characterNotes` / `imageMoment`. Intake can *enrich* these (e.g. handing
continuity ground-truth resolved targets) but cannot replace them.

**Stays deterministic pre-turn (intake does *not* absorb — the registry beats the
LLM):** `detectDeclaredRest` (precise "until 7am" → minutes math feeds the
clock), `matchActions` (action-duration registry + chain cap), `isOocInput` (the
cheap gate that decides whether intake even runs). An LLM is *worse* than these
at structured parsing; keep them primary.

**Stays on the director under Stack A:** `memoryQueries`. Re-seeding retrieval
from intake is **Stack B** (serial latency) — under Stack A retrieval runs
concurrent with intake and still uses the director's seed. Do not trim
`memoryQueries` until/unless Stack B is justified by retrieval-miss data (§6,
Open question D).

## 10. Docs to update when implementing

`turn-engine.md` (pre-turn: intake agent in the fan-out, its degraded default,
the consumer list), `prompts.md` (intake system prompt + state slice; the digest
now consumes intake's `allowed`), `contracts/turns.md` (`IntentBrief` schema, the
`tool`-model role), `resilience.md` (intake's timeout→regex fallback as a worked
example of a new trust boundary), and cross-links from
[movement-authority-spec](movement-authority.spec.md) §1/§3 and
[scheduled-arrivals-spec](scheduled-arrivals.spec.md) §A (intake supplies
the input-side recognition both assume someone does).
