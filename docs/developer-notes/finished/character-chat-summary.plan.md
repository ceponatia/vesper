# Character chat — rolling background summary

Status: **shipped — 2026-06-21**. v1 built to the shape below: the
`character_chat_summaries` table + watermark (migration `0009`), the watermark-aware
window load + `priorSummary` prompt block, the detached `chat_summary` fold job
(units = exchanges, model = `stateModelId`), and the guarded POST trigger. Covered
by `chat-summary.test.ts` (pure: fold/clamp/degrade) + `chat-summary.int.test.ts`
(DB: fold advances the watermark & trims the window, degraded no-op, below-trigger
no-op, enqueue guard, DELETE clears). `pnpm verify` green. **Leftovers** = the
tuning Open questions below (recursive-vs-append, word budget, decay) + the
deferred client "memory" panel; real-provider recap quality is a tuning pass, not
a correctness gate (the fold degrades to today's behavior by construction).
Independent of the broader [character-chat-state.plan.md](character-chat-state.plan.md)
brainstorm, where this summary converges later.

Topic slug `character-chat-summary` (grep `character-chat` finds this beside the
finished plan and the state brainstorm).

## The problem

The sessionless Chat tab replays a **flat window of the last 40 exchanges**
verbatim (`CHARACTER_CHAT_HISTORY_TURNS = 40`, `engine/constants.ts`;
`engine/character-chat.ts` `windowChatHistory` slices `-40*2` messages). That
window **is the model's only memory** — no episodes, facts, or RAG. So at turn
41 the first exchange silently falls off a cliff and is gone: the character
forgets the name you gave, the thing you promised, the joke from earlier. A long
chat slowly amnesia's its own beginning.

We want continuity **past** the 40-turn window without standing up the session
memory engine — and without the naive fix of "summarize then drop everything but
the last reply," which trades amnesia for a different amnesia (you keep the gist
but lose all recent verbatim texture).

## The shape: a watermark-anchored rolling summary

Keep two things in the prompt instead of one:

1. **A running summary** — prose recap of everything *older* than the verbatim
   window, refreshed in the background. Carries the long term.
2. **The verbatim window** — the recent exchanges, unchanged in spirit, carrying
   recent detail and voice.

The model always sees **summary + verbatim**, and the two are **contiguous**
(the summary covers exactly up to where the verbatim window begins — no gap, no
overlap-loss). Detail degrades *gently*: a message rides verbatim for ~20–35
exchanges before it's folded into prose, and even then its substance survives in
the summary.

### The watermark

One new row per `(ownerId, characterId)` holds the summary plus a **watermark**:
the `(createdAt, id)` of the newest message already folded into the summary.

- **Summarized** = messages at/before the watermark — represented by the prose.
- **Verbatim** = messages after the watermark — replayed in full.

The watermark only moves when a fold succeeds, which is what keeps summary and
window contiguous by construction.

### The three operations

**1. Assemble (every turn, in the POST route — pure, no LLM).**
Load the summary row, then load messages **after the watermark**, newest-first,
capped at the verbatim **ceiling** (the existing 40 exchanges), reversed to
oldest-first. Pass `summary` into `buildCharacterChatSystemPrompt` as a new
optional *"Earlier in this conversation"* block and the verbatim messages as
`history`. No watermark? (fresh chat, or summarization off) → behaves exactly
like today.

**2. Trigger (every turn, after appending the user line — cheap).**
If the count of unsummarized exchanges has reached `SUMMARIZE_AT` (≈35), enqueue
a detached `chat_summary` job (guarded so at most one is queued/running per
chat). This is fire-and-forget: it runs **concurrently with the streaming
reply** and never adds latency to it.

**3. Fold (the background job — one `generateChecked` call).**
Recompute unsummarized exchanges; if still ≥ `SUMMARIZE_AT`, take the **oldest
`SUMMARIZE_AT − VERBATIM_KEEP` ≈ 20 exchanges**, summarize *(prior summary +
that chunk)* into a new running summary, and in **one update** write the new
summary and advance the watermark to the last folded message. This leaves
`VERBATIM_KEEP` ≈ 15 exchanges still verbatim. If the count is now below the
trigger (a concurrent fold already ran, or a delete shrank it) the job no-ops —
**idempotent by recompute**.

### Constants (tune freely; units are exchanges = one user+assistant pair)

| Constant | Value | Role |
| --- | --- | --- |
| `CHARACTER_CHAT_HISTORY_TURNS` *(existing)* | 40 | **Verbatim ceiling** — hard cap on verbatim exchanges; the degraded floor (= today's behavior) |
| `CHARACTER_CHAT_SUMMARIZE_AT` | 35 | Fold trigger: unsummarized exchanges that enqueue a fold |
| `CHARACTER_CHAT_VERBATIM_KEEP` | 15 | Exchanges left verbatim after a fold |

Fold size = `SUMMARIZE_AT − VERBATIM_KEEP` = **20 exchanges** ("drop 20 of the
oldest"). The deliberate 5-exchange gap between the trigger (35) and the ceiling
(40) is headroom: the job (one LLM call, a few seconds) finishes well before the
verbatim window could overflow the ceiling and start dropping unsummarized
turns.

### Worked example

```
turns 1–34   no summary; all verbatim (≤ ceiling)         model sees: full transcript
turn  35     unsummarized hits 35 → enqueue fold
             fold: summarize ex.1–20 → summary; watermark = end of ex.20
             now verbatim = ex.21–35 (15)                 model sees: summary[1–20] + ex.21–35
turns 36–54  verbatim grows 16→34 (ex.21–54)              model sees: summary[1–20] + ex.21–54
turn  55     unsummarized hits 35 → enqueue fold
             fold: summarize (summary[1–20] + ex.21–40) → new summary; watermark = end of ex.40
             now verbatim = ex.41–55 (15)                 model sees: summary[1–40] + ex.41–55
…            repeats every ~20 turns
```

Steady-state prompt = a bounded summary (~250–350 words) + 15–35 verbatim
exchanges — comparable token cost to today's flat 40, but memory now reaches
across the **entire** conversation.

## Not losing detail: recursive fold + a durable ledger

The fold is **recursive** — `summarize(priorSummary, newChunk)` — so its input
stays bounded (no re-reading the whole transcript each time). The classic risk
of recursive summarization is *compounding loss of concrete facts*. We counter it
two ways:

- **Structured output.** The summary is one text blob with an instructed shape:
  a short past-tense **narrative recap** *plus* a bulleted **"Established:"
  ledger** of durable specifics — the player's name and what we know about them,
  commitments/promises either side made, stated preferences, relationship state,
  unresolved threads, in-jokes. The prompt tells the model to **carry the ledger
  forward near-verbatim** while compressing only the narrative prose. Durable
  facts survive many folds; only old narrative texture is lossy (and recent
  texture is still verbatim anyway).
- **Length cap.** The summary targets a word budget so it can't grow unbounded;
  the model is told to drop the least-important *narrative* detail first, never
  ledger entries.

Append-only (keep each fold's chunk-summary as its own section, concatenated) is
the fallback if recursive drift is ever observed in practice — simpler, no
re-summarization loss, but unbounded; noted as a lever, not the v1.

## Data model

A new focused table — isolated like `character_chat_messages`, one row per chat:

```ts
// src/server/db/schema.ts
export const characterChatSummaries = pgTable(
  "character_chat_summaries",
  {
    ownerId: text("owner_id").notNull().references(() => users.id),
    characterId: text("character_id").notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    summary: text("summary").notNull().default(""),
    /** (createdAt, id) of the newest message folded into `summary` — the watermark. */
    watermarkAt: timestamp("watermark_at", { withTimezone: true }),
    watermarkId: text("watermark_id"),
    /** Exchanges represented by the summary — telemetry/debug only. */
    coveredExchanges: integer("covered_exchanges").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.characterId] })],
);
```

- **Unsummarized predicate** (collision-safe ordering): `created_at > watermarkAt
  OR (created_at = watermarkAt AND id > watermarkId)`; a null watermark means
  "nothing folded yet" → all messages are verbatim. (cuid2 ids aren't
  time-sortable, so the `(createdAt, id)` tiebreak matters at the fold boundary.)
- DB workflow per `CLAUDE.md`: edit `schema.ts` → `pnpm db:generate` → review SQL
  → `pnpm db:migrate`.

**Why a new table, not the future `character_chat_state` row?** That row
([character-chat-state.plan.md](character-chat-state.plan.md)) is a draft
brainstorm; this feature ships independently now. When state lands, this summary
naturally becomes a column on it and the watermark rides along — noted there as
convergence, not a blocker. The brainstorm's one-line **`mindNote`** ("what's on
their mind") is the *complement*, not a duplicate: mindNote = current mood /
disposition; this summary = factual transcript recap. mindNote, once built, can
be **derived** from the same fold call cheaply.

## The background job

A new `chat_summary` `JobType` (`engine/jobs.ts`), registered with
`registerJobHandler`, enqueued with **`sessionId: null`** so it runs through the
existing **detached** path (`runDetachedJob`) — picked up immediately,
concurrent across chats, never gating any session. Structurally a clone of
[`engine/inner-note.ts`](../../src/server/engine/inner-note.ts): payload schema,
`enqueue…` helper, `generateChecked` extraction with a degraded fallback, a
`processChatSummary` body, and the handler registration.

```ts
// payload
{ ownerId: string; characterId: string }
```

The job: load the summary row + the unsummarized messages (oldest-first); if
< `SUMMARIZE_AT` exchanges, no-op; else slice the oldest `fold` exchanges,
`generateChecked` the recap, and on success write `{ summary, watermarkAt,
watermarkId, coveredExchanges }` in one update.

## Resilience (the degraded floor *is* today's behavior)

Following `docs/resilience.md` §3's worked example — make the fallback the
previously-shipped deterministic path, so the new call is pure upside:

- **No summary row / null watermark** → verbatim = last `CHARACTER_CHAT_HISTORY_TURNS`
  exchanges = **exactly today**.
- **Demo mode / LLM fails twice / job never runs** → the watermark **does not
  advance**; the messages simply stay verbatim and the window grows toward the
  ceiling. Worst case the window hits 40 and the oldest unsummarized exchange
  falls off — again, **exactly today**. A diagnostic records the degrade.
- **The fold only commits on success** — a partial/garbage summary never
  replaces a good one *and* advances the watermark; on failure we keep the prior
  summary and retry next cycle.
- **Schema** is small and fully defaulted (`summary` `.default("")`); fold output
  is clamped (length cap, non-empty check) before it's written — trust nothing.
- **Never blocks the reply.** The reply stream path (`streamCharacterChat`) is
  untouched; the trigger is fire-and-forget after the user line is appended.
- **Diagnostics:** no session/turn row exists to carry them, so the fold returns
  a `DiagnosticCollector` (unit-testable) and logs stable codes
  (`chat_summary.fold.degraded` / `.parse_failed` / `.empty`) via `server/log`.
  *Known gap:* no dev-inspector surface for chat diagnostics (sessions have the
  Turn Inspector; chat has none). Acceptable for v1; a small "memory" debug
  panel could surface the summary later (parked).

## Edge cases

- **Clear conversation** (`DELETE /chat`) → also delete the summary row, beside
  the existing message-delete + scene-prompt scrub. A cleared chat must not keep
  a hidden recap (correctness + privacy).
- **Single-message delete / PATCH** (`[messageId]/route.ts`) → if the message was
  already folded (≤ watermark) the prose can't un-say it — accepted (the summary
  is lossy by design; mirrors how a real recap works). If it's still verbatim,
  it just leaves the window. No watermark change. The PATCH/delete "poison
  recovery" lever still works on the verbatim window as before; a refusal folded
  into the summary is rarer (folds are recaps, not transcripts) but a future
  "rebuild summary" affordance could cover it (parked).
- **Concurrent fold + stream** → the fold reads old messages + the summary row;
  the stream only *appends* new messages. No write conflict; the new
  user/assistant pair is folded a cycle later.
- **Double-enqueue** → guarded best-effort (skip if a `chat_summary` job for this
  chat is queued/running), and harmless regardless: the second run recomputes,
  sees the watermark advanced, and no-ops.

## Prompt surfacing

`buildCharacterChatSystemPrompt` gains an optional `priorSummary?: string`,
rendered (when non-empty) as a section before `CHAT_RULES`, framed as **context,
not dialogue**:

> *Earlier in this conversation (recap for continuity — do not quote verbatim):*
> *{summary}*

Pure and snapshot-testable, like the rest of that builder. The plain-text reply
stream and the `[Name] "…"` tagging are unchanged.

## Client

**Unchanged for v1** — the summary is entirely server-side and invisible. Optional
later: a small "🧠 remembers earlier" affordance or a debug panel to view/edit
the running summary (parks in [deferred.plan.md](../deferred.plan.md)).

## Build order

1. **Table + assembly + prompt block (no new LLM).** `character_chat_summaries`
   schema → migration; watermark-aware load in `chat/route.ts`; `priorSummary`
   section in the prompt builder; `DELETE` also drops the summary row. With no
   folds yet this is behavior-neutral (summary always empty) — a safe, testable
   base.
2. **The fold job.** `chat_summary` job type + `processChatSummary` +
   `generateChecked` recap (prompt with the narrative-recap + ledger shape) +
   degraded fallback; register the handler. Unit-test the fold/clamp/degrade.
3. **The trigger.** Enqueue (guarded) in POST after the user line is appended.
   Int-test: drive a chat past 35 exchanges → summary row written, watermark
   advanced, verbatim trimmed to 15, prompt carries the recap; `DELETE` clears it.
4. **Tune** `SUMMARIZE_AT` / `VERBATIM_KEEP` and the summary word-budget on real
   transcripts; consider mindNote/state convergence.

## Open questions

- **Units.** Design is in **exchanges** (matches `CHARACTER_CHAT_HISTORY_TURNS`,
  where a "turn" = one user+assistant pair). The request said both "40 messages"
  and "35–40 turns" — confirm we mean **35/15/40 exchanges** (= 70/30/80
  messages), not raw messages. Thresholds are constants, so this is a one-line
  change either way.
- **Recursive vs append-only fold.** v1 = recursive + durable ledger (bounded,
  recommended). Switch to append-only if drift shows up?
- **Summary word budget** — the length cap (≈250–350 words?) that balances recall
  vs. prompt cost.
- **Fact loss tolerance on deletes** — accept that folded-then-deleted lines
  persist in prose (v1), or add a "rebuild summary from transcript" lever?
- **Model for the fold** — the default `stateModelId()` (as inner-note uses), or
  the chat's narrator model? (Lean: state model — it's an extraction/recap task,
  cheaper, and keeps the narrator model free for voice.)

## Related

- [finished/character-chat.plan.md](../finished/character-chat.plan.md) — the
  stateless v1 this extends; the "window IS its only memory" constraint this lifts.
- [character-chat-state.plan.md](character-chat-state.plan.md) — the light-state
  brainstorm; its `mindNote` is this summary's complement, and its
  `character_chat_state` row is where this summary converges later.
- `src/server/engine/inner-note.ts` — the detached-job + `generateChecked`
  template this clones.
- `docs/resilience.md` §3 (worked example) — the "fallback = previously-shipped
  path" pattern this follows.
- `docs/memory.md` §Episodes — the session-side analog (per-turn embedded
  summaries + RAG) this deliberately does *not* pull in.
