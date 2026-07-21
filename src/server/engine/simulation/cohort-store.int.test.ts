import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
import { newId } from "@/lib/ids";
import { cohortPresenceAt, emptyCohortsSeed, replayCohortHistory, zonePresenceAt } from "@/lib/simulation";
import { db, simBranches, simCohorts, simEvents, simMeansBands, simTriggers, simWorlds } from "@/server/db";
import { forkBranch } from "./branch-store";
import { loadBranchCohorts, submitDurableAdjustCohort, submitDurableCreateCohort } from "./cohort-store";
import { submitDurableSetMeansBand } from "./household-store";
import { seedDurableMaterialBranch } from "./material-store";
import { branchEventFromRow } from "./observation-store";
import { seedDurableSpaceTopology } from "./space-store";

/**
 * E6.3 durable cohort authority (engine.spec §27.6): create/adjust end to
 * end — zone validation, conservation, idempotency, authorization, the
 * cohort means band, fork parity, and the aggregate no-work guarantee (a
 * cohort never arms a trigger). Mirrors lod-store.int.test.ts's harness.
 */

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_cohorts limit 1`),
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
      `[cohort-store.int.test] skipping: database unreachable or unmigrated: ${
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

afterAll(async () => {
  if (!ready || seededWorldIds.length === 0) return;
  await db().delete(simWorlds).where(inArray(simWorlds.id, seededWorldIds));
});

/** Day 2, 07:33. The market window (08:00–18:00) opens 27 minutes later. */
const SEED_SECOND = 200_000;
const MARKET_OPEN_SECOND = 2 * 86_400 + 600 * 60; // day 2, 10:00 — mid-window

interface CohortCase {
  worldId: string;
  branchId: string;
  locationId: string;
  squareZoneId: string;
  ana: string;
}

function branchSeed(ids: CohortCase): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e6-3-test-world",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e6-3-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [{ id: ids.ana, name: "Ana" }],
    items: [],
  });
}

async function seedCase(): Promise<CohortCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: CohortCase = {
    worldId,
    branchId,
    locationId: `${worldId}-loc-town`,
    squareZoneId: `${branchId}-zone-square`,
    ana: newId(),
  };
  seededWorldIds.push(worldId);
  await seedDurableMaterialBranch(branchSeed(ids));
  await seedDurableSpaceTopology({
    branchId,
    locations: [{ id: ids.locationId, worldId, kind: "town", defaultAccessPolicy: "public" }],
    zones: [{ id: ids.squareZoneId, locationId: ids.locationId, kind: "plaza", privacyPolicy: "public" }],
    links: [],
    loci: [
      { kind: "at", actorId: ids.ana, locationId: ids.locationId, zoneId: ids.squareZoneId, since: SEED_SECOND },
    ],
  });
  return ids;
}

const admit = { admitAtLockedVersion: true };
const gmPrincipal = { kind: "storyteller" as const, principalId: "gm-1", controlledActorIds: [] };

function command(
  ids: CohortCase,
  name: string,
  type: string,
  payload: Record<string, unknown>,
  principal: object = gmPrincipal,
) {
  return {
    id: `cmd-${name}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `${name}-key-${ids.branchId}`,
    principal,
    submittedAtWallClock: "2026-07-21T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type,
    schemaVersion: 1,
    payload,
  };
}

function marketPayload(ids: CohortCase, cohortId: string, population = 200) {
  return {
    cohort: {
      id: cohortId,
      name: "market regulars",
      population,
      presenceWindows: [
        { zoneId: ids.squareZoneId, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 8_000 },
      ],
      registryVersion: "cohort-v1",
    },
  };
}

describe.runIf(ready)("E6.3 durable cohort authority", () => {
  it("creates, adjusts conservatively, wears a means band, and forks with parity", async () => {
    const ids = await seedCase();
    const cohortId = newId();

    // A cohort cannot gather somewhere that does not exist.
    const ghostZone = await submitDurableCreateCohort(
      command(ids, "ghost-zone", "create_cohort", {
        cohort: {
          ...marketPayload(ids, cohortId).cohort,
          presenceWindows: [
            { zoneId: `${ids.branchId}-zone-nowhere`, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 8_000 },
          ],
        },
      }),
      admit,
    );
    expect(ghostZone).toMatchObject({ status: "rejected", code: "zone_not_found" });

    // A player principal cannot people the background.
    const unauthorized = await submitDurableCreateCohort(
      command(ids, "player-create", "create_cohort", marketPayload(ids, cohortId), {
        kind: "player",
        principalId: "player-1",
        controlledActorIds: [ids.ana],
      }),
      admit,
    );
    expect(unauthorized).toMatchObject({ status: "rejected", code: "unauthorized_principal" });

    const created = await submitDurableCreateCohort(
      command(ids, "create-market", "create_cohort", marketPayload(ids, cohortId)),
      admit,
    );
    expect(created.status).toBe("accepted");
    const duplicated = await submitDurableCreateCohort(
      command(ids, "create-market-again", "create_cohort", marketPayload(ids, cohortId)),
      admit,
    );
    expect(duplicated).toMatchObject({ status: "rejected", code: "cohort_already_exists" });
    // Idempotency: the same command replays its cached result.
    const replayedCreate = await submitDurableCreateCohort(
      command(ids, "create-market", "create_cohort", marketPayload(ids, cohortId)),
      admit,
    );
    expect(replayedCreate).toEqual(created);

    // The analytic presence read: mid-window, 80% of 200 at the square —
    // and the read wrote nothing.
    const cohorts = await loadBranchCohorts(db(), ids.branchId);
    expect(cohorts).toHaveLength(1);
    const presentCohort = cohorts[0];
    if (!presentCohort) throw new Error("cohort row missing");
    expect(cohortPresenceAt(presentCohort, MARKET_OPEN_SECOND)).toEqual({
      zoneId: ids.squareZoneId,
      presentCount: 160,
    });
    expect(zonePresenceAt(cohorts, ids.squareZoneId, SEED_SECOND)).toBe(0);

    // Conserved adjustment: a promotion-style debit lands both counts on the
    // event; draining below zero is a structured rejection.
    const debited = await submitDurableAdjustCohort(
      command(ids, "reserve-one", "adjust_cohort", {
        cohortId,
        deltaCount: -1,
        reason: "promotion_reservation",
      }),
      admit,
    );
    expect(debited.status).toBe("accepted");
    const overdrawn = await submitDurableAdjustCohort(
      command(ids, "overdraw", "adjust_cohort", { cohortId, deltaCount: -500, reason: "attrition" }),
      admit,
    );
    expect(overdrawn).toMatchObject({ status: "rejected", code: "insufficient_population" });
    const [adjustedRow] = await db()
      .select()
      .from(simCohorts)
      .where(and(eq(simCohorts.branchId, ids.branchId), eq(simCohorts.cohortId, cohortId)));
    expect(adjustedRow).toMatchObject({ population: 199 });
    const adjustEvents = await db()
      .select({ payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "cohort_adjusted")));
    expect(adjustEvents).toHaveLength(1);
    expect(adjustEvents[0]?.payload).toMatchObject({
      cohortId,
      deltaCount: -1,
      reason: "promotion_reservation",
      populationBefore: 200,
      populationAfter: 199,
    });

    // §26.10 extension: a cohort wears a means band; a ghost cohort cannot.
    const banded = await submitDurableSetMeansBand(
      command(ids, "band-market", "set_means_band", {
        subject: { kind: "cohort", cohortId },
        bandKey: "modest",
      }),
      admit,
    );
    expect(banded.status).toBe("accepted");
    const ghostBand = await submitDurableSetMeansBand(
      command(ids, "band-ghost", "set_means_band", {
        subject: { kind: "cohort", cohortId: newId() },
        bandKey: "modest",
      }),
      admit,
    );
    expect(ghostBand).toMatchObject({ status: "rejected", code: "subject_not_found" });
    const bandRows = await db()
      .select({ subjectKind: simMeansBands.subjectKind, cohortId: simMeansBands.cohortId, bandKey: simMeansBands.bandKey })
      .from(simMeansBands)
      .where(eq(simMeansBands.branchId, ids.branchId));
    expect(bandRows).toContainEqual({ subjectKind: "cohort", cohortId, bandKey: "modest" });

    // The aggregate lane arms nothing, ever.
    const pendingTriggers = await db()
      .select({ id: simTriggers.id })
      .from(simTriggers)
      .where(and(eq(simTriggers.branchId, ids.branchId), eq(simTriggers.state, "pending")));
    expect(pendingTriggers).toHaveLength(0);

    // Fork at head: the child's cohort rows replay bit-identical from events
    // and the child's presence read matches the parent's.
    const [parentRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!parentRow) throw new Error("parent branch row missing");
    const childBranchId = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: parentRow.headSequence,
      principal: { kind: "storyteller", principalId: "gm-1" },
      reason: "E6.3 cohort fork parity",
    });
    const parentEvents = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(simEvents.sequence)
      .then((rows) => rows.map(branchEventFromRow));
    const replayedProjection = replayCohortHistory({
      seed: emptyCohortsSeed(childBranchId, SEED_SECOND),
      events: parentEvents,
    });
    const childCohorts = await loadBranchCohorts(db(), childBranchId);
    expect(childCohorts).toEqual(replayedProjection.cohorts);
    const childCohort = childCohorts[0];
    if (!childCohort) throw new Error("child cohort row missing");
    expect(cohortPresenceAt(childCohort, MARKET_OPEN_SECOND)).toEqual({
      zoneId: ids.squareZoneId,
      presentCount: Math.floor((199 * 8_000) / 10_000),
    });
  });
});
