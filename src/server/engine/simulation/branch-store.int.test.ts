import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  itemTransferProjectionSchema,
  transferItemCommandSchema,
  type ItemTransferProjection,
  type TransferItemCommand,
} from "@/contracts/simulation/item-transfer";
import {
  deriveScheduleCommandId,
  deriveTriggerCommandId,
  deriveTriggerId,
} from "@/contracts/simulation/scheduler";
import { newId } from "@/lib/ids";
import { db, simBranches, simEvents, simSnapshots, simTriggers, simWorlds } from "@/server/db";
import { explainItemPlacement } from "./audit-store";
import { forkBranch, readBranchAncestryEvents, loadBranchAncestry } from "./branch-store";
import {
  readDurableItemTransferBranch,
  seedDurableItemTransferBranch,
  submitDurableItemTransfer,
} from "./item-transfer-store";
import { consumeNextItemTransferOutbox, rebuildItemTransferFeed } from "./outbox-store";
import {
  advanceBranchStoryTime,
  resolveNextDueTrigger,
  scheduleDurableTrigger,
} from "./scheduler-store";
import {
  captureBranchSnapshot,
  discardBranchSnapshots,
  rebuildDurableBranchProjection,
} from "./snapshot-store";

const SEED_STORY_SECOND = 57_600;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      // Selecting from sim_snapshots is itself the from-zero migration check.
      db().execute(sql`select 1 from sim_snapshots limit 1`),
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
      `[branch-store.int.test] skipping: database unreachable or unmigrated: ${
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

interface CaseIds {
  worldId: string;
  branchId: string;
  actorId: string;
  sourceId: string;
  destinationId: string;
  itemIds: string[];
}

function makeIds(itemCount = 1, worldId = newId()): CaseIds {
  return {
    worldId,
    branchId: newId(),
    actorId: newId(),
    sourceId: newId(),
    destinationId: newId(),
    itemIds: Array.from({ length: itemCount }, () => newId()),
  };
}

function compareStableId(left: { id: string }, right: { id: string }): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function projection(ids: CaseIds): ItemTransferProjection {
  return itemTransferProjectionSchema.parse({
    worldId: ids.worldId,
    branchId: ids.branchId,
    rulesetVersion: "e2-5-test-v1",
    version: 0,
    headSequence: 0,
    storySecond: SEED_STORY_SECOND,
    actors: [
      { id: ids.actorId, name: "Mara", observedContainerIds: [ids.sourceId, ids.destinationId].sort() },
    ],
    containers: [
      {
        id: ids.sourceId,
        kind: "container",
        name: "Mara's bag",
        capacity: 8,
        accessibleToActorIds: [ids.actorId],
      },
      {
        id: ids.destinationId,
        kind: "location",
        name: "the cafe table",
        capacity: 8,
        accessibleToActorIds: [ids.actorId],
      },
    ].sort(compareStableId),
    items: ids.itemIds
      .map((id, index) => ({
        id,
        name: index === 0 ? "gold ring" : `test item ${index + 1}`,
        holdingContainerId: ids.sourceId,
      }))
      .sort(compareStableId),
    observations: [],
  });
}

function command(
  ids: CaseIds,
  itemId = ids.itemIds[0]!,
  overrides: Partial<{ branchId: string; expectedVersion: number }> = {},
): TransferItemCommand {
  return transferItemCommandSchema.parse({
    id: newId(),
    branchId: overrides.branchId ?? ids.branchId,
    expectedVersion: overrides.expectedVersion ?? 0,
    idempotencyKey: newId(),
    principal: { kind: "system", principalId: newId(), controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-17T16:00:00.000Z",
    type: "transfer_item",
    schemaVersion: 1,
    correlationId: newId(),
    payload: {
      actorId: ids.actorId,
      itemId,
      fromContainerId: ids.sourceId,
      toContainerId: ids.destinationId,
    },
  });
}

async function seedCase(ids: CaseIds): Promise<void> {
  if (!seededWorldIds.includes(ids.worldId)) seededWorldIds.push(ids.worldId);
  await seedDurableItemTransferBranch(projection(ids), {
    worldTypeId: "e2-5-test-world",
    worldSeed: "8899aabbccddeeff",
  });
}

function scheduleAt(ids: CaseIds, dueStorySecond: number, uniquenessKey: string, itemIndex = 0) {
  return scheduleDurableTrigger({
    worldId: ids.worldId,
    branchId: ids.branchId,
    kind: "scheduled_transfer_item",
    schemaVersion: 1,
    dueStorySecond,
    uniquenessKey,
    payload: { command: command(ids, ids.itemIds[itemIndex]!) },
  });
}

function fork(ids: CaseIds, atSequence: number, childBranchId = newId()) {
  return forkBranch({
    parentBranchId: ids.branchId,
    childBranchId,
    atSequence,
    principal: { kind: "player", principalId: "player_test" },
    reason: "retake",
  });
}

async function branchTriggers(branchId: string) {
  const rows = await db().select().from(simTriggers).where(eq(simTriggers.branchId, branchId));
  return rows.sort((left, right) => left.stableOrder - right.stableOrder);
}

async function itemHolding(branchId: string, itemId: string): Promise<string | undefined> {
  const state = await readDurableItemTransferBranch(branchId);
  return state.projection.items.find((item) => item.id === itemId)?.holdingContainerId;
}

afterEach(async () => {
  if (!ready || seededWorldIds.length === 0) return;
  for (const worldId of seededWorldIds.splice(0)) {
    await db().delete(simWorlds).where(eq(simWorlds.id, worldId));
  }
});

afterAll(async () => {
  await globalThis.__vesperPool?.end();
});

describe.skipIf(!ready)("E2.5 forks, snapshots, and audit", () => {
  it("forks at N re-creating exactly the alarms set at or before N (R1/R2)", async () => {
    const ids = makeIds(3);
    await seedCase(ids);
    // Mara's early alarm is set before the fork point, the late one after —
    // the plan's worked example with sequence standing in for story time.
    await scheduleAt(ids, SEED_STORY_SECOND + 3_600, "alarm-early", 0); // sequence 1
    expect(await submitDurableItemTransfer(command(ids, ids.itemIds[1]!, { expectedVersion: 1 }))).toMatchObject({
      status: "accepted",
      firstSequence: 2,
    });
    await scheduleAt(ids, SEED_STORY_SECOND + 1_800, "alarm-late", 2); // sequence 3

    const childId = newId();
    const result = await fork(ids, 2, childId);
    expect(result).toMatchObject({
      forkSequence: 2,
      forkStorySecond: SEED_STORY_SECOND,
      version: 2,
      inheritedEventCount: 2,
      completedTriggerIds: [],
    });
    expect(result.pendingTriggerIds).toHaveLength(1);

    const childTriggers = await branchTriggers(childId);
    expect(childTriggers.map((row) => [row.uniquenessKey, row.state])).toEqual([
      ["alarm-early", "pending"],
    ]);

    const [childRow] = await db().select().from(simBranches).where(eq(simBranches.id, childId));
    expect(childRow).toMatchObject({
      parentBranchId: ids.branchId,
      forkSequence: 2,
      headSequence: 2,
      version: 2,
      originStorySecond: SEED_STORY_SECOND,
      parentRulesetVersion: "e2-5-test-v1",
      forkedByPrincipalKind: "player",
      forkReason: "retake",
      inheritedSnapshotChecksum: result.inheritedSnapshotChecksum,
    });
    const [snapshotRow] = await db().select().from(simSnapshots).where(eq(simSnapshots.branchId, childId));
    expect(snapshotRow).toMatchObject({ sequence: 2, checksum: result.inheritedSnapshotChecksum });

    // The surviving alarm fires on the child once its clock reaches 4pm.
    const advanced = await advanceBranchStoryTime(childId, SEED_STORY_SECOND + 3_600, {
      workerId: "worker_child",
    });
    expect(advanced).toMatchObject({ status: "advanced", drained: 1 });
    expect(await itemHolding(childId, ids.itemIds[0]!)).toBe(ids.destinationId);
    // The discarded future's alarm never existed on the child.
    expect(await itemHolding(childId, ids.itemIds[2]!)).toBe(ids.sourceId);

    // The parent still owns its own future: the late alarm stays scheduled.
    const parentTriggers = await branchTriggers(ids.branchId);
    expect(parentTriggers.map((row) => [row.uniquenessKey, row.state])).toEqual([
      ["alarm-early", "pending"],
      ["alarm-late", "pending"],
    ]);
  });

  it("records an already-fired alarm as completed instead of re-arming it", async () => {
    const ids = makeIds();
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND, "alarm-now"); // sequence 1
    expect((await resolveNextDueTrigger(ids.branchId, { workerId: "worker_a" })).status).toBe("completed"); // sequence 2

    const childId = newId();
    const result = await fork(ids, 2, childId);
    expect(result.pendingTriggerIds).toEqual([]);
    expect(result.completedTriggerIds).toHaveLength(1);

    const [childTrigger] = await branchTriggers(childId);
    expect(childTrigger).toMatchObject({
      uniquenessKey: "alarm-now",
      state: "completed",
      resultCommandId: deriveTriggerCommandId(deriveTriggerId(ids.branchId, "alarm-now")),
    });

    // Replay is not a reroll: the child inherits the transfer, and nothing
    // fires again.
    expect(await itemHolding(childId, ids.itemIds[0]!)).toBe(ids.destinationId);
    expect((await resolveNextDueTrigger(childId, { workerId: "worker_b" })).status).toBe("idle");
    expect((await readDurableItemTransferBranch(childId)).events).toHaveLength(1);
  });

  it("does not mutate the parent branch, its events, or its triggers", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 600, "alarm-kept");
    await submitDurableItemTransfer(command(ids, ids.itemIds[1]!, { expectedVersion: 1 }));

    const before = {
      branch: await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId)),
      events: await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId)),
      triggers: await branchTriggers(ids.branchId),
    };
    await fork(ids, 1);
    const after = {
      branch: await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId)),
      events: await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId)),
      triggers: await branchTriggers(ids.branchId),
    };
    expect(after).toEqual(before);
  });

  it("keeps siblings and the parent causally isolated after the fork", async () => {
    const ids = makeIds(3);
    await seedCase(ids);
    await submitDurableItemTransfer(command(ids, ids.itemIds[0]!)); // sequence 1

    const childA = newId();
    const childB = newId();
    await fork(ids, 1, childA);
    await fork(ids, 1, childB);

    // Each timeline resolves its own future at its own sequence 2.
    expect(
      await submitDurableItemTransfer(command(ids, ids.itemIds[1]!, { branchId: childA, expectedVersion: 1 })),
    ).toMatchObject({ status: "accepted", firstSequence: 2 });
    expect(
      await submitDurableItemTransfer(command(ids, ids.itemIds[2]!, { branchId: childB, expectedVersion: 1 })),
    ).toMatchObject({ status: "accepted", firstSequence: 2 });
    expect(
      await submitDurableItemTransfer(command(ids, ids.itemIds[1]!, { expectedVersion: 1 })),
    ).toMatchObject({ status: "accepted", firstSequence: 2 });

    // The parent sees only its own history.
    const parentState = await readDurableItemTransferBranch(ids.branchId);
    expect(parentState.events.map((event) => event.branchId)).toEqual([ids.branchId, ids.branchId]);

    // Child A inherits the pre-fork event and its own — never the parent's
    // post-fork same-sequence event, never a sibling's.
    const childAState = await readDurableItemTransferBranch(childA);
    expect(childAState.events.map((event) => [event.sequence, event.branchId])).toEqual([
      [1, ids.branchId],
      [2, childA],
    ]);
    expect(childAState.projection.items.find((item) => item.id === ids.itemIds[2]!)?.holdingContainerId).toBe(
      ids.sourceId,
    );

    const childBAncestry = await loadBranchAncestry(db(), childB);
    const childBEvents = await readBranchAncestryEvents(db(), childBAncestry);
    expect(childBEvents.map((event) => [event.sequence, event.branchId])).toEqual([
      [1, ids.branchId],
      [2, childB],
    ]);
  });

  it("rebuilds from zero to the live projection hash on roots, children, and grandchildren", async () => {
    const ids = makeIds(3);
    await seedCase(ids);
    await submitDurableItemTransfer(command(ids, ids.itemIds[0]!)); // sequence 1
    await scheduleAt(ids, SEED_STORY_SECOND + 60, "alarm-chain", 1); // sequence 2

    const childId = newId();
    await fork(ids, 2, childId);
    await advanceBranchStoryTime(childId, SEED_STORY_SECOND + 60, { workerId: "worker_child" }); // child sequence 3

    const grandchildId = newId();
    await forkBranch({
      parentBranchId: childId,
      childBranchId: grandchildId,
      atSequence: 3,
      principal: { kind: "player", principalId: "player_test" },
      reason: "reach-back",
    });
    await submitDurableItemTransfer(
      command(ids, ids.itemIds[2]!, { branchId: grandchildId, expectedVersion: 3 }),
    );

    for (const branchId of [ids.branchId, childId, grandchildId]) {
      const rebuild = await rebuildDurableBranchProjection(branchId);
      expect(rebuild, branchId).toMatchObject({ source: "zero", matches: true });
      expect(rebuild.rebuiltHash).toBe(rebuild.liveHash);
    }

    const grandchildState = await readDurableItemTransferBranch(grandchildId);
    expect(grandchildState.events.map((event) => event.sequence)).toEqual([1, 3, 4]);
    expect(grandchildState.projection.items.map((item) => item.holdingContainerId)).toEqual([
      ids.destinationId,
      ids.destinationId,
      ids.destinationId,
    ]);
  });

  it("rebuilds from a snapshot to the same truth as from zero, and discards change nothing", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await submitDurableItemTransfer(command(ids, ids.itemIds[0]!));

    const childId = newId();
    await fork(ids, 1, childId);
    await submitDurableItemTransfer(command(ids, ids.itemIds[1]!, { branchId: childId, expectedVersion: 1 }));

    const captured = await captureBranchSnapshot(childId);
    expect(captured).toMatchObject({ branchId: childId, sequence: 2 });

    const fromSnapshot = await rebuildDurableBranchProjection(childId, { source: "snapshot" });
    const fromZero = await rebuildDurableBranchProjection(childId);
    expect(fromSnapshot).toMatchObject({ source: "snapshot", snapshotSequence: 2, matches: true });
    expect(fromZero.matches).toBe(true);
    expect(fromSnapshot.rebuiltHash).toBe(fromZero.rebuiltHash);
    // The snapshot replayed a shorter range than the zero rebuild.
    expect(fromSnapshot.replayedEventCount).toBeLessThan(fromZero.replayedEventCount);

    const truthBefore = await readDurableItemTransferBranch(childId);
    const discarded = await discardBranchSnapshots(childId);
    expect(discarded).toBeGreaterThanOrEqual(2); // fork snapshot + captured
    expect(await readDurableItemTransferBranch(childId)).toEqual(truthBefore);
    expect((await rebuildDurableBranchProjection(childId)).matches).toBe(true);
    await expect(rebuildDurableBranchProjection(childId, { source: "snapshot" })).rejects.toThrow(
      /No snapshot/u,
    );
  });

  it("explains an item placement back through its trigger and scheduling command", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND, "alarm-explain"); // sequence 1
    expect((await resolveNextDueTrigger(ids.branchId, { workerId: "worker_a" })).status).toBe("completed"); // sequence 2

    const triggerId = deriveTriggerId(ids.branchId, "alarm-explain");
    const explained = await explainItemPlacement(ids.branchId, ids.itemIds[0]!);
    expect(explained).toMatchObject({
      origin: "event",
      holdingContainerId: ids.destinationId,
      event: { sequence: 2, branchId: ids.branchId, type: "item_transferred" },
      command: { id: deriveTriggerCommandId(triggerId), branchId: ids.branchId, type: "transfer_item" },
      trigger: { id: triggerId, uniquenessKey: "alarm-explain" },
      schedulingEvent: { sequence: 1, type: "trigger_scheduled" },
      schedulingCommand: { id: deriveScheduleCommandId(triggerId), type: "schedule_transfer_item" },
    });

    // A fork child explains the same inherited fact by pointing at ancestor records.
    const childId = newId();
    await fork(ids, 2, childId);
    const childExplained = await explainItemPlacement(childId, ids.itemIds[0]!);
    expect(childExplained).toMatchObject({
      branchId: childId,
      event: { sequence: 2, branchId: ids.branchId },
      trigger: { id: triggerId, branchId: ids.branchId },
      schedulingEvent: { sequence: 1, branchId: ids.branchId },
    });

    // An item no event ever moved is seed truth (plan R3).
    expect(await explainItemPlacement(ids.branchId, ids.itemIds[1]!)).toMatchObject({
      origin: "seed",
      holdingContainerId: ids.sourceId,
    });
  });

  it("resolves replayed triggers identically to the live run", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 100, "at-100", 0); // sequence 1
    await scheduleAt(ids, SEED_STORY_SECOND + 200, "at-200", 1); // sequence 2

    const childId = newId();
    await fork(ids, 2, childId);

    const material = async (branchId: string) => {
      const state = await readDurableItemTransferBranch(branchId);
      return state.events.map((event) => [event.storySecond, event.payload.itemId]);
    };
    await advanceBranchStoryTime(ids.branchId, SEED_STORY_SECOND + 300, { workerId: "worker_p" });
    await advanceBranchStoryTime(childId, SEED_STORY_SECOND + 300, { workerId: "worker_c" });

    const parentOutcome = await material(ids.branchId);
    const childOutcome = await material(childId);
    expect(parentOutcome).toHaveLength(2);
    expect(childOutcome).toEqual(parentOutcome);
    expect((await rebuildDurableBranchProjection(childId)).matches).toBe(true);
  });

  it("starts the fork child's outbox lane after the fork point", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await submitDurableItemTransfer(command(ids, ids.itemIds[0]!)); // sequence 1
    const now = new Date(Date.now() + 60_000);
    expect(await consumeNextItemTransferOutbox({ workerId: "worker_p", now })).toMatchObject({
      status: "completed",
    });

    const childId = newId();
    await fork(ids, 1, childId);
    // The child's own first event sits above its fork boundary; without the
    // fork-time checkpoint this delivery would fail as a sequence gap forever.
    await submitDurableItemTransfer(command(ids, ids.itemIds[1]!, { branchId: childId, expectedVersion: 1 }));
    expect(await consumeNextItemTransferOutbox({ workerId: "worker_c", now })).toMatchObject({
      status: "completed",
      branchId: childId,
      throughSequence: 2,
    });

    const rebuilt = await rebuildItemTransferFeed(childId);
    expect(rebuilt).toMatchObject({ branchId: childId, rowCount: 1, throughSequence: 2 });

    // A child with no own transfers rebuilds to its fork baseline.
    const quietChild = newId();
    await fork(ids, 1, quietChild);
    expect(await rebuildItemTransferFeed(quietChild)).toMatchObject({
      branchId: quietChild,
      rowCount: 0,
      throughSequence: 1,
    });
  });

  it("delivers feed obligations across non-transfer sequences", async () => {
    // Codex review P1 on PR #15: a trigger_scheduled event advances the
    // branch sequence without creating feed work, so a density-based gap
    // check would retry the very first fired transfer as a "gap" forever.
    const ids = makeIds(2);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND, "alarm-feed"); // sequence 1, no obligation
    expect((await resolveNextDueTrigger(ids.branchId, { workerId: "worker_a" })).status).toBe("completed"); // sequence 2

    const now = new Date(Date.now() + 60_000);
    expect(await consumeNextItemTransferOutbox({ workerId: "worker_feed", now })).toMatchObject({
      status: "completed",
      branchId: ids.branchId,
      throughSequence: 2,
    });

    // Later obligations keep flowing through a stream that mixes families —
    // a rejected trigger (sequence 4's schedule dispatches onto an item that
    // already moved) adds no event and blocks nothing.
    expect(
      await submitDurableItemTransfer(command(ids, ids.itemIds[1]!, { expectedVersion: 2 })),
    ).toMatchObject({ status: "accepted", firstSequence: 3 });
    await scheduleAt(ids, SEED_STORY_SECOND, "alarm-feed-2", 1);
    expect((await resolveNextDueTrigger(ids.branchId, { workerId: "worker_a" })).status).toBe("rejected");
    expect(await consumeNextItemTransferOutbox({ workerId: "worker_feed", now })).toMatchObject({
      status: "completed",
      throughSequence: 3,
    });
  });

  it("validates fork boundaries and identities", async () => {
    const ids = makeIds();
    await seedCase(ids);
    await submitDurableItemTransfer(command(ids));

    await expect(fork(ids, 99)).rejects.toThrow(/head sequence/u);
    await expect(fork(ids, 1, ids.branchId)).rejects.toThrow(/fork onto itself/u);
    await expect(
      forkBranch({
        parentBranchId: newId(),
        childBranchId: newId(),
        atSequence: 0,
        principal: { kind: "player", principalId: "player_test" },
        reason: "retake",
      }),
    ).rejects.toThrow(/unavailable branch/u);

    // Forking at zero yields the world at creation, playable forward.
    const originChild = newId();
    const originFork = await fork(ids, 0, originChild);
    expect(originFork).toMatchObject({
      forkSequence: 0,
      forkStorySecond: SEED_STORY_SECOND,
      version: 0,
      inheritedEventCount: 0,
    });
    expect(await itemHolding(originChild, ids.itemIds[0]!)).toBe(ids.sourceId);
    expect(
      await submitDurableItemTransfer(command(ids, ids.itemIds[0]!, { branchId: originChild })),
    ).toMatchObject({ status: "accepted", firstSequence: 1 });
  });
});
