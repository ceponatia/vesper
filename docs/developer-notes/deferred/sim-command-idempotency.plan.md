# Composed sim-commands — idempotency + per-chat lock

Status: draft (successor-engine backlog item A1, parked 2026-07-23; **fleshed
out 2026-07-23 — owner rulings 1–2 recorded below**; still parked — promote per
[CLAUDE.md](CLAUDE.md) before building. Graduates **grouped with A2
[turn-clock-race](turn-clock-race.plan.md) and A4
[move-together-atomicity](move-together-atomicity.plan.md)** as one
command-integrity plan — see A4 §Owner rulings, ruling 2 (A2 joined the group
2026-07-23, its ruling 3). The trio is discussion-complete.)

## What

Every sim-command POST mints fresh envelope ids server-side
(`sim-command/route.ts:110`, plus a second fresh id for travel's scene-end step
at `:258`; `simPlayerEnvelope` sets `idempotencyKey: commandId` —
`sim-shared.ts:56-67`), so the command-runner's idempotency fast-path can never
dedupe two submissions of the same user action, and the route takes no per-chat
lock (the send path's `chat_exchange` keyed lock has no analog). A duplicated
skip request advances time twice and writes two beats; the same class applies
to `travel`, `do_activity`, and `travel_together`. (HIGH · S/M)

Verified at flesh-out (2026-07-23 — re-verify on promotion):

- **The dedupe machinery is sound; nothing feeds it.** The command-runner
  checks `(branchId, idempotencyKey)` twice — a pre-lock fast path and a
  re-check under the branch row lock (`command-runner.ts:79-86, 117-122`) —
  and replays the recorded result on a hit. But every entry point mints
  `newId()` per step per request (route `:110`/`:258`; the NL choreographies
  likewise — `sim-exchange.ts:1096, 1140` departure; `:1292, 1310, 1337`
  accompany), so the cache is write-once bookkeeping today, never a dedupe.
- **CAS is bypassed on every route command**: `expectedVersion: 0` +
  `admitAtLockedVersion: true` on all submissions, so the branch-version
  conflict that would catch a concurrent world change never fires. The branch
  row lock serializes individual commands; nothing serializes the composed
  sequences (end + move + drain + beat).
- **The send lane is already locked — BOTH flavors.** The legacy pipeline
  takes `chat_exchange:${chatId}` (`chat-pipeline.ts:433-458`), and the sim
  fork of the ordinary send route takes the SAME key
  (`[chatId]/route.ts:288-297` — "one reply in flight per conversation
  regardless of lane or kind"). The unguarded entries are exactly the
  `sim-command` route and the headless `sim-turn` route (`runSimChatExchange`
  takes no lock; that route adds none).
- **The client absorbs the visible double-tap in one tab**: the world card
  disables every chip while any card op or a reply runs
  (`chat-world-card.tsx:60`, fed `busy={skipBusy || sending}` —
  `chat-conversation.tsx:1122, 1374`), and `skipTime` guards on `skipBusy`
  (`:924`). The live server seam is a second tab, a resubmit/retry, event
  double-fire, and headless API callers — the stub's "double-tap" framing
  understated the client guard and overstated the single-tab path.
- **Beat writes are not idempotent**: `writeWorldBeat` is a plain insert into
  `characterChatMessages` (`sim-beats.ts:58-92`). Even with stable command
  keys, a replayed request re-runs its drain (a harmless no-op) but re-writes
  its beat (a duplicate transcript line) — full retry-safety needs
  route-level response replay, not just keys threaded into envelopes.
- **Suffixed step ids are legal**: command ids are opaque no-whitespace
  strings ≤ 256 chars (`identity.ts:10-19, 60`), and `composeSimulationId`
  (`identity.ts:87-89`) already exists for delimiter-safe composition. The
  client-minted key crosses a trust boundary — bound it with the
  stable-token shape in the body schema (resilience law: `parseOr` at every
  boundary).
- Cross-links: the shared lock also narrows A2's turn-vs-drain clock race
  ([turn-clock-race.plan.md](turn-clock-race.plan.md) names A1 in its
  sketch); A4's atomic `move_together` removes the worst composed sequence,
  leaving `travel`, `advance_time`, and `do_activity` as the composed
  survivors this plan makes retry-safe.

## Why it matters

The most likely bug to be hit in normal play — one duplicated request (second
tab, resubmit, or retry) doubles a time skip — and sim-command is the only
world-mutation surface that can still interleave with a streaming reply.

## Owner rulings (2026-07-23 — copy into engine.spec §39 at promotion)

1. **Contention turns away, never queues.** A sim command arriving while the
   chat is busy (another command, or a streaming reply) bounces immediately
   with the same quiet busy face the message lane uses (`chat_busy` 409). No
   bounded wait, no FIFO queue — the card's disabled chips make a visible
   bounce rare, and a rare bounce just refreshes the world card. The
   queue-it alternative was **rejected** (it makes accidental double-actions
   the default outcome).
2. **One shared lock.** Sim commands take the SAME `chat_exchange:${chatId}`
   key the reply lanes hold — chips, skips, and replies serialize per chat,
   from any tab or headless caller. A chip firing mid-reply is the same
   corruption class as A2's clock race; this closes that door server-side
   (the card already greys chips during streaming in the same tab, so no
   visible behavior changes). The separate-sim-lock alternative was
   **rejected** (it would leave the chip-vs-turn interleave open).

## Sketch

- **Lock (ruling 2)**: `sim-command` wraps its handler in
  `tryKeyedLock('chat_exchange:' + chatId, …)`; a miss returns the
  `chat_busy` 409 (ruling 1). The headless `sim-turn` route gets the same
  guard. In-process is correct on the single-machine Fly deploy
  (`keyed-lock.ts` header note) — revisit with the lock itself if the app
  ever scales past one machine.
- **Client-minted idempotency key**: the client mints a key per tap
  (`requestId` in the POST body, stable-token bounded); retries of the SAME
  tap resend the same key. A genuine second action after the first completes
  mints a fresh key — dedupe covers retries, the lock covers concurrency;
  both are needed and neither substitutes for the other.
- **Route-level replay**: under the lock, the route first checks a recorded
  response for `(chatId, requestId)` and replays it verbatim — beats not
  re-written, drains not re-run. The final response body is recorded before
  returning. (Where the record lives is the open question below.)
- **Threaded step keys**: composed kinds derive step envelope ids from the
  client key (via `composeSimulationId`, one suffix per step), so a retry of
  a request that died mid-composition resumes through the command cache
  instead of refusing — the idempotency replay is checked BEFORE the
  duplicate-command-id refusal (`command-runner.ts:117-128`), so stable ids
  are safe. `do_activity` gets a correctness bonus: `deriveActivityId(
  branchId, envelope.id)` becomes stable across retries, so a resumed
  request reads the same activity's `expectedCompleteAt`.
- **Client bounce handling**: a `chat_busy` on a chip is swallowed into a
  silent world-card refresh (the disable already covers the visible case;
  the send composer keeps its existing busy toast).

## Slices

Sized for the paired A1+A4 command-integrity plan (A4 §Slices carries the
`move_together` slices).

1. **The lock** — shared-key guard on `sim-command` + `sim-turn`, `chat_busy`
   bounce, client swallow-and-refresh; int test: two concurrent travels — one
   accepted, one 409, world advanced once. (S)
2. **Idempotency** — client key in the body, route-level replay record,
   threaded step keys; int tests: same-key resubmit of `advance_time` /
   `travel` replays the response (one drain, ONE beat), fresh-key resubmit
   applies again, and a mid-composition death resumes through cached steps.
   Degradation test asserts the fallback and the diagnostic code
   (docs/resilience.md law). (M)

## Open questions

- Where does the route-level response record live — a new
  `sim_command_requests` table, or piggybacked on the `sim_commands` row for
  single-command kinds with a table only for composed ones? (Leaning: one
  small table for all kinds — a uniform replay path beats two.)
- Should the NL choreographies (departure/accompany inside the locked
  exchange) also thread stable step keys? They already run under the lock,
  and their retry story is "the player sends another message" — leaning no
  until a real resume case appears.
