# Command integrity — serialize, survive, atomize

Status: next (graduated 2026-07-24 from successor-engine backlog items **A1**
[sim-command idempotency + per-chat lock], **A2** [turn-vs-clock race], **A4**
[`travel_together` atomicity], grouped as one command-integrity plan — the trio
was discussion-complete at parking, owner rulings recorded below. All code refs
re-verified against the post-C14/C16 tree on promotion; see §Interactions.)

Three correctness defects on the successor command surface, one theme: composed
world-mutations must stay honest under concurrency, crashes, and retries.
**Serialize** (A1) so two submissions of one action can't interleave or double;
**survive** (A2) so a turn overtaken by a drain lands instead of crashing;
**atomize** (A4) so walk-with-me can't strand the pair mid-move. Each slice is
**independently shippable** — one plan, nothing waits on the slice behind it.

## The three defects (re-verified 2026-07-24)

### A1 — composed sim-commands: no idempotency, no per-chat lock (HIGH · S/M)
`[chatId]/sim-command/route.ts` (448 lines) mints fresh `newId()` per step per
request (player envelope `:123`; travel's scene-end step `:291`) and takes **no
lock** — the send lanes' `chat_exchange:${chatId}` keyed lock has no analog here
or on the headless `sim-turn` route. The command-runner's dedupe is sound but
unfed: it checks `(branchId, idempotencyKey)` twice (`command-runner.ts:83`,
`:120`) and CAS-guards at `:135`, but every entry mints a per-request key, so a
duplicated skip/travel/`do_activity`/`travel_together` (second tab, resubmit,
retry, event double-fire, headless caller) advances time twice and writes two
beats. `writeWorldBeat` is a plain insert (`sim-beats.ts`), so even stable keys
need route-level response replay for retry-safety. The command-runner also
replays **blind** — matches on key alone, no payload comparison — harmless while
keys are server-minted, load-bearing the moment client keys land.

### A2 — turn vs clock-advance race: "story time cannot move backwards" (HIGH · S)
`prepareEngagementTurn` reads the branch clock (`arbiter-store.ts:159,180`),
computes `turnEnd = fromStorySecond + spanSeconds` (`:181`), and calls
`advanceBranchStoryTime(branchId, turnEnd, …)` (`:185`), which throws
`"Story time cannot move backwards"` when `start.storySecond > target`
(`scheduler-store.ts:721`). If a concurrent skip/travel drain
(`drainBranchTo` → `advanceBranchStoryTime`, `sim-exchange.ts:292/302`) advanced
past `turnEnd` in the race window (the whole remaining drain, up to `budgetMs`),
the **co-present** turn crashes — `runCoPresentTurn` (`:1074`) calls
`prepareEngagementTurn` (`:1092`) with no catch, so the throw becomes
`lastReplyFailure: "successor turn crashed: …"` (`[chatId]/route.ts`) — a message
with no reply. The **solo** path is the in-repo counterexample: it wraps its
span advance in try/catch and degrades to rendering at the current clock
(`sim-exchange.ts:1895-1902`). Reachable by typing while a skip is still draining;
the composer's send guard does **not** check `skipBusy` (`chat-conversation.tsx`),
so even the single tab isn't client-guarded.

### A4 — `travel_together` isn't atomic (MED · M)
`runAccompanyTogether` commits scene-end, the player move (`submitDurableMoveActor`
`:1496`), and the primary move (a separate `submitDurableMoveActor` `:1523`) as
**three independent transactions**. A process death after the player's move
strands the pair — player in transit, primary at origin, scene ended, no beat —
and a retry refuses `not_copresent` (co-presence gate `:1438`); the in-process
`traveled_alone` degrade (`:1546`) never runs on a crash. The data model already
supports the fix: `Journey.actorIds` is a `≥1` list
(`contracts/simulation/space.ts`), `actor_departed` moves every listed actor and
`resolveJourneyArrival` lands them together (`lib/simulation/space.ts`) — only the
command that creates a multi-actor journey is missing.

## Owner rulings (recorded at parking 2026-07-23 — **copy into engine.spec §39 at build**)

- **A1-1 Contention turns away, never queues.** A sim command arriving while the
  chat is busy (another command or a streaming reply) bounces immediately with
  the message lane's quiet busy face (`chat_busy` 409). No bounded wait, no FIFO.
  (Queue-it rejected — it makes accidental double-actions the default.)
- **A1-2 One shared lock.** Sim commands take the SAME `chat_exchange:${chatId}`
  key the reply lanes hold; chips/skips/replies serialize per chat from any tab
  or headless caller. (Separate-sim-lock rejected — leaves the chip-vs-turn
  interleave open.)
- **A2-1 The world's clock wins — a turn can never fail because time moved
  first.** The turn-side advance becomes tolerant: effective target =
  `max(requested turnEnd, current clock)`, so an overtaken turn lands at the
  drained clock as a *legal outcome* (no error, no degrade diagnostic).
  Skip/travel drain callers keep the **loud** backwards guard (a backwards target
  there is a genuine logic bug — the class A7 exists to catch). (Catch-and-retry
  and lock-only rejected.)
- **A2-2 Send-vs-drain contention turns away, with the right words** — mirror of
  A1-1, but the copy says the world is *catching up*, not "a reply is streaming."
- **A4-1 One indivisible action.** A dedicated branch-locked `move_together`
  commits scene-end + one SHARED journey (both actors) atomically; "together" is
  true by construction (one journey, one arrival, one event). (Resumable-steps
  rejected — halfway states would still exist.)
- **A1-3 / A2-3 / A4-2 Grouped** as this one command-integrity plan.
- **A4-3** Stays parked until promoted in backlog order (now promoted).

## Design / sketch

**A1 lock** — `sim-command` and headless `sim-turn` wrap their handlers in
`tryKeyedLock('chat_exchange:' + chatId, …)`; a miss returns `chat_busy` 409
(A1-1). In-process is correct on single-machine Fly (revisit if it scales;
the A5 durable job-active guard is already branch-keyed and is the model for a
future re-key by branch).

**A1 idempotency** — the client mints a stable `requestId` per tap (in the POST
body, `parseOr`-bounded as a stable token); retries resend it, a genuine new
action mints a fresh one. Under the lock the route checks a recorded response
for `(chatId, requestId)` and replays it verbatim (beats not re-written, drains
not re-run). The record is a state machine `started → completed | failed`,
written `started` **before** execution, and the beat gets a deterministic id
derived from the key (`composeSimulationId`, uniqueness-constrained) so a
crash-window retry dedupes the beat at the insert even if the record never
completed. Store a canonical hash of `(kind, payload)` with the record → a
same-key resubmit with a different hash returns `idempotency_mismatch` 409, never
an unrelated replay. Composed kinds derive step envelope ids from the client key
(one suffix per step), and the idempotency replay is checked **before** the
duplicate-command-id refusal (`command-runner.ts:120-128`), so stable ids resume
instead of refusing; `do_activity` gains stable `deriveActivityId` across retries
as a bonus.

**A2 tolerant advance** — an opt-in mode on `advanceBranchStoryTime` (e.g.
`target: "at_least"`): effective target = `max(requested, current)`, then the
normal drain loop runs so anything due through it still drains before render. The
throwing guard stays the default for every other caller. `prepareEngagementTurn`
passes the flag; `runSimSoloTurn` passes it too and keeps its broad catch for
*other* failures (its `simLoadWarn` stops recording a legitimate race as a
degrade). Busy face: the keyed lock gains a holder label ("reply" vs "world
catch-up") so the 409 copy can name the cause; the composer's `send()` adds
`skipBusy` to its guard (parity with the world-card chips).

**A4 `move_together`** — a new sim-command submitted by the PLAYER principal for
player + invited co-traveler. §14.2 preserved and strengthened: the resolver
re-runs the deterministic `decideAccompany` policy **inside** the locked
authority view (closing the read-vs-commit agency race that exists today at
`:1452`); accept ⇒ one event batch (`engagement_ended` when a scene stands with
§18.2 grace, `journey_planned` with `actorIds:[player, primary]`, one
`actor_departed`, one `trigger_scheduled`), decline ⇒ the §14.4 public face as the
command's refusal. Projectors and the arrival resolver need no changes.
Choreography simplifies to: decide → submit `move_together` → drain to the one
arrival (A7 `expectedArrivalAt`) → one `together` beat; the two-move composition
and the mid-flight `traveled_alone` divergence disappear (a whole-command refusal
degrades to plain solo travel, recorded via C15).

## Interactions with the just-shipped C14/C16 work (2026-07-24)

- **A4 largely rewrites `runAccompanyTogether`** (`sim-exchange.ts:1400-1589`) —
  the exact path C16 just refactored. The new `computeMoveArrivalTarget` /
  `settleStrandedInTransit` / `planStrandedSettlement` helpers in
  `lib/simulation/travel-settle.ts` were built for the two-move composition;
  `move_together` collapses that to one shared journey, so much of the two-move
  arrival math is superseded (a single-journey arrival target). Keep
  `settleStrandedInTransit` as the post-drain A7 stranded check (still useful).
- **A2 wires into `runSimSoloTurn`** whose signature C16 just changed (it now
  takes an optional threaded `settledSpace`, used only on departure turns).
  The tolerant-advance flag rides the existing `:1896` advance call.
- **A1's threaded step keys** touch the departure/accompany submit sites that C16
  moved; re-grep the `newId()` submit sites before threading.

## Slices (independently shippable)

1. **The lock** (A1) — shared-key guard on `sim-command` + `sim-turn`,
   `chat_busy` 409 bounce, client swallow-and-refresh. Int test: two concurrent
   travels — one accepted, one 409, world advanced once. (S)
2. **Tolerant advance** (A2) — the `at_least` mode + `prepareEngagementTurn` /
   `runSimSoloTurn` wiring; unit tests (overtaken / not / due-at-effective-target)
   + int test (slow drain vs concurrent co-present turn → lands with a reply, no
   `lastReplyFailure`) + a solo-path test that a pure race no longer logs the
   degrade. (S)
3. **Busy face** (A1-2/A2-2) — lock-holder label (or generic copy) on the 409 +
   the composer `skipBusy` disable; depends on slice 1's lock. (S)
4. **Idempotency replay** (A1) — client `requestId`, route-level replay record
   (state machine + payload hash + deterministic beat id), threaded step keys;
   int tests: same-key resubmit of `advance_time`/`travel` replays (one drain,
   ONE beat), fresh-key applies again, mid-composition death resumes; crash-point
   tests after each committed step; degradation test asserts fallback + code. (M)
5. **`move_together` command** (A4) — contract + resolver (locked-view agency
   re-check, one event batch) + store wiring; pure resolver tests: accept,
   decline (§14.4 face), claim-conflict refusal, already-in-transit refusal,
   multi-actor journey landing both. (M)
6. **Choreography swap** (A4) — walk-with-me (chip + NL twin) submits
   `move_together`; delete the two-move composition; int test: one shared journey
   drains to one arrival, co-presence restored at the destination. (M)

## Testing

Resilience law throughout: degradation tests assert the fallback **and** the
diagnostic code. Integration tests need Postgres (gate in CI — no local
Postgres). Crash-point coverage for slice 4 kills the flow after each committed
step (command, beat, record) and asserts convergence to one drain / one beat /
one response.

## Open questions

Resolved-by-lean (adopt unless owner redirects): **A1** — NL choreographies do
*not* thread stable step keys in v1 (they run under the lock; retry story is "the
player sends again"). **A2** — the busy-409 learns its cause via a holder label
on `keyed-lock` (cheap, reusable); the admin branch-command route does *not* take
the chat lock (debug surface; A2-1 already stops it killing a live turn). **A4** —
the NL accompany intake keeps its existing admission and routes to the new submit
(no distinct admitted kind).

Resolved 2026-07-24 (owner):

1. **Route-level response record** → a **dedicated `sim_command_requests` table**
   for every command kind (uniform replay path; one migration), keyed by
   `(chatId, requestId)` with a `started → completed | failed` state machine, a
   `(kind, payload)` canonical hash, and the full HTTP result. (Piggyback-on-
   `sim_commands` rejected — two replay paths.)
2. **Declined co-traveler invite** → renders as the **`move_together` command's
   own refusal** (§14.4 public face IS the refusal; one surface handles accept
   and decline). (Pre-command choreography rejected.)
