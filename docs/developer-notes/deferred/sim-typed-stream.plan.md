# Typed successor reply stream — progress, world events, and real error codes

Status: draft (stub — successor-engine backlog item F21, parked 2026-07-24 from
the successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building)

## What

The sim fork of the send route streams a zero-width-space first byte + an
8-second ZWSP heartbeat (to survive fly-proxy's ~60s idle cutoff —
`app/api/chats/[chatId]/route.ts:298-315`), performs the entire turn, then
emits the prose as one chunk (`:318-328`). Structured successor failures are
flattened on the way out: `runSimChatExchange` returns a closed code union
(`not_sim_enabled | sim_open_failed | render_withheld | nothing_to_retake |
world_catching_up`, `sim-exchange.ts:551-554`) but the route writes
`lastReplyFailure.code = "unknown"` (`route.ts:330-354`) because the
`chat-reply-failure` contract's enum has no successor members
(`contracts/turns/chat-reply-failure.ts:33,39` — `.catch("unknown")`), and
`model: ""` loses attribution. (MED · M)

## Why it matters

The player stares at an inert composer for the whole world-resolve + recall +
render pipeline, cancellation has no seam to hook (D18), retry can't be
targeted, and every distinct failure — world catching up, render withheld,
scene refusal — collapses to the same generic error UI.

## Sketch

- Replace the ZWSP protocol with newline-delimited JSON frames (or SSE):
  `phase` (resolving_world / recalling_memory / rendering), `world_event`
  (travel_started, …), `delta` (prose, enabling real narrator streaming
  later), `warning` (trigger_backoff), `error` (original code + retryability
  + diagnostic id), `done` (message id, cut id). Legacy lane can keep its
  current text stream or adopt the same envelope — decide at promotion.
- Extend the `chatReplyFailure` contract with the successor code union so
  codes survive into `lastReplyFailure` (the fix is a contract extension, not
  just plumbing).
- Client: phase-aware progress in the pending bubble; cause-specific retry
  affordances (e.g. `world_catching_up` → the existing catch-up poll).

## Open questions

- SSE vs ND-JSON over the existing fetch-stream (the client already consumes
  a ReadableStream — ND-JSON is the smaller change).
- Does the heartbeat stay as a comment frame, or does phase traffic make it
  redundant?
- Can the narrator render actually stream deltas through the §23 audit loop,
  or is `delta` all-at-once until the auditor learns to run incrementally?

## Slices

_(Defined at promotion.)_
