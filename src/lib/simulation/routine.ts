import {
  ROUTINE_HOLD_COMMITMENT_WEIGHT_FIXED_POINT,
  routineCandidateIdSchema,
  routinePolicyDerivationVersion,
  routinePolicyResolvedEventSchema,
  routinePolicyUniquenessKey,
  routineScoredCandidateSchema,
  routinePolicyTriggerKind,
  schedulerDerivationVersion,
  triggerScheduledEventSchema,
  composeSimulationId,
  type ActorLodRead,
  type BodyCondition,
  type BodyMeterState,
  type BodyModifier,
  type BodyRhythmRow,
  type RoutinePolicyResolvedEvent,
  type RoutineScoredCandidate,
  type RunRoutinePolicyCommand,
  type RunRoutinePolicyRejectionCode,
  type SimulationBranchEvent,
  type TriggerScheduledEvent,
} from "@/contracts/simulation";
import {
  buildSleepConditionTrain,
  deriveBodyConditionId,
  integrateMeterValue,
  type MeterIntegrationView,
} from "./bodies";
import { deriveCircadianPressure, resolveSleepWindow, type SleepWindow } from "./body-reads";

/**
 * E6.2 — the pure routine-controller kernel (engine.spec §19.1–19.2, §28
 * no-model tier). Deterministic candidate generation, versioned fixed-point
 * scoring, and the resolved event train — the chosen outcome commits through
 * the ordinary body law (`buildSleepConditionTrain`), never a special path.
 * No IO, no clock, no model.
 */

// ---------------------------------------------------------------------------
// Rhythm boundary math
// ---------------------------------------------------------------------------

const SECONDS_PER_DAY = 86_400;

/** The next story second strictly after `afterSecond` at `minuteOfDay`. */
export function nextMinuteOfDayCrossingSecond(afterSecond: number, minuteOfDay: number): number {
  const secondOfDay = minuteOfDay * 60;
  const dayStart = Math.floor(afterSecond / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const candidate = dayStart + secondOfDay;
  return candidate > afterSecond ? candidate : candidate + SECONDS_PER_DAY;
}

/** The actor's next bedtime (sleep window start) strictly after `afterSecond`. */
export function nextBedtimeSecond(window: SleepWindow, afterSecond: number): number {
  return nextMinuteOfDayCrossingSecond(afterSecond, window.startMinuteOfDay);
}

/** The actor's next scheduled wake (sleep window end) strictly after `afterSecond`. */
export function nextWakeSecond(window: SleepWindow, afterSecond: number): number {
  return nextMinuteOfDayCrossingSecond(afterSecond, window.endMinuteOfDay);
}

// ---------------------------------------------------------------------------
// Trigger builder (mirrors bodies.ts's buildBodyTrigger for the routine kind)
// ---------------------------------------------------------------------------

export interface RoutineBranchMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

export interface RoutineEventCommandContext {
  id: string;
  correlationId: string;
  submittedAtWallClock: string;
}

/**
 * Arm one actor's next routine alarm as a trigger_scheduled event — used by
 * the E6.1 LOD assignment (entering `event` LOD) and by every resolution's
 * re-arm. The uniqueness key is sequence-versioned (the E5.4 restock
 * precedent): a re-arm is a distinct alarm, and the prefix retires every
 * arming attempt for the actor regardless of version.
 */
export function buildRoutinePolicyTrigger(input: {
  view: RoutineBranchMeta;
  command: RoutineEventCommandContext;
  sequence: number;
  causationId?: string;
  actorId: string;
  suffix: string;
  dueStorySecond: number;
}): TriggerScheduledEvent {
  const uniquenessKey = routinePolicyUniquenessKey(input.actorId, input.sequence);
  const templateId = composeSimulationId("template", [uniquenessKey]);
  return triggerScheduledEventSchema.parse({
    id: composeSimulationId("event", [input.view.branchId, input.command.id, input.suffix]),
    worldId: input.view.worldId,
    branchId: input.view.branchId,
    sequence: input.sequence,
    storySecond: input.view.storySecond,
    schemaVersion: 1,
    rulesetVersion: input.view.rulesetVersion,
    derivationVersion: schedulerDerivationVersion,
    commandId: input.command.id,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    correlationId: input.command.correlationId,
    recordedAtWallClock: input.command.submittedAtWallClock,
    type: "trigger_scheduled",
    actorIds: [input.actorId],
    entityIds: [input.actorId],
    payload: {
      kind: routinePolicyTriggerKind,
      triggerSchemaVersion: 1,
      dueStorySecond: input.dueStorySecond,
      priority: 0,
      uniquenessKey,
      command: {
        id: templateId,
        branchId: input.view.branchId,
        expectedVersion: 0,
        idempotencyKey: templateId,
        principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] },
        submittedAtWallClock: input.command.submittedAtWallClock,
        correlationId: input.command.correlationId,
        schemaVersion: 1,
        type: "run_routine_policy",
        payload: { actorId: input.actorId, armedAtSequence: input.sequence },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// run_routine_policy resolution
// ---------------------------------------------------------------------------

interface RoutineRejection {
  ok: false;
  code: Extract<
    RunRoutinePolicyRejectionCode,
    "branch_mismatch" | "unauthorized_principal" | "actor_not_found" | "routine_stale"
  >;
  publicReason: string;
}

function rejection(code: RoutineRejection["code"], publicReason: string): RoutineRejection {
  return { ok: false, code, publicReason };
}

export interface RunRoutinePolicyResolutionView extends RoutineBranchMeta {
  actorExists: boolean;
  /** The actor's effective LOD read at fire time (§6.4 capture basis). */
  lod: ActorLodRead;
  rhythmRows: readonly BodyRhythmRow[];
  /** The actor's energy integration view; absent means the body is untracked. */
  energyView?: MeterIntegrationView;
  activeAsleep: boolean;
  /** When the actor last finished sleeping — feeds circadian escalation. */
  lastSleepEndedAtStorySecond?: number;
  claimHoldingActivityCount: number;
  openEngagementCount: number;
  /** actBy seconds of the actor's unresolved temporal pressures. */
  openPressureActBySeconds: readonly number[];
  coLocatedActorIds: readonly string[];
}

export interface RunRoutinePolicyResolution {
  ok: true;
  chosenCandidateId: RoutineScoredCandidate["id"];
  events: SimulationBranchEvent[];
  /** Present exactly when begin_sleep was chosen. */
  condition?: BodyCondition;
  suspendModifier?: BodyModifier;
  meter?: BodyMeterState;
}

/**
 * §19.1/§19.2 for the v1 routine boundary: score `begin_sleep` by the actor's
 * own circadian pressure and `hold` by live obligations falling inside the
 * would-be sleep. Ties keep `hold` (the no-change fallback), so sleep must
 * strictly outrank staying up. The §19.3 deliberator is never consulted here —
 * routine choices are the §28 no-model tier by definition.
 */
export function resolveRunRoutinePolicyFromView(
  view: RunRoutinePolicyResolutionView,
  command: RunRoutinePolicyCommand,
): RoutineRejection | RunRoutinePolicyResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (command.principal.kind !== "system") {
    return rejection("unauthorized_principal", "Routine life runs on the world's clock only.");
  }
  if (!view.actorExists) return rejection("actor_not_found", "That actor is unavailable.");
  if (view.lod.simulationLod !== "event") {
    return rejection("routine_stale", "That actor's routine is no longer engine-driven.");
  }
  if (!view.energyView) {
    return rejection("routine_stale", "That body is not tracked.");
  }
  if (view.activeAsleep) {
    return rejection("routine_stale", "That body already found sleep.");
  }

  const window = resolveSleepWindow(view.rhythmRows);
  const wakeSecond = nextWakeSecond(window, view.storySecond);

  const clampScore = (value: number): number => Math.max(-1_000_000, Math.min(1_000_000, value));
  const sleepIllegalReason =
    view.claimHoldingActivityCount > 0
      ? ("holding_claims" as const)
      : view.openEngagementCount > 0
        ? ("in_engagement" as const)
        : undefined;
  const sleepScore = clampScore(
    deriveCircadianPressure({
      atStorySecond: view.storySecond,
      rhythmRows: view.rhythmRows,
      ...(view.lastSleepEndedAtStorySecond === undefined
        ? {}
        : { lastSleepEndedAtStorySecond: view.lastSleepEndedAtStorySecond }),
    }),
  );
  const obligationInsideSleep = view.openPressureActBySeconds.some(
    (actBy) => actBy > view.storySecond && actBy <= wakeSecond,
  );
  const candidates: RoutineScoredCandidate[] = [
    routineScoredCandidateSchema.parse({
      id: routineCandidateIdSchema.parse("begin_sleep"),
      scoreFixedPoint: sleepScore,
      legal: sleepIllegalReason === undefined,
      ...(sleepIllegalReason === undefined ? {} : { illegalReason: sleepIllegalReason }),
    }),
    routineScoredCandidateSchema.parse({
      id: routineCandidateIdSchema.parse("hold"),
      scoreFixedPoint: obligationInsideSleep ? ROUTINE_HOLD_COMMITMENT_WEIGHT_FIXED_POINT : 0,
      legal: true,
    }),
  ];
  const [sleepCandidate, holdCandidate] = candidates;
  if (!sleepCandidate || !holdCandidate) throw new Error("Routine candidate set is incomplete");
  const chosenCandidateId =
    sleepCandidate.legal && sleepCandidate.scoreFixedPoint > holdCandidate.scoreFixedPoint
      ? sleepCandidate.id
      : holdCandidate.id;

  const events: SimulationBranchEvent[] = [];
  let nextSequence = view.headSequence + 1;
  const sleepConditionId = deriveBodyConditionId(view.branchId, command.id);

  const decisionEvent: RoutinePolicyResolvedEvent = routinePolicyResolvedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "routine-policy"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: nextSequence,
    storySecond: view.storySecond,
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: routinePolicyDerivationVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    recordedAtWallClock: command.submittedAtWallClock,
    type: "routine_policy_resolved",
    actorIds: [command.payload.actorId],
    entityIds: [command.payload.actorId],
    payload: {
      actorId: command.payload.actorId,
      chosenCandidateId,
      candidates,
      weightsVersion: routinePolicyDerivationVersion,
      lodSimulation: view.lod.simulationLod,
      ...(chosenCandidateId === "begin_sleep"
        ? { sleep: { conditionId: sleepConditionId, expiresAtStorySecond: wakeSecond } }
        : {}),
    },
  });
  events.push(decisionEvent);
  nextSequence += 1;

  let condition: BodyCondition | undefined;
  let suspendModifier: BodyModifier | undefined;
  let meter: BodyMeterState | undefined;
  if (chosenCandidateId === "begin_sleep") {
    const valueAtApply = integrateMeterValue(view.energyView, view.storySecond);
    const train = buildSleepConditionTrain({
      view,
      command,
      sequence: nextSequence,
      causationId: decisionEvent.id,
      actorId: command.payload.actorId,
      expiresAtStorySecond: wakeSecond,
      observerActorIds: [...new Set(view.coLocatedActorIds)].sort(),
      energyView: view.energyView,
      valueAtApply,
    });
    events.push(...train.events);
    nextSequence = train.nextSequence;
    condition = train.condition;
    suspendModifier = train.suspendModifier;
    meter = {
      ...view.energyView.state,
      valueFixedPoint: valueAtApply,
      lastIntegratedAtStorySecond: view.storySecond,
    };
  }

  // Re-arm the next routine boundary regardless of the choice: after the
  // sleep just begun (its own expiry handles waking), or — for a hold — at
  // the next bedtime, so a skipped night self-heals a day later.
  const rearmAfterSecond = chosenCandidateId === "begin_sleep" ? wakeSecond : view.storySecond;
  events.push(
    buildRoutinePolicyTrigger({
      view,
      command,
      sequence: nextSequence,
      causationId: decisionEvent.id,
      actorId: command.payload.actorId,
      suffix: "arm-routine-policy",
      dueStorySecond: nextBedtimeSecond(window, rearmAfterSecond),
    }),
  );

  return {
    ok: true,
    chosenCandidateId,
    events,
    ...(condition === undefined ? {} : { condition }),
    ...(suspendModifier === undefined ? {} : { suspendModifier }),
    ...(meter === undefined ? {} : { meter }),
  };
}
