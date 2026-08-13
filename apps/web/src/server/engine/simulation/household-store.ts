import { and, eq, inArray, sql } from "drizzle-orm";
import {
  RESERVED_CURRENCY_MATERIAL_KIND,
  adjustMaterialLotCommandResultSchema,
  adjustMaterialLotCommandSchema,
  configureRestockRoutineCommandResultSchema,
  configureRestockRoutineCommandSchema,
  createHouseholdCommandResultSchema,
  createHouseholdCommandSchema,
  householdMembershipSchema,
  householdRestockRoutineSchema,
  lotLocusSchema,
  materialLotStateSchema,
  meansBandStateSchema,
  meansSubjectSchema,
  promoteItemFromStockCommandResultSchema,
  promoteItemFromStockCommandSchema,
  runHouseholdRestockCommandResultSchema,
  runHouseholdRestockCommandSchema,
  setHouseholdMembershipCommandResultSchema,
  setHouseholdMembershipCommandSchema,
  setMeansBandCommandResultSchema,
  setMeansBandCommandSchema,
  simulationHouseholdSchema,
  transferLotQuantityCommandResultSchema,
  transferLotQuantityCommandSchema,
  type AdjustMaterialLotCommand,
  type AdjustMaterialLotCommandResult,
  type ConfigureRestockRoutineCommand,
  type ConfigureRestockRoutineCommandResult,
  type CreateHouseholdCommand,
  type CreateHouseholdCommandResult,
  type HouseholdMembership,
  type HouseholdRestockRoutine,
  type LotLocus,
  type MaterialLotInitializedEvent,
  type MaterialLotState,
  type MeansBandState,
  type MeansRead,
  type MeansSubject,
  type PromoteItemFromStockCommand,
  type PromoteItemFromStockCommandResult,
  type RunHouseholdRestockCommand,
  type RunHouseholdRestockCommandResult,
  type SetHouseholdMembershipCommand,
  type SetHouseholdMembershipCommandResult,
  type SetMeansBandCommand,
  type SetMeansBandCommandResult,
  type SimulationHousehold,
  type TransferLotQuantityCommand,
  type TransferLotQuantityCommandResult,
} from "@/contracts/simulation/households";
import {
  buildMaterialLotInitializedEvent,
  deriveMaterialLotRowKey,
  deriveMeansSubjectRowKey,
  deriveMeansRead,
  householdRestockUniquenessKey,
  householdRestockUniquenessKeyPrefix,
  initializeLot,
  resolveAdjustMaterialLotFromView,
  resolveConfigureRestockRoutineFromView,
  resolveCreateHouseholdFromView,
  resolvePromoteItemFromStockFromView,
  resolveRunHouseholdRestockFromView,
  resolveSetHouseholdMembershipFromView,
  resolveSetMeansBandFromView,
  resolveTransferLotQuantityFromView,
  type HouseholdsResolutionView,
} from "@/lib/simulation/households";
import {
  simCharacters,
  simHouseholdMembers,
  simHouseholdRestockRoutines,
  simHouseholds,
  simItemHoldings,
  simItems,
  simMaterialLots,
  simCohorts,
  simMeansBands,
  simPhysicalLoci,
  simTriggers,
  simWorlds,
  simZones,
  type Db,
} from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { holdingRowFieldsForLocus, InjectedSimulationCrash } from "./material-store";
import { applyTriggerScheduledEvent, type SimTx } from "./trigger-projector";

/**
 * E5.4 slice 1 durable households/lots/means authority (engine.spec
 * §26.8–26.10). Modeled on material-store.ts: every command runs through the
 * shared `runSimulationCommand` shell (§11.1) rather than a hand-rolled
 * transaction, so observation/knowledge/soft-canon/memory folds come free.
 *
 * No triggers or outbox in this slice (both arrive in slice 2 with
 * `configure_restock_routine`/`run_household_restock`), so this store's
 * choreography is simpler than material-store.ts's: event append, one or two
 * projection writes, branch advance.
 */

// ---------------------------------------------------------------------------
// Crash injection (soak-harness failpoints) — mirrors MaterialSubmitOptions.
// ---------------------------------------------------------------------------

export type DurableHouseholdCrashPoint =
  | "after_event_append"
  | "after_projection_update"
  | "after_branch_advance"
  | "after_commit";

export interface HouseholdSubmitOptions {
  database?: Db;
  crashAt?: DurableHouseholdCrashPoint;
  /** See `MaterialSubmitOptions.admitAtLockedVersion` — unused by any slice-1
   * command today (none are trigger-dispatched), kept for shape parity with
   * every other durable store and for slice 2's `run_household_restock`. */
  admitAtLockedVersion?: boolean;
}

function injectCrash(
  configured: DurableHouseholdCrashPoint | undefined,
  point: Exclude<DurableHouseholdCrashPoint, "after_commit">,
): void {
  if (configured === point) throw new InjectedSimulationCrash(point);
}

function rejectedResult<TCode extends string>(commandId: string, code: TCode, publicReason: string) {
  return {
    status: "rejected" as const,
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes: [],
  };
}

// ---------------------------------------------------------------------------
// Locus <-> row mapping (mirrors material-store.ts's holding-locus mapping)
// ---------------------------------------------------------------------------

function lotLocusRowFields(locus: LotLocus): {
  locusKind: "household" | "actor" | "zone";
  householdId: string | null;
  actorId: string | null;
  zoneId: string | null;
} {
  switch (locus.kind) {
    case "household":
      return { locusKind: "household", householdId: locus.householdId, actorId: null, zoneId: null };
    case "actor":
      return { locusKind: "actor", householdId: null, actorId: locus.actorId, zoneId: null };
    case "zone":
      return { locusKind: "zone", householdId: null, actorId: null, zoneId: locus.zoneId };
  }
}

function lotLocusFromRow(row: {
  locusKind: "household" | "actor" | "zone";
  householdId: string | null;
  actorId: string | null;
  zoneId: string | null;
}): LotLocus {
  switch (row.locusKind) {
    case "household":
      return lotLocusSchema.parse({ kind: "household", householdId: row.householdId });
    case "actor":
      return lotLocusSchema.parse({ kind: "actor", actorId: row.actorId });
    case "zone":
      return lotLocusSchema.parse({ kind: "zone", zoneId: row.zoneId });
  }
}

function meansBandSubjectRowFields(subject: MeansSubject): {
  subjectKind: "actor" | "household" | "cohort";
  actorId: string | null;
  householdId: string | null;
  cohortId: string | null;
} {
  switch (subject.kind) {
    case "actor":
      return { subjectKind: "actor", actorId: subject.actorId, householdId: null, cohortId: null };
    case "household":
      return { subjectKind: "household", actorId: null, householdId: subject.householdId, cohortId: null };
    case "cohort":
      return { subjectKind: "cohort", actorId: null, householdId: null, cohortId: subject.cohortId };
  }
}

function meansBandSubjectFromRow(row: {
  subjectKind: "actor" | "household" | "cohort";
  actorId: string | null;
  householdId: string | null;
  cohortId: string | null;
}): MeansSubject {
  switch (row.subjectKind) {
    case "actor":
      return meansSubjectSchema.parse({ kind: "actor", actorId: row.actorId });
    case "household":
      return meansSubjectSchema.parse({ kind: "household", householdId: row.householdId });
    case "cohort":
      return meansSubjectSchema.parse({ kind: "cohort", cohortId: row.cohortId });
  }
}

// ---------------------------------------------------------------------------
// Row mappers + insert shapers — the insert-direction functions are exported
// for branch-store.ts's fork materialization, mirroring bodyMeterRowInsert /
// itemConditionMeterRowInsert (body-store.ts / activity-store.ts).
// ---------------------------------------------------------------------------

function householdFromRow(row: typeof simHouseholds.$inferSelect): SimulationHousehold {
  return simulationHouseholdSchema.parse({
    id: row.householdId,
    name: row.name,
    residenceZoneIds: row.residenceZoneIds,
    stockAccessPolicy: row.stockAccessPolicy,
  });
}

/** `sim_households` carries no `updated_sequence` column (households.spec's migration
 * note — no branching discriminant, so no synthetic key AND no per-row sequence need). */
export function householdRowInsert(
  branchId: string,
  household: SimulationHousehold,
): typeof simHouseholds.$inferInsert {
  return {
    branchId,
    householdId: household.id,
    name: household.name,
    residenceZoneIds: [...household.residenceZoneIds],
    stockAccessPolicy: household.stockAccessPolicy,
  };
}

function householdMembershipFromRow(row: typeof simHouseholdMembers.$inferSelect): HouseholdMembership {
  return householdMembershipSchema.parse({
    householdId: row.householdId,
    actorId: row.actorId,
    role: row.role,
    status: row.status,
    ...(row.endedAtStorySecond === null ? {} : { endedAtStorySecond: row.endedAtStorySecond }),
  });
}

export function householdMemberRowInsert(
  branchId: string,
  membership: HouseholdMembership,
  updatedSequence: number,
): typeof simHouseholdMembers.$inferInsert {
  return {
    branchId,
    householdId: membership.householdId,
    actorId: membership.actorId,
    role: membership.role,
    status: membership.status,
    endedAtStorySecond: membership.endedAtStorySecond ?? null,
    updatedSequence,
  };
}

function materialLotFromRow(row: typeof simMaterialLots.$inferSelect): MaterialLotState {
  return materialLotStateSchema.parse({
    locus: lotLocusFromRow(row),
    materialKindKey: row.materialKindKey,
    quantityKind: row.quantityKind,
    quantityRaw: row.quantityRaw,
    registryVersion: row.registryVersion,
  });
}

export function materialLotRowInsert(
  branchId: string,
  lot: MaterialLotState,
  updatedSequence: number,
): typeof simMaterialLots.$inferInsert {
  return {
    branchId,
    lotKey: deriveMaterialLotRowKey(lot.locus, lot.materialKindKey),
    ...lotLocusRowFields(lot.locus),
    materialKindKey: lot.materialKindKey,
    quantityKind: lot.quantityKind,
    quantityRaw: lot.quantityRaw,
    registryVersion: lot.registryVersion,
    updatedSequence,
  };
}

function meansBandFromRow(row: typeof simMeansBands.$inferSelect): MeansBandState {
  return meansBandStateSchema.parse({
    subject: meansBandSubjectFromRow(row),
    bandKey: row.bandKey,
    registryVersion: row.registryVersion,
    setAtStorySecond: row.setAtStorySecond,
  });
}

export function meansBandRowInsert(
  branchId: string,
  band: MeansBandState,
  updatedSequence: number,
): typeof simMeansBands.$inferInsert {
  return {
    branchId,
    subjectKey: deriveMeansSubjectRowKey(band.subject),
    ...meansBandSubjectRowFields(band.subject),
    bandKey: band.bandKey,
    registryVersion: band.registryVersion,
    setAtStorySecond: band.setAtStorySecond,
    updatedSequence,
  };
}

function householdRestockRoutineFromRow(
  row: typeof simHouseholdRestockRoutines.$inferSelect,
): HouseholdRestockRoutine {
  return householdRestockRoutineSchema.parse({
    householdId: row.householdId,
    materialKindKey: row.materialKindKey,
    targetQuantityRaw: row.targetQuantityRaw,
    lowWaterThresholdRaw: row.lowWaterThresholdRaw,
    cadenceSeconds: row.cadenceSeconds,
    funding: row.funding,
    active: row.active,
  });
}

export function householdRestockRoutineRowInsert(
  branchId: string,
  routine: HouseholdRestockRoutine,
  updatedSequence: number,
): typeof simHouseholdRestockRoutines.$inferInsert {
  return {
    branchId,
    householdId: routine.householdId,
    materialKindKey: routine.materialKindKey,
    targetQuantityRaw: routine.targetQuantityRaw,
    lowWaterThresholdRaw: routine.lowWaterThresholdRaw,
    cadenceSeconds: routine.cadenceSeconds,
    funding: routine.funding,
    active: routine.active,
    updatedSequence,
  };
}

// ---------------------------------------------------------------------------
// Authority view — lock-consistent, loaded fresh inside every command
// ---------------------------------------------------------------------------

interface HouseholdsAuthorityContext {
  householdsById: Map<string, SimulationHousehold>;
  membershipsByKey: Map<string, HouseholdMembership>;
  actorsById: Map<string, { id: string; name: string }>;
  zoneIds: Set<string>;
  actorZoneById: Map<string, string>;
}

function membershipKey(householdId: string, actorId: string): string {
  return `${householdId}:${actorId}`;
}

/**
 * Load everything the five slice-1 commands might need to check, in one
 * shot — branch scale keeps this a handful of small selects, not a growth
 * risk, exactly the same tradeoff `loadMaterialResolutionView` documents.
 */
async function loadHouseholdsAuthorityContext(tx: SimTx, branchId: string): Promise<HouseholdsAuthorityContext> {
  const [householdRows, membershipRows, characterRows, zoneRows, locusRows] = await Promise.all([
    tx.select().from(simHouseholds).where(eq(simHouseholds.branchId, branchId)),
    tx.select().from(simHouseholdMembers).where(eq(simHouseholdMembers.branchId, branchId)),
    tx
      .select({ characterId: simCharacters.characterId, name: simCharacters.name })
      .from(simCharacters)
      .where(eq(simCharacters.branchId, branchId)),
    tx.select({ zoneId: simZones.zoneId }).from(simZones).where(eq(simZones.branchId, branchId)),
    tx
      .select({ actorId: simPhysicalLoci.actorId, kind: simPhysicalLoci.kind, zoneId: simPhysicalLoci.zoneId })
      .from(simPhysicalLoci)
      .where(eq(simPhysicalLoci.branchId, branchId)),
  ]);

  const actorZoneById = new Map<string, string>();
  for (const row of locusRows) {
    if (row.kind === "at" && row.zoneId !== null) actorZoneById.set(row.actorId, row.zoneId);
  }

  return {
    householdsById: new Map(householdRows.map((row) => [row.householdId, householdFromRow(row)])),
    membershipsByKey: new Map(
      membershipRows.map((row) => [membershipKey(row.householdId, row.actorId), householdMembershipFromRow(row)]),
    ),
    actorsById: new Map(characterRows.map((row) => [row.characterId, { id: row.characterId, name: row.name }])),
    zoneIds: new Set(zoneRows.map((row) => row.zoneId)),
    actorZoneById,
  };
}

function buildHouseholdsResolutionView(context: HouseholdsAuthorityContext): HouseholdsResolutionView {
  return {
    householdById: (householdId) => context.householdsById.get(householdId),
    activeMembership: (householdId, actorId) => context.membershipsByKey.get(membershipKey(householdId, actorId)),
    actorZoneId: (actorId) => context.actorZoneById.get(actorId) ?? null,
  };
}

/** §26.9's `locus_not_found`: whether the locus's referenced household/actor/zone exists. */
function lotLocusReferenceExists(context: HouseholdsAuthorityContext, locus: LotLocus): boolean {
  switch (locus.kind) {
    case "household":
      return context.householdsById.has(locus.householdId);
    case "actor":
      return context.actorsById.has(locus.actorId);
    case "zone":
      return context.zoneIds.has(locus.zoneId);
  }
}

async function loadMaterialLotRow(
  tx: SimTx,
  branchId: string,
  locus: LotLocus,
  materialKindKey: string,
): Promise<MaterialLotState | undefined> {
  const lotKey = deriveMaterialLotRowKey(locus, materialKindKey);
  const [row] = await tx
    .select()
    .from(simMaterialLots)
    .where(and(eq(simMaterialLots.branchId, branchId), eq(simMaterialLots.lotKey, lotKey)))
    .limit(1);
  return row ? materialLotFromRow(row) : undefined;
}

async function loadMeansBandRow(
  tx: SimTx,
  branchId: string,
  subjectKey: string,
): Promise<MeansBandState | undefined> {
  const [row] = await tx
    .select()
    .from(simMeansBands)
    .where(and(eq(simMeansBands.branchId, branchId), eq(simMeansBands.subjectKey, subjectKey)))
    .limit(1);
  return row ? meansBandFromRow(row) : undefined;
}

// ---------------------------------------------------------------------------
// Lazy lot initialization (§26.9 — "a lot's row persists indefinitely once
// initialized (lazily, on first touch)"). Mirrors
// `loadOrInitializeItemConditionView`: build the init event purely in memory
// at the given head sequence; the caller commits it ONLY after its own
// causing resolver accepts, exactly like `commitItemConditionInit`'s call
// site in material-store.ts — a rejected command must never leave a lazily-
// built init event's row behind.
// ---------------------------------------------------------------------------

interface LotLazyInit {
  lot: MaterialLotState;
  initEvent?: MaterialLotInitializedEvent;
  headSequence: number;
}

async function loadOrInitializeLot(
  tx: SimTx,
  branch: LockedBranchView,
  command: { id: string; correlationId: string; submittedAtWallClock: string },
  locus: LotLocus,
  materialKindKey: string,
  atHeadSequence: number,
): Promise<LotLazyInit> {
  const existing = await loadMaterialLotRow(tx, branch.id, locus, materialKindKey);
  if (existing) return { lot: existing, headSequence: atHeadSequence };

  const lot = initializeLot(locus, materialKindKey);
  const initEvent = buildMaterialLotInitializedEvent({
    view: {
      worldId: branch.worldId,
      branchId: branch.id,
      rulesetVersion: branch.rulesetVersion,
      headSequence: atHeadSequence,
      storySecond: branch.storySecond,
    },
    command,
    locus,
    materialKindKey,
    quantityKind: lot.quantityKind,
    sequence: atHeadSequence + 1,
  });
  return { lot, initEvent, headSequence: initEvent.sequence };
}

/** Persist a just-built lazy-init event: the event row, then its lot row at zero. */
async function commitLotInit(
  tx: SimTx,
  branch: LockedBranchView,
  initEvent: MaterialLotInitializedEvent | undefined,
): Promise<void> {
  if (!initEvent) return;
  await appendSimulationEvent(tx, initEvent);
  const lot = materialLotStateSchema.parse({
    locus: initEvent.payload.locus,
    materialKindKey: initEvent.payload.materialKindKey,
    quantityKind: initEvent.payload.quantityKind,
    quantityRaw: 0,
    registryVersion: initEvent.payload.registryVersion,
  });
  await tx.insert(simMaterialLots).values(materialLotRowInsert(branch.id, lot, initEvent.sequence));
}

async function updateLotQuantity(
  tx: SimTx,
  branchId: string,
  locus: LotLocus,
  materialKindKey: string,
  quantityRaw: number,
  updatedSequence: number,
): Promise<void> {
  const lotKey = deriveMaterialLotRowKey(locus, materialKindKey);
  const updated = await tx
    .update(simMaterialLots)
    .set({ quantityRaw, updatedSequence })
    .where(and(eq(simMaterialLots.branchId, branchId), eq(simMaterialLots.lotKey, lotKey)))
    .returning({ lotKey: simMaterialLots.lotKey });
  if (updated.length !== 1) throw new Error("Locked material lot changed before its quantity update");
}

// ---------------------------------------------------------------------------
// Household restock alarm plumbing (§26.11) — mirrors
// `retirePendingThresholdTriggers` (body-store.ts).
// ---------------------------------------------------------------------------

/**
 * Retire every non-terminal `household_restock_due` alarm for this
 * (householdId, materialKindKey) — both `pending` rows AND rows a scheduler
 * worker has already claimed into `processing` but not yet dispatched.
 *
 * That second half matters: `claimDueTrigger` (scheduler-store.ts) claims a
 * due trigger into `processing` and COMMITS in its own transaction before
 * `dispatch()` opens the separate, later transaction that actually resolves
 * it. Because every command transaction locks `sim_branches` FOR UPDATE
 * (command-runner.ts), this reconfigure and that dispatch can never overlap
 * in wall-clock time — one fully commits before the other's transaction
 * begins — but a reconfigure landing in exactly that claim/dispatch gap must
 * still invalidate the claimed row, or `isRestockArmingLive` (which reads
 * this row's state, not the routine's) would see a live, non-retired
 * `processing` row and let the stale cycle proceed under the new routine,
 * then unconditionally re-arm a second live trigger alongside the one this
 * reconfigure just armed. Retiring `processing` rows here closes that gap:
 * the stale dispatch's `isRestockArmingLive` check now correctly reads
 * `completed` and fails closed to `threshold_stale` (§5.8) instead of
 * double-arming. The scheduler's own post-dispatch completion write is
 * fenced on `state = 'processing'` (scheduler-store.ts), so it simply no-ops
 * to `lease_lost` when it finds this row already retired — no crash, no
 * double write.
 */
async function retirePendingRestockTriggers(
  tx: SimTx,
  branch: LockedBranchView,
  commandId: string,
  submittedAtWallClock: string,
  householdId: string,
  materialKindKey: string,
): Promise<void> {
  const prefix = householdRestockUniquenessKeyPrefix(householdId, materialKindKey);
  await tx
    .update(simTriggers)
    .set({
      state: "completed",
      resultCommandId: commandId,
      completedAt: new Date(submittedAtWallClock),
    })
    .where(
      and(
        eq(simTriggers.branchId, branch.id),
        inArray(simTriggers.state, ["pending", "processing"]),
        sql`starts_with(${simTriggers.uniquenessKey}, ${prefix})`,
      ),
    );
}

/**
 * Whether THIS command's own `armedAtSequence` names an alarm row that has
 * not been retired by a later reconfigure (§5.8's staleness defense) — the
 * durable stand-in for "the routine's current arming", since routines carry
 * no arming column of their own. Deliberately NOT a `state = 'pending'`
 * filter: at dispatch time the scheduler has already claimed this exact row
 * into `processing` (see `resolveNextDueTrigger`), so "pending" would never
 * match the live, in-flight arming — only a row a reconfigure's unconditional
 * retirement already flipped to `completed` (or `failed`) counts as stale.
 */
async function isRestockArmingLive(
  tx: SimTx,
  branchId: string,
  householdId: string,
  materialKindKey: string,
  armedAtSequence: number,
): Promise<boolean> {
  const uniquenessKey = householdRestockUniquenessKey(householdId, materialKindKey, armedAtSequence);
  const [row] = await tx
    .select({ state: simTriggers.state })
    .from(simTriggers)
    .where(and(eq(simTriggers.branchId, branchId), eq(simTriggers.uniquenessKey, uniquenessKey)))
    .limit(1);
  return row !== undefined && row.state !== "completed" && row.state !== "failed";
}

/**
 * A stock kind key never actually consulted: `promote_item_from_stock`'s
 * resolver rejects `invalid_funding_kind` before reading the lazily-loaded
 * lot whenever `stock` funding names an item with no declared
 * `materialKindKey` — this placeholder only satisfies `loadOrInitializeLot`'s
 * non-empty-key requirement for that dead lookup; no row under this key is
 * ever committed (a rejected command never calls `commitLotInit`).
 */
const PROMOTION_STOCK_KIND_PLACEHOLDER = "unspecified";

// ---------------------------------------------------------------------------
// create_household (§26.8)
// ---------------------------------------------------------------------------

export async function submitDurableCreateHousehold(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<CreateHouseholdCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: createHouseholdCommandSchema,
    resultSchema: createHouseholdCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That household request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That household request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      createHouseholdCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: CreateHouseholdCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      const resolution = resolveCreateHouseholdFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          householdExists: context.householdsById.has(command.payload.householdId),
          zoneExists: (zoneId) => context.zoneIds.has(zoneId),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await tx.insert(simHouseholds).values(
        householdRowInsert(branch.id, {
          id: event.payload.householdId,
          name: event.payload.name,
          residenceZoneIds: event.payload.residenceZoneIds,
          stockAccessPolicy: event.payload.stockAccessPolicy,
        }),
      );
      injectCrash(options.crashAt, "after_projection_update");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        eventIds: [event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// set_household_membership (§26.8)
// ---------------------------------------------------------------------------

export async function submitDurableSetHouseholdMembership(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<SetHouseholdMembershipCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: setHouseholdMembershipCommandSchema,
    resultSchema: setHouseholdMembershipCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That membership request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That membership request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      setHouseholdMembershipCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: SetHouseholdMembershipCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      const resolution = resolveSetHouseholdMembershipFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          householdExists: context.householdsById.has(command.payload.householdId),
          actorExists: context.actorsById.has(command.payload.actorId),
          currentMembership: context.membershipsByKey.get(
            membershipKey(command.payload.householdId, command.payload.actorId),
          ),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      const membership: HouseholdMembership = {
        householdId: event.payload.householdId,
        actorId: event.payload.actorId,
        role: event.payload.role,
        status: event.payload.status,
        ...(event.payload.endedAtStorySecond === undefined
          ? {}
          : { endedAtStorySecond: event.payload.endedAtStorySecond }),
      };
      await tx
        .insert(simHouseholdMembers)
        .values(householdMemberRowInsert(branch.id, membership, event.sequence))
        .onConflictDoUpdate({
          target: [simHouseholdMembers.branchId, simHouseholdMembers.householdId, simHouseholdMembers.actorId],
          set: {
            role: membership.role,
            status: membership.status,
            endedAtStorySecond: membership.endedAtStorySecond ?? null,
            updatedSequence: event.sequence,
          },
        });
      injectCrash(options.crashAt, "after_projection_update");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        eventIds: [event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// adjust_material_lot (§26.9) — privileged authoring, exempt from co-location
// ---------------------------------------------------------------------------

export async function submitDurableAdjustMaterialLot(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<AdjustMaterialLotCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: adjustMaterialLotCommandSchema,
    resultSchema: adjustMaterialLotCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That stock adjustment is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That stock adjustment has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      adjustMaterialLotCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: AdjustMaterialLotCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      const localeExists = lotLocusReferenceExists(context, command.payload.locus);
      const lazy = await loadOrInitializeLot(
        tx,
        branch,
        command,
        command.payload.locus,
        command.payload.materialKindKey,
        branch.headSequence,
      );

      const resolution = resolveAdjustMaterialLotFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: lazy.headSequence,
          storySecond: branch.storySecond,
          localeExists,
          lot: lazy.lot,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await commitLotInit(tx, branch, lazy.initEvent);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await updateLotQuantity(
        tx,
        branch.id,
        command.payload.locus,
        command.payload.materialKindKey,
        resolution.nextLot.quantityRaw,
        event.sequence,
      );
      injectCrash(options.crashAt, "after_projection_update");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: lazy.initEvent?.sequence ?? event.sequence,
        lastSequence: event.sequence,
        eventIds: [...(lazy.initEvent ? [lazy.initEvent.id] : []), event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// transfer_lot_quantity (§26.9) — same-kind conserved movement between lots
// ---------------------------------------------------------------------------

export async function submitDurableTransferLotQuantity(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<TransferLotQuantityCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: transferLotQuantityCommandSchema,
    resultSchema: transferLotQuantityCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That stock transfer is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That stock transfer has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      transferLotQuantityCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: TransferLotQuantityCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      // Deterministic order (§5.4): source, then destination.
      const fromLazy = await loadOrInitializeLot(
        tx,
        branch,
        command,
        command.payload.fromLocus,
        command.payload.materialKindKey,
        branch.headSequence,
      );
      const toLazy = await loadOrInitializeLot(
        tx,
        branch,
        command,
        command.payload.toLocus,
        command.payload.materialKindKey,
        fromLazy.headSequence,
      );

      const resolution = resolveTransferLotQuantityFromView(
        {
          ...buildHouseholdsResolutionView(context),
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: toLazy.headSequence,
          storySecond: branch.storySecond,
          actorById: (actorId) => context.actorsById.get(actorId),
          fromLot: fromLazy.lot,
          toLot: toLazy.lot,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await commitLotInit(tx, branch, fromLazy.initEvent);
      await commitLotInit(tx, branch, toLazy.initEvent);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await updateLotQuantity(
        tx,
        branch.id,
        command.payload.fromLocus,
        command.payload.materialKindKey,
        resolution.nextFromLot.quantityRaw,
        event.sequence,
      );
      await updateLotQuantity(
        tx,
        branch.id,
        command.payload.toLocus,
        command.payload.materialKindKey,
        resolution.nextToLot.quantityRaw,
        event.sequence,
      );
      injectCrash(options.crashAt, "after_projection_update");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      const initEventIds = [
        ...(fromLazy.initEvent ? [fromLazy.initEvent.id] : []),
        ...(toLazy.initEvent ? [toLazy.initEvent.id] : []),
      ];
      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: fromLazy.initEvent?.sequence ?? toLazy.initEvent?.sequence ?? event.sequence,
        lastSequence: event.sequence,
        eventIds: [...initEventIds, event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// set_means_band (§26.10)
// ---------------------------------------------------------------------------

export async function submitDurableSetMeansBand(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<SetMeansBandCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: setMeansBandCommandSchema,
    resultSchema: setMeansBandCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That means band request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That means band request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      setMeansBandCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: SetMeansBandCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      const subject = command.payload.subject;
      const subjectExists =
        subject.kind === "actor"
          ? context.actorsById.has(subject.actorId)
          : subject.kind === "household"
            ? context.householdsById.has(subject.householdId)
            : (
                await tx
                  .select({ cohortId: simCohorts.cohortId })
                  .from(simCohorts)
                  .where(and(eq(simCohorts.branchId, branch.id), eq(simCohorts.cohortId, subject.cohortId)))
                  .limit(1)
              ).length > 0;
      const currentBand = await loadMeansBandRow(tx, branch.id, deriveMeansSubjectRowKey(subject));

      const resolution = resolveSetMeansBandFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          subjectExists,
          currentBand,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      const band: MeansBandState = {
        subject: event.payload.subject,
        bandKey: event.payload.bandKey,
        registryVersion: event.payload.registryVersion,
        setAtStorySecond: event.payload.setAtStorySecond,
      };
      await tx
        .insert(simMeansBands)
        .values(meansBandRowInsert(branch.id, band, event.sequence))
        .onConflictDoUpdate({
          target: [simMeansBands.branchId, simMeansBands.subjectKey],
          set: {
            bandKey: band.bandKey,
            registryVersion: band.registryVersion,
            setAtStorySecond: band.setAtStorySecond,
            updatedSequence: event.sequence,
          },
        });
      injectCrash(options.crashAt, "after_projection_update");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        eventIds: [event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// configure_restock_routine (§26.11)
// ---------------------------------------------------------------------------

export async function submitDurableConfigureRestockRoutine(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<ConfigureRestockRoutineCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: configureRestockRoutineCommandSchema,
    resultSchema: configureRestockRoutineCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That restock routine request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(
        commandId,
        "duplicate_command_id",
        "That restock routine request has already been submitted.",
      ),
    conflictResult: (commandId, currentVersion) =>
      configureRestockRoutineCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: ConfigureRestockRoutineCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      const resolution = resolveConfigureRestockRoutineFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          householdExists: context.householdsById.has(command.payload.householdId),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      // Unconditionally retire any pending alarm for this (householdId,
      // materialKindKey) BEFORE arming a fresh one (§5.6) — a reconfigure
      // always invalidates whether or not a fresh arm follows.
      await retirePendingRestockTriggers(
        tx,
        branch,
        command.id,
        command.submittedAtWallClock,
        command.payload.householdId,
        command.payload.materialKindKey,
      );

      const [configuredEvent, ...triggerEvents] = resolution.events;
      await appendSimulationEvent(tx, configuredEvent);
      for (const triggerEvent of triggerEvents) {
        await appendSimulationEvent(tx, triggerEvent);
        await applyTriggerScheduledEvent(tx, triggerEvent, { branchId: branch.id, worldId: branch.worldId });
      }
      injectCrash(options.crashAt, "after_event_append");

      const routine: HouseholdRestockRoutine = {
        householdId: configuredEvent.payload.householdId,
        materialKindKey: configuredEvent.payload.materialKindKey,
        targetQuantityRaw: configuredEvent.payload.targetQuantityRaw,
        lowWaterThresholdRaw: configuredEvent.payload.lowWaterThresholdRaw,
        cadenceSeconds: configuredEvent.payload.cadenceSeconds,
        funding: configuredEvent.payload.funding,
        active: configuredEvent.payload.active,
      };
      await tx
        .insert(simHouseholdRestockRoutines)
        .values(householdRestockRoutineRowInsert(branch.id, routine, configuredEvent.sequence))
        .onConflictDoUpdate({
          target: [
            simHouseholdRestockRoutines.branchId,
            simHouseholdRestockRoutines.householdId,
            simHouseholdRestockRoutines.materialKindKey,
          ],
          set: {
            targetQuantityRaw: routine.targetQuantityRaw,
            lowWaterThresholdRaw: routine.lowWaterThresholdRaw,
            cadenceSeconds: routine.cadenceSeconds,
            funding: routine.funding,
            active: routine.active,
            updatedSequence: configuredEvent.sequence,
          },
        });
      injectCrash(options.crashAt, "after_projection_update");

      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? configuredEvent.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: configuredEvent.sequence,
        lastSequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// promote_item_from_stock (§26.10 / §27.2) — the only path an aggregate fact
// becomes an explicit `sim_items` row
// ---------------------------------------------------------------------------

export async function submitDurablePromoteItemFromStock(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<PromoteItemFromStockCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: promoteItemFromStockCommandSchema,
    resultSchema: promoteItemFromStockCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That promotion request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That promotion request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      promoteItemFromStockCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: PromoteItemFromStockCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      const [worldRow] = await tx
        .select({ seed: simWorlds.seed })
        .from(simWorlds)
        .where(eq(simWorlds.id, branch.worldId))
        .limit(1);
      if (!worldRow) throw new Error("Locked simulation branch references a missing world");

      const { funding, item } = command.payload;
      const fundingLocus = funding.kind === "stock" ? funding.sourceLocus : funding.currencyLocus;
      const fundingMaterialKindKey =
        funding.kind === "stock"
          ? (item.materialKindKey ?? PROMOTION_STOCK_KIND_PLACEHOLDER)
          : RESERVED_CURRENCY_MATERIAL_KIND;
      const lazy = await loadOrInitializeLot(
        tx,
        branch,
        command,
        fundingLocus,
        fundingMaterialKindKey,
        branch.headSequence,
      );

      const resolution = resolvePromoteItemFromStockFromView(
        {
          ...buildHouseholdsResolutionView(context),
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: lazy.headSequence,
          storySecond: branch.storySecond,
          actorById: (actorId) => context.actorsById.get(actorId),
          fundingLot: lazy.lot,
          // No name pool is authored anywhere yet (E5.4 slice 2) — a caller
          // that omits `item.name` must supply it explicitly until one is.
          namePool: () => [],
          worldSeed: worldRow.seed,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await commitLotInit(tx, branch, lazy.initEvent);

      await appendSimulationEvent(tx, resolution.lotAdjustedEvent);
      await appendSimulationEvent(tx, resolution.itemEvent);
      injectCrash(options.crashAt, "after_event_append");

      await updateLotQuantity(
        tx,
        branch.id,
        fundingLocus,
        resolution.lotAdjustedEvent.payload.materialKindKey,
        resolution.nextFundingLot.quantityRaw,
        resolution.lotAdjustedEvent.sequence,
      );

      const newItem = resolution.itemEvent.payload.item;
      await tx.insert(simItems).values({
        branchId: branch.id,
        itemId: newItem.id,
        name: newItem.name,
        materialKindKey: newItem.materialKindKey ?? null,
        consumptionEffects: newItem.consumptionEffects ?? null,
        ownerActorId: newItem.ownerActorId,
        containerCapacityCount: newItem.container?.capacityCount ?? null,
        containerAccess: newItem.container?.access ?? null,
        conditionTracked: newItem.conditionTracked,
      });
      await tx.insert(simItemHoldings).values({
        branchId: branch.id,
        itemId: newItem.id,
        updatedSequence: resolution.itemEvent.sequence,
        ...holdingRowFieldsForLocus(newItem.locus),
      });
      injectCrash(options.crashAt, "after_projection_update");

      const lastSequence = resolution.itemEvent.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: lazy.initEvent?.sequence ?? resolution.lotAdjustedEvent.sequence,
        lastSequence,
        eventIds: [
          ...(lazy.initEvent ? [lazy.initEvent.id] : []),
          resolution.lotAdjustedEvent.id,
          resolution.itemEvent.id,
        ],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// run_household_restock (§26.11) — trigger-dispatched, system principal only
// ---------------------------------------------------------------------------

export async function submitDurableRunHouseholdRestock(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<RunHouseholdRestockCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: runHouseholdRestockCommandSchema,
    resultSchema: runHouseholdRestockCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That restock cycle is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That restock cycle has already run."),
    conflictResult: (commandId, currentVersion) =>
      runHouseholdRestockCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: RunHouseholdRestockCommand) => {
      const { householdId, materialKindKey } = command.payload;
      const householdLocus: LotLocus = { kind: "household", householdId };

      const [routineRow] = await tx
        .select()
        .from(simHouseholdRestockRoutines)
        .where(
          and(
            eq(simHouseholdRestockRoutines.branchId, branch.id),
            eq(simHouseholdRestockRoutines.householdId, householdId),
            eq(simHouseholdRestockRoutines.materialKindKey, materialKindKey),
          ),
        )
        .limit(1);
      const routine = routineRow ? householdRestockRoutineFromRow(routineRow) : undefined;

      const armingIsLive = await isRestockArmingLive(
        tx,
        branch.id,
        householdId,
        materialKindKey,
        command.payload.armedAtSequence,
      );

      // The stock lot may be untouched on this household+kind's first cycle —
      // lazy-init it up front, mirroring adjust_material_lot/
      // transfer_lot_quantity, so a fulfilled outcome always has a real row
      // to update.
      const stockLazy = await loadOrInitializeLot(
        tx,
        branch,
        command,
        householdLocus,
        materialKindKey,
        branch.headSequence,
      );

      // The currency lot (`lot` funding only) is read-only here: whenever
      // this command has anything to fund, the cost is strictly positive, so
      // a missing row (balance treated as zero) always resolves
      // insufficient_funds — no lazy init, and no write ever targets it when
      // absent.
      const currencyLot =
        routine?.funding.kind === "lot"
          ? await loadMaterialLotRow(tx, branch.id, routine.funding.currencyLocus, RESERVED_CURRENCY_MATERIAL_KIND)
          : undefined;

      const householdMeansSubject: MeansSubject = { kind: "household", householdId };
      let householdMeansRead: MeansRead | undefined;
      if (routine?.funding.kind === "means_band_envelope") {
        const householdCurrencyLot = await loadMaterialLotRow(
          tx,
          branch.id,
          householdLocus,
          RESERVED_CURRENCY_MATERIAL_KIND,
        );
        const householdBand = await loadMeansBandRow(tx, branch.id, deriveMeansSubjectRowKey(householdMeansSubject));
        householdMeansRead = deriveMeansRead(householdMeansSubject, {
          currencyLot: () => householdCurrencyLot,
          band: () => householdBand,
        });
      }

      const resolution = resolveRunHouseholdRestockFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: stockLazy.headSequence,
          storySecond: branch.storySecond,
          routine,
          armingIsLive,
          stockLot: stockLazy.lot,
          currencyLot,
          householdMeansRead,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await commitLotInit(tx, branch, stockLazy.initEvent);

      for (const event of resolution.events) {
        await appendSimulationEvent(tx, event);
        if (event.type === "trigger_scheduled") {
          await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
        }
      }
      injectCrash(options.crashAt, "after_event_append");

      if (resolution.nextStockLot && resolution.stockLotUpdatedAtSequence !== undefined) {
        await updateLotQuantity(
          tx,
          branch.id,
          resolution.nextStockLot.locus,
          resolution.nextStockLot.materialKindKey,
          resolution.nextStockLot.quantityRaw,
          resolution.stockLotUpdatedAtSequence,
        );
      }
      if (resolution.nextCurrencyLot && resolution.currencyLotUpdatedAtSequence !== undefined) {
        await updateLotQuantity(
          tx,
          branch.id,
          resolution.nextCurrencyLot.locus,
          resolution.nextCurrencyLot.materialKindKey,
          resolution.nextCurrencyLot.quantityRaw,
          resolution.currencyLotUpdatedAtSequence,
        );
      }
      injectCrash(options.crashAt, "after_projection_update");

      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? stockLazy.headSequence;
      await advanceLockedBranch(tx, branch, lastSequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: stockLazy.initEvent?.sequence ?? resolution.events[0]?.sequence ?? lastSequence,
        lastSequence,
        eventIds: [
          ...(stockLazy.initEvent ? [stockLazy.initEvent.id] : []),
          ...resolution.events.map((event) => event.id),
        ],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}
