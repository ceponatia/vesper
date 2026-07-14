# Chat agent improvements — a tune-up for the helpers behind every reply

Status: **draft** (written 2026-07-14 from an agent-architecture review of the
character-chat lane, on owner request. Deliberately written in plain language —
each slice below stands alone and can be promoted, reordered, or dropped
independently. Review scope: the chat lane's tool + narrative agents, fit with
the queued roadmap items, whether any agent should split into smaller parallel
specialists, latency, and instruction-text cleanup.)

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

## Open questions

- **A. Split now or library-first?** Lean: Stage 1a unconditionally, 1b only
  after a quality comparison on real conversations (the retrieval/narration
  eval harnesses can carry it; live judged runs are owner-gated spend as
  usual).
- **B. Should the continuity tracker be skippable?** A regex gate ("no
  movement/clothing/people words this exchange → skip the call") would save
  most of its runs, but silent misses are the cost (an outfit change worded
  unusually). Lean: always-run with a small sheet; revisit with data.
- **C. If plans & promises ships before Stage 1a**, its field lands the old
  way — acceptable, but then Stage 1a should absorb it in the same change.
- **D. Should the memory scribe get more context?** Today the Archivist sees
  only the latest exchange, so a pronoun-heavy beat ("she actually said yes!")
  can file a vague fact. Feeding it the recap's "Established:" bullets would
  ground names at a small token cost. Lean: yes, scribe-only, once 1b exists.

## Where things live (for the implementing agent)

| Concern | File |
| --- | --- |
| Archivist prompt (the 13 fields) | `src/server/engine/prompts/chat-archivist.ts` |
| Personal note-taker prompt (the copy-paste) | `src/server/engine/prompts/chat-personal-notes.ts` |
| Archivist/pulse run + parallel fan-out | `src/server/engine/chat-memory.ts`, `src/server/engine/chat-state.ts` (`finalizeChatState`) |
| Sequential group settle loop | `src/server/engine/chat-pipeline.ts` (~line 1247, `for (const member of others)`) |
| Duplicate fingerprinting | `src/server/memory/facts.ts` (`retrieveFactsFused`) + `episodes.ts` (`retrieveEpisodesFused`) + `chat-memory.ts` (`retrieveChatMemory`, `retrieveChatCallback`) |
| The volatile-tail pile | `src/server/engine/prompts/character-chat.ts` (`buildCharacterChatPromptParts`, `tailSections`) |
| Rulebook overlaps + rollback comments | `src/server/engine/prompts/character-chat.ts` (`CHAT_RULES`) |
| Archivist output shape (defaults) | `src/contracts/turns/chat-archivist.ts` |

## Docs to update when implementing

`character-chat/pipeline.md` (fan-out shape, settle parallelism),
`prompts.md` (field library, tail digest), `character-chat/state.md` (if fold
sites move), `testing.md` (snapshot-test layout for composed prompts), and the
two queued plans' cross-references.
