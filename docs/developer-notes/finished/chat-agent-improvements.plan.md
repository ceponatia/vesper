# Chat agent improvements — a tune-up for the helpers behind every reply

Status: **shipped — 2026-07-14** (all five slices, in one pass. Written the same
day from an agent-architecture review of the character-chat lane, on owner
request; built on the owner's rulings below. Deliberately written in plain
language — the recommendations are preserved as written, with a §Completion
section at the end recording what actually shipped, the two places the build
deviated from the plan, and what is left.)

**Owner rulings (2026-07-14, before the build):**

- **Stage 1b — split live now**, not behind a flag: the three specialists are
  the live extraction path.
- **Tail digest — order AND defer**: crowded turns drop the low-priority notes,
  not just reorder them. (The build found the deferral has to happen *pre-burn*,
  in the pipeline gate rather than the prompt builder — see §Completion.)
- **Deploy + verify on Fly** after the gates.

## The cast of helpers today (a plain-language map)

Every message you send in a character chat is handled by one visible AI and a
small crew of invisible helpers:

| Helper | When it runs | What it does |
| --- | --- | --- |
| **The Narrator** | Immediately — it *is* the reply | Writes the character's answer, working from a large briefing document (the "prompt") assembled fresh each turn |
| **Memory lookup** | Just before the Narrator starts | Searches the chat's long-term memory for facts and past scenes relevant to what you just said |
| **The Pulse** | Quietly, after the reply is sent | Reads the exchange and judges how it landed emotionally — did the character warm up, get hurt, get flustered? |
| **The Archivist** | Quietly, after the reply, alongside the Pulse | The note-taker: writes down what happened, what's worth remembering long-term, what the character is wearing now, where the scene is, who was mentioned, whether the reply sounded in-character… **thirteen separate jobs** in one pass |
| **Personal note-takers** | Group chats only, after the reply | A small pass per present group member tracking just that character's own things (promises, outfit, drives) |
| **The Recap editor** | Occasionally, in the background | Folds the oldest lines of a long conversation into a running summary so nothing is forgotten |
| **The Location artist** | Occasionally, in the background | When the story enters a new place, sketches what it looks like so future scene images and narration stay consistent |
| **Image helpers** | On demand / in the background | Selfies, scene pictures, "look" reference photos, and reading photos the player sends |

Two design rules the lane already gets right, worth stating because every
recommendation below preserves them:

- **Nothing slow runs before the reply.** The only pre-reply work is the memory
  lookup; every judgment call happens after the reply has already streamed, so
  the player never waits on a helper.
- **A failed helper never breaks a turn.** Every helper degrades to "no notes
  this time" with a logged diagnostic; the reply the player already got is
  never taken back.

## What the review found

### 1. The Archivist wears too many hats — and is about to get another

The Archivist started as "summarize the exchange and file the facts." It has
since absorbed eleven more jobs (outfit tracking, scene tracking, side-character
tracking, presence, drives, voice quality-control, personality evolution…), each
with its own paragraph of instructions and special cases. Its instruction sheet
is now several pages long, and the model has to keep all thirteen assignments in
mind while reading every exchange.

That matters because the two features queued next on the roadmap both lean on
it further: **Chat plans & promises** adds a fourteenth job (recognize when a
date or promise is struck), and **Chat off-screen life** adds a cousin agent
that reuses several of the same jobs. Crowded instruction sheets have a known
failure mode: the rare jobs (a haircut, a personality shift, a new side
character) quietly get less attention because the model's focus is spread thin.

Smaller signs of strain are already visible in the file itself: the
instructions say "produce thirteen fields" (a count that has to be hand-edited
every time a job is added), and its own worked examples only show 8–10 of the
13 fields — harmless mechanically (missing fields default to empty), but the
examples teach the model a sloppier standard than the instructions demand.

### 2. Group-chat bookkeeping runs one character at a time

After a group-chat reply, each present member's Pulse + personal note-taker run
**in sequence** — character A finishes before character B starts. All of this
happens while the conversation is locked (the lock is what stops two replies
trampling each other's notes). With a full roster of four, that's up to four
back-to-back rounds of AI calls holding the lock — so a fast typer's next
message is told "busy, try again" for noticeably longer than it needs to be.
The work is independent per character and their notes are saved to separate
rows, so it can safely run all-at-once.

### 3. The same text gets fingerprinted two or three times

To search memory, text is first converted into a "search fingerprint" (an
embedding — a list of numbers that lets similar ideas find each other). Today
the fact search and the scene/episode search each fingerprint **the same query
text separately**, and the "remember when…" callback feature fingerprints the
player's message a third time. This is the one bit of waste that sits on the
**pre-reply** path — the part the player actually waits on. Fingerprinting
once and sharing the result is a small, safe win on every single message.

### 4. The end-of-prompt pile of sticky notes keeps growing

The Narrator's briefing ends with the "volatile tail" — the per-turn notes:
current state, the scene, time-skip notices, a sensory allowance, a possible
"remember when" prompt, a possible selfie license, a possible voice correction,
a possible out-of-character note, and more. There are now roughly **a dozen
possible one-turn notes**, each added by a different feature at a different
time, with no overall ordering rule or cap. The two queued roadmap features
will add several more (a Plans note, a "meanwhile" note, daily-rhythm lines).

The session lane already solved this shape of problem with a short "This turn"
digest — one organized, prioritized block instead of a pile. The chat lane
should grow the same organizer before the pile gets taller.

### 5. Copy-pasted instructions between helpers

The group-chat personal note-taker's instructions for "open loops," "attribute
changes," and "drives" are near-verbatim copies of the Archivist's paragraphs
for the same fields. Two copies means every future wording fix has to be made
twice — and they *will* drift apart.

### 6. Small overlaps in the Narrator's rulebook

The chat rulebook was heavily consolidated in July (an external review pass)
and is in good shape, but a few overlaps remain. Rule 8 ("respond directly to
what was heard before adding anything new") restates the first bullet of the
"Shaping each reply" block ("resolve, then one move"). Several retired rule
wordings are kept in the file as large "rollback" comments — deliberate at the
time, but they can be cleared once the pending behavior evaluation confirms
the new wordings (they are recorded in the consolidation plan either way).

## Recommendations

### Slice 1 — a shared "field library," then specialist note-takers

This is the big one, in two stages so the risky half is optional:

**Stage 1a — build the field library (no behavior change).** This codebase's
signature move is the *registry*: define a thing once as data, compose
everywhere. Apply it to extraction jobs. Each of the Archivist's thirteen
jobs becomes one self-contained "field module": its instruction paragraph, its
worked example, its expected output shape, and the code that folds its answer
into storage. The Archivist's prompt is then *assembled* from modules instead
of hand-written — and the personal note-taker becomes literally "the same four
modules, composed for one character," deleting the copy-paste. The
hand-counted "thirteen fields" wording and the inconsistent examples fix
themselves, because both are generated from the library.

Payoff even if nothing else changes: adding the roadmap's **plans** field
becomes "write one new module and slot it in" instead of threading a
fourteenth job through a monolithic prompt by hand.

**Stage 1b — split the Archivist into 2–3 specialists (owner-gated).** Once
jobs are modules, regrouping them is a composition change, not a rewrite.
The natural split:

- **Memory scribe** — what happened, durable facts, what to look up next turn
  (the jobs that feed long-term memory; the most valuable and most
  attention-hungry).
- **Continuity tracker** — scene, outfit, appearance changes, who's present,
  side characters (the "state of the world" jobs).
- **Character & commitments tracker** — open loops, drives, voice exemplar,
  character-slip check, personality nudges — and the future **plans** field,
  which is commitments-shaped and belongs here.

All three run **in parallel in the same after-the-reply slot** the Archivist
occupies today, so perceived latency doesn't change. The honest trade-off is
cost: two extra small model calls per exchange (each with a much shorter
instruction sheet, so total tokens rise less than 3× — but they do rise). The
expected return is quality on the rare fields: each specialist holds 4–5
assignments instead of 13. Recommended path: land 1a regardless; try 1b
behind a comparison (same test conversations, one week each way, or the
existing eval harness) before committing.

### Slice 2 — settle group members all at once

Change the after-reply group loop from one-character-at-a-time to
all-at-the-same-time. Same calls, same notes, same per-character save rows —
just simultaneous. The conversation lock is released sooner, so rapid-fire
group chatting stops bumping into "busy" as often. Small, contained, and
independent of everything else here.

### Slice 3 — fingerprint once, share everywhere

Compute each query's search fingerprint once per message and hand it to the
fact search, the episode search, and (when it runs) the callback picker,
instead of each computing its own. Shaves duplicate work off the only part of
the turn the player actually waits on. Also small and independent.

### Slice 4 — one organized "Right now" note instead of a pile

Give the chat prompt the session lane's trick: a single deterministic
organizer that gathers the one-turn notes, orders them by a declared priority
(binding gates first, licenses second, flavor last), and applies a soft cap so
one turn never carries six competing "special notes" (defer what can wait —
e.g., a "remember when" nudge yields to a time-skip notice; both would fight
for the same beat anyway). This is pure assembly code — no new AI call — and
it's the piece that keeps the queued Plans note and "meanwhile" note from
making the pile worse.

### Slice 5 — wording cleanup pass

A half-day, zero-risk batch: fold rule 8 into the shaping block; align the
Archivist's examples with its field list (or state the omission rule
outright — moot if Stage 1a lands first); drop the hand-maintained field
count; and, once the pending enactment evaluation rules on the softened
wordings, clear the retired rollback comment blocks from the rulebook file.

## How this fits the roadmap (read before building the queued plans)

- **Chat plans & promises** (next in queue): its Slice 1 says "a new archivist
  field `plans`." If Stage 1a lands first, that field arrives as a library
  module — same behavior, far cleaner landing, and the plan's open question
  about where plan-vs-open-loop guidance lives gets a one-place answer. Its
  pulse-context addition ("the character knows she was stood up") is untouched
  by anything here.
- **Chat off-screen life** (queued after): its "meanwhile pass" is explicitly
  an archivist-class agent proposing drive progress, side-character beats, and
  plan outcomes — i.e., **another composition of the same field modules**, with
  the same fold code reused. Building it against the field library instead of
  as a fourth hand-written prompt is the difference between a day and a week.
- Its detached-job placement lean (run at skip time in the background, never
  blocking a message) is the right call and matches the playbook below.

## The teamwork playbook (for future complex features)

The lane already has a winning pattern for making agents cooperate without
adding wait time; new features should compose it rather than invent new
shapes:

1. **Cheap deterministic checks decide what runs** (regex reads, band
   crossings, thresholds — never an AI call to decide whether to make an AI
   call).
2. **Focused agents run in parallel after the reply**, each with one small
   job, each degradable to "no notes."
3. **Plain code folds their answers into storage** — the agents propose, the
   deterministic folds dispose (caps, dedup, rollback safety).
4. **Anything slow becomes a detached background job** (the Recap editor /
   Location artist pattern) that can never block or break a message.

Everything in this plan either strengthens a step of that playbook or removes
friction from it.

## Looked at and deliberately left alone

- **Pulse and Archivist stay separate.** Their split is a shipped design
  decision (the Pulse is skipped on beats with no player act; the Archivist
  always runs) and merging them would re-crowd the sheet this plan un-crowds.
- **No AI calls before the reply.** The chat lane's pre-reply reads are
  regex-only by hard-won lesson (the session lane's intake latency); nothing
  here adds one.
- **The meanwhile pass stays one call** for the whole cast (its plan's ≤3
  developments cap is the cost control; per-member passes would multiply it).
- **Per-member personal note-takers stay separate calls** (a recorded ruling:
  focus beats batching). Worth revisiting only if group-chat cost becomes a
  real number worth chasing — noted, not recommended now.
- **The Recap editor and Location artist** are well-sized single-concern
  agents; no changes.

## Costs and latency, in plain terms

Per ordinary one-on-one exchange today: 1 streamed Narrator call + 2 small
helper calls (Pulse, Archivist) + 2 duplicate fingerprint batches.
After all slices: 1 streamed call + 4 small helper calls (Pulse + three
specialists) + 1 fingerprint batch — with the option to stop at Stage 1a and
keep it at 2 helper calls. Player-visible wait: unchanged by the split
(parallel, after the reply), slightly **better** from slices 2–3 (shorter lock
window, less pre-reply work).

## Open questions — all resolved at build time

- **A. Split now or library-first?** **Ruled (owner): split live now.** Stage 1a
  and 1b both shipped; the three specialists are the live path, no flag.
- **B. Should the continuity tracker be skippable?** **Ruled: no** (the plan's
  lean held). It always runs on a small sheet — a regex gate would save calls at
  the cost of silent misses (an outfit change worded unusually), and a missed
  continuity read corrupts state rather than merely omitting a nicety. Revisit
  only with data.
- **C. If plans & promises ships before Stage 1a** — moot: 1a shipped first, so
  the `plans` field lands as a field module (one file, slotted into the character
  leg).
- **D. Should the memory scribe get more context?** **Ruled: yes, scribe-only.**
  It now receives the rolling summary's `Established:` ledger, fenced and
  explicitly marked "never extract facts from this — use it only to resolve who a
  pronoun refers to", so a pronoun-heavy beat files a NAMED fact.

## Completion (2026-07-14)

All five slices shipped in one pass. Gates green (lint · cycles · typecheck ·
2 401 pure tests · 257 integration tests · jscpd), deployed to Fly and verified
against a live exchange.

**Live verification** (Fly, the uxtest ensemble chat — Sabrina Vale + Milo Finch;
one message naming a new person, moving the scene, and removing the PLAYER's
jacket):

- **memory scribe** — filed two facts, both correctly **named** rather than
  pronoun-dangling: "Iris is UX Tester's sister, lives in Lisbon, and is flying in
  to visit on Friday" · "Iris taught UX Tester to appreciate and actually taste
  coffee" (the open-question-D ledger doing its job).
- **continuity tracker** — minted the scene (`roasting room` + four established
  details: the steel door, the drum roaster, the burlap sacks, the workbench) AND
  the supporting-cast entry (`Iris — the player's sister, flying in from Lisbon ·
  taught the player to taste coffee`), and correctly **ignored the player's
  jacket** (neither character's outfit was clobbered — the field's "never record
  the player's clothing" rule held).
- **no degradation** — the exchange logged zero diagnostics.

**A supporting data point for the split.** `fly logs` from the day BEFORE this
change (the single 13-field archivist, same 6s budget) show
`chat_archivist.timeout` firing **repeatedly** in ordinary play — the monolith was
routinely failing to produce all thirteen fields in time, silently costing every
one of them. The three focused legs, each with its own smaller sheet and cap, went
clean on the first live exchange. That is not a controlled measurement, but it is
the failure mode the split predicts, observed in production.

**What shipped**

- **Slice 1a — the field library** (`server/engine/prompts/chat-extractors.ts`).
  One `ExtractorField` module per field owns its instruction, its context block,
  the rules it implies, whether it is *armed* this exchange, and its empty value
  for examples. A **leg** is an ordered list of field keys; its whole system
  prompt is assembled. Consequences: unarmed fields vanish from the sheet (a
  1-on-1 never reads the ensemble `presence` instructions; a drive-less character
  never reads `driveUpdates`), the hand-maintained "thirteen fields" count is
  gone, and every worked example is RENDERED from the leg's own field list — so
  examples can no longer drift out of sync with it. Each leg also closes with a
  **generated empty-output example**, the single most common reply, which the old
  sheets never showed for most fields. The two hand-written prompt files
  (`chat-archivist.ts`, `chat-personal-notes.ts`) are deleted.
- **Slice 1b — three parallel specialists.** `runChatExtraction` runs the
  **memory scribe** (episode/facts/queries), the **continuity tracker**
  (scene/outfit/appearance/presence/cast), and the **character tracker**
  (loops/drives/voice/slip/trait-shifts) concurrently, in the same post-flush
  slot the single archivist held — so the split costs two extra small calls and
  **no perceived latency**. They merge back into the one `ChatArchivist`
  aggregate (`mergeChatExtractions`), leaving every fold untouched. The per-leg
  schemas are `pick`s of the aggregate, so caps/defaults keep one source; a test
  asserts the three legs **partition** it exactly (no field lost, none twice).
  **Per-leg degradation** is the payoff: a degraded character leg keeps the
  standing open loops, a degraded scribe drops stale queries and flags the memory
  trace, and each healthy leg still lands (`chat-extraction-legs.int.test.ts`).
- **Slice 2 — concurrent ensemble settle.** The per-member pulse + note-taker +
  save now run in one `Promise.all` inside the exchange lock instead of serially,
  shortening the lock window a fast typer collides with. Per-member error
  isolation preserved.
- **Slice 3 — one embed per turn** (`server/memory/query-embeddings.ts`). The
  fact leg, the episode leg, every ensemble member's legs, and the callback picker
  now share ONE embedding batch instead of re-embedding the same texts 2–3×. This
  is the only change on the **pre-reply** path. The session lane's
  `preTurnRetrieve` shares it too (it carried the identical duplicate).
- **Slice 4 — the "Right now" digest.** The tail's dozen one-turn notes render
  under one heading that states their authority, ordered **binding → gate →
  license → flavor**. Both lanes (1-on-1 + ensemble).
- **Slice 5 — rulebook cleanup.** Rule 8 ("respond directly to what she just
  heard and saw") folded into the Shaping block's "Resolve, then one move" bullet
  that already said it; rules 9–17 renumbered to 8–16, with every cross-reference
  in code and docs updated. The retired-wording rollback comments **stay** (still
  gated on the enactment eval).

**Deviations from the plan (2)**

1. **Deferral moved from the prompt builder to the pipeline gate.** The plan put
   the soft cap in the tail composer. That is unsafe: an offered memory callback
   **burns its anti-repeat ring entry** the moment it is chosen, so a callback
   dropped at render time would be spent without ever reaching the page, and that
   episode could never be offered again. Deferral therefore lives in
   `chatCallbackEligible` — pure, pre-burn, before any embedding cost — which
   gained the crowded-turn arms the plan wanted (attached photos, storyteller
   narration, an armed photo beat). The builder now only ORDERS; it never drops.
   The deferrable set is exactly the callback and the unprompted selfie offer,
   both pipeline-armed, so nothing else needed a cap.
2. **The edited-reply re-extraction got cheaper, unplanned.** `reextractEditedReply`
   re-files long-term memory and rewrites no state row, so it now runs the
   **memory scribe alone** (`runChatMemoryScribe`) — before the split it paid for
   all thirteen fields and discarded eleven.

**Cost, honestly.** An ordinary 1-on-1 exchange went from 1 streamed narrator call
+ 2 small helper calls + 2–3 duplicate embed batches → 1 streamed call + **4**
small helper calls (pulse + three legs) + **1** embed batch. Player-visible wait
is unchanged by the split (parallel, post-reply) and slightly better from slices
2–3 (shorter lock window, less pre-reply work). Per-leg token caps (500/400/350)
are tighter than the old single 700, so total extraction tokens rise well under
3×.

## Agent health — the debug surface (added 2026-07-14, owner request)

The live verification above turned up the fact that yesterday's archivist had been timing
out **repeatedly in production for days**, and the only reason anyone knew was a stray `fly
logs` grep. That is a hole in the design, not bad luck: the helper legs are best-effort by
construction (§4 of `resilience.md` — they degrade and the reply still ships), which means a
leg failing on *every* exchange is **indistinguishable from a leg that had nothing to say**.
The state row just keeps its old values.

So a failed leg now leaves a durable record with a **suspected cause**, tallied in the admin
chat inspector:

- **`contracts/turns/agent-failure.ts`** (pure) — the `kind` (`timeout` / `api_error` /
  `parse_failed`), a closed `cause` vocabulary, `classifyAgentFailure`, and
  `tallyAgentFailures`. The classifier is deliberately honest about what it knows: a
  **provider error** is not a guess (the provider's class passes straight through), a
  **parse failure** is diagnosed by whether the JSON *stopped mid-object* (⇒
  `output_cap_too_low` — a real, fixable bug that otherwise reads as "the model is bad at
  JSON") or was wrong from the start, and a **timeout** — the weakest signal — blames the
  prompt only when the prompt is actually large.
- **`server/ai/agent-failures.ts`** — records from `generateChecked` (api/parse) and
  `withGenerateTimeout` (the watchdog trip — the important one, since an aborted
  `generateChecked` returns silently by design). Fire-and-forget into the existing `events`
  table; **no migration** for a debug surface.
- **`GET /api/admin/chat-inspector/[chatId]/agent-failures`** → the **Agent health** panel,
  first thing on the inspector page (you want to know a leg failed *before* you start
  reading the memory it was supposed to write). Shows this conversation's failures with the
  numbers that make each suspected cause checkable (budget, latency, prompt size, token
  cap, provider), plus the all-conversations tally — a timing-out leg is usually an
  infrastructure story, not a per-chat one.

**Fixed on the way** (a recorded follow-up in
[chat-reply-failures.plan.md](chat-reply-failures.plan.md)): `generateChecked` used to label
*every* failure `${code}.parse_failed`, so a 429 / 402 / network drop read as a schema
failure. Transport failures now emit `${code}.api_error` with the provider's class.

Telemetry is optional at the call site — an unwired leg is still **counted**, just not
diagnosable. Wired: the pulse, the three extraction legs, the per-member personal pass.
Unwired: the session-lane agents and the detached chat jobs (summary fold, scene sketch,
photo read).

**Left / follow-ups**

- **The quality claim is unmeasured.** The split's premise — that 4–5 assignments
  per sheet beats thirteen on the rare fields (a haircut, a trait shift, a new
  cast member) — is a design argument, not a measurement. The comparison rides
  the owner-gated live eval spend ([deferred.plan.md](../deferred.plan.md) §Owner-gated
  live eval runs); the harnesses can carry it whenever that budget opens.
- **Session-lane agents are untouched.** They remain hand-written
  (`prompts/agents.ts`). The field library is the pattern to reach for when one of
  them next grows a field — noted in `prompts.md` §Agent prompts, not scheduled.
- **Agent-health telemetry is chat-lane-wired only.** The session agents and the
  detached chat jobs are counted but not diagnosable (no `telemetry` passed).
  One-line fix each, when one of them needs diagnosing.
- **The tally has no alerting.** It answers "is a leg failing?" when you look. A
  standing threshold (e.g. warn when a leg's failure rate crosses X% over a day)
  is the obvious next step and deliberately not built — nobody is watching a
  dashboard on a dev deploy.

## Where things live (as built)

| Concern | File |
| --- | --- |
| The extraction **field library** + the four composed legs | `src/server/engine/prompts/chat-extractors.ts` |
| Per-leg schemas (`pick`s of the aggregate) + `mergeChatExtractions` + `ChatExtractionLegs` | `src/contracts/turns/chat-archivist.ts` |
| The three-leg run + the scribe-only re-extract | `src/server/engine/chat-memory.ts` (`runChatExtraction`, `runChatMemoryScribe`, `runChatPersonalNotes`) |
| Per-leg fold semantics | `src/server/engine/chat-state.ts` (`finalizeChatState`) |
| Concurrent ensemble settle | `src/server/engine/chat-pipeline.ts` (the `Promise.all` over `others`) |
| One embed per turn | `src/server/memory/query-embeddings.ts` (+ the optional 5th arg on both fused retrievers) |
| The "Right now" digest | `src/server/engine/prompts/character-chat.ts` (`buildTurnNotes`, both lanes) |
| Pre-burn crowded-turn deferral | `src/server/engine/chat-callback.ts` (`chatCallbackEligible`) |
| Per-leg timeouts + token caps | `src/server/engine/constants.ts` |

## Docs updated

`character-chat/pipeline.md` (three-leg fan-out, per-leg degradation, the shared
embed, concurrent settle, §The one-turn notes), `prompts.md` (§The chat extraction
field library, the retiered tail, rule renumbering), `memory.md` (§Fused retrieval
— one embed per turn), `character-chat/README.md` + `character-chat/api.md` (new
files + per-leg diagnostic codes), `character-chat/images.md` +
`character-chat/supporting-cast.md` (rule renumbering).
