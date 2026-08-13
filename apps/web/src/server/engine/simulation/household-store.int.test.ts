import { and, asc, desc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  RESERVED_CURRENCY_MATERIAL_KIND,
  householdMembershipSchema,
  householdRestockRoutineSchema,
  lotLocusSchema,
  materialLotStateSchema,
  meansBandStateSchema,
  meansSubjectSchema,
  promotedItemInputSchema,
  simulationHouseholdSchema,
  type HouseholdMembership,
  type HouseholdRestockRoutine,
  type LotLocus,
  type MaterialLotState,
  type MeansBandKey,
  type MeansBandState,
  type MeansSubject,
  type PromotionFunding,
  type SimulationHousehold,
} from "@/contracts/simulation/households";
import { newId } from "@/lib/ids";
import {
  deriveMaterialLotRowKey,
  deriveMeansRead,
  deriveMeansSubjectRowKey,
  emptyHouseholdsSeed,
  replayHouseholdsHistory,
  simulationHash,
  sortHouseholdsProjection,
} from "@/lib/simulation";
import {
  db,
  simBranches,
  simEvents,
  simHouseholdMembers,
  simHouseholdRestockRoutines,
  simHouseholds,
  simItemHoldings,
  simItems,
  simMaterialLots,
  simMeansBands,
  simTriggers,
} from "@/server/db";
import {
  expectAccepted,
  expectRejected,
  forkAtHead,
  gmPrincipal,
  latestEventPayload,
  playerPrincipal,
  readBranchEvents,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
  systemPrincipal,
  type SimCommandEnvelope,
} from "@/server/test-support";
import {
  submitDurableAdjustMaterialLot,
  submitDurableConfigureRestockRoutine,
  submitDurableCreateHousehold,
  submitDurablePromoteItemFromStock,
  submitDurableRunHouseholdRestock,
  submitDurableSetHouseholdMembership,
  submitDurableSetMeansBand,
  submitDurableTransferLotQuantity,
} from "./household-store";
import { InjectedSimulationCrash, submitDurableTransferItem } from "./material-store";
import { advanceBranchStoryTime } from "./scheduler-store";

/**
 * E5.4 slice 1 durable households/lots/means substrate (engine.spec
 * §26.8–26.10), on the shared `simulationSuiteHarness` scaffold.
 *
 * `sim_household_members` has no direct `branch_id -> sim_branches` cascade
 * FK (unlike `sim_households`/`sim_material_lots`/`sim_means_bands`, which
 * all declare one) — only deferred, non-cascading FKs to `sim_households`
 * and `sim_characters`. Deleting a world whose branch carries membership
 * rows therefore fails at commit (the deferred household/actor FK finds its
 * parent row already cascade-gone). That is exactly what the harness's
 * `trackBranchMembers` option handles: it deletes `sim_household_members`
 * for every tracked branch (including forked children — hence the
 * `harness.trackBranch` call at each fork) ahead of the `sim_worlds` delete,
 * routing around the gap without touching schema/migrations.
 */

const harness = await simulationSuiteHarness({
  suite: "household-store.int.test",
  table: "sim_households",
  trackBranchMembers: true,
});

const SEED_SECOND = 60_000;

interface HouseholdCase {
  worldId: string;
  branchId: string;
  locationId: string;
  /** The household's one residence zone. */
  zoneHome: string;
  /** A zone outside the household's residence — never reachable by it. */
  zoneAway: string;
  /** Co-located with iris/mara at zoneHome. */
  mara: string;
  iris: string;
  /** At zoneAway — never a member, never co-located with the household. */
  outsider: string;
}

function makeIds(): HouseholdCase {
  const worldId = newId();
  const branchId = newId();
  return {
    worldId,
    branchId,
    locationId: `${worldId}-loc-home`,
    zoneHome: `${branchId}-zone-home`,
    zoneAway: `${branchId}-zone-away`,
    mara: newId(),
    iris: newId(),
    outsider: newId(),
  };
}

async function seedCase(ids: HouseholdCase): Promise<void> {
  harness.trackWorld(ids.worldId);
  harness.trackBranch(ids.branchId);
  await seedSimBranch({
    worldId: ids.worldId,
    branchId: ids.branchId,
    worldTypeId: "e5-4-test-world",
    rulesetVersion: "e5-4-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.mara, name: "Mara" },
      { id: ids.iris, name: "Iris" },
      { id: ids.outsider, name: "Rhea" },
    ],
    locations: [{ id: ids.locationId, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" }],
    zones: [
      { id: ids.zoneHome, locationId: ids.locationId, kind: "room", privacyPolicy: "private" },
      { id: ids.zoneAway, locationId: ids.locationId, kind: "room", privacyPolicy: "private" },
    ],
    links: [],
    placements: [
      { actorId: ids.mara, locationId: ids.locationId, zoneId: ids.zoneHome },
      { actorId: ids.iris, locationId: ids.locationId, zoneId: ids.zoneHome },
      { actorId: ids.outsider, locationId: ids.locationId, zoneId: ids.zoneAway },
    ],
  });
}

// ---------------------------------------------------------------------------
// Locus / subject builders + command builders. Each keeps its TYPED input
// object (so a fixture's `funding`/`locus`/`subject` is still checked at
// compile time) and delegates the envelope itself to the shared `simCommand`.
// `name` is the per-command label the shared builder derives the command id
// and idempotency key from, so it must be unique per branch within a test.
// ---------------------------------------------------------------------------

const householdLocus = (householdId: string): LotLocus => lotLocusSchema.parse({ kind: "household", householdId });
const actorLocus = (actorId: string): LotLocus => lotLocusSchema.parse({ kind: "actor", actorId });

function createHouseholdCmd(input: {
  branchId: string;
  name: string;
  householdId: string;
  householdName: string;
  residenceZoneIds: string[];
  stockAccessPolicy: { kind: "members_only" } | { kind: "allow_list"; actorIds: string[] };
  expectedVersion: number;
}): SimCommandEnvelope {
  return simCommand({
    branchId: input.branchId,
    name: input.name,
    type: "create_household",
    expectedVersion: input.expectedVersion,
    principal: gmPrincipal,
    payload: {
      householdId: input.householdId,
      name: input.householdName,
      residenceZoneIds: input.residenceZoneIds,
      stockAccessPolicy: input.stockAccessPolicy,
    },
  });
}

function setMembershipCmd(input: {
  branchId: string;
  name: string;
  householdId: string;
  actorId: string;
  role: "resident" | "dependent" | "guest";
  status: "active" | "ended";
  expectedVersion: number;
}): SimCommandEnvelope {
  return simCommand({
    branchId: input.branchId,
    name: input.name,
    type: "set_household_membership",
    expectedVersion: input.expectedVersion,
    principal: gmPrincipal,
    payload: {
      householdId: input.householdId,
      actorId: input.actorId,
      role: input.role,
      status: input.status,
    },
  });
}

function adjustLotCmd(input: {
  branchId: string;
  name: string;
  locus: LotLocus;
  materialKindKey: string;
  deltaRaw: number;
  expectedVersion: number;
}): SimCommandEnvelope {
  return simCommand({
    branchId: input.branchId,
    name: input.name,
    type: "adjust_material_lot",
    expectedVersion: input.expectedVersion,
    principal: gmPrincipal,
    payload: { locus: input.locus, materialKindKey: input.materialKindKey, deltaRaw: input.deltaRaw },
  });
}

function transferLotCmd(input: {
  branchId: string;
  name: string;
  actorId: string;
  fromLocus: LotLocus;
  toLocus: LotLocus;
  materialKindKey: string;
  quantityRaw: number;
  expectedVersion: number;
}): SimCommandEnvelope {
  return simCommand({
    branchId: input.branchId,
    name: input.name,
    type: "transfer_lot_quantity",
    expectedVersion: input.expectedVersion,
    principal: playerPrincipal(input.actorId),
    payload: {
      actorId: input.actorId,
      fromLocus: input.fromLocus,
      toLocus: input.toLocus,
      materialKindKey: input.materialKindKey,
      quantityRaw: input.quantityRaw,
    },
  });
}

function setMeansBandCmd(input: {
  branchId: string;
  name: string;
  subject: MeansSubject;
  bandKey: MeansBandKey;
  expectedVersion: number;
}): SimCommandEnvelope {
  return simCommand({
    branchId: input.branchId,
    name: input.name,
    type: "set_means_band",
    expectedVersion: input.expectedVersion,
    principal: gmPrincipal,
    payload: { subject: input.subject, bandKey: input.bandKey },
  });
}

function configureRestockCmd(input: {
  branchId: string;
  name: string;
  householdId: string;
  materialKindKey: string;
  targetQuantityRaw: number;
  lowWaterThresholdRaw: number;
  cadenceSeconds: number;
  funding: HouseholdRestockRoutine["funding"];
  active: boolean;
  expectedVersion: number;
}): SimCommandEnvelope {
  return simCommand({
    branchId: input.branchId,
    name: input.name,
    type: "configure_restock_routine",
    expectedVersion: input.expectedVersion,
    principal: gmPrincipal,
    payload: {
      householdId: input.householdId,
      materialKindKey: input.materialKindKey,
      targetQuantityRaw: input.targetQuantityRaw,
      lowWaterThresholdRaw: input.lowWaterThresholdRaw,
      cadenceSeconds: input.cadenceSeconds,
      funding: input.funding,
      active: input.active,
    },
  });
}

function runHouseholdRestockCmd(input: {
  branchId: string;
  name: string;
  householdId: string;
  materialKindKey: string;
  armedAtSequence: number;
}): SimCommandEnvelope {
  return simCommand({
    branchId: input.branchId,
    name: input.name,
    type: "run_household_restock",
    // Overridden to the locked branch's own version by `admitAtLockedVersion`
    // (mirrors the scheduler's own dispatch, scheduler-store.ts) — this test
    // calls the durable submit function directly rather than through the
    // scheduler, so the value here is never actually checked.
    expectedVersion: 0,
    principal: systemPrincipal,
    payload: {
      householdId: input.householdId,
      materialKindKey: input.materialKindKey,
      armedAtSequence: input.armedAtSequence,
    },
  });
}

function promoteItemCmd(input: {
  branchId: string;
  name: string;
  actorId: string;
  funding: PromotionFunding;
  item: { name?: string; materialKindKey?: string };
  expectedVersion: number;
}): SimCommandEnvelope {
  return simCommand({
    branchId: input.branchId,
    name: input.name,
    type: "promote_item_from_stock",
    expectedVersion: input.expectedVersion,
    principal: playerPrincipal(input.actorId),
    payload: {
      actorId: input.actorId,
      funding: input.funding,
      item: promotedItemInputSchema.parse(input.item),
    },
  });
}

// ---------------------------------------------------------------------------
// Row -> domain-shape mappers. household-store.ts exports only the INSERT
// direction (`householdRowInsert`, `householdMemberRowInsert`,
// `materialLotRowInsert`, `meansBandRowInsert`,
// `householdRestockRoutineRowInsert`) — there is no durable-read function to
// assert against — so each mapper below is the inverse of the named exported
// writer and must be kept in step with it.
// ---------------------------------------------------------------------------

/** Inverse of household-store.ts's exported `householdRowInsert`. */
function householdFromDbRow(row: typeof simHouseholds.$inferSelect): SimulationHousehold {
  return simulationHouseholdSchema.parse({
    id: row.householdId,
    name: row.name,
    residenceZoneIds: row.residenceZoneIds,
    stockAccessPolicy: row.stockAccessPolicy,
  });
}

/** Inverse of household-store.ts's exported `householdMemberRowInsert`. */
function membershipFromDbRow(row: typeof simHouseholdMembers.$inferSelect): HouseholdMembership {
  return householdMembershipSchema.parse({
    householdId: row.householdId,
    actorId: row.actorId,
    role: row.role,
    status: row.status,
    ...(row.endedAtStorySecond === null ? {} : { endedAtStorySecond: row.endedAtStorySecond }),
  });
}

/** The locus half of `materialLotRowInsert`'s column split, read back. */
function lotLocusFromDbRow(row: {
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

/** Inverse of household-store.ts's exported `materialLotRowInsert`. */
function lotFromDbRow(row: typeof simMaterialLots.$inferSelect): MaterialLotState {
  return materialLotStateSchema.parse({
    locus: lotLocusFromDbRow(row),
    materialKindKey: row.materialKindKey,
    quantityKind: row.quantityKind,
    quantityRaw: row.quantityRaw,
    registryVersion: row.registryVersion,
  });
}

/** Inverse of household-store.ts's exported `meansBandRowInsert`. */
function bandFromDbRow(row: typeof simMeansBands.$inferSelect): MeansBandState {
  const subject: MeansSubject =
    row.subjectKind === "actor"
      ? meansSubjectSchema.parse({ kind: "actor", actorId: row.actorId })
      : meansSubjectSchema.parse({ kind: "household", householdId: row.householdId });
  return meansBandStateSchema.parse({
    subject,
    bandKey: row.bandKey,
    registryVersion: row.registryVersion,
    setAtStorySecond: row.setAtStorySecond,
  });
}

/** Inverse of household-store.ts's exported `householdRestockRoutineRowInsert`. */
function routineFromDbRow(row: typeof simHouseholdRestockRoutines.$inferSelect): HouseholdRestockRoutine {
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

async function loadLotRow(
  branchId: string,
  locus: LotLocus,
  materialKindKey: string,
): Promise<MaterialLotState | undefined> {
  const lotKey = deriveMaterialLotRowKey(locus, materialKindKey);
  const [row] = await db()
    .select()
    .from(simMaterialLots)
    .where(and(eq(simMaterialLots.branchId, branchId), eq(simMaterialLots.lotKey, lotKey)));
  return row ? lotFromDbRow(row) : undefined;
}

async function loadBandRow(branchId: string, subject: MeansSubject): Promise<MeansBandState | undefined> {
  const subjectKey = deriveMeansSubjectRowKey(subject);
  const [row] = await db()
    .select()
    .from(simMeansBands)
    .where(and(eq(simMeansBands.branchId, branchId), eq(simMeansBands.subjectKey, subjectKey)));
  return row ? bandFromDbRow(row) : undefined;
}

describe.runIf(harness.ready)("E5.4 slice 1 durable households/lots/means substrate", () => {
  it("runs create_household -> set_household_membership -> adjust_material_lot -> transfer_lot_quantity end to end, and the DB CHECK independently rejects a negative quantity", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();

    const create = await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Vance household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    expectAccepted(create, "household creation");

    const membership = await submitDurableSetHouseholdMembership(
      setMembershipCmd({
        branchId: ids.branchId,
        name: "member-mara",
        householdId,
        actorId: ids.mara,
        role: "resident",
        status: "active",
        expectedVersion: 1,
      }),
    );
    expectAccepted(membership, "membership");

    const stock = await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-bread",
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 10,
        expectedVersion: 2,
      }),
    );
    expectAccepted(stock, "stocking bread");

    const transfer = await submitDurableTransferLotQuantity(
      transferLotCmd({
        branchId: ids.branchId,
        name: "transfer",
        actorId: ids.mara,
        fromLocus: householdLocus(householdId),
        toLocus: actorLocus(ids.mara),
        materialKindKey: "bread",
        quantityRaw: 4,
        expectedVersion: 3,
      }),
    );
    expectAccepted(transfer, "lot transfer");

    const [householdRow] = await db()
      .select()
      .from(simHouseholds)
      .where(and(eq(simHouseholds.branchId, ids.branchId), eq(simHouseholds.householdId, householdId)));
    expect(householdRow).toMatchObject({ name: "Vance household", residenceZoneIds: [ids.zoneHome] });

    const [memberRow] = await db()
      .select()
      .from(simHouseholdMembers)
      .where(
        and(
          eq(simHouseholdMembers.branchId, ids.branchId),
          eq(simHouseholdMembers.householdId, householdId),
          eq(simHouseholdMembers.actorId, ids.mara),
        ),
      );
    expect(memberRow).toMatchObject({ role: "resident", status: "active" });

    const householdLot = await loadLotRow(ids.branchId, householdLocus(householdId), "bread");
    expect(householdLot).toMatchObject({ quantityRaw: 6, quantityKind: "count" });
    const actorLot = await loadLotRow(ids.branchId, actorLocus(ids.mara), "bread");
    expect(actorLot).toMatchObject({ quantityRaw: 4, quantityKind: "count" });

    // The DB CHECK rejects a negative quantity independently of the pure
    // resolver — a direct UPDATE bypassing `resolveTransferLotQuantityFromView`
    // entirely still cannot commit a negative lot (§26.9). Drizzle's node-postgres
    // driver wraps the raw pg error in a "Failed query" Error, so the constraint
    // name lands on `.cause`, not `.message`.
    const actorLotKey = deriveMaterialLotRowKey(actorLocus(ids.mara), "bread");
    let negativeUpdateError: unknown;
    try {
      await db().execute(
        sql`UPDATE sim_material_lots SET quantity_raw = -1 WHERE branch_id = ${ids.branchId} AND lot_key = ${actorLotKey}`,
      );
    } catch (error) {
      negativeUpdateError = error;
    }
    expect(negativeUpdateError).toBeInstanceOf(Error);
    const cause = negativeUpdateError instanceof Error ? negativeUpdateError.cause : undefined;
    const underlyingMessage = cause instanceof Error ? cause.message : String(negativeUpdateError);
    expect(underlyingMessage).toMatch(/sim_material_lots_quantity_safe/i);
  });

  it("rejects transfer_lot_quantity as root_not_colocated when the actor isn't at a residence zone", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );

    const result = await submitDurableTransferLotQuantity(
      transferLotCmd({
        branchId: ids.branchId,
        name: "transfer",
        actorId: ids.outsider,
        fromLocus: householdLocus(householdId),
        toLocus: actorLocus(ids.outsider),
        materialKindKey: "bread",
        quantityRaw: 1,
        expectedVersion: 1,
      }),
    );
    expectRejected(result, "root_not_colocated", "transfer from outside the residence");
  });

  it("rejects transfer_lot_quantity as household_access_denied under an allow_list policy", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "allow_list", actorIds: [ids.iris] },
        expectedVersion: 0,
      }),
    );

    // Mara is co-located at the residence zone but not on the allow-list and
    // holds no membership row — reachable, but denied.
    const result = await submitDurableTransferLotQuantity(
      transferLotCmd({
        branchId: ids.branchId,
        name: "transfer",
        actorId: ids.mara,
        fromLocus: householdLocus(householdId),
        toLocus: actorLocus(ids.mara),
        materialKindKey: "bread",
        quantityRaw: 1,
        expectedVersion: 1,
      }),
    );
    expectRejected(result, "household_access_denied", "transfer against the allow list");
  });

  it("rejects transfer_lot_quantity as insufficient_balance against a never-stocked lot, leaving no lazily-built row behind", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableSetHouseholdMembership(
      setMembershipCmd({
        branchId: ids.branchId,
        name: "member-mara",
        householdId,
        actorId: ids.mara,
        role: "resident",
        status: "active",
        expectedVersion: 1,
      }),
    );

    const result = await submitDurableTransferLotQuantity(
      transferLotCmd({
        branchId: ids.branchId,
        name: "transfer",
        actorId: ids.mara,
        fromLocus: householdLocus(householdId),
        toLocus: actorLocus(ids.mara),
        materialKindKey: "bread", // never stocked — the resolver sees it lazily-initialized at zero
        quantityRaw: 5,
        expectedVersion: 2,
      }),
    );
    expectRejected(result, "insufficient_balance", "transfer from a never-stocked lot");

    // A rejected command never persists its lazily-built init event/row — the
    // store only commits the lazy init after the resolver accepts (§26.9's
    // "lazily, on first touch" applies to accepted touches, not attempted ones).
    const lot = await loadLotRow(ids.branchId, householdLocus(householdId), "bread");
    expect(lot).toBeUndefined();
  });

  it("prefers a lot-tracked means read over a means band once a currency lot exists (§26.10 precedence)", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    const subject: MeansSubject = meansSubjectSchema.parse({ kind: "household", householdId });
    const bandResult = await submitDurableSetMeansBand(
      setMeansBandCmd({ branchId: ids.branchId, name: "band", subject, bandKey: "modest", expectedVersion: 1 }),
    );
    expectAccepted(bandResult, "means band");

    const bandOnlyRead = deriveMeansRead(subject, {
      currencyLot: () => undefined,
      band: () => undefined,
    });
    // Sanity: the view contract itself has no precedence baked in — the read
    // derivation is what applies it. Load the actual persisted band row.
    const persistedBand = await loadBandRow(ids.branchId, subject);
    expect(persistedBand?.bandKey).toBe("modest");
    expect(bandOnlyRead).toEqual({ kind: "unknown" });
    expect(
      deriveMeansRead(subject, { currencyLot: () => undefined, band: () => persistedBand }),
    ).toEqual({ kind: "band_tracked", bandKey: "modest" });

    const lotResult = await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-currency",
        locus: householdLocus(householdId),
        materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
        deltaRaw: 50_000,
        expectedVersion: 2,
      }),
    );
    expectAccepted(lotResult, "currency lot");

    const persistedLot = await loadLotRow(ids.branchId, householdLocus(householdId), RESERVED_CURRENCY_MATERIAL_KIND);
    const stillPersistedBand = await loadBandRow(ids.branchId, subject);
    // The band row is untouched (setting one on a lot-tracked subject is
    // legal narrative color, §26.10), but the read now derives from the lot.
    expect(stillPersistedBand?.bandKey).toBe("modest");
    expect(
      deriveMeansRead(subject, { currencyLot: () => persistedLot, band: () => stillPersistedBand }),
    ).toEqual({ kind: "lot_tracked", quantityRaw: 50_000, quantityKind: "fixed_point" });
  });

  it("forks with the child's household/membership/lot/means rows matching a replayHouseholdsHistory rebuild, and keeps a diverged child from touching the parent", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();

    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableSetHouseholdMembership(
      setMembershipCmd({
        branchId: ids.branchId,
        name: "member-mara",
        householdId,
        actorId: ids.mara,
        role: "resident",
        status: "active",
        expectedVersion: 1,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-bread",
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 10,
        expectedVersion: 2,
      }),
    );
    await submitDurableTransferLotQuantity(
      transferLotCmd({
        branchId: ids.branchId,
        name: "transfer",
        actorId: ids.mara,
        fromLocus: householdLocus(householdId),
        toLocus: actorLocus(ids.mara),
        materialKindKey: "bread",
        quantityRaw: 3,
        expectedVersion: 3,
      }),
    );
    const subject: MeansSubject = meansSubjectSchema.parse({ kind: "household", householdId });
    await submitDurableSetMeansBand(
      setMeansBandCmd({ branchId: ids.branchId, name: "band", subject, bandKey: "modest", expectedVersion: 4 }),
    );

    const { childBranchId, parentEvents } = await forkAtHead({
      parentBranchId: ids.branchId,
      reason: "E5.4 slice 1 fork parity",
    });
    harness.trackBranch(childBranchId);

    const expected = replayHouseholdsHistory({
      seed: emptyHouseholdsSeed(childBranchId, SEED_SECOND),
      events: parentEvents,
    });

    const [childHouseholds, childMembers, childLots, childBands] = await Promise.all([
      db().select().from(simHouseholds).where(eq(simHouseholds.branchId, childBranchId)),
      db().select().from(simHouseholdMembers).where(eq(simHouseholdMembers.branchId, childBranchId)),
      db().select().from(simMaterialLots).where(eq(simMaterialLots.branchId, childBranchId)),
      db().select().from(simMeansBands).where(eq(simMeansBands.branchId, childBranchId)),
    ]);
    const actual = sortHouseholdsProjection({
      ...expected,
      households: childHouseholds.map(householdFromDbRow),
      memberships: childMembers.map(membershipFromDbRow),
      lots: childLots.map(lotFromDbRow),
      meansBands: childBands.map(bandFromDbRow),
    });
    expect(actual).toEqual(expected);

    // Diverge: adjust the CHILD's household stock only.
    const [childBranchRow] = await db().select().from(simBranches).where(eq(simBranches.id, childBranchId));
    if (!childBranchRow) throw new Error("child branch row missing");
    const diverge = await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: childBranchId,
        name: "diverge",
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 100,
        expectedVersion: childBranchRow.version,
      }),
    );
    expectAccepted(diverge, "child divergence");

    const childLotAfter = await loadLotRow(childBranchId, householdLocus(householdId), "bread");
    expect(childLotAfter?.quantityRaw).toBe(107);
    // The parent's household lot (10 stocked - 3 transferred = 7) is untouched.
    const parentLotAfter = await loadLotRow(ids.branchId, householdLocus(householdId), "bread");
    expect(parentLotAfter?.quantityRaw).toBe(7);
  });

  it("rebuilds the households projection from zero to the live hash across all five slice-1 commands", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();

    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableSetHouseholdMembership(
      setMembershipCmd({
        branchId: ids.branchId,
        name: "member-mara",
        householdId,
        actorId: ids.mara,
        role: "resident",
        status: "active",
        expectedVersion: 1,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-bread",
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 10,
        expectedVersion: 2,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-currency",
        locus: householdLocus(householdId),
        materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
        deltaRaw: 50_000,
        expectedVersion: 3,
      }),
    );
    await submitDurableTransferLotQuantity(
      transferLotCmd({
        branchId: ids.branchId,
        name: "transfer",
        actorId: ids.mara,
        fromLocus: householdLocus(householdId),
        toLocus: actorLocus(ids.mara),
        materialKindKey: "bread",
        quantityRaw: 4,
        expectedVersion: 4,
      }),
    );
    const subject: MeansSubject = meansSubjectSchema.parse({ kind: "household", householdId });
    await submitDurableSetMeansBand(
      setMeansBandCmd({ branchId: ids.branchId, name: "band", subject, bandKey: "comfortable", expectedVersion: 5 }),
    );

    const [branchRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!branchRow) throw new Error("branch row missing");

    const [liveHouseholds, liveMembers, liveLots, liveBands] = await Promise.all([
      db().select().from(simHouseholds).where(eq(simHouseholds.branchId, ids.branchId)),
      db().select().from(simHouseholdMembers).where(eq(simHouseholdMembers.branchId, ids.branchId)),
      db().select().from(simMaterialLots).where(eq(simMaterialLots.branchId, ids.branchId)),
      db().select().from(simMeansBands).where(eq(simMeansBands.branchId, ids.branchId)),
    ]);
    const live = sortHouseholdsProjection({
      branchId: ids.branchId,
      headSequence: branchRow.headSequence,
      version: branchRow.version,
      storySecond: branchRow.storySecond,
      households: liveHouseholds.map(householdFromDbRow),
      memberships: liveMembers.map(membershipFromDbRow),
      lots: liveLots.map(lotFromDbRow),
      meansBands: liveBands.map(bandFromDbRow),
      restockRoutines: [],
    });

    const events = await readBranchEvents(ids.branchId);
    const rebuilt = replayHouseholdsHistory({ seed: emptyHouseholdsSeed(ids.branchId, SEED_SECOND), events });

    expect(simulationHash(live)).toBe(simulationHash(rebuilt));
  });
});

// ---------------------------------------------------------------------------
// E5.4 slice 2 — promotion, restock routine, crash recovery, fork parity
// ---------------------------------------------------------------------------

async function pendingRestockTriggers(branchId: string) {
  return db()
    .select({ state: simTriggers.state, dueStorySecond: simTriggers.dueStorySecond })
    .from(simTriggers)
    .where(and(eq(simTriggers.branchId, branchId), eq(simTriggers.kind, "household_restock_due")))
    .orderBy(asc(simTriggers.dueStorySecond));
}

describe.runIf(harness.ready)("E5.4 slice 2 promotion, restock routine, crash recovery, and fork parity", () => {
  it("promotes an item via stock funding end to end: debits the household lot, creates sim_items + sim_item_holdings, and the item is immediately usable through transfer_item", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableSetHouseholdMembership(
      setMembershipCmd({
        branchId: ids.branchId,
        name: "member-mara",
        householdId,
        actorId: ids.mara,
        role: "resident",
        status: "active",
        expectedVersion: 1,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-bread",
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 10,
        expectedVersion: 2,
      }),
    );

    const promote = await submitDurablePromoteItemFromStock(
      promoteItemCmd({
        branchId: ids.branchId,
        name: "promote",
        actorId: ids.mara,
        funding: { kind: "stock", sourceLocus: householdLocus(householdId), quantityRaw: 1 },
        item: { name: "Fresh Loaf", materialKindKey: "bread" },
        expectedVersion: 3,
      }),
    );
    expectAccepted(promote, "item promotion");

    const promotedPayload = (await latestEventPayload(ids.branchId, "item_instantiated_from_promotion")) as {
      item: { id: string };
    };
    const itemId = promotedPayload.item.id;

    const [itemRow] = await db().select().from(simItems).where(and(eq(simItems.branchId, ids.branchId), eq(simItems.itemId, itemId)));
    expect(itemRow).toMatchObject({ name: "Fresh Loaf", materialKindKey: "bread" });
    const [holdingRow] = await db()
      .select()
      .from(simItemHoldings)
      .where(and(eq(simItemHoldings.branchId, ids.branchId), eq(simItemHoldings.itemId, itemId)));
    expect(holdingRow).toMatchObject({ locusKind: "held", actorId: ids.mara });

    const householdLot = await loadLotRow(ids.branchId, householdLocus(householdId), "bread");
    expect(householdLot?.quantityRaw).toBe(9);

    // Immediately usable through the EXISTING transfer_item command — proves
    // the cross-domain event train didn't produce a second-class item.
    const transfer = await submitDurableTransferItem(
      simCommand({
        branchId: ids.branchId,
        name: "transfer-item",
        type: "transfer_item",
        expectedVersion: 4,
        principal: playerPrincipal(ids.mara),
        payload: {
          actorId: ids.mara,
          itemId,
          fromLocus: { kind: "held", actorId: ids.mara },
          toLocus: { kind: "zone", zoneId: ids.zoneHome },
        },
      }),
    );
    expectAccepted(transfer, "promoted item transfer");
  });

  it("promotes an item via purchase funding end to end, debiting the reserved currency lot by unitPriceRaw x quantityRaw", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableSetHouseholdMembership(
      setMembershipCmd({
        branchId: ids.branchId,
        name: "member-mara",
        householdId,
        actorId: ids.mara,
        role: "resident",
        status: "active",
        expectedVersion: 1,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-currency",
        locus: householdLocus(householdId),
        materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
        deltaRaw: 50_000,
        expectedVersion: 2,
      }),
    );

    const promote = await submitDurablePromoteItemFromStock(
      promoteItemCmd({
        branchId: ids.branchId,
        name: "promote",
        actorId: ids.mara,
        funding: { kind: "purchase", currencyLocus: householdLocus(householdId), unitPriceRaw: 1_000, quantityRaw: 3 },
        item: { name: "Brass Compass" },
        expectedVersion: 3,
      }),
    );
    expectAccepted(promote, "item promotion");

    const currencyLot = await loadLotRow(ids.branchId, householdLocus(householdId), RESERVED_CURRENCY_MATERIAL_KIND);
    expect(currencyLot?.quantityRaw).toBe(50_000 - 3_000);

    const promotedPayload = (await latestEventPayload(ids.branchId, "item_instantiated_from_promotion")) as {
      item: { id: string; name: string };
    };
    expect(promotedPayload.item.name).toBe("Brass Compass");
  });

  it("recovers atomically from an injected crash at each promotion checkpoint, never double-debiting via the same idempotency key", async () => {
    const crashPoints = ["after_event_append", "after_projection_update", "after_branch_advance", "after_commit"] as const;
    for (const crashAt of crashPoints) {
      const ids = makeIds();
      await seedCase(ids);
      const householdId = newId();
      await submitDurableCreateHousehold(
        createHouseholdCmd({
          branchId: ids.branchId,
          name: "create",
          householdId,
          householdName: "Household",
          residenceZoneIds: [ids.zoneHome],
          stockAccessPolicy: { kind: "members_only" },
          expectedVersion: 0,
        }),
      );
      await submitDurableSetHouseholdMembership(
        setMembershipCmd({
          branchId: ids.branchId,
          name: "member-mara",
          householdId,
          actorId: ids.mara,
          role: "resident",
          status: "active",
          expectedVersion: 1,
        }),
      );
      await submitDurableAdjustMaterialLot(
        adjustLotCmd({
          branchId: ids.branchId,
          name: "stock-bread",
          locus: householdLocus(householdId),
          materialKindKey: "bread",
          deltaRaw: 10,
          expectedVersion: 2,
        }),
      );

      const command = promoteItemCmd({
        branchId: ids.branchId,
        name: "promote",
        actorId: ids.mara,
        funding: { kind: "stock", sourceLocus: householdLocus(householdId), quantityRaw: 1 },
        item: { name: "Crash Loaf", materialKindKey: "bread" },
        expectedVersion: 3,
      });

      let threw: unknown;
      try {
        await submitDurablePromoteItemFromStock(command, { crashAt });
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeInstanceOf(InjectedSimulationCrash);

      const lotAfterCrash = await loadLotRow(ids.branchId, householdLocus(householdId), "bread");
      const itemsAfterCrash = await db().select().from(simItems).where(eq(simItems.branchId, ids.branchId));
      if (crashAt === "after_commit") {
        // The transaction already committed before the injected throw fired.
        expect(lotAfterCrash?.quantityRaw).toBe(9);
        expect(itemsAfterCrash).toHaveLength(1);
      } else {
        // The whole transaction rolled back atomically — nothing landed.
        expect(lotAfterCrash?.quantityRaw).toBe(10);
        expect(itemsAfterCrash).toHaveLength(0);
      }

      // Retry the SAME command (same id + idempotencyKey) with no crash —
      // must recover to exactly one debit and one item, never double-applying.
      const retry = await submitDurablePromoteItemFromStock(command);
      expectAccepted(retry, `retry after the ${crashAt} crash`);

      const lotAfterRetry = await loadLotRow(ids.branchId, householdLocus(householdId), "bread");
      const itemsAfterRetry = await db().select().from(simItems).where(eq(simItems.branchId, ids.branchId));
      expect(lotAfterRetry?.quantityRaw).toBe(9);
      expect(itemsAfterRetry).toHaveLength(1);
    }
  });

  it("drains configure_restock_routine -> run_household_restock through the scheduler, tops up stock, and re-arms; a second depletion+drain cycle fires the re-armed alarm", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-currency",
        locus: householdLocus(householdId),
        materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
        deltaRaw: 100_000,
        expectedVersion: 1,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-bread",
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 5,
        expectedVersion: 2,
      }),
    );

    const configure = await submitDurableConfigureRestockRoutine(
      configureRestockCmd({
        branchId: ids.branchId,
        name: "configure-1",
        householdId,
        materialKindKey: "bread",
        targetQuantityRaw: 20,
        lowWaterThresholdRaw: 5,
        cadenceSeconds: 3_600,
        funding: { kind: "lot", currencyLocus: householdLocus(householdId), unitPriceRaw: 10 },
        active: true,
        expectedVersion: 3,
      }),
    );
    expectAccepted(configure, "restock configuration");

    const [armed] = (await pendingRestockTriggers(ids.branchId)).filter((t) => t.state === "pending");
    if (!armed) throw new Error("expected an armed restock trigger");

    const drain1 = await advanceBranchStoryTime(ids.branchId, armed.dueStorySecond, { workerId: "w-restock-1" });
    expect(drain1.status).toBe("advanced");

    const lotAfterFirst = await loadLotRow(ids.branchId, householdLocus(householdId), "bread");
    expect(lotAfterFirst?.quantityRaw).toBe(20);
    const currencyAfterFirst = await loadLotRow(ids.branchId, householdLocus(householdId), RESERVED_CURRENCY_MATERIAL_KIND);
    expect(currencyAfterFirst?.quantityRaw).toBe(100_000 - 10 * 15);

    const fulfilledEvents1 = await db()
      .select({ type: simEvents.type })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "household_restock_fulfilled")));
    expect(fulfilledEvents1).toHaveLength(1);

    const [rearmed] = (await pendingRestockTriggers(ids.branchId)).filter((t) => t.state === "pending");
    if (!rearmed) throw new Error("expected a re-armed trigger");
    expect(rearmed.dueStorySecond).toBe(armed.dueStorySecond + 3_600);

    const [branchAfterFirst] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!branchAfterFirst) throw new Error("branch missing");
    const deplete = await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "deplete",
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: -15,
        expectedVersion: branchAfterFirst.version,
      }),
    );
    expectAccepted(deplete, "stock depletion");

    const drain2 = await advanceBranchStoryTime(ids.branchId, rearmed.dueStorySecond, { workerId: "w-restock-2" });
    expect(drain2.status).toBe("advanced");

    const lotAfterSecond = await loadLotRow(ids.branchId, householdLocus(householdId), "bread");
    expect(lotAfterSecond?.quantityRaw).toBe(20);

    const fulfilledEvents2 = await db()
      .select({ type: simEvents.type })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "household_restock_fulfilled")));
    expect(fulfilledEvents2).toHaveLength(2);
  });

  it("retires a stale restock alarm on reconfigure mid-flight, and only the fresh arm fires (never double-fires)", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-currency",
        locus: householdLocus(householdId),
        materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
        deltaRaw: 100_000,
        expectedVersion: 1,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-bread",
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 5,
        expectedVersion: 2,
      }),
    );

    await submitDurableConfigureRestockRoutine(
      configureRestockCmd({
        branchId: ids.branchId,
        name: "configure-1",
        householdId,
        materialKindKey: "bread",
        targetQuantityRaw: 20,
        lowWaterThresholdRaw: 5,
        cadenceSeconds: 3_600,
        funding: { kind: "lot", currencyLocus: householdLocus(householdId), unitPriceRaw: 10 },
        active: true,
        expectedVersion: 3,
      }),
    );

    // Reconfigure BEFORE the first arm fires — retires the stale alarm
    // unconditionally and arms a fresh one under a new armedAtSequence.
    const configure2 = await submitDurableConfigureRestockRoutine(
      configureRestockCmd({
        branchId: ids.branchId,
        name: "configure-2",
        householdId,
        materialKindKey: "bread",
        targetQuantityRaw: 30,
        lowWaterThresholdRaw: 5,
        cadenceSeconds: 3_600,
        funding: { kind: "lot", currencyLocus: householdLocus(householdId), unitPriceRaw: 10 },
        active: true,
        expectedVersion: 4,
      }),
    );
    expectAccepted(configure2, "reconfiguration");

    const triggers = await pendingRestockTriggers(ids.branchId);
    expect(triggers.map((t) => t.state).sort()).toEqual(["completed", "pending"]);
    const pending = triggers.find((t) => t.state === "pending");
    if (!pending) throw new Error("expected a fresh pending arm");

    const drain = await advanceBranchStoryTime(ids.branchId, pending.dueStorySecond, { workerId: "w-stale" });
    expect(drain.status).toBe("advanced");

    // The FRESH configuration's target (30), not the stale one's (20), fired.
    const lotAfter = await loadLotRow(ids.branchId, householdLocus(householdId), "bread");
    expect(lotAfter?.quantityRaw).toBe(30);

    const fulfilledEvents = await db()
      .select({ type: simEvents.type })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "household_restock_fulfilled")));
    expect(fulfilledEvents).toHaveLength(1);
  });

  it("retires a restock alarm a scheduler worker has already CLAIMED (processing, not pending) when a reconfigure lands in the claim/dispatch gap, so the stale dispatch fails closed instead of double-arming", async () => {
    // Reproduces the claim/dispatch race: `claimDueTrigger` (scheduler-store.ts)
    // commits a SEPARATE, earlier transaction that flips a due trigger to
    // `processing` before `dispatch()` opens the transaction that actually
    // resolves it. A `configure_restock_routine` landing in that gap must
    // still retire the claimed row — this test manually reproduces the claim
    // (a direct row update, mirroring the scheduler-store.int.test.ts
    // "reclaiming a crashed worker's expired lease" idiom) and asserts the
    // reconfigure retires it too, and that dispatching the stale claim
    // afterward rejects `threshold_stale` rather than fulfilling under the
    // superseded routine and re-arming a second live trigger.
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-currency",
        locus: householdLocus(householdId),
        materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
        deltaRaw: 100_000,
        expectedVersion: 1,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-bread",
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 5,
        expectedVersion: 2,
      }),
    );

    const configure1 = await submitDurableConfigureRestockRoutine(
      configureRestockCmd({
        branchId: ids.branchId,
        name: "configure-1",
        householdId,
        materialKindKey: "bread",
        targetQuantityRaw: 20,
        lowWaterThresholdRaw: 5,
        cadenceSeconds: 3_600,
        funding: { kind: "lot", currencyLocus: householdLocus(householdId), unitPriceRaw: 10 },
        active: true,
        expectedVersion: 3,
      }),
    );
    expectAccepted(configure1, "first restock configuration");
    const armedAtSequence1 = configure1.firstSequence;

    const [armedTrigger] = await pendingRestockTriggers(ids.branchId);
    expect(armedTrigger?.state).toBe("pending");

    // Simulate a scheduler worker's `claimDueTrigger` having already claimed
    // this trigger into `processing` — committed in its own transaction,
    // strictly before `dispatch()` opens the one below.
    await db()
      .update(simTriggers)
      .set({ state: "processing", leaseOwner: "w-claimed", leaseExpiresAt: new Date(Date.now() + 30_000) })
      .where(and(eq(simTriggers.branchId, ids.branchId), eq(simTriggers.kind, "household_restock_due")));

    // The reconfigure lands in the claim/dispatch gap.
    const configure2 = await submitDurableConfigureRestockRoutine(
      configureRestockCmd({
        branchId: ids.branchId,
        name: "configure-2",
        householdId,
        materialKindKey: "bread",
        targetQuantityRaw: 30,
        lowWaterThresholdRaw: 5,
        cadenceSeconds: 3_600,
        funding: { kind: "lot", currencyLocus: householdLocus(householdId), unitPriceRaw: 10 },
        active: true,
        expectedVersion: 4,
      }),
    );
    expectAccepted(configure2, "reconfiguration");

    // The claimed (processing) row is retired too, not just pending rows.
    const triggersAfterReconfigure = await db()
      .select({ state: simTriggers.state })
      .from(simTriggers)
      .where(and(eq(simTriggers.branchId, ids.branchId), eq(simTriggers.kind, "household_restock_due")));
    expect(triggersAfterReconfigure.map((t) => t.state).sort()).toEqual(["completed", "pending"]);

    // `dispatch()` now opens its transaction for the stale claim: it fails
    // closed to `threshold_stale` instead of fulfilling under the
    // reconfigured routine and re-arming a second live trigger.
    const staleDispatch = await submitDurableRunHouseholdRestock(
      runHouseholdRestockCmd({
        branchId: ids.branchId,
        name: "stale-dispatch",
        householdId,
        materialKindKey: "bread",
        armedAtSequence: armedAtSequence1,
      }),
      { admitAtLockedVersion: true },
    );
    expectRejected(staleDispatch, "threshold_stale", "stale claimed dispatch");

    // Exactly one live trigger remains — the fresh arm from the reconfigure —
    // never two.
    const triggersAfterStaleDispatch = await pendingRestockTriggers(ids.branchId);
    expect(triggersAfterStaleDispatch.filter((t) => t.state === "pending")).toHaveLength(1);

    const fulfilledEventsAfterStaleDispatch = await db()
      .select({ type: simEvents.type })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "household_restock_fulfilled")));
    expect(fulfilledEventsAfterStaleDispatch).toHaveLength(0);
  });

  it("forks mid-pending-restock: the child's alarm re-arms and fires independently of the (still-pending) parent's", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-currency",
        locus: householdLocus(householdId),
        materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
        deltaRaw: 100_000,
        expectedVersion: 1,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-bread",
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 5,
        expectedVersion: 2,
      }),
    );
    await submitDurableConfigureRestockRoutine(
      configureRestockCmd({
        branchId: ids.branchId,
        name: "configure-1",
        householdId,
        materialKindKey: "bread",
        targetQuantityRaw: 20,
        lowWaterThresholdRaw: 5,
        cadenceSeconds: 3_600,
        funding: { kind: "lot", currencyLocus: householdLocus(householdId), unitPriceRaw: 10 },
        active: true,
        expectedVersion: 3,
      }),
    );

    const { childBranchId } = await forkAtHead({
      parentBranchId: ids.branchId,
      reason: "E5.4 slice 2 fork mid-pending-restock",
    });
    harness.trackBranch(childBranchId);

    const [childTrigger] = await pendingRestockTriggers(childBranchId);
    expect(childTrigger).toMatchObject({ state: "pending" });
    if (!childTrigger) throw new Error("expected the child to inherit a pending restock alarm");

    const drainChild = await advanceBranchStoryTime(childBranchId, childTrigger.dueStorySecond, {
      workerId: "w-fork-child",
    });
    expect(drainChild.status).toBe("advanced");

    const childLot = await loadLotRow(childBranchId, householdLocus(householdId), "bread");
    expect(childLot?.quantityRaw).toBe(20);

    // The parent's own alarm is untouched — still pending, its stock unchanged.
    const [parentTrigger] = await pendingRestockTriggers(ids.branchId);
    expect(parentTrigger?.state).toBe("pending");
    const parentLot = await loadLotRow(ids.branchId, householdLocus(householdId), "bread");
    expect(parentLot?.quantityRaw).toBe(5);
  });

  it("forks before vs. at/after a promotion: the pre-promotion child has no row for the promoted item; the post-promotion child has it with the correct updatedSequence", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableSetHouseholdMembership(
      setMembershipCmd({
        branchId: ids.branchId,
        name: "member-mara",
        householdId,
        actorId: ids.mara,
        role: "resident",
        status: "active",
        expectedVersion: 1,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-bread",
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 10,
        expectedVersion: 2,
      }),
    );

    const { childBranchId: childBeforeId } = await forkAtHead({
      parentBranchId: ids.branchId,
      reason: "pre-promotion fork",
    });
    harness.trackBranch(childBeforeId);

    const promote = await submitDurablePromoteItemFromStock(
      promoteItemCmd({
        branchId: ids.branchId,
        name: "promote",
        actorId: ids.mara,
        funding: { kind: "stock", sourceLocus: householdLocus(householdId), quantityRaw: 1 },
        item: { name: "Fork Loaf", materialKindKey: "bread" },
        expectedVersion: 3,
      }),
    );
    expectAccepted(promote, "item promotion");

    const [promotedEventRow] = await db()
      .select({ payload: simEvents.payload, sequence: simEvents.sequence })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "item_instantiated_from_promotion")))
      .orderBy(desc(simEvents.sequence))
      .limit(1);
    if (!promotedEventRow) throw new Error("expected a promotion event");
    const itemId = (promotedEventRow.payload as { item: { id: string } }).item.id;

    const { childBranchId: childAfterId } = await forkAtHead({
      parentBranchId: ids.branchId,
      reason: "post-promotion fork",
    });
    harness.trackBranch(childAfterId);

    const [childBeforeItem] = await db()
      .select()
      .from(simItems)
      .where(and(eq(simItems.branchId, childBeforeId), eq(simItems.itemId, itemId)));
    expect(childBeforeItem).toBeUndefined();
    const [childBeforeHolding] = await db()
      .select()
      .from(simItemHoldings)
      .where(and(eq(simItemHoldings.branchId, childBeforeId), eq(simItemHoldings.itemId, itemId)));
    expect(childBeforeHolding).toBeUndefined();

    const [childAfterItem] = await db()
      .select()
      .from(simItems)
      .where(and(eq(simItems.branchId, childAfterId), eq(simItems.itemId, itemId)));
    expect(childAfterItem).toMatchObject({ name: "Fork Loaf" });
    const [childAfterHolding] = await db()
      .select()
      .from(simItemHoldings)
      .where(and(eq(simItemHoldings.branchId, childAfterId), eq(simItemHoldings.itemId, itemId)));
    expect(childAfterHolding).toMatchObject({ updatedSequence: promotedEventRow.sequence });
  });

  it("rebuilds the households projection from zero to the live hash across a scenario touching every slice-1+2 command", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();

    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        name: "create",
        householdId,
        householdName: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableSetHouseholdMembership(
      setMembershipCmd({
        branchId: ids.branchId,
        name: "member-mara",
        householdId,
        actorId: ids.mara,
        role: "resident",
        status: "active",
        expectedVersion: 1,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-bread",
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 10,
        expectedVersion: 2,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        name: "stock-currency",
        locus: householdLocus(householdId),
        materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
        deltaRaw: 100_000,
        expectedVersion: 3,
      }),
    );
    await submitDurableTransferLotQuantity(
      transferLotCmd({
        branchId: ids.branchId,
        name: "transfer",
        actorId: ids.mara,
        fromLocus: householdLocus(householdId),
        toLocus: actorLocus(ids.mara),
        materialKindKey: "bread",
        quantityRaw: 2,
        expectedVersion: 4,
      }),
    );
    const subject: MeansSubject = meansSubjectSchema.parse({ kind: "household", householdId });
    await submitDurableSetMeansBand(
      setMeansBandCmd({ branchId: ids.branchId, name: "band", subject, bandKey: "comfortable", expectedVersion: 5 }),
    );
    await submitDurableConfigureRestockRoutine(
      configureRestockCmd({
        branchId: ids.branchId,
        name: "configure-1",
        householdId,
        materialKindKey: "bread",
        targetQuantityRaw: 20,
        lowWaterThresholdRaw: 5,
        cadenceSeconds: 3_600,
        funding: { kind: "lot", currencyLocus: householdLocus(householdId), unitPriceRaw: 10 },
        active: true,
        expectedVersion: 6,
      }),
    );
    await submitDurablePromoteItemFromStock(
      promoteItemCmd({
        branchId: ids.branchId,
        name: "promote",
        actorId: ids.mara,
        funding: { kind: "stock", sourceLocus: householdLocus(householdId), quantityRaw: 1 },
        item: { name: "Full Catalog Loaf", materialKindKey: "bread" },
        expectedVersion: 7,
      }),
    );

    const [armed] = (await pendingRestockTriggers(ids.branchId)).filter((t) => t.state === "pending");
    if (!armed) throw new Error("expected an armed restock trigger");
    const drain = await advanceBranchStoryTime(ids.branchId, armed.dueStorySecond, { workerId: "w-full-catalog" });
    expect(drain.status).toBe("advanced");

    const [branchRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!branchRow) throw new Error("branch missing");

    const [liveHouseholds, liveMembers, liveLots, liveBands, liveRoutines] = await Promise.all([
      db().select().from(simHouseholds).where(eq(simHouseholds.branchId, ids.branchId)),
      db().select().from(simHouseholdMembers).where(eq(simHouseholdMembers.branchId, ids.branchId)),
      db().select().from(simMaterialLots).where(eq(simMaterialLots.branchId, ids.branchId)),
      db().select().from(simMeansBands).where(eq(simMeansBands.branchId, ids.branchId)),
      db().select().from(simHouseholdRestockRoutines).where(eq(simHouseholdRestockRoutines.branchId, ids.branchId)),
    ]);
    const live = sortHouseholdsProjection({
      branchId: ids.branchId,
      headSequence: branchRow.headSequence,
      version: branchRow.version,
      storySecond: branchRow.storySecond,
      households: liveHouseholds.map(householdFromDbRow),
      memberships: liveMembers.map(membershipFromDbRow),
      lots: liveLots.map(lotFromDbRow),
      meansBands: liveBands.map(bandFromDbRow),
      restockRoutines: liveRoutines.map(routineFromDbRow),
    });

    const events = await readBranchEvents(ids.branchId);
    const rebuilt = replayHouseholdsHistory({ seed: emptyHouseholdsSeed(ids.branchId, SEED_SECOND), events });

    expect(simulationHash(live)).toBe(simulationHash(rebuilt));
  });
});
