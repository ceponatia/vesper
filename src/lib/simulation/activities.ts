import {
  activitiesProjectionSchema,
  activityCancelledEventSchema,
  activityClaimsConflict,
  activityCompletedEventSchema,
  activityInstanceSchema,
  activityPhaseTransitions,
  activityStartedEventSchema,
  claimHoldingActivityPhases,
  type ActionResourceCost,
  type SimulationActionDefinition,
  type ActivitiesProjection,
  type ActivityCancelledEvent,
  type ActivityClaim,
  type ActivityCompletedEvent,
  type ActivityInstance,
  type ActivityPhase,
  type ActivityStartedEvent,
  activityResumedEventSchema,
  type ActivityResumedEvent,
  type CancelActivityCommand,
  type CancelActivityRejectionCode,
  type ResumeActivityCommand,
  type ResumeActivityRejectionCode,
  type CompleteActivityCommand,
  type CompleteActivityRejectionCode,
  type StartActivityCommand,
  type StartActivityRejectionCode,
} from "@/contracts/simulation/activities";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import { composeSimulationId } from "@/contracts/simulation/identity";
import type { BodyMeterState, BodySourceAppliedEvent } from "@/contracts/simulation/bodies";
import type { ItemConsumedEvent, SimulationMaterialItem } from "@/contracts/simulation/materials";
import type {
  ItemConditionSourceAppliedEvent,
  ItemConditionThresholdCrossedEvent,
} from "@/contracts/simulation/material-condition";
import {
  activityCompletionTriggerKind,
  schedulerDerivationVersion,
  triggerScheduledEventSchema,
  type TriggerScheduledEvent,
} from "@/contracts/simulation/scheduler";
import type { PhysicalLocus } from "@/contracts/simulation/space";
import {
  buildConsumptionBodyEffects,
  buildItemConsumedEvent,
  resolveRootLocus,
  type ConsumptionBodyView,
} from "./materials";
import { buildUseConditionDeltas, type ItemConditionView, type UseConditionDeltaItem } from "./material-condition";

/**
 * E3.2 pure activity kernel: start/complete/cancel resolution, claim
 * arithmetic over the activity set, and the projectors replay uses. No IO, no
 * clock, no ambient randomness (engine.spec §31–32).
 *
 * E5.3 slice 2 (§26.5–26.6) adds resource-cost reservation at start and
 * consume-disposition consumption at completion, both reusing `materials.ts`'s
 * root-locus walk and `buildConsumptionBodyEffects` so the two consumption
 * entry points (`consume_item` and completion) share one code path.
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

/**
 * E5.2 (the carried E3.4 note): a RESUMED completion re-arms under an
 * attempt-versioned key, because the original key's row was retired at
 * interruption and branch-unique keys never resurrect. Length-prefixed parts
 * keep the un-versioned key a true prefix of every versioned one, so the
 * cancel/complete retirement sweep catches both with one starts_with.
 */
export function activityCompletionResumeUniquenessKey(
  activityInstanceId: string,
  armedAtSequence: number,
): string {
  return composeSimulationId("activity-completion", [activityInstanceId, String(armedAtSequence)]);
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
  /**
   * E5.5 slice 2 (§21.4, ruling 16): whether the target has granted §21.4
   * consent coverage for this action's `consent_covered` scope — pre-resolved
   * by the store from the (target → actor) directional ledger slice, exactly
   * like `heldClaims`/`coLocatedActorIds` are already pre-resolved facts
   * rather than live queries. Unused when the definition has no
   * `consent_covered` precondition.
   */
  consentCovered?: boolean;
  /**
   * §26.5 resource-cost eligibility: every extant item id potentially in play
   * for this start (the store may narrow to the definition's requested
   * material kinds, or hand over the whole branch — the resolver still
   * filters by kind, reservation, and root). Unused when the definition has
   * no `resourceCosts`.
   */
  materialItemIds?: readonly string[];
  materialItemById?(itemId: string): SimulationMaterialItem | undefined;
  /** The live activity reserving one item, or null (mirrors `MaterialResolutionView`). */
  reservingActivityId?(itemId: string): string | null;
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

/**
 * Deterministic §26.5 selection for one resource cost: eligible items are
 * extant, matching `materialKindKey`, not already reserved (by this cost's
 * own prior picks or any live activity), and root-locate at either the
 * starting actor (held/worn, or a container chain rooted there) or the
 * actor's own zone. Actor-rooted items sort before zone-rooted ones;
 * lexicographic item id breaks ties within each group. A shortfall is
 * reported, never partially satisfied.
 */
function selectResourceItems(input: {
  cost: ActionResourceCost;
  candidateIds: readonly string[];
  itemById: (itemId: string) => SimulationMaterialItem | undefined;
  reservingActivityId: (itemId: string) => string | null;
  actorId: string;
  zoneId: string;
  alreadySelected: ReadonlySet<string>;
}): { ok: true; selected: string[] } | { ok: false } {
  const actorRooted: string[] = [];
  const zoneRooted: string[] = [];
  for (const itemId of input.candidateIds) {
    if (input.alreadySelected.has(itemId)) continue;
    const item = input.itemById(itemId);
    if (!item || item.locus.kind === "gone") continue;
    if (item.materialKindKey !== input.cost.materialKindKey) continue;
    if (input.reservingActivityId(itemId) !== null) continue;
    const root = resolveRootLocus(item.locus, input.itemById);
    if (root.kind === "actor" && root.actorId === input.actorId) {
      actorRooted.push(itemId);
    } else if (root.kind === "zone" && root.zoneId === input.zoneId) {
      zoneRooted.push(itemId);
    }
  }
  actorRooted.sort(compareStableText);
  zoneRooted.sort(compareStableText);
  const ordered = [...actorRooted, ...zoneRooted];
  if (ordered.length < input.cost.quantity) return { ok: false };
  return { ok: true, selected: ordered.slice(0, input.cost.quantity) };
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
    if (precondition.kind === "consent_covered") {
      const targetActorId = command.payload.targetActorId;
      if (targetActorId === undefined) {
        return startRejection("target_actor_required", "This needs someone else's say-so.");
      }
      if (!view.coLocatedActorIds.includes(targetActorId)) {
        return startRejection("target_not_co_located", "They are not here for that.");
      }
      if (!view.consentCovered) {
        return startRejection("consent_required", "That has not been agreed to.");
      }
    }
  }
  if (activityClaimsConflict(view.heldClaims, definition.requiredClaims)) {
    return startRejection("claim_conflict", "They are already occupied.");
  }

  // §26.5: select and reserve concrete items for every resource cost.
  const materialItemIds = view.materialItemIds ?? [];
  const materialItemById = view.materialItemById ?? (() => undefined);
  const reservingActivityId = view.reservingActivityId ?? (() => null);
  const selectedItemIds = new Set<string>();
  for (const cost of definition.resourceCosts) {
    const selection = selectResourceItems({
      cost,
      candidateIds: materialItemIds,
      itemById: materialItemById,
      reservingActivityId,
      actorId: command.payload.actorId,
      zoneId: zone.id,
      alreadySelected: selectedItemIds,
    });
    if (!selection.ok) {
      return startRejection(
        "material_unavailable",
        `There is not enough ${cost.materialKindKey} within reach.`,
      );
    }
    for (const itemId of selection.selected) selectedItemIds.add(itemId);
  }
  const reservedItemIds = [...selectedItemIds].sort(compareStableText);

  const activityId = deriveActivityId(view.branchId, command.id);
  const actorId = command.payload.actorId;
  const startedAt = view.storySecond;
  const expectedCompleteAt = startedAt + definition.duration.seconds;
  const observerActorIds =
    definition.noticeability === "obvious"
      ? sortedUnique([...view.coLocatedActorIds, actorId])
      : [actorId];

  // E5.5 slice 2: capture the consent grant that let this start pass — the
  // precondition loop above already guaranteed `targetActorId` is defined and
  // coverage held whenever a `consent_covered` precondition is present.
  // `.find()` is safe because `simulationActionDefinitionSchema` rejects any
  // definition with more than one `consent_covered` precondition — one scope
  // per action, by construction.
  const consentPrecondition = definition.preconditions.find(
    (precondition) => precondition.kind === "consent_covered",
  );
  const consentGrant =
    consentPrecondition && command.payload.targetActorId !== undefined
      ? {
          granterActorId: command.payload.targetActorId,
          granteeActorId: actorId,
          scopeKey: consentPrecondition.scopeKey,
        }
      : undefined;

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
      reservedItemIds,
      ...(consentGrant ? { consentGrant } : {}),
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
    reservedItemIds,
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
  /** §26.5–26.6: the captured action's resource costs, threaded from its definition. */
  resourceCosts?: readonly ActionResourceCost[];
  /** Raw item lookup for fire-time re-validation + consumption. Unused when `resourceCosts` is empty. */
  materialItemById?(itemId: string): SimulationMaterialItem | undefined;
  /** The consuming actor's body facts for the §26.6 trailing effects; absent → zero body events. */
  bodyView?: ConsumptionBodyView;
  /** §26.7: a `use`-disposition item's condition state, when it is condition-tracked. */
  itemConditionViewByItemId?(itemId: string): ItemConditionView | undefined;
}

interface CompleteRejection {
  ok: false;
  code: CompleteActivityRejectionCode;
  publicReason: string;
}

export interface CompleteResolution {
  ok: true;
  activity: ActivityInstance;
  events: [
    ActivityCompletedEvent,
    ...(
      | ItemConsumedEvent
      | BodySourceAppliedEvent
      | ItemConditionSourceAppliedEvent
      | ItemConditionThresholdCrossedEvent
      | TriggerScheduledEvent
    )[],
  ];
  /** The §26.6 body meters written by consumed items' authored effects, if any. */
  meterUpdates: BodyMeterState[];
}

function completeRejection(code: CompleteActivityRejectionCode, publicReason: string): CompleteRejection {
  return { ok: false, code, publicReason };
}

/**
 * Pure fire-time completion resolver. Re-validates rather than trusting the
 * schedule, and — §26.5–26.6 — re-validates every reserved item before
 * spending the `consume`-disposition ones: no legal command path can move a
 * reserved item, so a violation here is corruption, not a rejection.
 */
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

  // §26.5 fire-time re-validation: every reserved item must still be legally
  // in the activity's grasp. No legal command path can move a reserved item
  // (transfer/destroy/consume all reject item_reserved), so any failure here
  // is an engine invariant violation, not a rejection.
  const primaryActorId: string | undefined = activity.actorIds[0];
  const materialItemById = view.materialItemById ?? (() => undefined);
  const reservedItems = new Map<string, SimulationMaterialItem>();
  for (const itemId of activity.reservedItemIds) {
    const item = materialItemById(itemId);
    if (!item || item.locus.kind === "gone") {
      throw new Error(`Reserved item ${itemId} is missing or gone at completion of activity ${activity.id}`);
    }
    const root = resolveRootLocus(item.locus, materialItemById);
    const rootOk =
      (root.kind === "actor" && primaryActorId !== undefined && root.actorId === primaryActorId) ||
      (root.kind === "zone" && root.zoneId === activity.zoneId);
    if (!rootOk) {
      throw new Error(`Reserved item ${itemId} no longer root-locates with activity ${activity.id}`);
    }
    reservedItems.set(itemId, item);
  }

  // §26.6: match consume-disposition costs to reserved items by
  // materialKindKey, deterministically (lexicographic item id).
  const consumeCosts = [...(view.resourceCosts ?? [])]
    .filter((cost) => cost.disposition === "consume")
    .sort((a, b) => compareStableText(a.materialKindKey, b.materialKindKey));
  const reservedIdsSorted = [...activity.reservedItemIds].sort(compareStableText);
  const claimed = new Set<string>();
  const consumedIds: string[] = [];
  for (const cost of consumeCosts) {
    let taken = 0;
    for (const itemId of reservedIdsSorted) {
      if (taken >= cost.quantity) break;
      if (claimed.has(itemId)) continue;
      const item = reservedItems.get(itemId);
      if (!item || item.materialKindKey !== cost.materialKindKey) continue;
      claimed.add(itemId);
      consumedIds.push(itemId);
      taken += 1;
    }
    if (taken < cost.quantity) {
      throw new Error(
        `Activity ${activity.id} completed without enough reserved ${cost.materialKindKey} to consume`,
      );
    }
  }
  consumedIds.sort(compareStableText);

  // §26.7: match use-disposition costs carrying authored condition deltas to
  // reserved TRACKED items, the same deterministic materialKindKey matching
  // consume-costs use — but every matched item receives its deltas (use
  // items are never spent away, so there is no "claimed" defense needed
  // against consume-side double counting).
  const useCosts = [...(view.resourceCosts ?? [])]
    .filter((cost) => cost.disposition === "use" && cost.useConditionDeltas.length > 0)
    .sort((a, b) => compareStableText(a.materialKindKey, b.materialKindKey));
  const useConditionItems: UseConditionDeltaItem[] = [];
  if (useCosts.length > 0 && view.itemConditionViewByItemId) {
    const itemConditionViewByItemId = view.itemConditionViewByItemId;
    const useClaimed = new Set<string>();
    for (const cost of useCosts) {
      let taken = 0;
      for (const itemId of reservedIdsSorted) {
        if (taken >= cost.quantity) break;
        if (useClaimed.has(itemId)) continue;
        const item = reservedItems.get(itemId);
        if (!item || item.materialKindKey !== cost.materialKindKey) continue;
        useClaimed.add(itemId);
        taken += 1;
        if (!item.conditionTracked) continue;
        const condition = itemConditionViewByItemId(itemId);
        if (condition) useConditionItems.push({ itemId, condition, deltas: cost.useConditionDeltas });
      }
    }
  }

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
      consumedItemIds: consumedIds,
    },
  });

  // One item_consumed per consumed item, each followed by its own §26.6
  // trailing body effects — causation-chained to THIS event, one running
  // sequence counter (the resolveBodyCollapse precedent).
  const trailing: (
    | ItemConsumedEvent
    | BodySourceAppliedEvent
    | ItemConditionSourceAppliedEvent
    | ItemConditionThresholdCrossedEvent
    | TriggerScheduledEvent
  )[] = [];
  const meterUpdates: BodyMeterState[] = [];
  let nextSequence = event.sequence + 1;
  if (primaryActorId !== undefined) {
    for (const itemId of consumedIds) {
      const item = reservedItems.get(itemId);
      if (!item) throw new Error(`Consumed item ${itemId} vanished from the material view mid-resolution`);
      const againstOwnership = item.ownerActorId !== null && item.ownerActorId !== primaryActorId;
      const consumedEvent = buildItemConsumedEvent({
        worldId: view.worldId,
        branchId: view.branchId,
        rulesetVersion: view.rulesetVersion,
        storySecond: view.storySecond,
        sequence: nextSequence,
        command,
        actorId: primaryActorId,
        itemId,
        fromLocus: item.locus,
        againstOwnership,
        causationId: event.id,
        ...(view.zoneLocationId ? { locationId: view.zoneLocationId } : {}),
      });
      trailing.push(consumedEvent);
      nextSequence = consumedEvent.sequence + 1;

      const bodyResult = buildConsumptionBodyEffects({
        view,
        command,
        actorId: primaryActorId,
        consumptionEffects: item.consumptionEffects ?? [],
        causationEventId: consumedEvent.id,
        startSequence: nextSequence,
        bodyView: view.bodyView,
      });
      trailing.push(...bodyResult.events);
      meterUpdates.push(...bodyResult.meterUpdates);
      nextSequence = bodyResult.nextSequence;
    }
  }

  // §26.7: use-delta events join the events train after consumption events,
  // causation-chained to the activity_completed event itself (there is no
  // per-item intermediate event the way item_consumed is for consumption).
  if (useConditionItems.length > 0) {
    const useResult = buildUseConditionDeltas({
      view,
      command,
      items: useConditionItems,
      causationEventId: event.id,
      startSequence: nextSequence,
      coLocatedActorIds: view.coLocatedActorIds,
    });
    trailing.push(...useResult.events);
    nextSequence = useResult.nextSequence;
  }

  const completed = activityInstanceSchema.parse({
    ...activity,
    phase: "completed",
    progressFixedPoint: 1_000_000,
  });

  return { ok: true, activity: completed, events: [event, ...trailing], meterUpdates };
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
// ResumeActivity resolution (E5.2 — the carried E3.4 re-arm design note)
// ---------------------------------------------------------------------------

export interface ResumeActivityResolutionView extends ActivityBranchMeta {
  activity?: ActivityInstance;
  zoneLocationId?: string;
}

interface ResumeRejection {
  ok: false;
  code: ResumeActivityRejectionCode;
  publicReason: string;
}

export interface ResumeResolution {
  ok: true;
  activity: ActivityInstance;
  events: [ActivityResumedEvent, TriggerScheduledEvent];
}

function resumeRejection(code: ResumeActivityRejectionCode, publicReason: string): ResumeRejection {
  return { ok: false, code, publicReason };
}

/**
 * Pick an interrupted activity back up. The claims never released
 * (interrupted is claim-holding, §16.3), so nothing re-validates them; what
 * DOES change is the completion alarm — retired at interruption, re-armed
 * here under an attempt-versioned uniqueness key at now + remaining, with
 * the window rebased so progress math survives repeated interruptions.
 */
export function resolveResumeActivity(
  view: ResumeActivityResolutionView,
  command: ResumeActivityCommand,
): ResumeRejection | ResumeResolution {
  if (command.branchId !== view.branchId) {
    return resumeRejection("branch_mismatch", "That world branch is unavailable.");
  }
  const activity = view.activity;
  if (!activity) return resumeRejection("activity_not_found", "That activity is unknown.");
  if (activity.phase !== "interrupted") {
    return resumeRejection("activity_not_interrupted", "There is nothing to pick back up.");
  }
  const controlsParticipant = activity.actorIds.some((actorId) =>
    command.principal.controlledActorIds.includes(actorId),
  );
  if (
    command.principal.kind !== "system" &&
    command.principal.kind !== "storyteller" &&
    !controlsParticipant
  ) {
    return resumeRejection("unauthorized_actor", "You cannot resume that for them.");
  }

  const resumedAt = view.storySecond;
  const totalSeconds =
    activity.startedAt !== undefined && activity.expectedCompleteAt !== undefined
      ? activity.expectedCompleteAt - activity.startedAt
      : 0;
  const remainingSeconds =
    totalSeconds > 0
      ? Math.max(
          1,
          Math.ceil((totalSeconds * (1_000_000 - activity.progressFixedPoint)) / 1_000_000),
        )
      : 1;
  const newExpectedCompleteAt = resumedAt + remainingSeconds;

  const resumedEvent = activityResumedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "activity-resumed"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: resumedAt,
    type: "activity_resumed",
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
      resumedAt,
      newExpectedCompleteAt,
    },
  });

  const uniquenessKey = activityCompletionResumeUniquenessKey(activity.id, resumedEvent.sequence);
  const templateId = composeSimulationId("template", [uniquenessKey]);
  const triggerEvent = triggerScheduledEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "completion-trigger"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 2,
    storySecond: resumedAt,
    type: "trigger_scheduled",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: schedulerDerivationVersion,
    commandId: command.id,
    causationId: resumedEvent.id,
    correlationId: command.correlationId,
    actorIds: activity.actorIds,
    entityIds: [activity.id],
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      kind: activityCompletionTriggerKind,
      triggerSchemaVersion: 1,
      dueStorySecond: newExpectedCompleteAt,
      priority: 0,
      uniquenessKey,
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
        payload: { activityInstanceId: activity.id },
      },
    },
  });

  const resumed = activityInstanceSchema.parse({
    ...activity,
    phase: "active",
    expectedCompleteAt: newExpectedCompleteAt,
    ...(totalSeconds > 0 ? { startedAt: newExpectedCompleteAt - totalSeconds } : {}),
  });
  return { ok: true, activity: resumed, events: [resumedEvent, triggerEvent] };
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
        reservedItemIds: event.payload.reservedItemIds,
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
            // Rebase the window so the total span is preserved: a second
            // interruption's progress math sees one consistent [start, end].
            ...(activity.startedAt !== undefined && activity.expectedCompleteAt !== undefined
              ? {
                  startedAt:
                    event.payload.newExpectedCompleteAt -
                    (activity.expectedCompleteAt - activity.startedAt),
                }
              : {}),
          }),
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
    case "body_initialized":
    case "body_source_applied":
    case "body_modifier_applied":
    case "body_condition_applied":
    case "body_condition_ended":
    case "body_threshold_crossed":
    case "body_collapsed":
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
