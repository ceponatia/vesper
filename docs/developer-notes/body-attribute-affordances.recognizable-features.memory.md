# Recognizable features — salience and visual memory

Status: detail for
[body-attribute-affordances.spec.recognizable-features.md](body-attribute-affordances.spec.recognizable-features.md)
(promoted with the plan 2026-07-28)

## Purpose

Rank currently perceptible identity details and remember what a specific
observer has noticed, so the narrator can establish recognizable features
without re-describing them every turn.

The source feature remains canonical body truth. This layer owns only
observer-specific salience, notice history, recognition strength, and narrator
mention cooldown.

## Salience dimensions

All values are deterministic fixed-point scores (`0..10_000`).

### Visibility

Visibility is recomputed per observer and cut from:

- exposure and effective coverage;
- feature size and contrast;
- light, distance, angle, motion, and occlusion;
- perception channel and detail tier;
- deliberate inspection or current action focus.

Visibility is never a permanent character property. Shoulder freckles may be
highly visible in a sleeveless top and zero beneath a coat.

### Uniqueness

Uniqueness estimates how strongly a feature distinguishes this subject:

- feature-kind rarity prior;
- instance placement, pattern, scale, or asymmetry;
- rarity within the species/body plan;
- contrast within the current cast;
- a distinctive constellation of otherwise common details.

V1 uses authored priors plus instance modifiers. Live population statistics
and cast-relative calibration are optional later refinements.

### Importance

Importance captures narrative and observer-relative significance:

- authored identity anchor;
- source-event consequence or emotional weight;
- relationship relevance;
- deliberate player attention;
- the character's self-concept;
- connection to a promise, mystery, trauma, or goal.

A common feature can be important. A plain scar from a pivotal shared event may
matter more than a rare but irrelevant eye color.

## Scores

Physical/identity salience:

```text
featureSalience =
  visibility × (0.55 × uniqueness + 0.45 × importance)
```

Narrator mention priority:

```text
mentionPriority =
  featureSalience
  × max(novelty, changeSignificance, actionRelevance)
  × repetitionCooldown
```

The weights are calibration defaults, not schema law. Invariants:

- zero visibility means no current visual cue;
- uniqueness and importance remain separate diagnostics;
- novelty/relevance affects mention priority, not canonical recognizability;
- low mention priority never deletes visual memory or body truth;
- intimate-region exposure and consent gates remain hard constraints.

## Structured visual memory

General semantic RAG is useful for callbacks but not precise enough for
deterministic recognition and repetition control. Add a compact,
observer-specific read model:

```ts
type VisualObserverRef =
  | { kind: "actor"; actorId: CharacterId }
  | { kind: "player_viewpoint"; viewpointId: PlayerViewpointId };

type VisualMemoryScopeRef =
  | { kind: "chat"; memoryGroupId: ChatMemoryGroupId }
  | { kind: "world_branch"; branchId: WorldBranchId };

interface VisualFeatureMemory {
  scope: VisualMemoryScopeRef;
  observer: VisualObserverRef;
  subjectId: CharacterId;
  featureKey: RecognizableFeatureKey;
  truthFingerprint: string;
  firstNoticedAt: StoryTimestamp;
  lastNoticedAt: StoryTimestamp;
  noticeCount: number;
  strongestDetailTier: 1 | 2 | 3;
  confidence: UnitInterval;
  recognitionStrength: UnitInterval;
  lastMentionedAt?: StoryTimestamp;
  mentionCount: number;
  firstObservationId: ObservationId;
  lastObservationId: ObservationId;
}
```

The record is:

- a projection of perception-safe observations, never body truth;
- scoped to one actor or player viewpoint;
- rebuildable from observations/cuts where an event ledger exists;
- structured rather than embedding-dependent;
- eligible to produce a redacted semantic-memory document downstream.

`lastNoticedAt` and `lastMentionedAt` are deliberately separate. An observer
can refresh recognition without the narrator restating the feature.

Legacy-chat player memory follows the chat memory group so “continue our
history” can retain recognition while a fresh/AU conversation remains
isolated. Successor memory is branch-scoped so forks and retakes cannot leak
later visual knowledge backward.

## Update rules

- Create/update memory only after perception crosses a notice threshold;
  theoretical visibility is insufficient.
- Repeated clear observations and important shared events raise recognition
  strength.
- Freshness decays with story time; stable identity recognition decays much
  more slowly than freshness.
- Update `lastMentionedAt` only when the selected cue enters the committed cut.
- A changed `truthFingerprint` produces a change candidate instead of silently
  replacing what the observer knew.
- Never infer disappearance from coverage, occlusion, low attention, or cue
  omission.
- Confirmed removal/healing may supersede the current memory while preserving
  historical observations.
- Retakes reuse captured notice/mention results rather than advancing memory a
  second time.

## Narrator behavior

Offer at most one recognition cue when it helps the current beat:

- **first notice** — a newly visible, sufficiently salient detail;
- **recognition refresh** — a familiar feature after a long absence or during
  identification;
- **change** — a known detail is altered, newly acquired, healed, or missing;
- **action relevance** — the current action exposes, touches, or depends on it;
- **emotional callback** — importance is grounded in an observed shared event.

Stable ordinary visibility should usually strengthen recognition while lowering
mention novelty. Remembered features may still support identity continuity,
image consistency, or reference grounding without generating prose.

## Acquired-feature example: missing ring finger

```text
committed injury event
        ↓
anatomy owner sets left ring-finger presence=absent
        ↓
body-state owner manages wound → healing → ended
        ↓
optional persistent scar fact is committed
        ↓
perception-safe recognition candidate reaches the observer
        ↓
VisualFeatureMemory records the new fingerprint
        ↓
narrator may mention the change once, then cooldown applies
```

The injury never appends prose to a recognizability list. It changes
authoritative anatomy, and observer memory follows what was actually perceived.

## Relationship to existing memory

Successor observations already carry witness, channel, confidence, detail tier,
and story time. Visual memory should be a rebuildable structured projection over
those observations, with optional `MemoryDocument` generation for semantic
recall.

Legacy character chat needs an equivalent cut-scoped observation adapter.
Do not use a shared character profile field or chat-wide RAG fact as a shortcut:
those surfaces cannot represent per-observer visibility and mention cooldown
safely.

## Acceptance tests

- zero visibility produces no notice regardless of uniqueness;
- a common but important shared-event scar can outrank a rare irrelevant mark;
- opaque coverage prevents visual-memory updates;
- first notice can produce a cue; repeated ordinary visibility normally does
  not;
- `lastNoticedAt` can advance without `lastMentionedAt`;
- a changed fingerprint produces a change candidate;
- occlusion never produces a false disappearance;
- observer A's memory never appears in observer B's read;
- replay rebuilds identical memory from identical observations;
- retake does not double-increment notice or mention counts.

## Resolved (owner rulings, 2026-07-28)

### Notice threshold

Notice requires total salience of roughly **0.35–0.40** *plus* the required
detail tier. Deliberate inspection may lower the threshold to about **0.25**,
but never bypasses visibility — zero visibility remains a hard gate.

### Decay — freshness buckets before a continuous law

Ship simple freshness buckets before any continuous decay curve:

- `recent` — under one story day;
- `familiar` — one to thirty days;
- `long_absence` — over thirty days.

A repeatedly noticed **stable** feature retains a **recognition floor** instead
of being forgotten completely; only freshness moves between buckets.

### Mention history — both surfaces, distinct roles

The **selected mention is captured with the cut**, which is what makes retakes
stable. The **committed `lastMentionedAt` and `mentionCount` belong in observer
visual memory**. The cut is the retake-safe record; the projection is the
cooldown record.

### Semantic-memory boundary

Emit a summary only for **stable, important identity facts** or **meaningful
acquired changes the observer actually noticed**. Never generate a RAG document
per visual-memory refresh.

### Importance storage

Resolved in the features spec: a stable base importance is stored, and observer
relationship plus current attention apply at projection time — see
[recognizable features §Resolved](body-attribute-affordances.spec.recognizable-features.md#resolved-owner-rulings-2026-07-28).

### Calibration stance

The thresholds and bucket boundaries above are fixture-tested calibration
defaults, not permanent product law.

## Shipped (Slice 7 implementation, 2026-07-29)

Salience, memory, and mention policy shipped as
`src/contracts/affordances/recognition/{salience,visual-memory,mention-policy}.ts`;
the chat persistence half is `src/server/engine/visual-memory-store.ts` over
the new `chat_visual_memory` table (migration `drizzle/0092_careful_spectrum.sql`).

### The commit seam is data, not a callback

`selectRecognitionCue` returns a SERIALIZABLE
`{ cue, notices, changes, memoryAfterNotices, mentionCommit }`, and
`commitRecognitionMention` folds the selected mention into that
already-computed memory. Nothing in the contract writes; the lane decides when.

That shape is what makes the ruled "mention is captured with the cut" true in a
lane with no event ledger. The read runs while the prompt is built, and the
commit runs only once the exchange has actually settled — a failed or empty
reply leaves memory exactly as the next take needs to find it, and a retake
cannot advance the same notice twice through a closure that already fired.

### Two generations, keyed to the memory group

One row per `(memory_group_id, viewpoint_id, subject_id)`. Scoping to the chat
**memory group** rather than the chat is the owner ruling made concrete:
"continue our history" retains recognition, a fresh conversation meets a
stranger.

The row stores `features` (current), `features_before` (the generation before
the exchange that last wrote it), and `applied_message_id` (the same rollback
guard the state and scenario anchors take). A retake arrives with the same
guard id, so the store hands the adapter `features_before` and the exchange
recomputes from the identical pre-exchange memory. A *new* exchange rotates
current into before. Two generations are enough because a retake only ever
replaces the most recent exchange; anything deeper would need the event ledger
this lane does not have.

`deleteChat` clears the group's rows when its last chat goes.

### Calibration as shipped

| Constant          | Value                                                                            |
| ----------------- | -------------------------------------------------------------------------------- |
| Salience mix      | `0.55 × uniqueness + 0.45 × importance` (of visibility)                          |
| Notice threshold  | 3_500; 2_500 under deliberate inspection                                         |
| Freshness buckets | `recent` < 1_440 min · `familiar` ≤ 43_200 min · `long_absence` beyond           |
| Recognition floor | 2_500, after ≥ 3 notices, for `inherent`/`persistent` features                   |
| Mention floor     | 2_000                                                                            |
| Novelty ladder    | unseen 10_000 · changed 9_000 · long absence 7_000 · familiar 2_000 · recent 500 |
| Mention cooldown  | recovers linearly over 1_440 × `mentionCount` minutes                            |
| Feature cap       | 96 per (scope, observer, subject)                                                |

The 0.35–0.40 ruling reads as 3_500 on the shared fixed-point scale, and the
0.25 inspection relaxation as 2_500. Memory state parses through healing
schemas: an unreadable entry is dropped rather than failing the exchange, and
the cap sheds the **least recently noticed** features first (a recognition
memory that dropped its newest rows would be worse than useless).

### Notices persist without a mention

Looking is what strengthens recognition, so notices commit even when no cue
fired — `mentionCommit` being null is a no-op inside `commitRecognitionMention`.
Only a cue that actually reached the transcript moves `lastMentionedAt` and
starts a cooldown. That is the ruled split between the two timestamps,
observable in production: with `CHAT_RECOGNITION_CUES` off nothing is computed
at all, but with it on and every cue below the mention floor, memory still
accumulates.

### Honest silences

- **A change loses to a recent mention.** A fingerprint change within roughly a
  story day of the same feature's last mention is adopted into memory (via the
  separate `applyRecognitionFingerprintChanges` path, so it is never lost) but
  scores below the mention floor and is not narrated. Defensible — the
  narrator did just talk about it — but it is a calibration ruling if change
  should be privileged over cooldown.
- **`emotional_callback` is unreachable** with the shipped priors: its
  importance requirement (7_000) is a tie rather than a clearance, and novelty
  outranks it in every case that would otherwise select it. The reason exists
  and is tested; nothing in production can currently choose it.
- **Semantic-memory document emission is not built** — the boundary is ruled,
  the emitter is deferred.
- **Successor-lane projection into the same contract** (rollout step 8) is
  deferred; the store, the scope union, and the observer union already carry
  the branch-scoped case.
