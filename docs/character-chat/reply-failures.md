# Reply failures

A reply that never arrives is **classified and persisted, never guessed at**. The
plain-text token stream has no error frame — once the route commits its 200, the
only in-band signal the client can see is "zero bytes, clean close" — so the cause
travels out-of-band instead. The same channel carries the one failure that does
stream text first: a pathological one-token `length` stub, which the exchange
withholds instead of keeping as a reply.

## How a failure is classified

1. **A provider failure usually does not throw.** `streamText`'s `textStream` drops
   error parts and delivers the failure to its `onError` callback, rejecting the
   `finishReason`/`usage` promises — so a failed generation arrives as a clean stream
   of zero deltas. `streamCharacterChat` therefore captures the error from `onError`
   and classifies it there; `streamExchange`'s catch still covers a genuinely thrown
   error. Either way the classifier is the same `classifyProviderError`
   (`server/ai/errors.ts`): it unwraps the AI SDK's `RetryError`, reads
   `APICallError.statusCode` + the provider error envelope in `responseBody`, and also
   recognizes an error envelope delivered as a plain JSON object in-stream (an
   upstream that answers HTTP 200 and puts `{"error": …}` in an SSE frame). It maps
   them onto the closed `ChatReplyFailureCode` vocabulary
   (`contracts/turns/chat-reply-failure.ts`) — timeout, rate_limited, no_credits,
   auth_failed, moderation_blocked, context_too_long, provider_error, network,
   empty_reply, unknown.
2. **How the generation ended is recorded, not inferred.** `streamCharacterChat`
   reports a `NarratorCompletion` (`server/ai/narrator-completion.ts`) — provider,
   model, finish reason, token counts, the output cap the request actually carried
   after the model gateway merged it (absent when it sent none), and the text length
   both BEFORE and AFTER the output normalizers. Counts and finish state only: no
   prompt, prose or reasoning content. A zero-visible-text exchange logs the whole
   record (`engine.chat "narrator produced no visible text"`), and so does a withheld
   stub (`"narrator length stub withheld from the transcript"`).
3. `resolveReplyFailure` (pure) decides what the exchange records, and `streamExchange`
   resolves it **before** settlement: a reply settles only when the verdict records no
   failure. A **zero-text** exchange records a failure; an exchange with text records
   nothing (a partial is a visible reply) except the one-token `length` stub below. A
   watchdog trip outranks the stop flag it shares an AbortController with (`timeout`);
   a genuine player Stop records nothing. A zero-text exchange that neither threw,
   timed out nor stopped is classified from the completion record
   (`classifyEmptyNarratorCompletion`) rather than assumed silent:

| Evidence                                | Recorded as                         |
| --------------------------------------- | ----------------------------------- |
| `content-filter` finish                 | `moderation_blocked`                |
| `error` finish                          | the provider error's own class      |
| raw text > 0, none survived normalizing | `empty_reply` / `normalizer_erased` |
| reasoning tokens reported, no prose     | `empty_reply` / `reasoning_spent`   |
| `length` finish, no reasoning reported  | `empty_reply` / `length_capped`     |
| billed output tokens that never arrived | `empty_reply` / `hidden_output`     |
| `stop` finish with no such evidence     | `empty_reply` / `model_silent`      |
| no usable evidence                      | `empty_reply`, no cause             |

4. `engine/chat-reply-store.ts` writes the verdict to
   `character_chats.last_reply_failure` (cleared by any
   exchange that settles) **before the generator returns**, so the route's drain —
   and therefore the client's post-exchange refetch — strictly follows it.
5. The transcript GET returns it on the `chat` envelope. The client's
   zero-tokens-received path always hands it to `replyFailureToast`; after a stream
   that DID deliver text, the popup fires only when `replyWithdrawnAfterStreaming`
   says the fresh record withdrew it (the `length_stub` cause), so no other record can
   turn a visible reply into a "didn't reply". `replyFailureToast`
   (`components/chat/reply-failure.ts`) maps each class to its own copy
   (quoting the provider's words where they add signal) with a 10-minute staleness
   guard. An `empty_reply` carrying a cause takes that cause's copy instead of the
   class copy, so the popup never claims the model said nothing when the server knows
   it hit the length cap or that Vesper's own normalizers erased the reply. **No
   cause's copy names a mechanism the metadata did not measure**: only
   `reasoning_spent` carries a reported reasoning-token count, so only it blames a
   thinking chain — which matters because no Featherless narrator reports a reasoning
   split at all: the thinking rows are asked with `enable_thinking: false`, and the
   rest never emit a chain. Credential
   failures name the upstream only when the recorded model id identifies one
   (`narrativeModelProvider`), and say "the model provider" otherwise — the narrator
   list is multi-provider. No record ⇒ honest "no cause recorded" copy.

Adding a failure class = a literal in the contract + a copy entry in the client map
(registry pattern — never a migration; unknown stored codes parse to `unknown`). The
same is true of `ChatReplyFailureCause`, the optional refinement of `empty_reply`.

## The one-token `length` stub

A completion that reports `finish: length` after one output token or fewer, on a
request whose output budget was larger, is not a credible narrator turn: it claims it
ran out of room after a single token of a budget many times that. `isNarratorLengthStub`
(`server/ai/narrator-completion.ts`) is the model-agnostic test, and all three facts
are required:

- the finish is `length`;
- the generation reported one output token or fewer — by the total count, else by the
  text/reasoning split, and only when the provider reported neither, by exactly one
  character of raw text arriving;
- the request's cap was above one token, or the request carried no cap and the host's
  own default governed. A request deliberately capped at one token that stops there
  did what it was asked.

It is not a minimum reply length. A one-word or one-character reply that finishes on
`stop` settles like any other, and a long reply that ran into a real cap is not a stub.

The stub's fragment streams to the player before the finish is known, so its handling
is at the settle boundary rather than in the stream:

- **It never settles.** No assistant row, no take on a regenerate (the prior take
  stays), no post-turn fan-out, and nothing enters history — the exchange ends exactly
  like an empty reply, so the prompt's zero-successor rerun is its retry path.
- **It records `empty_reply` / `length_stub`**, with a detail naming the reported
  output, the budget and the fragment's length. Like a normalizer erasure, no reply
  was kept.
- **The client retracts it.** The post-exchange refetch replaces the streamed bubble
  with the stored transcript, and the popup explains the discarded fragment.
- **A player Stop wins.** Stop, a watchdog trip and a thrown stream error keep their
  partial exactly as before; the stub rule applies only to a generation that finished
  on its own.
- **It is never retried.** A second attempt would append a new answer after a fragment
  the player already saw. The failure surfaces at once and the player's retake or
  rerun replaces it cleanly.

## One hidden retry, for one model

A narrator model may opt into a single hidden retry for a zero-visible-text completion
(`narratorHiddenRetryModel`, which reads the exact model's adapter in
[text-models](../text-models/README.md)). It runs only
when nothing reached the player — so nothing can be duplicated — and never after a
content-filter or generation-error finish, a player abort, or a thrown exception. It
lives inside `streamCharacterChat`, so both attempts share the caller's abort signal and
the one first-token/overall watchdog budget. A partial reply is never retried — the
one-token `length` stub included — and every model whose adapter does not earn the
hint, including every model with no adapter at all, surfaces the empty reply
immediately.

The hint is earned by a **measured** intermittent empty reply on that exact model, never
by family resemblance: a retry costs a player the latency of a second generation, so a
model that has always answered must not pay for one that has not.

The retry's only difference from the first attempt is a floor on generated tokens, and
only when the first attempt was a genuinely silent stop (`narratorEmptyWasSilentStop`) —
an empty that burned output tokens gets no floor, because it did not stop early. The
floor rides the model gateway's per-call layer, so it outranks the model's own profile
for that one attempt and the host dialect spells its wire field; the lane names no
request field itself. A floor applied to every call, rather than to this one retry, is
how narrator padding gets resurrected.
