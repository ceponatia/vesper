# Engine spec — operations: branching, boundaries, resilience, testing, rulings (§29–§40)

Status: companion to [engine.spec.md](engine.spec.md) — §29–§40, operations.

Part of the [engine.spec.md](engine.spec.md) contract set (split 2026-07-21).
Section numbering is GLOBAL across the engine.spec.* files — cite sections as
"engine.spec §N" exactly as before; the hub's index maps every § to its file. The
normative-keyword rules (MUST/SHOULD/MAY) are defined in the hub.

## 29. Retakes, rerenders, branches, and replay

### 29.1 Definitions

- **Rerender:** new prose for the same NarrativeCut. No new commands, events, observations,
  beliefs, milestones, embeddings, or body changes.
- **Retake:** fork from the pre-turn sequence and resolve a new outcome on the child
  branch.
- **Reach-back edit:** always a branch fork.
- **Projection rebuild:** replay the same branch events; not a retake.

The UI must distinguish these operations.

### 29.2 Legacy chat lane

Legacy character chat is a separate live lane, not a transitional state. Its group
regenerate MUST snapshot and restore every member's mutable pre-drift state — a
primary-only snapshot violates rollback integrity — and a reach-back rerun that cannot
restore all causal state MUST be rejected or implemented as a branch.

### 29.3 Branch fork

A fork records:

- parent branch ID;
- fork sequence and story second;
- parent ruleset and event schema versions;
- initiating principal and reason;
- inherited snapshot checksum.

Events after the fork are never shared by mutable reference. Memory and embedding queries
must include branch ancestry rules and sequence bounds.

## 30. API boundaries

The successor SHOULD expose intent-oriented APIs:

- submitCommand;
- advanceTo;
- getBranchState;
- getActorPerspective;
- openEngagement;
- prepareTurn;
- getNarrativeCut;
- confirmNarratorResult;
- rerenderCut;
- forkForRetake;
- rebuildProjection;
- explainEvent;
- queryEligibleMemory.

No public API should expose “set NPC location,” “mark schedule kept,” or “write current
meter” without a privileged migration/storyteller capability.

## 31. Package boundaries

The engine occupies three directories of this repository, one per authority layer:

| Directory                       | Contents                                              |
| ------------------------------- | ----------------------------------------------------- |
| `src/contracts/simulation/`     | Branded IDs, schemas, commands, events, registries    |
| `src/lib/simulation/`           | Pure kernels — validators, resolvers, rates, policies |
| `src/server/engine/simulation/` | Stores, transactions, sequencer, scheduler, outbox    |

The first two MUST have no database, network, file, process clock, model, or global random
dependency — a boundary the repository's ESLint `no-restricted-imports` rule enforces. The
server layer holds one store per domain plus the shared `runSimulationCommand` transaction
shell (§11.1); modules there import each other only through `index.ts` barrels.

## 32. TypeScript numeric and performance contract

TypeScript is acceptable if:

- story time and causal quantities use validated integers;
- deterministic collections are explicitly sorted;
- maps and sets do not leak insertion-order accidents into rules;
- schema parsing occurs at every trust boundary;
- the kernel avoids hidden Date, Math.random, locale, and floating-rounding behavior;
- property and replay tests run in CI;
- representative benchmarks track route, scheduler, projection, and catch-up costs.

A native rewrite is considered only after profiling identifies a stable pure kernel that
materially exceeds its budget. Candidate boundaries include route search, large
population flow integration, and spatial indexing. Database wait, model latency, or
poor query design are not fixed by Rust.

## 33. Resilience and diagnostics

All trust boundaries use resilient parsing and typed fallbacks:

- invalid model output selects deterministic fallback;
- unknown authored enum stays unknown;
- malformed private access fails closed;
- stale command returns conflict;
- duplicate command returns original result;
- failed async projection retries idempotently;
- failed narrator render retries the same cut;
- impossible event payload quarantines the branch and produces an operator diagnostic.

Diagnostics MUST include branch, sequence, command, event, derivation, and ruleset
identifiers where available. User-facing failure text must be perspective-safe.

The system SHOULD retain causal explanation records:

- which predicate rejected a command;
- which candidate scores led to deterministic policy;
- which trigger produced an event;
- which observations supported a belief;
- which provenance rows entered a cut.

Do not log secrets, private model reasoning, or unredacted prompts across authorization
boundaries.

## 34. Security and abuse model

### 34.1 Untrusted inputs

Treat as untrusted:

- player prose;
- narrator and agent output;
- imported character and schedule prose;
- RAG documents;
- soft canon;
- migration files;
- webhook or external-world inputs.

Each crosses schemas and capability checks before causing state.

### 34.2 Prompt injection

Retrieved text is quoted data, not instruction. The context compiler labels source class
and provenance. Authored or remembered text cannot grant capabilities, change viewpoint,
or ask the model to reveal private context.

### 34.3 Cross-world and cross-branch access

Every query joins through authorized world and branch identity. An opaque ID from another
world is not sufficient authority. Caches and embeddings must include tenancy and branch
keys.

### 34.4 Unsupported player assertions

Text that claims an impossible fact—“Mara is suddenly beside me,” “I already have her
key,” or “the door was open”—must be classified as speech, imagination, attempted
storyteller action, or unsupported action proposal. It cannot mutate projections.

### 34.5 Privacy

The compiler redacts before model invocation. Denials use FailurePresentation. Audit
systems may retain private causes but normal prompts, logs, embeddings, and UI errors may
not.

## 35. Observability

### 35.1 Per-command trace

Record:

- admission and authorization result;
- starting and ending branch version;
- due-trigger count;
- kernel duration;
- projection duration;
- event count and types;
- outbox count;
- selected policy candidate;
- model calls, tokens, and latency;
- NarrativeCut ID and hash;
- retries, degraded paths, and rejection code.

### 35.2 System metrics

- command p50 and p95 by type;
- narrator p50 and p95;
- branch lock wait;
- scheduler queue depth and overdue age;
- triggers processed per story day;
- projection lag and rebuild time;
- outbox retry age;
- event and snapshot growth;
- memory eligibility set size and top-k latency;
- model calls and tokens per turn and per actor-day;
- deterministic fallback frequency;
- perspective leak and impossible-claim test failures.

### 35.3 Explainability

An operator should be able to ask:

- Why is this actor here?
- Why did this NPC leave?
- Why was entry denied?
- Why does this actor believe this?
- Why did this commitment become late?
- Why did this memory enter the prompt?
- What changed between two branch sequences?

Answers must reference events, observations, ruleset versions, and public/private
boundaries.

## 36. Testing

### 36.1 Unit tests

- every command validator;
- every legal and illegal state transition;
- route and access predicates;
- modifier ordering and expiry;
- policy score and tie-breaking;
- NarrativeCut redaction;
- ArmedEffect confirmation;
- memory eligibility.

### 36.2 Property tests

- replay determinism;
- skip partition invariance;
- one physical locus;
- one item holding;
- resource conservation;
- no overlapping exclusive claims;
- idempotent retries;
- branch isolation;
- projection rebuild equality;
- no event before causal precondition;
- no arrival before lower-bound duration.

### 36.3 Integration tests

- command transaction crash before and after commit;
- scheduler retry;
- outbox duplicate delivery;
- stale branch version;
- concurrent engagement reservation;
- narrator timeout and same-cut retry;
- embedding failure with safe degradation;
- ruleset and event upcast.

### 36.4 Live-scene scenario tests

| Scenario                  | Required result                                                               |
| ------------------------- | ----------------------------------------------------------------------------- |
| 4pm shift                 | advance warning, decision, departure, travel, arrival or explicit consequence |
| player asks NPC to stay   | NPC choice changes; commitment and travel time remain                         |
| sleep                     | actor unavailable until a legal wake cue or choice                            |
| shower                    | no teleport or private-cause leak; channel behavior follows policy            |
| summon attempt            | request is routed to NPC controller; no instant co-location                   |
| doorstep and barge-in     | exterior arrival, separate entry check, explicit trespass if allowed          |
| competing chats           | one physical body reservation wins; other request gets legal alternative      |
| route delay               | arrival time changes through a causal event                                   |
| impossible narrator prose | auditor rejects or rerenders; projection remains correct                      |
| rerender                  | prose may differ; all state and memory hashes remain equal                    |
| retake                    | child branch differs; parent remains unchanged                                |
| viewpoint pair            | observer recalls material event; non-observer cannot                          |

### 36.5 Quality evaluation

Run paired, blinded baseline/treatment comparisons across 12–20 fixed scenarios with
multiple model samples. Score:

- voice;
- chemistry;
- continuity;
- pacing;
- causal enactment;
- contradiction;
- exposition;
- perspective leakage;
- player and NPC agency.

Initial acceptance:

- zero deterministic perspective leaks;
- at least 80 percent relevant must-enact coverage;
- no forced irrelevant-state mention;
- no median voice or chemistry decline;
- no material p95 increase without measured quality gain;
- routine progress adds no LLM call.

## 37. Migration and compatibility

### 37.1 Lane separation

The two lanes stay separate: legacy character chat, and successor chats bound to their own
simulated world and authoritative per the per-chat `engine_authority` flag. New interaction
patterns still prove out in the chat lane first. A chat-lane domain moves behind an adapter
only after the successor contract for it exists, and no fact may have two authorities.

### 37.2 Authored schedules

Rhythm and schedule entries carry a typed kind and stable destination references where
applicable (§25.5). There is no text inference over authored schedule prose: untyped text
MUST remain unknown and MUST NOT cause hard location or body events.

### 37.3 Events

Every event type has a schema version and pure upcaster. If semantics cannot be safely
upcast, freeze the old branch on its ruleset or run an explicit migration that emits
auditable events.

### 37.4 Projections and RAG

Projection schemas may be rebuilt. Embeddings may be deleted and regenerated from
authorized source rows. Neither operation changes domain history.

### 37.5 Feature flags

Authority flags apply per world or branch:

- legacy_chat;
- successor_shadow;
- successor_authoritative;
- successor_narrative_view;
- successor_rag_eligibility.

The application must display or log which authority served a turn.

## 38. Cheap architectural experiments

Before broad migration:

1. **Witness SQL eligibility:** use existing witnessedBy data as a WHERE condition before
   vector ranking for one observer/non-observer fixture.
2. **Schedule-kind shadow audit:** measure inferScheduleKind precision and unknown rate;
   false-positive hard effects fail the adapter.
3. **Grounded-context ablation:** add one deterministic redacted environmental or body
   read to current narration without a new model call.
4. **Minimum authority seam:** one item, two holdings, one transfer command/event/
   projection, one observer and one non-observer.

The first three should fit in sub-day spikes. The fourth should remain deletable and
should not acquire scheduler, body, economy, or autonomous-agent scope.

## 39. Product rulings

Rulings 1–11 and 13 were **resolved by the owner on 2026-07-17** (the Gate 3 unblock
pass); ruling 14 was **resolved on 2026-07-18** (the Gate 4 unblock pass); rulings 15–16
were **resolved on 2026-07-19** (the Gate 5 opening pass); ruling 17 was **resolved on
2026-07-22** (the R3 live-session clock finding); rulings 18–19 were **resolved on
2026-07-22** (the presentation-charter planning pass); rulings 20–21 were **resolved on
2026-07-23** (the world-UI planning pass); rulings 22–25 were **resolved on 2026-07-23**
(the drain-hardening promotion — full versions with alternatives-rejected context in
[finished/drain-hardening.plan.md](finished/drain-hardening.plan.md)'s detail docs);
rulings 26–30 were
**resolved on 2026-07-24** (the command-integrity passes A1–A4); and rulings 31–33 were
**resolved on 2026-07-27** (the successor-world-lifecycle work). Each resolved decision
is normative and MUST be stored in a versioned world-type rule or explicit product
contract, not only in a prompt. Ruling 12 remains **open** and is deferred to the work
that needs it.

1. **Ordinary dialogue duration** — RESOLVED: a fixed per-exchange story-time span (the
   current-lane ~1-minute default), versioned by world type. Explicit actions (travel,
   chores, sleep, wait) carry their own durations; dialogue itself is not content-estimated
   and is not player-timed.
2. **Shift/commitment firmness** — RESOLVED: per commitment, via the existing
   `Commitment.flexibility` dial (`soft | negotiable | firm | hard`). There is no global
   exact-versus-flexible switch; a world type sets defaults, each commitment overrides.
3. **Transgressive actions** — RESOLVED: permitted as explicit, modeled attempts per
   §14.3 (duration, noise, tools, lock/obstacle state, witnesses, interruption, and legal/
   social/safety consequence). They MUST never auto-succeed and MUST never override the
   target's agency. A world type MAY still disallow them and reject at admission with a
   public rule reason (§14.3). **This ruling governs spatial/property transgression only;
   interpersonal consent for touch or intimacy remains an independent action precondition
   (§14) that no spatial outcome can grant.**
4. **Storyteller privilege** — RESOLVED: admin principals only, and only inside an explicit
   storyteller mode. The privileged command family (§7) is always audited; ordinary player
   principals never receive it.
5. **Obligation disclosure** — RESOLVED: relationship- and personality-driven. How
   proactively an NPC reveals an obligation before leaving is an NPC-policy output, not a
   fixed rule; a guarded actor MAY decline to explain (see ruling 13).
6. **Missed-obligation consequences** — RESOLVED: deterministic built-in rules for the
   first build (no model call), emitting `CommitmentLate` / `CommitmentMissed` consequence
   events. Authored consequence tables and a bounded director are later, optional layers.
7. **Player concurrency** — RESOLVED: one physical locus per player. A player MAY hold at
   most one co-present Engagement; any concurrent Engagement MUST be remote (text, voice,
   or video). The player body is reserved exactly as an NPC body is (§11.3).
8. **Failed narration** — RESOLVED: a failed narrator turn is hidden and retryable, and the
   committed story-time advance is NOT surfaced to the player until a render succeeds. Hard
   state already committed for the cut is never reverted (§18.5) — only its presentation is
   withheld.
9. **Armed speech acts** — RESOLVED: all semantic speech acts in §23.3 (promise offered/
   accepted, invitation, disclosure, warning, boundary, question, apology) use ArmedEffect
   and are recorded only when the structured narrator result enacts them in meaning
   (paraphrase counts; no literal keyword is required).
10. **Initial performance target** — RESOLVED: small and intimate — an on-branch cast of
    roughly 2–8 exact-LOD actors and an off-screen horizon of hours to a few days. Larger
    populations and longer horizons are a later LOD target (Gate 6), not a first-build
    budget.
11. **Waking sleeping actors** — RESOLVED: by default a remote message is delivered but does
    NOT wake a sleeping actor (§16.4); it queues unread until a legal wake cue. World types
    MAY define emergency exceptions later.
12. **Route-estimate uncertainty exposure** — OPEN (deferred to Gate 3 travel polish; the
    §13.3 route result carries derivation uncertainty regardless of how much is shown).
13. **Lying about a private denial reason** — RESOLVED: an NPC MAY give an in-character
    cover story instead of the true private cause, consistent with personality. The true
    cause is still redacted from narrator context, prompts, diagnostics, and embeddings
    either way (§14.4, §34.5); the cover story is presentation, never a change to hard
    truth.
14. **Soft canon → authored canon promotion** — RESOLVED (2026-07-18): **safe
    auto-promotion, documented for tuning.** A soft-canon entry whose key survives the
    §23.4 validation checks and is reused across the ruled number of distinct committed
    cuts auto-promotes to authored/domain canon. Promotion is itself an audited event
    (never a silent write), carries the full soft-canon provenance (source cuts,
    confidence history), and has an explicit demotion path that retracts the promoted
    record without touching event history. Every knob — reuse count, minimum confidence,
    eligible scopes, expiry handling — is a versioned world-type value, and the defaults
    plus their tuning rationale MUST be documented so the mechanism can be retuned after
    it is built. A world type MAY disable auto-promotion entirely, falling back to
    explicit storyteller promotion.
15. **Gate 5 v1 body-meter scope** — RESOLVED (2026-07-19): **full chat parity.** The
    G5.1 substrate instantiates the entire chat meter economy in the engine v1, not a
    minimal proof set: energy as a stored 0–1 reserve with proportional (half-life)
    decay and linear sleep restore, read as the bidirectional axis
    `clamp(−1, +1, reserve − circadian pressure)` with both poles saturating (pressure
    derived purely from the story clock against the actor's own sleep rhythm — never
    stored); arousal regraded to body facts (graded physiological vocabulary, perception-
    gated signs, disinhibition scoped to intimate inhibition only); the intimacy pulse
    read with climax reset + afterglow (afterglow as a self-expiring condition); hygiene
    as clock-keyed drain against the actor's rhythm with window-crossing self-care and no
    blanket restore (§25.5). The normative semantics source for these ported meters is
    `chat-meter-economy.spec.md` (rulings OQ1–OQ3 and the meter taxonomy); the engine
    substrate expresses them in fixed-point units under §25's substrate/read law, and
    meter membership stays registry data (satiation/hydration/desire/bladder land as
    data edits, not schema changes).
16. **Interpersonal consent mechanics** — RESOLVED (2026-07-19): **ledger-gated with a
    policy escalation path.** Stated boundaries and granted permissions are typed
    relationship-ledger entries (§21.3); intimate-action preconditions check the ledger
    **fail-closed** — no covering entry means no permission, and a malformed entry admits
    nothing. An escalation attempt with no covering entry routes to the NPC-policy /
    §19.3 deliberator seam (bounded legal candidates, deterministic fallback = decline),
    and its accept or decline lands back in the ledger as a causal entry — so consent is
    always explainable, revocable by a later entry, and never grantable by any spatial
    outcome (ruling 3) or narrator prose.
17. **World-clock parity and player time control** — RESOLVED (2026-07-22): **the sim
    clock is the one time surface for a sim-routed chat, and the player keeps control
    of time skips.** Everything a sim-routed chat presents about time — narrator prose
    color, the header clock chip, skip-landing labels — reads the branch's
    `storySecond`, never the legacy chat clock (parity throughout the system; the
    legacy clock keeps governing legacy chats until R5 migrates the time domain). The
    player retains the ability to advance time by minutes / hours / days as an ordinary
    admitted command, alongside time advancing naturally through play. Near-term
    richness is what `storySecond` truthfully encodes (story day index + time of day +
    daylight band); **full calendar integration** (a calendar anchor on the world
    config mapping story time → weekday/date, with the optional-player-control surface)
    is the R5 time/clock domain's product shape, expanded there — not invented early in
    presentation.
18. **Sim-chat operation routing parity** — RESOLVED (2026-07-22, the presentation-
    charter planning pass): **no operation on a sim-routed chat ever falls back to the
    legacy narrator — every operation has successor semantics or is refused.**
    Regenerate/rerun re-render the SAME committed cut (same events, fresh prose;
    §22.3/§23 rerender-creates-nothing, confirm-by-id supersedence governing effect
    arming on the retake) — this is a different *telling*, not a retake of *outcome*;
    outcome-level retakes remain branch forks (§29). Attachments and legacy action
    chips are refused with the affordance hidden until each earns designed successor
    semantics. Detail: `presentation-charter.plan.md` §4.
19. **Successor "Continue" advances time** — RESOLVED (2026-07-22): Continue (and the
    character-opens beat) runs a real successor turn with **no player utterance** —
    the engagement span advances per ruling 1, the world may act, and the narrator
    renders the fresh cut. Continue is never presentation-only re-description; time is
    the successor lane's medium and the scene visibly breathes.
20. **Travel-control time semantics** — RESOLVED (2026-07-23, the world-UI planning
    pass): **skip-style arrival.** Player-initiated travel resolves within the same
    interaction: the travel affordance (and, for parity, an admitted natural-language
    move) composes the `move` command with a bounded `advance_time` to the journey's
    earliest arrival — tap, the clock jumps the travel duration, the player lands. The
    §17 journey machinery still runs underneath (in-transit locus, scheduled arrival
    trigger, re-validated arrival): skip-style is loop sugar over the same events,
    never a bypass, and the §17.1 lower-bound law (repartitioning a skip MUST not
    change arrival) holds. Detail: `world-ui.plan.md`.
21. **Solo turns away from the primary** — RESOLVED (2026-07-23, the world-UI planning
    pass): **dual-block narration.** When a turn runs without a co-present primary,
    the render is two blocks: (a) a player-side block reacting to what the player does
    in the world — looking around the zone, examining held items, local NPCs engaging
    — in the charter's second person; and (b) an **away vignette** of the primary
    character acting in their own location, interacting with the NPCs there, going
    about their routine, in third person. The engine supplies **routine-based MUSTs**
    (the primary's actual committed activities, commitments, and movements) to the
    narrator; within them the narrator is free to color, bounded by standing law: it
    cannot move the primary or create state (§65 non-goals), the primary does not
    travel aimlessly, and does not incessantly text/call the player. The Narrator
    input mode (the existing composer toggle) is the player's steering channel for
    giving the character things to react to. The vignette is **audience knowledge,
    not player-character knowledge** — it must never fold into the player's §20
    perception/knowledge or memory partitions; the privacy-law interaction (what a
    vignette may show when the primary's activity is private) is an open design point
    in `world-ui.plan.md`.

22. **Long skips are staged, server-owned catch-up** — RESOLVED (2026-07-23, the
    drain-hardening promotion): a long `advance_time` runs as short server steps, never
    one request that must survive the whole stretch; while the app is open the world
    card shows progress ("Day 12 of 30…"). Once a skip or travel starts, **the server
    owns completion** — a durable, leased time job (its own table, not `sim_outbox`)
    finishes the drain whether or not the app stays open, with a boot/next-request
    sweep so deploys strand nothing. While a time job is active on a branch, every
    mutation entry point turns away (the quiet catching-up face) — the in-process
    per-chat lock does not outlive the original request, so the guard is durable job
    state, not the lock.
23. **Never a 500 after a committed write; drains stop honestly** — RESOLVED
    (2026-07-23, drain-hardening; follows from resilience law): sim-command routes
    return 200 with an honest shape (what committed, how far time actually moved,
    why it stopped short) — `drain_diverged` 500s are gone. A transiently-failing
    trigger halts the drain AT its due second (`trigger_backoff`, distinct from
    budget exhaustion) so its event stamps at the second it was due — §12.4 partition
    invariance over wall-clock backoff. A terminally-failed trigger inside a job's
    window **blocks the job** for explicit repair, never a silent skip-over.
24. **Drain target ≡ arrival trigger due second** — RESOLVED (2026-07-23,
    drain-hardening): travel drains target `expectedArrivalAt` (the arrival trigger's
    due second), whatever values authored route configuration later supplies — the
    invariant is semantics-neutral. Every travel choreography verifies post-drain that
    the traveller left `in_transit`, and a still-in-transit actor **escalates to the
    durable time job** (recovery, not just a warn). A delay feature must bump
    `journey.expectedArrivalAt` AND reschedule the durable trigger; the job re-reads
    its target between steps so a mid-drain delay extends rather than strands.
25. **Composition half-failures are recorded, admin-only** — RESOLVED (2026-07-23,
    drain-hardening): every choreography fallback lands (a) in the affected message's
    persisted meta as a stable **public-safe code** (never exception text — meta rides
    the player-visible payload) and (b) as a durable `composition_fallback` tally row
    for the admin inspector. Players see only the honest prose; no player-facing
    notice or retry affordance.
26. **Contended sim commands turn away, never queue** — RESOLVED (2026-07-24,
    command-integrity A1): a sim command (chip / skip / travel / do_activity)
    arriving while the chat is busy — another command or a streaming reply —
    bounces immediately with the message lane's quiet busy face (`chat_busy`
    409). No bounded wait, no FIFO queue; the world card already greys chips
    during a same-tab op, so a visible bounce is rare and just refreshes the card.
27. **One shared per-chat lock for every writer** — RESOLVED (2026-07-24,
    command-integrity A1): sim commands and the headless `sim-turn` route take the
    SAME `chat_exchange:${chatId}` keyed lock the reply lanes hold, so chips,
    skips, and replies serialize per chat from any tab or headless caller.
    Retry-safety rides a dedicated `sim_command_requests` replay record
    (client-minted `requestId`, `started → completed | failed`, payload-hash
    bound, deterministic beat ids) so a duplicated request replays one response —
    no doubled time, no second beat. In-process on the single-machine deploy;
    re-keys by branch if it ever scales.
28. **The world's clock wins — a turn never fails because time moved first** —
    RESOLVED (2026-07-24, command-integrity A2): the turn-side story-time advance
    is tolerant (`at_least` target = `max(requested turnEnd, current clock)`), so a
    co-present turn overtaken by a concurrent drain lands at the drained clock as a
    LEGAL outcome — no error, no degrade diagnostic. Skip/travel drain callers keep
    the loud backwards guard (a backwards target there is a genuine logic bug, the
    class ruling 24 exists to catch).
29. **Send-vs-drain contention turns away, with the right words** — RESOLVED
    (2026-07-24, command-integrity A2): a send arriving while a drain holds the chat
    bounces with the same quiet busy face (mirror of ruling 26), but the copy says
    the world is catching up, not "a reply is still streaming" (the keyed lock
    carries a holder label). Client-side the composer disables during `skipBusy`
    (parity with the world-card chips), so the visible bounce is rare.
30. **Walk-with-me is one indivisible move** — RESOLVED (2026-07-24,
    command-integrity A4): a dedicated branch-locked `move_together` command commits
    scene-end + ONE shared journey (both actors on it) + one arrival trigger
    atomically, so a crash can no longer strand the pair mid-move and "together" is
    true by construction. `decideAccompany` re-runs inside the locked authority view
    (§14.2 — the player principal never moves an NPC); a decline renders as the
    command's own §14.4 refusal (one surface for accept and decline). A version
    conflict commits nothing (honest `rejected`), never a phantom solo travel.
31. **A successor world hard-deletes with its chat** — RESOLVED (2026-07-27,
    successor-world-lifecycle E20-1): the front door is 1:1 chat↔world, and the app
    treats archive as the everyday action (`archived_at` on the chat) and delete as
    the one destructive verb — so `deleteChat` deletes the world graph (one
    `sim_worlds` delete; cascades take branches + branch-scoped rows) in the same
    transaction, and every delete-confirm surface states the consequence.
    (Archive-the-world and detach-and-keep rejected; a D19 fork / multi-chat-world
    future re-opens this ruling.) The orphan-world sweeper
    (`sweepOrphanSimWorlds`, admin `POST /api/admin/self/sim/sweep-orphan-worlds`)
    applies the same ruling to already-leaked and degraded-path worlds — no chat on
    any branch, no pending provisioning record, 1h DB-clock grace (E20-2).
32. **Provisioning is synchronous and resumable — one world per tap** — RESOLVED
    (2026-07-27, successor-world-lifecycle E20-3): the player waits on one request;
    a durable `sim_provisioning_requests` record (client-minted `requestId`, state
    machine `requested → world_created → chat_created → relationships_seeded →
    ready | failed`, payload-hash bound) under an owner-scoped
    `successor_provision:${ownerId}` lock makes a retry RESUME a partial world —
    the `stw-` stamp derives from the idempotency key, so every seeder id is stable
    and the command-runner's dedupe finally applies. Completed requests replay
    verbatim; failures run compensating cleanup (no partial state survives —
    `seed_failed`/`flip_failed` retired for one `provision_failed`).
33. **The world quota counts what's real** — RESOLVED (2026-07-27,
    successor-world-lifecycle slice 4): the per-owner cap counts
    `successor_narrative_view` chats plus non-terminal provisioning records,
    checked inside the provisioning lock (race-free). Shadow chats no longer
    count; a `failed` record holds no slot; a resume/replay is never re-charged
    (a half-built world locked out by its own cap would strand forever).

## 40. Initial conformance checklist

An implementation conforms to the foundation when:

- accepted operations are commands resolved into immutable events;
- one branch owns one total event order and optimistic version;
- replay and projection rebuild are deterministic;
- scheduled triggers evaluate outcomes without a minute tick;
- schedule boundaries create pressure, not teleportation;
- movement uses one locus, routes, journeys, and lower-bound time;
- activities own claims and enforce compatibility;
- access, privacy, and consent are independent and fail safely;
- live engagements reconcile due and upcoming pressure before narration;
- player prose cannot command an uncontrolled NPC;
- routine NPC choices use deterministic policy;
- LLM deliberation is bounded to legal candidates;
- hard events commit before narration;
- semantic prose effects require ArmedEffect confirmation;
- NarrativeCut is immutable and perspective-safe;
- observations, assertions, beliefs, and truth remain distinct;
- retrieval filters eligibility before vector ranking;
- rerender is state-free and retake forks;
- current group retakes restore every member until migration;
- TypeScript kernel behavior is integer, seeded, sorted, tested, and benchmarked;
- scenario quality and latency meet the gates in the companion plan.
