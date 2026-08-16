# Engine operations

How the successor simulation engine is run safely once it is live: retakes,
branches and replay; resilience and security; observability; testing
approach; and migration practice. The normative source is
`engine.spec.operations.md`
(§29, §33–§38) — this doc explains current behavior in plain prose and cites
section numbers rather than restating them. API shape, package boundaries,
and the TypeScript numeric contract belong to the sibling
[boundaries.md](boundaries.md).

## Retakes, branches, and replay

### Operation vocabulary

Four distinct operations get confused if the UI doesn't distinguish them
(engine.spec §29.1):

| Operation           | What it does                                                        |
| -------------------- | -------------------------------------------------------------------- |
| Rerender              | New prose for the same NarrativeCut; no new commands or events       |
| Retake                | Forks from the pre-turn sequence and resolves a new outcome on the child |
| Reach-back edit       | Always a branch fork                                                 |
| Projection rebuild    | Replays the same branch's events; not a retake                       |

Legacy character chat is a separate, permanently live lane rather than a
transitional state, and it has its own rollback rule: a group regenerate
snapshots and restores every member's mutable pre-drift state, never only
the primary's, and a reach-back rerun that cannot restore all causal state
is rejected or run as a branch instead (engine.spec §29.2).

### Forking a branch

A fork records the parent branch ID, the fork sequence and story second, the
parent's ruleset and event schema versions, the initiating principal and
reason, and the inherited snapshot checksum (engine.spec §29.3). Events
created after the fork are never shared by mutable reference between parent
and child, and memory or embedding queries apply branch ancestry rules and
sequence bounds so a query never crosses into a sibling branch's history.

### Replay and snapshots

Forking a branch does not copy its history — it replays it. The child's
projections and trigger rows come from replaying ancestor events 1..N
through the same pure projectors that ran live (`replayBranchHistory`). An
alarm set at or before the fork point returns in the child; one set by the
discarded future never replays, so it never exists there. An alarm whose
firing is already inherited history replays as `completed` — replay
re-applies recorded outcomes, it never re-rolls the decision that produced
them.

The child also does not copy rows, it references them: it owns only its
post-fork rows, and every branch-scoped read walks the parent chain bounded
by each fork's sequence (`readBranchAncestryEvents` over
`composeAncestryEventBounds`). That bound is what stops a sibling branch's
post-fork events from leaking into an unrelated child.

Snapshots exist purely as discardable accelerators, never as a second
source of truth. `captureBranchSnapshot` checksums and stores the
projection payload at a branch's head (`simulationHash`, comparable
directly against live hashes); a fork snapshots the fork point
automatically. `rebuildDurableBranchProjection` can replay from zero or
from the latest snapshot and reports whether the rebuilt hash matches live
— tests keep the from-zero path exercised so a stale or wrong snapshot
can't hide a replay defect behind a shortcut.

Audit answers are read back from the same records, never reconstructed:
`explainItemPlacement` walks a projection fact back through the event that
placed it, the command that produced the event, and — when the event was
scheduler-dispatched — the trigger, the event that set it, and the command
that produced that event, entirely through ancestry and read-only.

## Resilience

The engine's trust-boundary and diagnostic patterns follow
[../resilience.md](../resilience.md): `parseOr` at every boundary,
diagnostics over exceptions, degraded defaults over failed turns. What the
engine adds on top of that baseline (engine.spec §33):

- Invalid model output resolves to a deterministic fallback rather than
  blocking the turn.
- An enum value the engine doesn't recognize (an unknown authored value)
  stays unknown rather than being coerced to a guess.
- Malformed private-access data fails closed.
- A stale command version returns a conflict; a duplicate command returns
  the original result instead of re-executing.
- A failed async projection retries idempotently; a failed narrator render
  retries the same cut rather than producing a second one.
- A stored event payload that fails its schema on read throws rather than
  resolving to a diagnostic (`branch-store.ts` parses it directly). There is
  no branch-level quarantine state to fall back to: `simWorlds.status` is
  `active`/`paused` only and `simBranches` has no status column at all.
  "Quarantine" in this codebase names per-obligation retry exhaustion in the
  outbox, scheduler, time-job, and memory-index stores — never a branch.

Diagnostics carry branch, sequence, command, event, derivation, and ruleset
identifiers wherever available, and user-facing failure text stays
perspective-safe — an error never reveals what a different actor would not
know. The engine also keeps causal explanation records: which predicate
rejected a command, which candidate scores drove a deterministic policy
choice, which trigger produced an event, which observations supported a
belief, and which provenance rows entered a NarrativeCut. None of this
logs secrets, private model reasoning, or unredacted prompts across an
authorization boundary.

## Security and abuse model

### Untrusted inputs

The engine treats all of the following as untrusted, each crossing schema
and capability checks before it can cause state: player prose, narrator and
agent output, imported character and schedule prose, RAG documents, soft
canon, migration files, and webhook or external-world inputs
(engine.spec §34.1).

### Prompt injection

Retrieved text is quoted data, never instruction. The context compiler
labels each piece of context with its source class and provenance, and
authored or remembered text cannot grant capabilities, change viewpoint, or
ask the model to reveal private context (engine.spec §34.2).

### Cross-world and cross-branch access

Every query joins through an authorized world and branch identity — an
opaque ID copied from another world is never sufficient authority on its
own — and caches and embeddings carry tenancy and branch keys so a lookup
can't accidentally serve another world's or branch's data
(engine.spec §34.3).

### Unsupported player assertions

Player text that claims an impossible fact ("Mara is suddenly beside me,"
"I already have her key," "the door was open") is classified as speech,
imagination, an attempted storyteller action, or an unsupported action
proposal — never as a fact. None of those classifications can mutate a
projection (engine.spec §34.4).

### Privacy

The context compiler redacts private data before it reaches the model.
Denials render through `PublicFailurePresentation` rather than leaking
their private cause. Audit systems may retain the private cause behind a
denial; ordinary prompts, logs, embeddings, and UI errors may not
(engine.spec §34.5).

## Observability

### Per-command trace

engine.spec §35.1 describes a per-command trace: admission and
authorization result, starting and ending branch version, due-trigger
count, kernel and projection duration, event count and types, outbox
count, the selected policy candidate, model calls/tokens/latency, the
NarrativeCut ID and hash, and any retries, degraded paths, or rejection
code. None of it is collected — `command-runner.ts` contains no logging or
tracing calls. The only durable record of a command is its `sim_commands`
row: branch ID, idempotency key, command ID, type, schema version,
expected version, principal kind, the command envelope, status
(`accepted`/`rejected`/`conflict`), result, and submitted/completed
timestamps — a replay and idempotency record, not a trace.

### System metrics

engine.spec §35.2 describes standing metrics: command and narrator p50/p95,
branch lock wait, scheduler queue depth and overdue age, triggers processed
per story day, projection lag and rebuild time, outbox retry age, event and
snapshot growth, memory eligibility set size and top-k latency, model calls
and tokens per turn and per actor-day, deterministic fallback frequency,
and perspective-leak / impossible-claim test failures. None of these are
collected as standing metrics. The only related computation
(`summarizeLatency`, `openQueueDepths`) lives in `soak-harness.ts`, a soak-test
harness that reports on one run rather than a running collector. No metrics library —
prom-client, statsd, OpenTelemetry — is a dependency anywhere in the
workspace.

### Explainability

engine.spec §35.3 describes explain answers for why an actor is present,
why an NPC left, why entry was denied, why an actor holds a belief, why a
commitment became late, why a memory entered the prompt, and what changed
between two branch sequences. `audit-store.ts` implements exactly one of
these: `explainItemPlacement`, which walks a projection fact back through
the event that placed it, the command that produced the event, and — when
the event was scheduler-dispatched — the trigger and the event and command
that set it. The other explain surfaces do not exist.

## Testing

General layers, commands, and the verification gate are documented in
[../testing.md](../testing.md); this section covers what the engine adds on
top of that baseline (engine.spec §36).

- **Unit** — every command validator, every legal and illegal state
  transition, route and access predicates, modifier ordering and expiry,
  policy scoring and tie-breaking, NarrativeCut redaction, ArmedEffect
  confirmation, and memory eligibility.
- **Property** — replay determinism, skip partition invariance, one
  physical locus, one item holding, resource conservation, no overlapping
  exclusive claims, idempotent retries, branch isolation, projection
  rebuild equality, no event before its causal precondition, and no
  arrival before the lower-bound duration.
- **Integration** — a command transaction crashing before and after commit,
  scheduler retry, outbox duplicate delivery, a stale branch version,
  concurrent engagement reservation, narrator timeout with same-cut retry,
  embedding failure with safe degradation, and ruleset/event upcast.

### Live-scene scenarios

A fixed set of scenarios each assert a required result end to end:

| Scenario                | Required result                                                    |
| ------------------------ | -------------------------------------------------------------------- |
| 4pm shift                | Advance warning, decision, departure, travel, arrival or consequence |
| Player asks NPC to stay  | NPC choice changes; commitment and travel time remain                |
| Sleep                    | Actor unavailable until a legal wake cue or choice                   |
| Shower                   | No teleport, no private-cause leak; channel behavior follows policy  |
| Summon attempt           | Request routes to NPC controller; no instant co-location             |
| Doorstep and barge-in    | Exterior arrival, separate entry check, explicit trespass if allowed |
| Competing chats          | One physical body reservation wins; the other gets a legal alternative |
| Route delay              | Arrival time changes through a causal event                          |
| Impossible narrator prose| Auditor rejects or rerenders; projection stays correct                |
| Rerender                 | Prose may differ; all state and memory hashes stay equal              |
| Retake                   | Child branch differs; parent stays unchanged                          |
| Viewpoint pair           | Observer recalls the material event; non-observer cannot              |

### Quality evaluation

Paired, blinded baseline/treatment comparisons run across a fixed bank of
12–20 scenarios with multiple model samples, scored on voice, chemistry,
continuity, pacing, causal enactment, contradiction, exposition,
perspective leakage, and player/NPC agency (engine.spec §36.5). Acceptance
requires zero deterministic perspective leaks, at least 80 percent relevant
must-enact coverage, no forced irrelevant-state mention, no median voice or
chemistry decline, no material p95 latency increase without a measured
quality gain, and no LLM call added for routine progress.

## Migration and compatibility

### Lane separation

Legacy character chat and successor chats stay separate lanes. A successor
chat is bound to its own simulated world and is authoritative according to
its chat's `engine_authority` flag. New interaction patterns still prove
out in the chat lane first; a chat-lane domain moves behind a successor
adapter only once the successor contract for that domain exists, and no
fact ever has two authorities at once (engine.spec §37.1).

### Authored schedules

Rhythm and schedule entries carry a typed kind and, where applicable, a
stable destination reference. There is no text inference over authored
schedule prose: untyped text stays unknown and never causes a hard location
or body event on its own (engine.spec §37.2).

### Events

Every event type carries a schema version, stamped as a fixed `z.literal`
on the envelope. engine.spec §37.3 describes a pure upcaster per event
type; none exists — there is no upcast or migration hook anywhere in the
engine. When semantics change, the practical options are freezing the old
branch on its original ruleset or running an explicit migration that
emits its own auditable events.

### Projections and RAG

Projection schemas can be rebuilt, and embeddings can be deleted and
regenerated from their authorized source rows — neither operation changes
domain history (engine.spec §37.4).

### Feature flags

The `engine_authority` column lives on `character_chats` — a per-chat
flag, not a per-world or per-branch one; `sim_worlds` and `sim_branches`
carry no authority column. It holds one of four values: `legacy_chat`,
`successor_shadow`, `successor_narrative_view`, `successor_authoritative`.
A separate boolean column on the same table, `successor_rag_eligibility`,
is read independently of the authority flag (engine.spec §37.5). The
application displays or logs which authority served each turn.

## Validating a migration before it ships

Before a chat-lane domain moves behind a successor adapter, the engine
de-risks the move with a small, deletable spike rather than committing to
the full adapter up front (engine.spec §38). Representative spike shapes:
checking whether existing witness data is enough to filter eligibility
before vector ranking; measuring a heuristic's precision and unknown rate
against a shadow audit before trusting it to drive hard effects; adding one
deterministic, redacted read to narration without a new model call, to see
what it changes; or wiring the smallest possible authority seam — one item,
two holdings, one transfer command/event/projection, one observer and one
non-observer — to prove the pattern before it grows scheduler, body,
economy, or autonomous-agent scope. A spike stays deletable; it earns its
way into the adapter only by holding up under the domain's real test
scenarios.

## Related

- [boundaries.md](boundaries.md) — API surface, package boundaries, and the
  TypeScript numeric/performance contract.
- [../resilience.md](../resilience.md) — the app-wide resilience patterns
  this doc's Resilience section builds on.
- [../testing.md](../testing.md) — test layers, commands, and the
  verification gate this doc's Testing section builds on.
- [@vesper/simulation-core](../../packages/simulation-core/README.md) — the durable
  authority transaction and the forks/snapshots/audit contract this doc's
  Retakes section describes.
- `engine.spec.operations.md`
  — the normative source for this entire document.
