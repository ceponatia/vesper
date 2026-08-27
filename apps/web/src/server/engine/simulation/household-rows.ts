import { and, eq, inArray, sql } from "drizzle-orm";
import {
  householdMembershipSchema,
  householdRestockRoutineSchema,
  lotLocusSchema,
  materialLotStateSchema,
  meansBandStateSchema,
  meansSubjectSchema,
  simulationHouseholdSchema,
  type HouseholdMembership,
  type HouseholdRestockRoutine,
  type LotLocus,
  type MaterialLotInitializedEvent,
  type MaterialLotState,
  type MeansBandState,
  type MeansSubject,
  type SimulationHousehold,
} from "@vesper/simulation-core/contracts/households";
import {
  buildMaterialLotInitializedEvent,
  deriveMaterialLotRowKey,
  deriveMeansSubjectRowKey,
  householdRestockUniquenessKey,
  householdRestockUniquenessKeyPrefix,
  initializeLot,
  type HouseholdsResolutionView,
} from "@vesper/simulation-core/households";
import {
  simCharacters,
  simHouseholdMembers,
  type simHouseholdRestockRoutines,
  simHouseholds,
  simMaterialLots,
  simMeansBands,
  simPhysicalLoci,
  simTriggers,
  simZones,
  type Db,
} from "@/server/db";
import { appendSimulationEvent, type LockedBranchView } from "./command-runner";
import { InjectedSimulationCrash } from "./material-store";
import type { SimTx } from "./trigger-projector";

/**
 * The E5.4 household ROW layer: every
 * `sim_households` / `sim_household_members` / `sim_material_lots` /
 * `sim_means_bands` / `sim_household_restock_routines` mapping, the
 * branch-scoped authority context the resolvers read through, the lazy lot
 * lifecycle, the restock alarm plumbing, and the crash-injection / rejection
 * helpers both household command modules share.
 *
 * Its two consumers are siblings, not layers: household-store.ts owns the four
 * §26.8/§26.10/§26.11 identity-and-policy commands, household-lots.ts owns the
 * four lot-moving ones.
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

export function injectCrash(
  configured: DurableHouseholdCrashPoint | undefined,
  point: Exclude<DurableHouseholdCrashPoint, "after_commit">,
): void {
  if (configured === point) throw new InjectedSimulationCrash(point);
}

export function rejectedResult<TCode extends string>(commandId: string, code: TCode, publicReason: string) {
  return {
    status: "rejected" as const,
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes: [],
  };
}

// ---------------------------------------------------------------------------
// Locus <-> row mapping (mirrors material-rows.ts's holding-locus mapping)
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
// itemConditionMeterRowInsert (body-rows.ts / item-condition-store.ts).
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

export function householdRestockRoutineFromRow(
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

export interface HouseholdsAuthorityContext {
  householdsById: Map<string, SimulationHousehold>;
  membershipsByKey: Map<string, HouseholdMembership>;
  actorsById: Map<string, { id: string; name: string }>;
  zoneIds: Set<string>;
  actorZoneById: Map<string, string>;
}

export function membershipKey(householdId: string, actorId: string): string {
  return `${householdId}:${actorId}`;
}

/**
 * Load everything the five slice-1 commands might need to check, in one
 * shot — branch scale keeps this a handful of small selects, not a growth
 * risk, exactly the same tradeoff `loadMaterialResolutionView` documents.
 */
export async function loadHouseholdsAuthorityContext(
  tx: SimTx,
  branchId: string,
): Promise<HouseholdsAuthorityContext> {
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

export function buildHouseholdsResolutionView(context: HouseholdsAuthorityContext): HouseholdsResolutionView {
  return {
    householdById: (householdId) => context.householdsById.get(householdId),
    activeMembership: (householdId, actorId) => context.membershipsByKey.get(membershipKey(householdId, actorId)),
    actorZoneId: (actorId) => context.actorZoneById.get(actorId) ?? null,
  };
}

/** §26.9's `locus_not_found`: whether the locus's referenced household/actor/zone exists. */
export function lotLocusReferenceExists(context: HouseholdsAuthorityContext, locus: LotLocus): boolean {
  switch (locus.kind) {
    case "household":
      return context.householdsById.has(locus.householdId);
    case "actor":
      return context.actorsById.has(locus.actorId);
    case "zone":
      return context.zoneIds.has(locus.zoneId);
  }
}

export async function loadMaterialLotRow(
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

export async function loadMeansBandRow(
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

export interface LotLazyInit {
  lot: MaterialLotState;
  initEvent?: MaterialLotInitializedEvent;
  headSequence: number;
}

export async function loadOrInitializeLot(
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
export async function commitLotInit(
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

export async function updateLotQuantity(
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
// `retirePendingThresholdTriggers` (body-rows.ts).
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
export async function retirePendingRestockTriggers(
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
export async function isRestockArmingLive(
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
export const PROMOTION_STOCK_KIND_PLACEHOLDER = "unspecified";
