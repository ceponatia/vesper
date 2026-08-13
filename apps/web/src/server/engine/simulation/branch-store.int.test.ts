import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isMaterialEvent } from "@vesper/simulation-core/contracts/branching";
import { itemConditionRegistryV1 } from "@vesper/simulation-core/contracts/material-condition";
import {
  transferItemCommandSchema,
  type TransferItemCommand,
} from "@vesper/simulation-core/contracts/materials";
import {
  deriveScheduleCommandId,
  deriveTriggerCommandId,
  deriveTriggerId,
} from "@vesper/simulation-core/contracts/scheduler";
import { newId } from "@/lib/ids";
import {
  db,
  simBranches,
  simEvents,
  simItemConditionMeters,
  simItemConditionModifiers,
  simSnapshots,
  simTriggers,
} from "@/server/db";
import { explainItemPlacement } from "./audit-store";
import {
  forkBranch,
  readBranchAncestryEvents,
  readDurableBranchState,
  loadBranchAncestry,
} from "./branch-store";
import { submitDurableTransferItem } from "./material-store";
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
import {
  expectAccepted,
  LEGACY_ENGINE_TEST_PLAYER_ID,
  playerPrincipal,
  seedSimBranch,
  simulationSuiteHarness,
} from "@/server/test-support";

/**
 * E2.5 forks, snapshots and audit, plus E5.3 slice 3's item-condition
 * fork/replay parity. Runs on the shared `simulationSuiteHarness` scaffold
 * (probe + legacy-player guard + pool close) with per-test world teardown —
 * every case seeds its own world and none of them read another's rows.
 */

const harness = await simulationSuiteHarness({
  suite: "branch-store.int.test",
  // Selecting from sim_snapshots is itself the from-zero migration check.
  table: "sim_snapshots",
  cleanup: "afterEach",
});

const SEED_STORY_SECOND = 57_600;

interface CaseIds {
  worldId: string;
  branchId: string;
  actorId: string;
  locationId: string;
  zoneId: string;
  sourceId: string;
  destinationId: string;
  itemIds: string[];
}

function makeIds(itemCount = 1, worldId = newId()): CaseIds {
  const branchId = newId();
  return {
    worldId,
    branchId,
    actorId: newId(),
    locationId: `${worldId}-loc-cafe`,
    zoneId: `${branchId}-zone-hall`,
    sourceId: newId(),
    destinationId: newId(),
    itemIds: Array.from({ length: itemCount }, () => newId()),
  };
}

/**
 * Kept as a hand-built, schema-PARSED command: it is embedded verbatim in a
 * scheduled trigger's payload (`scheduleAt`), so it must be a real
 * `TransferItemCommand`, and its identities are freshly minted per call because
 * several cases submit the same item twice on one branch.
 */
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
    schemaVersion: 2,
    correlationId: newId(),
    payload: {
      actorId: ids.actorId,
      itemId,
      fromLocus: { kind: "container", containerItemId: ids.sourceId },
      toLocus: { kind: "container", containerItemId: ids.destinationId },
    },
  });
}

async function seedCase(ids: CaseIds): Promise<void> {
  harness.trackWorld(ids.worldId);
  await seedSimBranch({
    worldId: ids.worldId,
    branchId: ids.branchId,
    worldTypeId: "e2-5-test-world",
    worldSeed: "8899aabbccddeeff",
    rulesetVersion: "e2-5-test-v1",
    originStorySecond: SEED_STORY_SECOND,
    actors: [{ id: ids.actorId, name: "Mara" }],
    items: [
      {
        id: ids.sourceId,
        name: "Mara's bag",
        container: { capacityCount: 8, access: { kind: "holder_only" } },
        locus: { kind: "held", actorId: ids.actorId },
      },
      {
        id: ids.destinationId,
        name: "the cafe table",
        container: { capacityCount: 8, access: { kind: "holder_only" } },
        locus: { kind: "held", actorId: ids.actorId },
      },
      ...ids.itemIds.map((id, index) => ({
        id,
        name: index === 0 ? "gold ring" : `test item ${index + 1}`,
        locus: { kind: "container" as const, containerItemId: ids.sourceId },
      })),
    ],
    locations: [{ id: ids.locationId, worldId: ids.worldId, kind: "cafe", defaultAccessPolicy: "public" }],
    zones: [{ id: ids.zoneId, locationId: ids.locationId, kind: "hall", privacyPolicy: "public" }],
    links: [],
    placements: [{ actorId: ids.actorId, locationId: ids.locationId, zoneId: ids.zoneId }],
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

/**
 * Forks at an EXPLICIT sequence — the whole point of this suite, including the
 * out-of-bounds and self-fork failure cases. `forkAtHead` (test-support) reads
 * the parent's head and cannot express any of that.
 */
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

async function itemLocus(branchId: string, itemId: string) {
  const state = await readDurableBranchState(branchId);
  return state.projection.items.find((item) => item.id === itemId)?.locus;
}

function containerLocus(containerItemId: string) {
  return { kind: "container" as const, containerItemId };
}

describe.runIf(harness.ready)("E2.5 forks, snapshots, and audit", () => {
  it("forks at N re-creating exactly the alarms set at or before N (R1/R2)", async () => {
    const ids = makeIds(3);
    await seedCase(ids);
    // Mara's early alarm is set before the fork point, the late one after —
    // the plan's worked example with sequence standing in for story time.
    await scheduleAt(ids, SEED_STORY_SECOND + 3_600, "alarm-early", 0); // sequence 1
    expect(await submitDurableTransferItem(command(ids, ids.itemIds[1]!, { expectedVersion: 1 }))).toMatchObject({
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
    expect(await itemLocus(childId, ids.itemIds[0]!)).toEqual(containerLocus(ids.destinationId));
    // The discarded future's alarm never existed on the child.
    expect(await itemLocus(childId, ids.itemIds[2]!)).toEqual(containerLocus(ids.sourceId));

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
    expect(await itemLocus(childId, ids.itemIds[0]!)).toEqual(containerLocus(ids.destinationId));
    expect((await resolveNextDueTrigger(childId, { workerId: "worker_b" })).status).toBe("idle");
    expect((await readDurableBranchState(childId)).events.filter(isMaterialEvent)).toHaveLength(1);
  });

  it("does not mutate the parent branch, its events, or its triggers", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 600, "alarm-kept");
    await submitDurableTransferItem(command(ids, ids.itemIds[1]!, { expectedVersion: 1 }));

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
    await submitDurableTransferItem(command(ids, ids.itemIds[0]!)); // sequence 1

    const childA = newId();
    const childB = newId();
    await fork(ids, 1, childA);
    await fork(ids, 1, childB);

    // Each timeline resolves its own future at its own sequence 2.
    expect(
      await submitDurableTransferItem(command(ids, ids.itemIds[1]!, { branchId: childA, expectedVersion: 1 })),
    ).toMatchObject({ status: "accepted", firstSequence: 2 });
    expect(
      await submitDurableTransferItem(command(ids, ids.itemIds[2]!, { branchId: childB, expectedVersion: 1 })),
    ).toMatchObject({ status: "accepted", firstSequence: 2 });
    expect(
      await submitDurableTransferItem(command(ids, ids.itemIds[1]!, { expectedVersion: 1 })),
    ).toMatchObject({ status: "accepted", firstSequence: 2 });

    // The parent sees only its own history.
    const parentState = await readDurableBranchState(ids.branchId);
    expect(parentState.events.map((event) => event.branchId)).toEqual([ids.branchId, ids.branchId]);

    // Child A inherits the pre-fork event and its own — never the parent's
    // post-fork same-sequence event, never a sibling's.
    const childAState = await readDurableBranchState(childA);
    expect(childAState.events.map((event) => [event.sequence, event.branchId])).toEqual([
      [1, ids.branchId],
      [2, childA],
    ]);
    expect(childAState.projection.items.find((item) => item.id === ids.itemIds[2]!)?.locus).toEqual(
      containerLocus(ids.sourceId),
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
    await submitDurableTransferItem(command(ids, ids.itemIds[0]!)); // sequence 1
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
    await submitDurableTransferItem(
      command(ids, ids.itemIds[2]!, { branchId: grandchildId, expectedVersion: 3 }),
    );

    for (const branchId of [ids.branchId, childId, grandchildId]) {
      const rebuild = await rebuildDurableBranchProjection(branchId);
      expect(rebuild, branchId).toMatchObject({ source: "zero", matches: true });
      expect(rebuild.rebuiltHash).toBe(rebuild.liveHash);
    }

    const grandchildState = await readDurableBranchState(grandchildId);
    expect(grandchildState.events.filter(isMaterialEvent).map((event) => event.sequence)).toEqual([1, 3, 4]);
    // Only the three tracked items — `projection.items` also carries the two
    // container items (source and destination) themselves under §26.2.
    expect(
      ids.itemIds.map((itemId) => grandchildState.projection.items.find((item) => item.id === itemId)?.locus),
    ).toEqual([containerLocus(ids.destinationId), containerLocus(ids.destinationId), containerLocus(ids.destinationId)]);
  });

  it("rebuilds from a snapshot to the same truth as from zero, and discards change nothing", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await submitDurableTransferItem(command(ids, ids.itemIds[0]!));

    const childId = newId();
    await fork(ids, 1, childId);
    await submitDurableTransferItem(command(ids, ids.itemIds[1]!, { branchId: childId, expectedVersion: 1 }));

    const captured = await captureBranchSnapshot(childId);
    expect(captured).toMatchObject({ branchId: childId, sequence: 2 });

    const fromSnapshot = await rebuildDurableBranchProjection(childId, { source: "snapshot" });
    const fromZero = await rebuildDurableBranchProjection(childId);
    expect(fromSnapshot).toMatchObject({ source: "snapshot", snapshotSequence: 2, matches: true });
    expect(fromZero.matches).toBe(true);
    expect(fromSnapshot.rebuiltHash).toBe(fromZero.rebuiltHash);
    // The snapshot replayed a shorter range than the zero rebuild.
    expect(fromSnapshot.replayedEventCount).toBeLessThan(fromZero.replayedEventCount);

    const truthBefore = await readDurableBranchState(childId);
    const discarded = await discardBranchSnapshots(childId);
    expect(discarded).toBeGreaterThanOrEqual(2); // fork snapshot + captured
    expect(await readDurableBranchState(childId)).toEqual(truthBefore);
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
      locus: containerLocus(ids.destinationId),
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
      locus: containerLocus(ids.sourceId),
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
      const state = await readDurableBranchState(branchId);
      return state.events.filter(isMaterialEvent).map((event) => [event.storySecond, event.payload.itemId]);
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
    await submitDurableTransferItem(command(ids, ids.itemIds[0]!)); // sequence 1
    const now = new Date(Date.now() + 60_000);
    expect(await consumeNextItemTransferOutbox({ workerId: "worker_p", now })).toMatchObject({
      status: "completed",
    });

    const childId = newId();
    await fork(ids, 1, childId);
    // The child's own first event sits above its fork boundary; without the
    // fork-time checkpoint this delivery would fail as a sequence gap forever.
    await submitDurableTransferItem(command(ids, ids.itemIds[1]!, { branchId: childId, expectedVersion: 1 }));
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
      await submitDurableTransferItem(command(ids, ids.itemIds[1]!, { expectedVersion: 2 })),
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
    await submitDurableTransferItem(command(ids));

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
    expect(await itemLocus(originChild, ids.itemIds[0]!)).toEqual(containerLocus(ids.sourceId));
    expect(
      await submitDurableTransferItem(command(ids, ids.itemIds[0]!, { branchId: originChild })),
    ).toMatchObject({ status: "accepted", firstSequence: 1 });
  });
});

describe.runIf(harness.ready)("E5.3 slice 3 — item condition fork/replay parity (§26.7)", () => {
  it("forks mid-worn-window: the child carries the meter + live modifier rows and a re-armed pending alarm, and its own drain fires the crossing independently", async () => {
    const worldId = newId();
    const branchId = newId();
    const actorId = newId();
    const garmentId = newId();
    const locationId = `${worldId}-loc-home`;
    const zoneId = `${branchId}-zone-room`;
    harness.trackWorld(worldId);

    await seedSimBranch({
      worldId,
      branchId,
      worldTypeId: "e5-3-slice3-fork-tests",
      worldSeed: "8899aabbccddeeff",
      rulesetVersion: "e5-3-slice3-fork-test-v1",
      originStorySecond: SEED_STORY_SECOND,
      actors: [{ id: actorId, name: "Mara" }],
      items: [
        {
          id: garmentId,
          name: "Linen shirt",
          conditionTracked: true,
          locus: { kind: "held", actorId },
        },
      ],
      locations: [{ id: locationId, worldId, kind: "home", defaultAccessPolicy: "private" }],
      zones: [{ id: zoneId, locationId, kind: "room", privacyPolicy: "private" }],
      links: [],
      placements: [{ actorId, locationId, zoneId }],
    });

    // Don the garment: the worn-window transition (`buildWornWindowTransition`
    // in lib/simulation/material-condition.ts, wired at transfer time by
    // material-store.ts) lazily initializes the item's condition state, then
    // applies cleanliness's rate_add modifier for the worn window and arms
    // its "grimy" threshold.
    const don = await submitDurableTransferItem(
      transferItemCommandSchema.parse({
        id: newId(),
        branchId,
        expectedVersion: 0,
        idempotencyKey: newId(),
        principal: playerPrincipal(actorId),
        submittedAtWallClock: "2026-07-19T21:00:00.000Z",
        type: "transfer_item",
        schemaVersion: 2,
        correlationId: newId(),
        payload: {
          actorId,
          itemId: garmentId,
          fromLocus: { kind: "held", actorId },
          toLocus: { kind: "worn", actorId, slotKey: "torso" },
        },
      }),
    );
    expectAccepted(don, "don the linen shirt");

    const [modifierRow] = await db()
      .select()
      .from(simItemConditionModifiers)
      .where(
        and(eq(simItemConditionModifiers.branchId, branchId), eq(simItemConditionModifiers.itemId, garmentId)),
      );
    expect(modifierRow).toBeDefined();
    expect(modifierRow?.validUntil).toBeNull();

    const [pendingAlarm] = await db()
      .select()
      .from(simTriggers)
      .where(
        and(
          eq(simTriggers.branchId, branchId),
          eq(simTriggers.kind, "item_condition_threshold_due"),
          eq(simTriggers.state, "pending"),
        ),
      );
    if (!pendingAlarm) throw new Error("expected a pending grimy alarm before forking");

    const childId = newId();
    const forkResult = await forkBranch({
      parentBranchId: branchId,
      childBranchId: childId,
      atSequence: don.lastSequence,
      principal: { kind: "player", principalId: LEGACY_ENGINE_TEST_PLAYER_ID },
      reason: "mid-worn-window retake",
    });
    expect(forkResult.pendingTriggerIds).toHaveLength(1);

    const childMeterRows = await db()
      .select()
      .from(simItemConditionMeters)
      .where(and(eq(simItemConditionMeters.branchId, childId), eq(simItemConditionMeters.itemId, garmentId)));
    // Derived from the registry, so adding a meter to it is a one-file change.
    expect(childMeterRows.map((row) => row.meterKey).sort()).toEqual(
      itemConditionRegistryV1.map((definition) => definition.key).sort(),
    );

    const [childModifierRow] = await db()
      .select()
      .from(simItemConditionModifiers)
      .where(and(eq(simItemConditionModifiers.branchId, childId), eq(simItemConditionModifiers.itemId, garmentId)));
    expect(childModifierRow).toBeDefined();
    expect(childModifierRow?.validUntil).toBeNull();

    const [childAlarm] = await db()
      .select()
      .from(simTriggers)
      .where(
        and(
          eq(simTriggers.branchId, childId),
          eq(simTriggers.kind, "item_condition_threshold_due"),
          eq(simTriggers.state, "pending"),
        ),
      );
    expect(childAlarm).toBeDefined();
    expect(childAlarm?.dueStorySecond).toBe(pendingAlarm.dueStorySecond);

    // The child's own drain fires the grimy crossing independently — fork
    // did not consume or share the alarm with the parent.
    const outcome = await advanceBranchStoryTime(childId, pendingAlarm.dueStorySecond, {
      workerId: "w-child-grimy",
    });
    expect(outcome).toMatchObject({ status: "advanced", drained: 1 });

    const childEvents = await db().select().from(simEvents).where(eq(simEvents.branchId, childId));
    expect(childEvents.some((row) => row.type === "item_condition_threshold_crossed")).toBe(true);

    const [parentAlarmAfter] = await db()
      .select({ state: simTriggers.state })
      .from(simTriggers)
      .where(eq(simTriggers.id, pendingAlarm.id));
    expect(parentAlarmAfter?.state).toBe("pending");
  });
});
