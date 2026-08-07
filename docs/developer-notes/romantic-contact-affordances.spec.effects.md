# Romantic contact affordances — observations, effects, and presentation

Status: technical companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)

## Contracts

```ts
interface ContactObservation {
  id: ContactObservationId;
  phenomenonId: ContactPhenomenonId;
  subjectIds: readonly EntityId[];
  locus: BodyLocusRef;
  channel: "visual" | "tactile" | "olfactory" | "gustatory";
  tags: readonly string[];
  strength: UnitInterval;
  evidence: readonly AffordanceEvidence[];
  repeatKey: string;
}

interface ContactConstraint {
  kind:
    | "contact_blocked"
    | "direct_surface_hidden"
    | "motion_restricted"
    | "effect_not_committed";
  locus: BodyLocusRef;
  evidence: readonly AffordanceEvidence[];
}

interface ContactEffectBase {
  sourceSurface: SurfaceHandle;
  targetSurface: SurfaceHandle;
  causedByContactId: ContactId;
  idempotencyKey: ContactEffectIdempotencyKey;
  evidence: readonly AffordanceEvidence[];
}

type ProposedContactEffect =
  | (ContactEffectBase & {
      kind: "surface_transfer";
      payload: SurfaceMaterialPayload;
      sourceDelta: SurfaceMaterialDelta;
      targetDelta: SurfaceMaterialDelta;
    })
  | (ContactEffectBase & {
      kind: "pressure_mark" | "scratch" | "garment_displacement";
      magnitude: UnitInterval;
    });

type ContactEffectCommitResult =
  | {
      status: "committed" | "already_committed";
      idempotencyKey: ContactEffectIdempotencyKey;
      effectId: CommittedContactEffectId;
      eventIds: readonly EventId[];
    }
  | {
      status: "rejected";
      idempotencyKey: ContactEffectIdempotencyKey;
      reason:
        | "insufficient_source"
        | "owner_unavailable"
        | "conflict"
        | "invalid_proposal";
    };
```

`ProposedContactEffect` is submitted to the owning action/body/garment
transaction. The next frame may observe the committed result by event id. A
failed or rolled-back effect remains absent.

**Ownership ruling (owner, 2026-07-30)** — resolving the plan's *"Who owns
regional moisture and residue?"*: **body-surface state** owns skin moisture,
products, and residue, keyed by subject, side, and surface; **garment state**
owns wet footwear and other garment-carried substance, which reaches contact
mechanics only through the material layers. This extends today's
wetness-only, hair-only `BodySurfaceState` along the axes the foot condition
read already assumes (subject × side × surface × substance kind); the contact
layer proposes, these two owners commit, and neither may invent a source the
other did not record.

## Material-transfer law

- Source removal and target deposition commit in one transaction/event batch.
- The transferred kind and amount are identical on both sides after unit
  normalization.
- Source amount cannot fall below zero.
- A retry with the same idempotency key produces no second transfer.
- A retake restores or replays both sides together.
- Permeability may route material onto an intermediate garment layer rather
  than directly to skin.
- A transfer across lanes uses the owning lane's event/snapshot transaction;
  the pure affordance resolver never writes either side.

## Marks, scratches, and displacement

Marks and scratches do not use a conservation law, but still require:

- an active committed contact and supported pressure/duration/path;
- idempotency and cause provenance;
- an explicit body-state owner;
- expiry/healing semantics where appropriate;
- rollback and branch parity.

Garment displacement additionally requires a wardrobe operation. Contact may
propose the operation, but the garment graph validates and commits the exact
part/coverage change.

## Perception and intimate gating

Perception gating is evaluated before cue ranking.

| Channel   | Minimum evidence                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------- |
| Visual    | Unoccluded path, sufficient light/distance/orientation, exposure appropriate to region and viewer. |
| Tactile   | Actor is a participant in committed contact and material transmission is nonzero.                  |
| Olfactory | Current contributor, exposure/permeability, proximity, and airflow.                                |
| Gustatory | Direct qualifying oral contact, current contributor, and intimate policy pass where required.      |

Intimate status is an additional hard gate, not a score. High salience,
uniqueness, action relevance, or narrator focus cannot bypass it.

The narrator gets no observations about what another actor privately feels.
A character's internal tactile observation may inform that character's own
behavior/narration only through the lane's established point-of-view rules.

## Ranking and repetition

Physical truth and mention state remain separate.

```ts
interface ContactMentionRead {
  observation: ContactObservation;
  novelty: UnitInterval;
  changeSignificance: UnitInterval;
  actionRelevance: UnitInterval;
  narrativeFocus: UnitInterval;
  repetitionCooldown: UnitInterval;
}

function contactMentionPriority(read: ContactMentionRead): number {
  return (
    Math.max(read.novelty, read.changeSignificance, read.actionRelevance) *
    read.narrativeFocus *
    read.repetitionCooldown
  );
}
```

This formula is a proposed shape, not calibrated truth. Rank after hard gates
and select at most one or two cues. A repeat key includes phenomenon, subjects,
locus, channel, and stable result band. New pressure, path, material, motion,
surface condition, effect commit, or perception can change the fingerprint and
restore priority.

Keep separate timestamps for:

- last physically observed/noticed;
- last offered to the narrator;
- last realized in narration, if the lane can report it.

Do not require RAG retrieval for immediate cooldown correctness.

## Required tests

- a proposed effect never becomes an observation before commit;
- a failed or rolled-back effect produces no aftermath;
- transfer conserves kind and amount;
- insufficient source material rejects without partial target deposition;
- retry with the same key is a no-op;
- retry/retake cannot double a mark, scratch, displacement, or transfer;
- permeability deposits onto the correct intermediate layer;
- expired/healed marks disappear through the body-state owner, not affordance
  memory;
- garment displacement changes effective coverage only after wardrobe commit.
