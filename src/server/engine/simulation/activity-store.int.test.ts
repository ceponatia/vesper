import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
import { itemTransferFeedConsumerKind } from "@/contracts/simulation/outbox";
import { newId } from "@/lib/ids";
import {
  activityCompletionUniquenessKey,
  deriveActivityId,
  emptyActivitiesSeed,
  replayActivitiesHistory,
  simulationHash,
} from "@/lib/simulation";
import { simulationBranchEventSchema } from "@/contracts/simulation/branching";
import { bodyThresholdUniquenessKeyPrefix } from "@/lib/simulation/bodies";
import {
  db,
  simActivities,
  simBodyMeters,
  simBranches,
  simEvents,
  simItemConditionMeters,
  simItemHoldings,
  simOutbox,
  simTriggers,
  simWorlds,
} from "@/server/db";
import {
  readDurableActivities,
  seedDurableActionDefinitions,
  submitDurableCancelActivity,
  submitDurableResumeActivity,
  submitDurableStartActivity,
} from "./activity-store";
import {
  seedDurableBodyRhythms,
  submitDurableApplyBodyCondition,
  submitDurableInitializeActorBody,
} from "./body-store";
import { forkBranch } from "./branch-store";
import { seedDurableMaterialBranch, submitDurableTransferItem } from "./material-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { readDurableSpaceBranch, seedDurableSpaceTopology, submitDurableMoveActor } from "./space-store";
import { requireLegacyUnanchoredEngineTestMode } from "@/server/test-support";

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
if (ready) requireLegacyUnanchoredEngineTestMode("activity-store.int.test");
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

function branchSeed(ids: ActivityCase): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e3-2-tests",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e3-2-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.actorId, name: "Mara" },
      { id: ids.witnessId, name: "Iris" },
    ],
    items: [],
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
  await seedDurableMaterialBranch(branchSeed(ids));
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

// -----------------------------------------------------------------------
// E5.3 slice 2 (§26.5–26.6) — resource-cost reservation at start and
// consume-disposition consumption at completion.
// -----------------------------------------------------------------------

/**
 * Long enough that the collapse-interruption test's alarm (armed ~24–48h
 * after wake, the same window body-store.int.test.ts's vigil test proves
 * out) fires mid-meal rather than after it — short enough that every other
 * test's drain-to-completion stays a single plain arithmetic offset.
 */
const MEAL_SECONDS = 200_000;
const MEAL_ENERGY_DELTA = 2_000;

interface ConsumptionCase {
  worldId: string;
  branchId: string;
  actorId: string;
  witnessId: string;
  zoneA: string;
  mealItemId: string;
  eatActionId: string;
  eatFeastActionId: string;
}

function consumptionBranchSeed(ids: ConsumptionCase, includeMeal: boolean): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e5-3-slice2-tests",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e5-3-slice2-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.actorId, name: "Mara" },
      { id: ids.witnessId, name: "Iris" },
    ],
    items: includeMeal
      ? [
          {
            id: ids.mealItemId,
            name: "Rice bowl",
            materialKindKey: "meal",
            consumptionEffects: [
              {
                meterKey: "energy",
                sourceKind: "meal",
                operation: { kind: "add", deltaFixedPoint: MEAL_ENERGY_DELTA },
              },
            ],
            locus: { kind: "held", actorId: ids.actorId },
          },
        ]
      : [],
  });
}

async function seedConsumptionCase(options: { includeMeal?: boolean } = {}): Promise<ConsumptionCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: ConsumptionCase = {
    worldId,
    branchId,
    actorId: newId(),
    witnessId: newId(),
    zoneA: `${branchId}-zone-a`,
    mealItemId: `${branchId}-item-meal`,
    eatActionId: `${branchId}-action-eat`,
    eatFeastActionId: `${branchId}-action-eat-feast`,
  };
  const locHome = `${worldId}-loc-home`;
  await seedDurableMaterialBranch(consumptionBranchSeed(ids, options.includeMeal ?? true));
  await seedDurableSpaceTopology({
    branchId,
    locations: [{ id: locHome, worldId, kind: "home", defaultAccessPolicy: "private" }],
    zones: [{ id: ids.zoneA, locationId: locHome, kind: "room", privacyPolicy: "private" }],
    links: [],
    loci: [
      { kind: "at", actorId: ids.actorId, locationId: locHome, zoneId: ids.zoneA, since: SEED_SECOND },
      { kind: "at", actorId: ids.witnessId, locationId: locHome, zoneId: ids.zoneA, since: SEED_SECOND },
    ],
  });
  await seedDurableActionDefinitions({
    branchId,
    definitions: [
      {
        id: ids.eatActionId,
        version: 1,
        controllerKinds: ["player", "npc_policy"],
        duration: { kind: "fixed", seconds: MEAL_SECONDS },
        preconditions: [{ kind: "at_zone_kind", zoneKind: "room" }],
        requiredClaims: [{ kind: "body" }, { kind: "attention", weight: "full" }],
        interruptibility: "pausable",
        noticeability: "obvious",
        resourceCosts: [{ materialKindKey: "meal", quantity: 1, disposition: "consume" }],
      },
      {
        id: ids.eatFeastActionId,
        version: 1,
        controllerKinds: ["player", "npc_policy"],
        duration: { kind: "fixed", seconds: MEAL_SECONDS },
        preconditions: [{ kind: "at_zone_kind", zoneKind: "room" }],
        requiredClaims: [{ kind: "body" }, { kind: "attention", weight: "full" }],
        interruptibility: "pausable",
        noticeability: "obvious",
        resourceCosts: [{ materialKindKey: "meal", quantity: 2, disposition: "consume" }],
      },
    ],
  });
  seededWorldIds.push(worldId);
  return ids;
}

function startEatCommand(ids: ConsumptionCase, overrides: Record<string, unknown> = {}) {
  return {
    id: `cmd-eat-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `eat-key-${ids.branchId}`,
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-19T18:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "start_activity",
    schemaVersion: 1,
    payload: { actionDefinitionId: ids.eatActionId, actorId: ids.actorId },
    ...overrides,
  };
}

function transferMealCommand(ids: ConsumptionCase, expectedVersion: number, suffix: string) {
  return {
    id: `cmd-${suffix}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion,
    idempotencyKey: `${suffix}-key-${ids.branchId}`,
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-19T18:05:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "transfer_item",
    schemaVersion: 2,
    payload: {
      actorId: ids.actorId,
      itemId: ids.mealItemId,
      fromLocus: { kind: "held", actorId: ids.actorId },
      toLocus: { kind: "zone", zoneId: ids.zoneA },
    },
  };
}

function initializeBodyCommand(ids: ConsumptionCase, expectedVersion: number) {
  return {
    id: `cmd-init-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion,
    idempotencyKey: `init-key-${ids.branchId}`,
    principal: { kind: "storyteller", principalId: "principal-1", controlledActorIds: [] },
    submittedAtWallClock: "2026-07-19T18:00:30.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "initialize_actor_body",
    schemaVersion: 1,
    payload: { actorId: ids.actorId, registryVersion: "body-v1", baselineOverrides: {} },
  };
}

async function currentBranchVersion(branchId: string): Promise<number> {
  const [row] = await db().select({ version: simBranches.version }).from(simBranches).where(eq(simBranches.id, branchId)).limit(1);
  if (!row) throw new Error("branch missing for version lookup");
  return row.version;
}

describe.runIf(ready)("E5.3 slice 2 — activity resource reservations and consumption", () => {
  it("reserves the held meal deterministically and persists reservedItemIds", async () => {
    const ids = await seedConsumptionCase();
    const result = await submitDurableStartActivity(startEatCommand(ids));
    expect(result.status).toBe("accepted");

    const projection = await readDurableActivities(ids.branchId);
    expect(projection.activities[0]?.reservedItemIds).toEqual([ids.mealItemId]);

    const [startedRow] = await db()
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "activity_started")));
    const startedPayload = z.object({ reservedItemIds: z.array(z.string()) }).loose().parse(startedRow?.payload);
    expect(startedPayload.reservedItemIds).toEqual([ids.mealItemId]);
  });

  it("rejects start with material_unavailable when the resource cost cannot be met", async () => {
    const ids = await seedConsumptionCase();
    const result = await submitDurableStartActivity(
      startEatCommand(ids, {
        id: `cmd-feast-${ids.branchId}`,
        idempotencyKey: `feast-key-${ids.branchId}`,
        payload: { actionDefinitionId: ids.eatFeastActionId, actorId: ids.actorId },
      }),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.code).toBe("material_unavailable");
  });

  it("rejects a transfer of the reserved item while the activity holds it", async () => {
    const ids = await seedConsumptionCase();
    const start = await submitDurableStartActivity(startEatCommand(ids));
    expect(start.status).toBe("accepted");

    const transfer = await submitDurableTransferItem(transferMealCommand(ids, 1, "transfer-blocked"));
    expect(transfer.status).toBe("rejected");
    if (transfer.status === "rejected") expect(transfer.code).toBe("item_reserved");
  });

  it("cancellation releases the reservation — a transfer then succeeds", async () => {
    const ids = await seedConsumptionCase();
    await submitDurableStartActivity(startEatCommand(ids));
    const activityId = deriveActivityId(ids.branchId, `cmd-eat-${ids.branchId}`);

    const cancel = await submitDurableCancelActivity({
      id: `cmd-cancel-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: 1,
      idempotencyKey: `cancel-key-${ids.branchId}`,
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
      submittedAtWallClock: "2026-07-19T18:10:00.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "cancel_activity",
      schemaVersion: 1,
      payload: { activityInstanceId: activityId, reason: "actor_choice" },
    });
    expect(cancel.status).toBe("accepted");

    const transfer = await submitDurableTransferItem(transferMealCommand(ids, 2, "transfer-after-cancel"));
    expect(transfer.status).toBe("accepted");
  });

  it("completes through the drain: consumes the meal, applies the body effect, retires and re-arms the energy alarm, publishes the feed row", async () => {
    const ids = await seedConsumptionCase();
    const init = await submitDurableInitializeActorBody(initializeBodyCommand(ids, 0));
    expect(init.status).toBe("accepted");

    const energyThresholdPrefix = bodyThresholdUniquenessKeyPrefix(ids.actorId, "energy");
    const beforeTriggers = await db()
      .select({ id: simTriggers.id, state: simTriggers.state })
      .from(simTriggers)
      .where(
        and(
          eq(simTriggers.branchId, ids.branchId),
          sql`starts_with(${simTriggers.uniquenessKey}, ${energyThresholdPrefix})`,
        ),
      );
    expect(beforeTriggers.some((row) => row.state === "pending")).toBe(true);
    const staleTriggerIds = beforeTriggers.map((row) => row.id);

    const start = await submitDurableStartActivity({ ...startEatCommand(ids), expectedVersion: 1 });
    expect(start.status).toBe("accepted");
    const dueSecond = SEED_SECOND + MEAL_SECONDS;

    const outcome = await advanceBranchStoryTime(ids.branchId, dueSecond + 10, { workerId: "w-eat-complete" });
    expect(outcome.status).toBe("advanced");

    const projection = await readDurableActivities(ids.branchId);
    expect(projection.activities[0]?.phase).toBe("completed");

    const [holdingRow] = await db()
      .select()
      .from(simItemHoldings)
      .where(and(eq(simItemHoldings.branchId, ids.branchId), eq(simItemHoldings.itemId, ids.mealItemId)));
    expect(holdingRow?.locusKind).toBe("gone");
    expect(holdingRow?.goneBasis).toBe("consumed");

    const eventRows = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence));
    const consumedEvent = eventRows.find((row) => row.type === "item_consumed");
    expect(consumedEvent).toBeDefined();
    const sourceEvent = eventRows.find((row) => row.type === "body_source_applied");
    expect(sourceEvent).toBeDefined();
    const sourcePayload = z
      .object({ meterKey: z.string(), valueAfterFixedPoint: z.number() })
      .loose()
      .parse(sourceEvent?.payload);
    expect(sourcePayload.meterKey).toBe("energy");
    // Causation-chained to the item_consumed event, not to the completion (§26.6).
    expect(sourceEvent?.causationId).toBe(consumedEvent?.id);

    const [meterRow] = await db()
      .select()
      .from(simBodyMeters)
      .where(
        and(
          eq(simBodyMeters.branchId, ids.branchId),
          eq(simBodyMeters.actorId, ids.actorId),
          eq(simBodyMeters.meterKey, "energy"),
        ),
      );
    expect(meterRow?.lastIntegratedAt).toBe(dueSecond);
    expect(meterRow?.valueFixedPoint).toBe(sourcePayload.valueAfterFixedPoint);

    const afterTriggers = await db()
      .select({ id: simTriggers.id, state: simTriggers.state })
      .from(simTriggers)
      .where(
        and(
          eq(simTriggers.branchId, ids.branchId),
          sql`starts_with(${simTriggers.uniquenessKey}, ${energyThresholdPrefix})`,
        ),
      );
    expect(afterTriggers.filter((row) => staleTriggerIds.includes(row.id)).every((row) => row.state === "completed")).toBe(
      true,
    );
    expect(afterTriggers.some((row) => row.state === "pending")).toBe(true);

    const [feedRow] = await db()
      .select()
      .from(simOutbox)
      .where(
        and(
          eq(simOutbox.branchId, ids.branchId),
          eq(simOutbox.consumerKind, itemTransferFeedConsumerKind),
          eq(simOutbox.sourceEventId, consumedEvent?.id ?? ""),
        ),
      );
    expect(feedRow).toBeDefined();
  });

  it("keeps the reservation through an interruption and consumes normally after resume", async () => {
    const ids = await seedConsumptionCase();
    await seedDurableBodyRhythms({
      branchId: ids.branchId,
      rows: [
        { actorId: ids.actorId, kind: "sleep", startMinuteOfDay: 1_380, endMinuteOfDay: 420 },
        { actorId: ids.actorId, kind: "wash", startMinuteOfDay: 405, endMinuteOfDay: 420 },
      ],
    });
    await submitDurableInitializeActorBody(initializeBodyCommand(ids, 0));

    // A short nap creates real sleep history — the wake is what arms the
    // collapse alarm this test uses to force a mid-meal interruption
    // (mirrors body-store.int.test.ts's collapse-arc test).
    await submitDurableApplyBodyCondition({
      id: `cmd-nap-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: await currentBranchVersion(ids.branchId),
      idempotencyKey: `nap-key-${ids.branchId}`,
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
      submittedAtWallClock: "2026-07-19T18:01:00.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "apply_body_condition",
      schemaVersion: 1,
      payload: {
        actorId: ids.actorId,
        conditionKey: "asleep",
        durationSeconds: 5_400,
        modifiers: [],
        observerActorIds: [],
      },
    });
    const wakeAt = SEED_SECOND + 5_400;
    await advanceBranchStoryTime(ids.branchId, wakeAt, { workerId: "w-eat-wake" });

    const [collapseAlarm] = await db()
      .select({ dueStorySecond: simTriggers.dueStorySecond })
      .from(simTriggers)
      .where(
        and(
          eq(simTriggers.branchId, ids.branchId),
          eq(simTriggers.kind, "body_collapse_due"),
          eq(simTriggers.state, "pending"),
        ),
      );
    expect(collapseAlarm).toBeDefined();
    if (!collapseAlarm) throw new Error("collapse alarm missing");

    const start = await submitDurableStartActivity({
      ...startEatCommand(ids),
      expectedVersion: await currentBranchVersion(ids.branchId),
    });
    expect(start.status).toBe("accepted");
    const activityId = deriveActivityId(ids.branchId, `cmd-eat-${ids.branchId}`);

    // The collapse fires mid-meal. Reservations are phase-derived like claims
    // (§26.5) — held across every claim-holding phase including interrupted.
    const collapseOutcome = await advanceBranchStoryTime(ids.branchId, collapseAlarm.dueStorySecond, {
      workerId: "w-eat-collapse",
    });
    expect(collapseOutcome.status).toBe("advanced");

    const [interruptedRow] = await db().select().from(simActivities).where(eq(simActivities.branchId, ids.branchId));
    expect(interruptedRow?.phase).toBe("interrupted");
    expect(interruptedRow?.reservedItemIds).toEqual([ids.mealItemId]);

    const blockedTransfer = await submitDurableTransferItem(
      transferMealCommand(ids, await currentBranchVersion(ids.branchId), "transfer-while-interrupted"),
    );
    expect(blockedTransfer.status).toBe("rejected");
    if (blockedTransfer.status === "rejected") expect(blockedTransfer.code).toBe("item_reserved");

    // Sleep runs its course; resume picks the meal back up with the same
    // reservation, then finishes it normally.
    const wake2 = collapseAlarm.dueStorySecond + 28_800;
    await advanceBranchStoryTime(ids.branchId, wake2, { workerId: "w-eat-wake2" });

    const resume = await submitDurableResumeActivity({
      id: `cmd-resume-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: await currentBranchVersion(ids.branchId),
      idempotencyKey: `resume-key-${ids.branchId}`,
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
      submittedAtWallClock: "2026-07-19T18:20:00.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "resume_activity",
      schemaVersion: 1,
      payload: { activityInstanceId: activityId },
    });
    expect(resume.status).toBe("accepted");

    const [resumedRow] = await db().select().from(simActivities).where(eq(simActivities.branchId, ids.branchId));
    expect(resumedRow?.phase).toBe("active");
    expect(resumedRow?.reservedItemIds).toEqual([ids.mealItemId]);

    const finishOutcome = await advanceBranchStoryTime(ids.branchId, (resumedRow?.expectedCompleteAt ?? 0) + 10, {
      workerId: "w-eat-finish",
    });
    expect(finishOutcome.status).toBe("advanced");

    const finalProjection = await readDurableActivities(ids.branchId);
    expect(finalProjection.activities[0]?.phase).toBe("completed");
    const [finalHolding] = await db()
      .select()
      .from(simItemHoldings)
      .where(and(eq(simItemHoldings.branchId, ids.branchId), eq(simItemHoldings.itemId, ids.mealItemId)));
    expect(finalHolding?.goneBasis).toBe("consumed");
  });
});

// -----------------------------------------------------------------------
// E5.3 slice 3 (§26.7) — use-disposition item-condition deltas at completion.
// -----------------------------------------------------------------------

const CRAFT_SECONDS = 600;

interface ItemConditionCase {
  worldId: string;
  branchId: string;
  actorId: string;
  witnessId: string;
  zoneA: string;
  toolId: string;
  craftActionId: string;
}

function itemConditionBranchSeed(ids: ItemConditionCase, conditionTracked: boolean): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e5-3-slice3-tests",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e5-3-slice3-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.actorId, name: "Mara" },
      { id: ids.witnessId, name: "Iris" },
    ],
    items: [
      {
        id: ids.toolId,
        name: "Whittling knife",
        materialKindKey: "tool",
        conditionTracked,
        locus: { kind: "held", actorId: ids.actorId },
      },
    ],
  });
}

async function seedItemConditionCase(options: {
  conditionTracked: boolean;
  wearDeltaFixedPoint: number;
}): Promise<ItemConditionCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: ItemConditionCase = {
    worldId,
    branchId,
    actorId: newId(),
    witnessId: newId(),
    zoneA: `${branchId}-zone-a`,
    toolId: `${branchId}-item-tool`,
    craftActionId: `${branchId}-action-craft`,
  };
  const locHome = `${worldId}-loc-home`;
  await seedDurableMaterialBranch(itemConditionBranchSeed(ids, options.conditionTracked));
  await seedDurableSpaceTopology({
    branchId,
    locations: [{ id: locHome, worldId, kind: "home", defaultAccessPolicy: "private" }],
    zones: [{ id: ids.zoneA, locationId: locHome, kind: "room", privacyPolicy: "private" }],
    links: [],
    loci: [
      { kind: "at", actorId: ids.actorId, locationId: locHome, zoneId: ids.zoneA, since: SEED_SECOND },
      { kind: "at", actorId: ids.witnessId, locationId: locHome, zoneId: ids.zoneA, since: SEED_SECOND },
    ],
  });
  await seedDurableActionDefinitions({
    branchId,
    definitions: [
      {
        id: ids.craftActionId,
        version: 1,
        controllerKinds: ["player", "npc_policy"],
        duration: { kind: "fixed", seconds: CRAFT_SECONDS },
        preconditions: [{ kind: "at_zone_kind", zoneKind: "room" }],
        requiredClaims: [{ kind: "body" }, { kind: "attention", weight: "full" }],
        interruptibility: "pausable",
        noticeability: "obvious",
        resourceCosts: [
          {
            materialKindKey: "tool",
            quantity: 1,
            disposition: "use",
            useConditionDeltas: [{ meterKey: "wear", deltaFixedPoint: options.wearDeltaFixedPoint }],
          },
        ],
      },
    ],
  });
  seededWorldIds.push(worldId);
  return ids;
}

function startCraftCommand(ids: ItemConditionCase, overrides: Record<string, unknown> = {}) {
  return {
    id: `cmd-craft-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `craft-key-${ids.branchId}`,
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-19T20:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "start_activity",
    schemaVersion: 1,
    payload: { actionDefinitionId: ids.craftActionId, actorId: ids.actorId },
    ...overrides,
  };
}

async function itemConditionMeterRow(branchId: string, itemId: string, meterKey: string) {
  const [row] = await db()
    .select()
    .from(simItemConditionMeters)
    .where(
      and(
        eq(simItemConditionMeters.branchId, branchId),
        eq(simItemConditionMeters.itemId, itemId),
        eq(simItemConditionMeters.meterKey, meterKey),
      ),
    );
  return row;
}

describe.runIf(ready)("E5.3 slice 3 — item condition use-deltas at completion (§26.7)", () => {
  it("lazily initializes and moves wear on a tracked reserved tool; the driftless meter never gets a scheduled rearm", async () => {
    const ids = await seedItemConditionCase({ conditionTracked: true, wearDeltaFixedPoint: 1_500 });
    const start = await submitDurableStartActivity(startCraftCommand(ids));
    expect(start.status).toBe("accepted");

    const outcome = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + CRAFT_SECONDS + 10, {
      workerId: "w-craft-wear",
    });
    expect(outcome.status).toBe("advanced");

    const eventRows = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence));
    const types = eventRows.map((row) => row.type);
    // Full branch stream: [activity_started, trigger_scheduled] from the
    // start command, then the completion's own train — the lazy-init event
    // precedes activity_completed itself within THAT train (§26.7 store note).
    const completionTypes = types.slice(2);
    expect(completionTypes.indexOf("item_condition_initialized")).toBe(0);
    expect(completionTypes.indexOf("activity_completed")).toBe(1);
    expect(completionTypes).toContain("item_condition_source_applied");
    expect(completionTypes).not.toContain("item_condition_threshold_crossed");

    const initRow = eventRows.find((row) => row.type === "item_condition_initialized");
    const initPayload = z
      .object({
        itemId: z.string(),
        registryVersion: z.string(),
        meters: z.array(z.object({ meterKey: z.string(), valueFixedPoint: z.number() })),
      })
      .loose()
      .parse(initRow?.payload);
    expect(initPayload.itemId).toBe(ids.toolId);
    expect(initPayload.meters.map((meter) => meter.meterKey).sort()).toEqual(["cleanliness", "wear"]);

    const meterRow = await itemConditionMeterRow(ids.branchId, ids.toolId, "wear");
    expect(meterRow?.valueFixedPoint).toBe(1_500);
    expect(meterRow?.lastIntegratedAt).toBe(SEED_SECOND + CRAFT_SECONDS);

    // wear's driftLaw is "none" — a discrete delta below threshold can never
    // produce a scheduled rearm (there is no future crossing to solve); this
    // asserts the store does not fabricate one.
    const [trigger] = await db()
      .select()
      .from(simTriggers)
      .where(and(eq(simTriggers.branchId, ids.branchId), eq(simTriggers.kind, "item_condition_threshold_due")));
    expect(trigger).toBeUndefined();
  });

  it("a delta crossing worn_out at completion emits the instant threshold-crossed event, witnessed by the co-located actor", async () => {
    const ids = await seedItemConditionCase({ conditionTracked: true, wearDeltaFixedPoint: 8_500 });
    await submitDurableStartActivity(startCraftCommand(ids));
    const outcome = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + CRAFT_SECONDS + 10, {
      workerId: "w-craft-worn-out",
    });
    expect(outcome.status).toBe("advanced");

    const eventRows = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence));
    const sourceEvent = eventRows.find((row) => row.type === "item_condition_source_applied");
    const crossedEvent = eventRows.find((row) => row.type === "item_condition_threshold_crossed");
    expect(sourceEvent).toBeDefined();
    expect(crossedEvent).toBeDefined();
    expect(crossedEvent?.causationId).toBe(sourceEvent?.id);

    const crossedPayload = z
      .object({
        itemId: z.string(),
        meterKey: z.string(),
        thresholdKey: z.string(),
        direction: z.string(),
        valueFixedPoint: z.number(),
        observerActorIds: z.array(z.string()),
      })
      .loose()
      .parse(crossedEvent?.payload);
    expect(crossedPayload).toMatchObject({
      itemId: ids.toolId,
      meterKey: "wear",
      thresholdKey: "worn_out",
      direction: "rising",
      valueFixedPoint: 8_500,
    });
    // Co-located witness only — mirrors bodies' capture idiom (the acting
    // actor is not separately listed as their own observer here).
    expect(crossedPayload.observerActorIds).toEqual([ids.witnessId]);

    const meterRow = await itemConditionMeterRow(ids.branchId, ids.toolId, "wear");
    expect(meterRow?.valueFixedPoint).toBe(8_500);
  });

  it("an untracked used item receives no condition rows or events", async () => {
    const ids = await seedItemConditionCase({ conditionTracked: false, wearDeltaFixedPoint: 1_500 });
    await submitDurableStartActivity(startCraftCommand(ids));
    const outcome = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + CRAFT_SECONDS + 10, {
      workerId: "w-craft-untracked",
    });
    expect(outcome.status).toBe("advanced");

    const eventRows = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence));
    expect(eventRows.some((row) => row.type.startsWith("item_condition_"))).toBe(false);

    const meterRows = await db()
      .select()
      .from(simItemConditionMeters)
      .where(
        and(eq(simItemConditionMeters.branchId, ids.branchId), eq(simItemConditionMeters.itemId, ids.toolId)),
      );
    expect(meterRows).toHaveLength(0);
  });
});
