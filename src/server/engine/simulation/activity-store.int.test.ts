import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  itemTransferProjectionSchema,
  type ItemTransferProjection,
} from "@/contracts/simulation/item-transfer";
import { newId } from "@/lib/ids";
import {
  activityCompletionUniquenessKey,
  deriveActivityId,
  emptyActivitiesSeed,
  replayActivitiesHistory,
  simulationHash,
} from "@/lib/simulation";
import { simulationBranchEventSchema } from "@/contracts/simulation/branching";
import { db, simEvents, simTriggers, simWorlds } from "@/server/db";
import {
  readDurableActivities,
  seedDurableActionDefinitions,
  submitDurableCancelActivity,
  submitDurableStartActivity,
} from "./activity-store";
import { forkBranch } from "./branch-store";
import { seedDurableItemTransferBranch } from "./item-transfer-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { readDurableSpaceBranch, seedDurableSpaceTopology, submitDurableMoveActor } from "./space-store";

const SEED_SECOND = 20_000;
const NAP_SECONDS = 1_800;
const WALK_AB = 600;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_activities limit 1`),
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
      `[activity-store.int.test] skipping: database unreachable or unmigrated: ${
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

interface ActivityCase {
  worldId: string;
  branchId: string;
  actorId: string;
  witnessId: string;
  zoneA: string;
  zoneB: string;
  napActionId: string;
}

function branchProjection(ids: ActivityCase): ItemTransferProjection {
  return itemTransferProjectionSchema.parse({
    worldId: ids.worldId,
    branchId: ids.branchId,
    rulesetVersion: "e3-2-test-v1",
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

async function seedActivityCase(): Promise<ActivityCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: ActivityCase = {
    worldId,
    branchId,
    actorId: newId(),
    witnessId: newId(),
    zoneA: `${branchId}-zone-a`,
    zoneB: `${branchId}-zone-b`,
    napActionId: `${branchId}-action-nap`,
  };
  const locHome = `${worldId}-loc-home`;
  await seedDurableItemTransferBranch(branchProjection(ids), {
    worldTypeId: "e3-2-tests",
    worldSeed: `seed-${worldId}`,
  });
  await seedDurableSpaceTopology({
    branchId,
    locations: [{ id: locHome, worldId, kind: "home", defaultAccessPolicy: "private" }],
    zones: [
      { id: ids.zoneA, locationId: locHome, kind: "room", privacyPolicy: "private" },
      { id: ids.zoneB, locationId: locHome, kind: "kitchen", privacyPolicy: "semi_private" },
    ],
    links: [
      {
        id: `${branchId}-link-ab`,
        fromZoneId: ids.zoneA,
        toZoneId: ids.zoneB,
        modes: ["walk"],
        minimumDurationSeconds: WALK_AB,
        accessPolicy: "public",
        state: "open",
      },
    ],
    loci: [
      { kind: "at", actorId: ids.actorId, locationId: locHome, zoneId: ids.zoneA, since: SEED_SECOND },
      { kind: "at", actorId: ids.witnessId, locationId: locHome, zoneId: ids.zoneA, since: SEED_SECOND },
    ],
  });
  await seedDurableActionDefinitions({
    branchId,
    definitions: [
      {
        id: ids.napActionId,
        version: 1,
        controllerKinds: ["player", "npc_policy"],
        duration: { kind: "fixed", seconds: NAP_SECONDS },
        preconditions: [{ kind: "at_zone_kind", zoneKind: "room" }],
        requiredClaims: [{ kind: "body" }, { kind: "attention", weight: "full" }],
        interruptibility: "pausable",
        noticeability: "obvious",
      },
    ],
  });
  seededWorldIds.push(worldId);
  return ids;
}

function startCommand(ids: ActivityCase, overrides: Record<string, unknown> = {}) {
  return {
    id: `cmd-start-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `start-key-${ids.branchId}`,
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-17T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "start_activity",
    schemaVersion: 1,
    payload: { actionDefinitionId: ids.napActionId, actorId: ids.actorId },
    ...overrides,
  };
}

function moveCommand(ids: ActivityCase, expectedVersion: number, suffix = "move") {
  return {
    id: `cmd-${suffix}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion,
    idempotencyKey: `${suffix}-key-${ids.branchId}`,
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-17T12:05:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "move_actor",
    schemaVersion: 1,
    payload: { actorId: ids.actorId, destinationZoneId: ids.zoneB, travelMode: "walk" },
  };
}

describe.runIf(ready)("E3.2 durable activity authority", () => {
  it("starts an activity with claims, witnesses, and a pending completion trigger", async () => {
    const ids = await seedActivityCase();
    const result = await submitDurableStartActivity(startCommand(ids));
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.eventIds).toHaveLength(2);

    const projection = await readDurableActivities(ids.branchId);
    expect(projection.activities).toHaveLength(1);
    expect(projection.activities[0]?.phase).toBe("active");
    expect(projection.activities[0]?.expectedCompleteAt).toBe(SEED_SECOND + NAP_SECONDS);

    const [startedRow] = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence))
      .limit(1);
    expect(startedRow?.type).toBe("activity_started");
    const startedPayload = z
      .object({ observerActorIds: z.array(z.string()) })
      .loose()
      .parse(startedRow?.payload);
    // The co-located witness is captured at start time.
    expect(startedPayload.observerActorIds).toEqual([ids.actorId, ids.witnessId].sort());

    const [trigger] = await db().select().from(simTriggers).where(eq(simTriggers.branchId, ids.branchId));
    expect(trigger?.kind).toBe("activity_completion_due");
    expect(trigger?.state).toBe("pending");
    expect(trigger?.dueStorySecond).toBe(SEED_SECOND + NAP_SECONDS);
  });

  it("completes through the scheduler drain at the due second", async () => {
    const ids = await seedActivityCase();
    await submitDurableStartActivity(startCommand(ids));
    const dueSecond = SEED_SECOND + NAP_SECONDS;

    const outcome = await advanceBranchStoryTime(ids.branchId, dueSecond + 100, { workerId: "w-complete" });
    expect(outcome.status).toBe("advanced");
    if (outcome.status !== "advanced") return;
    expect(outcome.drained).toBe(1);

    const projection = await readDurableActivities(ids.branchId);
    expect(projection.activities[0]?.phase).toBe("completed");
    expect(projection.activities[0]?.progressFixedPoint).toBe(1_000_000);

    const eventRows = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence));
    const completed = eventRows.at(-1);
    expect(completed?.type).toBe("activity_completed");
    expect(completed?.storySecond).toBe(dueSecond);

    const [trigger] = await db().select().from(simTriggers).where(eq(simTriggers.branchId, ids.branchId));
    expect(trigger?.state).toBe("completed");
  });

  it("enforces claims across activities and movement until release", async () => {
    const ids = await seedActivityCase();
    await submitDurableStartActivity(startCommand(ids));

    // A second body-claiming start conflicts.
    const second = await submitDurableStartActivity(
      startCommand(ids, {
        id: `cmd-start2-${ids.branchId}`,
        idempotencyKey: `start2-key-${ids.branchId}`,
        expectedVersion: 1,
      }),
    );
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") expect(second.code).toBe("claim_conflict");

    // Departure is blocked while the body claim is held.
    const blockedMove = await submitDurableMoveActor(moveCommand(ids, 1, "blocked"));
    expect(blockedMove.status).toBe("rejected");
    if (blockedMove.status === "rejected") expect(blockedMove.code).toBe("activity_conflict");

    // After completion the claim releases and the same move succeeds.
    await advanceBranchStoryTime(ids.branchId, SEED_SECOND + NAP_SECONDS, { workerId: "w-claims" });
    const freedMove = await submitDurableMoveActor(moveCommand(ids, 2, "freed"));
    expect(freedMove.status).toBe("accepted");

    // And starting while in transit is refused.
    const whileTraveling = await submitDurableStartActivity(
      startCommand(ids, {
        id: `cmd-start3-${ids.branchId}`,
        idempotencyKey: `start3-key-${ids.branchId}`,
        expectedVersion: 3,
      }),
    );
    expect(whileTraveling.status).toBe("rejected");
    if (whileTraveling.status === "rejected") expect(whileTraveling.code).toBe("actor_in_transit");
  });

  it("cancel releases the claim and retires the completion trigger", async () => {
    const ids = await seedActivityCase();
    await submitDurableStartActivity(startCommand(ids));
    const activityId = deriveActivityId(ids.branchId, `cmd-start-${ids.branchId}`);

    const cancel = await submitDurableCancelActivity({
      id: `cmd-cancel-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: 1,
      idempotencyKey: `cancel-key-${ids.branchId}`,
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
      submittedAtWallClock: "2026-07-17T12:10:00.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "cancel_activity",
      schemaVersion: 1,
      payload: { activityInstanceId: activityId, reason: "actor_choice" },
    });
    expect(cancel.status).toBe("accepted");

    const [trigger] = await db()
      .select()
      .from(simTriggers)
      .where(eq(simTriggers.uniquenessKey, activityCompletionUniquenessKey(activityId)));
    expect(trigger?.state).toBe("completed");
    expect(trigger?.resultCommandId).toBe(`cmd-cancel-${ids.branchId}`);

    // Advancing past the original due second fires nothing.
    const outcome = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + NAP_SECONDS + 100, {
      workerId: "w-cancelled",
    });
    expect(outcome).toMatchObject({ status: "advanced", drained: 0 });

    // The claim released: movement is legal again.
    const move = await submitDurableMoveActor(moveCommand(ids, 2, "after-cancel"));
    expect(move.status).toBe("accepted");
  });

  it("forks mid-activity with claims held and the completion re-armed; cancelled forks stay retired", async () => {
    const ids = await seedActivityCase();
    await submitDurableStartActivity(startCommand(ids));

    const midChild = newId();
    const midFork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId: midChild,
      atSequence: 2,
      principal: { kind: "player", principalId: "principal-1" },
      reason: "mid-activity retake",
    });
    expect(midFork.pendingTriggerIds).toHaveLength(1);
    const childActivities = await readDurableActivities(midChild);
    expect(childActivities.activities[0]?.phase).toBe("active");

    const outcome = await advanceBranchStoryTime(midChild, SEED_SECOND + NAP_SECONDS, { workerId: "w-child" });
    expect(outcome).toMatchObject({ status: "advanced", drained: 1 });
    const childDone = await readDurableActivities(midChild);
    expect(childDone.activities[0]?.phase).toBe("completed");

    // Cancel on the parent, fork after it: the child records the trigger retired.
    const activityId = deriveActivityId(ids.branchId, `cmd-start-${ids.branchId}`);
    await submitDurableCancelActivity({
      id: `cmd-cancel-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: 1,
      idempotencyKey: `cancel-key-${ids.branchId}`,
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
      submittedAtWallClock: "2026-07-17T12:10:00.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "cancel_activity",
      schemaVersion: 1,
      payload: { activityInstanceId: activityId, reason: "actor_choice" },
    });
    const cancelChild = newId();
    const cancelFork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId: cancelChild,
      atSequence: 3,
      principal: { kind: "player", principalId: "principal-1" },
      reason: "post-cancel retake",
    });
    expect(cancelFork.pendingTriggerIds).toHaveLength(0);
    expect(cancelFork.completedTriggerIds).toHaveLength(1);
    const cancelledChild = await readDurableActivities(cancelChild);
    expect(cancelledChild.activities[0]?.phase).toBe("cancelled");
  });

  it("rebuilds the activities projection from zero to the live hash", async () => {
    const ids = await seedActivityCase();
    await submitDurableStartActivity(startCommand(ids));
    await advanceBranchStoryTime(ids.branchId, SEED_SECOND + NAP_SECONDS, { workerId: "w-rebuild" });

    const live = await readDurableActivities(ids.branchId);
    const eventRows = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence));
    const events = eventRows.map((row) =>
      simulationBranchEventSchema.parse({
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
      }),
    );
    const rebuilt = replayActivitiesHistory({
      seed: emptyActivitiesSeed(ids.branchId, SEED_SECOND),
      events,
    });
    expect(simulationHash(rebuilt)).toBe(simulationHash(live));

    // Space state stayed coherent alongside: the actor never moved.
    const space = await readDurableSpaceBranch(ids.branchId);
    expect(space.loci.find((locus) => locus.actorId === ids.actorId)?.kind).toBe("at");
  });
});
