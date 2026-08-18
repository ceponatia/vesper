# Romantic contact affordances — NPC actor control through the live lane

Status: **implementation complete, authority gated; reconciled 2026-08-18.**
The pure decision foundation, durable decision envelope, shadow leg, and all
three authority increments are built. The production shadow measurement window
was opened on 2026-08-10 on a build carrying the cost/latency instrument. The
repository does **not** contain a final reviewed corpus or owner acceptance
ruling as of this reconciliation, so authority remains a rollout decision rather
than a completed plan step.

This corrects the old header that said shadow had never been enabled; later
sections of the same document already recorded the 2026-08-10 window.

Plan: [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)

## Scope

This lane gives a character-chat NPC narrowly bounded authority over physical
acts already stated in the committed assistant reply.

Supported proposal kinds:

- approach/depart relative to one present counterpart;
- start one allow-listed **affectionate** hand contact;
- update the gesture of one unambiguously identified contact that NPC started.

Not supported here:

- romantic/intimate contact;
- player movement/reaction;
- restraint/pinning;
- posture/support changes;
- wardrobe changes;
- supporting-cast entries without stable participant identity;
- successor chat behavior.

The feature does not let a model invent scene actions. It lets a structured
classifier **propose** an action already present in the persisted reply; pure
validators and the scene/contact owners decide whether it commits.

## Two tiers, one authority floor

### Tier 1 — deterministic contact endings

`chat-contact-reply.ts` remains the frozen authoritative floor for clear NPC
withdrawal/departure endings. It does not depend on the new classifier's
authority flag.

### Tier 2 — one reply-scene classifier

At most one structured model call runs for one persisted assistant reply. It may
propose bounded movement and contact candidates for the whole roster.

The classifier cannot commit state. Every candidate must pass deterministic
admission, then the actor-generic scene/contact resolver.

There is never one classifier call per NPC.

## Decision schema

Conceptual V1:

```ts
interface NpcSceneDecisionOutputV1 {
  version: 1;
  movement: NpcMovementCandidate | null;
  contact: NpcContactCandidate | null;
}

type NpcMovementCandidate =
  | {
      kind: "approach";
      actorRef: NpcRef;
      counterpartRef: ParticipantRef;
      band: "touching" | "close";
      facing: "toward" | null;
      evidence: EvidenceQuote;
    }
  | {
      kind: "depart";
      actorRef: NpcRef;
      counterpartRef: ParticipantRef;
      band: "near" | "distant";
      evidence: EvidenceQuote;
    };

type NpcContactCandidate =
  | {
      kind: "start";
      actorRef: NpcRef;
      targetRef: ParticipantRef;
      gesture: ChatContactGesture;
      targetLocationId: ChatAffectionateTargetLocationId;
      evidence: EvidenceQuote;
    }
  | {
      kind: "update";
      actorRef: NpcRef;
      contactRef: ContactRef;
      gesture: ChatContactGesture;
      evidence: EvidenceQuote;
    };
```

Refs are digest-local closed enums, never model-authored database ids.

## Admission fence

A candidate passes all four gates or is dropped unchanged.

1. **Grounded** — evidence occurs uniquely in a narration span of the exact
   persisted reply.
2. **Asserted** — evidence states a completed action; negation, question,
   hypothetical/modal/future/intention/refusal language fails. Contact
   start/update also rejects romantic/intimate/restraint framing.
3. **Actor-attributed** — the proposed NPC is the grammatical actor; possessive
   mentions do not count as actor evidence. Ambiguous ensemble pronouns fail.
4. **Decision-congruent** — deterministic bounded vocabulary proves the exact
   kind, counterpart, band/facing, gesture, target location, or contact handle.

A verifier may accept/reject the model's field. It may never substitute a
different field or create a proposal the model omitted.

The broad trigger is only a **cost gate**. Trigger hits/misses are not authority.

## Stable digest and handles

The classifier digest contains:

- `player`;
- stable `npc_0 ...` refs for roster participants;
- stable local `contact_0 ...` refs for resolvable active contacts;
- pre-settle presence;
- current pair proximity needed for the bounded choices.

The durable envelope stores resolved subject/contact ids and hashes of the reply
and digest. Replay therefore does not depend on names or array position.

Supporting cast without stable `chat_participants` identity is excluded.

## Post-settle authority cut

Classification may overlap normal settlement, but resolution uses a fresh
post-settle cut:

- exact persisted assistant bytes;
- current scenario/scene;
- current story minute;
- current participant presence;
- current wardrobe/coverage;
- current active contacts.

Presence wins over classifier output.

- `away` cannot act or be targeted; affected contacts end and pair relations are
  cleared.
- `present` is seeded before resolution and may act if its reply evidence is
  otherwise valid.
- missing from the authoritative roster cannot be rescued by model output.

## Continuous co-presence law

Pair proximity/facing is valid only while the pair remains continuously present
in the same scene.

Clear affected pair relations when:

- a participant becomes away — their relations only;
- place changes — all pairs;
- explicit story-clock skip — all pairs.

Do not clear for an ordinary per-turn clock tick.

Returning does not restore the old distance; a later authoritative action must
place the pair again.

## Chronology

Admitted actions are ordered by grounded reply offsets, not classifier array
order.

Examples:

- “she steps closer, then rests her hand on your shoulder” -> movement resolves
  first, then contact against the new scene;
- “she lets go, then steps away” -> deterministic floor ending and movement are
  ordered once;
- ambiguous order -> tier-2 candidate fails closed rather than guessing.

The evolving scene is used as each admitted action resolves.

## Durable envelope

`chat_npc_scene_decisions` stores one row per assistant message with:

- reply/digest hashes;
- schema version, story minute, mode;
- trigger/degraded/evaluated status;
- pre/post scene fingerprints;
- parsed slots, admission/drop reasons, grounded evidence excerpt, ordered
  actions, resolver outcomes, and contact references;
- model/latency/timeout telemetry;
- input/output tokens, cost, and settle-wait telemetry when available.

Trigger miss, timeout, malformed output, all-rejected output, and no-op are all
durable outcomes. The same assistant reply is not reclassified into a different
answer on retry.

The envelope/contact rows/scene result commit through the guarded transaction;
stale assistant bytes, scene CAS failure, or row mismatch roll the whole write
back.

Retake unconditionally prunes the discarded assistant's envelope and reply-side
contact rows even if flags changed since the original reply.

## Flags

- `CHAT_NPC_SCENE_DECISION_SHADOW=on`
  - classifier + envelope;
  - tier-2 evaluated dry;
  - no new scene/contact authority.
- `CHAT_NPC_SCENE_DECISIONS=on`
  - authority mode;
  - effective only with `CHAT_CONTACT_ACTIONS=on`.
- `CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS`
  - subset of `movement,start,update`;
  - unset/blank -> `movement` only;
  - unknown tokens ignored;
  - nonblank value containing no known kind -> no tier-2 execution.

Authority wins over shadow when both are on. Admission/ordering/envelope behavior
is shared; only the final execution step differs.

## Measurement instrument — built 2026-08-10

`pnpm report:npc-scene-decisions` can report/export:

- trigger fire/miss rates;
- accepted/dropped candidates and reasons;
- resolution outcomes;
- p50/p95/p99 classifier latency;
- p50/p95/p99 **settle wait** (`settleWaitMs`), the actual added reply-path wait;
- timeout rate;
- input/output token coverage;
- spend and cost per 100 replies;
- JSONL review corpus containing exact reply text/hash plus candidates/actions/
  drops for human false-positive/negative labeling.

The production shadow window was explicitly documented as opened 2026-08-10
with this telemetry available.

### Remaining gate

Before movement authority is enabled, review must record:

1. trigger misses relevant to real actions;
2. false positives/negatives on the exported corpus;
3. dominant drop reasons and whether gates are too strict/loose;
4. p50/p95/p99 added settle wait;
5. timeout rate;
6. cost per 100 replies;
7. owner accept/reject ruling.

**The existence of telemetry is not the ruling.** No final review artifact is
committed in the repository as of 2026-08-18.

## Staged authority rollout

If the measurement gate is accepted:

1. `movement`
2. `movement,start`
3. `movement,start,update`

Each widening must pin:

- exact retry/idempotency;
- stale-scene rollback;
- retake across flag changes;
- shadow/flag-off scene identity;
- no player body authority;
- no romantic/intimate contact;
- no degraded candidate gaining authority;
- expected resolver outcomes for the newly admitted kind.

Do not skip directly to all three because all code is already merged.

## Relationship to the romantic permission track

General NPC scene authority is **not** a prerequisite for the first
player -> NPC romantic permission proof when the NPC need not reposition.

These are parallel tracks:

- this spec governs NPC-authored physical movement/contact;
- the permission spec governs whether a gated contact direction/scope is allowed;
- the new player romantic action producer supplies the actual player attempt.

NPC-initiated romantic contact remains future work and would require both an
NPC romantic action producer/authority decision and the applicable permission
rules. The current NPC `start` schema is affectionate-only by design.

## Required adversarial coverage

- actor/object possessive confusion;
- two NPCs acting in one reply;
- wrong kind/actor/target/band/facing/gesture/location;
- duplicate evidence quotes;
- dialogue/thought/OOC/styled spans not grounding authority;
- negation/question/conditional/future/modal/refusal;
- romantic/intimate/restraint framing on contact proposals;
- ensemble pronoun ambiguity;
- `beside` versus explicit touching adjacency;
- approach from an already-touching pair;
- departure from an unplaced pair;
- backing away does not invent facing;
- mixed action order both directions;
- deterministic floor + movement composition;
- multiple contacts with one counterpart;
- update wrong actor/source/action kind/contact handle;
- dressed-but-unmodellable wardrobe;
- same-reply wardrobe change;
- away/arrival transitions;
- supporting-cast rejection;
- trigger miss/timeout/malformed/all-rejected;
- stale assistant bytes and stale-scene CAS;
- retake with flags changed;
- shadow causes zero authoritative scene difference.

## Remaining product questions

- Does the measured shadow envelope meet the owner’s accuracy/cost/latency
  threshold for movement authority?
- Posture/support changes such as “she sits beside you” remain a separate scene
  modeling problem and must not be added as free-text escape hatches to this
  classifier.
