# RAG improvements

Status: draft — remainder only (re-grounded against the code 2026-08-07: of the
seven ideas, three shipped whole and one in part on 2026-07-02, one is moot,
and the three remaining are not committed work)

Outcome: A player can rely on a character recalling what is relevant to the scene
in front of them instead of stray details about people who are not there, so that
replies stop dragging in facts nobody mentioned.

Source of truth for how retrieval behaves **today**:
[memory.md](../memory.md). This plan owns only the ideas that have not been
built; it deliberately does not restate thresholds, fusion math, or channel
rules that the reference doc owns.

## Where this came from

Seven retrieval ideas the owner wrote down, assessed here one by one. Four were
built as the chat lane's retrieval-quality slice
([finished/character-chat-standalone.plan.md](finished/character-chat-standalone.plan.md),
spec §6.3) and shipped 2026-07-02. The numbering is kept stable because that
spec and the code comments cite these numbers.

## Shipped ledger

- **#2 — per-query embedding, fusion, and provenance.** Shipped. Each memory
  query is embedded and searched separately, results fuse by reciprocal rank,
  and every hit carries which queries surfaced it — visible in the chat
  inspector and on the retrieval telemetry event. A later pass added a
  once-per-turn embedding cache so the several legs that search the same texts
  cost one round-trip instead of three.
- **#4 — prefer subject identity over subject name in supersedence.** Shipped.
  When both the incoming fact and the stored candidate are grounded to a
  library subject, identity equality decides: two people who happen to share a
  name no longer overwrite each other, and a rename no longer breaks the
  chain. Name matching remains the fallback when either side is unresolved.
- **#6 — the retrieval evaluation harness.** Shipped as `pnpm eval:retrieval`
  (`scripts/eval/retrieval/`, with its own README). It seeds fixture corpora
  through the real write path, retrieves through the real retrievers, and
  scores recall and precision against per-fixture expectations. Deliberately
  never wired into CI: a poor score is a tuning signal, not a build failure.
- **#1 — a measured relevance floor for facts.** Shipped in part. The floor
  exists and was *measured* with the harness rather than guessed, and pinned
  "remember this" facts are exempt from it so a player note is never filtered
  out. What did **not** ship is the presence-based half of the idea — see the
  remainder below.

## What is moot

**#3 — centralize lore gating.** Closed as no longer applicable. The drift it
targeted lived in the session-lane turn pipeline duplicating the lore module's
gating helpers; the R6 rollout (2026-07-22) deleted the session lane, the lore
module, and the lore table outright. Nothing retrieves lore today.

One piece of litter survives that deletion: `memory/constants.ts` still exports
two lore thresholds with no reader anywhere in the codebase. Deleting them is a
one-line hygiene fix that belongs to whoever next opens that file, not to a
plan.

## The remainder

### 1. Presence as an inclusion signal (the unbuilt half of #1)

The floor answers "is this fact related to what was just said". It does not
answer "is this fact about someone who is actually here". In a one-on-one
conversation those questions collapse into each other — the only other person
present is the partner — which is exactly why the shipped slice was safe
without it. In an ensemble conversation they come apart: a fact about a
character who is currently away can outrank a fact about the person being
spoken to.

The chat lane already tracks the signal this needs. Each participant carries a
presence state (present or away) and, when away, a free-text sense of where
they are. Nothing in retrieval reads either one.

The shape to build: a fact about a present participant is admitted even when it
scores below the floor, and the ranking prefers present subjects over absent
ones. The wiring cost is that retrieval does not currently return a fact's
subject identity to its caller, so surfacing it is part of the work rather than
a freebie.

- **Size:** small once the ensemble pipeline is the normal case; low value
  before then.
- **Depends on:** multi-character conversations being the common shape. In a
  one-on-one chat this changes nothing observable.

### 5. Retrieval that respects who witnessed what

The half of this idea that mattered most has already been solved by a different
route. The **fact channel** fence (see [memory.md](../memory.md)) closes the
archivist's mind-reading backdoor: knowledge established from the player's
unspoken thoughts is excluded from narrator-bound retrieval in SQL, before the
top-k cut, so it can never surface as something the character "knows".

What remains is the per-character version. Facts and episodes record who
witnessed them, and a witness fence exists in the memory module and is composed
into every fact and episode query — but no production caller supplies a
viewpoint, so it is currently a seam exercised only by an integration spike. It
becomes load-bearing the moment two characters in one conversation should know
different things.

The canon flag is the other half, and it is still dormant: the column exists,
defaults to true, and **no code path ever writes it false**. Building a filter
for beliefs and lies before anything produces a belief or a lie would be a gate
with nothing behind it. The lies-and-beliefs model owns that write side; this
plan does not.

- **Size:** small to wire, large to make meaningful.
- **Gated on:** a real multi-character conversation (for witness) and a
  producer of non-canon facts (for canon).

### 7. Retrieval as a replacement for flat history

The conversation history sent to the narrator is still a flat window: the last
forty exchanges verbatim, with everything older folded into a rolling summary.
Nothing about that selection is scoped to who is present or what is happening —
it is purely "the most recent N".

The ambition is to compose history procedurally instead: assemble what the
narrator sees from what is relevant to the people in the room and the situation
they are in, rather than from a fixed count of recent lines.

Two things changed since this idea was first written, and both matter:

- **The old blocker came back, stronger.** The original framing hung on "we
  make no model call before narration". That briefly stopped being true when
  the session lane grew a pre-narrator intake agent — and then the session lane
  was deleted, and the surviving chat lane adopted "no model calls before the
  reply" as a **recorded design ruling** rather than an accident
  ([finished/chat-agent-improvements.plan.md](finished/chat-agent-improvements.plan.md)
  §"Looked at and deliberately left alone"), because that intake latency was
  the lesson. The one exception is the photo-description read, and it only runs
  when the player attached an image. A synthesized digest would therefore be
  the *first* routine model call the player waits on — that is the decision
  this idea now has to win, not a free slot.
- **The first concrete step is gone too.** That step was "scope episode recall
  by present roster and location adjacency", which assumed the session lane's
  proximity graph. That code was deleted with the session lane. Chat has no
  locations-as-entities and no adjacency — its only location-like state is the
  present/away flag and a free-text whereabouts phrase.

So the tractable first step is now the same work as the presence remainder
above: scope episode recall by who is present. The rest — per-character episode
windows, a synthesized scene digest — stays a research direction.

- **Size:** large, multi-stage. **Treat as direction, not near-term work.**

## Open questions

- **#1** — does "subject is present" admit a below-floor fact outright, or only
  lower the bar for it? A hard override risks pulling stale facts about a
  present character ahead of fresh relevant ones.
- **#5** — should a witness-scoped retrieval be the default once ensembles are
  normal, or an opt-in per conversation? Defaulting it changes recall for every
  existing conversation whose rows were written under the unfiltered rule.
- **#7** — accept the first routine pre-reply model call in exchange for a
  synthesized scene digest, or keep history assembly strictly non-model
  (filter, rank, and scope the summaries that already exist)? The standing
  ruling is non-model; overturning it needs a latency number, not an argument.

## Suggested sequencing

The three remaining items are all gated on the same thing — conversations where
more than one character is really in play — and none of them is worth building
before that. When it arrives, the order is: presence as an inclusion signal
(#1's remainder), then wiring the witness fence to a real viewpoint (#5), then
history composition (#7). Re-run `pnpm eval:retrieval` before and after any of
them; that is what it is for.

## Cross-references

- [memory.md](../memory.md) — how retrieval works today, and every tuning knob.
- [finished/character-chat-standalone.spec.md](finished/character-chat-standalone.spec.md)
  §6.3 — the shipped slice, and §6.4 for pinned "remember this" facts.
- [finished/character-memory-spec.phase3.md](finished/character-memory-spec.phase3.md)
  — the per-character knowledge ledger that owns idea #5's consumer. Not
  started, not on the roadmap.
- [finished/chat-agent-improvements.plan.md](finished/chat-agent-improvements.plan.md)
  — the recorded ruling that the chat lane makes no model call before the
  reply, which idea #7 has to argue against.
- [../character-chat/pipeline.md](../character-chat/pipeline.md) — the exchange
  lifecycle, including exactly what runs before the reply.
