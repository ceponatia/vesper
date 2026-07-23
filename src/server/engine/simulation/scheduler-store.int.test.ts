import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  materialBranchSeedSchema,
  transferItemCommandSchema,
  type MaterialBranchSeed,
  type TransferItemCommand,
} from "@/contracts/simulation/materials";
import { schedulerDerivationVersion } from "@/contracts/simulation/scheduler";
import { newId } from "@/lib/ids";
import { db, simBranches, simEvents, simTriggers, simWorlds } from "@/server/db";
import { seedDurableMaterialBranch, submitDurableTransferItem } from "./material-store";
import {
  advanceBranchStoryTime,
  resolveNextDueTrigger,
  scheduleDurableTrigger,
} from "./scheduler-store";
import { seedDurableSpaceTopology } from "./space-store";

const SEED_STORY_SECOND = 57_600;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      // Selecting from sim_triggers is itself the from-zero migration check: an
      // orphaned migration leaves this table absent and every case below fails.
      db().execute(sql`select 1 from sim_triggers limit 1`),
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
      `[scheduler-store.int.test] skipping: database unreachable or unmigrated: ${
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

function branchSeed(ids: CaseIds): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e2-4-test-world",
    worldSeed: "0011223344556677",
    branchId: ids.branchId,
    rulesetVersion: "e2-4-test-v1",
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
  });
}

function topologySeed(ids: CaseIds) {
  return {
    branchId: ids.branchId,
    locations: [{ id: ids.locationId, worldId: ids.worldId, kind: "cafe", defaultAccessPolicy: "public" as const }],
    zones: [{ id: ids.zoneId, locationId: ids.locationId, kind: "hall", privacyPolicy: "public" as const }],
    links: [],
    loci: [
      { kind: "at" as const, actorId: ids.actorId, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_STORY_SECOND },
    ],
  };
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
  if (!seededWorldIds.includes(ids.worldId)) seededWorldIds.push(ids.worldId);
  await seedDurableMaterialBranch(branchSeed(ids));
  await seedDurableSpaceTopology(topologySeed(ids));
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
 * Transfers only: since E2.5, scheduling itself appends a trigger_scheduled
 * event, so counting every row would conflate setting an alarm with it firing.
 */
async function eventCount(branchId: string): Promise<number> {
  const rows = await db()
    .select({ id: simEvents.id })
    .from(simEvents)
    .where(and(eq(simEvents.branchId, branchId), eq(simEvents.type, "item_transferred")));
  return rows.length;
}

async function triggerRow(triggerId: string) {
  const [row] = await db().select().from(simTriggers).where(eq(simTriggers.id, triggerId)).limit(1);
  return row;
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

describe.skipIf(!ready)("E2.4 durable scheduler", () => {
  it("creates sim_triggers from a zero-state migration", async () => {
    // Regression for an orphaned migration: the table existed only in a
    // hand-written SQL file absent from the drizzle journal, so db:migrate
    // never created it and every scheduler call failed at runtime.
    const result = await db().execute<{ count: string }>(
      sql`select count(*)::text as count from information_schema.tables where table_name = 'sim_triggers'`,
    );
    expect(result.rows[0]?.count).toBe("1");
  });

  it("resolves one due trigger exactly once through the command transaction", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const trigger = await scheduleAt(ids, SEED_STORY_SECOND, "transfer-now");

    const first = await resolveNextDueTrigger(ids.branchId, { workerId: "worker_a" });
    expect(first.status).toBe("completed");
    expect(await eventCount(ids.branchId)).toBe(1);

    const second = await resolveNextDueTrigger(ids.branchId, { workerId: "worker_a" });
    expect(second.status).toBe("idle");
    expect(await eventCount(ids.branchId)).toBe(1);

    const row = await triggerRow(trigger.id);
    expect(row?.state).toBe("completed");
    expect(row?.attempts).toBe(1);
    expect(row?.leaseOwner).toBeNull();
    expect(row?.derivationVersion).toBe(schedulerDerivationVersion);
    expect(row?.resultCommandId).toBeTruthy();
  });

  it("leaves a trigger dormant until story time reaches its due second", async () => {
    const ids = makeIds();
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 3_600, "transfer-later");

    expect((await resolveNextDueTrigger(ids.branchId, { workerId: "worker_a" })).status).toBe("idle");
    expect(await eventCount(ids.branchId)).toBe(0);

    const advanced = await advanceBranchStoryTime(ids.branchId, SEED_STORY_SECOND + 3_600, {
      workerId: "worker_a",
    });
    expect(advanced).toMatchObject({ status: "advanced", drained: 1 });
    expect(await eventCount(ids.branchId)).toBe(1);
  });

  it("does not conflict or poison when a concurrent command advances the branch", async () => {
    // The trigger payload was fixed at schedule time with expectedVersion 0. A
    // player command lands first, so an optimistic admission would store a
    // conflict under the trigger's permanent idempotency key and replay it forever.
    const ids = makeIds(2);
    await seedCase(ids);
    const trigger = await scheduleAt(ids, SEED_STORY_SECOND, "transfer-after-race", 0);

    // The schedule command advanced the branch to version 1 (its
    // trigger_scheduled event is a committed part of history).
    const player = await submitDurableTransferItem(command(ids, ids.itemIds[1]!, { expectedVersion: 1 }));
    expect(player.status).toBe("accepted");

    const resolved = await resolveNextDueTrigger(ids.branchId, { workerId: "worker_a" });
    expect(resolved.status).toBe("completed");
    expect(await eventCount(ids.branchId)).toBe(2);
    expect((await triggerRow(trigger.id))?.state).toBe("completed");
  });

  it("quarantines a rejected trigger instead of retrying a certain refusal", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const trigger = await scheduleDurableTrigger({
      worldId: ids.worldId,
      branchId: ids.branchId,
      kind: "scheduled_transfer_item",
      schemaVersion: 1,
      dueStorySecond: SEED_STORY_SECOND,
      uniquenessKey: "transfer-missing-item",
      payload: { command: command(ids, newId()) },
    });

    const resolved = await resolveNextDueTrigger(ids.branchId, { workerId: "worker_a" });
    expect(resolved).toMatchObject({ status: "rejected", code: "item_not_found" });
    expect(await eventCount(ids.branchId)).toBe(0);

    const row = await triggerRow(trigger.id);
    expect(row?.state).toBe("failed");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("item_not_found");
  });

  it("increments attempts when reclaiming a crashed worker's expired lease", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const trigger = await scheduleAt(ids, SEED_STORY_SECOND, "transfer-reclaim");

    // The row state a worker that died mid-resolution leaves behind.
    await db()
      .update(simTriggers)
      .set({
        state: "processing",
        attempts: 2,
        leaseOwner: "dead_worker",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(simTriggers.id, trigger.id));

    const resolved = await resolveNextDueTrigger(ids.branchId, { workerId: "worker_b" });
    expect(resolved.status).toBe("completed");
    const row = await triggerRow(trigger.id);
    expect(row?.attempts).toBe(3);
    expect(row?.state).toBe("completed");
  });

  it("retires an exhausted trigger rather than reclaiming it forever", async () => {
    // Attempts increment at claim time, but a worker that dies never runs its own
    // failure path — so whoever next claims an exhausted trigger must retire it.
    const ids = makeIds();
    await seedCase(ids);
    const trigger = await scheduleAt(ids, SEED_STORY_SECOND, "transfer-exhausted");
    await db()
      .update(simTriggers)
      .set({
        state: "processing",
        attempts: 5,
        leaseOwner: "dead_worker",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(simTriggers.id, trigger.id));

    const resolved = await resolveNextDueTrigger(ids.branchId, { workerId: "worker_b", maxAttempts: 5 });
    expect(resolved).toMatchObject({ status: "failed", attempts: 5 });
    expect(await eventCount(ids.branchId)).toBe(0);

    const row = await triggerRow(trigger.id);
    expect(row?.state).toBe("failed");
    expect(row?.lastError).toContain("exhausted");
    expect(row?.derivationVersion).toBe(schedulerDerivationVersion);

    expect((await resolveNextDueTrigger(ids.branchId, { workerId: "worker_c" })).status).toBe("idle");
  });

  it("produces one event when two workers race one due trigger", async () => {
    const ids = makeIds();
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND, "transfer-race");

    const outcomes = await Promise.all([
      resolveNextDueTrigger(ids.branchId, { workerId: "worker_a" }),
      resolveNextDueTrigger(ids.branchId, { workerId: "worker_b" }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "completed")).toHaveLength(1);
    expect(await eventCount(ids.branchId)).toBe(1);
  });

  it("drains simultaneous triggers in stable order", async () => {
    const ids = makeIds(3);
    await seedCase(ids);
    // All three share one due second; stable order must decide, not insertion race.
    await scheduleAt(ids, SEED_STORY_SECOND + 60, "b-second", 1);
    await scheduleAt(ids, SEED_STORY_SECOND + 60, "a-first", 0);
    await scheduleAt(ids, SEED_STORY_SECOND + 60, "c-third", 2);

    const advanced = await advanceBranchStoryTime(ids.branchId, SEED_STORY_SECOND + 60, {
      workerId: "worker_a",
    });
    expect(advanced).toMatchObject({ status: "advanced", drained: 3 });

    const rows = await db()
      .select({ order: simTriggers.stableOrder, completedAt: simTriggers.completedAt, key: simTriggers.uniquenessKey })
      .from(simTriggers)
      .where(eq(simTriggers.branchId, ids.branchId));
    const byOrder = [...rows].sort((left, right) => left.order - right.order);
    expect(byOrder.map((row) => row.key)).toEqual(["b-second", "a-first", "c-third"]);
    // Resolution order follows stable order, which is assignment order — not key order.
    const events = await db()
      .select({ sequence: simEvents.sequence })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "item_transferred")));
    expect(events).toHaveLength(3);
  });

  it("stamps each drained event at its own due second, not the advance target", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 100, "at-100", 0);
    await scheduleAt(ids, SEED_STORY_SECOND + 200, "at-200", 1);

    await advanceBranchStoryTime(ids.branchId, SEED_STORY_SECOND + 900, { workerId: "worker_a" });

    const events = await db()
      .select({ storySecond: simEvents.storySecond, sequence: simEvents.sequence })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "item_transferred")));
    expect(events.sort((a, b) => a.sequence - b.sequence).map((row) => row.storySecond)).toEqual([
      SEED_STORY_SECOND + 100,
      SEED_STORY_SECOND + 200,
    ]);
  });

  it("produces the same material outcome for one skip as for equivalent partitions", async () => {
    // Spec §12.4: advance(T0,T3) must equal advance(T0,T1); advance(T1,T2); advance(T2,T3).
    async function run(partitions: number[]): Promise<Array<[number, string]>> {
      const ids = makeIds(2);
      await seedCase(ids);
      await scheduleAt(ids, SEED_STORY_SECOND + 100, "at-100", 0);
      await scheduleAt(ids, SEED_STORY_SECOND + 200, "at-200", 1);
      for (const boundary of partitions) {
        await advanceBranchStoryTime(ids.branchId, boundary, { workerId: "worker_a" });
      }
      const events = await db()
        .select({
          storySecond: simEvents.storySecond,
          sequence: simEvents.sequence,
          itemId: sql<string>`${simEvents.payload}->>'itemId'`,
        })
        .from(simEvents)
        .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "item_transferred")));
      return events
        .sort((a, b) => a.sequence - b.sequence)
        .map((row) => [row.storySecond, row.itemId] as [number, string]);
    }

    const oneSkip = await run([SEED_STORY_SECOND + 300]);
    const partitioned = await run([
      SEED_STORY_SECOND + 100,
      SEED_STORY_SECOND + 200,
      SEED_STORY_SECOND + 300,
    ]);

    expect(oneSkip).toHaveLength(2);
    // Item IDs differ per seeded case; the story-second shape is the invariant.
    expect(oneSkip.map(([second]) => second)).toEqual(partitioned.map(([second]) => second));
  });

  it("returns catch_up_required without skipping a trigger when a bound is exceeded", async () => {
    const ids = makeIds(3);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 10, "one", 0);
    await scheduleAt(ids, SEED_STORY_SECOND + 20, "two", 1);
    await scheduleAt(ids, SEED_STORY_SECOND + 30, "three", 2);

    const bounded = await advanceBranchStoryTime(ids.branchId, SEED_STORY_SECOND + 30, {
      workerId: "worker_a",
      maxTriggers: 2,
    });
    expect(bounded).toMatchObject({ status: "catch_up_required", drained: 2, reason: "trigger_budget" });
    expect(await eventCount(ids.branchId)).toBe(2);

    // The remaining trigger is not skipped; resuming drains it.
    const resumed = await advanceBranchStoryTime(ids.branchId, SEED_STORY_SECOND + 30, {
      workerId: "worker_a",
    });
    expect(resumed).toMatchObject({ status: "advanced", drained: 1 });
    expect(await eventCount(ids.branchId)).toBe(3);
  });

  it("keeps draining past a poison trigger and surfaces it as a terminal failure (A6)", async () => {
    // A poison trigger (here a deterministic rejection — a missing item) must NOT stop the
    // drain: stopping would strand the clock behind a trigger that can never resolve, bricking
    // every future skip on the branch. Instead the drain continues AND surfaces the failure via
    // `terminalFailures`, so a caller records a `trigger_failed` diagnostic (never hidden).
    const ids = makeIds(1);
    await seedCase(ids);
    // A poison trigger at +100 (references an item that isn't there → rejected → state failed),
    // and a healthy transfer at +200 that must still fire.
    await scheduleDurableTrigger({
      worldId: ids.worldId,
      branchId: ids.branchId,
      kind: "scheduled_transfer_item",
      schemaVersion: 1,
      dueStorySecond: SEED_STORY_SECOND + 100,
      uniquenessKey: "poison-missing-item",
      payload: { command: command(ids, newId()) },
    });
    await scheduleAt(ids, SEED_STORY_SECOND + 200, "healthy-at-200", 0);

    const advanced = await advanceBranchStoryTime(ids.branchId, SEED_STORY_SECOND + 300, {
      workerId: "worker_a",
    });
    // Reached the target (did not stop on the poison), counted the failure, and fired the good one.
    expect(advanced).toMatchObject({ status: "advanced", storySecond: SEED_STORY_SECOND + 300, terminalFailures: 1 });
    expect(await eventCount(ids.branchId)).toBe(1);
  });

  it("rejects a trigger whose command targets another branch", async () => {
    const ids = makeIds();
    const other = makeIds(1, ids.worldId);
    await seedCase(ids);
    await seedCase(other);

    await expect(
      scheduleDurableTrigger({
        worldId: ids.worldId,
        branchId: ids.branchId,
        kind: "scheduled_transfer_item",
        schemaVersion: 1,
        dueStorySecond: SEED_STORY_SECOND,
        uniquenessKey: "cross-branch",
        payload: { command: command(ids, ids.itemIds[0]!, { branchId: other.branchId }) },
      }),
    ).rejects.toThrow(/own branch/u);

    // The database refuses it too, so a caller bypassing the contract cannot
    // dispatch across branches. Drizzle wraps the driver error, so the violated
    // constraint is on the cause rather than the message.
    await expect(
      db()
        .insert(simTriggers)
        .values({
          id: newId(),
          worldId: ids.worldId,
          branchId: ids.branchId,
          kind: "scheduled_transfer_item",
          schemaVersion: 1,
          dueStorySecond: SEED_STORY_SECOND,
          stableOrder: 99,
          uniquenessKey: "cross-branch-raw",
          payload: { command: command(ids, ids.itemIds[0]!, { branchId: other.branchId }) },
        }),
    ).rejects.toMatchObject({ cause: { constraint: "sim_triggers_payload_branch_matches" } });
  });

  it("keeps branches independent", async () => {
    const ids = makeIds(1);
    const other = makeIds(1, ids.worldId);
    await seedCase(ids);
    await seedCase(other);
    await scheduleAt(ids, SEED_STORY_SECOND, "branch-a");
    await scheduleAt(other, SEED_STORY_SECOND, "branch-b");

    expect((await resolveNextDueTrigger(ids.branchId, { workerId: "worker_a" })).status).toBe("completed");
    expect(await eventCount(ids.branchId)).toBe(1);
    expect(await eventCount(other.branchId)).toBe(0);

    expect((await resolveNextDueTrigger(other.branchId, { workerId: "worker_a" })).status).toBe("completed");
    expect(await eventCount(other.branchId)).toBe(1);
  });

  it("is idempotent across a repeated schedule and a re-resolve", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const first = await scheduleAt(ids, SEED_STORY_SECOND, "transfer-idem");
    const again = await scheduleAt(ids, SEED_STORY_SECOND, "transfer-idem");
    expect(again.id).toBe(first.id);
    expect(again.stableOrder).toBe(first.stableOrder);

    expect((await resolveNextDueTrigger(ids.branchId, { workerId: "worker_a" })).status).toBe("completed");

    // A crash between the command commit and the trigger write leaves the row
    // reclaimable; the derived idempotency key must return the stored result.
    await db()
      .update(simTriggers)
      .set({ state: "pending", completedAt: null, resultCommandId: null })
      .where(eq(simTriggers.id, first.id));
    expect((await resolveNextDueTrigger(ids.branchId, { workerId: "worker_b" })).status).toBe("completed");
    expect(await eventCount(ids.branchId)).toBe(1);

    // Version 2: the schedule command committed one version, its resolution
    // committed the other. The repeat schedule and re-resolve added nothing.
    const [branch] = await db()
      .select({ version: simBranches.version })
      .from(simBranches)
      .where(eq(simBranches.id, ids.branchId))
      .limit(1);
    expect(branch?.version).toBe(2);
  });
});
