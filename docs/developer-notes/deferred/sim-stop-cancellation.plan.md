# Stop for successor replies — thread an AbortSignal through the turn

Status: draft (stub — successor-engine backlog item D18, parked 2026-07-24 from
the successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building)

## What

`POST /api/chats/[chatId]/stop` aborts via `stopChatReply`, which reads the
in-process `inflightReplyAborts` map (`chat-pipeline.ts:335`, read `:343`).
Only the legacy pipeline ever registers there (`:1184`) — the sim fork of the
send route awaits `runSimChatExchange` to completion and then enqueues the
whole prose as one chunk (`app/api/chats/[chatId]/route.ts:318-328`), holding
the `chat_exchange` lock the whole time (`:294`). A successor Stop click can
never interrupt the work it claims to stop: the endpoint 404s and the client
swallows the 404 silently (`chat-conversation.tsx:784-790`). (MED · M)

## Why it matters

A successor turn is the *slow* kind (recall drain + narrator render + audit
retries), which is exactly when players reach for Stop. Today the button is
dead precisely where it matters most, and the player gets no feedback at all.

## Sketch

- Thread an `AbortSignal` through `runSimChatExchange` → memory recall
  (`loadSimConversationContext`), the narrator render loop, and the provider
  call; register the controller against the chat id in the same map (or a
  successor-side registry keyed by exchange).
- Define abort semantics per phase: before the world commit → clean cancel;
  after commit, during render → the cut stands, the render is abandoned and
  the turn lands as "withheld" (rerenderable later) rather than half-written.
  A player Stop must never leave committed world events without a transcript
  row explaining them.
- Until built, report `canStop: false` through the D17 capability manifest so
  the button doesn't render on sim chats.

## Open questions

- Is stopping mid-render a *rerender later* affordance (cut committed, prose
  withheld) or does it roll the exchange back entirely pre-confirm? The
  engine's rerender-from-cut machinery suggests the former.
- Does abort need to reach the durable drain (probably not — drains are
  bounded and must converge; abort only the model-call phases)?

## Slices

_(Defined at promotion.)_
