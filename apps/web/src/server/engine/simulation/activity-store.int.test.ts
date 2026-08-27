import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { itemConditionRegistryV1 } from "@vesper/simulation-core/contracts/material-condition";
import type { MaterialBranchSeedInput } from "@vesper/simulation-core/contracts/materials";
import { itemTransferFeedConsumerKind } from "@vesper/simulation-core/contracts/outbox";
import { newId } from "@/lib/ids";
import {
  activityCompletionUniquenessKey,
  deriveActivityId,
  emptyActivitiesSeed,
  replayActivitiesHistory,
} from "@vesper/simulation-core/activities";
import { simulationHash } from "@vesper/simulation-core/hash";
import { bodyThresholdUniquenessKeyPrefix } from "@vesper/simulation-core/bodies";
import {
  db,
  simActivities,
  simBodyMeters,
  simBranches,
  simItemConditionMeters,
  simItemHoldings,
  simOutbox,
  simTriggers,
} from "@/server/db";
import {
  readDurableActivities,
  seedDurableActionDefinitions,
  submitDurableCancelActivity,
  submitDurableResumeActivity,
  submitDurableStartActivity,
} from "./activity-store";
import { submitDurableApplyBodyCondition, submitDurableInitializeActorBody } from "./body-store";
import { forkBranch } from "./branch-store";
import { submitDurableTransferItem } from "./material-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { readDurableSpaceBranch, submitDurableMoveActor } from "./space-store";
import {
  expectAccepted,
  expectRejected,
  gmPrincipal,
  LEGACY_ENGINE_TEST_PLAYER_ID,
  playerPrincipal,
  readBranchEvents,
  readBranchEventTypes,
  seedReferenceRhythms,
  seedSimBranch,
  seedSimpleBranch,
  simCommand,
  simulationSuiteHarness,
} from "@/server/test-support";

/**
 * E3.2 durable activity authority, plus E5.3 slices 2–3 (resource reservation,
 * consumption, and item-condition use-deltas at completion). Runs on the shared
 * `simulationSuiteHarness` scaffold (probe + legacy-player guard + world
 * teardown + pool close).
 */

const harness = await simulationSuiteHarness({ suite: "activity-store.int.test", table: "sim_activities" });

const SEED_SECOND = 20_000;
const NAP_SECONDS = 1_800;
const WALK_AB = 600;

interface ActivityCase {
  worldId: string;
  branchId: string;
  actorId: string;
  witnessId: string;
  zoneA: string;
  zoneB: string;
  napActionId: string;
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
  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: "e3-2-tests",
    rulesetVersion: "e3-2-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.actorId, name: "Mara" },
      { id: ids.witnessId, name: "Iris" },
    ],
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
    placements: [
      { actorId: ids.actorId, locationId: locHome, zoneId: ids.zoneA },
      { actorId: ids.witnessId, locationId: locHome, zoneId: ids.zoneA },
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
  harness.trackWorld(worldId);
  return ids;
}

function startCommand(ids: ActivityCase, options: { name?: string; expectedVersion?: number } = {}) {
  return simCommand({
    branchId: ids.branchId,
    name: options.name ?? "start",
    type: "start_activity",
    expectedVersion: options.expectedVersion ?? 0,
    principal: playerPrincipal(ids.actorId),
    payload: { actionDefinitionId: ids.napActionId, actorId: ids.actorId },
  });
}

function moveCommand(ids: ActivityCase, expectedVersion: number, name = "move") {
  return simCommand({
    branchId: ids.branchId,
    name,
    type: "move_actor",
    expectedVersion,
    principal: playerPrincipal(ids.actorId),
    payload: { actorId: ids.actorId, destinationZoneId: ids.zoneB, travelMode: "walk" },
  });
}

function cancelCommand(ids: ActivityCase, activityId: string, expectedVersion: number) {
  return simCommand({
    branchId: ids.branchId,
    name: "cancel",
    type: "cancel_activity",
    expectedVersion,
    principal: playerPrincipal(ids.actorId),
    payload: { activityInstanceId: activityId, reason: "actor_choice" },
  });
}

describe.runIf(harness.ready)("E3.2 durable activity authority", () => {
  it("starts an activity with claims, witnesses, and a pending completion trigger", async () => {
    const ids = await seedActivityCase();
    const result = await submitDurableStartActivity(startCommand(ids));
    expectAccepted(result, "start the nap");
    expect(result.eventIds).toHaveLength(2);

    const projection = await readDurableActivities(ids.branchId);
    expect(projection.activities).toHaveLength(1);
    expect(projection.activities[0]?.phase).toBe("active");
    expect(projection.activities[0]?.expectedCompleteAt).toBe(SEED_SECOND + NAP_SECONDS);

    const [startedRow] = await readBranchEvents(ids.branchId);
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

    const completed = (await readBranchEvents(ids.branchId)).at(-1);
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
      startCommand(ids, { name: "start2", expectedVersion: 1 }),
    );
    expectRejected(second, "claim_conflict", "a second start claiming the same body");

    // Departure is blocked while the body claim is held.
    const blockedMove = await submitDurableMoveActor(moveCommand(ids, 1, "blocked"));
    expectRejected(blockedMove, "activity_conflict", "departing under a held body claim");

    // After completion the claim releases and the same move succeeds.
    await advanceBranchStoryTime(ids.branchId, SEED_SECOND + NAP_SECONDS, { workerId: "w-claims" });
    const freedMove = await submitDurableMoveActor(moveCommand(ids, 2, "freed"));
    expectAccepted(freedMove, "the move that the released claim now permits");

    // And starting while in transit is refused.
    const whileTraveling = await submitDurableStartActivity(
      startCommand(ids, { name: "start3", expectedVersion: 3 }),
    );
    expectRejected(whileTraveling, "actor_in_transit", "starting an activity while in transit");
  });

  it("cancel releases the claim and retires the completion trigger", async () => {
    const ids = await seedActivityCase();
    await submitDurableStartActivity(startCommand(ids));
    const activityId = deriveActivityId(ids.branchId, `cmd-start-${ids.branchId}`);

    const cancel = await submitDurableCancelActivity(cancelCommand(ids, activityId, 1));
    expectAccepted(cancel, "cancel the nap");

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
    expectAccepted(move, "movement after the cancellation released the claim");
  });

  it("forks mid-activity with claims held and the completion re-armed; cancelled forks stay retired", async () => {
    const ids = await seedActivityCase();
    await submitDurableStartActivity(startCommand(ids));

    const midChild = newId();
    const midFork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId: midChild,
      atSequence: 2,
      principal: { kind: "player", principalId: LEGACY_ENGINE_TEST_PLAYER_ID },
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
    await submitDurableCancelActivity(cancelCommand(ids, activityId, 1));
    const cancelChild = newId();
    const cancelFork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId: cancelChild,
      atSequence: 3,
      principal: { kind: "player", principalId: LEGACY_ENGINE_TEST_PLAYER_ID },
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
    const events = await readBranchEvents(ids.branchId);
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
// E5.3 slice 2 — resource-cost reservation at start and
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

async function seedConsumptionCase(options: { includeMeal?: boolean } = {}): Promise<ConsumptionCase> {
  const actorId = newId();
  const witnessId = newId();
  const branchId = newId();
  const mealItemId = `${branchId}-item-meal`;
  const items: MaterialBranchSeedInput["items"] =
    (options.includeMeal ?? true)
      ? [
          {
            id: mealItemId,
            name: "Rice bowl",
            materialKindKey: "meal",
            consumptionEffects: [
              {
                meterKey: "energy",
                sourceKind: "meal",
                operation: { kind: "add", deltaFixedPoint: MEAL_ENERGY_DELTA },
              },
            ],
            locus: { kind: "held", actorId },
          },
        ]
      : [];
  const seeded = await seedSimpleBranch({
    prefix: "e5-3-slice2-test",
    branchId,
    actors: [
      { id: actorId, name: "Mara" },
      { id: witnessId, name: "Iris" },
    ],
    originStorySecond: SEED_SECOND,
    items,
    zoneSlug: "a",
    defaultAccessPolicy: "private",
    privacyPolicy: "private",
  });
  const ids: ConsumptionCase = {
    worldId: seeded.worldId,
    branchId: seeded.branchId,
    actorId,
    witnessId,
    zoneA: seeded.zoneId,
    mealItemId,
    eatActionId: `${branchId}-action-eat`,
    eatFeastActionId: `${branchId}-action-eat-feast`,
  };
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
  harness.trackWorld(seeded.worldId);
  return ids;
}

function startEatCommand(
  ids: ConsumptionCase,
  options: { name?: string; expectedVersion?: number; actionDefinitionId?: string } = {},
) {
  return simCommand({
    branchId: ids.branchId,
    name: options.name ?? "eat",
    type: "start_activity",
    expectedVersion: options.expectedVersion ?? 0,
    principal: playerPrincipal(ids.actorId),
    payload: {
      actionDefinitionId: options.actionDefinitionId ?? ids.eatActionId,
      actorId: ids.actorId,
    },
  });
}

function transferMealCommand(ids: ConsumptionCase, expectedVersion: number, name: string) {
  return simCommand({
    branchId: ids.branchId,
    name,
    type: "transfer_item",
    expectedVersion,
    principal: playerPrincipal(ids.actorId),
    payload: {
      actorId: ids.actorId,
      itemId: ids.mealItemId,
      fromLocus: { kind: "held", actorId: ids.actorId },
      toLocus: { kind: "zone", zoneId: ids.zoneA },
    },
  });
}

function initializeBodyCommand(ids: ConsumptionCase, expectedVersion: number) {
  return simCommand({
    branchId: ids.branchId,
    name: "init",
    type: "initialize_actor_body",
    expectedVersion,
    principal: gmPrincipal,
    payload: { actorId: ids.actorId, registryVersion: "body-v1", baselineOverrides: {} },
  });
}

async function currentBranchVersion(branchId: string): Promise<number> {
  const [row] = await db().select({ version: simBranches.version }).from(simBranches).where(eq(simBranches.id, branchId)).limit(1);
  if (!row) throw new Error("branch missing for version lookup");
  return row.version;
}

describe.runIf(harness.ready)("E5.3 slice 2 — activity resource reservations and consumption", () => {
  it("reserves the held meal deterministically and persists reservedItemIds", async () => {
    const ids = await seedConsumptionCase();
    const result = await submitDurableStartActivity(startEatCommand(ids));
    expectAccepted(result, "start the meal that reserves the rice bowl");

    const projection = await readDurableActivities(ids.branchId);
    expect(projection.activities[0]?.reservedItemIds).toEqual([ids.mealItemId]);

    const [startedEvent] = await readBranchEvents(ids.branchId, { types: ["activity_started"] });
    const startedPayload = z.object({ reservedItemIds: z.array(z.string()) }).loose().parse(startedEvent?.payload);
    expect(startedPayload.reservedItemIds).toEqual([ids.mealItemId]);
  });

  it("rejects start with material_unavailable when the resource cost cannot be met", async () => {
    const ids = await seedConsumptionCase();
    const result = await submitDurableStartActivity(
      startEatCommand(ids, { name: "feast", actionDefinitionId: ids.eatFeastActionId }),
    );
    expectRejected(result, "material_unavailable", "a feast needing two meals with one in hand");
  });

  it("rejects a transfer of the reserved item while the activity holds it", async () => {
    const ids = await seedConsumptionCase();
    const start = await submitDurableStartActivity(startEatCommand(ids));
    expectAccepted(start, "start the meal before the blocked transfer");

    const transfer = await submitDurableTransferItem(transferMealCommand(ids, 1, "transfer-blocked"));
    expectRejected(transfer, "item_reserved", "transferring the item an active meal reserved");
  });

  it("cancellation releases the reservation — a transfer then succeeds", async () => {
    const ids = await seedConsumptionCase();
    await submitDurableStartActivity(startEatCommand(ids));
    const activityId = deriveActivityId(ids.branchId, `cmd-eat-${ids.branchId}`);

    const cancel = await submitDurableCancelActivity(
      simCommand({
        branchId: ids.branchId,
        name: "cancel",
        type: "cancel_activity",
        expectedVersion: 1,
        principal: playerPrincipal(ids.actorId),
        payload: { activityInstanceId: activityId, reason: "actor_choice" },
      }),
    );
    expectAccepted(cancel, "cancel the meal");

    const transfer = await submitDurableTransferItem(transferMealCommand(ids, 2, "transfer-after-cancel"));
    expectAccepted(transfer, "the transfer the cancellation released");
  });

  it("completes through the drain: consumes the meal, applies the body effect, retires and re-arms the energy alarm, publishes the feed row", async () => {
    const ids = await seedConsumptionCase();
    const init = await submitDurableInitializeActorBody(initializeBodyCommand(ids, 0));
    expectAccepted(init, "initialize the eater's body");

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

    const start = await submitDurableStartActivity(startEatCommand(ids, { expectedVersion: 1 }));
    expectAccepted(start, "start the meal that will complete through the drain");
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

    const events = await readBranchEvents(ids.branchId);
    const consumedEvent = events.find((event) => event.type === "item_consumed");
    expect(consumedEvent).toBeDefined();
    const sourceEvent = events.find((event) => event.type === "body_source_applied");
    expect(sourceEvent).toBeDefined();
    const sourcePayload = z
      .object({ meterKey: z.string(), valueAfterFixedPoint: z.number() })
      .loose()
      .parse(sourceEvent?.payload);
    expect(sourcePayload.meterKey).toBe("energy");
    // Causation-chained to the item_consumed event, not to the completion.
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
    await seedReferenceRhythms(ids.branchId, ids.actorId);
    await submitDurableInitializeActorBody(initializeBodyCommand(ids, 0));

    // A short nap creates real sleep history — the wake is what arms the
    // collapse alarm this test uses to force a mid-meal interruption
    // (mirrors body-store.int.test.ts's collapse-arc test).
    await submitDurableApplyBodyCondition(
      simCommand({
        branchId: ids.branchId,
        name: "nap",
        type: "apply_body_condition",
        expectedVersion: await currentBranchVersion(ids.branchId),
        principal: playerPrincipal(ids.actorId),
        payload: {
          actorId: ids.actorId,
          conditionKey: "asleep",
          durationSeconds: 5_400,
          modifiers: [],
          observerActorIds: [],
        },
      }),
    );
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

    const start = await submitDurableStartActivity(
      startEatCommand(ids, { expectedVersion: await currentBranchVersion(ids.branchId) }),
    );
    expectAccepted(start, "start the meal the collapse will interrupt");
    const activityId = deriveActivityId(ids.branchId, `cmd-eat-${ids.branchId}`);

    // The collapse fires mid-meal. Reservations are phase-derived like claims —
    // held across every claim-holding phase including interrupted.
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
    expectRejected(blockedTransfer, "item_reserved", "transferring the item an interrupted meal still reserves");

    // Sleep runs its course; resume picks the meal back up with the same
    // reservation, then finishes it normally.
    const wake2 = collapseAlarm.dueStorySecond + 28_800;
    await advanceBranchStoryTime(ids.branchId, wake2, { workerId: "w-eat-wake2" });

    const resume = await submitDurableResumeActivity(
      simCommand({
        branchId: ids.branchId,
        name: "resume",
        type: "resume_activity",
        expectedVersion: await currentBranchVersion(ids.branchId),
        principal: playerPrincipal(ids.actorId),
        payload: { activityInstanceId: activityId },
      }),
    );
    expectAccepted(resume, "resume the interrupted meal");

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
// E5.3 slice 3 — use-disposition item-condition deltas at completion.
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

async function seedItemConditionCase(options: {
  conditionTracked: boolean;
  wearDeltaFixedPoint: number;
}): Promise<ItemConditionCase> {
  const actorId = newId();
  const witnessId = newId();
  const branchId = newId();
  const toolId = `${branchId}-item-tool`;
  const seeded = await seedSimpleBranch({
    prefix: "e5-3-slice3-test",
    branchId,
    actors: [
      { id: actorId, name: "Mara" },
      { id: witnessId, name: "Iris" },
    ],
    originStorySecond: SEED_SECOND,
    items: [
      {
        id: toolId,
        name: "Whittling knife",
        materialKindKey: "tool",
        conditionTracked: options.conditionTracked,
        locus: { kind: "held", actorId },
      },
    ],
    zoneSlug: "a",
    defaultAccessPolicy: "private",
    privacyPolicy: "private",
  });
  const ids: ItemConditionCase = {
    worldId: seeded.worldId,
    branchId: seeded.branchId,
    actorId,
    witnessId,
    zoneA: seeded.zoneId,
    toolId,
    craftActionId: `${branchId}-action-craft`,
  };
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
  harness.trackWorld(seeded.worldId);
  return ids;
}

function startCraftCommand(ids: ItemConditionCase) {
  return simCommand({
    branchId: ids.branchId,
    name: "craft",
    type: "start_activity",
    principal: playerPrincipal(ids.actorId),
    payload: { actionDefinitionId: ids.craftActionId, actorId: ids.actorId },
  });
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

describe.runIf(harness.ready)("E5.3 slice 3 — item condition use-deltas at completion", () => {
  it("lazily initializes and moves wear on a tracked reserved tool; the driftless meter never gets a scheduled rearm", async () => {
    const ids = await seedItemConditionCase({ conditionTracked: true, wearDeltaFixedPoint: 1_500 });
    const start = await submitDurableStartActivity(startCraftCommand(ids));
    expectAccepted(start, "start the whittling");

    const outcome = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + CRAFT_SECONDS + 10, {
      workerId: "w-craft-wear",
    });
    expect(outcome.status).toBe("advanced");

    const events = await readBranchEvents(ids.branchId);
    const types = events.map((event) => event.type);
    // RELATIVE order, never absolute offsets into the whole branch stream: the
    // completion's lazy-init event lands immediately BEFORE activity_completed,
    // after the start command's own train.
    const startedAt = types.indexOf("activity_started");
    const completedAt = types.indexOf("activity_completed");
    const initializedAt = types.indexOf("item_condition_initialized");
    expect(startedAt).toBeGreaterThanOrEqual(0);
    expect(types.filter((type) => type === "item_condition_initialized")).toHaveLength(1);
    expect(initializedAt).toBe(completedAt - 1);
    expect(startedAt).toBeLessThan(initializedAt);
    expect(types).toContain("item_condition_source_applied");
    expect(types).not.toContain("item_condition_threshold_crossed");

    const initEvent = events.find((event) => event.type === "item_condition_initialized");
    const initPayload = z
      .object({
        itemId: z.string(),
        registryVersion: z.string(),
        meters: z.array(z.object({ meterKey: z.string(), valueFixedPoint: z.number() })),
      })
      .loose()
      .parse(initEvent?.payload);
    expect(initPayload.itemId).toBe(ids.toolId);
    // Derived from the registry, so adding a meter to it is a one-file change.
    expect(initPayload.meters.map((meter) => meter.meterKey).sort()).toEqual(
      itemConditionRegistryV1.map((definition) => definition.key).sort(),
    );

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

    const events = await readBranchEvents(ids.branchId);
    const sourceEvent = events.find((event) => event.type === "item_condition_source_applied");
    const crossedEvent = events.find((event) => event.type === "item_condition_threshold_crossed");
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

    const types = await readBranchEventTypes(ids.branchId);
    expect(types.some((type) => type.startsWith("item_condition_"))).toBe(false);

    const meterRows = await db()
      .select()
      .from(simItemConditionMeters)
      .where(
        and(eq(simItemConditionMeters.branchId, ids.branchId), eq(simItemConditionMeters.itemId, ids.toolId)),
      );
    expect(meterRows).toHaveLength(0);
  });
});
