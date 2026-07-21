# Engine spec — mind: policy, perception, knowledge, cut, narrator, RAG (§19–§24)

Part of the [engine.spec.md](engine.spec.md) contract set (split 2026-07-21).
Section numbering is GLOBAL across the engine.spec.* files — cite sections as
"engine.spec §N" exactly as before; the hub's index maps every § to its file. The
normative-keyword rules (MUST/SHOULD/MAY) are defined in the hub.

## 19. NPC policy and deliberation

### 19.1 Legal candidate generation

The kernel or policy layer generates candidate actions after checking:

- controller authority;
- physical locus and route;
- active claims and activity compatibility;
- access, privacy, and consent;
- resources and body capability;
- actor knowledge and perceived cues;
- commitments and deadlines;
- world-type safety and content rules.

### 19.2 Deterministic utility

Routine policy SHOULD score legal candidates from versioned factors such as:

- goal progress;
- commitment priority and lateness risk;
- physiological need;
- relationship and promise evidence;
- habit and role;
- safety and legal risk;
- effort, time, and resource cost;
- interruption cost;
- bounded seeded variation.

The score breakdown MAY be retained as an audit explanation. It MUST NOT contain or claim
to expose a model's private chain of thought.

Deterministic utility's "relationship and promise evidence" factor (§19.2's existing
list) is concretized for the consent-escalation candidate scores (E5.5 §19.3 call
site, §4.7) as a versioned, fixed-point function of the target's directional
trust/attraction/resentment read (§21.3) toward the escalating actor, plus a fixed base
reluctance constant — net-neutral relationship evidence still defaults toward decline.
This is the first live consumer of ledger-derived terms in §19.2; widening the general
NPC routine-policy scorer to consume the same terms is a later slice (§9's open
decision 6).

### 19.2.1 The v1 routine controller (E6.2)

The background-life controller concretizes §19.1–19.2 for actors at `event`
simulation LOD (§27.4). A `routine_policy_due` alarm arms when an actor with a
tracked body enters `event` LOD (and re-arms on every resolution — sequence-
versioned uniqueness keys, unconditional retirement on any LOD assignment), due
at the actor's next routine boundary: the sleep window's start or any authored
`meal` rhythm window's start, whichever comes first (one boundary law shared by
the arm and every re-arm). It dispatches `run_routine_policy` (system principal
only), which re-validates fail-closed at fire time (LOD still `event`, body
tracked, not asleep — else the structured `routine_stale`) and resolves
deterministically: the §19.3 deliberator is never consulted; routine choices are
the §28 no-model tier by definition.

The candidate set is closed — `begin_sleep`, `eat_meal` (slice 2), and the
ever-legal fallback `hold`; the vocabulary order is the tie order (a later
candidate must strictly outscore the running winner, so every tie falls back
toward `hold`). A candidate is DUE only inside its own rhythm window
(half-open, wrapping midnight) and scores 0 outside it — a midday boundary can
never turn a hold into a nap off the daytime circadian floor; forced daytime
sleep belongs to the §25.4 collapse law alone. Legality gates (§19.1):
claim-holding activities and live engagements make both non-hold candidates
illegal, and `eat_meal` additionally requires an eligible item — §26.5
selection adapted to meals: extant, carrying at least one authored
`meal`-source consumption effect, unowned or the actor's own (routine never
eats against ownership), unreserved, outside inaccessible containers
(fail-closed §26.2), rooted at the actor or the actor's zone; actor-rooted
before zone-rooted, lexicographic item-id tie-break — else illegal
`no_eligible_item`. Every gate name is captured on the decision event.

Scoring (§19.2, versioned fixed-point weights, `routine-policy-v2`): sleep
scores the actor's own circadian pressure minus a 10 000 obligation penalty
when an unresolved pressure's actBy falls inside the would-be sleep — the
penalty sits above the entire periodic circadian range, so a live obligation
outranks routine bedtime while escalation past ~21h of sleep debt eventually
outranks it, emergently. (v1 scored the same weight on `hold`; v2 moved it
onto sleep so an evening obligation cannot starve an instant midday meal — the
sleep-vs-hold boundary is unchanged, and persisted v1 decisions remain
parseable via the versioned weights list.) `eat_meal` scores 6 000 inside a
meal window — above the 3 500 bedtime anchor where authored windows overlap,
below ~8h-overdue escalated sleep — and eating is instantaneous (§26.6), so no
obligation penalty applies to it.

The decision persists as `routine_policy_resolved` (every scored candidate, the
chosen id, the admitting LOD, and the chosen sleep's condition or the chosen
meal's item — a §6.4 capture; not perceptible, not a beat, not
memory-eligible). A chosen sleep commits atomically through the identical
asleep train collapse uses (§25.4 — condition, energy suspend, self-expiry at
the scheduled wake), so waking, the sleep credit, and every downstream re-arm
follow from existing law. A chosen meal commits atomically through the
identical §26.6 consumption train `consume_item` records — `item_consumed`
causation-chained to the decision, the item's authored body effects through
the shared builders, the material feed obligation, per-meter threshold
retire-and-re-arm — so a routine meal and a commanded meal are
indistinguishable in the record. A hold (or an eat) re-arms the next boundary
and a skipped window self-heals at the following one. Wash stays §25.5
window-crossing law — meal rhythm windows deliberately have NO crossing
credit; background eating is always real consumption of a real item. Feeding
from aggregate household stock (no concrete item) is the §27 aggregate lane's
concern (E6.3); the §21.3 ledger terms in the general scorer remain §9's open
decision 6.

### 19.3 Deliberator admission

An LLM deliberator MAY run only if:

- the actor is high inference LOD;
- at least two legal candidates remain;
- their deterministic score gap is below a configured threshold;
- the outcome is narratively or materially consequential;
- the branch has model budget;
- a deterministic fallback exists.

The prompt contains opaque candidate IDs and bounded evidence. The response may select
one ID and provide a short user-invisible rationale summary. Any new action text is
ignored.

## 20. Perception and observation

Perception computes whether an event produces evidence for a viewpoint. It considers:

- physical locus and topology;
- sight, sound, touch, smell, device, and social channels;
- lighting, cover, distance, barriers, and attention;
- activity and impairment;
- concealment and privacy;
- event salience;
- communication delivery and authentication.

    type Observation = {
      id: string;
      branchId: string;
      sourceEventId: string;
      witnessActorId: string;
      storySecond: number;
      channel: string;
      evidenceClass: string;
      confidenceFixedPoint: number;
      detailTier: number;
      derivationVersion: string;
    };

An event may have zero, one, or many observations. witnessedBy or equivalent eligibility
must be consumed by queries, not merely written.

Not every transient sensory pixel needs a durable row. The engine SHOULD persist
observations that affect belief, memory, action choice, relationships, evidence, or
narration continuity.

## 21. Assertions, beliefs, gossip, and relationships

### 21.1 Assertion

    type Assertion = {
      id: string;
      branchId: string;
      propositionKey: string;
      subjectIds: string[];
      claimedValue: unknown;
      sourceActorId?: string;
      sourceEventId?: string;
      assertedAt: number;
      validFrom?: number;
      validUntil?: number;
      status: "active" | "contradicted" | "superseded" | "retracted";
    };

An assertion may be false. canon false is not a belief model.

### 21.2 Belief

    type Belief = {
      id: string;
      branchId: string;
      holderActorId: string;
      assertionId: string;
      confidenceFixedPoint: number;
      basisObservationIds: string[];
      learnedFromActorIds: string[];
      believedFrom: number;
      believedUntil?: number;
      status: "active" | "doubted" | "rejected" | "superseded";
    };

Gossip is DisclosureMade plus the listener's observation and belief update. Each hop
preserves provenance and may alter confidence or content through an explicit event.

### 21.3 Relationship ledger (E5.5)

Relationship state MUST be derived from a persisted, typed evidence ledger — a
branch-scoped, append-only sequence of `RelationshipLedgerEntry` rows, each directional
(`fromActorId` toward `toActorId`, always two distinct actors), each carrying its own
causal provenance. The closed entry-kind vocabulary (versioned, registry-as-data —
extending it is a data edit, per the project's registry convention):

- `promise_made`, `promise_accepted`, `promise_kept`, `promise_missed`,
  `promise_repaired`;
- `boundary_stated`, `boundary_respected`, `boundary_violated`;
- `permission_granted`, `permission_withdrawn`, `consent_declined`;
- `warning_given`, `invitation_extended`, `apology_offered`, `confidence_shared`;
- `help_given`, `neglect_shown`, `betrayal`, `affection_shown`, `conflict`;
- `shared_scene`;
- `authored_prior`;
- `relationship_change_recorded`.

Every entry carries a `provenance`: `derived` (folded automatically from an event
already in the branch's causal history — a speech act delivered, a commitment resolved,
an engagement ended, a gated action started) or `authored` (an explicit privileged
command, §7, for facts the live mechanics do not yet organically produce). An entry's
`sourceEventId`, `sequence`, and `storySecond` are always the causing event's — an
entry is never backdated or forward-dated independent of its cause, EXCEPT
`authored_prior`, whose whole purpose is backfilling a `storySecond` before the
branch's own history (§6.4: the authoring command still names a real causing event —
itself — the entry's `storySecond` is simply free to predate it).

Prose summaries MAY help narration but MUST NOT be the only source: any relationship
read the narrator, an NPC's utility function, or an audit surfaces MUST trace to ledger
entries. The current relationship read (trust, attraction, resentment) is a derived
PROJECTION over the ledger, computed at read time, never itself persisted (mirrors
§25's meter-read law: only material transitions write, reads recompute). A dyad's read
is directional: "how much X trusts Y" sums only entries where `fromActorId = Y,
toActorId = X` — evidence of Y's conduct toward X — under a per-axis analytic decay
(§6.4's derivation rule: the decay law and its constants are versioned, fixed-point,
and story-clock-keyed, never wall-clock or floating point).

Relationship state change (e.g. "became partners," "broke up") is ITSELF a ledger entry
(`relationship_change_recorded`) — never inferable solely from narrator prose, and
never solely a side effect of the numeric trust/attraction/resentment read crossing a
threshold. It carries a free-text `changeKey` (an authored, world-type-defined
vocabulary) and MUST be an explicit act.

### 21.4 Consent (E5.5, ruling 16)

Interpersonal consent for touch, closeness, or intimacy (§14's layer 5) is
ledger-gated, never spatially or narratively implied (ruling 3: "This ruling governs
spatial/property transgression only; interpersonal consent for touch or intimacy
remains an independent action precondition"). An authored `ConsentScopeKey` (a closed,
versioned, world-type vocabulary — e.g. `closeness`, `kiss`, `touch_intimate`,
`undress`, `sex`) names the class of action a boundary or permission covers.

**Coverage.** For an actor A attempting a `consent_covered`-gated action toward actor
B under scope S, the gate reads the ledger for the MOST RECENT entry (by sequence)
among `{boundary_stated, permission_granted, permission_withdrawn}` where
`fromActorId = B, toActorId = A, payload.scopeKey = S`. Coverage exists — the action is
permitted — if and only if that most-recent entry's kind is `permission_granted`. No
covering entry, a `boundary_stated` or `permission_withdrawn` as the most recent entry,
or a malformed/unparseable entry (which never enters the ledger in the first place —
defense in depth, not a live failure mode) all resolve to NO coverage. **This check is
fail-closed by construction: absence of evidence is absence of permission.** A later
entry always supersedes an earlier one — permission is revocable at any time by a
`permission_withdrawn` entry, and a withdrawal takes effect for every scope-matching
attempt from that entry's sequence forward.

**Escalation.** An attempt with no covering entry does NOT auto-fail silently when the
attempting actor explicitly escalates (a distinct command, §7.6, from the gated action
itself — the gated action always rejects synchronously and fail-closed; escalation is a
deliberate follow-up, never automatic). Escalation routes through the §19.3 deliberator
seam: exactly two legal candidates (`grant`, `decline`), admission gated on the SAME
five criteria as any other deliberator call (target's inference LOD, score-gap
threshold, consequential — always true here, model budget, deterministic fallback —
always available here). **The deterministic fallback is always `decline`** — refusal,
timeout, an unparseable response, or an inadmissible LOD all resolve to decline, never
to grant. Escalation toward a PLAYER-controlled target is illegal — a player's own
consent is never modeled or decided by policy; it can only be given through the
player's own explicit act (a spoken permission-granting speech act, §23.3). The
escalation's accept or decline outcome lands back in the ledger as a causal entry
(`permission_granted` or `consent_declined`) — so consent is always explainable and
auditable, and a subsequent attempt of the same gated action re-reads the (now
possibly covering) ledger fresh; escalation never itself performs the gated action.

**Never bypassable.** No spatial outcome (ruling 3), no narrator prose (§22.1's
perspective-safe-by-omission rule; §23.1's forbidden-claims list), and no world-type
configuration may grant coverage outside this mechanism. A `boundary_violated` entry —
the ledger's only vocabulary for a consent breach — MUST NOT be producible by any live
command path; it exists solely for `authored` backfill (pre-branch history, storyteller
retcon) per §7.5, because the fail-closed gate makes a live violation structurally
unreachable.

## 22. NarrativeCut

### 22.1 Contract

    type NarrativeCut = {
      id: string;
      worldId: string;
      branchId: string;
      branchVersion: number;
      fromSequence: number;
      throughSequence: number;
      fromStorySecond: number;
      throughStorySecond: number;
      viewpointActorId: string;
      engagementId: string;
      currentLoci: PerspectiveSafeLocus[];
      currentActivities: PerspectiveSafeActivity[];
      mustEnact: NarrativeBeat[];
      perceptibleNow: EvidenceView[];
      speakerBeliefs: BeliefView[];
      relevantPressures: PressureView[];
      allowedTransitions: NarrativeBeat[];
      forbiddenClaims: ForbiddenClaim[];
      failurePresentations: PublicFailurePresentation[];
      creativeLicenses: CreativeLicense[];
      armedEffects: ArmedEffect[];
      provenance: ProvenanceRef[];
    };

The compiler MUST omit private fields rather than asking the narrator not to mention
them. Prompt instructions are defense in depth, not the privacy boundary.

mustEnact contains only beats relevant to this response. It is not a dump of every due
event. allowedTransitions are already-resolved beats the narrator may portray, not
permission to choose new hard outcomes.

### 22.2 Forbidden claims

ForbiddenClaim SHOULD cover:

- actor at an impossible place;
- travel without a journey;
- possession or consumption without an event;
- knowledge without belief or evidence;
- access without a grant or successful explicit attempt;
- action incompatible with activity or body claims;
- speech or action attributed to the player's actor without player authorization;
- disclosure of a private denial cause;
- future event stated as already completed.

### 22.3 Stability

A NarrativeCut is immutable and addressable. Recompiling the same cut ID must either
produce the same canonical content hash or fail with a version diagnostic. Model prompt
formatting may evolve, but the semantic cut remains inspectable.

## 23. Narrator and effects

### 23.1 Narrator output

The narrator returns:

    type NarratorResult = {
      prose: string;
      enactedArmedEffectIds: string[];
      proposedSoftCanon: SoftCanonProposal[];
      diagnostics?: string[];
    };

All fields cross a trust boundary and use resilient parsing with safe defaults.

The narrator MAY choose phrasing, sensory focus, gesture, pacing, subtext, and bounded
licensed details. It MUST enact required beats and MUST NOT assert forbidden claims.

### 23.2 Hard effects

Movement, item transfer, body injury, resource consumption, access, and activity
completion are resolved before narration. They do not wait for prose confirmation.

If prose omits a required hard beat, the presentation auditor may request a rerender or
add a deterministic bridge. It cannot undo the event.

### 23.3 Armed effects

ArmedEffect is for a semantic outcome that only exists if expressed:

- promise offered or accepted;
- invitation spoken;
- disclosure made;
- warning communicated;
- boundary expressed;
- question asked;
- apology delivered.

    type ArmedEffect = {
      id: string;
      cutId: string;
      effectType: string;
      actorId: string;
      targetActorIds: string[];
      payload: unknown;
      expiresAfterCut: boolean;
      preconditionVersion: number;
    };

After narration, each enacted ID is revalidated against cut, actor, and branch version.
Unlisted IDs are ignored. Unenacted effects expire. ArmedEffect MUST NOT be used to
smuggle physical outcomes back into narrator authority.

### 23.4 Soft canon

    type SoftCanonProposal = {
      key: string;
      value: unknown;
      scope: "scene" | "relationship" | "character" | "location" | "world";
      confidenceFixedPoint: number;
      validUntil?: number;
      sourceCutId: string;
    };

Soft canon must pass conflict, privacy, scope, duplication, and world-type checks. It may
be rejected without regenerating prose. Repeatedly useful soft canon is promoted through
the ruled auto-promotion path (ruling 14, §39): reuse across the world-type's ruled
number of committed cuts triggers an audited promotion event with full provenance and a
demotion path; all thresholds are versioned world-type values documented for tuning, and
a world type MAY disable auto-promotion in favor of explicit storyteller promotion. Soft
canon never becomes accidental hard state — promotion is always an explicit, audited
event.

Post-turn extraction is limited to information deterministic code could not know before
the response: episode compression, semantic propositions actually spoken, and permitted
soft-canon proposals. An extractor MUST NOT decide completed movement, item transfer,
body effects, commitment outcomes, access, or witness eligibility.

## 24. RAG and memory

### 24.1 Eligibility before similarity

The retrieval pipeline:

1. authenticate world, branch, principal, and viewpoint;
2. filter by source kind, branch, sequence, validity interval, supersedence, and privacy;
3. require viewpoint knowledge, observation, authorized authored lore, or explicit
   public scope;
4. apply structured relevance filters;
5. run vector or lexical ranking inside the eligible set;
6. diversify and fit the context budget;
7. return provenance and epistemic label with every result.

Vector similarity MUST NOT determine witness, truth, current validity, or access.

### 24.2 Source classes

Eligible source classes include:

- authored lore explicitly available to the viewpoint;
- observed events;
- active assertions and beliefs;
- dialogue episodes the actor participated in or learned about;
- relationship evidence;
- public world records;
- bounded soft canon.

Projection rows such as “current location” should normally enter the cut directly, not be
embedded as a competing memory.

### 24.3 Indexing

Indexing runs from the outbox after authoritative commit. Each document includes:

- source ID and kind;
- branch and sequence interval;
- viewpoint or visibility eligibility;
- valid and superseded intervals;
- embedding model and document schema versions;
- redacted text produced from authorized source data.

If indexing fails, world simulation continues. Recall quality degrades, and diagnostics
must expose lag. A model call must never see a less-restricted document because a more
specific index was unavailable.

