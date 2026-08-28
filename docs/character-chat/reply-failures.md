# Reply failures

A reply that never arrives is **classified and persisted, never guessed at**. The
plain-text token stream has no error frame — once the route commits its 200, the
only in-band signal the client can see is "zero bytes, clean close" — so the cause
travels out-of-band instead.

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
   model, finish reason, token counts, and the text length both BEFORE and AFTER the
   output normalizers. Counts and finish state only: no prompt, prose or reasoning
   content. A zero-visible-text exchange logs the whole record
   (`engine.chat "narrator produced no visible text"`).
3. `resolveReplyFailure` (pure) decides what the exchange records: only a
   **zero-text** settle records a failure (a partial that persisted is a visible
   reply); a watchdog trip outranks the stop flag it shares an AbortController with
   (`timeout`); a genuine player Stop records nothing. A zero-text settle that neither
   threw, timed out nor stopped is classified from the completion record
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

4. The verdict is written to `character_chats.last_reply_failure` (cleared by any
   exchange that settles) **before the generator returns**, so the route's drain —
   and therefore the client's post-exchange refetch — strictly follows it.
5. The transcript GET returns it on the `chat` envelope; the client's
   zero-tokens-received path hands it to `replyFailureToast`
   (`components/chat/reply-failure.ts`), which maps each class to its own copy
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

## One hidden retry, for one model

A narrator model may opt into a single hidden retry for a zero-visible-text completion
(`narratorHiddenRetryModel`, keyed by exact id in `server/ai/provider.ts`). It runs only
when nothing reached the player — so nothing can be duplicated — and never after a
content-filter or generation-error finish, a player abort, or a thrown exception. It
lives inside `streamCharacterChat`, so both attempts share the caller's abort signal and
the one first-token/overall watchdog budget. A partial reply is never retried, and every
model without an explicit policy entry surfaces the empty reply immediately.
