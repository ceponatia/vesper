# Memory-index drain off the reply-critical path

Status: draft (stub — successor-engine backlog item G27, parked 2026-07-24 from
the successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building)

## What

Before successor recall, every RAG-eligible user utterance drains the
branch-agnostic memory-index outbox for up to **25 iterations**, then embeds
the query (`sim-exchange.ts:187-198`, gate at `:693-702` on
`ragEligibility && message.trim()`). The drain runs on the reply path for all
three turn shapes via `loadSimConversationContext` (co-present `:1104`, solo
`:1914`, retake `:2057` — a retake re-pays the full drain + embed). Unrelated
indexing work therefore adds latency to the current chat's reply. The block
degrades to `[]` on failure (`:200-206`), so it's a latency hazard, not a
correctness one. (LOW-MED · M)

## Why it matters

Successor turns are already the slow lane (drain + narrator + audit); paying
another branch-agnostic indexing debt per utterance makes p95 reply latency
hostage to whatever any other chat recently committed. The engine already
models index lag as a first-class visible state (E4.4 — outbox lane "with
visible lag", degrading to text-only recall), so moving consumption off-path
is consistent with the contract, not a change to it.

## Sketch

- Run outbox consumption continuously in a durable worker (the drain-hardening
  time-job runner is the in-repo pattern for leased background work); the
  turn queries whatever index exists and reports `memoryIndexLag` as a
  diagnostic instead of draining inline.
- Optional freshness bridge: newly committed, highly relevant facts from the
  current branch append directly to the next prompt until indexing catches
  up (bounded, provenance-labeled).

## Open questions

- Worker trigger: piggyback on the existing due-time-job sweep, a cron, or
  drain-on-write with a small budget after each commit?
- Is the inline drain kept as a *fallback* when lag exceeds a threshold, or
  removed outright per the delete-don't-wrap rule?

## Slices

_(Defined at promotion.)_
