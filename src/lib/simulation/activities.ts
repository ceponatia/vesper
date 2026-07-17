import {
  activitiesProjectionSchema,
  activityCancelledEventSchema,
  activityClaimsConflict,
  activityCompletedEventSchema,
  activityInstanceSchema,
  activityPhaseTransitions,
  activityStartedEventSchema,
  claimHoldingActivityPhases,
  type SimulationActionDefinition,
  type ActivitiesProjection,
  type ActivityCancelledEvent,
  type ActivityClaim,
  type ActivityCompletedEvent,
  type ActivityInstance,
  type ActivityPhase,
  type ActivityStartedEvent,
  type CancelActivityCommand,
  type CancelActivityRejectionCode,
  type CompleteActivityCommand,
  type CompleteActivityRejectionCode,
  type StartActivityCommand,
  type StartActivityRejectionCode,
} from "@/contracts/simulation/activities";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import { composeSimulationId } from "@/contracts/simulation/identity";
import {
  activityCompletionTriggerKind,
  schedulerDerivationVersion,
  triggerScheduledEventSchema,
  type TriggerScheduledEvent,
} from "@/contracts/simulation/scheduler";
import type { PhysicalLocus } from "@/contracts/simulation/space";

/**
 * E3.2 pure activity kernel: start/complete/cancel resolution, claim
 * arithmetic over the activity set, and the projectors replay uses. No IO, no
 * clock, no ambient randomness (engine.spec §31–32).
 */

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStableText);
}

export function deriveActivityId(branchId: string, commandId: string): string {
  return composeSimulationId("activity", [branchId, commandId]);
}

/** The stable per-activity key the completion trigger schedules under. */
export function activityCompletionUniquenessKey(activityInstanceId: string): string {
  return composeSimulationId("activity-completion", [activityInstanceId]);
}

/** Claims an actor currently holds: the claims of every claim-holding activity they are in. */
export function heldClaimsForActor(
  activities: readonly ActivityInstance[],
  actorId: string,
): ActivityClaim[] {
  return activities
    .filter(
      (activity) =>
        claimHoldingActivityPhases.includes(activity.phase) && activity.actorIds.includes(actorId as never),
    )
    .flatMap((activity) => activity.claims);
}

/** Does the actor hold a body claim — the E3.2 rule that blocks departure. */
export function actorHoldsBodyClaim(activities: readonly ActivityInstance[], actorId: string): boolean {
  return heldClaimsForActor(activities, actorId).some((claim) => claim.kind === "body");
}

function assertActivityTransition(from: ActivityPhase, to: ActivityPhase, activityId: string): void {
  if (!activityPhaseTransitions[from].includes(to)) {
    throw new Error(`Illegal activity transition ${from} → ${to} for ${activityId}`);
  }
}

// ---------------------------------------------------------------------------
// StartActivity resolution (engine.spec §16.1–16.3)
// ---------------------------------------------------------------------------

interface ActivityBranchMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

export interface StartActivityResolutionView extends ActivityBranchMeta {
  actorExists: boolean;
  /** The actor's current locus; every registered actor has exactly one. */
  locus?: PhysicalLocus;
  /** The actor's current zone facts when the locus is an at-locus. */
  actorZone?: { id: string; kind: string; locationId: string };
  definition?: SimulationActionDefinition;
  /** Claims the actor already holds across claim-holding activities. */
  heldClaims: readonly ActivityClaim[];
  /** Actors whose locus is the same zone, excluding the acting actor. */
  coLocatedActorIds: readonly string[];
}

interface StartRejection {
  ok: false;
  code: StartActivityRejectionCode;
  publicReason: string;
}

export interface StartResolution {
  ok: true;
  activity: ActivityInstance;
  events: [ActivityStartedEvent, TriggerScheduledEvent];
}

function startRejection(code: StartActivityRejectionCode, publicReason: string): StartRejection {
  return { ok: false, code, publicReason };
}

/** Pure StartActivity resolver over a lock-consistent authority view. */
export function resolveStartActivity(
  view: StartActivityResolutionView,
  command: StartActivityCommand,
): StartRejection | StartResolution {
  if (command.branchId !== view.branchId) {
    return startRejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!view.actorExists) return startRejection("actor_not_found", "That actor is unavailable.");
  if (!command.principal.controlledActorIds.includes(command.payload.actorId)) {
    return startRejection("unauthorized_actor", "You cannot direct that actor.");
  }
  const definition = view.definition;
  if (!definition) return startRejection("action_not_found", "That action is unknown here.");
  if (!definition.controllerKinds.includes(command.principal.kind)) {
    return startRejection("unauthorized_controller", "That action is not available to you.");
  }
  const locus = view.locus;
  if (!locus) throw new Error(`Actor ${command.payload.actorId} has no physical locus`);
  if (locus.kind === "in_transit") {
    return startRejection("actor_in_transit", "They cannot do that while traveling.");
  }
  const zone = view.actorZone;
  if (!zone || zone.id !== locus.zoneId) {
    throw new Error("Start-activity view zone facts do not match the actor locus");
  }
  for (const precondition of definition.preconditions) {
    if (precondition.kind === "at_zone_kind" && zone.kind !== precondition.zoneKind) {
      return startRejection("precondition_failed", "This is not the place for that.");
    }
  }
  if (activityClaimsConflict(view.heldClaims, definition.requiredClaims)) {
    return startRejection("claim_conflict", "They are already occupied.");
  }

  const activityId = deriveActivityId(view.branchId, command.id);
  const actorId = command.payload.actorId;
  const startedAt = view.storySecond;
  const expectedCompleteAt = startedAt + definition.duration.seconds;
  const observerActorIds =
    definition.noticeability === "obvious"
      ? sortedUnique([...view.coLocatedActorIds, actorId])
      : [actorId];

  const startedEvent = activityStartedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "activity-started"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: startedAt,
    type: "activity_started",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: [actorId],
    entityIds: sortedUnique([actorId, activityId, zone.id]),
    locationId: zone.locationId,
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      activityInstanceId: activityId,
      actionDefinitionId: definition.id,
      actionVersion: definition.version,
      zoneId: zone.id,
      startedAt,
      expectedCompleteAt,
      claims: definition.requiredClaims,
      observerActorIds,
    },
  });

  const templateId = composeSimulationId("template", [activityId]);
  const triggerEvent = triggerScheduledEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "completion-trigger"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 2,
    storySecond: startedAt,
    type: "trigger_scheduled",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: schedulerDerivationVersion,
    commandId: command.id,
    causationId: startedEvent.id,
    correlationId: command.correlationId,
    actorIds: [actorId],
    entityIds: [activityId],
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      kind: activityCompletionTriggerKind,
      triggerSchemaVersion: 1,
      dueStorySecond: expectedCompleteAt,
      priority: 0,
      uniquenessKey: activityCompletionUniquenessKey(activityId),
      command: {
        id: templateId,
        branchId: view.branchId,
        expectedVersion: 0,
        idempotencyKey: templateId,
        principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] },
        submittedAtWallClock: command.submittedAtWallClock,
        correlationId: command.correlationId,
        type: "complete_activity",
        schemaVersion: 1,
        payload: { activityInstanceId: activityId },
      },
    },
  });

  const activity = activityInstanceSchema.parse({
    id: activityId,
    actionDefinitionId: definition.id,
    actionVersion: definition.version,
    actorIds: [actorId],
    zoneId: zone.id,
    phase: "active",
    startedAt,
    expectedCompleteAt,
    progressFixedPoint: 0,
    claims: definition.requiredClaims,
    sourceCommandId: command.id,
  });

  return { ok: true, activity, events: [startedEvent, triggerEvent] };
}

// ---------------------------------------------------------------------------
// CompleteActivity resolution (engine.spec §9.3, §16.3)
// ---------------------------------------------------------------------------

export interface CompleteActivityResolutionView extends ActivityBranchMeta {
  activity?: ActivityInstance;
  /** The activity zone's location, for the event envelope. */
  zoneLocationId?: string;
  /** Actors whose locus is the activity's zone at completion time. */
  coLocatedActorIds: readonly string[];
  noticeability?: SimulationActionDefinition["noticeability"];
}

interface CompleteRejection {
  ok: false;
  code: CompleteActivityRejectionCode;
  publicReason: string;
}

export interface CompleteResolution {
  ok: true;
  activity: ActivityInstance;
  event: ActivityCompletedEvent;
}

function completeRejection(code: CompleteActivityRejectionCode, publicReason: string): CompleteRejection {
  return { ok: false, code, publicReason };
}

/** Pure fire-time completion resolver. Re-validates rather than trusting the schedule. */
export function resolveCompleteActivity(
  view: CompleteActivityResolutionView,
  command: CompleteActivityCommand,
): CompleteRejection | CompleteResolution {
  if (command.branchId !== view.branchId) {
    return completeRejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (command.principal.kind !== "system") {
    return completeRejection("unauthorized_principal", "Completions resolve mechanically, not by request.");
  }
  const activity = view.activity;
  if (!activity) return completeRejection("activity_not_found", "That activity is unknown.");
  if (activity.phase !== "active") {
    return completeRejection("activity_not_active", "That activity is no longer underway.");
  }
  if (activity.expectedCompleteAt !== undefined && view.storySecond < activity.expectedCompleteAt) {
    throw new Error(
      `Completion for ${activity.id} fired at ${view.storySecond}, before its due ${activity.expectedCompleteAt}`,
    );
  }

  const completedAt = view.storySecond;
  const observerActorIds =
    (view.noticeability ?? "obvious") === "obvious"
      ? sortedUnique([...view.coLocatedActorIds, ...activity.actorIds])
      : [...activity.actorIds];

  const event = activityCompletedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "activity-completed"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: completedAt,
    type: "activity_completed",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: activity.actorIds,
    entityIds: sortedUnique([activity.id, activity.zoneId, ...activity.actorIds]),
    ...(view.zoneLocationId ? { locationId: view.zoneLocationId } : {}),
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      activityInstanceId: activity.id,
      completedAt,
      observerActorIds,
    },
  });

  const completed = activityInstanceSchema.parse({
    ...activity,
    phase: "completed",
    progressFixedPoint: 1_000_000,
  });

  return { ok: true, activity: completed, event };
}

// ---------------------------------------------------------------------------
// CancelActivity resolution (engine.spec §16.3)
// ---------------------------------------------------------------------------

export interface CancelActivityResolutionView extends ActivityBranchMeta {
  activity?: ActivityInstance;
  interruptibility?: SimulationActionDefinition["interruptibility"];
  noticeability?: SimulationActionDefinition["noticeability"];
  zoneLocationId?: string;
  coLocatedActorIds: readonly string[];
}

interface CancelRejection {
  ok: false;
  code: CancelActivityRejectionCode;
  publicReason: string;
}

export interface CancelResolution {
  ok: true;
  activity: ActivityInstance;
  event: ActivityCancelledEvent;
}

function cancelRejection(code: CancelActivityRejectionCode, publicReason: string): CancelRejection {
  return { ok: false, code, publicReason };
}

export function resolveCancelActivity(
  view: CancelActivityResolutionView,
  command: CancelActivityCommand,
): CancelRejection | CancelResolution {
  if (command.branchId !== view.branchId) {
    return cancelRejection("branch_mismatch", "That world branch is unavailable.");
  }
  const activity = view.activity;
  if (!activity) return cancelRejection("activity_not_found", "That activity is unknown.");
  if (!activityPhaseTransitions[activity.phase].includes("cancelled")) {
    return cancelRejection("activity_not_cancellable", "That activity has already ended.");
  }
  if ((view.interruptibility ?? "free") === "locked") {
    return cancelRejection("activity_not_cancellable", "That cannot be stopped once begun.");
  }
  const controlsParticipant = activity.actorIds.some((actorId) =>
    command.principal.controlledActorIds.includes(actorId),
  );
  if (command.principal.kind !== "system" && !controlsParticipant) {
    return cancelRejection("unauthorized_actor", "You cannot stop that for them.");
  }

  const cancelledAt = view.storySecond;
  const observerActorIds =
    (view.noticeability ?? "obvious") === "obvious"
      ? sortedUnique([...view.coLocatedActorIds, ...activity.actorIds])
      : [...activity.actorIds];

  const event = activityCancelledEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "activity-cancelled"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: cancelledAt,
    type: "activity_cancelled",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: activity.actorIds,
    entityIds: sortedUnique([activity.id, activity.zoneId, ...activity.actorIds]),
    ...(view.zoneLocationId ? { locationId: view.zoneLocationId } : {}),
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      activityInstanceId: activity.id,
      cancelledAt,
      reason: command.payload.reason,
      observerActorIds,
    },
  });

  const cancelled = activityInstanceSchema.parse({ ...activity, phase: "cancelled" });
  return { ok: true, activity: cancelled, event };
}

// ---------------------------------------------------------------------------
// Activities projection: projectors and replay
// ---------------------------------------------------------------------------

export function sortActivitiesProjection(projection: ActivitiesProjection): ActivitiesProjection {
  return activitiesProjectionSchema.parse({
    ...projection,
    activities: [...projection.activities].sort((a, b) => compareStableText(a.id, b.id)),
  });
}

function updateActivity(
  projection: ActivitiesProjection,
  activityInstanceId: string,
  eventType: string,
  transform: (activity: ActivityInstance) => ActivityInstance,
): ActivityInstance[] {
  const existing = projection.activities.find((candidate) => candidate.id === activityInstanceId);
  if (!existing) throw new Error(`${eventType} replay references a missing activity`);
  const next = transform(existing);
  assertActivityTransition(existing.phase, next.phase, existing.id);
  return projection.activities.map((candidate) => (candidate.id === next.id ? next : candidate));
}

/** Pure synchronous projector for the activity event family. */
export function applyActivityEvent(
  projection: ActivitiesProjection,
  event: SimulationBranchEvent,
): ActivitiesProjection {
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };
  switch (event.type) {
    case "activity_started": {
      if (!event.commandId) throw new Error("activity_started replay requires a command identity");
      const activity = activityInstanceSchema.parse({
        id: event.payload.activityInstanceId,
        actionDefinitionId: event.payload.actionDefinitionId,
        actionVersion: event.payload.actionVersion,
        actorIds: event.actorIds,
        zoneId: event.payload.zoneId,
        phase: "active",
        startedAt: event.payload.startedAt,
        expectedCompleteAt: event.payload.expectedCompleteAt,
        progressFixedPoint: 0,
        claims: event.payload.claims,
        sourceCommandId: event.commandId,
      });
      return sortActivitiesProjection({ ...bumped, activities: [...projection.activities, activity] });
    }
    case "activity_completed":
      return sortActivitiesProjection({
        ...bumped,
        activities: updateActivity(projection, event.payload.activityInstanceId, event.type, (activity) =>
          activityInstanceSchema.parse({ ...activity, phase: "completed", progressFixedPoint: 1_000_000 }),
        ),
      });
    case "activity_cancelled":
      return sortActivitiesProjection({
        ...bumped,
        activities: updateActivity(projection, event.payload.activityInstanceId, event.type, (activity) =>
          activityInstanceSchema.parse({ ...activity, phase: "cancelled" }),
        ),
      });
    case "activity_failed":
      return sortActivitiesProjection({
        ...bumped,
        activities: updateActivity(projection, event.payload.activityInstanceId, event.type, (activity) =>
          activityInstanceSchema.parse({ ...activity, phase: "failed" }),
        ),
      });
    case "activity_interrupted":
      return sortActivitiesProjection({
        ...bumped,
        activities: updateActivity(projection, event.payload.activityInstanceId, event.type, (activity) =>
          activityInstanceSchema.parse({
            ...activity,
            phase: "interrupted",
            progressFixedPoint: event.payload.progressFixedPoint,
          }),
        ),
      });
    case "activity_resumed":
      return sortActivitiesProjection({
        ...bumped,
        activities: updateActivity(projection, event.payload.activityInstanceId, event.type, (activity) =>
          activityInstanceSchema.parse({
            ...activity,
            phase: "active",
            expectedCompleteAt: event.payload.newExpectedCompleteAt,
          }),
        ),
      });
    case "item_transferred":
    case "trigger_scheduled":
    case "journey_planned":
    case "actor_departed":
    case "journey_delayed":
    case "journey_interrupted":
    case "actor_arrived":
    case "journey_abandoned":
    case "commitment_created":
    case "pressure_raised":
    case "commitment_kept":
    case "commitment_late":
    case "commitment_missed":
    case "engagement_opened":
    case "engagement_ended":
    case "engagement_interrupted":
    case "engagement_winding_down":
      // Non-activity families advance the boundary without touching activities.
      return activitiesProjectionSchema.parse(bumped);
  }
}

export interface ActivitiesReplayInput {
  /** Activities are fully evented: a branch-origin seed holds none (plan R3). */
  seed: ActivitiesProjection;
  events: readonly SimulationBranchEvent[];
}

/** Fold one branch's full logical stream into its activities projection. */
export function replayActivitiesHistory(input: ActivitiesReplayInput): ActivitiesProjection {
  const seed = sortActivitiesProjection(activitiesProjectionSchema.parse(input.seed));
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(`Activities replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`);
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applyActivityEvent(projection, event);
    lastSequence = event.sequence;
  }
  return activitiesProjectionSchema.parse({
    ...projection,
    version: seed.version + commandIds.size,
  });
}

/** The empty branch-origin activities seed. */
export function emptyActivitiesSeed(branchId: string, originStorySecond: number): ActivitiesProjection {
  return activitiesProjectionSchema.parse({
    branchId,
    headSequence: 0,
    version: 0,
    storySecond: originStorySecond,
    activities: [],
  });
}
