import type { SimulationBranchEvent } from "../contracts/branching";
import { composeSimulationId } from "../contracts/identity";
import {
  itemConsumedEventSchema,
  itemDestroyedEventSchema,
  itemOwnershipSetEventSchema,
  itemTransferredEventSchema,
  materialBranchSeedSchema,
  materialDerivationVersion,
  materialsProjectionSchema,
  type ConsumeItemCommand,
  type ConsumeItemRejectionCode,
  type DestroyItemCommand,
  type DestroyItemRejectionCode,
  type ItemConsumedEvent,
  type ItemConsumptionEffect,
  type ItemDestroyedEvent,
  type ItemLocus,
  type ItemOwnershipSetEvent,
  type ItemTransferredEvent,
  type MaterialsProjection,
  type SetItemOwnershipCommand,
  type SetItemOwnershipRejectionCode,
  type SimulationMaterialItem,
  type TransferItemCommand,
  type TransferItemRejectionCode,
} from "../contracts/materials";
import type { BodyMeterState, BodySourceAppliedEvent } from "../contracts/bodies";
import type {
  ItemConditionModifierAppliedEvent,
  ItemConditionModifierEndedEvent,
} from "../contracts/material-condition";
import type { TriggerScheduledEvent } from "../contracts/scheduler";
import {
  applySourceToMeter,
  type BodyBranchMeta,
  type BodyEventCommandContext,
  type CollapseContext,
  type MeterIntegrationView,
} from "./bodies";
import { compareStableText, sortedUnique } from "./hash";
import { buildWornWindowTransition, type ItemConditionView } from "./material-condition";
import {
  containerAccessAllowed,
  MATERIAL_CHAIN_DEPTH_CAP,
  resolveRootLocus,
  rootZoneId,
  type MaterialResolutionView,
} from "./material-locus";

export {
  containerAccessAllowed,
  MATERIAL_CHAIN_DEPTH_CAP,
  resolveRootLocus,
  rootZoneId,
  type MaterialResolutionView,
  type RootLocus,
} from "./material-locus";

/**
 * E5.3 slice 1 pure material kernel: the transfer / destroy / ownership
 * resolvers over a lock-consistent authority view, the strict-contiguity
 * projector, replay, seed assembly, and the projection invariants. No IO,
 * no clock, no ambient randomness.
 *
 * Slice 2 adds `resolveConsumeItemFromView` and the shared
 * `buildConsumptionBodyEffects` helper `lib/simulation/activities.ts`'s
 * completion-time consumption path reuses — both drive the body kernel through
 * `applySourceToMeter` (`lib/bodies/sources.ts`).
 */

// ---------------------------------------------------------------------------
// Locus helpers
// ---------------------------------------------------------------------------

/** Structural locus equality: the staleness and no-op defenses both need it. */
function lociEqual(left: ItemLocus, right: ItemLocus): boolean {
  switch (left.kind) {
    case "held":
      return right.kind === "held" && left.actorId === right.actorId;
    case "worn":
      return right.kind === "worn" && left.actorId === right.actorId && left.slotKey === right.slotKey;
    case "container":
      return right.kind === "container" && left.containerItemId === right.containerItemId;
    case "zone":
      return right.kind === "zone" && left.zoneId === right.zoneId;
    case "gone":
      return right.kind === "gone" && left.basis === right.basis;
  }
}

/** The registry ids a locus references, for the event envelope's entity set. */
function lociEntityIds(locus: ItemLocus): string[] {
  switch (locus.kind) {
    case "held":
    case "worn":
      return [locus.actorId];
    case "container":
      return [locus.containerItemId];
    case "zone":
      return [locus.zoneId];
    case "gone":
      return [];
  }
}

// ---------------------------------------------------------------------------
// Authority view — MaterialResolutionView, resolveRootLocus, rootZoneId, and
// containerAccessAllowed all live in ./material-locus (see its module doc for
// why: material-condition.ts needs them without a materials.ts import cycle).
// ---------------------------------------------------------------------------

function destinationWellFormed(view: MaterialResolutionView, toLocus: ItemLocus): boolean {
  switch (toLocus.kind) {
    case "held":
    case "worn":
      return view.actorById(toLocus.actorId) !== undefined;
    case "container": {
      const container = view.itemById(toLocus.containerItemId);
      return container !== undefined && container.container !== undefined && container.locus.kind !== "gone";
    }
    case "zone":
      // Root co-location validates the zone is the acting actor's own zone.
      return true;
    case "gone":
      // Refined out at the command schema; defensive only.
      return false;
  }
}

/** Would placing `itemId` into `toLocus` close a containment cycle? */
function destinationWouldCycle(
  itemId: string,
  toLocus: ItemLocus,
  itemById: (itemId: string) => SimulationMaterialItem | undefined,
): boolean {
  if (toLocus.kind !== "container") return false;
  let currentContainerId = toLocus.containerItemId;
  const seen = new Set<string>();
  for (let hops = 0; hops <= MATERIAL_CHAIN_DEPTH_CAP; hops += 1) {
    if (currentContainerId === itemId) return true;
    if (seen.has(currentContainerId)) return false;
    seen.add(currentContainerId);
    const container = itemById(currentContainerId);
    if (!container || container.locus.kind !== "container") return false;
    currentContainerId = container.locus.containerItemId;
  }
  return true;
}

// ---------------------------------------------------------------------------
// TransferItem resolution (the fail-closed validation order)
// ---------------------------------------------------------------------------

interface TransferRejection {
  ok: false;
  code: TransferItemRejectionCode;
  publicReason: string;
}
interface TransferAccepted {
  ok: true;
  /**
   * A worn-ness change on a condition-tracked item trails its worn-window
   * modifier (applied or ended) plus a threshold re-arm — a breaking change
   * from the bare `event` slice 1/2 shipped with (mirrors the `events` array
   * `resolveCompleteActivity` gained in slice 2).
   */
  events: [ItemTransferredEvent, ...(ItemConditionModifierAppliedEvent | ItemConditionModifierEndedEvent | TriggerScheduledEvent)[]];
}
export type TransferItemResolution = TransferRejection | TransferAccepted;

function transferReject(code: TransferItemRejectionCode, publicReason: string): TransferRejection {
  return { ok: false, code, publicReason };
}

/**
 * Pure TransferItem resolver over a lock-consistent authority view.
 * `itemConditionView`, when the moved item is condition-tracked, drives the
 * worn-window transition: donning/doffing trails a
 * `item_condition_modifier_applied`/`_ended` event plus cleanliness's
 * threshold re-arm after the primary `item_transferred` event.
 */
export function resolveTransferItemFromView(
  view: MaterialResolutionView,
  command: TransferItemCommand,
  itemConditionView?: ItemConditionView,
): TransferItemResolution {
  const { actorId, itemId, fromLocus, toLocus } = command.payload;

  // 1. branch
  if (command.branchId !== view.branchId) {
    return transferReject("branch_mismatch", "That world branch is unavailable.");
  }
  // 2. actor existence + control
  if (!view.actorById(actorId)) return transferReject("actor_not_found", "That actor is unavailable.");
  if (!command.principal.controlledActorIds.includes(actorId)) {
    return transferReject("unauthorized_actor", "You cannot direct that actor.");
  }
  // 3. actor embodied at a zone
  const actorZoneId = view.actorZoneId(actorId);
  if (actorZoneId === null) return transferReject("actor_not_embodied", "They are not anywhere they can do that.");
  // 4. item extant + not gone
  const item = view.itemById(itemId);
  if (!item) return transferReject("item_not_found", "That item is unavailable.");
  if (item.locus.kind === "gone") return transferReject("item_gone", "That item is gone.");
  // 5. asserted source matches current truth (staleness defense)
  if (!lociEqual(fromLocus, item.locus)) {
    return transferReject("stale_source", "That item is no longer where you expect it.");
  }
  // 6. destination well-formed
  if (!destinationWellFormed(view, toLocus)) {
    return transferReject("destination_not_found", "That destination is not available.");
  }
  // 7. root co-location — the acting actor's zone must equal both chains' root zone
  const sourceRoot = resolveRootLocus(fromLocus, view.itemById);
  if (sourceRoot.kind === "cycle") return transferReject("container_cycle", "That container arrangement is impossible.");
  const destRoot = resolveRootLocus(toLocus, view.itemById);
  if (destRoot.kind === "cycle") return transferReject("container_cycle", "That container arrangement is impossible.");
  if (rootZoneId(sourceRoot, view) !== actorZoneId) {
    return transferReject("root_not_colocated", "That item is not within reach.");
  }
  if (rootZoneId(destRoot, view) !== actorZoneId) {
    return transferReject("root_not_colocated", "That destination is not within reach.");
  }
  // 8. person-sovereignty — a source chain rooted at ANOTHER actor is off-limits
  if (sourceRoot.kind === "actor" && sourceRoot.actorId !== actorId) {
    return fromLocus.kind === "worn"
      ? transferReject("worn_by_other", "That is worn by someone else.")
      : transferReject("held_by_other", "That is in someone else's keeping.");
  }
  // 9. self-dressing — a worn destination only on the acting actor
  if (toLocus.kind === "worn" && toLocus.actorId !== actorId) {
    return transferReject("not_self_dressing", "They cannot put that on someone else.");
  }
  // 10. container access at both immediate ends
  if (fromLocus.kind === "container" && !containerAccessAllowed(view, fromLocus.containerItemId, actorId)) {
    return transferReject("container_access_denied", "That container is closed to them.");
  }
  if (toLocus.kind === "container" && !containerAccessAllowed(view, toLocus.containerItemId, actorId)) {
    return transferReject("container_access_denied", "That container is closed to them.");
  }
  // 10.5. reservation — only the reserving activity's own machinery may move it
  if (view.reservingActivityId(itemId) !== null) {
    return transferReject("item_reserved", "That is reserved for something else right now.");
  }
  // 11. destination capacity (excluding the item itself when it already sits there)
  if (toLocus.kind === "container") {
    const container = view.itemById(toLocus.containerItemId);
    const capacity = container?.container?.capacityCount ?? 0;
    let occupants = view.containerOccupantCount(toLocus.containerItemId);
    if (item.locus.kind === "container" && item.locus.containerItemId === toLocus.containerItemId) {
      occupants -= 1;
    }
    if (!Number.isSafeInteger(occupants) || occupants < 0) {
      throw new Error("Material authority view has an invalid container occupant count");
    }
    if (occupants >= capacity) return transferReject("destination_full", "There is no room for that.");
  }
  // 12. cycle rejection — placing the item inside its own descendant
  if (destinationWouldCycle(itemId, toLocus, view.itemById)) {
    return transferReject("container_cycle", "An item cannot be put inside itself.");
  }
  // 13. no-op rejection
  if (lociEqual(fromLocus, toLocus)) return transferReject("same_locus", "The item is already there.");

  const againstOwnership = item.ownerActorId !== null && item.ownerActorId !== actorId;
  const locationId = view.actorLocationId(actorId);
  const event = itemTransferredEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "item-transferred"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    type: "item_transferred",
    schemaVersion: 2,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: materialDerivationVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: [actorId],
    entityIds: sortedUnique([actorId, itemId, ...lociEntityIds(fromLocus), ...lociEntityIds(toLocus)]),
    ...(locationId !== null ? { locationId } : {}),
    recordedAtWallClock: command.submittedAtWallClock,
    payload: { actorId, itemId, fromLocus, toLocus, againstOwnership },
  });

  const wornWindow = buildWornWindowTransition({
    view,
    command,
    itemId,
    fromLocus,
    toLocus,
    ...(itemConditionView === undefined ? {} : { condition: itemConditionView }),
    causationId: event.id,
    startSequence: event.sequence + 1,
  });

  return { ok: true, events: [event, ...wornWindow.events] };
}

// ---------------------------------------------------------------------------
// DestroyItem resolution (gone/terminal)
// ---------------------------------------------------------------------------

interface DestroyRejection {
  ok: false;
  code: DestroyItemRejectionCode;
  publicReason: string;
}
interface DestroyAccepted {
  ok: true;
  event: ItemDestroyedEvent;
}
export type DestroyItemResolution = DestroyRejection | DestroyAccepted;

function destroyReject(code: DestroyItemRejectionCode, publicReason: string): DestroyRejection {
  return { ok: false, code, publicReason };
}

/** Pure DestroyItem resolver: the source-side subset of transfer law + item_gone. */
export function resolveDestroyItemFromView(
  view: MaterialResolutionView,
  command: DestroyItemCommand,
): DestroyItemResolution {
  const { actorId, itemId, basis } = command.payload;

  if (command.branchId !== view.branchId) {
    return destroyReject("branch_mismatch", "That world branch is unavailable.");
  }
  if (!view.actorById(actorId)) return destroyReject("actor_not_found", "That actor is unavailable.");
  if (!command.principal.controlledActorIds.includes(actorId)) {
    return destroyReject("unauthorized_actor", "You cannot direct that actor.");
  }
  const actorZoneId = view.actorZoneId(actorId);
  if (actorZoneId === null) return destroyReject("actor_not_embodied", "They are not anywhere they can do that.");
  const item = view.itemById(itemId);
  if (!item) return destroyReject("item_not_found", "That item is unavailable.");
  if (item.locus.kind === "gone") return destroyReject("item_gone", "That item is gone.");

  const root = resolveRootLocus(item.locus, view.itemById);
  // Destroy has no container_cycle code; an unresolvable source fails closed as unreachable.
  if (rootZoneId(root, view) !== actorZoneId) {
    return destroyReject("root_not_colocated", "That item is not within reach.");
  }
  if (root.kind === "actor" && root.actorId !== actorId) {
    return item.locus.kind === "worn"
      ? destroyReject("worn_by_other", "That is worn by someone else.")
      : destroyReject("held_by_other", "That is in someone else's keeping.");
  }
  if (item.locus.kind === "container" && !containerAccessAllowed(view, item.locus.containerItemId, actorId)) {
    return destroyReject("container_access_denied", "That container is closed to them.");
  }
  if (view.reservingActivityId(itemId) !== null) {
    return destroyReject("item_reserved", "That is reserved for something else right now.");
  }

  const againstOwnership = item.ownerActorId !== null && item.ownerActorId !== actorId;
  const locationId = view.actorLocationId(actorId);
  const event = itemDestroyedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "item-destroyed"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    type: "item_destroyed",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: materialDerivationVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: [actorId],
    entityIds: sortedUnique([actorId, itemId, ...lociEntityIds(item.locus)]),
    ...(locationId !== null ? { locationId } : {}),
    recordedAtWallClock: command.submittedAtWallClock,
    payload: { actorId, itemId, basis, fromLocus: item.locus, againstOwnership },
  });
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// ConsumeItem resolution (a material event with a body effect)
// ---------------------------------------------------------------------------

/**
 * The actor's body facts a consumption needs, supplied by the caller under
 * the same branch lock as the material view. Absent (or `bodyInitialized:
 * false`) means the actor has no tracked body — consumption still succeeds,
 * with zero trailing body events (the E5.2 "empty for worlds without
 * initialized bodies" precedent: worlds without bodies still eat).
 */
export interface ConsumptionBodyView {
  bodyInitialized: boolean;
  /** Meter integration facts for one authored effect's meterKey, or undefined if unknown. */
  meterView(meterKey: string): MeterIntegrationView | undefined;
  /** Consulted only for an effect whose meterKey is `"energy"`. */
  collapseContext?: CollapseContext;
}

export interface ConsumptionBodyEffectsResult {
  /** Trailing body_source_applied + re-arm trigger_scheduled events, authored order. */
  events: (BodySourceAppliedEvent | TriggerScheduledEvent)[];
  meterUpdates: BodyMeterState[];
  /** The first unused sequence number after every returned event — chain a caller's own trailing events off this. */
  nextSequence: number;
}

/**
 * Build the trailing body-kernel events for one item's authored
 * `consumptionEffects`, causation-chained to the consumption event with one
 * running sequence counter (the `resolveBodyCollapse` precedent: every
 * trailing event chains to the SAME root cause, never to each other).
 * Shared by `resolveConsumeItemFromView` below and
 * `lib/simulation/activities.ts`'s completion-time consume-disposition path,
 * so the two consumption entry points can never drift apart.
 */
export function buildConsumptionBodyEffects(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  actorId: string;
  consumptionEffects: readonly ItemConsumptionEffect[];
  /** The `item_consumed` event every trailing event causation-chains to. */
  causationEventId: string;
  startSequence: number;
  bodyView?: ConsumptionBodyView;
}): ConsumptionBodyEffectsResult {
  if (!input.bodyView?.bodyInitialized) {
    return { events: [], meterUpdates: [], nextSequence: input.startSequence };
  }
  const bodyView = input.bodyView;
  const events: (BodySourceAppliedEvent | TriggerScheduledEvent)[] = [];
  const meterUpdates: BodyMeterState[] = [];
  let sequence = input.startSequence;
  for (const [index, effect] of input.consumptionEffects.entries()) {
    const meterView = bodyView.meterView(effect.meterKey);
    // Defensive only: authored data always names a registered meter key.
    if (!meterView) continue;
    const result = applySourceToMeter({
      view: input.view,
      command: input.command,
      actorId: input.actorId,
      meterKey: effect.meterKey,
      sourceKind: effect.sourceKind,
      operation: effect.operation,
      meterView,
      collapseContext: bodyView.collapseContext,
      sequence,
      suffix: `item-consumed-effect-${index}`,
      causationId: input.causationEventId,
    });
    events.push(result.event, ...result.rearmEvents);
    meterUpdates.push(result.nextState);
    sequence = result.nextSequence;
  }
  return { events, meterUpdates, nextSequence: sequence };
}

/**
 * Build one `item_consumed` event. Shared by `resolveConsumeItemFromView`
 * below (the root event of its own transaction, no causation) and
 * `lib/simulation/activities.ts`'s completion-time consume path (one per
 * consumed item, causation-chained to the `activity_completed` event) — so an
 * item's consumption is recorded identically no matter which command reached it.
 */
export function buildItemConsumedEvent(input: {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  storySecond: number;
  sequence: number;
  command: BodyEventCommandContext;
  actorId: string;
  itemId: string;
  fromLocus: ItemLocus;
  againstOwnership: boolean;
  locationId?: string;
  causationId?: string;
}): ItemConsumedEvent {
  return itemConsumedEventSchema.parse({
    id: composeSimulationId("event", [input.branchId, input.command.id, `item-consumed-${input.itemId}`]),
    worldId: input.worldId,
    branchId: input.branchId,
    sequence: input.sequence,
    storySecond: input.storySecond,
    type: "item_consumed",
    schemaVersion: 1,
    rulesetVersion: input.rulesetVersion,
    derivationVersion: materialDerivationVersion,
    commandId: input.command.id,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    correlationId: input.command.correlationId,
    actorIds: [input.actorId],
    entityIds: sortedUnique([input.actorId, input.itemId, ...lociEntityIds(input.fromLocus)]),
    ...(input.locationId === undefined ? {} : { locationId: input.locationId }),
    recordedAtWallClock: input.command.submittedAtWallClock,
    payload: {
      actorId: input.actorId,
      itemId: input.itemId,
      fromLocus: input.fromLocus,
      againstOwnership: input.againstOwnership,
    },
  });
}

interface ConsumeRejection {
  ok: false;
  code: ConsumeItemRejectionCode;
  publicReason: string;
}
interface ConsumeAccepted {
  ok: true;
  event: ItemConsumedEvent;
  bodyEvents: (BodySourceAppliedEvent | TriggerScheduledEvent)[];
  meterUpdates: BodyMeterState[];
}
export type ConsumeItemResolution = ConsumeRejection | ConsumeAccepted;

function consumeReject(code: ConsumeItemRejectionCode, publicReason: string): ConsumeRejection {
  return { ok: false, code, publicReason };
}

/**
 * Pure ConsumeItem resolver: the destroy-law subset of validation
 * (no caller-asserted source, so no staleness check) plus `not_consumable`
 * and `item_reserved`, followed by the trailing body effects built
 * through `buildConsumptionBodyEffects`.
 */
export function resolveConsumeItemFromView(
  view: MaterialResolutionView,
  command: ConsumeItemCommand,
  bodyView?: ConsumptionBodyView,
): ConsumeItemResolution {
  const { actorId, itemId } = command.payload;

  if (command.branchId !== view.branchId) {
    return consumeReject("branch_mismatch", "That world branch is unavailable.");
  }
  if (!view.actorById(actorId)) return consumeReject("actor_not_found", "That actor is unavailable.");
  if (!command.principal.controlledActorIds.includes(actorId)) {
    return consumeReject("unauthorized_actor", "You cannot direct that actor.");
  }
  const actorZoneId = view.actorZoneId(actorId);
  if (actorZoneId === null) return consumeReject("actor_not_embodied", "They are not anywhere they can do that.");
  const item = view.itemById(itemId);
  if (!item) return consumeReject("item_not_found", "That item is unavailable.");
  if (item.locus.kind === "gone") return consumeReject("item_gone", "That item is gone.");
  if (!item.consumptionEffects || item.consumptionEffects.length === 0) {
    return consumeReject("not_consumable", "That cannot be consumed.");
  }

  const root = resolveRootLocus(item.locus, view.itemById);
  if (rootZoneId(root, view) !== actorZoneId) {
    return consumeReject("root_not_colocated", "That item is not within reach.");
  }
  if (root.kind === "actor" && root.actorId !== actorId) {
    return item.locus.kind === "worn"
      ? consumeReject("worn_by_other", "That is worn by someone else.")
      : consumeReject("held_by_other", "That is in someone else's keeping.");
  }
  if (item.locus.kind === "container" && !containerAccessAllowed(view, item.locus.containerItemId, actorId)) {
    return consumeReject("container_access_denied", "That container is closed to them.");
  }
  if (view.reservingActivityId(itemId) !== null) {
    return consumeReject("item_reserved", "That is reserved for something else right now.");
  }

  const againstOwnership = item.ownerActorId !== null && item.ownerActorId !== actorId;
  const locationId = view.actorLocationId(actorId);
  const event = buildItemConsumedEvent({
    worldId: view.worldId,
    branchId: view.branchId,
    rulesetVersion: view.rulesetVersion,
    storySecond: view.storySecond,
    sequence: view.headSequence + 1,
    command,
    actorId,
    itemId,
    fromLocus: item.locus,
    againstOwnership,
    ...(locationId !== null ? { locationId } : {}),
  });

  const { events: bodyEvents, meterUpdates } = buildConsumptionBodyEffects({
    view,
    command,
    actorId,
    consumptionEffects: item.consumptionEffects,
    causationEventId: event.id,
    startSequence: event.sequence + 1,
    bodyView,
  });

  return { ok: true, event, bodyEvents, meterUpdates };
}

// ---------------------------------------------------------------------------
// SetItemOwnership resolution (social, not physical)
// ---------------------------------------------------------------------------

interface OwnershipRejection {
  ok: false;
  code: SetItemOwnershipRejectionCode;
  publicReason: string;
}
interface OwnershipAccepted {
  ok: true;
  event: ItemOwnershipSetEvent;
}
export type SetItemOwnershipResolution = OwnershipRejection | OwnershipAccepted;

function ownershipReject(code: SetItemOwnershipRejectionCode, publicReason: string): OwnershipRejection {
  return { ok: false, code, publicReason };
}

/**
 * Pure SetItemOwnership resolver. Authorized only for the storyteller principal
 * or an actor principal that controls the item's CURRENT owner. No
 * physical checks: ownership is social and never blocks or requires movement.
 */
export function resolveSetItemOwnershipFromView(
  view: MaterialResolutionView,
  command: SetItemOwnershipCommand,
): SetItemOwnershipResolution {
  const { itemId, newOwnerActorId } = command.payload;

  if (command.branchId !== view.branchId) {
    return ownershipReject("branch_mismatch", "That world branch is unavailable.");
  }
  const item = view.itemById(itemId);
  if (!item) return ownershipReject("item_not_found", "That item is unavailable.");
  if (item.locus.kind === "gone") return ownershipReject("item_gone", "That item is gone.");
  if (newOwnerActorId !== null && !view.actorById(newOwnerActorId)) {
    return ownershipReject("actor_not_found", "That owner is unavailable.");
  }
  const isStoryteller = command.principal.kind === "storyteller";
  const controlsCurrentOwner =
    item.ownerActorId !== null && command.principal.controlledActorIds.includes(item.ownerActorId);
  if (!isStoryteller && !controlsCurrentOwner) {
    return ownershipReject("unauthorized_principal", "You cannot reassign that item.");
  }

  const owners = [
    ...(item.ownerActorId !== null ? [item.ownerActorId] : []),
    ...(newOwnerActorId !== null ? [newOwnerActorId] : []),
  ];
  const event = itemOwnershipSetEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "item-ownership-set"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    type: "item_ownership_set",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: materialDerivationVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: [],
    entityIds: sortedUnique([itemId, ...owners]),
    recordedAtWallClock: command.submittedAtWallClock,
    payload: { itemId, previousOwnerActorId: item.ownerActorId, newOwnerActorId },
  });
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// Projection: canonical order, projector, replay, seed, invariants
// ---------------------------------------------------------------------------

/** Canonical ordering shared by live assembly, replay, and hashing. */
export function sortMaterialsProjection(projection: MaterialsProjection): MaterialsProjection {
  return materialsProjectionSchema.parse({
    ...projection,
    actors: [...projection.actors].sort((left, right) => compareStableText(left.id, right.id)),
    items: [...projection.items].sort((left, right) => compareStableText(left.id, right.id)),
  });
}

function findItem(projection: MaterialsProjection, itemId: string): SimulationMaterialItem {
  const item = projection.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Material event replay references a missing item ${itemId}`);
  return item;
}

function withLocus(
  items: readonly SimulationMaterialItem[],
  itemId: string,
  locus: ItemLocus,
): SimulationMaterialItem[] {
  return items.map((item) => (item.id === itemId ? { ...item, locus } : item));
}

export interface ApplyMaterialEventOptions {
  /**
   * Branches whose events this projection accepts. Defaults to the projection's
   * own branch; ancestry replay onto a fork child passes the chain so inherited
   * ancestor events apply (R4).
   */
  acceptBranchIds?: readonly string[];
}

/**
 * Pure synchronous projector for the material event family. It mutates on the
 * real material events (the item-mutation events, `item_instantiated_from_promotion`
 * — the first event that CREATES an item — and E6.4's
 * `actor_materialized_from_aggregate`, the first that CREATES an actor) and
 * passes every other branch event through as a bare boundary advance — the
 * exhaustive passthrough (copied from `applyActivityEvent`) keeps TS
 * exhaustiveness holding so a new event type cannot ship without a ruling.
 */
export function applyMaterialEvent(
  projection: MaterialsProjection,
  event: SimulationBranchEvent,
  options: ApplyMaterialEventOptions = {},
): MaterialsProjection {
  const acceptBranchIds = options.acceptBranchIds ?? [projection.branchId];
  if (!acceptBranchIds.includes(event.branchId) || event.worldId !== projection.worldId) {
    throw new Error("Cannot apply a material event from another world branch");
  }
  if (event.sequence !== projection.headSequence + 1) {
    throw new Error("Material event sequence is not contiguous");
  }
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };

  switch (event.type) {
    case "item_transferred": {
      const item = findItem(projection, event.payload.itemId);
      if (!lociEqual(item.locus, event.payload.fromLocus)) {
        throw new Error("Item transfer replay source precondition failed");
      }
      const next = sortMaterialsProjection({
        ...bumped,
        items: withLocus(projection.items, event.payload.itemId, event.payload.toLocus),
      });
      assertMaterialsProjectionInvariants(next);
      return next;
    }
    case "item_destroyed": {
      const item = findItem(projection, event.payload.itemId);
      if (!lociEqual(item.locus, event.payload.fromLocus)) {
        throw new Error("Item destruction replay source precondition failed");
      }
      const next = sortMaterialsProjection({
        ...bumped,
        items: withLocus(projection.items, event.payload.itemId, { kind: "gone", basis: event.payload.basis }),
      });
      assertMaterialsProjectionInvariants(next);
      return next;
    }
    case "item_consumed": {
      const item = findItem(projection, event.payload.itemId);
      if (!lociEqual(item.locus, event.payload.fromLocus)) {
        throw new Error("Item consumption replay source precondition failed");
      }
      const next = sortMaterialsProjection({
        ...bumped,
        items: withLocus(projection.items, event.payload.itemId, { kind: "gone", basis: "consumed" }),
      });
      assertMaterialsProjectionInvariants(next);
      return next;
    }
    case "item_ownership_set": {
      const item = findItem(projection, event.payload.itemId);
      if (item.ownerActorId !== event.payload.previousOwnerActorId) {
        throw new Error("Item ownership replay precondition failed");
      }
      const next = sortMaterialsProjection({
        ...bumped,
        items: projection.items.map((candidate) =>
          candidate.id === item.id
            ? { ...candidate, ownerActorId: event.payload.newOwnerActorId }
            : candidate,
        ),
      });
      assertMaterialsProjectionInvariants(next);
      return next;
    }
    case "item_instantiated_from_promotion": {
      // The first material event that CREATES an item rather than mutating
      // an existing one (E5.4) — no pre-existing row to find.
      if (projection.items.some((item) => item.id === event.payload.item.id)) {
        throw new Error("Material event replay double-instantiates a promoted item");
      }
      const next = sortMaterialsProjection({
        ...bumped,
        items: [...projection.items, event.payload.item],
      });
      assertMaterialsProjectionInvariants(next);
      return next;
    }
    case "actor_materialized_from_aggregate": {
      // E6.4: the first event that CREATES an actor rather than
      // referencing one — the actor lane's `item_instantiated_from_promotion`.
      if (projection.actors.some((actor) => actor.id === event.payload.actorId)) {
        throw new Error("Material event replay double-materializes a promoted actor");
      }
      const next = sortMaterialsProjection({
        ...bumped,
        actors: [...projection.actors, { id: event.payload.actorId, name: event.payload.name }],
      });
      assertMaterialsProjectionInvariants(next);
      return next;
    }
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
      // Non-material families advance the boundary without touching items.
      return materialsProjectionSchema.parse(bumped);
  }
}

export interface MaterialsReplayInput {
  /** Materials are fully evented past their origin seed (R3). */
  seed: MaterialsProjection;
  events: readonly SimulationBranchEvent[];
}

/** Fold one branch's full logical stream into its materials projection. */
export function replayMaterialsHistory(input: MaterialsReplayInput): MaterialsProjection {
  const seed = sortMaterialsProjection(materialsProjectionSchema.parse(input.seed));
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(`Materials replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`);
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applyMaterialEvent(projection, event);
    lastSequence = event.sequence;
  }
  return materialsProjectionSchema.parse({ ...projection, version: seed.version + commandIds.size });
}

/** Assemble the origin projection for one new material branch from its seed. */
export function materialsSeedProjection(rawSeed: unknown): MaterialsProjection {
  const seed = materialBranchSeedSchema.parse(rawSeed);
  const projection = sortMaterialsProjection(
    materialsProjectionSchema.parse({
      worldId: seed.worldId,
      branchId: seed.branchId,
      rulesetVersion: seed.rulesetVersion,
      version: 0,
      headSequence: 0,
      storySecond: seed.originStorySecond,
      actors: seed.actors,
      items: seed.items,
    }),
  );
  assertMaterialsProjectionInvariants(projection);
  return projection;
}

function assertUniqueIds(kind: string, ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error(`Materials projection has duplicate ${kind} ids`);
}

/**
 * The projection's structural laws: unique ids, container references
 * exist and are themselves containers, capacity respected, and no containment
 * cycle. Thrown from — never returned by — the projector, because a corrupt
 * projection is an engine bug, not a rejected command.
 */
export function assertMaterialsProjectionInvariants(projection: MaterialsProjection): void {
  assertUniqueIds("actor", projection.actors.map((actor) => actor.id));
  assertUniqueIds("item", projection.items.map((item) => item.id));

  const itemsById = new Map<string, SimulationMaterialItem>(
    projection.items.map((item) => [item.id, item]),
  );
  const occupants = new Map<string, number>();
  for (const item of projection.items) {
    if (item.locus.kind === "container") {
      const container = itemsById.get(item.locus.containerItemId);
      if (!container) {
        throw new Error(`Material item ${item.id} references a missing container ${item.locus.containerItemId}`);
      }
      if (!container.container) {
        throw new Error(`Material item ${item.id} sits in a non-container item ${item.locus.containerItemId}`);
      }
      occupants.set(item.locus.containerItemId, (occupants.get(item.locus.containerItemId) ?? 0) + 1);
    }
  }
  for (const item of projection.items) {
    if (item.container && (occupants.get(item.id) ?? 0) > item.container.capacityCount) {
      throw new Error(`Material container ${item.id} exceeds its capacity`);
    }
  }
  for (const item of projection.items) {
    if (resolveRootLocus(item.locus, (id) => itemsById.get(id)).kind === "cycle") {
      throw new Error(`Material item ${item.id} sits in a container cycle`);
    }
  }
}
