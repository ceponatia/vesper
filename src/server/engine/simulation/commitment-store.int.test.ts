import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  itemTransferProjectionSchema,
  type ItemTransferProjection,
} from "@/contracts/simulation/item-transfer";
import { newId } from "@/lib/ids";
import { deriveCommitmentId } from "@/lib/simulation";
import { db, simTriggers, simWorlds } from "@/server/db";
import { forkBranch } from "./branch-store";
import {
  readDurableCommitments,
  submitDurableCreateCommitment,
} from "./commitment-store";
import { seedDurableItemTransferBranch } from "./item-transfer-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { readDurableSpaceBranch, seedDurableSpaceTopology, submitDurableMoveActor } from "./space-store";

const SEED_SECOND = 50_000;
const WALK = 600;
const SHIFT_AT = 52_000;
const NOTICE_LEAD = 500;
const PREPARATION = 100;
// latestDeparture = 52_000 - 600 - 100 = 51_300; noticeAt = 50_800.
const NOTICE_AT = SHIFT_AT - WALK - PREPARATION - NOTICE_LEAD;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_commitments limit 1`),
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
      `[commitment-store.int.test] skipping: database unreachable or unmigrated: ${
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

interface ShiftCase {
  worldId: string;
  branchId: string;
  actorId: string;
  zoneHome: string;
  zoneWork: string;
}

function branchProjection(ids: ShiftCase): ItemTransferProjection {
  return itemTransferProjectionSchema.parse({
    worldId: ids.worldId,
    branchId: ids.branchId,
    rulesetVersion: "e3-3-test-v1",
    version: 0,
    headSequence: 0,
    storySecond: SEED_SECOND,
    actors: [{ id: ids.actorId, name: "Mara", observedContainerIds: [] }],
    containers: [],
    items: [],
    observations: [],
  });
}

async function seedShiftCase(): Promise<ShiftCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: ShiftCase = {
    worldId,
    branchId,
    actorId: newId(),
    zoneHome: `${branchId}-zone-home`,
    zoneWork: `${branchId}-zone-work`,
  };
  const locTown = `${worldId}-loc-town`;
  await seedDurableItemTransferBranch(branchProjection(ids), {
    worldTypeId: "e3-3-tests",
    worldSeed: `seed-${worldId}`,
  });
  await seedDurableSpaceTopology({
    branchId,
    locations: [{ id: locTown, worldId, kind: "town", defaultAccessPolicy: "public" }],
    zones: [
      { id: ids.zoneHome, locationId: locTown, kind: "room", privacyPolicy: "private" },
      { id: ids.zoneWork, locationId: locTown, kind: "shop", privacyPolicy: "public" },
    ],
    links: [
      {
        id: `${branchId}-link-hw`,
        fromZoneId: ids.zoneHome,
        toZoneId: ids.zoneWork,
        modes: ["walk"],
        minimumDurationSeconds: WALK,
        accessPolicy: "public",
        state: "open",
      },
    ],
    loci: [{ kind: "at", actorId: ids.actorId, locationId: locTown, zoneId: ids.zoneHome, since: SEED_SECOND }],
  });
  seededWorldIds.push(worldId);
  return ids;
}

function createCommand(ids: ShiftCase) {
  return {
    id: `cmd-shift-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `shift-key-${ids.branchId}`,
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-17T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "create_commitment",
    schemaVersion: 1,
    payload: {
      actorId: ids.actorId,
      kind: "shift",
      destinationZoneId: ids.zoneWork,
      window: { latestArrival: SHIFT_AT },
      priority: 10,
      flexibility: "firm",
      preparationSeconds: PREPARATION,
      reliabilityBufferSeconds: 0,
      noticeLeadSeconds: NOTICE_LEAD,
      knowledgeSource: { kind: "authored" },
    },
  };
}

function moveCommand(ids: ShiftCase, expectedVersion: number) {
  return {
    id: `cmd-depart-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion,
    idempotencyKey: `depart-key-${ids.branchId}`,
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-17T12:05:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "move_actor",
    schemaVersion: 1,
    payload: { actorId: ids.actorId, destinationZoneId: ids.zoneWork, travelMode: "walk" },
  };
}

describe.runIf(ready)("E3.3 durable commitments and temporal pressure", () => {
  it("creates a shift with captured derivation and both triggers pending", async () => {
    const ids = await seedShiftCase();
    const result = await submitDurableCreateCommitment(createCommand(ids));
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.eventIds).toHaveLength(3);

    const projection = await readDurableCommitments(ids.branchId);
    expect(projection.commitments[0]?.status).toBe("planned");
    expect(projection.pressures).toHaveLength(0);

    const triggers = await db().select().from(simTriggers).where(eq(simTriggers.branchId, ids.branchId));
    const kinds = triggers.map((trigger) => [trigger.kind, trigger.dueStorySecond, trigger.state]);
    expect(kinds).toContainEqual(["commitment_notice_due", NOTICE_AT, "pending"]);
    expect(kinds).toContainEqual(["commitment_deadline_due", SHIFT_AT, "pending"]);
  });

  it("raises pressure at the notice second, once", async () => {
    const ids = await seedShiftCase();
    await submitDurableCreateCommitment(createCommand(ids));
    const outcome = await advanceBranchStoryTime(ids.branchId, NOTICE_AT + 10, { workerId: "w-notice" });
    expect(outcome).toMatchObject({ status: "advanced", drained: 1 });

    const projection = await readDurableCommitments(ids.branchId);
    expect(projection.commitments[0]?.status).toBe("noticed");
    expect(projection.pressures).toHaveLength(1);
    expect(projection.pressures[0]).toMatchObject({ severity: "urgent", noticeAt: NOTICE_AT });
  });

  it("keeps the shift when the actor departs in time (the §15.3 arc)", async () => {
    const ids = await seedShiftCase();
    await submitDurableCreateCommitment(createCommand(ids));
    await advanceBranchStoryTime(ids.branchId, NOTICE_AT, { workerId: "w-kept-notice" });
    // Departure after the pressure: v2 (create, pressure) → move.
    const move = await submitDurableMoveActor(moveCommand(ids, 2));
    expect(move.status).toBe("accepted");

    const outcome = await advanceBranchStoryTime(ids.branchId, SHIFT_AT, { workerId: "w-kept" });
    expect(outcome.status).toBe("advanced");

    const projection = await readDurableCommitments(ids.branchId);
    expect(projection.commitments[0]?.status).toBe("kept");
    expect(projection.pressures[0]?.resolvedAt).toBe(SHIFT_AT);
    const space = await readDurableSpaceBranch(ids.branchId);
    expect(space.loci[0]).toMatchObject({ kind: "at", zoneId: ids.zoneWork });
  });

  it("marks the shift late when the actor is still inbound at the deadline", async () => {
    const ids = await seedShiftCase();
    await submitDurableCreateCommitment(createCommand(ids));
    // Dawdle until 100 seconds before the deadline, then leave: arrival lands
    // at 52_500, after the 52_000 deadline.
    await advanceBranchStoryTime(ids.branchId, SHIFT_AT - 100, { workerId: "w-late-dawdle" });
    const move = await submitDurableMoveActor(moveCommand(ids, 2));
    expect(move.status).toBe("accepted");

    const outcome = await advanceBranchStoryTime(ids.branchId, SHIFT_AT + WALK, { workerId: "w-late" });
    expect(outcome.status).toBe("advanced");

    const projection = await readDurableCommitments(ids.branchId);
    expect(projection.commitments[0]?.status).toBe("late");
    // The deadline evaluated first (due 52_000), then the arrival fired
    // (due 52_500) — the actor still reaches work, late.
    const space = await readDurableSpaceBranch(ids.branchId);
    expect(space.loci[0]).toMatchObject({ kind: "at", zoneId: ids.zoneWork });
    expect(space.journeys[0]?.status).toBe("arrived");
  });

  it("misses the shift when the actor never leaves — and no one is teleported", async () => {
    const ids = await seedShiftCase();
    await submitDurableCreateCommitment(createCommand(ids));
    const outcome = await advanceBranchStoryTime(ids.branchId, SHIFT_AT + 1_000, { workerId: "w-missed" });
    expect(outcome).toMatchObject({ status: "advanced", drained: 2 });

    const projection = await readDurableCommitments(ids.branchId);
    expect(projection.commitments[0]?.status).toBe("missed");
    expect(projection.pressures[0]?.resolvedAt).toBe(SHIFT_AT);
    // Spec §3.1 invariant 5: the schedule boundary changed no location.
    const space = await readDurableSpaceBranch(ids.branchId);
    expect(space.loci[0]).toMatchObject({ kind: "at", zoneId: ids.zoneHome });
  });

  it("forks before the deadline: the child resolves independently of the parent", async () => {
    const ids = await seedShiftCase();
    await submitDurableCreateCommitment(createCommand(ids));
    const childBranchId = newId();
    const fork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: 3,
      principal: { kind: "player", principalId: "principal-1" },
      reason: "pre-deadline retake",
    });
    expect(fork.pendingTriggerIds).toHaveLength(2);

    const childOutcome = await advanceBranchStoryTime(childBranchId, SHIFT_AT + 10, { workerId: "w-child" });
    expect(childOutcome).toMatchObject({ status: "advanced", drained: 2 });
    const child = await readDurableCommitments(childBranchId);
    expect(child.commitments[0]?.status).toBe("missed");

    const parent = await readDurableCommitments(ids.branchId);
    expect(parent.commitments[0]?.status).toBe("planned");
    const parentTriggers = await db()
      .select()
      .from(simTriggers)
      .where(eq(simTriggers.branchId, ids.branchId));
    expect(parentTriggers.every((trigger) => trigger.state === "pending")).toBe(true);
  });

  it("resolves the same commitment id deterministically across identical worlds", async () => {
    const first = await seedShiftCase();
    const second = await seedShiftCase();
    await submitDurableCreateCommitment(createCommand(first));
    await submitDurableCreateCommitment(createCommand(second));
    await advanceBranchStoryTime(first.branchId, SHIFT_AT + 1, { workerId: "w-a" });
    for (const boundary of [NOTICE_AT, SHIFT_AT - 500, SHIFT_AT + 1]) {
      await advanceBranchStoryTime(second.branchId, boundary, { workerId: "w-b" });
    }
    const firstProjection = await readDurableCommitments(first.branchId);
    const secondProjection = await readDurableCommitments(second.branchId);
    // Partition invariance of the material outcome (§12.4).
    expect(firstProjection.commitments[0]?.status).toBe("missed");
    expect(secondProjection.commitments[0]?.status).toBe("missed");
    expect(firstProjection.pressures[0]?.severity).toBe(secondProjection.pressures[0]?.severity);
    expect(firstProjection.commitments[0]?.id).toBe(
      deriveCommitmentId(first.branchId, `cmd-shift-${first.branchId}`),
    );
  });
});
