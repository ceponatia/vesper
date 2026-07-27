# Recognizable features — salience and visual memory

Status: draft (detail for
[body-attribute-affordances.spec.recognizable-features.md](body-attribute-affordances.spec.recognizable-features.md))

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

## Open questions

- Exact notice threshold and recognition-strength decay law.
- Whether importance is partly observer-relative at storage time or calculated
  entirely during projection.
- Whether mention history belongs in the captured cut, the visual-memory
  projection, or both.
- Which visual-memory summaries, if any, should become semantic memory
  documents.
