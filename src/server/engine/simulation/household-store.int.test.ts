import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { simulationBranchEventSchema, type SimulationBranchEvent } from "@/contracts/simulation/branching";
import {
  RESERVED_CURRENCY_MATERIAL_KIND,
  adjustMaterialLotCommandSchema,
  createHouseholdCommandSchema,
  householdMembershipSchema,
  lotLocusSchema,
  materialLotStateSchema,
  meansBandStateSchema,
  meansSubjectSchema,
  setHouseholdMembershipCommandSchema,
  setMeansBandCommandSchema,
  simulationHouseholdSchema,
  transferLotQuantityCommandSchema,
  type AdjustMaterialLotCommand,
  type CreateHouseholdCommand,
  type HouseholdMembership,
  type LotLocus,
  type MaterialLotState,
  type MeansBandKey,
  type MeansBandState,
  type MeansSubject,
  type SetHouseholdMembershipCommand,
  type SetMeansBandCommand,
  type SimulationHousehold,
  type TransferLotQuantityCommand,
} from "@/contracts/simulation/households";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
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
  simHouseholds,
  simMaterialLots,
  simMeansBands,
  simWorlds,
} from "@/server/db";
import { forkBranch } from "./branch-store";
import {
  submitDurableAdjustMaterialLot,
  submitDurableCreateHousehold,
  submitDurableSetHouseholdMembership,
  submitDurableSetMeansBand,
  submitDurableTransferLotQuantity,
} from "./household-store";
import { seedDurableMaterialBranch } from "./material-store";
import { seedDurableSpaceTopology } from "./space-store";

/**
 * E5.4 slice 1 durable households/lots/means substrate (engine.spec
 * §26.8–26.10). Mirrors body-store.int.test.ts's harness shape: a single
 * `describe.runIf(ready)` block, `afterAll` teardown of every seeded world.
 *
 * `sim_household_members` has no direct `branch_id -> sim_branches` cascade
 * FK (unlike `sim_households`/`sim_material_lots`/`sim_means_bands`, which
 * all declare one) — only deferred, non-cascading FKs to `sim_households`
 * and `sim_characters`. Deleting a world whose branch carries membership
 * rows therefore fails at commit (the deferred household/actor FK finds its
 * parent row already cascade-gone). Teardown below deletes
 * `sim_household_members` explicitly, ahead of the `sim_worlds` delete, to
 * route around that gap without touching schema/migrations (out of this
 * slice's scope — see the final report for the follow-up).
 */

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_households limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4_000);
      }),
    ]);
    return true;
  } catch (error) {
    if (process.env.CI === "true" || process.env.VESPER_REQUIRE_TEST_DB === "1") {
      throw error;
    }
    process.stderr.write(
      `[household-store.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const seededWorldIds: string[] = [];
const seededBranchIds: string[] = [];

afterAll(async () => {
  if (!ready) return;
  if (seededBranchIds.length > 0) {
    await db().delete(simHouseholdMembers).where(inArray(simHouseholdMembers.branchId, seededBranchIds));
  }
  if (seededWorldIds.length > 0) {
    await db().delete(simWorlds).where(inArray(simWorlds.id, seededWorldIds));
  }
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
  seededWorldIds.push(ids.worldId);
  seededBranchIds.push(ids.branchId);
  const seed: MaterialBranchSeed = materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e5-4-test-world",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e5-4-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.mara, name: "Mara" },
      { id: ids.iris, name: "Iris" },
      { id: ids.outsider, name: "Rhea" },
    ],
    items: [],
  });
  await seedDurableMaterialBranch(seed);
  await seedDurableSpaceTopology({
    branchId: ids.branchId,
    locations: [{ id: ids.locationId, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" }],
    zones: [
      { id: ids.zoneHome, locationId: ids.locationId, kind: "room", privacyPolicy: "private" },
      { id: ids.zoneAway, locationId: ids.locationId, kind: "room", privacyPolicy: "private" },
    ],
    links: [],
    loci: [
      { kind: "at", actorId: ids.mara, locationId: ids.locationId, zoneId: ids.zoneHome, since: SEED_SECOND },
      { kind: "at", actorId: ids.iris, locationId: ids.locationId, zoneId: ids.zoneHome, since: SEED_SECOND },
      { kind: "at", actorId: ids.outsider, locationId: ids.locationId, zoneId: ids.zoneAway, since: SEED_SECOND },
    ],
  });
}

// ---------------------------------------------------------------------------
// Locus / subject builders + command builders — mirror material-store.int
// .test.ts's `transferCommand`-style shape (explicit required fields, no IO).
// ---------------------------------------------------------------------------

const householdLocus = (householdId: string): LotLocus => lotLocusSchema.parse({ kind: "household", householdId });
const actorLocus = (actorId: string): LotLocus => lotLocusSchema.parse({ kind: "actor", actorId });

const gmPrincipal = { kind: "storyteller" as const, principalId: "gm-1", controlledActorIds: [] };

function createHouseholdCmd(input: {
  branchId: string;
  householdId: string;
  name: string;
  residenceZoneIds: string[];
  /** Unbranded input shape (mirrors `CreateHouseholdCommandInput`) — `.parse()`
   * below brands `actorIds`, matching how `residenceZoneIds`/actor-id fields
   * accept plain strings on input throughout this file. */
  stockAccessPolicy: { kind: "members_only" } | { kind: "allow_list"; actorIds: string[] };
  expectedVersion: number;
}): CreateHouseholdCommand {
  return createHouseholdCommandSchema.parse({
    id: newId(),
    branchId: input.branchId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: newId(),
    principal: gmPrincipal,
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    correlationId: newId(),
    type: "create_household",
    schemaVersion: 1,
    payload: {
      householdId: input.householdId,
      name: input.name,
      residenceZoneIds: input.residenceZoneIds,
      stockAccessPolicy: input.stockAccessPolicy,
    },
  });
}

function setMembershipCmd(input: {
  branchId: string;
  householdId: string;
  actorId: string;
  role: "resident" | "dependent" | "guest";
  status: "active" | "ended";
  expectedVersion: number;
}): SetHouseholdMembershipCommand {
  return setHouseholdMembershipCommandSchema.parse({
    id: newId(),
    branchId: input.branchId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: newId(),
    principal: gmPrincipal,
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    correlationId: newId(),
    type: "set_household_membership",
    schemaVersion: 1,
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
  locus: LotLocus;
  materialKindKey: string;
  deltaRaw: number;
  expectedVersion: number;
}): AdjustMaterialLotCommand {
  return adjustMaterialLotCommandSchema.parse({
    id: newId(),
    branchId: input.branchId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: newId(),
    principal: gmPrincipal,
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    correlationId: newId(),
    type: "adjust_material_lot",
    schemaVersion: 1,
    payload: { locus: input.locus, materialKindKey: input.materialKindKey, deltaRaw: input.deltaRaw },
  });
}

function transferLotCmd(input: {
  branchId: string;
  actorId: string;
  fromLocus: LotLocus;
  toLocus: LotLocus;
  materialKindKey: string;
  quantityRaw: number;
  expectedVersion: number;
}): TransferLotQuantityCommand {
  return transferLotQuantityCommandSchema.parse({
    id: newId(),
    branchId: input.branchId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: newId(),
    principal: { kind: "player", principalId: "player-1", controlledActorIds: [input.actorId] },
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    correlationId: newId(),
    type: "transfer_lot_quantity",
    schemaVersion: 1,
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
  subject: MeansSubject;
  bandKey: MeansBandKey;
  expectedVersion: number;
}): SetMeansBandCommand {
  return setMeansBandCommandSchema.parse({
    id: newId(),
    branchId: input.branchId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: newId(),
    principal: gmPrincipal,
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    correlationId: newId(),
    type: "set_means_band",
    schemaVersion: 1,
    payload: { subject: input.subject, bandKey: input.bandKey },
  });
}

// ---------------------------------------------------------------------------
// Row -> domain-shape mappers (local test copies of household-store.ts's
// private FromRow functions — that file exports only the insert direction,
// mirroring bodyMeterRowInsert/itemConditionMeterRowInsert's precedent).
// ---------------------------------------------------------------------------

function householdFromDbRow(row: typeof simHouseholds.$inferSelect): SimulationHousehold {
  return simulationHouseholdSchema.parse({
    id: row.householdId,
    name: row.name,
    residenceZoneIds: row.residenceZoneIds,
    stockAccessPolicy: row.stockAccessPolicy,
  });
}

function membershipFromDbRow(row: typeof simHouseholdMembers.$inferSelect): HouseholdMembership {
  return householdMembershipSchema.parse({
    householdId: row.householdId,
    actorId: row.actorId,
    role: row.role,
    status: row.status,
    ...(row.endedAtStorySecond === null ? {} : { endedAtStorySecond: row.endedAtStorySecond }),
  });
}

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

function lotFromDbRow(row: typeof simMaterialLots.$inferSelect): MaterialLotState {
  return materialLotStateSchema.parse({
    locus: lotLocusFromDbRow(row),
    materialKindKey: row.materialKindKey,
    quantityKind: row.quantityKind,
    quantityRaw: row.quantityRaw,
    registryVersion: row.registryVersion,
  });
}

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

function rowToEvent(row: typeof simEvents.$inferSelect): SimulationBranchEvent {
  return simulationBranchEventSchema.parse({
    id: row.id,
    worldId: row.worldId,
    branchId: row.branchId,
    sequence: row.sequence,
    storySecond: row.storySecond,
    type: row.type,
    schemaVersion: row.schemaVersion,
    rulesetVersion: row.rulesetVersion,
    ...(row.derivationVersion ? { derivationVersion: row.derivationVersion } : {}),
    ...(row.commandId ? { commandId: row.commandId } : {}),
    ...(row.causationId ? { causationId: row.causationId } : {}),
    correlationId: row.correlationId,
    actorIds: row.actorIds,
    entityIds: row.entityIds,
    ...(row.locationId ? { locationId: row.locationId } : {}),
    recordedAtWallClock: row.recordedAt.toISOString(),
    payload: row.payload,
  });
}

async function readBranchEvents(branchId: string): Promise<SimulationBranchEvent[]> {
  const rows = await db().select().from(simEvents).where(eq(simEvents.branchId, branchId)).orderBy(asc(simEvents.sequence));
  return rows.map(rowToEvent);
}

describe.runIf(ready)("E5.4 slice 1 durable households/lots/means substrate", () => {
  it("runs create_household -> set_household_membership -> adjust_material_lot -> transfer_lot_quantity end to end, and the DB CHECK independently rejects a negative quantity", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();

    const create = await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        householdId,
        name: "Vance household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    expect(create.status).toBe("accepted");

    const membership = await submitDurableSetHouseholdMembership(
      setMembershipCmd({
        branchId: ids.branchId,
        householdId,
        actorId: ids.mara,
        role: "resident",
        status: "active",
        expectedVersion: 1,
      }),
    );
    expect(membership.status).toBe("accepted");

    const stock = await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 10,
        expectedVersion: 2,
      }),
    );
    expect(stock.status).toBe("accepted");

    const transfer = await submitDurableTransferLotQuantity(
      transferLotCmd({
        branchId: ids.branchId,
        actorId: ids.mara,
        fromLocus: householdLocus(householdId),
        toLocus: actorLocus(ids.mara),
        materialKindKey: "bread",
        quantityRaw: 4,
        expectedVersion: 3,
      }),
    );
    expect(transfer.status).toBe("accepted");

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
        householdId,
        name: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );

    const result = await submitDurableTransferLotQuantity(
      transferLotCmd({
        branchId: ids.branchId,
        actorId: ids.outsider,
        fromLocus: householdLocus(householdId),
        toLocus: actorLocus(ids.outsider),
        materialKindKey: "bread",
        quantityRaw: 1,
        expectedVersion: 1,
      }),
    );
    expect(result).toMatchObject({ status: "rejected", code: "root_not_colocated" });
  });

  it("rejects transfer_lot_quantity as household_access_denied under an allow_list policy", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        householdId,
        name: "Household",
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
        actorId: ids.mara,
        fromLocus: householdLocus(householdId),
        toLocus: actorLocus(ids.mara),
        materialKindKey: "bread",
        quantityRaw: 1,
        expectedVersion: 1,
      }),
    );
    expect(result).toMatchObject({ status: "rejected", code: "household_access_denied" });
  });

  it("rejects transfer_lot_quantity as insufficient_balance against a never-stocked lot, leaving no lazily-built row behind", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const householdId = newId();
    await submitDurableCreateHousehold(
      createHouseholdCmd({
        branchId: ids.branchId,
        householdId,
        name: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableSetHouseholdMembership(
      setMembershipCmd({
        branchId: ids.branchId,
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
        actorId: ids.mara,
        fromLocus: householdLocus(householdId),
        toLocus: actorLocus(ids.mara),
        materialKindKey: "bread", // never stocked — the resolver sees it lazily-initialized at zero
        quantityRaw: 5,
        expectedVersion: 2,
      }),
    );
    expect(result).toMatchObject({ status: "rejected", code: "insufficient_balance" });

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
        householdId,
        name: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    const subject: MeansSubject = meansSubjectSchema.parse({ kind: "household", householdId });
    const bandResult = await submitDurableSetMeansBand(
      setMeansBandCmd({ branchId: ids.branchId, subject, bandKey: "modest", expectedVersion: 1 }),
    );
    expect(bandResult.status).toBe("accepted");

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
        locus: householdLocus(householdId),
        materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
        deltaRaw: 50_000,
        expectedVersion: 2,
      }),
    );
    expect(lotResult.status).toBe("accepted");

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
        householdId,
        name: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableSetHouseholdMembership(
      setMembershipCmd({
        branchId: ids.branchId,
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
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 10,
        expectedVersion: 2,
      }),
    );
    await submitDurableTransferLotQuantity(
      transferLotCmd({
        branchId: ids.branchId,
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
      setMeansBandCmd({ branchId: ids.branchId, subject, bandKey: "modest", expectedVersion: 4 }),
    );

    const [parentBranchRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!parentBranchRow) throw new Error("parent branch row missing");

    const childBranchId = newId();
    seededBranchIds.push(childBranchId);
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: parentBranchRow.headSequence,
      principal: { kind: "storyteller", principalId: "gm-1" },
      reason: "E5.4 slice 1 fork parity",
    });

    const parentEvents = await readBranchEvents(ids.branchId);
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
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 100,
        expectedVersion: childBranchRow.version,
      }),
    );
    expect(diverge.status).toBe("accepted");

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
        householdId,
        name: "Household",
        residenceZoneIds: [ids.zoneHome],
        stockAccessPolicy: { kind: "members_only" },
        expectedVersion: 0,
      }),
    );
    await submitDurableSetHouseholdMembership(
      setMembershipCmd({
        branchId: ids.branchId,
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
        locus: householdLocus(householdId),
        materialKindKey: "bread",
        deltaRaw: 10,
        expectedVersion: 2,
      }),
    );
    await submitDurableAdjustMaterialLot(
      adjustLotCmd({
        branchId: ids.branchId,
        locus: householdLocus(householdId),
        materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
        deltaRaw: 50_000,
        expectedVersion: 3,
      }),
    );
    await submitDurableTransferLotQuantity(
      transferLotCmd({
        branchId: ids.branchId,
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
      setMeansBandCmd({ branchId: ids.branchId, subject, bandKey: "comfortable", expectedVersion: 5 }),
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
    });

    const events = await readBranchEvents(ids.branchId);
    const rebuilt = replayHouseholdsHistory({ seed: emptyHouseholdsSeed(ids.branchId, SEED_SECOND), events });

    expect(simulationHash(live)).toBe(simulationHash(rebuilt));
  });
});
