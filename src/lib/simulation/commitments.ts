import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import {
  commitmentCreatedEventSchema,
  commitmentKeptEventSchema,
  commitmentLateEventSchema,
  commitmentMissedEventSchema,
  commitmentSchema,
  commitmentStatusTransitions,
  commitmentsProjectionSchema,
  deriveCommitmentTimes,
  derivePressureSeverity,
  pressureRaisedEventSchema,
  temporalPressureSchema,
  type Commitment,
  type CommitmentCreatedEvent,
  type CommitmentKeptEvent,
  type CommitmentLateEvent,
  type CommitmentMissedEvent,
  type CommitmentStatus,
  type CommitmentsProjection,
  type CreateCommitmentCommand,
  type CreateCommitmentRejectionCode,
  type PressureRaisedEvent,
  type RaisePressureCommand,
  type RaisePressureRejectionCode,
  type ResolveCommitmentDeadlineCommand,
  type ResolveDeadlineRejectionCode,
  type TemporalPressure,
} from "@/contracts/simulation/commitments";
import { composeSimulationId } from "@/contracts/simulation/identity";
import {
  commitmentDeadlineTriggerKind,
  commitmentNoticeTriggerKind,
  schedulerDerivationVersion,
  triggerScheduledEventSchema,
  type TriggerScheduledEvent,
} from "@/contracts/simulation/scheduler";
import { planRoute, type SpaceTopology } from "./space";
import type { Journey, PhysicalLocus } from "@/contracts/simulation/space";

/**
 * E3.3 pure commitment kernel: creation with captured §15.2 derivation,
 * fire-time pressure raising gated on knowledge availability, and the
 * deterministic deadline evaluator (ruling 6 — rules, no model call). The
 * deadline only *evaluates* the actor's actual locus; it never moves anyone
 * (spec §3.1 invariant 5).
 */

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStableText);
}

export function deriveCommitmentId(branchId: string, commandId: string): string {
  return composeSimulationId("commitment", [branchId, commandId]);
}

export function derivePressureId(commitmentId: string): string {
  return composeSimulationId("pressure", [commitmentId]);
}

export function commitmentNoticeUniquenessKey(commitmentId: string): string {
  return composeSimulationId("commitment-notice", [commitmentId]);
}

export function commitmentDeadlineUniquenessKey(commitmentId: string): string {
  return composeSimulationId("commitment-deadline", [commitmentId]);
}

function assertCommitmentTransition(from: CommitmentStatus, to: CommitmentStatus, id: string): void {
  if (!commitmentStatusTransitions[from].includes(to)) {
    throw new Error(`Illegal commitment transition ${from} → ${to} for ${id}`);
  }
}

/** Statuses the notice and deadline evaluators treat as still open. */
const openCommitmentStatuses: readonly CommitmentStatus[] = [
  "planned",
  "noticed",
  "accepted",
  "in_progress",
];

// ---------------------------------------------------------------------------
// CreateCommitment resolution (engine.spec §15.1–15.2)
// ---------------------------------------------------------------------------

interface CommitmentBranchMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

export interface CreateCommitmentResolutionView extends CommitmentBranchMeta {
  actorExists: boolean;
  /**
   * The zone route derivation starts from: the actor's current zone, or their
   * active journey's destination when in transit (they will be there when the
   * pressure matters). Recomputation on material change is E3.4's arbiter.
   */
  originZoneId?: string;
  destinationZoneExists: boolean;
  topology: SpaceTopology;
}

interface CreateRejection {
  ok: false;
  code: CreateCommitmentRejectionCode;
  publicReason: string;
}

export interface CreateCommitmentResolution {
  ok: true;
  commitment: Commitment;
  events: [CommitmentCreatedEvent, TriggerScheduledEvent, TriggerScheduledEvent];
}

function createRejection(code: CreateCommitmentRejectionCode, publicReason: string): CreateRejection {
  return { ok: false, code, publicReason };
}

function buildCommitmentTrigger(input: {
  view: CommitmentBranchMeta;
  command: CreateCommitmentCommand;
  sequence: number;
  causationId: string;
  kind: typeof commitmentNoticeTriggerKind | typeof commitmentDeadlineTriggerKind;
  dueStorySecond: number;
  uniquenessKey: string;
  commitmentId: string;
  suffix: string;
  commandType: "raise_pressure" | "resolve_commitment_deadline";
}): TriggerScheduledEvent {
  const templateId = composeSimulationId("template", [input.uniquenessKey]);
  return triggerScheduledEventSchema.parse({
    id: composeSimulationId("event", [input.view.branchId, input.command.id, input.suffix]),
    worldId: input.view.worldId,
    branchId: input.view.branchId,
    sequence: input.sequence,
    storySecond: input.view.storySecond,
    type: "trigger_scheduled",
    schemaVersion: 1,
    rulesetVersion: input.view.rulesetVersion,
    derivationVersion: schedulerDerivationVersion,
    commandId: input.command.id,
    causationId: input.causationId,
    correlationId: input.command.correlationId,
    actorIds: [input.command.payload.actorId],
    entityIds: [input.commitmentId],
    recordedAtWallClock: input.command.submittedAtWallClock,
    payload: {
      kind: input.kind,
      triggerSchemaVersion: 1,
      dueStorySecond: input.dueStorySecond,
      priority: 0,
      uniquenessKey: input.uniquenessKey,
      command: {
        id: templateId,
        branchId: input.view.branchId,
        expectedVersion: 0,
        idempotencyKey: templateId,
        principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] },
        submittedAtWallClock: input.command.submittedAtWallClock,
        correlationId: input.command.correlationId,
        type: input.commandType,
        schemaVersion: 1,
        payload: { commitmentId: input.commitmentId },
      },
    },
  });
}

/** Pure CreateCommitment resolver over a lock-consistent authority view. */
export function resolveCreateCommitment(
  view: CreateCommitmentResolutionView,
  command: CreateCommitmentCommand,
): CreateRejection | CreateCommitmentResolution {
  if (command.branchId !== view.branchId) {
    return createRejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!view.actorExists) return createRejection("actor_not_found", "That actor is unavailable.");
  const principal = command.principal;
  // Players and NPC policy speak only for controlled actors; system and
  // director principals may schedule obligations for anyone (spec §7).
  if (
    (principal.kind === "player" || principal.kind === "npc_policy" || principal.kind === "npc_deliberator") &&
    !principal.controlledActorIds.includes(command.payload.actorId)
  ) {
    return createRejection("unauthorized_actor", "You cannot commit that actor.");
  }
  if (!view.destinationZoneExists) {
    return createRejection("destination_not_found", "That destination is unknown.");
  }
  if (command.payload.window.latestArrival <= view.storySecond) {
    return createRejection("window_in_past", "That obligation is already over.");
  }
  const originZoneId = view.originZoneId;
  if (!originZoneId) throw new Error(`Actor ${command.payload.actorId} has no origin zone for derivation`);

  // Route assumption at creation time (spec §15.2). Unreachable or same-zone
  // destinations derive as zero travel — conservative, and recomputation on
  // material change is E3.4's concern.
  let minimumRouteDurationSeconds = 0;
  if (originZoneId !== command.payload.destinationZoneId) {
    const plan = planRoute(view.topology, {
      originZoneId,
      destinationZoneId: command.payload.destinationZoneId,
      travelMode: "walk",
    });
    if (plan.ok) minimumRouteDurationSeconds = plan.route.minimumDurationSeconds;
  }

  const derived = deriveCommitmentTimes({
    latestArrival: command.payload.window.latestArrival,
    minimumRouteDurationSeconds,
    preparationSeconds: command.payload.preparationSeconds,
    reliabilityBufferSeconds: command.payload.reliabilityBufferSeconds,
    noticeLeadSeconds: command.payload.noticeLeadSeconds,
  });

  const commitmentId = deriveCommitmentId(view.branchId, command.id);
  const createdEvent = commitmentCreatedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "commitment-created"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    type: "commitment_created",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: "gate3-route-v1",
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: [command.payload.actorId],
    entityIds: sortedUnique([command.payload.actorId, commitmentId, command.payload.destinationZoneId]),
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      commitmentId,
      actorId: command.payload.actorId,
      kind: command.payload.kind,
      destinationZoneId: command.payload.destinationZoneId,
      window: command.payload.window,
      ...(command.payload.expectedDurationSeconds === undefined
        ? {}
        : { expectedDurationSeconds: command.payload.expectedDurationSeconds }),
      priority: command.payload.priority,
      flexibility: command.payload.flexibility,
      preparationSeconds: command.payload.preparationSeconds,
      reliabilityBufferSeconds: command.payload.reliabilityBufferSeconds,
      noticeLeadSeconds: command.payload.noticeLeadSeconds,
      knowledgeSource: command.payload.knowledgeSource,
      derived: { ...derived, minimumRouteDurationSeconds },
    },
  });

  // The notice may already be due (a tight window); the drain fires it on the
  // next advance. Clamping to the current second keeps the queue ordered.
  const noticeDue = Math.max(derived.noticeAt, view.storySecond);
  const noticeTrigger = buildCommitmentTrigger({
    view,
    command,
    sequence: view.headSequence + 2,
    causationId: createdEvent.id,
    kind: commitmentNoticeTriggerKind,
    dueStorySecond: noticeDue,
    uniquenessKey: commitmentNoticeUniquenessKey(commitmentId),
    commitmentId,
    suffix: "notice-trigger",
    commandType: "raise_pressure",
  });
  const deadlineTrigger = buildCommitmentTrigger({
    view,
    command,
    sequence: view.headSequence + 3,
    causationId: createdEvent.id,
    kind: commitmentDeadlineTriggerKind,
    dueStorySecond: command.payload.window.latestArrival,
    uniquenessKey: commitmentDeadlineUniquenessKey(commitmentId),
    commitmentId,
    suffix: "deadline-trigger",
    commandType: "resolve_commitment_deadline",
  });

  const commitment = commitmentSchema.parse({
    id: commitmentId,
    actorId: command.payload.actorId,
    kind: command.payload.kind,
    destinationZoneId: command.payload.destinationZoneId,
    window: command.payload.window,
    ...(command.payload.expectedDurationSeconds === undefined
      ? {}
      : { expectedDurationSeconds: command.payload.expectedDurationSeconds }),
    priority: command.payload.priority,
    flexibility: command.payload.flexibility,
    preparationSeconds: command.payload.preparationSeconds,
    reliabilityBufferSeconds: command.payload.reliabilityBufferSeconds,
    noticeLeadSeconds: command.payload.noticeLeadSeconds,
    status: "planned",
    knowledgeSource: command.payload.knowledgeSource,
    sourceCommandId: command.id,
  });

  return { ok: true, commitment, events: [createdEvent, noticeTrigger, deadlineTrigger] };
}

// ---------------------------------------------------------------------------
// RaisePressure resolution (engine.spec §15.2, §9.3)
// ---------------------------------------------------------------------------

export interface RaisePressureResolutionView extends CommitmentBranchMeta {
  commitment?: Commitment;
  /** The actor's zone at fire time (journey destination when in transit). */
  originZoneId?: string;
  topology: SpaceTopology;
  /**
   * Whether the actor actually holds the commitment's non-authored knowledge
   * source: a §20 observation of the named event (`observed`, E4.1), a live
   * belief in the named assertion (`asserted`, E4.2), or the named belief row
   * itself, live and their own (`believed`, E4.2). The store resolves the
   * lookup per kind; absent means not looked up — the gate fails closed
   * (§3.3: a pressure is salient only if the actor can know).
   */
  knowledgeSourceHeld?: boolean;
}

interface RaiseRejection {
  ok: false;
  code: RaisePressureRejectionCode;
  publicReason: string;
}

export interface RaisePressureResolution {
  ok: true;
  commitment: Commitment;
  pressure: TemporalPressure;
  event: PressureRaisedEvent;
}

function raiseRejection(code: RaisePressureRejectionCode, publicReason: string): RaiseRejection {
  return { ok: false, code, publicReason };
}

/** Pure fire-time pressure resolver. A pressure is salient only if the actor can know (§3.3). */
export function resolveRaisePressure(
  view: RaisePressureResolutionView,
  command: RaisePressureCommand,
): RaiseRejection | RaisePressureResolution {
  if (command.branchId !== view.branchId) {
    return raiseRejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (command.principal.kind !== "system") {
    return raiseRejection("unauthorized_principal", "Pressure resolves mechanically, not by request.");
  }
  const commitment = view.commitment;
  if (!commitment) return raiseRejection("commitment_not_found", "That obligation is unknown.");
  if (commitment.status !== "planned") {
    return raiseRejection("commitment_not_open", "That obligation is no longer awaiting notice.");
  }
  // The knowledge gate (§15.1): authored setup is deemed known; every other
  // source requires the actor to genuinely hold it — an E4.1 observation of
  // the named event, or an E4.2 live belief in the named assertion or the
  // named belief row. All of them fail closed.
  switch (commitment.knowledgeSource.kind) {
    case "authored":
      break;
    case "observed":
    case "asserted":
    case "believed":
      if (view.knowledgeSourceHeld !== true) {
        return raiseRejection("knowledge_unavailable", "They have no way to know about that obligation.");
      }
      break;
  }

  const originZoneId = view.originZoneId;
  if (!originZoneId) throw new Error(`Actor ${commitment.actorId} has no origin zone for pressure derivation`);

  // Fire-time §15.2 derivation: actBy is latestDeparture from the actor's
  // CURRENT origin — the notice second is a natural recompute point for the
  // route assumption. Unreachable or same-zone destinations derive as zero
  // travel, exactly as at creation; a notice that fires past its own act-by
  // (a too-tight window) clamps forward so ordering still holds.
  let minimumRouteDurationSeconds = 0;
  if (originZoneId !== commitment.destinationZoneId) {
    const plan = planRoute(view.topology, {
      originZoneId,
      destinationZoneId: commitment.destinationZoneId,
      travelMode: "walk",
    });
    if (plan.ok) minimumRouteDurationSeconds = plan.route.minimumDurationSeconds;
  }
  const derived = deriveCommitmentTimes({
    latestArrival: commitment.window.latestArrival,
    minimumRouteDurationSeconds,
    preparationSeconds: commitment.preparationSeconds,
    reliabilityBufferSeconds: commitment.reliabilityBufferSeconds,
    noticeLeadSeconds: commitment.noticeLeadSeconds,
  });
  const times = {
    noticeAt: view.storySecond,
    decideBy: Math.max(view.storySecond, derived.decideBy),
    actBy: Math.max(view.storySecond, derived.actBy),
  };
  const pressureId = derivePressureId(commitment.id);
  const severity = derivePressureSeverity(commitment.flexibility);

  const event = pressureRaisedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "pressure-raised"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    type: "pressure_raised",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: [commitment.actorId],
    entityIds: sortedUnique([commitment.actorId, commitment.id]),
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      commitmentId: commitment.id,
      pressureId,
      actorId: commitment.actorId,
      noticeAt: times.noticeAt,
      decideBy: times.decideBy,
      actBy: times.actBy,
      severity,
    },
  });

  const pressure = temporalPressureSchema.parse({
    id: pressureId,
    actorId: commitment.actorId,
    sourceCommitmentId: commitment.id,
    noticeAt: times.noticeAt,
    decideBy: times.decideBy,
    actBy: times.actBy,
    severity,
  });
  const noticed = commitmentSchema.parse({ ...commitment, status: "noticed" });
  return { ok: true, commitment: noticed, pressure, event };
}

// ---------------------------------------------------------------------------
// Deadline resolution (engine.spec §15.3–15.4, ruling 6)
// ---------------------------------------------------------------------------

export interface CommitmentDeadlineResolutionView extends CommitmentBranchMeta {
  commitment?: Commitment;
  actorLocus?: PhysicalLocus;
  /** The actor's journey when their locus is in transit. */
  actorJourney?: Journey;
}

interface DeadlineRejection {
  ok: false;
  code: ResolveDeadlineRejectionCode;
  publicReason: string;
}

export type CommitmentOutcomeEvent = CommitmentKeptEvent | CommitmentLateEvent | CommitmentMissedEvent;

export interface CommitmentDeadlineResolution {
  ok: true;
  commitment: Commitment;
  outcome: "kept" | "late" | "missed";
  event: CommitmentOutcomeEvent;
}

function deadlineRejection(code: ResolveDeadlineRejectionCode, publicReason: string): DeadlineRejection {
  return { ok: false, code, publicReason };
}

/**
 * The deterministic deadline evaluator: presence at the destination keeps the
 * commitment, an inbound journey makes it late, anything else misses it. It
 * reads where the actor actually is — it never teleports them there.
 */
export function resolveCommitmentDeadline(
  view: CommitmentDeadlineResolutionView,
  command: ResolveCommitmentDeadlineCommand,
): DeadlineRejection | CommitmentDeadlineResolution {
  if (command.branchId !== view.branchId) {
    return deadlineRejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (command.principal.kind !== "system") {
    return deadlineRejection("unauthorized_principal", "Deadlines resolve mechanically, not by request.");
  }
  const commitment = view.commitment;
  if (!commitment) return deadlineRejection("commitment_not_found", "That obligation is unknown.");
  if (!openCommitmentStatuses.includes(commitment.status)) {
    return deadlineRejection("commitment_not_open", "That obligation has already resolved.");
  }
  const locus = view.actorLocus;
  if (!locus) throw new Error(`Actor ${commitment.actorId} has no physical locus`);
  if (view.storySecond < commitment.window.latestArrival) {
    throw new Error(
      `Deadline for ${commitment.id} fired at ${view.storySecond}, before its window ${commitment.window.latestArrival}`,
    );
  }

  let outcome: "kept" | "late" | "missed";
  let evaluation: CommitmentOutcomeEvent["payload"]["evaluation"];
  if (locus.kind === "at" && locus.zoneId === commitment.destinationZoneId) {
    outcome = "kept";
    evaluation = { basis: "at_destination" };
  } else if (
    locus.kind === "in_transit" &&
    view.actorJourney &&
    view.actorJourney.destinationZoneId === commitment.destinationZoneId
  ) {
    outcome = "late";
    evaluation = {
      basis: "en_route",
      journeyId: view.actorJourney.id,
      expectedArrivalAt: view.actorJourney.expectedArrivalAt,
    };
  } else {
    outcome = "missed";
    evaluation = { basis: "absent" };
  }

  const schema =
    outcome === "kept"
      ? commitmentKeptEventSchema
      : outcome === "late"
        ? commitmentLateEventSchema
        : commitmentMissedEventSchema;
  const event = schema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, `commitment-${outcome}`]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    type: `commitment_${outcome}`,
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: [commitment.actorId],
    entityIds: sortedUnique([commitment.actorId, commitment.id, commitment.destinationZoneId]),
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      commitmentId: commitment.id,
      actorId: commitment.actorId,
      resolvedAt: view.storySecond,
      evaluation,
    },
  });

  assertCommitmentTransition(commitment.status, outcome, commitment.id);
  const resolved = commitmentSchema.parse({ ...commitment, status: outcome });
  return { ok: true, commitment: resolved, outcome, event };
}

// ---------------------------------------------------------------------------
// Commitments projection: projectors and replay
// ---------------------------------------------------------------------------

export function sortCommitmentsProjection(projection: CommitmentsProjection): CommitmentsProjection {
  return commitmentsProjectionSchema.parse({
    ...projection,
    commitments: [...projection.commitments].sort((a, b) => compareStableText(a.id, b.id)),
    pressures: [...projection.pressures].sort((a, b) => compareStableText(a.id, b.id)),
  });
}

function updateCommitment(
  projection: CommitmentsProjection,
  commitmentId: string,
  eventType: string,
  nextStatus: CommitmentStatus,
): Commitment[] {
  const existing = projection.commitments.find((candidate) => candidate.id === commitmentId);
  if (!existing) throw new Error(`${eventType} replay references a missing commitment`);
  assertCommitmentTransition(existing.status, nextStatus, existing.id);
  const next = commitmentSchema.parse({ ...existing, status: nextStatus });
  return projection.commitments.map((candidate) => (candidate.id === next.id ? next : candidate));
}

function resolvePressures(
  projection: CommitmentsProjection,
  commitmentId: string,
  resolvedAt: number,
): TemporalPressure[] {
  return projection.pressures.map((pressure) =>
    pressure.sourceCommitmentId === commitmentId && pressure.resolvedAt === undefined
      ? temporalPressureSchema.parse({ ...pressure, resolvedAt })
      : pressure,
  );
}

/** Pure synchronous projector for the commitment event family. */
export function applyCommitmentEvent(
  projection: CommitmentsProjection,
  event: SimulationBranchEvent,
): CommitmentsProjection {
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };
  switch (event.type) {
    case "commitment_created": {
      if (!event.commandId) throw new Error("commitment_created replay requires a command identity");
      const commitment = commitmentSchema.parse({
        id: event.payload.commitmentId,
        actorId: event.payload.actorId,
        kind: event.payload.kind,
        destinationZoneId: event.payload.destinationZoneId,
        window: event.payload.window,
        ...(event.payload.expectedDurationSeconds === undefined
          ? {}
          : { expectedDurationSeconds: event.payload.expectedDurationSeconds }),
        priority: event.payload.priority,
        flexibility: event.payload.flexibility,
        preparationSeconds: event.payload.preparationSeconds,
        reliabilityBufferSeconds: event.payload.reliabilityBufferSeconds,
        noticeLeadSeconds: event.payload.noticeLeadSeconds,
        status: "planned",
        knowledgeSource: event.payload.knowledgeSource,
        sourceCommandId: event.commandId,
      });
      return sortCommitmentsProjection({ ...bumped, commitments: [...projection.commitments, commitment] });
    }
    case "pressure_raised": {
      const pressure = temporalPressureSchema.parse({
        id: event.payload.pressureId,
        actorId: event.payload.actorId,
        sourceCommitmentId: event.payload.commitmentId,
        noticeAt: event.payload.noticeAt,
        decideBy: event.payload.decideBy,
        actBy: event.payload.actBy,
        severity: event.payload.severity,
      });
      return sortCommitmentsProjection({
        ...bumped,
        commitments: updateCommitment(projection, event.payload.commitmentId, event.type, "noticed"),
        pressures: [...projection.pressures, pressure],
      });
    }
    case "commitment_kept":
    case "commitment_late":
    case "commitment_missed": {
      const nextStatus =
        event.type === "commitment_kept" ? "kept" : event.type === "commitment_late" ? "late" : "missed";
      return sortCommitmentsProjection({
        ...bumped,
        commitments: updateCommitment(projection, event.payload.commitmentId, event.type, nextStatus),
        pressures: resolvePressures(projection, event.payload.commitmentId, event.payload.resolvedAt),
      });
    }
    case "item_transferred":
    case "item_destroyed":
    case "item_consumed":
    case "item_ownership_set":
    case "trigger_scheduled":
    case "journey_planned":
    case "actor_departed":
    case "journey_delayed":
    case "journey_interrupted":
    case "actor_arrived":
    case "journey_abandoned":
    case "activity_started":
    case "activity_completed":
    case "activity_cancelled":
    case "activity_failed":
    case "activity_interrupted":
    case "activity_resumed":
    case "engagement_opened":
    case "engagement_ended":
    case "engagement_interrupted":
    case "engagement_winding_down":
    case "zone_entered":
    case "storyteller_relocation":
    case "speech_act_delivered":
    case "disclosure_made":
    case "soft_canon_recorded":
    case "soft_canon_promoted":
    case "soft_canon_demoted":
    case "body_initialized":
    case "body_source_applied":
    case "body_modifier_applied":
    case "body_condition_applied":
    case "body_condition_ended":
    case "body_threshold_crossed":
    case "body_collapsed":
      // Non-commitment families advance the boundary without touching this projection.
      return commitmentsProjectionSchema.parse(bumped);
  }
}

export interface CommitmentsReplayInput {
  /** Commitments are fully evented: a branch-origin seed holds none (plan R3). */
  seed: CommitmentsProjection;
  events: readonly SimulationBranchEvent[];
}

/** Fold one branch's full logical stream into its commitments projection. */
export function replayCommitmentsHistory(input: CommitmentsReplayInput): CommitmentsProjection {
  const seed = sortCommitmentsProjection(commitmentsProjectionSchema.parse(input.seed));
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(`Commitments replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`);
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applyCommitmentEvent(projection, event);
    lastSequence = event.sequence;
  }
  return commitmentsProjectionSchema.parse({
    ...projection,
    version: seed.version + commandIds.size,
  });
}

/** The empty branch-origin commitments seed. */
export function emptyCommitmentsSeed(branchId: string, originStorySecond: number): CommitmentsProjection {
  return commitmentsProjectionSchema.parse({
    branchId,
    headSequence: 0,
    version: 0,
    storySecond: originStorySecond,
    commitments: [],
    pressures: [],
  });
}
