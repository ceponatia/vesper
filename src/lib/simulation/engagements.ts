import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import type { ActivityClaim } from "@/contracts/simulation/activities";
import {
  claimHoldingEngagementStates,
  engagementAttentionClaim,
  engagementEndedEventSchema,
  engagementInterruptedEventSchema,
  engagementOpenedEventSchema,
  engagementSchema,
  engagementStateTransitions,
  engagementsProjectionSchema,
  type EndEngagementCommand,
  type EndEngagementRejectionCode,
  type Engagement,
  type EngagementEndedEvent,
  type EngagementOpenedEvent,
  type EngagementState,
  type EngagementsProjection,
  type OpenEngagementCommand,
  type OpenEngagementRejectionCode,
} from "@/contracts/simulation/engagements";
import { composeSimulationId } from "@/contracts/simulation/identity";
import type { PhysicalLocus } from "@/contracts/simulation/space";

/**
 * E3.4 slice 1 pure engagement kernel: open/end resolution over the claim
 * arithmetic, plus the projectors replay uses. One body, one physical scene
 * (spec §11.3); a conversation claims attention but freezes nothing.
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

/** Claims an actor holds through open engagements (held until `ended`, §18.2). */
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

/** Open co-present engagements an actor occupies — at most one may exist (§11.3). */
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
// OpenEngagement resolution (engine.spec §18.1, §11.3)
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
        // One body, one physical scene (spec §11.3).
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
// EndEngagement resolution (engine.spec §18.2)
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

/** Ending releases claims but moves no one (§18.2). */
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

  const event = engagementEndedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "engagement-ended"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    type: "engagement_ended",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: engagement.participantIds,
    entityIds: sortedUnique([engagement.id, ...engagement.participantIds]),
    ...(engagement.locationId ? { locationId: engagement.locationId } : {}),
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      engagementId: engagement.id,
      endedAt: view.storySecond,
      reason: command.payload.reason,
    },
  });

  const ended = engagementSchema.parse({ ...engagement, state: "ended" });
  return { ok: true, engagement: ended, event };
}

/** The interruption event a departure emits for each open co-present scene it breaks. */
export function buildDepartureInterruptEvent(input: {
  meta: EngagementBranchMeta;
  command: { id: string; correlationId: string; submittedAtWallClock: string };
  engagement: Engagement;
  sequence: number;
  causationId: string;
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
      reason: "participant_departed",
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
  // Non-engagement families advance the boundary without touching this projection.
  return engagementsProjectionSchema.parse(bumped);
}

export interface EngagementsReplayInput {
  /** Engagements are fully evented: a branch-origin seed holds none (plan R3). */
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
