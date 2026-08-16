# Knowledge, Belief, and Memory

This doc covers what a character in the successor simulation engine knows and
believes, how that spreads between characters, how relationship state and
interpersonal consent are tracked, and how the engine recalls any of it back
into a scene. The normative contract is `engine.spec §21` (assertions,
beliefs, gossip, relationships) and `engine.spec §24` (RAG and memory); this
doc explains the current behavior in plain terms and cites the spec rather
than restating it.

## How it works

### Assertions: claims, not truth

An assertion is an append-only record of a claimed proposition: a
`propositionKey`, the subject(s) it's about, a claimed value, who (or what
event) asserted it, when, an optional validity window, and a lifecycle status
— active, contradicted, superseded, or retracted. An assertion can be false.
The engine does not collapse assertions into one canonical truth for the
world; a false claim is still a real assertion, tracked like any other
(engine.spec §21.1).

### Beliefs: what a character actually holds

A belief binds one holder actor to one assertion. It carries its own
confidence (fixed-point), the observations it rests on, the chain of actors it
was learned from, its own believed-from/until window, and its own lifecycle —
active, doubted, rejected, superseded — independent of the assertion's
lifecycle. That independence matters: an assertion can be superseded while a
belief traced to it stays active until something explicitly updates it, so a
character can keep believing something the world has already moved past
(engine.spec §21.2).

Gossip is not a separate mechanism. It's a `DisclosureMade` event plus the
listener's own observation and belief update. Each hop preserves provenance
(the belief's `learnedFromActorIds` chain) and can only shift confidence or
content through an explicit event — a rumor's drift is part of the auditable
record, not something applied silently between hops.

### Relationship ledger

Trust, attraction, and resentment are never stored as a running number.
Every read is a projection computed at read time over a persisted,
branch-scoped, append-only ledger of directional entries — the same
recompute-don't-persist pattern the meter system uses for reads (engine.spec
§21.3). Each ledger entry is directional (`fromActorId` toward `toActorId`,
always two distinct actors) and carries its own causal provenance.

The entry-kind vocabulary is closed and versioned:

- promises: `promise_made`, `promise_accepted`, `promise_kept`,
  `promise_missed`, `promise_repaired`
- boundaries and permission: `boundary_stated`, `boundary_respected`,
  `boundary_violated`, `permission_granted`, `permission_withdrawn`,
  `consent_declined`
- disclosure and conduct: `warning_given`, `invitation_extended`,
  `apology_offered`, `confidence_shared`, `help_given`, `neglect_shown`,
  `betrayal`, `affection_shown`, `conflict`
- structural: `shared_scene`, `authored_prior`, `relationship_change_recorded`

Most entries are `derived` — folded automatically from an event already in the
branch's causal history: a delivered speech act, a resolved commitment, an
ended engagement, a gated action that started. The rest are `authored`: an
explicit privileged command for facts the live mechanics don't yet organically
produce. An entry's `sourceEventId`, `sequence`, and `storySecond` always come
from the causing event, with one deliberate exception — `authored_prior`
exists to backfill history that predates the branch itself, so its recorded
`storySecond` is free to predate the authoring command that actually caused
it.

A dyad's read is directional, not symmetric: "how much X trusts Y" sums only
entries where `fromActorId = Y, toActorId = X` — evidence of Y's conduct
toward X, not X's conduct toward Y — under a per-axis decay that is versioned,
fixed-point, and keyed to story time rather than wall-clock time, so a replay
reproduces the same reading bit for bit.

A qualitative shift in a relationship — becoming partners, breaking up — is
itself a ledger entry (`relationship_change_recorded`), carrying a free-text,
world-type-authored `changeKey`. It is always an explicit act: never inferred
from narrator prose, and never fired automatically just because a numeric
trust/attraction/resentment read crosses some threshold.

### Consent

Interpersonal consent for touch, closeness, or intimacy is gated through the
same ledger, never implied by spatial state or narrative framing — a
deliberately separate concern from spatial or property transgression
(engine.spec §21.4). A closed, versioned, world-type `ConsentScopeKey`
(`closeness`, `kiss`, `touch_intimate`, `undress`, `sex`, and other authored
scopes) names the class of action a boundary or permission covers.

Coverage for actor A attempting a scope-S action toward actor B reads the most
recent entry, by sequence, among the three entry kinds that can name that
scope from B toward A:

| Most recent matching entry  | Coverage |
| --------------------------- | -------- |
| `permission_granted`        | covered  |
| `boundary_stated`           | none     |
| `permission_withdrawn`      | none     |
| no entry, or unparseable    | none     |

The check is fail-closed by construction: absence of evidence is absence of
permission. A later entry always supersedes an earlier one, so a withdrawal
takes effect for every matching attempt from its own sequence forward.

An attempt with no coverage rejects synchronously — the gated action itself
never blocks waiting on a decision. A separate, explicit escalation command
can follow up, and only then does the attempt route through the deliberator
seam ([mind.md](mind.md)): exactly two legal candidates, grant or decline,
admitted under the same criteria as any other deliberator call, with decline
as the unconditional fallback for a refusal, a timeout, an unparseable
response, or an inadmissible inference tier. Escalating toward a
player-controlled target is illegal outright — a player's own consent is
never modeled or decided by policy, only ever given through the player's own
explicit speech act. Either escalation outcome lands back in the ledger as its
own causal entry (`permission_granted` or `consent_declined`), so the next
attempt of the same action re-reads a ledger that has actually changed.

No spatial outcome, no narrator prose, and no world-type configuration can
grant coverage outside this mechanism (see [narration.md](narration.md) for
the forbidden-claims list that backs this at the prose layer).
`boundary_violated` — the ledger's only vocabulary for a consent breach — can
never be produced by a live command path; the fail-closed gate makes a live
violation structurally unreachable, so the entry kind exists solely for
authored backfill of pre-branch history or storyteller retcon.

### Recall: eligibility before relevance

Retrieval runs as a fixed pipeline, and eligibility is decided before
anything is ranked by similarity (engine.spec §24.1):

1. authenticate the world, branch, principal, and viewpoint;
2. filter by source kind, branch, sequence, validity interval, supersedence,
   and privacy;
3. require viewpoint knowledge, an observation, authorized lore, or an
   explicit public scope;
4. apply structured relevance filters;
5. rank the now-eligible set by vector or lexical similarity;
6. diversify the ranked set and fit it to the context budget;
7. return every result with its provenance and epistemic label.

Vector similarity never determines witness, truth, current validity, or
access — those are settled upstream, in steps 1–3, before a single embedding
comparison runs. A fact nobody in the scene witnessed cannot surface just
because it reads as semantically close to the query.

Eligible source classes include authored lore explicitly available to the
viewpoint, observed events, active assertions and beliefs, dialogue episodes
the actor participated in or learned about, relationship evidence, public
world records, and bounded soft canon (engine.spec §24.2). Projection rows
like a character's current location normally enter the compiled scene
directly ([narration.md](narration.md)) rather than being embedded as a
competing memory candidate — recall is for what a character knows or
remembers, not a substitute for state the scene compiler already carries.

### Indexing

Indexing runs from the outbox after the authoritative commit — asynchronous
and event-sourced, never inline with the write that produced the source data.
Each indexed document carries the source id and kind, its branch and sequence
interval, the viewpoint or visibility eligibility it was indexed under, its
valid and superseded intervals, the embedding model and document schema
versions it was built with, and redacted text produced only from data the
source was authorized to expose (engine.spec §24.3).

## Invariants

- A relationship read is always a projection recomputed at read time; nothing
  persists a running trust/attraction/resentment number.
- Consent coverage is fail-closed: absence of a covering ledger entry is
  absence of permission, never an implicit yes.
- `boundary_violated` is unreachable through any live command path — it
  exists only for authored backfill.
- Escalation toward a player-controlled target is illegal; player consent is
  only ever given through the player's own act.
- A relationship's qualitative state (a breakup, becoming partners) is always
  an explicit ledger entry, never inferred from prose or a threshold crossing.
- An assertion and the beliefs built on it carry independent lifecycles — a
  belief can outlive the assertion it traces to.
- Vector similarity ranks inside an already-eligible set; it never decides
  witness, truth, validity, or access.
- A model call never sees a less-restricted document because a more specific
  index wasn't ready — degraded recall narrows what's visible, never widens
  it.

## Extending it

The relationship ledger's entry-kind vocabulary and the `ConsentScopeKey`
vocabulary are both closed, versioned, and registry-as-data: adding one is a
data edit to the vocabulary list, not a schema migration (engine.spec §21.3,
§21.4). The RAG source classes work the same way (engine.spec §24.2) —
widening what a character can recall means declaring a new source class and
its eligibility rule, not changing the ranking pipeline.

## Degradation

If indexing falls behind or fails outright, world simulation keeps running —
recall quality degrades rather than blocking play, and the lag surfaces as a
diagnostic instead of going silently stale (engine.spec §24.3). The failure
direction is deliberately asymmetric: a model call must never see a
less-restricted document just because a more specific index wasn't ready, so
degraded recall only ever narrows what's visible. This follows the same
degrade-over-fail discipline as the rest of the engine — see
[resilience.md](../resilience.md).

## Related

- [mind.md](mind.md) — the deliberation loop, perception and observation, and
  NPC policy that beliefs and the relationship ledger feed into.
- [narration.md](narration.md) — NarrativeCut compilation, forbidden claims,
  and the narrator that beliefs, relationship reads, and recalled memory are
  compiled into.
- [resilience.md](../resilience.md) — the degraded-default discipline this
  doc's indexing failure mode follows.
