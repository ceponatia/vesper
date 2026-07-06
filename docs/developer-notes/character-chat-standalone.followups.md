# Character chat — the standalone experience — follow-ups

Status: **shipped — 2026-07-06** — post-ship fixes from the adversarial review that
followed slices 6–9. Five findings triaged; four were real correctness bugs (fixed with
tests), one was the ruled-by-design rollback tradeoff (recorded, not changed). Plan:
[character-chat-standalone.plan.md](character-chat-standalone.plan.md) · spec:
[character-chat-standalone.spec.md](character-chat-standalone.spec.md).

The review ran a fan-out of finders over the whole slices-6–9 diff, then an adversarial
verify pass per finding. It surfaced a cluster around the "another take" rollback anchor
(`pre_exchange_state`) and the in-process exchange lock — exactly the two seams the
codebase-review notes flag as fragile (the single hand-written upsert column list, and
the chat lane's lack of a DB-level concurrency invariant).

## F1 — state mutations mid-stream clobbered by the finalizer *(fixed)*

**Major.** The exchange holds the `chat_exchange:<id>` lock across the whole stream, and
its finalizer (`finalizeChatState` → `saveChatState`) rewrites the **full** state-row
column list from the pre-exchange snapshot. But the state-mutation routes — time skip,
mark moment, the state-tools PATCH, the action chips — took **no** lock, so a mutation
that landed while a reply was streaming was silently overwritten by the finalize save
that followed it (the skip note cleared before it ever rendered, the clock reverted, a
marked moment lost).

**Fix.** A shared `chatBusyResponse(chatId)` guard (`src/app/api/chats/owned.ts`) returns
**409 `chat_busy`** — the same code the exchange itself uses — while
`keyedLockBusy('chat_exchange:'+chatId)` is true. The four mutating handlers call it right
after ownership resolves, before touching the state row. This matches the existing
in-process, single-machine concurrency model (a live streaming reply reliably holds the
lock across the entire settle, so the realistic "tap skip while watching the reply stream"
race is caught deterministically); a DB-level CAS is only warranted if the app ever scales
past one machine (see `keyed-lock.ts`). Covered by an int test that holds the lock and
asserts all four routes 409, then succeed once it releases.

## F2 — whole-snapshot rollback reverts post-settle edits *(ruled — by design)*

Listed by a finder as a bug, refuted on the intent lens: "another take" rolls the **whole**
state row back to the pre-exchange snapshot (spec §4.1), so an author edit made *after* the
reply settled but *before* the regenerate is discarded along with the exchange's own
effects. This is the **ruled** design — a single, legible rollback unit beats a
field-level merge whose "which edits survive a regenerate" rules no player could predict.
Recorded in the spec's adopted-defaults note; left unchanged.

## F3 — regenerating the FIRST exchange never rolled back *(fixed)*

**Major.** `savePreExchangeSnapshot(…, null)` writes `{}` for a first exchange (there was
no prior state — and `{}` is also the column default). `loadPreExchangeState` then parsed
`{}` against `storedChatStateSchema`, whose core keys have no defaults, so the parse
**failed** → returned null → the regenerate path fell back to the **post-exchange** state
as if it were the rollback anchor. Result: drift + pulse double-applied, the clock ticked
twice, the arc sample/`first_exchange` milestone re-derived on a state that already had
them.

**Fix.** `loadPreExchangeState` now returns a discriminated `{ found, state }`: a recorded
`{}` is the **null-pre-state sentinel** → `{ found: true, state: null }`, so the caller
re-seeds from the authored defaults exactly as the live first exchange did; a missing row
stays `{ found: false }` → degrade to no-rollback with the `chat_state.snapshot.missing`
diagnostic. Int test: regenerating the first reply lands the clock on **one** tick (not
two) with a single `first_exchange` milestone and one baseline arc sample.

## F4 — `first_exchange` skipped when a state row pre-existed the first send *(fixed)*

**Minor.** `firstExchange` was `input.preExchangeState === null`, but several paths create
the state row **before** the first message — a premise **Save**, an opening beat, a pickup
skip — so `loadChatState` returned non-null on the first real send and the baseline arc
sample + `first_exchange` milestone were silently skipped.

**Fix.** `firstExchange` now keys on `input.driftedState.relationshipHistory.length === 0`
(no arc sample recorded yet) — robust to a pre-existing row, and self-consistent (the first
exchange appends the baseline, so exchange two sees a non-empty history). Int test: a
premise-Save-then-first-send records the milestone + sample.

## F5 — rollback anchor written unguarded while the paired state save was guarded *(fixed)*

**Major (narrow race).** In the finalizer, `saveChatState` is guarded on the prompting
user message still existing (so a mid-stream delete can't resurrect a deleted row), but the
paired `savePreExchangeSnapshot` ran **unguarded** — so a prompting-message delete landing
mid-stream left the state save a no-op while the anchor was still overwritten, splitting
the two and pointing a later regenerate at a state that was never saved.

**Fix.** `savePreExchangeSnapshot` takes an optional `guardMessageId` and applies the same
`exists (select 1 …)` guard as `saveChatState`; the finalizer passes the same
`promptMessageId`, so both halves land together or neither does. (The opening-beat snapshot
write stays unguarded — an opening beat has no prompting message.)
