import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  itemTransferProjectionSchema,
  type ItemTransferProjection,
} from "@/contracts/simulation/item-transfer";
import { simulationBranchEventSchema } from "@/contracts/simulation/branching";
import { newId } from "@/lib/ids";
import {
  deriveEngagementId,
  emptyEngagementsSeed,
  replayEngagementsHistory,
  simulationHash,
} from "@/lib/simulation";
import { db, simEvents, simWorlds } from "@/server/db";
import { seedDurableActionDefinitions, submitDurableStartActivity } from "./activity-store";
import { forkBranch } from "./branch-store";
import {
  readDurableEngagements,
  submitDurableEndEngagement,
  submitDurableOpenEngagement,
} from "./engagement-store";
import { seedDurableItemTransferBranch } from "./item-transfer-store";
import { readDurableSpaceBranch, seedDurableSpaceTopology, submitDurableMoveActor } from "./space-store";

const SEED_SECOND = 60_000;
const WALK = 600;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_engagements limit 1`),
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
      `[engagement-store.int.test] skipping: database unreachable or unmigrated: ${
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

interface SceneCase {
  worldId: string;
  branchId: string;
  mara: string;
  iris: string;
  zoneA: string;
  zoneB: string;
  napActionId: string;
}

function branchProjection(ids: SceneCase): ItemTransferProjection {
  return itemTransferProjectionSchema.parse({
    worldId: ids.worldId,
    branchId: ids.branchId,
    rulesetVersion: "e3-4-test-v1",
    version: 0,
    headSequence: 0,
    storySecond: SEED_SECOND,
    actors: [
      { id: ids.mara, name: "Mara", observedContainerIds: [] },
      { id: ids.iris, name: "Iris", observedContainerIds: [] },
    ],
    containers: [],
    items: [],
    observations: [],
  });
}

async function seedSceneCase(): Promise<SceneCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: SceneCase = {
    worldId,
    branchId,
    mara: newId(),
    iris: newId(),
    zoneA: `${branchId}-zone-a`,
    zoneB: `${branchId}-zone-b`,
    napActionId: `${branchId}-action-nap`,
  };
  const locHome = `${worldId}-loc-home`;
  await seedDurableItemTransferBranch(branchProjection(ids), {
    worldTypeId: "e3-4-tests",
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
        minimumDurationSeconds: WALK,
        accessPolicy: "public",
        state: "open",
      },
    ],
    loci: [
      { kind: "at", actorId: ids.mara, locationId: locHome, zoneId: ids.zoneA, since: SEED_SECOND },
      { kind: "at", actorId: ids.iris, locationId: locHome, zoneId: ids.zoneA, since: SEED_SECOND },
    ],
  });
  await seedDurableActionDefinitions({
    branchId,
    definitions: [
      {
        id: ids.napActionId,
        version: 1,
        controllerKinds: ["player"],
        duration: { kind: "fixed", seconds: 1_800 },
        preconditions: [],
        requiredClaims: [{ kind: "body" }, { kind: "attention", weight: "full" }],
        interruptibility: "pausable",
        noticeability: "obvious",
      },
    ],
  });
  seededWorldIds.push(worldId);
  return ids;
}

function openCommand(ids: SceneCase, overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    id: `cmd-open-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `open-key-${ids.branchId}`,
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.mara] },
    submittedAtWallClock: "2026-07-17T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "open_engagement",
    schemaVersion: 1,
    payload: { participantIds: [ids.mara, ids.iris].sort(), channel: "co_present", ...payload },
    ...overrides,
  };
}

function napCommand(ids: SceneCase, actorId: string, expectedVersion: number, suffix: string) {
  return {
    id: `cmd-nap-${suffix}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion,
    idempotencyKey: `nap-${suffix}-key-${ids.branchId}`,
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: [actorId] },
    submittedAtWallClock: "2026-07-17T12:01:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "start_activity",
    schemaVersion: 1,
    payload: { actionDefinitionId: ids.napActionId, actorId },
  };
}

describe.runIf(ready)("E3.4 durable engagements", () => {
  it("opens one co-present scene and refuses a second for an occupied body", async () => {
    const ids = await seedSceneCase();
    const open = await submitDurableOpenEngagement(openCommand(ids));
    expect(open.status).toBe("accepted");
    const projection = await readDurableEngagements(ids.branchId);
    expect(projection.engagements[0]).toMatchObject({ state: "active", channel: "co_present", zoneId: ids.zoneA });

    const second = await submitDurableOpenEngagement(
      openCommand(ids, {
        id: `cmd-open2-${ids.branchId}`,
        idempotencyKey: `open2-key-${ids.branchId}`,
        expectedVersion: 1,
      }),
    );
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") expect(second.code).toBe("participant_already_engaged");
  });

  it("naps block conversations and conversations block naps", async () => {
    const ids = await seedSceneCase();
    // Iris naps (body + full attention).
    const nap = await submitDurableStartActivity({
      ...napCommand(ids, ids.iris, 0, "iris"),
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.iris] },
    });
    expect(nap.status).toBe("accepted");

    // Even a text thread cannot reach a napping mind (ruling 11 adjacent).
    const text = await submitDurableOpenEngagement(
      openCommand(ids, { expectedVersion: 1 }, { channel: "text" }),
    );
    expect(text.status).toBe("rejected");
    if (text.status === "rejected") expect(text.code).toBe("participant_unavailable");

    // In a second world: an open conversation blocks starting a nap.
    const other = await seedSceneCase();
    await submitDurableOpenEngagement(openCommand(other));
    const napDuring = await submitDurableStartActivity(napCommand(other, other.mara, 1, "mara"));
    expect(napDuring.status).toBe("rejected");
    if (napDuring.status === "rejected") expect(napDuring.code).toBe("claim_conflict");
  });

  it("a departure interrupts the scene atomically with the journey events", async () => {
    const ids = await seedSceneCase();
    await submitDurableOpenEngagement(openCommand(ids));
    const move = await submitDurableMoveActor({
      id: `cmd-move-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: 1,
      idempotencyKey: `move-key-${ids.branchId}`,
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.mara] },
      submittedAtWallClock: "2026-07-17T12:05:00.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "move_actor",
      schemaVersion: 1,
      payload: { actorId: ids.mara, destinationZoneId: ids.zoneB, travelMode: "walk" },
    });
    expect(move.status).toBe("accepted");
    if (move.status !== "accepted") return;
    // journey_planned + actor_departed + arrival trigger + engagement interrupt.
    expect(move.eventIds).toHaveLength(3);
    expect(move.lastSequence - move.firstSequence).toBe(3);

    const projection = await readDurableEngagements(ids.branchId);
    expect(projection.engagements[0]?.state).toBe("interrupted");
    const space = await readDurableSpaceBranch(ids.branchId);
    expect(space.loci.find((locus) => locus.actorId === ids.mara)?.kind).toBe("in_transit");
  });

  it("ending releases attention; forks and rebuilds stay faithful", async () => {
    const ids = await seedSceneCase();
    await submitDurableOpenEngagement(openCommand(ids));

    const childBranchId = newId();
    const fork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: 1,
      principal: { kind: "player", principalId: "principal-1" },
      reason: "mid-conversation retake",
    });
    expect(fork.inheritedEventCount).toBe(1);
    const child = await readDurableEngagements(childBranchId);
    expect(child.engagements[0]?.state).toBe("active");

    const end = await submitDurableEndEngagement({
      id: `cmd-end-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: 1,
      idempotencyKey: `end-key-${ids.branchId}`,
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.mara] },
      submittedAtWallClock: "2026-07-17T12:20:00.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "end_engagement",
      schemaVersion: 1,
      payload: { engagementId: deriveEngagementId(ids.branchId, `cmd-open-${ids.branchId}`), reason: "participant_choice" },
    });
    expect(end.status).toBe("accepted");
    // Released: the nap that a live conversation would block now starts.
    const nap = await submitDurableStartActivity(napCommand(ids, ids.mara, 2, "after-end"));
    expect(nap.status).toBe("accepted");

    const live = await readDurableEngagements(ids.branchId);
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
    const rebuilt = replayEngagementsHistory({
      seed: emptyEngagementsSeed(ids.branchId, SEED_SECOND),
      events,
    });
    expect(simulationHash(rebuilt)).toBe(simulationHash(live));
  });
});
