import { activityInterruptedEventSchema, type ActivityInstance } from "../../contracts/activities";
import { COLLAPSE_SLEEP_SECONDS, COLLAPSE_SOLVE_HORIZON_SECONDS, METER_FIXED_POINT_ONE, bodyCollapsedEventSchema, bodyMeterStateSchema, type BodyCondition, type BodyMeterDefinition, type BodyMeterState, type BodyModifier, type BodyRhythmRow, type ResolveBodyCollapseCommand, type ResolveBodyCollapseRejectionCode, type ScheduledBodyAdjustment } from "../../contracts/bodies";
import type { SimulationBranchEvent } from "../../contracts/branching";
import type { Engagement } from "../../contracts/engagements";
import { composeSimulationId } from "../../contracts/identity";
import { bodyCollapseTriggerKind, type TriggerScheduledEvent } from "../../contracts/scheduler";
import { deriveCircadianPressure } from "../body-reads";
import { buildDepartureInterruptEvent } from "../engagements";
import { buildBodyTrigger, buildSleepConditionTrain, capturedDerivation, eventEnvelope, rejection, type BodyBranchMeta, type BodyEventCommandContext, type BodyRejection } from "./events";
import { compareStableText, integrateMeterValue, type MeterIntegrationView } from "./integration";

export interface CollapseContext {
  rhythmRows: readonly BodyRhythmRow[];
  /**
   * When the actor last actually finished sleeping. Absent means no real
   * sleep history exists — the pressure curve then assumes the rhythm was
   * followed, escalation never accrues, and collapse is unreachable, so
   * alarms arm only for actors whose wakefulness the engine has witnessed.
   */
  lastSleepEndedAtStorySecond?: number;
}

/** The most recent second the actor actually finished sleeping, if any. */
export function lastSleepEndedAtOf(conditions: readonly BodyCondition[]): number | undefined {
  return conditions
    .filter(
      (condition) =>
        condition.key === "asleep" &&
        condition.status === "ended" &&
        condition.endedAtStorySecond !== undefined,
    )
    .reduce<number | undefined>(
      (latest, condition) =>
        latest === undefined || (condition.endedAtStorySecond ?? 0) > latest
          ? condition.endedAtStorySecond
          : latest,
      undefined,
    );
}

/**
 * The collapse solver's context over one actor's loaded condition and rhythm
 * rows — the companion of `buildMeterView` for the collapse half of the body
 * kernel.
 */
export function collapseContextOf(rows: {
  conditions: readonly BodyCondition[];
  rhythms: readonly BodyRhythmRow[];
}): CollapseContext {
  const lastSleepEndedAt = lastSleepEndedAtOf(rows.conditions);
  return {
    rhythmRows: rows.rhythms,
    ...(lastSleepEndedAt === undefined ? {} : { lastSleepEndedAtStorySecond: lastSleepEndedAt }),
  };
}

export interface CollapseCrossing {
  crossesAtStorySecond: number;
  reserveFixedPoint: number;
  pressureFixedPoint: number;
}

function collapseReadAt(
  energyView: MeterIntegrationView,
  context: CollapseContext,
  atStorySecond: number,
): { reserveFixedPoint: number; pressureFixedPoint: number; collapsed: boolean } {
  const reserveFixedPoint = integrateMeterValue(energyView, atStorySecond);
  const pressureFixedPoint = deriveCircadianPressure({
    atStorySecond,
    rhythmRows: context.rhythmRows,
    ...(context.lastSleepEndedAtStorySecond === undefined
      ? {}
      : { lastSleepEndedAtStorySecond: context.lastSleepEndedAtStorySecond }),
  });
  return {
    reserveFixedPoint,
    pressureFixedPoint,
    collapsed: reserveFixedPoint - pressureFixedPoint <= -METER_FIXED_POINT_ONE,
  };
}

/**
 * The first second the energy read saturates its floor: reserve(t) −
 * pressure(t) ≤ −1. Pressure is time-varying (anchors + escalation), so this
 * scans at minute resolution and refines the found minute to its first
 * crossed second — conservative by under a minute at worst, exact at the
 * armed second, and always re-validated at fire time. Emergent: with the
 * reference rhythm this lands near 40 hours awake, from no hardcoded hour.
 */
export function solveCollapseCrossing(input: {
  energyView: MeterIntegrationView;
  context: CollapseContext;
  fromStorySecond: number;
  horizonSeconds?: number;
}): CollapseCrossing | undefined {
  if (input.context.lastSleepEndedAtStorySecond === undefined) return undefined;
  const horizon = input.horizonSeconds ?? COLLAPSE_SOLVE_HORIZON_SECONDS;
  const end = input.fromStorySecond + horizon;
  let previous = input.fromStorySecond;
  for (let at = input.fromStorySecond; at <= end; at += 60) {
    const sample = collapseReadAt(input.energyView, input.context, at);
    if (sample.collapsed) {
      for (let second = at === input.fromStorySecond ? at : previous + 1; second <= at; second += 1) {
        const exact = collapseReadAt(input.energyView, input.context, second);
        if (exact.collapsed) {
          return {
            crossesAtStorySecond: second,
            reserveFixedPoint: exact.reserveFixedPoint,
            pressureFixedPoint: exact.pressureFixedPoint,
          };
        }
      }
    }
    previous = at;
  }
  return undefined;
}

export function bodyCollapseUniquenessKey(actorId: string, armedAtSequence: number): string {
  return composeSimulationId("body-collapse", [actorId, String(armedAtSequence)]);
}

/** Prefix matching every armed collapse alarm for one actor. */
export function bodyCollapseUniquenessKeyPrefix(actorId: string): string {
  return `${composeSimulationId("body-collapse", [actorId])}:`;
}

/** Re-solve one actor's collapse alarm after an energy or sleep material event. */
export function rearmCollapseTrigger(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  actorId: string;
  energyView: MeterIntegrationView;
  context: CollapseContext | undefined;
  sequence: number;
  causationId: string;
  armedAtSequence: number;
}): TriggerScheduledEvent | undefined {
  if (!input.context) return undefined;
  const crossing = solveCollapseCrossing({
    energyView: input.energyView,
    context: input.context,
    fromStorySecond: input.view.storySecond,
  });
  if (!crossing) return undefined;
  return buildBodyTrigger({
    view: input.view,
    command: input.command,
    sequence: input.sequence,
    causationId: input.causationId,
    actorId: input.actorId,
    suffix: "arm-collapse",
    intent: {
      kind: bodyCollapseTriggerKind,
      dueStorySecond: crossing.crossesAtStorySecond,
      uniquenessKey: bodyCollapseUniquenessKey(input.actorId, input.armedAtSequence),
      payload: { actorId: input.actorId, armedAtSequence: input.armedAtSequence },
    },
  });
}

/**
 * E6.3 — re-solve and re-arm one actor's full body-alarm set (each meter's
 * next threshold crossing, plus the collapse alarm when an energy view and
 * context exist) from current law at `view.storySecond`. Used by the LOD
 * assignment when the simulation axis moves and lands at `event` or `exact`:
 * the store retires every prior body alarm unconditionally first (the
 * restock-reconfigure idiom), and this builds the fresh set as the same
 * command's trigger_scheduled events. A meter whose law never crosses a
 * threshold inside the horizon arms nothing, exactly as initialization does.
 */
export interface ResolveBodyCollapseResolutionView extends BodyBranchMeta {
  meter?: BodyMeterState;
  definition?: BodyMeterDefinition;
  modifiers: readonly BodyModifier[];
  scheduledAdjustments?: readonly ScheduledBodyAdjustment[];
  collapseContext?: CollapseContext;
  /** A live asleep condition means the body already got what it demanded. */
  activeAsleep: boolean;
  /** The actor's claim-holding activities, to interrupt (sorted by store). */
  interruptibleActivities: readonly ActivityInstance[];
  /** The actor's open co-present engagements, to interrupt. */
  openEngagements: readonly Engagement[];
  coLocatedActorIds: readonly string[];
}

export interface ResolveBodyCollapseResolution {
  ok: true;
  meter: BodyMeterState;
  condition: BodyCondition;
  modifiers: BodyModifier[];
  interruptedActivityIds: string[];
  interruptedEngagementIds: string[];
  events: SimulationBranchEvent[];
}

export function resolveBodyCollapse(
  view: ResolveBodyCollapseResolutionView,
  command: ResolveBodyCollapseCommand,
): BodyRejection<ResolveBodyCollapseRejectionCode> | ResolveBodyCollapseResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (command.principal.kind !== "system") {
    return rejection("unauthorized_principal", "Bodies give out on the world's clock only.");
  }
  if (!view.meter || !view.definition) {
    return rejection("body_not_initialized", "That body is not tracked.");
  }
  if (view.activeAsleep || !view.collapseContext) {
    return rejection("collapse_stale", "That body already found sleep.");
  }
  const energyView: MeterIntegrationView = {
    definition: view.definition,
    state: view.meter,
    modifiers: view.modifiers,
    scheduledAdjustments: view.scheduledAdjustments ?? [],
  };
  const now = collapseReadAt(energyView, view.collapseContext, view.storySecond);
  if (!now.collapsed) {
    // A material event moved the trajectory after arming; its own commit
    // retired this alarm's replay entry and re-armed the live one.
    return rejection("collapse_stale", "That body is no longer at its limit.");
  }
  const observerActorIds = [...new Set(view.coLocatedActorIds)].sort(compareStableText);
  const events: SimulationBranchEvent[] = [];
  let nextSequence = view.headSequence + 1;
  const collapsedEvent = bodyCollapsedEventSchema.parse({
    ...eventEnvelope(view, command, nextSequence, "body-collapsed"),
    type: "body_collapsed",
    actorIds: [command.payload.actorId],
    entityIds: [command.payload.actorId],
    payload: {
      actorId: command.payload.actorId,
      reserveFixedPoint: now.reserveFixedPoint,
      pressureFixedPoint: now.pressureFixedPoint,
      readSignedFixedPoint: Math.max(
        -METER_FIXED_POINT_ONE,
        Math.min(METER_FIXED_POINT_ONE, now.reserveFixedPoint - now.pressureFixedPoint),
      ),
      observerActorIds,
      derived: capturedDerivation(energyView, view.storySecond),
    },
  });
  events.push(collapsedEvent);
  nextSequence += 1;
  // The world does not pause for a body: every held activity and open scene
  // breaks in the same transaction (one body, one physical scene).
  const interruptedActivityIds: string[] = [];
  for (const activity of [...view.interruptibleActivities].sort((a, b) => compareStableText(a.id, b.id))) {
    const total =
      activity.startedAt !== undefined && activity.expectedCompleteAt !== undefined
        ? activity.expectedCompleteAt - activity.startedAt
        : 0;
    const elapsed = activity.startedAt !== undefined ? view.storySecond - activity.startedAt : 0;
    const progressFixedPoint =
      total > 0 ? Math.max(0, Math.min(1_000_000, Math.floor((elapsed * 1_000_000) / total))) : activity.progressFixedPoint;
    events.push(
      activityInterruptedEventSchema.parse({
        ...eventEnvelope(view, command, nextSequence, `interrupt-activity-${activity.id}`),
        type: "activity_interrupted",
        causationId: collapsedEvent.id,
        actorIds: activity.actorIds,
        entityIds: [...new Set<string>([activity.id, ...activity.actorIds])].sort(compareStableText),
        payload: {
          activityInstanceId: activity.id,
          interruptedAt: view.storySecond,
          reason: "collapse",
          progressFixedPoint,
        },
      }),
    );
    interruptedActivityIds.push(activity.id);
    nextSequence += 1;
  }
  const interruptedEngagementIds: string[] = [];
  for (const engagement of [...view.openEngagements].sort((a, b) => compareStableText(a.id, b.id))) {
    events.push(
      buildDepartureInterruptEvent({
        meta: {
          worldId: view.worldId,
          branchId: view.branchId,
          rulesetVersion: view.rulesetVersion,
          headSequence: nextSequence - 1,
          storySecond: view.storySecond,
        },
        command,
        engagement,
        sequence: nextSequence,
        causationId: collapsedEvent.id,
        reason: "participant_collapsed",
      }),
    );
    interruptedEngagementIds.push(engagement.id);
    nextSequence += 1;
  }
  // Collapse IS forced sleep: the asleep condition with its energy suspend,
  // self-expiring after the sleep the body was denied.
  const sleepTrain = buildSleepConditionTrain({
    view,
    command,
    sequence: nextSequence,
    causationId: collapsedEvent.id,
    actorId: command.payload.actorId,
    expiresAtStorySecond: view.storySecond + COLLAPSE_SLEEP_SECONDS,
    observerActorIds,
    energyView,
    valueAtApply: now.reserveFixedPoint,
  });
  events.push(...sleepTrain.events);
  nextSequence = sleepTrain.nextSequence;
  const condition = sleepTrain.condition;
  const suspendModifier = sleepTrain.suspendModifier;
  const meter = bodyMeterStateSchema.parse({
    ...view.meter,
    valueFixedPoint: now.reserveFixedPoint,
    lastIntegratedAtStorySecond: view.storySecond,
  });
  return {
    ok: true,
    meter,
    condition,
    modifiers: [suspendModifier],
    interruptedActivityIds,
    interruptedEngagementIds,
    events,
  };
}
// ---------------------------------------------------------------------------
// Bodies projection: projectors and replay
// ---------------------------------------------------------------------------
