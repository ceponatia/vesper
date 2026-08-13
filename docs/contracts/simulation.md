[← Contracts index](README.md)

# Successor simulation contracts

The successor engine begins with the executable authority seam described by
[engine.spec.md](../developer-notes/engine.spec.md). Gate 1 proved that a
`transfer_item` request can be validated, resolved to one immutable
`item_transferred` event, synchronously projected, replayed, and compiled into a
perspective-safe NarrativeCut. Gate 2 target E2.1 promotes the causal primitives into
reusable production contracts.

The implementation lives in:

- `apps/web/src/contracts/simulation/identity.ts` — opaque branded identities and safe integer
  causal primitives;
- `apps/web/src/contracts/simulation/envelopes.ts` — principals and strict command, event, and
  exhaustive-result schema factories;
- `apps/web/src/contracts/simulation/item-transfer.ts` — the first command/event/projection,
  observation, and NarrativeCut family;
- `apps/web/src/contracts/simulation/scheduler.ts` — the E2.4 trigger contract, derived trigger
  identity, named deterministic draw streams, capped retry backoff, and the E2.5
  `schedule_transfer_item` command / `trigger_scheduled` event family;
- `apps/web/src/contracts/simulation/branching.ts` — the E2.5 branch-event union, fork input/result,
  snapshot, rebuild-comparison, and causal-explanation contracts;
- `apps/web/src/lib/simulation/item-transfer.ts` — pure resolver over a minimum authority view,
  projector, replay, cut compiler, prompt formatter, and the temporary in-memory runtime;
- `apps/web/src/lib/simulation/replay.ts` — pure E2.5 ancestry-bound math, seed reverse-derivation,
  and the deterministic branch replay driver with its trigger ledger;
- `apps/web/src/server/engine/simulation/item-transfer-store.ts` — the E2.2 PostgreSQL branch
  transaction and typed read/bootstrap adapter;
- `apps/web/src/server/engine/simulation/scheduler-store.ts` — the E2.4 durable trigger queue,
  lease/claim semantics, the bounded story-time advance seam, and the E2.5 durable
  schedule-command transaction;
- `apps/web/src/server/engine/simulation/branch-store.ts` (E2.5) — ancestry loading, the
  R4-bounded event read, live-state assembly, and `forkBranch`;
- `apps/web/src/server/engine/simulation/snapshot-store.ts` (E2.5) — snapshot capture/discard and
  rebuild-from-zero / rebuild-from-snapshot hash comparison;
- `apps/web/src/server/engine/simulation/audit-store.ts` (E2.5) — the read-only
  `explainItemPlacement` causal chain;
- `apps/web/src/server/engine/world-engine.ts` — the adapter into the existing character-chat
  narrator.

## Identity and causal primitives

Each identity family is a nominal TypeScript type backed by the same strict opaque string
shape. IDs are never trimmed, case-folded, resolved from display names, or accepted with
whitespace. World, branch, character, place, item, action, activity, commitment, journey,
engagement, command, event, trigger, observation, cut, outbox, and snapshot identities
therefore cannot be interchanged accidentally after parsing.

Deterministically derived identities use length-prefixed parts rather than ambiguous raw
delimiter concatenation. Event identity includes branch plus command identity, so the
same command ID on a causally isolated branch cannot collide in the global event catalog.

Story time and branch versions are nonnegative safe integers. Event sequence and schema
version are positive safe integers. Fractional, negative, infinite, and unsafe values fail
at the trust boundary.

## Command and event envelopes

Every command family uses one envelope factory: command identity, branch identity,
optimistic version, idempotency key, principal/controller grants, strict ISO operational
timestamp, optional requested story boundary, literal type/schema version, correlation
identity, and typed payload. The principal vocabulary includes player, deterministic NPC
policy, sparse NPC deliberator, system, director, storyteller, and migration authority.

Every event family uses one envelope factory with world/branch identity, branch sequence,
story time, ruleset, optional derivation and causation, correlation, stable actor/entity
reference sets, optional location, operational timestamp, and typed payload. Reference
sets must be sorted and unique so insertion order cannot become replay behavior.

Command outcomes share an accepted/rejected/conflict union. Accepted ranges cannot run
backward, skip a sequence, or repeat an event ID. Rejected public reasons and alternatives
remain separate from private predicates, while conflicts report the current branch
version.

## Item-transfer authority flow

`TransferItemCommand` uses the shared envelope and checks actor control, current source,
access to both holding containers, and destination capacity. Rejection and conflict do
not create domain history.

An accepted command emits one `ItemTransferredEvent` using the shared event envelope. The
event records observer IDs derived at resolution time under `gate1-perception-v1`; replay
therefore does not recompute historical visibility from newer state. The synchronous
projector moves the item to exactly one container and creates one typed observation per
eligible witness.

## Durable authority transaction

E2.2 persists parsed command outcomes by branch and idempotency key. A PostgreSQL
`FOR UPDATE` lock on `sim_branches` serializes resolution, event append, typed
`sim_item_holdings` update, branch advance, and command-result insert. The adapter
rechecks idempotency after it acquires the lock, so two concurrent retries cannot race
through the lock-free fast path.

The storage adapter loads only the actor, requested item and holding, two containers,
destination count, and eligible witnesses into `ItemTransferResolutionView`. The same
pure resolver serves the in-memory and durable paths. Rejections and optimistic conflicts
are durable audit outcomes but do not enter `sim_events`.

Crash failpoints are closed synchronous throw locations—never arbitrary callbacks under
the lock. Integration tests prove rollback after every pre-commit write, recovery from a
lost post-commit acknowledgement, one acceptance plus one conflict for concurrent
same-version commands, and one stored outcome when identical idempotent submissions race. The typed branch reader uses a read-only repeatable-read transaction so projection and history cannot straddle a concurrent commit.

## Perspective and narration

The NarrativeCut query joins through the observation ledger before it reads event detail.
An observer receives the transfer as one required beat. A non-observer receives no actor,
item, source, destination, event, or denial-cause detail—only a generic prohibition on
claiming unobserved inventory changes.

The existing narrator receives the cut only through
`buildCharacterChatPromptForNarrativeCut`. It may vary presentation, but the prompt grants
no additional hard transition. Rerender variants reuse the same cut ID and semantic hash
and have no command or persistence capability.

## Scheduling and story time

A trigger is a durable request to evaluate something at a future story second. Nothing
else makes it due: `advanceBranchStoryTime` moves the branch clock and drains whatever
becomes due, in `dueStorySecond` → `stableOrder` → `id` order (spec §12.1). A trigger
resolves through the same command transaction a player command uses, so it inherits that
seam's idempotency, ordering, and crash atomicity rather than reimplementing them.

Triggers express *when to evaluate*, never an outcome: a trigger carries a command to
submit, and the command is still validated, and may still be rejected, on its merits. The
trigger's own branch is authoritative for routing — a payload naming another branch is
refused by both the contract and a database check constraint.

Advance is bounded. A caller may declare `maxTriggers` and `budgetMs`; exceeding either
persists the boundary reached and returns `catch_up_required` (spec §12.3). Triggers are
never skipped and never approximated away.

Since E2.5, **a trigger is created only as the effect of a committed event**: a
`schedule_transfer_item` command appends a `trigger_scheduled` event inside the branch
transaction (spec §11.1 step 10), and `applyTriggerScheduledEvent` — the one projector that
inserts trigger rows — applies it live and again on fork replay. `scheduleDurableTrigger`
keeps its E2.4 signature as an idempotent wrapper whose command identity derives from the
trigger identity.

## Chat world read and player commands

A **routed** chat (successor lane, `engine_authority` past the view threshold, branch +
actors mapped) reaches the world through two chat-scoped surfaces, both gated by
`requireSimChat` (legacy/shadow chats are refused with 409 `not_sim_enabled`). The
conversation UI mirrors the gate client-side: it issues the world read only when the
transcript bootstrap's `chat.simRouted` is true (the server computes that flag with the
same `isSimRoutedAuthority` predicate the gate enforces, so a legacy chat never asks)
and treats any refusal as "no affordance":

- **`GET /api/chats/[chatId]/world`** → `readSimChatWorld` (`server/engine/sim-surfaces.ts`).
  The player-facing envelope: `place {label, privacy}` when the player is `at` a zone OR
  `transit {toLabel, arrivesInSeconds}` when `in_transit` (ETA = the journey's
  `earliestArrivalAt − storySecond`, floored at 0); `cast [{name, whereabouts, present}]`
  for every non-player actor (whereabouts via the shared `actorWhereabouts` decision —
  the same machinery `readSimChatPresence` uses); `destinations [{zoneId, label, mode,
  travelSeconds}]` (open, walkable links from the current zone, treated as **undirected**
  like the route planner, empty in transit); `held [{itemId, name}]`; `actions [{id, label,
  durationSeconds, available, unavailableReason?}]` (the branch's
  **player-startable** action definitions; `available` is the `at_zone_kind` law evaluated
  against the player's current zone kind via the pure `buildWorldActions`, the same law
  `resolveStartActivity` enforces; a `consent_covered`-gated action is marked unavailable);
  and `sceneOpen` (`isStandingCoPresentEngagement`, shared with the exchange's
  `findStandingEngagement`). Each `cast` member also carries `isPrimary` (the fixed
  `give_item` target). Zone labels are display **nouns** off the zone kind, and an action's
  `label` is its authored display label (`simulationActionDefinition.label`, an OPTIONAL
  jsonb field — no migration; unlabeled definitions fall back to an id-derived label) — never
  a raw id. The read is fail-open: a malformed projection degrades to `null` (a 503 the
  client reads as "no card"), never a throw (docs/resilience.md). Pure shaping lives in
  `apps/web/src/lib/simulation/world-read.ts`.
- **`POST /api/chats/[chatId]/sim-command`** carries the typed player commands
  (`move` · `end_scene` · `give_item` · `start_activity` · `advance_time` · **`travel`** ·
  **`move_together`** · **`do_activity`**). Each is the ordinary durable command under the
  player principal; a refusal returns the §14.4 PUBLIC face (code + public reason + legal
  alternatives), never a private cause.
  **`travel {toZoneId}`** is the skip-style composite (ruling 20) with a **graceful
  departure**: if a scene stands, END it as a CHOICE first
  (`end_engagement`, reason `participant_choice` — the lawful two-step `advance_time`
  performs), so the move that follows fires **no** hard interrupt (spec §18.2: an ended
  scene holds no claim to interrupt). Then submit the player `move` and — on acceptance —
  drain the branch clock to the resulting journey's `earliestArrivalAt` through the shared
  `drainBranchTo` + `moveArrivalTarget` helpers (the same bounded `advanceBranchStoryTime`
  loop `advance_time` uses); the §17 arrival trigger fires inside the drain. The `traveled`
  world-beat is phrased with the parting (`parted`) when a scene was ended. An unexpected
  end-engagement failure degrades to the interrupt path (the accepted move still
  interrupts) — travel is never blocked. Response `{status:"traveled", toStorySecond,
  arrived}`; a rejection returns the §14.4 shape at HTTP 200 (so the card can read
  `publicReason` + `legalAlternatives` instead of a flattened error body). Skip-style is
  loop sugar over the §17 events, never a bypass — the §17.1 lower-bound law still holds.
  **The natural-language twin** (an admitted "I walk to the town square", `sim-exchange.ts`)
  runs the SAME choreography (end-as-choice → move → drain → one parted beat) and then
  renders the farewell + walk + arrival through the **solo cut** (a departure context on the
  dual-block solo prompt), satisfying ruling 20's parity clause. The pure decision
  (`planDepartureChoreography`, `lib/simulation/departure.ts`) is scene-stands × admitted-kind
  → steps; give/rest/none keep the co-present flow.
  **`move_together {toZoneId}`** (command-integrity A4) is
  **walk-with-me**, **ONE atomic branch-locked command**: the player invites the
  CO-PRESENT primary to travel together. The primary's acceptance is **NPC agency via a
  bounded deterministic policy** (`decideAccompany`, `lib/simulation/accompany.ts` — no model
  call, no §21.4 consent-ledger touch per §39 ruling 16): **accept unless** (a) a claim-holding
  activity occupies the primary's **body**, or (b) a **`firm`/`hard`** open commitment falls
  due before the walk's arrival + a 300 s buffer. `decideAccompany` re-runs **inside the locked
  authority view** (`resolveMoveTogether`, `lib/simulation/move-together.ts`), so there is no
  read-vs-commit agency race (§14.2). A decline returns an
  honest §14.4 PUBLIC face — the SAME reason whether (a) or (b) blocks her, so the private cause
  never leaks. On **acceptance** the durable store (`submitDurableMoveTogether`) commits, in ONE
  transaction, an event batch: `engagement_ended` (when a scene stands, `participant_choice` —
  §18.2 grace) → `journey_planned` with **both** actors on one `Journey.actorIds` → ONE
  `actor_departed` → ONE arrival `trigger_scheduled` (built via the shared `buildJourneyBatch`
  `resolveMoveActor` also uses). "Together" is **true by construction** — one journey, one
  arrival, both land at once; the projectors and the arrival resolver already fan out over
  `actorIds`. §14.2 is preserved and strengthened: the player principal controls only the
  player; the co-traveller is authorized by the policy, never by the principal. After the atomic
  command, `runAccompanyTogether` (`sim-exchange.ts`) only settles time — drain to the ONE
  journey's arrival, the A7 `settleStrandedInTransit` net, ONE `together` world beat. Response
  `{status:"accompanied", toStorySecond, arrived}`; a decline / refusal returns the §14.4 shape
  at 200 (`status:"rejected"`). **No stranding window:** the command is both-or-neither — a
  whole-command failure commits nothing, so a bare version conflict degrades to an honest
  `rejected` (world unchanged, C15-noted), never a phantom solo travel and never a pair split
  mid-walk. **The natural-language twin** is an admitted
  **`accompany`** intent (input admission — first-person plural or invite phrasing "let's walk
  to the square" / "we head home" / "walk with me…" / "come with me…", over a known zone word,
  deterministic, checked before solo move): while co-present it runs the same choreography then
  reopens the scene at the destination and renders the co-present turn with a travel-context
  line (on accept) or the decline as a §14.4 failure presentation (on decline); while NOT
  co-present it degrades to a plain solo move — inviting an ABSENT partner (the §14.2
  remote-invite family) is not supported.
  **`do_activity {actionDefinitionId}`** is the analogous
  skip-style composite for an activity: submit the player's `start_activity`, then — on
  acceptance — drain the branch clock to the just-started activity's `expectedCompleteAt`
  (deterministic id via `deriveActivityId(branchId, commandId)`) through the same
  `drainBranchTo` helper. Completion is trigger-scheduled AT start (§16.3), so the drain
  fires it — the route never submits `complete_activity`, and the activity never dangles
  active. A claim conflict (resting mid-scene) surfaces as the §14.4 face at 200. Response
  `{status:"performed", toStorySecond}`.
  **`give_item {itemId}`** hands the player's held item to the
  primary (player→primary held→held, the only legal transfer today). Giver/receiver
  co-location is enforced by the transfer resolver itself (§26.4 step 7 — the destination's
  root zone must equal the acting actor's zone), so an absent primary refuses
  `root_not_colocated` with no route-level precheck; the card additionally disables the
  affordance when the primary is not present. Returns the §14.4 face at 200 on rejection, or
  `{status:"gave"}` on success.
  On commit, `travel` / `advance_time` / `end_scene` / `give_item` / `do_activity` each write
  a durable **world beat** to the chat transcript (a side effect, not part of the response):
  an ordinary `role: "assistant"` message row marked
  `meta.worldBeat = { kind }`, the phrased line on `content`, stamped through
  `formatSimLanding`. The beat kinds are `traveled` ("You walk to …", or "You take your
  leave and walk to …" when a departure ended a standing scene — the `parted` flag —
  or "You walk to … together." on a walk-with-me — the `together` flag, which
  supersedes `parted`) · `time_skipped` · `scene_ended` · `gave_item` ("You hand {primary} {item}. ·
  <landing>") · `rested` ("You {label} a while. · <landing>", phrased generically from the
  action label). Best-effort (`writeWorldBeat`,
  `server/engine/sim-beats.ts`): a failed beat write logs `engine.sim.world_beat` and never
  fails the committed command.

## Forks, snapshots, and audit

A branch forks at a past sequence N into a causally isolated child
(`forkBranch`, spec §29.3; owner rulings R1–R4 in
[engine-forks-snapshots-audit.plan.md](../developer-notes/engine-forks-snapshots-audit.plan.md)):

- **Replay, not copy (R1).** The child's projections and trigger rows are produced by
  replaying ancestor events 1..N through the same pure projectors that ran live
  (`replayBranchHistory`). An alarm set at or before N returns; one set by the discarded
  future never replays and so never exists. An alarm whose firing is already inherited
  history is recorded `completed` — replay re-applies recorded outcomes, never re-rolls
  decisions.
- **Reference, not copy (R4).** The child owns only its post-fork rows. Every
  branch-scoped read walks the parent chain bounded by each fork sequence
  (`readBranchAncestryEvents` over `composeAncestryEventBounds`), so a sibling's post-fork
  events can never leak in.
- **Snapshots are discardable accelerators (§10.4).** `captureBranchSnapshot` checksums
  and stores the projection payload at the branch head (`simulationHash`, comparable with
  live hashes); forking snapshots the fork point automatically (the plan's default
  cadence: on fork + on demand). `rebuildDurableBranchProjection` replays from zero or
  from the latest snapshot and reports whether the rebuilt hash matches live — tests keep
  the from-zero path exercised so a wrong snapshot cannot hide a replay defect.
- **Audit answers from records (§35.3).** `explainItemPlacement` walks a projection fact
  back through the event that placed it, the command that produced the event, and — when
  scheduler-dispatched — the trigger, its setting event, and the setting command, through
  ancestry, read-only.

## Deliberate limits

Durability covers only the first item-transfer family. The in-memory adapter remains a pure
test/replay fixture; production persistence has crash atomicity, cross-process branch
locking, durable command results (E2.2), asynchronous rebuildable consumers (E2.3), and a
durable trigger queue (E2.4).

Deliberately absent:

- **Trigger cancellation.** No mutation path cancels a trigger. A cancellation must be an
  event effect exactly as creation is (a `trigger_cancelled` family) — anything else and
  fork replay resurrects cancelled alarms.
- **A trigger never sets location directly.** Movement is a journey plus its arrival
  trigger; a scheduler outcome that wrote a locus would bypass the §17 laws.
- **Deterministic draws are recorded, never re-rolled.** Any consumer of
  `deterministicDrawUnit` records stream, index, value, and derivation version on the event
  that consumed it, so replay reproduces the draw instead of drawing again.
