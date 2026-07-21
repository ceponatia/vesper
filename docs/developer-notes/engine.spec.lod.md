# Engine spec — simulation and inference LOD (§27–§28)

Part of the [engine.spec.md](engine.spec.md) contract set (split 2026-07-21).
Section numbering is GLOBAL across the engine.spec.* files — cite sections as
"engine.spec §N" exactly as before; the hub's index maps every § to its file. The
normative-keyword rules (MUST/SHOULD/MAY) are defined in the hub.

## 27. Simulation LOD

### 27.1 Levels

| Level | Resolution |
| --- | --- |
| exact | Explicit activities, claims, resources, routes, and observations |
| event | Resolve named actors only at material transitions |
| aggregate | Resolve population or institution flows and sampled outcomes |
| dormant | Perform no work until an incoming dependency or promotion trigger |

LOD is a performance choice, not permission to violate invariants.

### 27.2 Promotion

Promotion from aggregate to exact MUST:

1. identify aggregate facts already committed;
2. reserve conserved quantities;
3. sample missing detail with a named deterministic stream;
4. emit a MaterializedFromAggregate or equivalent event;
5. preserve known observations, commitments, relationships, and causal constraints.

The engine must not materialize a detail that contradicts something already observed.

§26.10 concretizes this for the item-promotion case (the mechanism E5.4 builds first);
other promotion targets (an aggregate NPC becoming exact-LOD, §27.1) reuse the same
five-step shape but are out of E5.4's scope.

### 27.3 Demotion

Demotion may compact unobserved routine detail into a summary projection, but immutable
material events remain. Active contested claims, named scarce items, unresolved
commitments, and near-boundary hazards prevent demotion.

### 27.4 The per-actor LOD ledger (E6.1)

Simulation LOD and inference LOD (§28) are independent axes on one branch-scoped,
fully-evented ledger row per actor (`sim_actor_lods`). The ledger is sparse: an actor
with no row MUST read the versioned registry defaults (`actor-lod-v1`: `exact`
simulation + `deliberator` inference — the values every pre-Gate-6 call site assumed),
so assigning nothing changes nothing. Assignment is `assign_actor_lod` — storyteller
and system principals only, audited through `actor_lod_assigned`, whose payload
captures the replaced effective values so history explains itself without reads.

The §27.3 demotion guards are enforced fail-closed inside the command transaction, in
fixed order: the actor's claim-holding activities (§16.3), then unresolved temporal
pressures (§15.2), then claim-holding engagements (§18.2) — the first blocker names
the structured rejection. Only a simulation-axis move toward less resolution guards:
the inference axis is a model-budget dial, and raising simulation resolution for a
named actor whose full state already exists is bookkeeping (promotion FROM an
aggregate is §27.2 and stays E6.4's contract). LOD bookkeeping is not a world event —
it derives no observations, no memory documents, and no narrative beats.

Every consumer resolves an actor's LOD through one read seam (the effective read:
assigned row or defaults). The §19.3 deliberator admission consumes the acting NPC's
inference LOD per actor; the §21.4 consent escalation consumes the deciding target's.

### 27.5 The below-event alarm law (E6.3)

Below `event` (aggregate | dormant) an actor performs no scheduled work at all.
`assign_actor_lod` enforces this at the boundary:

- Landing below `event` additionally requires no ACTIVE body condition
  (`demotion_blocked_active_condition`): a live self-expiring condition is a §27.3
  near-boundary hazard — retiring its expiry alarm would leave the projection lying
  about when it ends — so a sleeping actor cannot be tucked into dormancy until they
  wake.
- Whenever the simulation axis MOVES, the actor's full body-alarm set (every meter's
  threshold alarm plus the collapse alarm) is retired unconditionally (the
  restock-reconfigure idiom) and, when the new level is `event` or `exact`, re-armed
  fresh from re-solved law as the same command's trigger_scheduled events. Landing
  below `event` re-arms nothing; inference-only changes never touch body alarms. The
  routine alarm keeps its E6.2 law (retired on every assignment, re-armed at `event`).
- `initialize_actor_body` for an actor already below `event` initializes the substrate
  (meters exist, reads stay pure and lazy) but arms no alarms — the no-work law holds
  on every path.
- Replay mirrors the retirement (a simulation-axis-moving `actor_lod_assigned` retires
  the actor's body-alarm keys); re-arms ride the command's own events, so forked
  children carry no phantom alarms.

Reads are untouched: a dormant actor's meters keep drifting analytically and integrate
lazily at read time — LOD gates scheduled work, never read law. Waking is a promotion
back to `event`/`exact`. Waking on an INCOMING DEPENDENCY (a command or engagement
reaching a below-event actor) is E6.4's promotion/catch-up concern; until then an
explicit command acting on a below-event actor is an authored intervention whose own
alarms will fire — promote the actor first.

### 27.6 Population cohorts (E6.3)

A cohort is a branch-scoped CONSERVED COUNT of unnamed background people — one row no
matter how many it holds. It MUST exist only through `cohort_created`
(storyteller/system principals; presence-window zones validated fail-closed) and
change only through `cohort_adjusted`: integer deltas with a closed reason vocabulary
(`authoring | influx | attrition | promotion_reservation`) capturing both the replaced
and resulting counts (audit-without-reads). An adjustment below zero is a structured
rejection (`insufficient_population`), never a clamp. Fork children rebuild rows from
inherited events.

Presence is ANALYTIC — the §27.1 aggregate level made concrete. Authored minute-of-day
windows (half-open, wrapping midnight; overlaps resolve to the earliest
(start, end, zone) triple) each place `floor(population × share / 10 000)` people at
one zone; outside every window the cohort is dispersed. A presence read writes no
rows, arms no triggers, and consults no model: aggregate world state is a pure
function of authored data and the story clock, so ten times the background population
is the same one row and the same zero per-minute work. A zero count at a zone is a
real read ("the square is empty tonight"), not an absence. Cohort bookkeeping events
are not perceptible, derive no observations, and never become beats or memory — a
crowd's ebb reaches a viewpoint only through the presence read.

A cohort MAY wear a §26.10 means band (the means-subject vocabulary is
actor | household | cohort); it can never be lot-tracked — lot loci do not name
cohorts — so its means read is band-tracked or `unknown` by construction.
Institutions remain households + restock (§26.8–26.11) in v1; extending the restock
routine to zone-locus shop stock is deferred until a scenario demands it.

E6.4 consumes this substrate: actor promotion debits the source cohort
(`promotion_reservation`) before materializing a named actor (§27.2 step 2), so a
promoted actor's existence can never contradict aggregate history.

## 28. Inference LOD and model budget

Simulation LOD and inference LOD MUST be independent. A physically exact activity may
need no model call, while an aggregate political decision may justify one deliberation.

The default turn has:

- deterministic input admission;
- deterministic world reconciliation;
- deterministic context compilation;
- one narrator call;
- zero routine state-agent calls.

Optional calls require an explicit budget and fallback. Background agents MUST NOT fan
out once per NPC or once per meter. Batch classifiers, deterministic reducers, and outbox
workers are preferred.

