import type { SimulationBranchEvent } from "../contracts/branching";
import type { ActivityClaim } from "../contracts/activities";
import type { TemporalPressure } from "../contracts/commitments";
import {
  claimHoldingEngagementStates,
  engagementAttentionClaim,
  engagementEndedEventSchema,
  engagementInterruptedEventSchema,
  engagementOpenedEventSchema,
  engagementSchema,
  engagementStateTransitions,
  engagementsProjectionSchema,
  pressureAcknowledgedEventSchema,
  type AcknowledgePressureCommand,
  type AcknowledgePressureRejectionCode,
  type EndEngagementCommand,
  type EndEngagementRejectionCode,
  type Engagement,
  type EngagementEndedEvent,
  type EngagementInterruptReason,
  type EngagementOpenedEvent,
  type EngagementState,
  type EngagementsProjection,
  type OpenEngagementCommand,
  type OpenEngagementRejectionCode,
  type PressureAcknowledgedEvent,
} from "../contracts/engagements";
import { composeSimulationId } from "../contracts/identity";
import type { PhysicalLocus } from "../contracts/space";

/**
 * E3.4 slice 1 pure engagement kernel: open/end resolution over the claim
 * arithmetic, plus the projectors replay uses. One body, one physical scene;
 * a conversation claims attention but freezes nothing.
 */

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStableText);
}

export function deriveEngagementId(branchId: string, commandId: string): string {
  return composeSimulationId("engagement", [branchId, commandId]);
}

/**
 * The pair's STANDING scene test (one body one physical scene): a
 * claim-holding co-present engagement binding both actors. Shared by the chat
 * exchange's `findStandingEngagement` and the world read's `sceneOpen` flag so
 * the two can never disagree about whether a scene is open.
 */
export function isStandingCoPresentEngagement(engagement: Engagement, actorA: string, actorB: string): boolean {
  const participants: readonly string[] = engagement.participantIds;
  return (
    engagement.channel === "co_present" &&
    claimHoldingEngagementStates.includes(engagement.state) &&
    participants.includes(actorA) &&
    participants.includes(actorB)
  );
}

/** Claims an actor holds through open engagements (held until `ended`). */
export function engagementClaimsForActor(
  engagements: readonly Engagement[],
  actorId: string,
): ActivityClaim[] {
  return engagements
    .filter(
      (engagement) =>
        claimHoldingEngagementStates.includes(engagement.state) &&
        engagement.participantIds.includes(actorId as never),
    )
    .map((engagement) => engagement.attentionClaim);
}

/** Open co-present engagements an actor occupies — at most one may exist. */
export function openCoPresentEngagementsForActor(
  engagements: readonly Engagement[],
  actorId: string,
): Engagement[] {
  return engagements.filter(
    (engagement) =>
      engagement.channel === "co_present" &&
      claimHoldingEngagementStates.includes(engagement.state) &&
      engagement.participantIds.includes(actorId as never),
  );
}

function assertEngagementTransition(from: EngagementState, to: EngagementState, id: string): void {
  if (!engagementStateTransitions[from].includes(to)) {
    throw new Error(`Illegal engagement transition ${from} → ${to} for ${id}`);
  }
}

// ---------------------------------------------------------------------------
// OpenEngagement resolution
// ---------------------------------------------------------------------------

interface EngagementBranchMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

export interface OpenEngagementResolutionView extends EngagementBranchMeta {
  /** Participant facts, one entry per requested participant id. */
  participants: readonly {
    actorId: string;
    exists: boolean;
    locus?: PhysicalLocus;
    /** The zone's location when the locus is an at-locus (for the envelope). */
    locationId?: string;
    /** Full claim picture: activities plus open engagements. */
    heldClaims: readonly ActivityClaim[];
    inOpenCoPresentEngagement: boolean;
  }[];
}

interface OpenRejection {
  ok: false;
  code: OpenEngagementRejectionCode;
  publicReason: string;
}

export interface OpenEngagementResolution {
  ok: true;
  engagement: Engagement;
  event: EngagementOpenedEvent;
}

function openRejection(code: OpenEngagementRejectionCode, publicReason: string): OpenRejection {
  return { ok: false, code, publicReason };
}

/** Pure OpenEngagement resolver over a lock-consistent authority view. */
export function resolveOpenEngagement(
  view: OpenEngagementResolutionView,
  command: OpenEngagementCommand,
): OpenRejection | OpenEngagementResolution {
  if (command.branchId !== view.branchId) {
    return openRejection("branch_mismatch", "That world branch is unavailable.");
  }
  const requested = command.payload.participantIds;
  const byId = new Map(view.participants.map((participant) => [participant.actorId, participant]));
  for (const actorId of requested) {
    const participant = byId.get(actorId);
    if (!participant || !participant.exists) {
      return openRejection("participant_not_found", "Someone in that conversation is unavailable.");
    }
  }
  const principal = command.principal;
  if (
    (principal.kind === "player" || principal.kind === "npc_policy" || principal.kind === "npc_deliberator") &&
    !requested.some((actorId) => principal.controlledActorIds.includes(actorId))
  ) {
    return openRejection("unauthorized_actor", "You are not part of that conversation.");
  }

  const channel = command.payload.channel;
  let sceneZoneId: string | undefined;
  let sceneLocationId: string | undefined;
  if (channel === "co_present") {
    for (const actorId of requested) {
      const participant = byId.get(actorId);
      const locus = participant?.locus;
      if (!locus) throw new Error(`Actor ${actorId} has no physical locus`);
      if (locus.kind === "in_transit") {
        return openRejection("participant_in_transit", "They are on the move right now.");
      }
      if (sceneZoneId === undefined) {
        sceneZoneId = locus.zoneId;
        sceneLocationId = locus.locationId;
      } else if (locus.zoneId !== sceneZoneId) {
        return openRejection("participants_not_co_located", "They are not in the same place.");
      }
      if (participant.inOpenCoPresentEngagement) {
        // One body, one physical scene.
        return openRejection("participant_already_engaged", "They are already in a conversation.");
      }
    }
  }
  // Any channel requires presence of mind: a held full-attention claim (a nap,
  // another co-present scene) blocks joining even a text thread. Ruling 11's
  // no-wake default stays intact — a message can still be delivered later;
  // delivery is not an engagement.
  for (const actorId of requested) {
    const participant = byId.get(actorId);
    const holdsFullAttention = (participant?.heldClaims ?? []).some(
      (claim) => claim.kind === "attention" && claim.weight === "full",
    );
    if (holdsFullAttention) {
      return openRejection("participant_unavailable", "They cannot give this their attention right now.");
    }
  }

  const engagementId = deriveEngagementId(view.branchId, command.id);
  const attentionClaim = engagementAttentionClaim(channel);
  const event = engagementOpenedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "engagement-opened"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    type: "engagement_opened",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: requested,
    entityIds: sortedUnique([engagementId, ...requested, ...(sceneZoneId ? [sceneZoneId] : [])]),
    ...(sceneLocationId ? { locationId: sceneLocationId } : {}),
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      engagementId,
      channel,
      ...(sceneZoneId ? { zoneId: sceneZoneId } : {}),
      openedAt: view.storySecond,
      attentionClaim,
    },
  });

  // Slice 1 opens straight to `active`; the `opening` state is reserved for
  // the arbiter's multi-step handshake (E3.4b).
  const engagement = engagementSchema.parse({
    id: engagementId,
    participantIds: requested,
    channel,
    ...(sceneLocationId ? { locationId: sceneLocationId } : {}),
    ...(sceneZoneId ? { zoneId: sceneZoneId } : {}),
    state: "active",
    openedAt: view.storySecond,
    attentionClaim,
    sourceCommandId: command.id,
  });

  return { ok: true, engagement, event };
}

// ---------------------------------------------------------------------------
// EndEngagement resolution
// ---------------------------------------------------------------------------

export interface EndEngagementResolutionView extends EngagementBranchMeta {
  engagement?: Engagement;
}

interface EndRejection {
  ok: false;
  code: EndEngagementRejectionCode;
  publicReason: string;
}

export interface EndEngagementResolution {
  ok: true;
  engagement: Engagement;
  event: EngagementEndedEvent;
}

function endRejection(code: EndEngagementRejectionCode, publicReason: string): EndRejection {
  return { ok: false, code, publicReason };
}

/**
 * The `engagement_ended` event for one open engagement at a chosen sequence.
 * Shared by `resolveEndEngagement` (the ordinary end command) and the composed
 * `move_together` resolver (which ends the standing scene as `participant_choice`
 * in the SAME batch that departs both travellers — grace, one indivisible
 * action). Ending releases claims but moves no one; the mover's departure
 * events do the moving.
 */
export function buildEngagementEndedEvent(input: {
  meta: EngagementBranchMeta;
  command: { id: string; correlationId: string; submittedAtWallClock: string };
  engagement: Engagement;
  reason: EndEngagementCommand["payload"]["reason"];
  sequence: number;
}): EngagementEndedEvent {
  return engagementEndedEventSchema.parse({
    id: composeSimulationId("event", [input.meta.branchId, input.command.id, "engagement-ended"]),
    worldId: input.meta.worldId,
    branchId: input.meta.branchId,
    sequence: input.sequence,
    storySecond: input.meta.storySecond,
    type: "engagement_ended",
    schemaVersion: 1,
    rulesetVersion: input.meta.rulesetVersion,
    commandId: input.command.id,
    correlationId: input.command.correlationId,
    actorIds: input.engagement.participantIds,
    entityIds: sortedUnique([input.engagement.id, ...input.engagement.participantIds]),
    ...(input.engagement.locationId ? { locationId: input.engagement.locationId } : {}),
    recordedAtWallClock: input.command.submittedAtWallClock,
    payload: {
      engagementId: input.engagement.id,
      endedAt: input.meta.storySecond,
      reason: input.reason,
    },
  });
}

/** Ending releases claims but moves no one. */
export function resolveEndEngagement(
  view: EndEngagementResolutionView,
  command: EndEngagementCommand,
): EndRejection | EndEngagementResolution {
  if (command.branchId !== view.branchId) {
    return endRejection("branch_mismatch", "That world branch is unavailable.");
  }
  const engagement = view.engagement;
  if (!engagement) return endRejection("engagement_not_found", "That conversation is unknown.");
  if (!engagementStateTransitions[engagement.state].includes("ended")) {
    return endRejection("engagement_not_open", "That conversation has already ended.");
  }
  const principal = command.principal;
  const controlsParticipant = engagement.participantIds.some((actorId) =>
    principal.controlledActorIds.includes(actorId),
  );
  if (principal.kind !== "system" && !controlsParticipant) {
    return endRejection("unauthorized_actor", "You are not part of that conversation.");
  }

  const event = buildEngagementEndedEvent({
    meta: {
      worldId: view.worldId,
      branchId: view.branchId,
      rulesetVersion: view.rulesetVersion,
      headSequence: view.headSequence,
      storySecond: view.storySecond,
    },
    command,
    engagement,
    reason: command.payload.reason,
    sequence: view.headSequence + 1,
  });

  const ended = engagementSchema.parse({ ...engagement, state: "ended" });
  return { ok: true, engagement: ended, event };
}

// ---------------------------------------------------------------------------
// AcknowledgePressure resolution (E5.5 slice 3)
// ---------------------------------------------------------------------------

export interface AcknowledgePressureResolutionView extends EngagementBranchMeta {
  engagement?: Engagement;
  /** The pressure row named by the command, loaded narrowly by the store —
   * `undefined` when no such pressure exists on this branch. */
  pressure?: TemporalPressure;
}

interface AcknowledgePressureRejection {
  ok: false;
  code: AcknowledgePressureRejectionCode;
  publicReason: string;
}

export interface AcknowledgePressureResolution {
  ok: true;
  event: PressureAcknowledgedEvent;
}

function acknowledgePressureRejection(
  code: AcknowledgePressureRejectionCode,
  publicReason: string,
): AcknowledgePressureRejection {
  return { ok: false, code, publicReason };
}

/**
 * Mark a live temporal pressure "looked at and not resolved" by one of an
 * open engagement's participants. Mechanical, arbiter-driven — like
 * `confirm_narrator_result`, this resolves off the turn machinery rather
 * than any single participant's own agency, so only a `system` principal is
 * authorized (deviation-flagged design choice: the blueprint names the
 * rejection `unauthorized_principal`, not `unauthorized_actor`, which reads
 * as the same "mechanical, not player-attributable" shape as
 * `confirm_narrator_result`'s existing system-only check).
 */
export function resolveAcknowledgePressure(
  view: AcknowledgePressureResolutionView,
  command: AcknowledgePressureCommand,
): AcknowledgePressureRejection | AcknowledgePressureResolution {
  if (command.branchId !== view.branchId) {
    return acknowledgePressureRejection("branch_mismatch", "That world branch is unavailable.");
  }
  const engagement = view.engagement;
  if (!engagement) return acknowledgePressureRejection("engagement_not_found", "That conversation is unknown.");
  if (!claimHoldingEngagementStates.includes(engagement.state)) {
    return acknowledgePressureRejection("engagement_not_open", "That conversation is not open.");
  }
  if (command.principal.kind !== "system") {
    return acknowledgePressureRejection("unauthorized_principal", "That cannot be acknowledged directly.");
  }
  const pressure = view.pressure;
  if (!pressure) return acknowledgePressureRejection("pressure_not_found", "That pressure is unknown.");
  if (pressure.resolvedAt !== undefined || !engagement.participantIds.includes(pressure.actorId as never)) {
    return acknowledgePressureRejection(
      "pressure_not_relevant",
      "That pressure has nothing to do with this conversation.",
    );
  }
  // Re-acknowledging at the SAME severity is a no-op rejection; a severity
  // change since the last acknowledgment is new evidence and is legally
  // re-acknowledgeable (mirrors `compileNarrativeCut`'s own
  // acknowledgedSeverity-vs-severity comparison, narrative.ts).
  if (pressure.acknowledgedAt !== undefined && pressure.acknowledgedSeverity === pressure.severity) {
    return acknowledgePressureRejection("already_acknowledged", "That has already been acknowledged.");
  }

  const event = pressureAcknowledgedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "pressure-acknowledged"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    type: "pressure_acknowledged",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: [pressure.actorId],
    // `pressure.id` is deliberately OMITTED here — like `pressure_raised`'s
    // own entityIds (commitments.ts), a pressure id nests a commitment id
    // which itself nests a branch+command id, and can exceed the 256-char
    // compact-id cap `simulationEntityIdSchema` enforces.
    entityIds: sortedUnique([engagement.id, pressure.actorId]),
    ...(engagement.locationId ? { locationId: engagement.locationId } : {}),
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      engagementId: engagement.id,
      pressureId: pressure.id,
      actorId: pressure.actorId,
      acknowledgedAt: view.storySecond,
      acknowledgedSeverity: pressure.severity,
    },
  });
  return { ok: true, event };
}

/** The interruption event a departure emits for each open co-present scene it breaks. */
export function buildDepartureInterruptEvent(input: {
  meta: EngagementBranchMeta;
  command: { id: string; correlationId: string; submittedAtWallClock: string };
  engagement: Engagement;
  sequence: number;
  causationId: string;
  /** Defaults to the departure reason; a collapse names its own (E5.2). */
  reason?: EngagementInterruptReason;
}): SimulationBranchEvent {
  return engagementInterruptedEventSchema.parse({
    id: composeSimulationId("event", [input.meta.branchId, input.command.id, `interrupt-${input.engagement.id}`]),
    worldId: input.meta.worldId,
    branchId: input.meta.branchId,
    sequence: input.sequence,
    storySecond: input.meta.storySecond,
    type: "engagement_interrupted",
    schemaVersion: 1,
    rulesetVersion: input.meta.rulesetVersion,
    commandId: input.command.id,
    causationId: input.causationId,
    correlationId: input.command.correlationId,
    actorIds: input.engagement.participantIds,
    entityIds: sortedUnique([input.engagement.id, ...input.engagement.participantIds]),
    ...(input.engagement.locationId ? { locationId: input.engagement.locationId } : {}),
    recordedAtWallClock: input.command.submittedAtWallClock,
    payload: {
      engagementId: input.engagement.id,
      interruptedAt: input.meta.storySecond,
      reason: input.reason ?? "participant_departed",
    },
  });
}

// ---------------------------------------------------------------------------
// Engagements projection: projectors and replay
// ---------------------------------------------------------------------------

export function sortEngagementsProjection(projection: EngagementsProjection): EngagementsProjection {
  return engagementsProjectionSchema.parse({
    ...projection,
    engagements: [...projection.engagements].sort((a, b) => compareStableText(a.id, b.id)),
  });
}

function updateEngagement(
  projection: EngagementsProjection,
  engagementId: string,
  eventType: string,
  nextState: EngagementState,
): Engagement[] {
  const existing = projection.engagements.find((candidate) => candidate.id === engagementId);
  if (!existing) throw new Error(`${eventType} replay references a missing engagement`);
  assertEngagementTransition(existing.state, nextState, existing.id);
  const next = engagementSchema.parse({ ...existing, state: nextState });
  return projection.engagements.map((candidate) => (candidate.id === next.id ? next : candidate));
}

/** Pure synchronous projector for the engagement event family. */
export function applyEngagementEvent(
  projection: EngagementsProjection,
  event: SimulationBranchEvent,
): EngagementsProjection {
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };
  if (event.type === "engagement_opened") {
    if (!event.commandId) throw new Error("engagement_opened replay requires a command identity");
    const zone = event.payload.zoneId;
    const engagement = engagementSchema.parse({
      id: event.payload.engagementId,
      participantIds: event.actorIds,
      channel: event.payload.channel,
      ...(event.locationId ? { locationId: event.locationId } : {}),
      ...(zone ? { zoneId: zone } : {}),
      state: "active",
      openedAt: event.payload.openedAt,
      attentionClaim: event.payload.attentionClaim,
      sourceCommandId: event.commandId,
    });
    return sortEngagementsProjection({ ...bumped, engagements: [...projection.engagements, engagement] });
  }
  if (event.type === "engagement_ended") {
    return sortEngagementsProjection({
      ...bumped,
      engagements: updateEngagement(projection, event.payload.engagementId, event.type, "ended"),
    });
  }
  if (event.type === "engagement_interrupted") {
    return sortEngagementsProjection({
      ...bumped,
      engagements: updateEngagement(projection, event.payload.engagementId, event.type, "interrupted"),
    });
  }
  if (event.type === "engagement_winding_down") {
    return sortEngagementsProjection({
      ...bumped,
      engagements: updateEngagement(projection, event.payload.engagementId, event.type, "winding_down"),
    });
  }
  if (event.type === "pressure_acknowledged") {
    // The sibling real case to `commitments.ts`'s — appends this
    // event's `pressureId` to the matching engagement's
    // `acknowledgedPressureIds`. `sortedUnique` makes a duplicate append
    // (a defensive replay-safety property, not a live failure mode — each
    // event folds once) idempotent.
    return sortEngagementsProjection({
      ...bumped,
      engagements: projection.engagements.map((engagement) =>
        engagement.id === event.payload.engagementId
          ? engagementSchema.parse({
              ...engagement,
              acknowledgedPressureIds: sortedUnique([...engagement.acknowledgedPressureIds, event.payload.pressureId]),
            })
          : engagement,
      ),
    });
  }
  // Non-engagement families advance the boundary without touching this projection.
  return engagementsProjectionSchema.parse(bumped);
}

export interface EngagementsReplayInput {
  /** Engagements are fully evented: a branch-origin seed holds none (R3). */
  seed: EngagementsProjection;
  events: readonly SimulationBranchEvent[];
}

/** Fold one branch's full logical stream into its engagements projection. */
export function replayEngagementsHistory(input: EngagementsReplayInput): EngagementsProjection {
  const seed = sortEngagementsProjection(engagementsProjectionSchema.parse(input.seed));
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(`Engagements replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`);
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applyEngagementEvent(projection, event);
    lastSequence = event.sequence;
  }
  return engagementsProjectionSchema.parse({
    ...projection,
    version: seed.version + commandIds.size,
  });
}

/** The empty branch-origin engagements seed. */
export function emptyEngagementsSeed(branchId: string, originStorySecond: number): EngagementsProjection {
  return engagementsProjectionSchema.parse({
    branchId,
    headSequence: 0,
    version: 0,
    storySecond: originStorySecond,
    engagements: [],
  });
}
