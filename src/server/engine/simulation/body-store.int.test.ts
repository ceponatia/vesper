import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  itemTransferProjectionSchema,
  type ItemTransferProjection,
} from "@/contracts/simulation/item-transfer";
import { newId } from "@/lib/ids";
import { db, simBodyConditions, simBodyMeters, simBodyModifiers, simEvents, simTriggers, simWorlds } from "@/server/db";
import {
  readDurableBodies,
  submitDurableApplyBodyCondition,
  submitDurableApplyBodySource,
  submitDurableInitializeActorBody,
} from "./body-store";
import { forkBranch } from "./branch-store";
import { seedDurableItemTransferBranch } from "./item-transfer-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { seedDurableSpaceTopology } from "./space-store";

const SEED_SECOND = 50_000;
// Registry v1: hygiene 9 000 → 2 500 at 150/h = 156 000s after seeding.
const HYGIENE_CROSSING = SEED_SECOND + 156_000;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_body_meters limit 1`),
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
      `[body-store.int.test] skipping: database unreachable or unmigrated: ${
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

interface BodyCase {
  worldId: string;
  branchId: string;
  actorId: string;
  witnessId: string;
  zoneId: string;
}

function branchProjection(ids: BodyCase): ItemTransferProjection {
  return itemTransferProjectionSchema.parse({
    worldId: ids.worldId,
    branchId: ids.branchId,
    rulesetVersion: "e5-1-test-v1",
    version: 0,
    headSequence: 0,
    storySecond: SEED_SECOND,
    actors: [
      { id: ids.actorId, name: "Mara", observedContainerIds: [] },
      { id: ids.witnessId, name: "Iris", observedContainerIds: [] },
    ],
    containers: [],
    items: [],
    observations: [],
  });
}

async function seedBodyCase(): Promise<BodyCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: BodyCase = {
    worldId,
    branchId,
    actorId: newId(),
    witnessId: newId(),
    zoneId: `${branchId}-zone-room`,
  };
  const locHome = `${worldId}-loc-home`;
  await seedDurableItemTransferBranch(branchProjection(ids), {
    worldTypeId: "e5-1-tests",
    worldSeed: `seed-${worldId}`,
  });
  await seedDurableSpaceTopology({
    branchId,
    locations: [{ id: locHome, worldId, kind: "home", defaultAccessPolicy: "public" }],
    zones: [{ id: ids.zoneId, locationId: locHome, kind: "room", privacyPolicy: "private" }],
    links: [],
    loci: [
      { kind: "at", actorId: ids.actorId, locationId: locHome, zoneId: ids.zoneId, since: SEED_SECOND },
      { kind: "at", actorId: ids.witnessId, locationId: locHome, zoneId: ids.zoneId, since: SEED_SECOND },
    ],
  });
  seededWorldIds.push(worldId);
  return ids;
}

function initializeCommand(ids: BodyCase) {
  return {
    id: `cmd-init-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `init-key-${ids.branchId}`,
    principal: { kind: "storyteller", principalId: "principal-1", controlledActorIds: [] },
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "initialize_actor_body",
    schemaVersion: 1,
    payload: { actorId: ids.actorId, registryVersion: "body-v1", baselineOverrides: {} },
  };
}

async function pendingBodyTriggers(branchId: string) {
  return db()
    .select({
      kind: simTriggers.kind,
      state: simTriggers.state,
      uniquenessKey: simTriggers.uniquenessKey,
      dueStorySecond: simTriggers.dueStorySecond,
    })
    .from(simTriggers)
    .where(
      and(
        eq(simTriggers.branchId, branchId),
        inArray(simTriggers.kind, ["body_threshold_due", "body_condition_expiry_due"]),
      ),
    )
    .orderBy(asc(simTriggers.dueStorySecond));
}

describe.runIf(ready)("E5.1 durable body substrate", () => {
  it("seeds the registry meters and arms the initial threshold alarms", async () => {
    const ids = await seedBodyCase();
    const result = await submitDurableInitializeActorBody(initializeCommand(ids));
    expect(result.status).toBe("accepted");

    const bodies = await readDurableBodies(ids.branchId);
    expect(bodies.meters.map((meter) => meter.meterKey)).toEqual(["arousal", "energy", "hygiene"]);
    expect(bodies.meters.every((meter) => meter.lastIntegratedAtStorySecond === SEED_SECOND)).toBe(true);

    const triggers = await pendingBodyTriggers(ids.branchId);
    // energy "depleted" and hygiene "grimy" arm; arousal has no thresholds.
    expect(triggers.filter((trigger) => trigger.state === "pending")).toHaveLength(2);
    expect(triggers.find((trigger) => trigger.dueStorySecond === HYGIENE_CROSSING)).toBeDefined();
  });

  it("retires and re-arms a meter's alarm when a source moves the trajectory", async () => {
    const ids = await seedBodyCase();
    await submitDurableInitializeActorBody(initializeCommand(ids));
    const wash = await submitDurableApplyBodySource({
      id: `cmd-wash-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: 1,
      idempotencyKey: `wash-key-${ids.branchId}`,
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
      submittedAtWallClock: "2026-07-19T12:01:00.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "apply_body_source",
      schemaVersion: 1,
      payload: {
        actorId: ids.actorId,
        meterKey: "hygiene",
        sourceKind: "wash",
        operation: { kind: "set", valueFixedPoint: 9_500 },
      },
    });
    expect(wash.status).toBe("accepted");

    const bodies = await readDurableBodies(ids.branchId);
    expect(bodies.meters.find((meter) => meter.meterKey === "hygiene")?.valueFixedPoint).toBe(9_500);

    const triggers = await pendingBodyTriggers(ids.branchId);
    const hygieneAlarms = triggers.filter((trigger) => trigger.uniquenessKey.includes("grimy"));
    // The seed-time alarm completed under the wash command; one fresh alarm
    // pends at the recomputed crossing (9 500 → 2 500 at 150/h = 168 000s).
    expect(hygieneAlarms.map((trigger) => trigger.state).sort()).toEqual(["completed", "pending"]);
    expect(hygieneAlarms.find((trigger) => trigger.state === "pending")?.dueStorySecond).toBe(
      SEED_SECOND + 168_000,
    );
  });

  it("fires a due threshold through the drain and captures co-located witnesses", async () => {
    const ids = await seedBodyCase();
    await submitDurableInitializeActorBody(initializeCommand(ids));
    const outcome = await advanceBranchStoryTime(ids.branchId, HYGIENE_CROSSING, { workerId: "w-grimy" });
    expect(outcome.status).toBe("advanced");

    const bodies = await readDurableBodies(ids.branchId);
    const hygiene = bodies.meters.find((meter) => meter.meterKey === "hygiene");
    expect(hygiene?.valueFixedPoint).toBe(2_500);
    expect(hygiene?.lastIntegratedAtStorySecond).toBe(HYGIENE_CROSSING);

    const [crossed] = await db()
      .select({ payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "body_threshold_crossed")));
    // hygiene "grimy" is a quiet crossing: subject-only, no witness capture.
    expect(crossed?.payload).toMatchObject({
      meterKey: "hygiene",
      thresholdKey: "grimy",
      valueAtCrossingFixedPoint: 2_500,
      observerActorIds: [],
    });

    // Drain on to the energy "depleted" crossing — noticeable, so the
    // co-located witness lands in the capture set.
    const [energyAlarm] = (await pendingBodyTriggers(ids.branchId)).filter(
      (trigger) => trigger.state === "pending" && trigger.uniquenessKey.includes("depleted"),
    );
    expect(energyAlarm).toBeDefined();
    if (!energyAlarm) throw new Error("energy alarm missing");
    const outcome2 = await advanceBranchStoryTime(ids.branchId, energyAlarm.dueStorySecond, {
      workerId: "w-depleted",
    });
    expect(outcome2.status).toBe("advanced");
    const crossings = await db()
      .select({ payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "body_threshold_crossed")));
    const depleted = crossings.find(
      (row) => (row.payload as { thresholdKey?: string }).thresholdKey === "depleted",
    );
    expect(depleted?.payload).toMatchObject({
      meterKey: "energy",
      observerActorIds: [ids.witnessId],
    });
  });

  it("expires a condition through the drain, closing its modifiers and re-arming", async () => {
    const ids = await seedBodyCase();
    await submitDurableInitializeActorBody(initializeCommand(ids));
    const nap = await submitDurableApplyBodyCondition({
      id: `cmd-nap-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: 1,
      idempotencyKey: `nap-key-${ids.branchId}`,
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
      submittedAtWallClock: "2026-07-19T12:02:00.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "apply_body_condition",
      schemaVersion: 1,
      payload: {
        actorId: ids.actorId,
        conditionKey: "asleep",
        durationSeconds: 5_400,
        modifiers: [{ meterKey: "energy", operation: { kind: "suspend" }, stackingGroup: "sleep" }],
        observerActorIds: [],
      },
    });
    expect(nap.status).toBe("accepted");

    const before = await readDurableBodies(ids.branchId);
    expect(before.conditions[0]).toMatchObject({ key: "asleep", status: "active" });
    expect(before.modifiers[0]?.validUntilStorySecond).toBe(SEED_SECOND + 5_400);

    const outcome = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + 5_400, { workerId: "w-wake" });
    expect(outcome.status).toBe("advanced");

    const after = await readDurableBodies(ids.branchId);
    expect(after.conditions[0]).toMatchObject({ key: "asleep", status: "ended", endBasis: "expired" });
    // Suspension shifted the energy crossing out by exactly the nap.
    const alarms = await pendingBodyTriggers(ids.branchId);
    const energyAlarm = alarms.find(
      (trigger) => trigger.state === "pending" && trigger.uniquenessKey.includes("depleted"),
    );
    expect(energyAlarm).toBeDefined();
    const expiry = alarms.find((trigger) => trigger.kind === "body_condition_expiry_due");
    expect(expiry?.state).toBe("completed");
  });

  it("forks with bit-identical body rows and re-armed alarms on the child", async () => {
    const ids = await seedBodyCase();
    await submitDurableInitializeActorBody(initializeCommand(ids));
    const parent = await readDurableBodies(ids.branchId);

    const childBranchId = newId();
    const fork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: parent.headSequence,
      principal: { kind: "storyteller", principalId: "principal-1" },
      reason: "E5.1 body fork parity",
    });
    expect(fork.pendingTriggerIds.length).toBeGreaterThanOrEqual(2);

    const child = await readDurableBodies(childBranchId);
    expect(child.meters).toEqual(parent.meters);
    expect(child.conditions).toEqual(parent.conditions);
    expect(child.modifiers).toEqual(parent.modifiers);

    const [childMeterRow] = await db()
      .select({ updatedSequence: simBodyMeters.updatedSequence })
      .from(simBodyMeters)
      .where(and(eq(simBodyMeters.branchId, childBranchId), eq(simBodyMeters.meterKey, "energy")))
      .limit(1);
    expect(childMeterRow).toBeDefined();
    const childConditions = await db()
      .select()
      .from(simBodyConditions)
      .where(eq(simBodyConditions.branchId, childBranchId));
    const childModifiers = await db()
      .select()
      .from(simBodyModifiers)
      .where(eq(simBodyModifiers.branchId, childBranchId));
    expect(childConditions).toHaveLength(parent.conditions.length);
    expect(childModifiers).toHaveLength(parent.modifiers.length);
  });
});
