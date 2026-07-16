import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  itemTransferProjectionSchema,
  transferItemCommandSchema,
  type ItemTransferProjection,
  type TransferItemCommand,
} from "@/contracts/simulation/item-transfer";
import { newId } from "@/lib/ids";
import {
  db,
  simCommands,
  simConsumerCheckpoints,
  simHoldingContainers,
  simItemTransferFeed,
  simOutbox,
  simWorlds,
} from "@/server/db";
import {
  InjectedSimulationCrash,
  readDurableItemTransferBranch,
  seedDurableItemTransferBranch,
  submitDurableItemTransfer,
  type DurableItemTransferCrashPoint,
} from "./item-transfer-store";
import { consumeNextItemTransferOutbox, rebuildItemTransferFeed } from "./outbox-store";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_worlds limit 1`),
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
      `[item-transfer-store.int.test] skipping: database unreachable or unmigrated: ${
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
  observerId: string;
  sourceId: string;
  destinationId: string;
  itemIds: string[];
}

function makeIds(itemCount = 1, worldId = newId()): CaseIds {
  return {
    worldId,
    branchId: newId(),
    actorId: newId(),
    observerId: newId(),
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
    rulesetVersion: "e2-2-test-v1",
    version: 0,
    headSequence: 0,
    storySecond: 57_600,
    actors: [
      {
        id: ids.actorId,
        name: "Mara",
        observedContainerIds: [ids.sourceId, ids.destinationId].sort(),
      },
      {
        id: ids.observerId,
        name: "Theo",
        observedContainerIds: [ids.sourceId, ids.destinationId].sort(),
      },
    ].sort(compareStableId),
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
  overrides: Partial<{
    id: string;
    idempotencyKey: string;
    expectedVersion: number;
    fromContainerId: string;
    toContainerId: string;
    controlledActorIds: string[];
  }> = {},
): TransferItemCommand {
  return transferItemCommandSchema.parse({
    id: overrides.id ?? newId(),
    branchId: ids.branchId,
    expectedVersion: overrides.expectedVersion ?? 0,
    idempotencyKey: overrides.idempotencyKey ?? newId(),
    principal: {
      kind: "npc_policy",
      principalId: newId(),
      controlledActorIds: overrides.controlledActorIds ?? [ids.actorId],
    },
    submittedAtWallClock: "2026-07-16T16:00:00.000Z",
    type: "transfer_item",
    schemaVersion: 1,
    correlationId: newId(),
    payload: {
      actorId: ids.actorId,
      itemId,
      fromContainerId: overrides.fromContainerId ?? ids.sourceId,
      toContainerId: overrides.toContainerId ?? ids.destinationId,
    },
  });
}

async function seedCase(ids: CaseIds): Promise<void> {
  if (!seededWorldIds.includes(ids.worldId)) seededWorldIds.push(ids.worldId);
  await seedDurableItemTransferBranch(projection(ids), {
    worldTypeId: "e2-2-test-world",
    worldSeed: "0011223344556677",
  });
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

describe("E2.2 durable item-transfer branch transaction", () => {
  it("atomically persists one result, event, branch advance, and typed holding", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);
    const input = command(ids);

    // Both calls may miss the lock-free cache. The recheck under the branch
    // lock must still collapse them to one durable result and one event.
    const [first, concurrentRetry] = await Promise.all([
      submitDurableItemTransfer(input),
      submitDurableItemTransfer(input),
    ]);
    expect(first).toMatchObject({
      status: "accepted",
      branchVersion: 1,
      firstSequence: 1,
      lastSequence: 1,
    });
    expect(concurrentRetry).toEqual(first);

    const state = await readDurableItemTransferBranch(ids.branchId);
    expect(state.projection).toMatchObject({ version: 1, headSequence: 1 });
    expect(state.events).toHaveLength(1);
    expect(state.projection.items[0]?.holdingContainerId).toBe(ids.destinationId);
    expect(state.projection.observations).toHaveLength(2);

    const [stored] = await db()
      .select({ status: simCommands.status, result: simCommands.result })
      .from(simCommands)
      .where(
        and(
          eq(simCommands.branchId, ids.branchId),
          eq(simCommands.idempotencyKey, input.idempotencyKey),
        ),
      );
    expect(stored).toEqual({ status: "accepted", result: first });

    const storedRows = await db()
      .select({ commandId: simCommands.commandId })
      .from(simCommands)
      .where(eq(simCommands.branchId, ids.branchId));
    expect(storedRows).toEqual([{ commandId: input.id }]);

    expect(await submitDurableItemTransfer(input)).toEqual(first);
    expect((await readDurableItemTransferBranch(ids.branchId)).events).toHaveLength(1);
  });

  it("persists deterministic rejection and rejects a reused command id without another event", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);

    const denied = command(ids, ids.itemIds[0], { controlledActorIds: [ids.observerId] });
    const deniedResult = await submitDurableItemTransfer(denied);
    expect(deniedResult).toMatchObject({ status: "rejected", code: "unauthorized_actor" });
    expect(await submitDurableItemTransfer(denied)).toEqual(deniedResult);

    const accepted = command(ids);
    expect(await submitDurableItemTransfer(accepted)).toMatchObject({ status: "accepted" });
    const duplicate = command(ids, ids.itemIds[0], {
      id: accepted.id,
      idempotencyKey: newId(),
      expectedVersion: 1,
      fromContainerId: ids.destinationId,
      toContainerId: ids.sourceId,
    });
    const duplicateResult = await submitDurableItemTransfer(duplicate);
    expect(duplicateResult).toMatchObject({
      status: "rejected",
      code: "duplicate_command_id",
    });
    expect(await submitDurableItemTransfer(duplicate)).toEqual(duplicateResult);
    expect((await readDurableItemTransferBranch(ids.branchId)).events).toHaveLength(1);
  });

  it("serializes concurrent same-version work on the branch row", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds(2);
    await seedCase(ids);

    const outcomes = await Promise.all([
      submitDurableItemTransfer(command(ids, ids.itemIds[0])),
      submitDurableItemTransfer(command(ids, ids.itemIds[1])),
    ]);
    expect(outcomes.map((result) => result.status).sort()).toEqual(["accepted", "conflict"]);

    const state = await readDurableItemTransferBranch(ids.branchId);
    expect(state.projection.version).toBe(1);
    expect(state.events).toHaveLength(1);
    expect(
      state.projection.items.filter((item) => item.holdingContainerId === ids.destinationId),
    ).toHaveLength(1);
    const commandRows = await db()
      .select({ status: simCommands.status })
      .from(simCommands)
      .where(eq(simCommands.branchId, ids.branchId));
    expect(commandRows.map((row) => row.status).sort()).toEqual(["accepted", "conflict"]);
  });

  it("rolls back every pre-commit failpoint without partial history or projection", async (test) => {
    if (!ready) return test.skip();
    const points: Exclude<DurableItemTransferCrashPoint, "after_commit">[] = [
      "after_event_append",
      "after_projection_update",
      "after_outbox_insert",
      "after_branch_advance",
      "after_command_result",
    ];

    for (const point of points) {
      const ids = makeIds();
      await seedCase(ids);
      const input = command(ids);
      await expect(submitDurableItemTransfer(input, { crashAt: point })).rejects.toEqual(
        expect.objectContaining({ name: "InjectedSimulationCrash", point }),
      );

      const state = await readDurableItemTransferBranch(ids.branchId);
      expect(state.events, point).toEqual([]);
      expect(state.projection, point).toMatchObject({ version: 0, headSequence: 0 });
      expect(state.projection.items[0]?.holdingContainerId, point).toBe(ids.sourceId);
      const [stored] = await db()
        .select({ commandId: simCommands.commandId })
        .from(simCommands)
        .where(
          and(
            eq(simCommands.branchId, ids.branchId),
            eq(simCommands.idempotencyKey, input.idempotencyKey),
          ),
        );
      expect(stored, point).toBeUndefined();
    }
  });

  it("recovers a lost post-commit acknowledgement through the idempotency record", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);
    const input = command(ids);

    await expect(
      submitDurableItemTransfer(input, { crashAt: "after_commit" }),
    ).rejects.toBeInstanceOf(InjectedSimulationCrash);

    const committed = await readDurableItemTransferBranch(ids.branchId);
    expect(committed.projection).toMatchObject({ version: 1, headSequence: 1 });
    expect(committed.events).toHaveLength(1);

    const retry = await submitDurableItemTransfer(input);
    expect(retry).toMatchObject({ status: "accepted", branchVersion: 1 });
    expect((await readDurableItemTransferBranch(ids.branchId)).events).toHaveLength(1);
  });

  it("allows the same command id on isolated branches without event-id collision", async (test) => {
    if (!ready) return test.skip();
    const worldId = newId();
    const firstIds = makeIds(1, worldId);
    const secondIds = makeIds(1, worldId);
    await seedCase(firstIds);
    await seedCase(secondIds);
    const commandId = newId();

    const [firstResult, secondResult] = await Promise.all([
      submitDurableItemTransfer(command(firstIds, firstIds.itemIds[0], { id: commandId })),
      submitDurableItemTransfer(command(secondIds, secondIds.itemIds[0], { id: commandId })),
    ]);
    expect(firstResult).toMatchObject({ status: "accepted" });
    expect(secondResult).toMatchObject({ status: "accepted" });

    const [first, second] = await Promise.all([
      readDurableItemTransferBranch(firstIds.branchId),
      readDurableItemTransferBranch(secondIds.branchId),
    ]);
    expect(first.events[0]?.id).not.toBe(second.events[0]?.id);
  });

  it("blocks standalone deletion of a live container while allowing branch teardown", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);

    await expect(
      db()
        .delete(simHoldingContainers)
        .where(
          and(
            eq(simHoldingContainers.branchId, ids.branchId),
            eq(simHoldingContainers.holdingContainerId, ids.sourceId),
          ),
        ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ constraint: "sim_item_holdings_container_fk" }),
    });

    await expect(db().delete(simWorlds).where(eq(simWorlds.id, ids.worldId))).resolves.toBeDefined();
  });
});

describe("E2.3 transactional outbox and rebuildable item-transfer feed", () => {
  it("publishes only accepted events once inside the authority transaction", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);

    const denied = command(ids, ids.itemIds[0], { controlledActorIds: [ids.observerId] });
    expect(await submitDurableItemTransfer(denied)).toMatchObject({ status: "rejected" });
    expect(await db().select().from(simOutbox).where(eq(simOutbox.branchId, ids.branchId))).toEqual([]);

    const accepted = command(ids);
    expect(await submitDurableItemTransfer(accepted)).toMatchObject({ status: "accepted" });
    expect(await submitDurableItemTransfer(accepted)).toMatchObject({ status: "accepted" });
    const rows = await db().select().from(simOutbox).where(eq(simOutbox.branchId, ids.branchId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      consumerKind: "item_transfer_feed",
      firstSequence: 1,
      lastSequence: 1,
      state: "pending",
      attempts: 0,
    });
  });

  it("rolls projection, checkpoint, and completion back before recording a retry", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);
    await submitDurableItemTransfer(command(ids));
    const now = new Date(Date.now() + 60_000);

    const failed = await consumeNextItemTransferOutbox({
      workerId: "worker_crash",
      now,
      crashAt: "after_projection_write",
    });
    expect(failed).toMatchObject({ status: "failed", terminal: false });
    expect(await db().select().from(simItemTransferFeed).where(eq(simItemTransferFeed.branchId, ids.branchId))).toEqual([]);
    expect(await db().select().from(simConsumerCheckpoints).where(eq(simConsumerCheckpoints.branchId, ids.branchId))).toEqual([]);

    const [work] = await db().select().from(simOutbox).where(eq(simOutbox.branchId, ids.branchId));
    if (!work) throw new Error("Expected retryable outbox work");
    expect(work).toMatchObject({ state: "pending", attempts: 1, leaseOwner: null });
    expect(work.lastError).toContain(`outbox=${work.id}`);
    expect(work.lastError).toContain(`branch=${ids.branchId}`);
    expect(work.lastError).toContain("sequence=1");

    expect(
      await consumeNextItemTransferOutbox({
        workerId: "worker_retry",
        now: new Date(now.getTime() + 1_000),
      }),
    ).toMatchObject({ status: "completed", branchId: ids.branchId, throughSequence: 1 });
  });

  it("makes duplicate delivery idempotent and checkpoints monotonically", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);
    await submitDurableItemTransfer(command(ids));
    const now = new Date(Date.now() + 60_000);
    expect(await consumeNextItemTransferOutbox({ workerId: "worker_a", now })).toMatchObject({
      status: "completed",
      throughSequence: 1,
    });

    await db()
      .update(simOutbox)
      .set({ state: "pending", availableAt: now, completedAt: null })
      .where(eq(simOutbox.branchId, ids.branchId));
    expect(await consumeNextItemTransferOutbox({ workerId: "worker_b", now })).toMatchObject({
      status: "completed",
      throughSequence: 1,
    });
    expect(await db().select().from(simItemTransferFeed).where(eq(simItemTransferFeed.branchId, ids.branchId))).toHaveLength(1);
    const [checkpoint] = await db().select().from(simConsumerCheckpoints).where(eq(simConsumerCheckpoints.branchId, ids.branchId));
    expect(checkpoint?.throughSequence).toBe(1);
  });

  it("recovers an expired lease and preserves live-versus-rebuild equality", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);
    await submitDurableItemTransfer(command(ids));
    const now = new Date(Date.now() + 60_000);
    await db()
      .update(simOutbox)
      .set({
        state: "processing",
        attempts: 1,
        leaseOwner: "dead_worker",
        leaseExpiresAt: new Date(now.getTime() - 1_000),
      })
      .where(eq(simOutbox.branchId, ids.branchId));

    expect(await consumeNextItemTransferOutbox({ workerId: "recovery_worker", now })).toMatchObject({
      status: "completed",
      throughSequence: 1,
    });
    const live = await rebuildItemTransferFeed(ids.branchId);
    const repeated = await rebuildItemTransferFeed(ids.branchId);
    expect(live).toEqual(repeated);
    expect(live).toMatchObject({ branchId: ids.branchId, throughSequence: 1, rowCount: 1 });
    expect(live.projectionHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not advance a checkpoint across a missing sequence and can quarantine poison work", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds(2);
    await seedCase(ids);
    await submitDurableItemTransfer(command(ids, ids.itemIds[0]));
    await submitDurableItemTransfer(
      command(ids, ids.itemIds[1], { expectedVersion: 1 }),
    );
    await db()
      .update(simOutbox)
      .set({ state: "completed", completedAt: new Date() })
      .where(and(eq(simOutbox.branchId, ids.branchId), eq(simOutbox.firstSequence, 1)));

    const result = await consumeNextItemTransferOutbox({
      workerId: "gap_worker",
      now: new Date(Date.now() + 60_000),
      maxAttempts: 1,
    });
    expect(result).toMatchObject({ status: "failed", terminal: true, retryAt: null });
    expect(await db().select().from(simConsumerCheckpoints).where(eq(simConsumerCheckpoints.branchId, ids.branchId))).toEqual([]);
    expect(await db().select().from(simItemTransferFeed).where(eq(simItemTransferFeed.branchId, ids.branchId))).toEqual([]);
    const [poison] = await db()
      .select()
      .from(simOutbox)
      .where(and(eq(simOutbox.branchId, ids.branchId), eq(simOutbox.firstSequence, 2)));
    expect(poison).toMatchObject({ state: "failed", attempts: 1 });
    expect(poison?.lastError).toContain("Consumer sequence gap");
  });
});
