# Turn vs clock-advance race — "story time cannot move backwards"

Status: draft (successor-engine backlog item A2, parked 2026-07-23; **fleshed
out 2026-07-23 — owner rulings 1–3 recorded below**; still parked — promote per
[CLAUDE.md](CLAUDE.md) before building. Per ruling 3 it graduates **grouped
with A1 [sim-command-idempotency](sim-command-idempotency.plan.md) and A4
[move-together-atomicity](move-together-atomicity.plan.md)** as one
command-integrity plan — the trio is now discussion-complete: serialize (A1),
survive (A2), atomize (A4).)

## What

`prepareEngagementTurn` targets `staleClock + 60s` from a pre-read
(`arbiter-store.ts:181-188`); if a concurrent travel/skip drain advanced the
branch clock past that, the backwards-time guard (`scheduler-store.ts:703`)
throws, and the co-present turn path doesn't catch it (`sim-exchange.ts:940`
— the solo path does). The player gets a dead turn recorded as
`lastReplyFailure: "successor turn crashed: Story time cannot move
backwards"`. Reachable by typing a message while a skip/travel drain is still
running. (HIGH · S)

Verified at flesh-out (2026-07-23 — re-verify on promotion):

- **The race window is the whole remaining drain, not a millisecond TOCTOU.**
  `prepareEngagementTurn` reads the branch clock itself
  (`arbiter-store.ts:154-163`), computes `turnEnd = read + spanSeconds`
  (`:181`), and `advanceBranchStoryTime` re-reads under its own guard
  (`scheduler-store.ts:697-703`). The reads are close together — but the
  competing writer is `drainBranchTo`'s unbounded advance loop
  (`sim-exchange.ts:222-233`), and a long skip runs up to the 30s `budgetMs`
  per call while stepping the clock trigger by trigger. A send landing
  anywhere in that span reads a mid-drain clock and targets a second the
  drain then leaps past.
- **The throw happens before any turn writes** — the guard is the first check
  after `advanceBranchStoryTime`'s own read, and every write in
  `prepareEngagementTurn` (policy departures, deliberations,
  acknowledgments, the cut) comes after the advance. A clamped or caught
  race leaves zero half-committed state; the fix is purely semantic, no
  compensation path needed.
- **The dead-turn surface, end to end**: `runCoPresentTurn` calls
  `prepareEngagementTurn` bare (`sim-exchange.ts:940-949`); the throw
  propagates to the send route's stream body, which records
  `lastReplyFailure: "successor turn crashed: …"`
  (`app/api/chats/[chatId]/route.ts:342-354`). The player's line persisted
  before the scene gate (by design — a refusal never deletes what they
  typed), so the transcript shows a message with no reply.
- **The solo path is the in-repo counterexample**: `runSimSoloTurn` wraps its
  span advance in try/catch and "degrades to rendering at the current clock,
  never a failed turn" (`sim-exchange.ts:1658-1672`). Ruling 1 gives the
  co-present path the same guarantee — but as a *legal outcome*, not a
  logged degrade.
- **The single-tab repro is NOT client-guarded.** The composer's send guard
  checks `sendingRef` / `ready` / `archived` / `attachBusy` but **not**
  `skipBusy` (`chat-conversation.tsx:630-636`) — unlike the world-card
  chips, which disable on `busy={skipBusy || sending}`. Start a multi-day
  skip, type, hit send: the stub's "ordinary impatience" framing was
  understated — A1's client-disable mitigation never covered the composer.
- **Clock-advancer map** (who can race a live turn): the sim-command route's
  skip/travel drains and the headless `sim-turn` route (both unlocked today
  — A1 ruling 2 locks both); the admin branch-command route
  (`admin/sim/[branchId]/command/route.ts:143` — branch-keyed, takes no chat
  lock, and stays unlocked as a debug surface: ruling 1 is what protects
  live chats from it); the shadow/soak/rollout harnesses run on their own
  branches, never a live chat's.
- **Cross-link**: A1's shared `chat_exchange:${chatId}` lock closes the live
  send-vs-drain interleave by serialization; ruling 1 below is the
  semantics fix that holds wherever serialization isn't in force (the admin
  surface, a lock regression, a second machine someday). Two halves of one
  closure — hence the shared graduation (ruling 3).

## Why it matters

A failed turn with no reply is the worst successor-lane failure mode, and this
one needs only ordinary impatience to trigger.

## Owner rulings (2026-07-23 — copy into engine.spec §39 at promotion)

1. **The world's clock wins — a turn can never fail because time moved
   first.** The turn-side advance becomes tolerant: the effective target is
   `max(requested turnEnd, current clock)`, so a turn overtaken by a drain
   simply lands at the drained clock (its 60s beat subsumed by the hours the
   drain already moved). Landing there is a *legal outcome* — no error, no
   degrade diagnostic. Skip/travel drain callers keep the **loud** backwards
   guard: a backwards target there is a genuine logic bug (the A7
   `earliest`-vs-`expectedArrivalAt` mismatch is exactly the class it
   exists to catch). Alternatives **rejected**: catch-and-retry (same
   outcome, more machinery, exhaustible by a pathological writer);
   lock-only (leaves the admin surface — and any future lock bypass — able
   to kill a live turn).
2. **Send-vs-drain contention turns away, with the right words.** The mirror
   of A1 ruling 1: a send arriving while a drain holds the chat bounces with
   the same quiet busy face — but the copy says the world is catching up,
   not "a reply is still streaming". Client-side, the composer disables
   during `skipBusy` (parity with the world-card chips), so the visible
   bounce is rare (a second tab or headless caller). Bounded-wait and
   run-anyway were **rejected** (the first is A1's rejected queue in mirror
   form; the second re-opens the mid-drain interleave A1 ruling 2 closes).
3. **Graduates grouped with A1+A4** as the one command-integrity plan (owner
   accepted 2026-07-23) — serialize, survive, atomize.

## Sketch

- **Tolerant advance (ruling 1)**: an opt-in mode on `advanceBranchStoryTime`
  (shape at build — e.g. `target: "at_least"`): effective target =
  `max(requested, current)`, then the NORMAL drain loop runs against it, so
  anything due through the effective target still drains before the turn
  renders. The throwing guard stays the default for every other caller.
- **Wiring**: `prepareEngagementTurn` passes the flag. `runSimSoloTurn`
  passes it too and keeps its broad catch for *other* failures — its
  `simLoadWarn` stops recording a legitimate race as a degrade.
- **Bounce face (ruling 2)**: the keyed lock likely gains a holder label
  ("reply" vs "world catch-up") so the sim fork's lock-miss 409 can say
  which; a single generic "the world is catching up on this chat" copy is
  the fallback shape. Decide at build.
- **Composer disable (ruling 2)**: `send()` adds `skipBusy` to its guard
  (`chat-conversation.tsx:636`), and the composer surfaces the disabled
  state the way the chips do.
- **Tests** (resilience law: degradation tests assert fallback AND
  diagnostic): int test — start a slow fixture drain, run a co-present turn
  concurrently, assert the turn lands at the drained clock with a reply row
  and NO `lastReplyFailure`; unit tests on the at-least clamp (overtaken /
  not-overtaken / due-triggers-at-the-effective-target); a solo-path test
  that a pure race no longer logs the degrade warning.

## Slices

Sized for the grouped A1+A2+A4 command-integrity plan.

1. **Tolerant turn advance** — the at-least mode + `prepareEngagementTurn` /
   solo wiring + unit and int tests. (S)
2. **Send-vs-drain face** — lock-holder label (or generic copy) on the busy
   409 + the composer `skipBusy` disable; coordinates with A1 slice 1 (the
   lock itself and the client swallow-and-refresh land there). (S)

## Open questions

- How the busy 409 knows its cause — a holder label on `keyed-lock` (cheap,
  reusable, leaning yes) vs one generic catching-up copy for both cases.
- Does the admin branch-command route ever need the chat lock (it would have
  to resolve branch → chat to take it)? Leaning no — it is a debug surface
  and ruling 1 already makes it unable to kill a live turn; revisit only if
  admin-driven drains become a routine operation.
