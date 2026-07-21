# Engine spec — operations: branching, boundaries, resilience, testing, rulings (§29–§40)

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

### 29.2 Current-lane bridge

Until the successor owns chat turns, group regenerate must snapshot and restore every
member's mutable pre-drift state. Primary-only snapshots violate rollback integrity.
Reach-back reruns that cannot restore all causal state must be rejected or implemented as
branches.

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

A recommended TypeScript organization:

| Package | Contents |
| --- | --- |
| engine-contracts | Branded IDs, schemas, commands, events, projection views |
| engine-kernel | Pure validators, resolvers, rates, routes, policies |
| engine-runtime | Transactions, sequencer, scheduler, outbox |
| engine-projections | Core and async projectors, replay |
| engine-knowledge | Observation, assertion, belief, relationship, eligibility |
| engine-narrative | NarrativeCut compiler, ArmedEffect, auditor |
| engine-adapters | Current chat, authored schedule, legacy import |

The pure kernel MUST have no database, network, file, process clock, model, or global
random dependency.

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

| Scenario | Required result |
| --- | --- |
| 4pm shift | advance warning, decision, departure, travel, arrival or explicit consequence |
| player asks NPC to stay | NPC choice changes; commitment and travel time remain |
| sleep | actor unavailable until a legal wake cue or choice |
| shower | no teleport or private-cause leak; channel behavior follows policy |
| summon attempt | request is routed to NPC controller; no instant co-location |
| doorstep and barge-in | exterior arrival, separate entry check, explicit trespass if allowed |
| competing chats | one physical body reservation wins; other request gets legal alternative |
| route delay | arrival time changes through a causal event |
| impossible narrator prose | auditor rejects or rerenders; projection remains correct |
| rerender | prose may differ; all state and memory hashes remain equal |
| retake | child branch differs; parent remains unchanged |
| viewpoint pair | observer recalls material event; non-observer cannot |

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

### 37.1 Current chat

Current chat remains the test bed until a successor seam passes its gate. Migrate one
domain behind an adapter only after the successor contract exists. Avoid dual authority.

### 37.2 Authored schedules

New entries require typed kind and stable destination references where applicable.
Existing free-text entries use shadow inference, corpus review, explicit unknown, and
telemetry. Inferred text must not cause hard location or body events without validation.

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
were **resolved on 2026-07-19** (the Gate 5 opening pass). Each resolved decision is
normative and MUST be stored in a versioned world-type rule or explicit product
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
