# Chat reply-failure surfacing — accurate "didn't reply" popups

Status: shipped — 2026-07-13

## The problem

A narrator reply that never arrived surfaced as one guessed toast: _"The narrator
model returned nothing — usually a timeout."_ The client had exactly one bit to
work with (`received === false` on a clean 200 stream), while the server was
holding — and discarding — the real cause: `streamExchange`'s catch reduced every
distinct provider failure (401 bad key, 402 out of credits, 429, moderation block,
context overflow, upstream 5xx, socket reset) to a `log.warn` of `error.message`
and returned normally. Watchdog timeouts additionally masqueraded as player Stops
(they abort the same controller). And the plain-text token stream has no error
frame, so nothing could be reported in-band after the 200 committed.

Worse, the first-token watchdog (60s) was in a dead-heat race with Fly's ~60s
proxy idle timeout — with zero bytes flowed, whichever fired first decided whether
the failure was attributable at all.

## What shipped

- **Closed failure vocabulary** — `contracts/turns/chat-reply-failure.ts`:
  `timeout · rate_limited · no_credits · auth_failed · moderation_blocked ·
  context_too_long · provider_error · network · empty_reply · unknown`
  (registry pattern; unknown stored codes parse to `unknown`).
- **Classifier** — `classifyProviderError` (`server/ai/errors.ts`): unwraps
  `RetryError`, reads `APICallError.statusCode` + the OpenRouter `responseBody`
  envelope; moderation and context-length are text-matched before the status
  fallbacks (OpenRouter reports both under generic 4xx). The image lanes' body
  digger (`describeImageGenError`) was generalized to `describeProviderError`
  and now serves both lanes.
- **Persistence** — `character_chats.last_reply_failure` (jsonb, migration
  0045): written by `streamExchange` only on a **zero-text** settle, cleared by
  any settle, always before the generator returns (the client refetch strictly
  follows it). `resolveReplyFailure` (pure, tested) holds the verdict logic —
  watchdog trip outranks the shared stop flag; player Stop records nothing;
  clean zero tokens = `empty_reply`.
- **Surfacing** — transcript GET returns it on the `chat` envelope;
  `replyFailureToast` (`components/chat/reply-failure.ts`) maps each class to
  its own copy (provider words quoted where they add signal, 160-char cap,
  10-minute staleness guard, honest fallback when no record exists).
- **Watchdog race fix** — `CHAT_STREAM_FIRST_TOKEN_MS` 60s → 50s so the server
  reliably beats Fly's ~60s proxy idle kill and gets to record `timeout`.
- **Log fidelity** — the reply-stream `log.warn` now carries class + status +
  provider words instead of a bare `error.message`.

Details: `docs/character-chat/pipeline.md` §Reply failures.

## Out of scope / follow-ups

- **Session-lane parity.** The session narrator (`pipeline.liveNarrativeStream`)
  still reports static strings over SSE and has no watchdog at all. Chat leads
  (product direction 2026-07-13); port when the successor model firms up.
- ~~**`generateChecked` mislabeling.**~~ **Closed 2026-07-14** (agent-failure
  telemetry — [chat-agent-improvements.plan.md](chat-agent-improvements.plan.md)
  §Agent health): a transport failure now classifies through
  `classifyProviderError` and emits `${code}.api_error` with the provider's own
  class; only genuine schema failures still say `.parse_failed`.
- ~~**Durable chat diagnostics.**~~ **Closed 2026-07-14 for the failure half** —
  every failed agent leg is now recorded durably (an `events` row, `type =
  "agent_failure"`) with a suspected cause, and tallied in the inspector's
  **Agent health** panel; see [../resilience.md](../resilience.md)
  §Agent-failure telemetry. What remains un-persisted is the *non-failure*
  chat diagnostic stream (the `info`-level codes) — still `log.info`'d and
  dropped, with no chat equivalent of `turns.diagnostics`. Lower value now that
  the failures are visible.
- **Partial-then-died replies.** A stream that dies mid-reply persists the
  partial and records no failure (the reply is visible); the client shows no
  cause. Acceptable for now — the transcript shows what happened.
