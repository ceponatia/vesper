# Chat reply latency — the pause between send and the first word

Status: draft (unscheduled — derived from [codebase-efficiency.audit.md](codebase-efficiency.audit.md); no roadmap line yet)

## Why

A player hits send, and then nothing happens for a moment — no text, just the
waiting state — before the character starts speaking. Some of that gap is the model
genuinely composing a reply, and that part is fine: it reads as thinking. The rest
is bookkeeping the player never asked for, and all of it happens *before* the first
word can appear.

The efficiency audit measured that bookkeeping ([§B, §C](codebase-efficiency.audit.md)).
Before the stream opens, the chat's own row is fetched three or four times in
sequence — including one lookup that re-reads the player's persona state the caller
already holds (**B12**). The item table (clothing, props) is read five to eleven
times per exchange with nothing batched, and the character's wardrobe and the
player's wardrobe resolve one after the other even though neither depends on the
other (**B13**). On the memory path, a network round trip to the embedding provider
is awaited before a cheap local count that could have run alongside it — twice
(**C15**). In a group chat, each member's body and appearance are computed two or
three times over per turn from pure functions that return the same answer each time
(**B15**), so the fullest ensembles pay the most.

There is a second, sharper symptom. The exchange lock — the guard that stops two
replies racing on one chat — is held through four sequential writes at the end of
the turn where two phases would do (**B14**). A player who sends again quickly gets
bounced with "a reply is still streaming for this chat" for the length of that tail.
Shortening the hold makes fast back-and-forth feel like conversation rather than a
form that rejects you.

None of this changes a word the character says. That is the point: five findings,
all rated small effort and low risk, all of them felt by the player.

## Scope

Audit batch 4 exactly, no additions:

- **B12** — stop re-reading the chat row: return the owner from the scenario load and
  pass the already-resolved persona in. Two round trips gone from the pre-stream path.
- **B13** — batch the item reads: start the two wardrobe resolutions together instead
  of one-then-the-other, and collapse the worn/pool lookups per fold.
- **C15** — start the embedding call and the turn-number read at the same time on the
  memory path, in both places it occurs.
- **B14** — group the finalizer's four tail writes into two phases, shortening the
  lock hold behind the fast-re-send rejection.
- **B15** — compute each ensemble member's realized body and resolved attributes once
  per turn and reuse the result.

The audit entries carry enough detail (call sites, the shape of each fix) to serve as
this batch's spec. **No `chat-reply-latency.spec.md` unless a slice grows past its
estimate** — likeliest candidate is B13's per-fold query collapse.

## Non-goals

- **No behavior change.** The narrator prompt and the reply text must come out
  identical for a fixed fixture. If a fix would alter output, it leaves this batch.
- No schema change, no migration, no new caching layer; and not the large
  decompositions the audit names separately (**B18**, **B1**).
- Not the *after* the reply starts half — the transcript re-parsing every message on
  every streaming token (**D12**) is a separate audit batch, coordinated with the
  parked component decomposition (G25).
- Not the successor lane. **G27** (the inline memory-index drain,
  [deferred/sim-memory-index-worker.plan.md](deferred/sim-memory-index-worker.plan.md))
  is the known latency item over there — cited so nobody re-derives it, deliberately
  not absorbed.
- Not **C14** (batching the post-turn fact writes) — it changes which draft supersedes
  which, so it needs a ruling rather than a cheap win.

## Delivery slices

0. **Rebase check.** Re-locate every call site against current `main` — the audit's
   §B line references were taken while the narrator-physical-guidance build was live
   in the same files, so they are stale by construction. Cheap, and it gates the rest.
1. **Fewer reads before the stream opens** (B12, plus B13's parallel wardrobe
   start). Most visible slice, smallest diff — do it first.
2. **Batched item lookups** (B13 remainder).
3. **Parallel memory-path awaits** (C15).
4. **Hoisted per-member computation** (B15). Biggest effect on group chats.
5. **Shorter lock hold** (B14). Last, because it touches write ordering.

## Success criteria

- **Round trips, counted.** Before/after on the same chat: two fewer chat-row reads
  before the stream opens, the two wardrobe resolutions overlapping rather than
  queued, and the embedding call no longer blocking the turn-number read at either site.
- **Output parity.** Existing prompt snapshot coverage passes unchanged. A snapshot
  diff is a failed slice, not an update to accept.
- **Per-member work.** In a four-member ensemble, body realization and attribute
  resolution each run once per member per turn (asserted by call count, not by eye).
- **Fast re-send.** On the Fly deploy, sending again immediately after a reply
  completes no longer returns `chat_busy` in a manual playtest.
- Full gate green, run one command at a time.

## Risks & coordination

- **Active build in the same files.** `chat-pipeline.ts` and
  `prompts/character-chat.ts` are being modified by the in-progress
  [narrator-physical-guidance.plan.md](narrator-physical-guidance.plan.md) work.
  Sequence behind it, or run alongside with slice 0 as a standing rebase check —
  don't start slices 1/4/5 while those files are mid-edit.
- **Write ordering is load-bearing.** The finalizer's tail writes are deliberately
  separate: the rollback anchors ride targeted follow-up updates so an author edit
  cannot clobber them, and each is guarded on the same prompting message so a
  mid-stream delete leaves neither half written. B14 must preserve both — hence last
  slice, smallest possible diff.
- **Parallel awaits change failure timing.** Two calls started together both begin
  before either can fail, so per-leg diagnostics must still be recorded individually
  (`docs/resilience.md`); a swallowed code is a regression even if the turn succeeds.
- **Hoisting is only safe because the functions are pure.** Confirm each call site
  passes the same overlay inputs first — B15 becomes a bug the moment one site reads
  a different overlay list.
- **Don't overclaim the win.** Time-to-first-token is dominated by the model provider.
  Removing three to five round trips is real, but the honest framing is "the app stops
  adding to the wait", not "replies are fast now".

## Open questions

- Do we add a pre-stream timing trace before the fixes, so the result reads as a
  millisecond delta rather than a round-trip count? Without one the success criteria
  stay structural — and is a single Fly before/after enough given Neon's latency
  variance, or does it need a repeated-run median?
- Does B13's per-fold worn/pool query collapse belong in this batch, or wait until
  the wardrobe seam settles under the active affordance work?
- Should the client retry a busy chat once regardless? That is the player-facing fix
  for fast re-sends even after the lock hold shrinks — but it is its own small plan.
