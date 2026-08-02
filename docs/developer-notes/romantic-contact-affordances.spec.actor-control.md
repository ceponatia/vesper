# Romantic contact affordances — NPC actor control through the live lane

Status: technical companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
(continuation item 3 — **revised 2026-08-02 after pre-implementation review;
not ready for authority until the foundation and shadow gates below pass**).
The deterministic NPC contact-ending producer shipped 2026-07-31 and remains
the frozen floor described here.
**Delivery steps 1–3 are built (2026-08-02):** the pure foundation with its
adversarial fixtures, the durable decision envelope with the guarded CAS
transaction (migration 0094), and the shadow leg behind
`CHAT_NPC_SCENE_DECISION_SHADOW` (default off; with both new flags off the
lane is byte-identical to before). The shadow flag has **not** been enabled —
the measurement window, its review, and the cost ruling remain, and the
authority increments (4–6) are unbuilt by design.

## Scope and boundary

The character-chat lane already commits the player's typed movement and
affectionate hand contact, and it can end contact when an NPC's narration
plainly withdraws or departs. The remaining item-3 surface is deliberately
small:

- an NPC may approach or depart relative to one present counterpart;
- an NPC may start one allow-listed affectionate hand contact;
- an NPC may change the gesture of one unambiguously identified contact they
  started with their own hand.

This work never moves the player's body, never creates romantic or intimate
contact, never restrains or pins, never changes posture/support or wardrobe,
and never treats narrator prose as state. Supporting-cast JSON entries are not
actors in this increment: only the player and stable `chat_participants` rows
have scene-subject identity. Successor chats remain out of scope.

## Authority model

There are two decision sources and only one model call:

1. **Frozen deterministic ending floor.** `chat-contact-reply.ts` keeps its
   current whole-sentence ending vocabulary and vetoes. It remains the only
   free-prose extractor and the only tier that produces contact endings. Its
   result gains source offsets for ordering, but its accepted language does not
   grow.
2. **One reply-scene classifier call.** At most once per persisted assistant
   message, one structured call reads the reply and a compact digest for the
   whole roster. It may propose at most one movement and one contact
   start/update. Each proposal names its NPC actor explicitly. The model cannot
   commit state; deterministic validation, resolution, and persistence decide
   whether anything lands.

There is never one call per NPC. An ensemble reply such as “Mara crosses the
room and Sabrina takes your hand” can return two proposals with different
`actorRef` values from the one call.

### The fence

No free-prose extractor may mint a movement, start, or update. Small, closed
positive lexicons may **verify** that a model-proposed field is entailed by a
grounded quote. A verifier receives the proposed actor, kind, counterpart,
band, gesture, target location, or contact handle and can answer only
supported/unsupported/ambiguous. It may not substitute a different field or
create a proposal the model omitted.

The trigger may use a broader verb-stem list because it controls cost, not
authority. Trigger misses are measured and produce a durable no-decision
outcome; they never cause fallback extraction.

## Compact digest and stable references

The digest is assembled before state fan-out so classification can run beside
settlement. It contains no database subject IDs. References are local to this
assistant message and assigned deterministically:

- `player` — the chat player;
- `npc_0` … `npc_3` — `chat_participants` in stable roster order, with display
  name, aliases, and pre-settle presence;
- `contact_0` … — active contacts sorted by stable contact ID, with their actor,
  action kind, source/target roster refs, and canonical surface IDs;
- current pair proximity facts needed to understand the bounded choices.

The contact list exposes only roster-resolvable contacts. The resolver still
re-checks the post-settle contact by durable `contactId`; a local handle is not
authority. The stored envelope carries the digest hash and the resolved subject
and contact IDs so a later replay never depends on names or array position.

Previously-away roster members remain in the digest so an arrival narrated in
this reply can be classified. Whether they may act is decided only from the
post-settle presence cut. Recurring supporting-cast names are omitted until
they gain stable participant and scene-body identity.

## Closed decision schema

`src/contracts/turns/npc-scene-decision.ts` owns strict, length-bounded schemas.
The outer result has two raw nullable slots so each slot can be parsed and
traced independently; one malformed slot must not erase a valid sibling. No
slot uses `.catch(null)`, because “absent” and “malformed” are different trace
outcomes.

```ts
interface NpcSceneDecisionOutputV1 {
  readonly version: 1;
  readonly movement: NpcMovementCandidate | null;
  readonly contact: NpcContactCandidate | null;
}

type NpcMovementCandidate =
  | {
      readonly kind: "approach";
      readonly actorRef: NpcRef;
      readonly counterpartRef: ParticipantRef;
      readonly band: "touching" | "close";
      readonly facing: "toward" | null;
      readonly evidence: EvidenceQuote;
    }
  | {
      readonly kind: "depart";
      readonly actorRef: NpcRef;
      readonly counterpartRef: ParticipantRef;
      readonly band: "near" | "distant";
      readonly evidence: EvidenceQuote;
    };

type NpcContactCandidate =
  | {
      readonly kind: "start";
      readonly actorRef: NpcRef;
      readonly targetRef: ParticipantRef;
      readonly gesture: ChatContactGesture;
      readonly targetLocationId: ChatAffectionateTargetLocationId;
      readonly evidence: EvidenceQuote;
    }
  | {
      readonly kind: "update";
      readonly actorRef: NpcRef;
      readonly contactRef: ContactRef;
      readonly gesture: ChatContactGesture;
      readonly evidence: EvidenceQuote;
    };
```

`NpcRef`, `ParticipantRef`, and `ContactRef` are dynamic enums built from the
digest, not arbitrary strings. `EvidenceQuote` is the only free text: nonblank,
maximum 480 characters. All objects are strict; unknown keys make that slot
malformed. Tier 2 has no `end` case—the deterministic floor already owns it.

Before this schema lands, extract the current private
`CONTACT_TARGET_LOCATION`, `chatContactGestures`, and `GESTURE_CONTACT` data
into one pure shared chat-contact vocabulary. The detector, classifier schema,
evidence verifier, and adapter must import that single vocabulary. The output
uses canonical location IDs, not model-authored body-part strings.

## Evidence admission

Every candidate passes four gates in order. A failure drops only that candidate
and records a bounded reason; no gate repairs it.

1. **Grounded.** After the same curly-quote normalization used by message-span
   parsing, the quote occurs exactly once in a narration span. Dialogue,
   thought, OOC, comms, and styled non-narration never ground authority. Zero or
   multiple occurrences fail closed. The gate returns absolute reply offsets.
2. **Asserted.** The supporting clause describes a completed action. Negation,
   hedges, modal/conditional/future/intent language, questions, commands,
   refusals, and incomplete clauses fail. Contact starts/updates additionally
   fail on romantic/intimate framing or restraint. The ending floor keeps its
   existing veto set unchanged.
3. **Actor-attributed.** The action verb's grammatical subject is the proposed
   NPC. A name or alias in a possessive object does not count. A bare third-
   person pronoun is accepted only when the post-settle scene has exactly one
   eligible NPC; ensembles require the actor's name/alias in the action clause.
4. **Decision-congruent.** A bounded verifier proves every proposed field, not
   merely that some action happened. It returns one unique action span.

| Candidate | Congruence that must be proven |
| --- | --- |
| approach | completed nearer movement by `actorRef`, relative to `counterpartRef`, supporting the exact `band`; `facing: toward` needs independent forward/toward evidence |
| depart | completed whole-body movement away by `actorRef`, relative to `counterpartRef`, supporting `near` versus `distant` |
| start | completed hand contact by `actorRef` on `targetRef`, exact gesture and canonical target location, with language that creates rather than merely considers contact |
| update | completed modulation by `actorRef` of the exact active contact behind `contactRef`, supporting the new gesture and that contact's counterpart/location |

Assistant-narration `you/your` resolves only to `player`. Other pronouns may
resolve only when the candidate plus the live contact/roster leaves exactly one
compatible referent. If a quote supports two contacts or two action clauses,
it is ambiguous. Ordinary `beside` supports `close`; only explicit physical
adjacency such as “right beside” supports `touching`. “Steps back” supports
`near`; crossing/walking across the room supports `distant`.

The verifier returns `{ start, end }` for the exact action phrase plus a
field-level verdict. These offsets order admitted actions and make evidence
congruence testable independently of the classifier.

## Authoritative post-settle cut

Classification may run concurrently, but resolution waits until all primary
and ensemble state settlement and the sequential garment reconcile finish.
The reply scene leg then reloads, rather than reusing the pipeline's stale
`scenario` variable:

- the persisted assistant row and exact reply bytes;
- the current scenario/scene and story minute;
- current `chat_participants` presence;
- current garment store and per-actor coverage;
- active contacts.

Presence has precedence over classifier output:

1. A participant confirmed `away` cannot act or be a target. Every active
   contact involving them ends deterministically as `separated` before tier-2
   proposals resolve.
2. A participant confirmed `present` is seeded into the scene before movement
   or contact resolution; a newly arrived roster member may then act.
3. A participant absent from the post-settle roster cannot be rescued by a
   name, pre-settle presence, or model output.

The common reply-scene leg runs for every persisted nonempty assistant reply:
initial openings, initiative reopeners, ordinary turns, continue beats, action
beats, and user-stopped or timed-out partial replies. Assertion validation
rejects any cut-off action. Empty replies have no assistant decision envelope.
The current opening branch must call the common leg before returning.

## Resolution laws

All accepted candidates remain attempts. Existing scene/contact resolvers still
enforce actor control, presence, geometry, reach, support, policy, eligibility,
capacity, ordering, and lifecycle laws.

### Movement

Both bodies must be post-settle present. The moved `subjectId` is always the
candidate's NPC actor, `origin` is `npc`, and every resulting intent still goes
through `commitSceneIntent`.

Add adapter helpers before constructing the intents:

- `approachedBand` may create a first proximity fact from explicit evidence or
  replace a standing fact only with a strictly nearer band. An active contact
  counts as effective `touching`, so an approach can never overwrite it with
  `close`. Equal/closer standing distance is a no-op.
- `departedBand` mirrors the player helper: it may widen an existing proximity
  fact, or use an active contact as proof that an otherwise unplaced pair was
  touching. It never creates a band for a pair with neither fact nor contact,
  and never makes a pair nearer.
- approach writes `facing: toward` only when the candidate proposed it and the
  congruence gate proved it. Backing into place may change proximity without
  changing facing.

`commitSceneIntent` alone does not enforce these direction/placement laws; the
NPC adapter must not claim that it does.

### Contact start

The source is the NPC's `hands`; actor control is read from the scene and is
allowed only for `npc_controlled`. The target must differ from the actor and be
post-settle present. The action kind is always `affectionate`, with eligibility
and permission `not_required`; romantic/intimate/restraint language was already
vetoed. Target agencies stay empty because only the NPC's own hand moves.

Material is resolved from **both sides**. Generalize the chat adapter to compose
the NPC-hand coverage (gloves, source first) with target-surface coverage
(target garments after it). If either involved wardrobe is dressed but cannot
be modeled, material is unavailable and the start is unresolved. The read uses
the reloaded post-settle garment cut, never the pre-settle scenario.

If either the source or target participant's wardrobe authoritatively changed
during this same reply, the start is dropped as
`wardrobe_chronology_ambiguous`. The final wardrobe does not prove which layers
existed at the contact's action offset. A later chronology design may lift this
conservative rule; increment 2 does not guess.

### Contact update

`contactRef` must still resolve to exactly one active contact whose immutable
identity says:

- `actorId` is the candidate NPC;
- source is that NPC's `hands`;
- `actionKind` is `affectionate`;
- the evidence supports that contact's counterpart and target location.

Zero or more than one compatible result is silence. An update is never promoted
to a start and never modulates another actor's contact.

Before increment 3, add a gesture-only lifecycle operation. It may change
pressure/motion and the update stamp; it must preserve contact ID, actor,
action kind, source, target, area, material-between, transmission, implicit
adjustments, and start authorization byte-for-byte. Re-resolving a full contact
attempt is forbidden for updates. An unchanged gesture produces the existing
`contact_continued` no-row result.

## Chronology and folding

The fixed floor→movement→contact order is removed. Every admitted floor result
and tier-2 candidate carries one action span and is sorted by absolute start
offset. If two state-changing actions cannot be totally ordered, the ambiguous
tier-2 candidates are dropped; the independently valid frozen floor remains.

Examples that must work:

- “She squeezes your hand, then steps away.” updates first, then separates.
- “She steps closer, then takes your hand.” approaches first, then resolves the
  start against the nearer scene.

When the floor and a `depart` proposal describe the same action span, they form
one composite departure: compute the allowable wider proximity from the scene
**before that action's contact ends**, fold `separated` endings, then apply the
prevalidated proximity intent. This preserves an active contact as closeness
evidence without running the ending twice.

The normalized ordered actions—not schema slot order—are what the durable
envelope records.

## Durable decision envelope and transaction

Movement and empty outcomes need durable identity. Add
`chat_npc_scene_decisions`, one row per assistant message:

| Column | Contract |
| --- | --- |
| `chat_id`, `assistant_message_id` | FKs with cascade; unique together; assistant message is the retake guard |
| `reply_hash`, `digest_hash` | hashes of exact persisted reply bytes and the classifier digest |
| `schema_version`, `mode`, `story_minute` | replay/version boundary and `shadow` versus `authority` |
| `status` | `trigger_miss`, `degraded`, or `evaluated`—all are durable tombstones |
| `base_scene_hash`, `result_scene_hash` | exact pre/post projection fingerprints |
| `payload` | bounded parsed-slot outcomes, grounded spans/hashes, gate reasons, normalized ordered actions, resolver outcomes, contact-row references, model/latency telemetry |

Do not add a best-effort `lastSceneDecisionTrace` field to the chat. The
envelope is the trace; the dev inspector reads the newest non-pruned envelope.
The existing `contact-reply:<assistantMessageId>` event ref remains the contact
event identity. Its row sequence follows chronological **contact-commit** order;
movement positions and no-row continuations live in the envelope's full ordered
action list. The envelope stores the actual committed scene intents, not only
the model candidates, so movement provenance can be replayed. Story minute is
read from the post-settle scenario and truncated once for the whole envelope.

One new transaction owns the envelope, contact rows, and scene projection. Its
required predicate is explicit:

1. the assistant row still exists in this chat and its stored content hashes to
   `reply_hash`;
2. `character_chats.scene` is JSONB-equal to the expected post-settle base
   scene (or an equivalent exact revision predicate);
3. no envelope exists for this assistant message, or the existing envelope is
   canonical-byte-equivalent to the attempted one;
4. every conflicting contact row under the reply event ref matches exactly.

For a new envelope, the transaction inserts/validates contact rows, performs a
compare-and-swap scene update (including movement-only and no-row updates), and
commits the envelope atomically. Zero matched scene rows, a missing/changed
assistant row, or any envelope/ledger mismatch returns a typed stale/conflict
result and rolls everything back. `appendChatContactEventsWithScene` does not
currently provide this guard or CAS; factor its row-verification logic into the
new transaction instead of calling it separately.

Before classification, an existing envelope with the same reply hash is reused
regardless of current flags; the same assistant reply is never reclassified
into different authority. Concurrent first writers race on the unique key: one
wins, and a different loser fails closed. A trigger miss, timeout, malformed
output, all-rejected proposal set, or `contact_continued` result is just as
idempotent as a movement/contact commit.

Retake rollback unconditionally deletes this assistant's decision envelope and
reply-side contact rows beside restoration of `pre_exchange_scenario`, even if
either feature flag is now off. The regenerated take then gets a new envelope.
Cascade deletion remains the hard-delete backstop.

## Execution, flags, and cost gate

The pure trigger runs after nonempty reply persistence. If no reusable envelope
exists and it fires, launch the single classifier call concurrently with normal
post-reply settlement. Resolution waits for the post-settle cut. The call has a
dedicated `CHAT_NPC_SCENE_DECISION_TIMEOUT_MS`, initially capped at 8 seconds
from launch; it must not inherit the pulse's temporary 60-second diagnostic
timeout. The call remains inside settlement and the exchange lock, so latency is
part of the rollout evidence—not “off the reply path.”

Flags use the repository's literal `on` convention:

- `CHAT_NPC_SCENE_DECISION_SHADOW=on` runs the classifier and persists a shadow
  envelope but grants no new scene/contact authority; the frozen floor still
  behaves normally.
- `CHAT_NPC_SCENE_DECISIONS=on` enables authority after the shadow gate and is
  effective only with `CHAT_CONTACT_ACTIONS=on`. Authority wins if both are on.

Before movement authority is enabled, shadow results must report trigger fire
rate/misses, candidate acceptance and drop reasons, false positives/negatives on
the review corpus, p50/p95/p99 added settle latency, timeout rate, and cost per
100 replies. The owner cost ruling is made from those measurements, not from the
incorrect claim that pulse already runs once per roster member.

## Diagnostics

Use one namespace with bounded reason fields rather than a code per sentence:

- `npc_scene_decision.degraded`;
- `npc_scene_decision.slot_malformed`;
- `npc_scene_decision.ref_invalid`;
- `npc_scene_decision.evidence_ungrounded`;
- `npc_scene_decision.evidence_ambiguous`;
- `npc_scene_decision.evidence_unasserted`;
- `npc_scene_decision.evidence_misattributed`;
- `npc_scene_decision.evidence_incongruent` (`field` names the mismatch);
- `npc_scene_decision.chronology_ambiguous`;
- `npc_scene_decision.presence_conflict`;
- `npc_scene_decision.contact_conflict`;
- `npc_scene_decision.wardrobe_chronology_ambiguous`;
- `npc_scene_decision.persistence_conflict`.

Agent failure/latency telemetry follows the other structured legs. Resolver,
scene, contact, material, and ledger diagnostics retain their existing codes.

## Delivery order and gates

No pipeline authority work starts with the old “increment 1.” The order is:

1. **Pure foundation and adversarial fixtures:** shared vocabularies; strict
   dynamic-ref schema; digest/contact handles; unique grounding and full
   congruence verifiers; action offsets and chronological planner.
2. **Durability foundation:** decision-envelope migration and parser; guarded
   CAS transaction; exact conflict/idempotency behavior; unconditional retake
   prune; dev trace reader.
3. **Shadow:** one call per reply across every included reply kind, post-settle
   presence/wardrobe cut, no authority. Review measured quality, latency, and
   cost before proceeding.
4. **Increment 1—movement:** monotonic approach/depart helpers, composite
   departure ordering, opening/presence integration.
5. **Increment 2—starts:** arbitrary actor adapter, two-sided material, and
   same-reply wardrobe-change veto.
6. **Increment 3—updates:** stable contact handles and gesture-only lifecycle
   operation.

Each authority increment must pin durable envelope/rows, exact retry, degraded
tombstone, stale CAS rollback, retake prune across flag changes, shadow/flag-off
scene identity, and the new behavior's resolver outcomes before the next starts.

Minimum adversarial fixtures include: actor/object possessive confusion; two
NPCs acting in one reply; evidence supporting the wrong kind/actor/target/band/
gesture/location; duplicate quotes; dialogue and styled spans; every assertion
veto; ensemble pronouns; ordinary versus “right” beside; approach from
`touching`; departure from an unplaced pair; facing while backing up; both mixed
action orders; floor/depart composition; multiple contacts with one
counterpart; wrong actor/source/action kind on update; gesture-only material
preservation; NPC gloves; dressed-but-unmodellable wardrobes; same-reply outfit
change; departure/arrival presence transitions; supporting-cast rejection;
opening/initiative/continue/action/partial/empty replies; trigger miss, timeout,
and all-rejected retries; assistant deletion and stale-scene CAS; retake with
flags changed; and shadow producing zero authoritative scene difference.

## Remaining product questions

- **Standing cost:** implementation may proceed through shadow; enabling
  movement authority requires the owner to accept the measured cost/latency
  envelope.
- **Posture/support:** “she sits beside you” remains outside increments 1–3.
  Pulling it forward requires a separate surface/support design with at least a
  seat vocabulary; this classifier schema must not grow a free-text posture
  escape hatch.
