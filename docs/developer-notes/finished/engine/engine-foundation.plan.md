# Successor world engine — implementation plan

Status: **shipped — 2026-07-21** (committed scope: gates 0–6, closed 2026-07-16 →
2026-07-21). The migration that put the engine under the live product closed 2026-07-22
in [engine.rollout.plan.md](../engine.rollout.plan.md). Archived 2026-08-16 with the
gate-0–6 docs: this hub and its closed gates are build history, and the reference layer
that replaced them for everyday reading is [docs/engine/](../../../engine/README.md).

**Two parts of the family deliberately stay live and are NOT archived**, because
neither is history:

- **[engine.spec.md](../../engine.spec.md) and its six cluster files** — the normative
  contract of a running system, cited from source as `engine.spec §N` at 147 call sites
  against a § index that never renumbers. Archiving it would point every one of those
  into a history folder.
- **[engine.gate7.institutions.md](../../engine.gate7.institutions.md)** — optional,
  never opened, and still carrying a `roadmap.md` line under Next.

Outcome: A player can talk to characters who keep living their own lives between scenes
— sleeping, eating, working, travelling, and hearing news from one another — so that a
character who is across town arrives late instead of appearing on cue, and knows only
what they actually saw or were told.

Companion to [engine.spec.md](../../engine.spec.md), which owns the normative contracts. This
document is the hub of the gate set: the goals the build was judged against, the gate
index, the standing decisions that produced the architecture, and the budgets it still
runs under. Each gate's own scope, build order, and shipped record lives in its
`engine.gateN.*.md` doc. The architectural argument this plan was written from is
[finished/world-engine-refactor.gpt.md](../../finished/world-engine-refactor.gpt.md).

The one-line direction:

> Build one deterministic, event-driven authority for world truth; let code resolve
> routine life and physical causality; let sparse LLM agents choose only among legal
> alternatives; and make the narrator render a perspective-safe committed cut.

## Where the engine stands

Gates 0–6 closed between 2026-07-16 and 2026-07-21; rollout R0–R6 (2026-07-21/22) made
the engine the world authority for successor chats and deleted the legacy world/session
model and its tables outright. A successor chat is born through the `/worlds` front door,
bound 1:1 to its own simulated world, and carries its authority on the per-chat
`engine_authority` flag. Legacy character chat remains a separate live lane.

What is still open on this track:

- **Gate 7** — institutions and macro simulation. Optional and never opened. Its
  sequencing precondition (rollout R6) exited 2026-07-22, so it is unblocked, but it
  opens only on the owner's call.
  ([engine.gate7.institutions.md](../../engine.gate7.institutions.md))
- **The live paired quality evals.** Every gate from 4 onward closed on its deterministic
  exit corpus per the owner's 2026-07-18 exit-scope ruling; the human-scored comparison
  was never run and rides the owner-gated spend list in
  [deferred.plan.md](../../deferred.plan.md) §Owner-gated live eval runs.
- **Product ruling 12** — route-estimate uncertainty exposure. The one ruling still open;
  deferred to the travel work that needs it.
- **The parked improvement backlog.** Post-rollout review findings live as draft stubs
  under `deferred/` and graduate one at a time on the owner's go, never in bulk
  ([deferred/CLAUDE.md](../../deferred/CLAUDE.md)).

## Standing decisions

These are the decisions the build was made under. They still govern the running engine
unless a §39 ruling supersedes one.

1. **TypeScript owns the production foundation.** The risks were authority, persistence,
   concurrency, scheduling, and evaluation — not raw arithmetic throughput. The kernel
   stays isolated, deterministic, benchmarked, and portable so a measured hotspot can
   later move to Rust or WASM without moving product rules.
2. **The engine is not an extension of the retired session model.** Useful ideas were
   recovered, but its aggregates, movement-by-turn, narrator authority, and permissive
   access defaults are not this architecture. That model was deleted at rollout R6.
3. **There is no per-minute world tick.** A durable scheduler jumps between due triggers,
   integrates continuous rates analytically, and records only material outcomes.
4. **Schedules express intent and constraints.** They never directly set an NPC's
   location or mark themselves kept because a clock boundary passed.
5. **A live conversation is a world activity.** It can consume attention and create
   dramatic pressure, but it cannot freeze jobs, sleep, travel, hazards, or other actors.
6. **LLMs do not own hard state.** They may interpret language, rank a small legal choice
   set, render narration, and propose soft canon. Commands, validation, domain events,
   projections, and access rules remain deterministic.
7. **Truth, observation, belief, memory, and prose are separate.** RAG is a perspective-
   filtered recall layer, never the source of physical truth.
8. **Gates are sequential, not parallel.** Each gate's exit is the next gate's
   prerequisite, so the foundation ran one gated path end to end; independent chat-lane
   fixes shipped alongside it.
9. **The first architecture slice was deliberately tiny.** Gate 1 proved one authority
   and one perspective invariant with a single item transfer; the rich-life scenario came
   much later.
10. **Chat-lane owner rulings were carried, not overridden.** Ruling 15 made
    `chat-meter-economy.spec.md` OQ1–OQ3 the normative semantics source for the engine's
    own v1 body meters, so the engine expresses the chat lane's economy rather than a
    competing one.

## Product goal

Vesper should feel as though characters continue to inhabit one causally coherent world
whether or not the player is looking. Characters should have bodies, commitments,
relationships, possessions, homes, work, travel, knowledge, privacy, and consequences.
The player should be able to influence that world without receiving omnipotent control
over NPC bodies or bypassing space, time, access, and consent.

The engine succeeds when it makes richer roleplay possible while preserving:

- character voice and chemistry;
- player agency;
- causal and physical continuity;
- perspective and privacy;
- bounded latency and model cost;
- replayability and debuggability;
- graceful degradation when models or background jobs fail.

## Non-goals

The foundation does not attempt:

- continuous physics, exact fluid dynamics, or a general scientific simulator;
- an LLM process for every character, institution, room, or minute;
- perfect psychological prediction;
- exact simulation of every commodity and anonymous citizen;
- natural-language text as the authoritative database;
- a universal action ontology before real scenarios demand it;
- a promise that all authored worlds use the maximum simulation depth.

The architecture admits greater depth, but each world type may choose packages, fidelity,
content rules, and population scale.

## Feasibility boundary

### Deterministic in code — the foundation's shipped surface

- stable world, branch, actor, place, item, activity, and event identity;
- travel over a bounded topology with time and access constraints;
- schedules, deadlines, preparation, lateness, cancellation, and consequences;
- body rates, thresholds, sleep pressure, hygiene, arousal, illness, and recovery;
- inventories, containers, ownership, reservations, and resource consumption;
- observation eligibility, disclosure, beliefs, gossip provenance, and contradiction;
- relationship ledgers and bounded derived reads;
- routine NPC policy, utility scoring, and event-driven catch-up;
- analytical low-detail populations and institutions;
- replay, branching, retakes, audits, and perspective-safe context compilation.

### Feasible only with approximation

- nuanced long-horizon plans;
- social reputation across large populations;
- labor, housing, and market behavior;
- emergent romance and conflict;
- urban traffic, queues, weather effects, and institutional response;
- thousands of off-screen actors.

These use aggregates, representative agents, bounded stochastic models, and
event-triggered promotion to higher detail. They do not pretend to be exact.

### Out of scope, deliberately

- one reasoning model call per NPC per turn;
- exact simulation of every anonymous person's private life;
- unrestricted narrator-created movement, items, injuries, or knowledge;
- a vector store queried as though similarity established truth;
- encoding every human action before shipping one end-to-end seam;
- choosing a systems language before a profiler identifies a stable hotspot.

## Component authority

The engine is a set of packages with explicit authority:

| Component                | Owns                                                    | Does not own                    |
| ------------------------ | ------------------------------------------------------- | ------------------------------- |
| Command gateway          | identity, authorization, idempotency, command admission | world outcomes                  |
| Simulation kernel        | validation, deterministic resolution, domain events     | prose or vector recall          |
| Branch sequencer         | one ordered stream per world branch                     | model calls                     |
| Scheduler                | due triggers and analytical integration                 | direct location changes         |
| Projections              | current query state                                     | historical authority            |
| Live-scene arbiter       | pressure, legal outcomes, committed transitions         | narration                       |
| Perception and knowledge | observation, assertion, belief eligibility              | physical truth                  |
| Context compiler         | one redacted NarrativeCut                               | creative prose                  |
| Narrator                 | presentation of the committed cut                       | hard state mutation             |
| Memory indexer           | searchable representations of eligible records          | canon decisions                 |
| Policy controller        | cheap routine NPC choices                               | bypassing validators            |
| Deliberator              | rare choice among legal candidates                      | inventing candidates or effects |

These run in one process. The boundaries are contracts and transaction seams, not a
requirement for microservices.

## How the gates were judged

Each gate could exit four ways — **advance** (evidence meets the declared exit criteria),
**revise** (the seam is valuable but the contract is wrong), **hold** (value is plausible
but cost or latency is unacceptable), or **stop** (the architecture does not outperform a
simpler current-lane solution). No gate was justified merely by appearing in this plan.
Every committed gate returned **advance**.

From Gate 4 onward the owner's 2026-07-18 exit-scope ruling governs what closing means: a
gate's deterministic exit corpus closes it, and any live-model quality check rides the
owner-gated spend list instead of holding the verdict.

## The gates

Each gate has its own doc carrying that gate's scope, build order, and shipped E-package
history. One line of status here; [roadmap.md](../../roadmap.md) stays the ordered index of
what to build next.

- **Gate 0 — establish trustworthy evidence** · closed (advance) 2026-07-16 ·
  [engine.gate0.evidence.md](engine-foundation.gate0.evidence.md)
- **Gate 1 — minimum authority seam** · closed (advance) 2026-07-16 ·
  [engine.gate1.authority-seam.md](engine-foundation.gate1.authority-seam.md)
- **Gate 2 — production identity, event kernel, scheduler** · closed (advance)
  2026-07-17, E2.1–E2.6 · [engine.gate2.kernel.md](engine-foundation.gate2.kernel.md)
- **Gate 3 — space, action, schedules, live-scene arbitration** · closed (advance)
  2026-07-18, E3.1–E3.5 · [engine.gate3.space-action.md](engine-foundation.gate3.space-action.md)
- **Gate 4 — perception, knowledge, narration, RAG** · closed 2026-07-19, E4.1–E4.5 ·
  [engine.gate4.perception-narration.md](engine-foundation.gate4.perception-narration.md)
- **Gate 5 — bodies, materials, households, relationships** · closed 2026-07-20,
  E5.1–E5.6 · [engine.gate5.bodies-materials.md](engine-foundation.gate5.bodies-materials.md)
- **Gate 6 — dual LOD and autonomous background life** · closed 2026-07-21, E6.1–E6.5 ·
  [engine.gate6.dual-lod.md](engine-foundation.gate6.dual-lod.md)
- **Gate 7 — optional institutions and macro simulation** · never opened; optional,
  owner-gated · [engine.gate7.institutions.md](../../engine.gate7.institutions.md)

## Dependency order, as executed

The critical path the build actually followed:

1. current invariant repair and baseline (Gate 0);
2. discriminating spikes (Gate 0);
3. minimum authority seam (Gate 1);
4. production identity and command/event foundation (Gate 2);
5. scheduler and projections (Gate 2);
6. space, actions, schedules, resources, journeys, access, and live-scene arbitration
   (Gate 3);
7. observation, knowledge, NarrativeCut, and RAG eligibility (Gate 4);
8. bodies, inventories, households, relationships, and material traces (Gate 5);
9. dual LOD and autonomous background behavior (Gate 6);
10. migration and rollout under the live product
    ([finished/engine.rollout.plan.md](../../finished/engine.rollout.plan.md), R0–R6).

Optional macro packages (Gate 7) sit after all of it and were never scheduled.

The queued chat-lane meter work was never blocked on this path, and the dependency ran
the other way: Gate 5's ruling 15 adopted `chat-meter-economy.spec.md`'s OQ1–OQ3
semantics as the normative source for the engine's own meters, so the engine already
implements the economy those plans describe — in the successor lane only. The chat-lane
plans as written name no engine contract; see [Open questions](#open-questions).

## What it cost

This plan estimated **60–120+ focused developer-days** for the foundation, at low
confidence across every line. The committed gates instead closed over six calendar days
(2026-07-16 → 2026-07-21), with the rollout taking two more (2026-07-21/22). The
per-slice estimates that produced that range are superseded and have been removed; what
each gate actually delivered is recorded in its gate doc.

## Quality evaluation

Architecture was not the outcome. Each gate closed on a deterministic exit corpus that
proves its invariants; the human-scored half of the comparison — 12–20 paired scenarios,
multiple samples per condition, blinded review of baseline versus treatment — has not
been run and is owner-gated spend.

### Human-scored dimensions — awaiting the live paired eval

- voice fidelity;
- chemistry and emotional specificity;
- continuity;
- pacing;
- causal enactment;
- contradiction rate;
- exposition burden;
- perspective leakage;
- player and NPC agency.

### Instrumented dimensions

- p50 and p95 turn latency;
- model calls and tokens per turn;
- deterministic resolver time;
- scheduler queue depth and lag;
- projection rebuild time and hash;
- degraded legs and retries;
- hard-effect repair attempts;
- invalid command and stale-version rates;
- context size by provenance class.

### Advancement thresholds

- zero deterministic perspective leaks in the fixed corpus;
- at least 80 percent relevant enactment of must-enact beats;
- no forced mention of irrelevant state;
- no decline in median voice or chemistry;
- no material p95 latency increase without a measured quality gain;
- routine world progress requires no additional LLM call;
- replay and skip-partition property tests pass for every supported domain.

Thresholds may be revisited with data, but never after seeing a result solely to make
that result pass.

## Latency and model-call budget

The default turn budget is:

- deterministic reconciliation and context compilation;
- one narrator call;
- zero routine state-agent calls;
- optional existing extraction only for information code could not know;
- at most one deliberator call when a consequential choice is genuinely close.

The deliberator must receive:

- the legal candidate list;
- compact goals, beliefs, commitments, and relationship factors;
- no capability to invent an action or bypass access;
- a deterministic fallback and timeout;
- a recorded rationale summary that is not treated as private chain of thought.

If a feature requires a permanent new model leg, it needs a measured quality gain,
failure behavior, and budget owner.

## Migration and rollout

**Complete.** The strategy this section once described became
[finished/engine.rollout.plan.md](../../finished/engine.rollout.plan.md) (R0–R6, shipped
2026-07-21/22). Its ground rules still govern the running system:

- **Authority is assigned per world or branch by flag, never per row.** A chat carries
  `legacy_chat`, `successor_shadow`, `successor_narrative_view`, or
  `successor_authoritative`; recall routing rides the orthogonal
  `successor_rag_eligibility` flag.
- **Rollback selects the previous authority flag or branch.** Events stay immutable for
  audit; rebuildable projections and embeddings may be dropped and regenerated. A schema
  migration must supply an event upcaster or explicitly declare the old branch frozen.
- **Retake and rerender semantics are the spec's** (engine.spec §29): rerender is new
  prose from the same committed cut, a retake forks, a reach-back edit always forks, and
  no in-place rewind may leave later events, beliefs, embeddings, or member state behind.

## TypeScript decision and exit conditions

The deterministic kernel lives in a package with:

- no database, network, clock, model, or global-random access;
- integer story time and fixed-point values where rounding affects outcomes;
- explicit seeds and stable iteration order;
- exhaustive command results;
- property tests, replay hashes, and benchmarks;
- serializable contracts that do not depend on TypeScript class identity.

Rust or WASM comes into consideration only when profiling repeatedly shows a stable pure
workload — route search, large-population analytical integration, spatial indexing —
consuming a material share of the latency budget. A rewrite is not justified by expected
future complexity alone.

## RAG decision

pgvector stays the final ranking stage for prose-scale recall, never the arbiter of
truth: eligibility is resolved relationally — branch, viewpoint, time, validity,
knowledge — before anything is ranked semantically, and every result carries provenance
and an epistemic label. Transient projections are not embedded as though they were canon,
and top-k similarity never infers witness, truth, supersedence, or current validity. Full
pipeline contract: engine.spec §24.

## Risks the architecture was built against

- **Event-sourcing scope expands without player value** — gate on one cheap seam and
  paired quality evaluation.
- **Narration becomes mechanical** — separate must-enact facts from creative licenses;
  score voice and chemistry.
- **World rules create excessive refusals** — return legal alternatives and public
  reasons, not a bare denial.
- **The scheduler creates hidden teleports** — schedule only evaluation triggers;
  movement requires action and journey events.
- **Privacy rules leak causes** — separate private cause from public failure
  presentation.
- **LLM choice destabilizes replay** — give it legal candidates, record the selected
  result and model metadata, keep the fallback.
- **Projection and event schemas drift** — version payloads, upcast, rebuild in CI, hash
  projections.
- **Too many agents increase latency** — deterministic policy by default; sparse
  deliberation only on measured ambiguity.
- **Text inference becomes permanent authority** — shadow, type new data, migrate,
  instrument, delete the adapter.
- **A TypeScript hot path becomes slow** — benchmark first; move only pure measured
  kernels.
- **Retakes corrupt state** — presentation rerender is state-free; an alternative outcome
  is a branch.

## Product rulings

Every product ruling is recorded normatively in **engine.spec §39**
([engine.spec.operations.md](../../engine.spec.operations.md)), which is their canonical owner
and the only place their wording lives. Rulings 1–11 and 13 were resolved 2026-07-17 (the
Gate 3 unblock pass), 14 on 2026-07-18 (Gate 4), 15–16 on 2026-07-19 (Gate 5), and 17–33
across the rollout and the work that followed it, 2026-07-22 → 2026-07-27.

**Ruling 12** — route-estimate uncertainty exposure — is the only one still open.

## Graduation scenario

The plan reserved one end-to-end scenario as the foundation's final proof: a named NPC
wakes with body state and household resources, prepares for a 4pm shift, remembers a
promise to the player, receives a message while showering, decides when and how to
respond, protects private knowledge, dresses from owned items, leaves with enough travel
time, encounters a delay, arrives late or on time, is witnessed by some actors but not
others, accrues workplace and relationship consequences, and later recalls the day from
their own perspective.

**It was never run as a single scripted arc.** Each gate closed instead on its own
deterministic exit corpus — Gates 3 through 6 each shipped one, `gate6-corpus.int.test.ts`
being the last — and the rollout then put the whole loop under live play, which together
cover the same ground piecewise. Whether the arc is worth building as one regression
fixture is an open question below.

## Definition of done

The foundation's conformance checklist is **engine.spec §40**, which owns the list. Gate
6's close satisfied its deterministic items. Two clauses stand apart: the group-retake
clause describes the legacy chat lane (repaired in Gate 0 G0.1 and unaffected by the
successor lane), and "scenario quality and latency meet the gates in the companion plan"
awaits the owner-gated live paired eval.

## Open questions

- **Ruling 12 — route-estimate uncertainty exposure.** How much of a route estimate's
  derivation uncertainty a player or NPC sees. The §13.3 route result carries it
  regardless; only the exposure is undecided. Detail: engine.spec §39.
- **Whether the graduation scenario becomes a standing regression fixture.** The per-gate
  corpora cover its ground piecewise; running it as one arc would need the live paired
  eval to supply the quality half of a verdict.
- **How the queued chat-lane meter plans relate to Gate 5.** The roadmap and the rollout
  close-out both describe [chat-meter-economy.plan.md](../../chat-meter-economy.plan.md) and
  [chat-body-needs.plan.md](../../chat-body-needs.plan.md) as porting through the Gate 5
  contracts, but neither plan names an engine contract, and Gate 5 took its semantics
  from the chat spec rather than the reverse. Whether those plans build in the chat lane,
  adapt onto §25, or are superseded by the successor lane is undecided.
