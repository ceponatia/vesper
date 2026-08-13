import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import { composeSimulationId } from "@/contracts/simulation/identity";
import {
  RESERVED_CURRENCY_MATERIAL_KIND,
  compareMeansBands,
  householdCreatedEventSchema,
  householdMembershipSchema,
  householdMembershipSetEventSchema,
  householdRestockDeferredEventSchema,
  householdRestockFulfilledEventSchema,
  householdRestockRoutineConfiguredEventSchema,
  householdRestockRoutineSchema,
  householdsDerivationVersion,
  householdsProjectionSchema,
  itemInstantiatedFromPromotionEventSchema,
  materialKindRegistryV1,
  materialKindRegistryVersion,
  materialLotAdjustedEventSchema,
  materialLotInitializedEventSchema,
  materialLotStateSchema,
  materialLotTransferredEventSchema,
  meansBandRegistryVersion,
  meansBandSetEventSchema,
  meansBandStateSchema,
  simulationHouseholdSchema,
  type AdjustMaterialLotCommand,
  type AdjustMaterialLotRejectionCode,
  type ConfigureRestockRoutineCommand,
  type ConfigureRestockRoutineRejectionCode,
  type CreateHouseholdCommand,
  type CreateHouseholdRejectionCode,
  type HouseholdCreatedEvent,
  type HouseholdMembership,
  type HouseholdMembershipSetEvent,
  type HouseholdRestockDeferredEvent,
  type HouseholdRestockDeferredReason,
  type HouseholdRestockFulfilledEvent,
  type HouseholdRestockRoutine,
  type HouseholdRestockRoutineConfiguredEvent,
  type HouseholdsProjection,
  type ItemInstantiatedFromPromotionEvent,
  type LotLocus,
  type MaterialKindDefinition,
  type MaterialKindRegistryVersion,
  type MaterialLotAdjustedEvent,
  type MaterialLotInitializedEvent,
  type MaterialLotState,
  type MaterialLotTransferredEvent,
  type MaterialQuantityKind,
  type MeansBandSetEvent,
  type MeansBandState,
  type MeansRead,
  type MeansSubject,
  type PromoteItemFromStockCommand,
  type PromoteItemFromStockRejectionCode,
  type PromotionSampledDetail,
  type RunHouseholdRestockCommand,
  type RunHouseholdRestockRejectionCode,
  type SetHouseholdMembershipCommand,
  type SetHouseholdMembershipRejectionCode,
  type SetMeansBandCommand,
  type SetMeansBandRejectionCode,
  type SimulationHousehold,
  type TransferLotQuantityCommand,
  type TransferLotQuantityRejectionCode,
} from "@/contracts/simulation/households";
import {
  deterministicDrawUnit,
  householdRestockTriggerKind,
  schedulerDerivationVersion,
  triggerScheduledEventSchema,
  type TriggerScheduledEvent,
} from "@/contracts/simulation/scheduler";
import { compareStableText, sortedUnique } from "./hash";

/**
 * E5.4 slice 1 — the pure households/lots/means kernel (engine.spec
 * §26.8–26.10): row-key helpers, lot arithmetic, §26.8 access/reachability,
 * the §26.10 means read, the five slice-1 command resolvers, and the
 * households projector/replay/seed. No IO, no clock, no ambient randomness
 * (engine.spec §31–32).
 *
 * Unlike `material-condition.ts` (E5.3 slice 3), this file needs no split
 * file and no dependency on `material-locus.ts`/`materials.ts`: lot loci
 * (§26.9) are FLAT — household XOR actor XOR zone, no container nesting — so
 * "root co-location" for a lot is a direct one-step check, never a chain
 * walk. `materials.ts` imports nothing from here and this file imports
 * nothing from `materials.ts` — there is no cycle to avoid (see
 * `lib/simulation/materials.ts`'s new `item_instantiated_from_promotion`
 * passthrough case, added in slice 2, for the one place the two domains meet).
 */

// ---------------------------------------------------------------------------
// Persistence-layer row keys (NEVER appear in a contracts schema or an event
// payload — lots/means-bands are addressed by (locus, materialKindKey) /
// subject everywhere in contracts/events; see schema.ts's migration note).
// ---------------------------------------------------------------------------

export function deriveMaterialLotRowKey(locus: LotLocus, materialKindKey: string): string {
  const locusTag =
    locus.kind === "household"
      ? ["household", locus.householdId]
      : locus.kind === "actor"
        ? ["actor", locus.actorId]
        : ["zone", locus.zoneId];
  return composeSimulationId("material-lot", [...locusTag, materialKindKey]);
}

export function deriveMeansSubjectRowKey(subject: MeansSubject): string {
  switch (subject.kind) {
    case "actor":
      return composeSimulationId("means-subject", ["actor", subject.actorId]);
    case "household":
      return composeSimulationId("means-subject", ["household", subject.householdId]);
    case "cohort":
      return composeSimulationId("means-subject", ["cohort", subject.cohortId]);
  }
}

// ---------------------------------------------------------------------------
// Lot arithmetic (pure, no IO)
// ---------------------------------------------------------------------------

/** Registered key -> its declared kind; unregistered keys default to `count` (§26.9). */
export function resolveQuantityKind(
  materialKindKey: string,
  registry: readonly MaterialKindDefinition[] = materialKindRegistryV1,
): MaterialQuantityKind {
  return registry.find((definition) => definition.key === materialKindKey)?.quantityKind ?? "count";
}

export function initializeLot(locus: LotLocus, materialKindKey: string): MaterialLotState {
  return materialLotStateSchema.parse({
    locus,
    materialKindKey,
    quantityKind: resolveQuantityKind(materialKindKey),
    quantityRaw: 0,
    registryVersion: materialKindRegistryVersion,
  });
}

/**
 * A discriminated-union TYPE ALIAS (not the invalid `interface X {…} | {…}`
 * shape) — matches how `materials.ts`'s resolvers type their results.
 */
export type LotAdjustResult =
  | { ok: true; resultingQuantityRaw: number }
  | { ok: false; code: "insufficient_balance" };

/** Clamp-reject below zero; accept exact zero. No upper clamp beyond the safe-integer range. */
export function applyLotDelta(lot: MaterialLotState, deltaRaw: number): LotAdjustResult {
  const resultingQuantityRaw = lot.quantityRaw + deltaRaw;
  if (resultingQuantityRaw < 0) return { ok: false, code: "insufficient_balance" };
  if (!Number.isSafeInteger(resultingQuantityRaw)) {
    throw new Error("Material lot adjustment produced an unsafe integer quantity");
  }
  return { ok: true, resultingQuantityRaw };
}

export type LotTransferResult =
  | { ok: true; from: MaterialLotState; to: MaterialLotState }
  | { ok: false; code: "insufficient_balance" };

/** Same-kind, both loci already resolved to lots; pure arithmetic only — no IO. */
export function applyLotTransfer(
  from: MaterialLotState,
  to: MaterialLotState,
  quantityRaw: number,
): LotTransferResult {
  if (from.quantityRaw < quantityRaw) return { ok: false, code: "insufficient_balance" };
  const nextFromQuantityRaw = from.quantityRaw - quantityRaw;
  const nextToQuantityRaw = to.quantityRaw + quantityRaw;
  if (!Number.isSafeInteger(nextToQuantityRaw)) {
    throw new Error("Material lot transfer produced an unsafe integer quantity");
  }
  return {
    ok: true,
    from: materialLotStateSchema.parse({ ...from, quantityRaw: nextFromQuantityRaw }),
    to: materialLotStateSchema.parse({ ...to, quantityRaw: nextToQuantityRaw }),
  };
}

// ---------------------------------------------------------------------------
// Root/co-location resolution (flat, no chain walk — §26.8)
// ---------------------------------------------------------------------------

export interface HouseholdsBranchMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

export interface HouseholdsResolutionView {
  householdById(householdId: string): SimulationHousehold | undefined;
  activeMembership(householdId: string, actorId: string): HouseholdMembership | undefined;
  /** The actor's current zone (§13.2 physical locus), or null if not embodied. */
  actorZoneId(actorId: string): string | null;
}

/** §26.8 fail-closed stock access. */
export function householdStockAccessAllowed(
  view: HouseholdsResolutionView,
  householdId: string,
  actorId: string,
): boolean {
  const household = view.householdById(householdId);
  if (!household) return false;
  switch (household.stockAccessPolicy.kind) {
    case "members_only": {
      const membership = view.activeMembership(householdId, actorId);
      return membership !== undefined && membership.status === "active";
    }
    case "allow_list":
      return household.stockAccessPolicy.actorIds.includes(actorId as never);
  }
}

/**
 * The lot locus's root zone(s) — a household locus roots at ANY of its
 * residence zones, so an acting actor at any one of them satisfies
 * co-location; an actor locus is always reachable (carried with its holder —
 * reachability there is checked as person-sovereignty, not zone, by the
 * caller).
 */
export function lotLocusReachableFrom(
  view: HouseholdsResolutionView,
  locus: LotLocus,
  actorZoneId: string,
): boolean {
  switch (locus.kind) {
    case "zone":
      return locus.zoneId === actorZoneId;
    case "household": {
      const household = view.householdById(locus.householdId);
      return household !== undefined && household.residenceZoneIds.includes(actorZoneId as never);
    }
    case "actor":
      return true;
  }
}

// ---------------------------------------------------------------------------
// Means read (mirrors `deriveEnergyRead`'s total/pure/contextual shape)
// ---------------------------------------------------------------------------

export interface MeansReadView {
  currencyLot(subject: MeansSubject): MaterialLotState | undefined;
  band(subject: MeansSubject): MeansBandState | undefined;
}

/** Precedence is structural (§26.10): the lot wins whenever it exists. */
export function deriveMeansRead(subject: MeansSubject, view: MeansReadView): MeansRead {
  const lot = view.currencyLot(subject);
  if (lot) return { kind: "lot_tracked", quantityRaw: lot.quantityRaw, quantityKind: lot.quantityKind };
  const band = view.band(subject);
  if (band) return { kind: "band_tracked", bandKey: band.bandKey };
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// Conservation checker (property-test support, not runtime-called by a
// command path — runtime conservation is structural per §26.9).
// ---------------------------------------------------------------------------

/**
 * For a set of same-transaction lot deltas that CLAIM to be conserved (every
 * `material_lot_transferred`, decomposed into its two same-kind deltas),
 * assert same-`materialKindKey` deltas sum to zero. Used by property tests,
 * not by any store command.
 */
export function assertConservedDeltasBalance(
  deltas: readonly { materialKindKey: string; deltaRaw: number }[],
): void {
  const totals = new Map<string, number>();
  for (const delta of deltas) {
    totals.set(delta.materialKindKey, (totals.get(delta.materialKindKey) ?? 0) + delta.deltaRaw);
  }
  for (const [materialKindKey, total] of totals) {
    if (total !== 0) {
      throw new Error(`Conservation violated for material kind "${materialKindKey}": net delta ${total}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared resolver plumbing (mirrors bodies.ts / material-condition.ts)
// ---------------------------------------------------------------------------

interface HouseholdRejection<TCode extends string> {
  ok: false;
  code: TCode;
  publicReason: string;
}

function rejection<TCode extends string>(code: TCode, publicReason: string): HouseholdRejection<TCode> {
  return { ok: false, code, publicReason };
}

function isPrivilegedPrincipal(kind: string): boolean {
  return kind === "storyteller" || kind === "system";
}

interface HouseholdEventCommandContext {
  id: string;
  correlationId: string;
  submittedAtWallClock: string;
}

function eventEnvelope(
  view: HouseholdsBranchMeta,
  command: HouseholdEventCommandContext,
  sequence: number,
  suffix: string,
) {
  return {
    id: composeSimulationId("event", [view.branchId, command.id, suffix]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence,
    storySecond: view.storySecond,
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: householdsDerivationVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    recordedAtWallClock: command.submittedAtWallClock,
  };
}

/** The registry id(s) a lot locus references, for an event envelope's entity set. */
function lotLocusEntityIds(locus: LotLocus): string[] {
  switch (locus.kind) {
    case "household":
      return [locus.householdId];
    case "actor":
      return [locus.actorId];
    case "zone":
      return [locus.zoneId];
  }
}

/** Structural locus equality — the `same_locus` no-op defense. */
function lotLociEqual(left: LotLocus, right: LotLocus): boolean {
  switch (left.kind) {
    case "household":
      return right.kind === "household" && left.householdId === right.householdId;
    case "actor":
      return right.kind === "actor" && left.actorId === right.actorId;
    case "zone":
      return right.kind === "zone" && left.zoneId === right.zoneId;
  }
}

type LotLocusAccessCode = "root_not_colocated" | "household_access_denied";

/**
 * §26.8's three-step access check applied to ONE lot locus end of a transfer:
 * a zone locus needs exact co-location; a household locus needs residence
 * co-location THEN the stock access policy; an actor locus is reachable
 * unconditionally for its own holder, or requires the OTHER actor to be
 * co-located (mirrors `item_transferred`'s "giving" allowance).
 */
function checkLotLocusAccess(
  view: HouseholdsResolutionView,
  locus: LotLocus,
  actingActorId: string,
  actorZoneId: string,
): { ok: true } | { ok: false; code: LotLocusAccessCode } {
  switch (locus.kind) {
    case "zone":
      return lotLocusReachableFrom(view, locus, actorZoneId)
        ? { ok: true }
        : { ok: false, code: "root_not_colocated" };
    case "household": {
      if (!lotLocusReachableFrom(view, locus, actorZoneId)) {
        return { ok: false, code: "root_not_colocated" };
      }
      return householdStockAccessAllowed(view, locus.householdId, actingActorId)
        ? { ok: true }
        : { ok: false, code: "household_access_denied" };
    }
    case "actor": {
      if (locus.actorId === actingActorId) return { ok: true };
      return view.actorZoneId(locus.actorId) === actorZoneId
        ? { ok: true }
        : { ok: false, code: "root_not_colocated" };
    }
  }
}

/**
 * Lazy init (mirrors `buildItemConditionInitializedEvent`): the store calls
 * this the first time a lot's row is touched, before persisting it.
 */
export function buildMaterialLotInitializedEvent(input: {
  view: HouseholdsBranchMeta;
  command: HouseholdEventCommandContext;
  locus: LotLocus;
  materialKindKey: string;
  quantityKind: MaterialQuantityKind;
  sequence: number;
  registryVersion?: MaterialKindRegistryVersion;
}): MaterialLotInitializedEvent {
  const registryVersion = input.registryVersion ?? materialKindRegistryVersion;
  return materialLotInitializedEventSchema.parse({
    ...eventEnvelope(input.view, input.command, input.sequence, "material-lot-initialized"),
    type: "material_lot_initialized",
    actorIds: [],
    entityIds: sortedUnique(lotLocusEntityIds(input.locus)),
    payload: {
      locus: input.locus,
      materialKindKey: input.materialKindKey,
      quantityKind: input.quantityKind,
      registryVersion,
    },
  });
}

// ---------------------------------------------------------------------------
// create_household (§26.8)
// ---------------------------------------------------------------------------

export interface CreateHouseholdResolutionView extends HouseholdsBranchMeta {
  householdExists: boolean;
  zoneExists(zoneId: string): boolean;
}

export type CreateHouseholdResolution =
  | HouseholdRejection<CreateHouseholdRejectionCode>
  | { ok: true; event: HouseholdCreatedEvent };

export function resolveCreateHouseholdFromView(
  view: CreateHouseholdResolutionView,
  command: CreateHouseholdCommand,
): CreateHouseholdResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller can found a household.");
  }
  if (view.householdExists) {
    return rejection("household_already_exists", "That household already exists.");
  }
  for (const zoneId of command.payload.residenceZoneIds) {
    if (!view.zoneExists(zoneId)) {
      return rejection("zone_not_found", "That residence zone is unavailable.");
    }
  }

  const event = householdCreatedEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "household-created"),
    type: "household_created",
    actorIds: [],
    entityIds: sortedUnique([command.payload.householdId]),
    payload: {
      householdId: command.payload.householdId,
      name: command.payload.name,
      residenceZoneIds: command.payload.residenceZoneIds,
      stockAccessPolicy: command.payload.stockAccessPolicy,
    },
  });
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// set_household_membership (§26.8)
// ---------------------------------------------------------------------------

export interface SetHouseholdMembershipResolutionView extends HouseholdsBranchMeta {
  householdExists: boolean;
  actorExists: boolean;
  /** Undefined means no membership row exists yet for this (householdId, actorId) pair. */
  currentMembership?: HouseholdMembership;
}

export type SetHouseholdMembershipResolution =
  | HouseholdRejection<SetHouseholdMembershipRejectionCode>
  | { ok: true; event: HouseholdMembershipSetEvent };

export function resolveSetHouseholdMembershipFromView(
  view: SetHouseholdMembershipResolutionView,
  command: SetHouseholdMembershipCommand,
): SetHouseholdMembershipResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller can change household membership.");
  }
  if (!view.householdExists) return rejection("household_not_found", "That household is unavailable.");
  if (!view.actorExists) return rejection("actor_not_found", "That actor is unavailable.");

  const current = view.currentMembership;
  if (
    current &&
    current.role === command.payload.role &&
    current.status === command.payload.status &&
    current.endedAtStorySecond === command.payload.endedAtStorySecond
  ) {
    return rejection("no_op", "That membership is already set that way.");
  }

  const event = householdMembershipSetEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "household-membership-set"),
    type: "household_membership_set",
    actorIds: [command.payload.actorId],
    entityIds: sortedUnique([command.payload.householdId, command.payload.actorId]),
    payload: {
      householdId: command.payload.householdId,
      actorId: command.payload.actorId,
      role: command.payload.role,
      status: command.payload.status,
      ...(command.payload.endedAtStorySecond === undefined
        ? {}
        : { endedAtStorySecond: command.payload.endedAtStorySecond }),
    },
  });
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// adjust_material_lot (§26.9) — privileged authoring, exempt from co-location
// ---------------------------------------------------------------------------

export interface AdjustMaterialLotResolutionView extends HouseholdsBranchMeta {
  /** Whether the locus's referenced household/actor/zone exists. */
  localeExists: boolean;
  /** The lot's current state — the store has already lazily initialized it. */
  lot: MaterialLotState;
}

export type AdjustMaterialLotResolution =
  | HouseholdRejection<AdjustMaterialLotRejectionCode>
  | { ok: true; event: MaterialLotAdjustedEvent; nextLot: MaterialLotState };

export function resolveAdjustMaterialLotFromView(
  view: AdjustMaterialLotResolutionView,
  command: AdjustMaterialLotCommand,
): AdjustMaterialLotResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller can author a stock adjustment.");
  }
  if (command.payload.deltaRaw === 0) {
    return rejection("non_zero_delta_required", "That adjustment has no effect.");
  }
  if (!view.localeExists) return rejection("locus_not_found", "That stock's location is unavailable.");

  const delta = applyLotDelta(view.lot, command.payload.deltaRaw);
  if (!delta.ok) return rejection("insufficient_balance", "That stock cannot go below zero.");

  const event = materialLotAdjustedEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "material-lot-adjusted"),
    type: "material_lot_adjusted",
    actorIds: [],
    entityIds: sortedUnique(lotLocusEntityIds(command.payload.locus)),
    payload: {
      locus: command.payload.locus,
      materialKindKey: command.payload.materialKindKey,
      deltaRaw: command.payload.deltaRaw,
      resultingQuantityRaw: delta.resultingQuantityRaw,
      quantityKind: view.lot.quantityKind,
      reason: "authoring",
    },
  });
  return {
    ok: true,
    event,
    nextLot: materialLotStateSchema.parse({ ...view.lot, quantityRaw: delta.resultingQuantityRaw }),
  };
}

// ---------------------------------------------------------------------------
// transfer_lot_quantity (§26.9) — same-kind conserved movement between lots
// ---------------------------------------------------------------------------

export interface TransferLotQuantityResolutionView extends HouseholdsResolutionView, HouseholdsBranchMeta {
  actorById(actorId: string): { id: string; name: string } | undefined;
  /** Both lots' current state — the store has already lazily initialized whichever were untouched. */
  fromLot: MaterialLotState;
  toLot: MaterialLotState;
}

export type TransferLotQuantityResolution =
  | HouseholdRejection<TransferLotQuantityRejectionCode>
  | {
      ok: true;
      event: MaterialLotTransferredEvent;
      nextFromLot: MaterialLotState;
      nextToLot: MaterialLotState;
    };

/** Pure resolver, mirroring `resolveTransferItemFromView`'s numbered validation order (§26.4). */
export function resolveTransferLotQuantityFromView(
  view: TransferLotQuantityResolutionView,
  command: TransferLotQuantityCommand,
): TransferLotQuantityResolution {
  const { actorId, fromLocus, toLocus, materialKindKey, quantityRaw } = command.payload;

  // 1. branch
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  // 2. actor existence + control (storyteller bypasses controlledActorIds)
  if (!view.actorById(actorId)) return rejection("actor_not_found", "That actor is unavailable.");
  const isStoryteller = command.principal.kind === "storyteller";
  if (!isStoryteller && !command.principal.controlledActorIds.includes(actorId)) {
    return rejection("unauthorized_actor", "You cannot direct that actor.");
  }
  // 3. actor embodied at a zone (§13.2)
  const actorZoneId = view.actorZoneId(actorId);
  if (actorZoneId === null) return rejection("actor_not_embodied", "They are not anywhere they can do that.");
  // 4. positive quantity
  if (quantityRaw <= 0) return rejection("non_positive_quantity", "That amount must be positive.");
  // 5. no-op rejection
  if (lotLociEqual(fromLocus, toLocus)) return rejection("same_locus", "That stock is already there.");
  // 6. §26.8 access at both ends
  const fromCheck = checkLotLocusAccess(view, fromLocus, actorId, actorZoneId);
  if (!fromCheck.ok) {
    return rejection(
      fromCheck.code,
      fromCheck.code === "household_access_denied"
        ? "That household's stores are closed to them."
        : "That stock is not within reach.",
    );
  }
  const toCheck = checkLotLocusAccess(view, toLocus, actorId, actorZoneId);
  if (!toCheck.ok) {
    return rejection(
      toCheck.code,
      toCheck.code === "household_access_denied"
        ? "That household's stores are closed to them."
        : "That destination is not within reach.",
    );
  }
  // 7. sufficient balance
  const transfer = applyLotTransfer(view.fromLot, view.toLot, quantityRaw);
  if (!transfer.ok) return rejection("insufficient_balance", "There is not enough there to move.");

  const event = materialLotTransferredEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "material-lot-transferred"),
    type: "material_lot_transferred",
    actorIds: [actorId],
    entityIds: sortedUnique([actorId, ...lotLocusEntityIds(fromLocus), ...lotLocusEntityIds(toLocus)]),
    payload: {
      actorId,
      fromLocus,
      toLocus,
      materialKindKey,
      quantityRaw,
      resultingFromQuantityRaw: transfer.from.quantityRaw,
      resultingToQuantityRaw: transfer.to.quantityRaw,
    },
  });
  return { ok: true, event, nextFromLot: transfer.from, nextToLot: transfer.to };
}

// ---------------------------------------------------------------------------
// set_means_band (§26.10)
// ---------------------------------------------------------------------------

export interface SetMeansBandResolutionView extends HouseholdsBranchMeta {
  subjectExists: boolean;
  currentBand?: MeansBandState;
}

export type SetMeansBandResolution =
  | HouseholdRejection<SetMeansBandRejectionCode>
  | { ok: true; event: MeansBandSetEvent };

export function resolveSetMeansBandFromView(
  view: SetMeansBandResolutionView,
  command: SetMeansBandCommand,
): SetMeansBandResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller can set a means band.");
  }
  if (!view.subjectExists) return rejection("subject_not_found", "That subject is unavailable.");
  if (view.currentBand?.bandKey === command.payload.bandKey) {
    return rejection("no_op", "That means band is already set.");
  }

  const subject = command.payload.subject;
  const subjectEntityIds: readonly string[] =
    subject.kind === "actor"
      ? [subject.actorId]
      : subject.kind === "household"
        ? [subject.householdId]
        : [subject.cohortId];
  const event = meansBandSetEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "means-band-set"),
    type: "means_band_set",
    actorIds: command.payload.subject.kind === "actor" ? [command.payload.subject.actorId] : [],
    entityIds: sortedUnique(subjectEntityIds),
    payload: {
      subject: command.payload.subject,
      bandKey: command.payload.bandKey,
      registryVersion: meansBandRegistryVersion,
      setAtStorySecond: view.storySecond,
    },
  });
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// Household restock alarm identity (§26.11) — mirrors
// `itemConditionThresholdUniquenessKey`/`Prefix`: versioned by `armedAtSequence`
// so a re-arm is a distinct alarm and the prefix retires every arming attempt
// for one (householdId, materialKindKey) regardless of its version.
// ---------------------------------------------------------------------------

export function householdRestockUniquenessKey(
  householdId: string,
  materialKindKey: string,
  armedAtSequence: number,
): string {
  return composeSimulationId("household-restock", [householdId, materialKindKey, String(armedAtSequence)]);
}

export function householdRestockUniquenessKeyPrefix(householdId: string, materialKindKey: string): string {
  return `${composeSimulationId("household-restock", [householdId, materialKindKey])}:`;
}

/**
 * Arm (or re-arm) one household+kind's restock alarm, due at `view.storySecond
 * + cadenceSeconds` — a fixed cadence, not a solved crossing (§9 open decision
 * 6: restock is discrete-scheduled, not continuous-integrated, so there is no
 * trajectory to solve against, unlike `rearmThresholdTrigger`/
 * `rearmItemConditionThresholdTrigger`).
 */
function buildHouseholdRestockTrigger(input: {
  view: HouseholdsBranchMeta;
  command: HouseholdEventCommandContext;
  householdId: string;
  materialKindKey: string;
  cadenceSeconds: number;
  sequence: number;
  causationId: string;
  armedAtSequence: number;
}): TriggerScheduledEvent {
  const uniquenessKey = householdRestockUniquenessKey(
    input.householdId,
    input.materialKindKey,
    input.armedAtSequence,
  );
  const templateId = composeSimulationId("template", [uniquenessKey]);
  return triggerScheduledEventSchema.parse({
    ...eventEnvelope(input.view, input.command, input.sequence, "arm-household-restock"),
    type: "trigger_scheduled",
    derivationVersion: schedulerDerivationVersion,
    causationId: input.causationId,
    actorIds: [],
    entityIds: [input.householdId],
    payload: {
      kind: householdRestockTriggerKind,
      triggerSchemaVersion: 1,
      dueStorySecond: input.view.storySecond + input.cadenceSeconds,
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
        type: "run_household_restock",
        payload: {
          householdId: input.householdId,
          materialKindKey: input.materialKindKey,
          armedAtSequence: input.armedAtSequence,
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// configure_restock_routine (§26.11)
// ---------------------------------------------------------------------------

export interface ConfigureRestockRoutineResolutionView extends HouseholdsBranchMeta {
  householdExists: boolean;
}

export type ConfigureRestockRoutineResolution =
  | HouseholdRejection<ConfigureRestockRoutineRejectionCode>
  | { ok: true; events: [HouseholdRestockRoutineConfiguredEvent, ...TriggerScheduledEvent[]] };

/**
 * The command payload IS the routine (mirrors `set_household_membership`
 * reusing `householdMembershipSchema`) — configuring always upserts the row
 * wholesale. Arming is unconditional-retire-then-arm-if-active at the STORE
 * layer (the pure resolver only ever builds a fresh arm; it never retires —
 * retirement touches durable trigger rows, which this file never sees).
 */
export function resolveConfigureRestockRoutineFromView(
  view: ConfigureRestockRoutineResolutionView,
  command: ConfigureRestockRoutineCommand,
): ConfigureRestockRoutineResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller can configure a restock routine.");
  }
  if (!view.householdExists) return rejection("household_not_found", "That household is unavailable.");

  const configuredEvent = householdRestockRoutineConfiguredEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "household-restock-routine-configured"),
    type: "household_restock_routine_configured",
    actorIds: [],
    entityIds: sortedUnique([command.payload.householdId]),
    payload: {
      householdId: command.payload.householdId,
      materialKindKey: command.payload.materialKindKey,
      targetQuantityRaw: command.payload.targetQuantityRaw,
      lowWaterThresholdRaw: command.payload.lowWaterThresholdRaw,
      cadenceSeconds: command.payload.cadenceSeconds,
      funding: command.payload.funding,
      active: command.payload.active,
    },
  });

  const events: [HouseholdRestockRoutineConfiguredEvent, ...TriggerScheduledEvent[]] = [configuredEvent];
  if (command.payload.active) {
    events.push(
      buildHouseholdRestockTrigger({
        view,
        command,
        householdId: command.payload.householdId,
        materialKindKey: command.payload.materialKindKey,
        cadenceSeconds: command.payload.cadenceSeconds,
        sequence: configuredEvent.sequence + 1,
        causationId: configuredEvent.id,
        armedAtSequence: configuredEvent.sequence,
      }),
    );
  }
  return { ok: true, events };
}

// ---------------------------------------------------------------------------
// promote_item_from_stock (§26.10 / §27.2) — the only path an aggregate fact
// becomes an explicit `sim_items` row
// ---------------------------------------------------------------------------

export interface PromoteItemFromStockResolutionView extends HouseholdsResolutionView, HouseholdsBranchMeta {
  actorById(actorId: string): { id: string; name: string } | undefined;
  /** The funding lot's current state — the store has already lazily initialized it. */
  fundingLot: MaterialLotState;
  /**
   * Authored per-`materialKindKey` display-name pool (§26.10 step 3); an empty
   * array means no pool. No pool is authored yet anywhere in the codebase as
   * of E5.4 slice 2 — the store's implementation returns `[]` unconditionally
   * today, so a caller that omits `item.name` MUST supply it explicitly until
   * a pool registry exists (a future data edit, per the registry-as-data
   * convention — no schema change).
   */
  namePool(materialKindKey: string): readonly string[];
  worldSeed: string;
}

export type PromoteItemFromStockResolution =
  | HouseholdRejection<PromoteItemFromStockRejectionCode>
  | {
      ok: true;
      lotAdjustedEvent: MaterialLotAdjustedEvent;
      itemEvent: ItemInstantiatedFromPromotionEvent;
      nextFundingLot: MaterialLotState;
    };

/** Pure resolver, mirroring `resolveTransferLotQuantityFromView`'s numbered validation order (§26.10/§27.2). */
export function resolvePromoteItemFromStockFromView(
  view: PromoteItemFromStockResolutionView,
  command: PromoteItemFromStockCommand,
): PromoteItemFromStockResolution {
  const { actorId, funding, item } = command.payload;

  // 1. branch
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  // 2. actor existence + control (storyteller bypasses controlledActorIds)
  if (!view.actorById(actorId)) return rejection("actor_not_found", "That actor is unavailable.");
  const isStoryteller = command.principal.kind === "storyteller";
  if (!isStoryteller && !command.principal.controlledActorIds.includes(actorId)) {
    return rejection("unauthorized_actor", "You cannot direct that actor.");
  }
  // 3. actor embodied at a zone (§13.2)
  const actorZoneId = view.actorZoneId(actorId);
  if (actorZoneId === null) return rejection("actor_not_embodied", "They are not anywhere they can do that.");

  // 4. §26.8 access on the funding locus only (an actor-locus source needs no
  // co-location check for its own holder — `checkLotLocusAccess` already
  // encodes that).
  const fundingLocus = funding.kind === "stock" ? funding.sourceLocus : funding.currencyLocus;
  const access = checkLotLocusAccess(view, fundingLocus, actorId, actorZoneId);
  if (!access.ok) {
    return rejection(
      access.code,
      access.code === "household_access_denied"
        ? "That household's stores are closed to them."
        : "That stock is not within reach.",
    );
  }

  // 5. funding kind well-formedness. `stock` draws N whole units of the SAME
  // materialKindKey the item declares — an item with no declared kind has no
  // stock lot to identify. `purchase` always debits the reserved currency
  // kind, so it is well-formed by construction.
  let sourceMaterialKindKey: string;
  let cost: number;
  if (funding.kind === "stock") {
    if (item.materialKindKey === undefined) {
      return rejection("invalid_funding_kind", "That item has no stock kind to draw from.");
    }
    sourceMaterialKindKey = item.materialKindKey;
    cost = funding.quantityRaw;
  } else {
    sourceMaterialKindKey = RESERVED_CURRENCY_MATERIAL_KIND;
    cost = funding.unitPriceRaw * funding.quantityRaw;
  }

  // 6. sufficient funding balance
  const delta = applyLotDelta(view.fundingLot, -cost);
  if (!delta.ok) return rejection("insufficient_balance", "There is not enough there to cover that.");

  // Sample any detail the command did not supply (§26.10 step 3) — the stream
  // identity and drawn result are captured on the event so replay never
  // resamples.
  let sampledName: string | undefined;
  let sampledDetail: PromotionSampledDetail | undefined;
  if (item.name === undefined) {
    const stream = composeSimulationId("promotion-detail", [command.id, "item-name"]);
    const pool = item.materialKindKey === undefined ? [] : view.namePool(item.materialKindKey);
    const draw = deterministicDrawUnit({
      worldSeed: view.worldSeed,
      branchId: view.branchId,
      stream,
      drawIndex: 0,
    });
    sampledName = pool.length > 0 ? pool[Math.floor(draw * pool.length)] : undefined;
    sampledDetail = {
      stream,
      drawIndex: 0,
      ...(sampledName === undefined ? {} : { sampledName }),
      registryVersion: materialKindRegistryVersion,
    };
  }
  // Invariant 3.2.4 / §26.10 step 5: the caller, never the narrator, supplies
  // any narratively-established name. An unauthored pool plus an omitted name
  // is a foreseeable runtime state (no pool is authored anywhere yet), so it
  // is a structured rejection rather than a thrown exception — resilience.md:
  // diagnostics over exceptions, degraded defaults over failed turns.
  const finalName = item.name ?? sampledName;
  if (finalName === undefined) {
    return rejection("name_required", "That item needs a name — none was given and none could be sampled.");
  }

  const lotAdjustedEvent = materialLotAdjustedEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "material-lot-adjusted"),
    type: "material_lot_adjusted",
    actorIds: [actorId],
    entityIds: sortedUnique([actorId, ...lotLocusEntityIds(fundingLocus)]),
    payload: {
      locus: fundingLocus,
      materialKindKey: sourceMaterialKindKey,
      deltaRaw: -cost,
      resultingQuantityRaw: delta.resultingQuantityRaw,
      quantityKind: view.fundingLot.quantityKind,
      reason: "promotion_cost",
    },
  });

  // A one-level derivation from already-bounded ids (branchId + commandId +
  // one literal) — no hash compaction needed (the E3.5 lesson applies only to
  // chained/growing derivations, e.g. `deriveBodyConditionId`).
  const itemId = composeSimulationId("item", [view.branchId, command.id, "promoted"]);
  const itemEvent = itemInstantiatedFromPromotionEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 2, "item-instantiated-from-promotion"),
    type: "item_instantiated_from_promotion",
    causationId: lotAdjustedEvent.id,
    actorIds: [actorId],
    entityIds: sortedUnique([actorId, itemId, ...lotLocusEntityIds(fundingLocus)]),
    payload: {
      item: {
        id: itemId,
        name: finalName,
        ...(item.materialKindKey === undefined ? {} : { materialKindKey: item.materialKindKey }),
        ownerActorId: item.ownerActorId,
        ...(item.container === undefined ? {} : { container: item.container }),
        ...(item.consumptionEffects === undefined ? {} : { consumptionEffects: item.consumptionEffects }),
        conditionTracked: item.conditionTracked,
        locus: { kind: "held", actorId },
      },
      sourceLocus: fundingLocus,
      sourceMaterialKindKey,
      ...(sampledDetail === undefined ? {} : { sampledDetail }),
    },
  });

  return {
    ok: true,
    lotAdjustedEvent,
    itemEvent,
    nextFundingLot: materialLotStateSchema.parse({ ...view.fundingLot, quantityRaw: delta.resultingQuantityRaw }),
  };
}

// ---------------------------------------------------------------------------
// run_household_restock (§26.11) — trigger-dispatched, system principal only
// ---------------------------------------------------------------------------

export interface RunHouseholdRestockResolutionView extends HouseholdsBranchMeta {
  /** Undefined if no routine is configured for (householdId, materialKindKey). */
  routine?: HouseholdRestockRoutine;
  /**
   * Whether the alarm THIS command's own `command.payload.armedAtSequence`
   * names has not been retired by a later reconfigure (§5.8's staleness
   * defense) — the durable stand-in for "the routine's current arming",
   * since routines carry no arming column of their own. `false` fails closed
   * as stale rather than acting on a superseded arming.
   */
  armingIsLive: boolean;
  /** The stock lot's current state — undefined means uninitialized (zero, §26.9). */
  stockLot?: MaterialLotState;
  /** `lot` funding only: the currency lot's current state — undefined means uninitialized (zero). */
  currencyLot?: MaterialLotState;
  /** `means_band_envelope` funding only: the household's own means read. */
  householdMeansRead?: MeansRead;
}

export type RunHouseholdRestockResolution =
  | HouseholdRejection<RunHouseholdRestockRejectionCode>
  | {
      ok: true;
      events: (
        | MaterialLotAdjustedEvent
        | HouseholdRestockFulfilledEvent
        | HouseholdRestockDeferredEvent
        | TriggerScheduledEvent
      )[];
      nextStockLot?: MaterialLotState;
      /** The sequence of the specific event that produced `nextStockLot` — set iff it is. */
      stockLotUpdatedAtSequence?: number;
      nextCurrencyLot?: MaterialLotState;
      /** The sequence of the specific event that produced `nextCurrencyLot` — set iff it is. */
      currencyLotUpdatedAtSequence?: number;
    };

/**
 * Fire-time re-validation (mirrors `resolveBodyThreshold`/
 * `resolveItemConditionThreshold`'s re-validate-then-act shape) — always
 * re-arms the next cycle regardless of outcome (§26.11).
 */
export function resolveRunHouseholdRestockFromView(
  view: RunHouseholdRestockResolutionView,
  command: RunHouseholdRestockCommand,
): RunHouseholdRestockResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (command.principal.kind !== "system") {
    return rejection("unauthorized_principal", "Restock resolves on the world's clock only.");
  }
  const routine = view.routine;
  if (!routine || !routine.active) return rejection("routine_not_found", "That restock routine is unavailable.");
  if (!view.armingIsLive) {
    return rejection("threshold_stale", "That restock cycle is no longer current.");
  }

  const { householdId, materialKindKey } = command.payload;
  const householdLocus: LotLocus = { kind: "household", householdId };
  const currentQuantityRaw = view.stockLot?.quantityRaw ?? 0;
  const quantityKind = view.stockLot?.quantityKind ?? resolveQuantityKind(materialKindKey);
  const stockRegistryVersion = view.stockLot?.registryVersion ?? materialKindRegistryVersion;

  const events: (
    | MaterialLotAdjustedEvent
    | HouseholdRestockFulfilledEvent
    | HouseholdRestockDeferredEvent
    | TriggerScheduledEvent
  )[] = [];
  let nextStockLot: MaterialLotState | undefined;
  let stockLotUpdatedAtSequence: number | undefined;
  let nextCurrencyLot: MaterialLotState | undefined;
  let currencyLotUpdatedAtSequence: number | undefined;
  let sequence = view.headSequence + 1;

  const pushDeferred = (reason: HouseholdRestockDeferredReason): HouseholdRestockDeferredEvent => {
    const event = householdRestockDeferredEventSchema.parse({
      ...eventEnvelope(view, command, sequence, "household-restock-deferred"),
      type: "household_restock_deferred",
      actorIds: [],
      entityIds: sortedUnique([householdId]),
      payload: { householdId, materialKindKey, reason },
    });
    events.push(event);
    sequence += 1;
    return event;
  };

  const pushFulfilled = (resultingQuantityRaw: number): HouseholdRestockFulfilledEvent => {
    const event = householdRestockFulfilledEventSchema.parse({
      ...eventEnvelope(view, command, sequence, "household-restock-fulfilled"),
      type: "household_restock_fulfilled",
      actorIds: [],
      entityIds: sortedUnique([householdId]),
      payload: { householdId, materialKindKey, resultingQuantityRaw },
    });
    events.push(event);
    sequence += 1;
    return event;
  };

  let terminalEvent: HouseholdRestockFulfilledEvent | HouseholdRestockDeferredEvent;

  if (currentQuantityRaw >= routine.targetQuantityRaw) {
    terminalEvent = pushDeferred("already_stocked");
  } else if (routine.funding.kind === "lot") {
    const neededRaw = routine.targetQuantityRaw - currentQuantityRaw;
    const cost = routine.funding.unitPriceRaw * neededRaw;
    const currencyBalance = view.currencyLot?.quantityRaw ?? 0;
    if (currencyBalance < cost) {
      terminalEvent = pushDeferred("insufficient_funds");
    } else {
      const currencyQuantityKind =
        view.currencyLot?.quantityKind ?? resolveQuantityKind(RESERVED_CURRENCY_MATERIAL_KIND);
      const currencyLocus = routine.funding.currencyLocus;
      const debitEvent = materialLotAdjustedEventSchema.parse({
        ...eventEnvelope(view, command, sequence, "household-restock-debit"),
        type: "material_lot_adjusted",
        actorIds: [],
        entityIds: sortedUnique(lotLocusEntityIds(currencyLocus)),
        payload: {
          locus: currencyLocus,
          materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
          deltaRaw: -cost,
          resultingQuantityRaw: currencyBalance - cost,
          quantityKind: currencyQuantityKind,
          reason: "restock_purchase",
        },
      });
      events.push(debitEvent);
      sequence += 1;
      nextCurrencyLot = materialLotStateSchema.parse({
        locus: currencyLocus,
        materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
        quantityKind: currencyQuantityKind,
        quantityRaw: currencyBalance - cost,
        registryVersion: view.currencyLot?.registryVersion ?? materialKindRegistryVersion,
      });
      currencyLotUpdatedAtSequence = debitEvent.sequence;

      const creditEvent = materialLotAdjustedEventSchema.parse({
        ...eventEnvelope(view, command, sequence, "household-restock-credit"),
        type: "material_lot_adjusted",
        causationId: debitEvent.id,
        actorIds: [],
        entityIds: sortedUnique(lotLocusEntityIds(householdLocus)),
        payload: {
          locus: householdLocus,
          materialKindKey,
          deltaRaw: neededRaw,
          resultingQuantityRaw: routine.targetQuantityRaw,
          quantityKind,
          reason: "restock_purchase",
        },
      });
      events.push(creditEvent);
      sequence += 1;
      nextStockLot = materialLotStateSchema.parse({
        locus: householdLocus,
        materialKindKey,
        quantityKind,
        quantityRaw: routine.targetQuantityRaw,
        registryVersion: stockRegistryVersion,
      });
      stockLotUpdatedAtSequence = creditEvent.sequence;

      terminalEvent = pushFulfilled(routine.targetQuantityRaw);
    }
  } else {
    // means_band_envelope: fail closed unless the household's OWN means read
    // is band-tracked and at least at the routine's minimum band — a
    // lot-tracked or unknown read has no band to compare, so it cannot be
    // verified sufficient (§26.10's structural precedence: this branch never
    // consults a lot even if one happens to exist for this subject).
    const read = view.householdMeansRead ?? { kind: "unknown" };
    const sufficient =
      read.kind === "band_tracked" && compareMeansBands(read.bandKey, routine.funding.minimumBandKey) >= 0;
    if (!sufficient) {
      terminalEvent = pushDeferred("insufficient_funds");
    } else {
      const creditEvent = materialLotAdjustedEventSchema.parse({
        ...eventEnvelope(view, command, sequence, "household-restock-credit"),
        type: "material_lot_adjusted",
        actorIds: [],
        entityIds: sortedUnique(lotLocusEntityIds(householdLocus)),
        payload: {
          locus: householdLocus,
          materialKindKey,
          deltaRaw: routine.targetQuantityRaw - currentQuantityRaw,
          resultingQuantityRaw: routine.targetQuantityRaw,
          quantityKind,
          reason: "restock_topup_unconserved",
        },
      });
      events.push(creditEvent);
      sequence += 1;
      nextStockLot = materialLotStateSchema.parse({
        locus: householdLocus,
        materialKindKey,
        quantityKind,
        quantityRaw: routine.targetQuantityRaw,
        registryVersion: stockRegistryVersion,
      });
      stockLotUpdatedAtSequence = creditEvent.sequence;

      terminalEvent = pushFulfilled(routine.targetQuantityRaw);
    }
  }

  // Re-arm the next cycle regardless of outcome (§26.11) — a deferred cycle
  // keeps trying.
  events.push(
    buildHouseholdRestockTrigger({
      view,
      command,
      householdId,
      materialKindKey,
      cadenceSeconds: routine.cadenceSeconds,
      sequence,
      causationId: terminalEvent.id,
      armedAtSequence: terminalEvent.sequence,
    }),
  );

  return {
    ok: true,
    events,
    ...(nextStockLot ? { nextStockLot, stockLotUpdatedAtSequence } : {}),
    ...(nextCurrencyLot ? { nextCurrencyLot, currencyLotUpdatedAtSequence } : {}),
  };
}

// ---------------------------------------------------------------------------
// Projection: canonical order, projector, replay, seed
// ---------------------------------------------------------------------------

function compareHouseholds(left: SimulationHousehold, right: SimulationHousehold): number {
  return compareStableText(left.id, right.id);
}

function compareMemberships(left: HouseholdMembership, right: HouseholdMembership): number {
  return (
    compareStableText(left.householdId, right.householdId) || compareStableText(left.actorId, right.actorId)
  );
}

function compareLots(left: MaterialLotState, right: MaterialLotState): number {
  return compareStableText(
    deriveMaterialLotRowKey(left.locus, left.materialKindKey),
    deriveMaterialLotRowKey(right.locus, right.materialKindKey),
  );
}

function compareMeansBandRows(left: MeansBandState, right: MeansBandState): number {
  return compareStableText(deriveMeansSubjectRowKey(left.subject), deriveMeansSubjectRowKey(right.subject));
}

function compareRestockRoutines(left: HouseholdRestockRoutine, right: HouseholdRestockRoutine): number {
  return (
    compareStableText(left.householdId, right.householdId) ||
    compareStableText(left.materialKindKey, right.materialKindKey)
  );
}

/** Canonical ordering shared by live assembly, replay, and hashing. */
export function sortHouseholdsProjection(projection: HouseholdsProjection): HouseholdsProjection {
  return householdsProjectionSchema.parse({
    ...projection,
    households: [...projection.households].sort(compareHouseholds),
    memberships: [...projection.memberships].sort(compareMemberships),
    lots: [...projection.lots].sort(compareLots),
    meansBands: [...projection.meansBands].sort(compareMeansBandRows),
    restockRoutines: [...projection.restockRoutines].sort(compareRestockRoutines),
  });
}

function findLotIndex(lots: readonly MaterialLotState[], locus: LotLocus, materialKindKey: string): number {
  const key = deriveMaterialLotRowKey(locus, materialKindKey);
  return lots.findIndex((lot) => deriveMaterialLotRowKey(lot.locus, lot.materialKindKey) === key);
}

/**
 * Pure synchronous projector for the household event family. It folds seven
 * event types into real state (the six slice-1 rows plus slice-2's restock
 * routine upsert) and passes every other branch event through as a bare
 * boundary advance — the exhaustive passthrough keeps TS exhaustiveness
 * holding so a new event type cannot ship without a ruling.
 */
export function applyHouseholdEvent(
  projection: HouseholdsProjection,
  event: SimulationBranchEvent,
): HouseholdsProjection {
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };
  switch (event.type) {
    case "household_created": {
      const household = simulationHouseholdSchema.parse({
        id: event.payload.householdId,
        name: event.payload.name,
        residenceZoneIds: event.payload.residenceZoneIds,
        stockAccessPolicy: event.payload.stockAccessPolicy,
      });
      return sortHouseholdsProjection({ ...bumped, households: [...projection.households, household] });
    }
    case "household_membership_set": {
      const membership = householdMembershipSchema.parse({
        householdId: event.payload.householdId,
        actorId: event.payload.actorId,
        role: event.payload.role,
        status: event.payload.status,
        ...(event.payload.endedAtStorySecond === undefined
          ? {}
          : { endedAtStorySecond: event.payload.endedAtStorySecond }),
      });
      const existingIndex = projection.memberships.findIndex(
        (candidate) =>
          candidate.householdId === membership.householdId && candidate.actorId === membership.actorId,
      );
      const memberships =
        existingIndex === -1
          ? [...projection.memberships, membership]
          : projection.memberships.map((candidate, index) => (index === existingIndex ? membership : candidate));
      return sortHouseholdsProjection({ ...bumped, memberships });
    }
    case "material_lot_initialized": {
      if (findLotIndex(projection.lots, event.payload.locus, event.payload.materialKindKey) !== -1) {
        throw new Error("Household event replay double-initializes a material lot");
      }
      const lot = materialLotStateSchema.parse({
        locus: event.payload.locus,
        materialKindKey: event.payload.materialKindKey,
        quantityKind: event.payload.quantityKind,
        quantityRaw: 0,
        registryVersion: event.payload.registryVersion,
      });
      return sortHouseholdsProjection({ ...bumped, lots: [...projection.lots, lot] });
    }
    case "material_lot_adjusted": {
      const index = findLotIndex(projection.lots, event.payload.locus, event.payload.materialKindKey);
      const existing = index === -1 ? undefined : projection.lots[index];
      if (!existing) throw new Error("material_lot_adjusted replay references an uninitialized lot");
      const next = materialLotStateSchema.parse({ ...existing, quantityRaw: event.payload.resultingQuantityRaw });
      return sortHouseholdsProjection({
        ...bumped,
        lots: projection.lots.map((candidate, i) => (i === index ? next : candidate)),
      });
    }
    case "material_lot_transferred": {
      const fromIndex = findLotIndex(projection.lots, event.payload.fromLocus, event.payload.materialKindKey);
      const toIndex = findLotIndex(projection.lots, event.payload.toLocus, event.payload.materialKindKey);
      const fromExisting = fromIndex === -1 ? undefined : projection.lots[fromIndex];
      const toExisting = toIndex === -1 ? undefined : projection.lots[toIndex];
      if (!fromExisting || !toExisting) {
        throw new Error("material_lot_transferred replay references an uninitialized lot");
      }
      const fromNext = materialLotStateSchema.parse({
        ...fromExisting,
        quantityRaw: event.payload.resultingFromQuantityRaw,
      });
      const toNext = materialLotStateSchema.parse({
        ...toExisting,
        quantityRaw: event.payload.resultingToQuantityRaw,
      });
      return sortHouseholdsProjection({
        ...bumped,
        lots: projection.lots.map((candidate, i) =>
          i === fromIndex ? fromNext : i === toIndex ? toNext : candidate,
        ),
      });
    }
    case "means_band_set": {
      const band = meansBandStateSchema.parse({
        subject: event.payload.subject,
        bandKey: event.payload.bandKey,
        registryVersion: event.payload.registryVersion,
        setAtStorySecond: event.payload.setAtStorySecond,
      });
      const key = deriveMeansSubjectRowKey(band.subject);
      const existingIndex = projection.meansBands.findIndex(
        (candidate) => deriveMeansSubjectRowKey(candidate.subject) === key,
      );
      const meansBands =
        existingIndex === -1
          ? [...projection.meansBands, band]
          : projection.meansBands.map((candidate, index) => (index === existingIndex ? band : candidate));
      return sortHouseholdsProjection({ ...bumped, meansBands });
    }
    case "household_restock_routine_configured": {
      // `configure_restock_routine` always upserts the row wholesale — the
      // event payload IS the routine (mirrors `means_band_set` above).
      const routine = householdRestockRoutineSchema.parse({
        householdId: event.payload.householdId,
        materialKindKey: event.payload.materialKindKey,
        targetQuantityRaw: event.payload.targetQuantityRaw,
        lowWaterThresholdRaw: event.payload.lowWaterThresholdRaw,
        cadenceSeconds: event.payload.cadenceSeconds,
        funding: event.payload.funding,
        active: event.payload.active,
      });
      const existingIndex = projection.restockRoutines.findIndex(
        (candidate) =>
          candidate.householdId === routine.householdId && candidate.materialKindKey === routine.materialKindKey,
      );
      const restockRoutines =
        existingIndex === -1
          ? [...projection.restockRoutines, routine]
          : projection.restockRoutines.map((candidate, index) => (index === existingIndex ? routine : candidate));
      return sortHouseholdsProjection({ ...bumped, restockRoutines });
    }
    // A promotion mutates lots through its own causally-chained
    // `material_lot_adjusted` companion event (already folded above); the
    // promotion/restock-outcome events themselves carry no lot/routine state
    // of their own for THIS projection to fold — households.ts's job here is
    // only to advance the boundary (materials.ts folds the new item itself).
    case "item_instantiated_from_promotion":
    case "household_restock_fulfilled":
    case "household_restock_deferred":
      return householdsProjectionSchema.parse(bumped);
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
    case "relationship_entry_authored":
    case "relationship_change_recorded":
    case "consent_escalation_resolved":
    case "pressure_acknowledged":
    case "actor_lod_assigned":
    case "routine_policy_resolved":
    case "cohort_created":
    case "cohort_adjusted":
    case "actor_materialized_from_aggregate":
      // Non-household families advance the boundary without touching this projection.
      return householdsProjectionSchema.parse(bumped);
  }
}

export interface HouseholdsReplayInput {
  /** Households are fully evented past their origin (empty) seed — no branch-seed ambiguity. */
  seed: HouseholdsProjection;
  events: readonly SimulationBranchEvent[];
}

/** Fold one branch's full logical stream into its households projection. */
export function replayHouseholdsHistory(input: HouseholdsReplayInput): HouseholdsProjection {
  const seed = sortHouseholdsProjection(householdsProjectionSchema.parse(input.seed));
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(`Households replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`);
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applyHouseholdEvent(projection, event);
    lastSequence = event.sequence;
  }
  return householdsProjectionSchema.parse({ ...projection, version: seed.version + commandIds.size });
}

/** The empty branch-origin households seed — nothing in this domain is ever branch-seeded. */
export function emptyHouseholdsSeed(branchId: string, originStorySecond: number): HouseholdsProjection {
  return householdsProjectionSchema.parse({
    branchId,
    headSequence: 0,
    version: 0,
    storySecond: originStorySecond,
    households: [],
    memberships: [],
    lots: [],
    meansBands: [],
    restockRoutines: [],
  });
}
