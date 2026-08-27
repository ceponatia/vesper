import type { BodyCondition, BodyMeterState, BodyModifier, BodyRhythmRow } from "../contracts/bodies";
import type { SimulationBranchEvent } from "../contracts/branching";
import { composeSimulationId } from "../contracts/identity";
import type { ActorLodRead } from "../contracts/lod";
import type { SimulationMaterialItem } from "../contracts/materials";
import {
  ROUTINE_MEAL_WEIGHT_FIXED_POINT,
  ROUTINE_SLEEP_OBLIGATION_PENALTY_FIXED_POINT,
  routineCandidateIdSchema,
  routinePolicyDerivationVersion,
  routinePolicyResolvedEventSchema,
  routinePolicyUniquenessKey,
  routineScoredCandidateSchema,
  type RoutinePolicyResolvedEvent,
  type RoutineScoredCandidate,
  type RunRoutinePolicyCommand,
  type RunRoutinePolicyRejectionCode,
} from "../contracts/routine";
import {
  routinePolicyTriggerKind,
  schedulerDerivationVersion,
  triggerScheduledEventSchema,
  type TriggerScheduledEvent,
} from "../contracts/scheduler";
import {
  buildSleepConditionTrain,
  deriveBodyConditionId,
  integrateMeterValue,
  type MeterIntegrationView,
} from "./bodies";
import { deriveCircadianPressure, resolveSleepWindow, type SleepWindow } from "./body-reads";
import { compareStableText } from "./hash";
import {
  containerAccessAllowed,
  resolveRootLocus,
  type MaterialResolutionView,
} from "./material-locus";
import { buildConsumptionBodyEffects, buildItemConsumedEvent, type ConsumptionBodyView } from "./materials";

/**
 * E6.2 — the pure routine-controller kernel (the no-model tier).
 * Deterministic candidate generation, versioned fixed-point scoring, and the
 * resolved event train — the chosen outcome commits through the ordinary body
 * law (`buildSleepConditionTrain`, the consumption builders), never a
 * special path. No IO, no clock, no model.
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

/** Half-open [start, end) minute-of-day membership, wrapping midnight. */
function minuteInsideWindow(minuteOfDay: number, startMinuteOfDay: number, endMinuteOfDay: number): boolean {
  if (startMinuteOfDay <= endMinuteOfDay) {
    return minuteOfDay >= startMinuteOfDay && minuteOfDay < endMinuteOfDay;
  }
  return minuteOfDay >= startMinuteOfDay || minuteOfDay < endMinuteOfDay;
}

function minuteOfDayAt(storySecond: number): number {
  return Math.floor(storySecond / 60) % 1_440;
}

/**
 * Whether the second falls inside the actor's sleep window (half-open at the
 * wake edge, wrapping midnight). A routine candidate is DUE only inside its
 * own window — the same law meals follow — so a midday boundary can never
 * turn a hold into a nap off the always-positive daytime circadian floor;
 * forced daytime sleep belongs to the collapse law alone.
 */
export function insideSleepWindow(window: SleepWindow, atStorySecond: number): boolean {
  return minuteInsideWindow(minuteOfDayAt(atStorySecond), window.startMinuteOfDay, window.endMinuteOfDay);
}

/**
 * The authored meal window covering this second, or undefined. Overlapping
 * windows resolve deterministically to the earliest (start, end) pair. The
 * alarm fires at a window's start, but membership is what scores `eat_meal`
 * at fire time — a drain that arrives late simply finds the window closed
 * and the meal scores 0, no staleness code needed.
 */
export function mealWindowCovering(
  rhythmRows: readonly BodyRhythmRow[],
  atStorySecond: number,
): BodyRhythmRow | undefined {
  const minuteOfDay = minuteOfDayAt(atStorySecond);
  return rhythmRows
    .filter((row) => row.kind === "meal")
    .sort(
      (left, right) =>
        left.startMinuteOfDay - right.startMinuteOfDay || left.endMinuteOfDay - right.endMinuteOfDay,
    )
    .find((row) => minuteInsideWindow(minuteOfDay, row.startMinuteOfDay, row.endMinuteOfDay));
}

/**
 * The actor's next routine boundary strictly after `afterSecond`: the sleep
 * window's start (bedtime) or any meal window's start, whichever comes
 * first. This is the one due-time law both the E6.1 LOD-assignment arm and
 * every resolution's re-arm compute, so the alarm and the scorer can never
 * disagree about what a boundary is.
 */
export function nextRoutineBoundarySecond(
  rhythmRows: readonly BodyRhythmRow[],
  afterSecond: number,
): number {
  let next = nextBedtimeSecond(resolveSleepWindow(rhythmRows), afterSecond);
  for (const row of rhythmRows) {
    if (row.kind !== "meal") continue;
    next = Math.min(next, nextMinuteOfDayCrossingSecond(afterSecond, row.startMinuteOfDay));
  }
  return next;
}

// ---------------------------------------------------------------------------
// Meal item selection (E6.2 slice 2)
// ---------------------------------------------------------------------------

/**
 * The `consume_item` selection law adapted to the routine meal: eligible items
 * are extant, carry at least one authored `meal`-source consumption effect, are
 * unowned or the actor's own (a background routine never eats against
 * ownership), are unreserved, sit outside any container the actor cannot open
 * (fail-closed), and root-locate at the actor (held/worn or a container chain
 * rooted there) or the actor's own zone. Actor-rooted items sort before
 * zone-rooted ones; lexicographic item id breaks ties within each group — the
 * first survivor is the meal.
 */
export function selectRoutineMealItem(
  view: MaterialResolutionView,
  candidateItemIds: readonly string[],
  actorId: string,
): SimulationMaterialItem | undefined {
  const zoneId = view.actorZoneId(actorId);
  const actorRooted: SimulationMaterialItem[] = [];
  const zoneRooted: SimulationMaterialItem[] = [];
  for (const itemId of candidateItemIds) {
    const item = view.itemById(itemId);
    if (!item || item.locus.kind === "gone") continue;
    if (!item.consumptionEffects?.some((effect) => effect.sourceKind === "meal")) continue;
    if (item.ownerActorId !== null && item.ownerActorId !== actorId) continue;
    if (view.reservingActivityId(itemId) !== null) continue;
    if (item.locus.kind === "container" && !containerAccessAllowed(view, item.locus.containerItemId, actorId)) {
      continue;
    }
    const root = resolveRootLocus(item.locus, view.itemById);
    if (root.kind === "actor" && root.actorId === actorId) {
      actorRooted.push(item);
    } else if (root.kind === "zone" && zoneId !== null && root.zoneId === zoneId) {
      zoneRooted.push(item);
    }
  }
  const byItemId = (left: SimulationMaterialItem, right: SimulationMaterialItem): number =>
    compareStableText(left.id, right.id);
  actorRooted.sort(byItemId);
  zoneRooted.sort(byItemId);
  return actorRooted[0] ?? zoneRooted[0];
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
  /** The actor's effective LOD read at fire time — captured on the decision event. */
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
  /**
   * E6.2 slice 2: material facts for the `eat_meal` candidate, loaded by the
   * store only when a meal window covers the fire second (both sides compute
   * membership through the same `mealWindowCovering`, so they cannot
   * disagree). Absent facts fail closed — inside a window with no view the
   * candidate is illegal `no_eligible_item`, never a throw.
   */
  materialView?: MaterialResolutionView;
  materialItemIds?: readonly string[];
  consumptionBodyView?: ConsumptionBodyView;
}

export interface RunRoutinePolicyResolution {
  ok: true;
  chosenCandidateId: RoutineScoredCandidate["id"];
  events: SimulationBranchEvent[];
  /** Present exactly when begin_sleep was chosen. */
  condition?: BodyCondition;
  suspendModifier?: BodyModifier;
  meter?: BodyMeterState;
  /** Present exactly when eat_meal was chosen: the item the train consumed. */
  consumedItemId?: string;
  /** Meter rows to upsert, aligned 1:1 with the train's body_source_applied events. */
  meterUpdates?: BodyMeterState[];
}

/**
 * Candidate generation and scoring for the v2 routine boundary: `begin_sleep`
 * scores the actor's own circadian pressure minus the obligation penalty when a
 * live obligation falls inside the would-be sleep; `eat_meal` scores the meal
 * weight inside one of the actor's authored meal windows (0 outside); `hold`
 * scores 0. The vocabulary order is the tie order — a later candidate must
 * STRICTLY outscore the running winner, so every tie falls back toward `hold`
 * (the no-change fallback). The deliberator is never consulted here — routine
 * choices are the no-model tier by definition.
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

  const actorId = command.payload.actorId;
  const window = resolveSleepWindow(view.rhythmRows);
  const wakeSecond = nextWakeSecond(window, view.storySecond);

  const clampScore = (value: number): number => Math.max(-1_000_000, Math.min(1_000_000, value));
  // The busy gates, shared by both non-hold candidates in fixed order:
  // an actor mid-activity or mid-scene neither sleeps nor eats by routine.
  const busyIllegalReason =
    view.claimHoldingActivityCount > 0
      ? ("holding_claims" as const)
      : view.openEngagementCount > 0
        ? ("in_engagement" as const)
        : undefined;
  const obligationInsideSleep = view.openPressureActBySeconds.some(
    (actBy) => actBy > view.storySecond && actBy <= wakeSecond,
  );
  // begin_sleep is due only inside the actor's own sleep window (the same
  // law meals follow); outside it scores 0 and every tie keeps hold.
  const sleepScore = insideSleepWindow(window, view.storySecond)
    ? clampScore(
        deriveCircadianPressure({
          atStorySecond: view.storySecond,
          rhythmRows: view.rhythmRows,
          ...(view.lastSleepEndedAtStorySecond === undefined
            ? {}
            : { lastSleepEndedAtStorySecond: view.lastSleepEndedAtStorySecond }),
        }) - (obligationInsideSleep ? ROUTINE_SLEEP_OBLIGATION_PENALTY_FIXED_POINT : 0),
      )
    : 0;

  // eat_meal: due inside an authored meal window; the item is a legality
  // fact, not a score term. Eating is instantaneous — one command, one atomic
  // record — so the sleep obligation penalty never applies to it.
  const coveringMealWindow = mealWindowCovering(view.rhythmRows, view.storySecond);
  const mealItem =
    coveringMealWindow !== undefined &&
    busyIllegalReason === undefined &&
    view.materialView !== undefined &&
    view.materialItemIds !== undefined
      ? selectRoutineMealItem(view.materialView, view.materialItemIds, actorId)
      : undefined;
  const eatIllegalReason =
    busyIllegalReason ??
    (coveringMealWindow !== undefined && mealItem === undefined ? ("no_eligible_item" as const) : undefined);
  const eatScore = coveringMealWindow === undefined ? 0 : ROUTINE_MEAL_WEIGHT_FIXED_POINT;

  const candidates: RoutineScoredCandidate[] = [
    routineScoredCandidateSchema.parse({
      id: routineCandidateIdSchema.parse("begin_sleep"),
      scoreFixedPoint: sleepScore,
      legal: busyIllegalReason === undefined,
      ...(busyIllegalReason === undefined ? {} : { illegalReason: busyIllegalReason }),
    }),
    routineScoredCandidateSchema.parse({
      id: routineCandidateIdSchema.parse("eat_meal"),
      scoreFixedPoint: eatScore,
      legal: eatIllegalReason === undefined,
      ...(eatIllegalReason === undefined ? {} : { illegalReason: eatIllegalReason }),
    }),
    routineScoredCandidateSchema.parse({
      id: routineCandidateIdSchema.parse("hold"),
      scoreFixedPoint: 0,
      legal: true,
    }),
  ];
  const holdCandidate = candidates.at(-1);
  if (!holdCandidate) throw new Error("Routine candidate set is incomplete");
  let chosen = holdCandidate;
  for (const candidate of candidates) {
    if (candidate.id === "hold") continue;
    if (candidate.legal && candidate.scoreFixedPoint > chosen.scoreFixedPoint) chosen = candidate;
  }
  const chosenCandidateId = chosen.id;

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
    actorIds: [actorId],
    entityIds: [actorId],
    payload: {
      actorId,
      chosenCandidateId,
      candidates,
      weightsVersion: routinePolicyDerivationVersion,
      lodSimulation: view.lod.simulationLod,
      ...(chosenCandidateId === "begin_sleep"
        ? { sleep: { conditionId: sleepConditionId, expiresAtStorySecond: wakeSecond } }
        : {}),
      ...(chosenCandidateId === "eat_meal" && mealItem !== undefined
        ? { meal: { itemId: mealItem.id } }
        : {}),
    },
  });
  events.push(decisionEvent);
  nextSequence += 1;

  let condition: BodyCondition | undefined;
  let suspendModifier: BodyModifier | undefined;
  let meter: BodyMeterState | undefined;
  let consumedItemId: string | undefined;
  let meterUpdates: BodyMeterState[] | undefined;
  if (chosenCandidateId === "begin_sleep") {
    const valueAtApply = integrateMeterValue(view.energyView, view.storySecond);
    const train = buildSleepConditionTrain({
      view,
      command,
      sequence: nextSequence,
      causationId: decisionEvent.id,
      actorId,
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
  } else if (chosenCandidateId === "eat_meal" && mealItem !== undefined && view.materialView !== undefined) {
    // The consumption train, byte-identical to what `consume_item`
    // records: one item_consumed causation-chained to the decision, then the
    // item's authored body effects through the shared builders.
    const locationId = view.materialView.actorLocationId(actorId);
    const consumedEvent = buildItemConsumedEvent({
      worldId: view.worldId,
      branchId: view.branchId,
      rulesetVersion: view.rulesetVersion,
      storySecond: view.storySecond,
      sequence: nextSequence,
      command,
      actorId,
      itemId: mealItem.id,
      fromLocus: mealItem.locus,
      againstOwnership: false,
      ...(locationId === null ? {} : { locationId }),
      causationId: decisionEvent.id,
    });
    events.push(consumedEvent);
    nextSequence += 1;
    const effects = buildConsumptionBodyEffects({
      view,
      command,
      actorId,
      consumptionEffects: mealItem.consumptionEffects ?? [],
      causationEventId: consumedEvent.id,
      startSequence: nextSequence,
      bodyView: view.consumptionBodyView,
    });
    events.push(...effects.events);
    nextSequence = effects.nextSequence;
    consumedItemId = mealItem.id;
    meterUpdates = effects.meterUpdates;
  }

  // Re-arm the next routine boundary (bedtime or a meal start) regardless of
  // the choice: after the sleep just begun (its own expiry handles waking,
  // and a meal window starting mid-sleep is deliberately skipped — asleep
  // actors don't eat), or — for an eat or a hold — after now, so a skipped
  // boundary self-heals at the next one.
  const rearmAfterSecond = chosenCandidateId === "begin_sleep" ? wakeSecond : view.storySecond;
  events.push(
    buildRoutinePolicyTrigger({
      view,
      command,
      sequence: nextSequence,
      causationId: decisionEvent.id,
      actorId,
      suffix: "arm-routine-policy",
      dueStorySecond: nextRoutineBoundarySecond(view.rhythmRows, rearmAfterSecond),
    }),
  );

  return {
    ok: true,
    chosenCandidateId,
    events,
    ...(condition === undefined ? {} : { condition }),
    ...(suspendModifier === undefined ? {} : { suspendModifier }),
    ...(meter === undefined ? {} : { meter }),
    ...(consumedItemId === undefined ? {} : { consumedItemId }),
    ...(meterUpdates === undefined ? {} : { meterUpdates }),
  };
}
