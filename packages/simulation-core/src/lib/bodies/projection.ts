import { bodiesProjectionSchema, bodyConditionSchema, bodyMeterStateSchema, bodyModifierSchema, type BodiesProjection, type BodyMeterState } from "../../contracts/bodies";
import type { SimulationBranchEvent } from "../../contracts/branching";
import { compareStableText } from "./integration";

export function sortBodiesProjection(projection: BodiesProjection): BodiesProjection {
  return bodiesProjectionSchema.parse({
    ...projection,
    meters: [...projection.meters].sort(
      (left, right) =>
        compareStableText(left.actorId, right.actorId) || compareStableText(left.meterKey, right.meterKey),
    ),
    conditions: [...projection.conditions].sort((left, right) => compareStableText(left.id, right.id)),
    modifiers: [...projection.modifiers].sort((left, right) => compareStableText(left.id, right.id)),
  });
}

function replaceMeter(
  meters: readonly BodyMeterState[],
  actorId: string,
  meterKey: string,
  eventType: string,
  valueFixedPoint: number,
  storySecond: number,
): BodyMeterState[] {
  const existing = meters.find(
    (candidate) => candidate.actorId === actorId && candidate.meterKey === meterKey,
  );
  if (!existing) throw new Error(`${eventType} replay references a missing body meter`);
  const next = bodyMeterStateSchema.parse({
    ...existing,
    valueFixedPoint,
    lastIntegratedAtStorySecond: storySecond,
  });
  return meters.map((candidate) =>
    candidate.actorId === actorId && candidate.meterKey === meterKey ? next : candidate,
  );
}

/** Pure synchronous projector for the body event family. */
export function applyBodyEvent(
  projection: BodiesProjection,
  event: SimulationBranchEvent,
): BodiesProjection {
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };
  switch (event.type) {
    case "body_initialized": {
      const meters = event.payload.meters.map((meter) =>
        bodyMeterStateSchema.parse({
          actorId: event.payload.actorId,
          meterKey: meter.meterKey,
          valueFixedPoint: meter.valueFixedPoint,
          baselineFixedPoint: meter.baselineFixedPoint,
          lastIntegratedAtStorySecond: event.storySecond,
          registryVersion: event.payload.registryVersion,
        }),
      );
      return sortBodiesProjection({ ...bumped, meters: [...projection.meters, ...meters] });
    }
    case "body_source_applied":
      return sortBodiesProjection({
        ...bumped,
        meters: replaceMeter(
          projection.meters,
          event.payload.actorId,
          event.payload.meterKey,
          event.type,
          event.payload.valueAfterFixedPoint,
          event.storySecond,
        ),
      });
    case "body_modifier_applied": {
      const modifier = bodyModifierSchema.parse({
        id: event.payload.modifierId,
        actorId: event.payload.actorId,
        meterKey: event.payload.meterKey,
        operation: event.payload.operation,
        stackingGroup: event.payload.stackingGroup,
        priority: event.payload.priority,
        validFromStorySecond: event.payload.validFromStorySecond,
        ...(event.payload.validUntilStorySecond === undefined
          ? {}
          : { validUntilStorySecond: event.payload.validUntilStorySecond }),
        visibility: event.payload.visibility,
        ...(event.payload.conditionId === undefined ? {} : { conditionId: event.payload.conditionId }),
        sourceEventId: event.payload.conditionId === undefined ? event.id : event.causationId ?? event.id,
      });
      return sortBodiesProjection({
        ...bumped,
        meters: replaceMeter(
          projection.meters,
          event.payload.actorId,
          event.payload.meterKey,
          event.type,
          event.payload.valueAtApplyFixedPoint,
          event.storySecond,
        ),
        modifiers: [...projection.modifiers, modifier],
      });
    }
    case "body_condition_applied": {
      const condition = bodyConditionSchema.parse({
        id: event.payload.conditionId,
        actorId: event.payload.actorId,
        key: event.payload.conditionKey,
        onsetAtStorySecond: event.payload.onsetAtStorySecond,
        ...(event.payload.expiresAtStorySecond === undefined
          ? {}
          : { expiresAtStorySecond: event.payload.expiresAtStorySecond }),
        status: "active",
        sourceEventId: event.id,
      });
      return sortBodiesProjection({ ...bumped, conditions: [...projection.conditions, condition] });
    }
    case "body_condition_ended": {
      const existing = projection.conditions.find((candidate) => candidate.id === event.payload.conditionId);
      if (!existing) throw new Error("body_condition_ended replay references a missing condition");
      const ended = bodyConditionSchema.parse({
        ...existing,
        status: "ended",
        endBasis: event.payload.basis,
        endedAtStorySecond: event.payload.endedAtStorySecond,
      });
      const retiredIds = new Set(event.payload.retiredModifiers.map((retired) => retired.modifierId));
      return sortBodiesProjection({
        ...bumped,
        conditions: projection.conditions.map((candidate) =>
          candidate.id === ended.id ? ended : candidate,
        ),
        modifiers: projection.modifiers.map((modifier) =>
          retiredIds.has(modifier.id)
            ? bodyModifierSchema.parse({
                ...modifier,
                validUntilStorySecond: Math.max(
                  event.payload.endedAtStorySecond,
                  modifier.validFromStorySecond + 1,
                ),
              })
            : modifier,
        ),
      });
    }
    case "body_threshold_crossed":
      return sortBodiesProjection({
        ...bumped,
        meters: replaceMeter(
          projection.meters,
          event.payload.actorId,
          event.payload.meterKey,
          event.type,
          event.payload.valueAtCrossingFixedPoint,
          event.storySecond,
        ),
      });
    case "body_collapsed":
      // The read gave out; the reserve persists at its integrated value and
      // the forced sleep rides the condition/modifier events that follow.
      return sortBodiesProjection({
        ...bumped,
        meters: replaceMeter(
          projection.meters,
          event.payload.actorId,
          "energy",
          event.type,
          event.payload.reserveFixedPoint,
          event.storySecond,
        ),
      });
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
    case "commitment_created":
    case "pressure_raised":
    case "commitment_kept":
    case "commitment_late":
    case "commitment_missed":
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
    case "item_condition_initialized":
    case "item_condition_source_applied":
    case "item_condition_modifier_applied":
    case "item_condition_modifier_ended":
    case "item_condition_threshold_crossed":
    case "household_created":
    case "household_membership_set":
    case "material_lot_initialized":
    case "material_lot_adjusted":
    case "material_lot_transferred":
    case "means_band_set":
    case "household_restock_routine_configured":
    case "item_instantiated_from_promotion":
    case "household_restock_fulfilled":
    case "household_restock_deferred":
    case "relationship_entry_authored":
    case "relationship_change_recorded":
    case "consent_escalation_resolved":
    case "pressure_acknowledged":
    case "actor_lod_assigned":
    case "routine_policy_resolved":
    case "cohort_created":
    case "cohort_adjusted":
    case "actor_materialized_from_aggregate":
      // Non-body families advance the boundary without touching this projection.
      return bodiesProjectionSchema.parse(bumped);
  }
}

export interface BodiesReplayInput {
  /** Bodies are fully evented: a branch-origin seed holds none (R3). */
  seed: BodiesProjection;
  events: readonly SimulationBranchEvent[];
}

/** Fold one branch's full logical stream into its bodies projection. */
export function replayBodiesHistory(input: BodiesReplayInput): BodiesProjection {
  const seed = sortBodiesProjection(bodiesProjectionSchema.parse(input.seed));
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(`Bodies replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`);
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applyBodyEvent(projection, event);
    lastSequence = event.sequence;
  }
  return bodiesProjectionSchema.parse({
    ...projection,
    version: seed.version + commandIds.size,
  });
}

/** The empty branch-origin bodies seed. */
export function emptyBodiesSeed(branchId: string, originStorySecond: number): BodiesProjection {
  return bodiesProjectionSchema.parse({
    branchId,
    headSequence: 0,
    version: 0,
    storySecond: originStorySecond,
    meters: [],
    conditions: [],
    modifiers: [],
  });
}
