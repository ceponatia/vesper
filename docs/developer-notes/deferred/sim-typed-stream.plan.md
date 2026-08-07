# Typed successor reply stream — progress, world events, and real error codes

Status: **draft** — parked in [deferred.plan.md](../deferred.plan.md); not
committed work. Successor-engine backlog item F21, parked 2026-07-24 from the
successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building.

Outcome (provisional): A player can see what a world-chat reply is doing while
they wait and read why it failed when it fails, so that a long pause stops
looking like a frozen screen and different problems stop showing the same
generic error.

## What

The sim fork of the send route sends a zero-width-space first byte + an
8-second ZWSP heartbeat (to survive fly-proxy's ~60s idle cutoff) while it
performs the turn and audits the narrator result. Since 2026-08-04, accepted
prose is revealed in small paced chunks instead of one final blob. The
transport still has no typed progress or warnings, does not expose raw provider
tokens before the audit, and flattens structured successor failures on the way
out: `runSimChatExchange` returns a closed code union
(`not_sim_enabled | sim_open_failed | render_withheld | nothing_to_retake |
world_catching_up`, `sim-exchange.ts:551-554`) but the route writes
`lastReplyFailure.code = "unknown"` (`route.ts:330-354`) because the
`chat-reply-failure` contract's enum has no successor members
(`contracts/turns/chat-reply-failure.ts:33,39` — `.catch("unknown")`), and
`model: ""` loses attribution. (MED · M)

## Partial closure — approved-prose reveal (2026-08-04)

World-chat replies now grow incrementally in the existing bubble once the
successor narrator's full result has passed its safety and consistency audit.
This closes the visibly-one-blob problem without leaking a hidden failed
attempt or weakening the retry/audit rules.

It does **not** promote or complete F21: the user still receives only invisible
heartbeats during world resolution, recall, generation, and audit; failures are
still flattened; and there are no named progress or world-event frames. Those
remaining product problems are the typed-stream work described below.

## Why it matters

The player still sees an inert composer until an audited telling is ready
(the approved prose now reveals progressively after that point), cancellation
has no seam to hook (D18), retry can't be targeted, and every distinct failure — world catching up, render withheld,
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
- Can raw narrator tokens ever stream safely through the §23 audit loop? The
  approved-prose reveal now ships after the audit, but true provider-token
  streaming would need an incremental audit or a product ruling that replaces
  the hidden retry; neither is part of this stub yet.

## Slices

_(Defined at promotion.)_
