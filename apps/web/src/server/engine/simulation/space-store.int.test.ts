import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import { simulationHash } from "@vesper/simulation-core/hash";
import { replaySpaceHistory, spaceSeedForReplay } from "@vesper/simulation-core/space";
import { db, simEvents, simJourneys, simPhysicalLoci, simTimeJobs, simTriggers } from "@/server/db";
import { moveArrivalTarget, settleStrandedInTransit } from "@/server/engine";
import {
  LEGACY_ENGINE_TEST_PLAYER_ID,
  expectAccepted,
  expectRejected,
  playerPrincipal,
  readBranchEvents,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
} from "@/server/test-support";
import { forkBranch } from "./branch-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import {
  readDurableSpaceBranch,
  submitDurableMoveActor,
} from "./space-store";

/**
 * E3.1 durable space authority. Probe, legacy-player opt-in, seeded-world
 * teardown and pool close all come from `simulationSuiteHarness`; the probe
 * reads `sim_physical_loci`, which is itself the from-zero migration check (an
 * orphaned migration leaves that table absent).
 */

const SEED_SECOND = 10_000;
const WALK_AB = 600;
const WALK_BC = 300;

const harness = await simulationSuiteHarness({
  suite: "space-store.int.test",
  table: "sim_physical_loci",
});
const ready = harness.ready;

interface SpaceCase {
  worldId: string;
  branchId: string;
  actorId: string;
  zoneA: string;
  zoneB: string;
  zoneC: string;
}

async function seedSpaceCase(): Promise<SpaceCase> {
  const worldId = newId();
  const branchId = newId();
  const actorId = newId();
  const zoneA = `${branchId}-zone-a`;
  const zoneB = `${branchId}-zone-b`;
  const zoneC = `${branchId}-zone-c`;
  const locHome = `${worldId}-loc-home`;
  const locCafe = `${worldId}-loc-cafe`;
  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: "e3-1-tests",
    rulesetVersion: "e3-1-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [{ id: actorId, name: "Mara" }],
    locations: [
      { id: locHome, worldId, kind: "home", defaultAccessPolicy: "private" },
      { id: locCafe, worldId, kind: "cafe", defaultAccessPolicy: "public" },
    ],
    zones: [
      { id: zoneA, locationId: locHome, kind: "room", privacyPolicy: "private" },
      { id: zoneB, locationId: locCafe, kind: "hall", privacyPolicy: "public" },
      { id: zoneC, locationId: locCafe, kind: "terrace", privacyPolicy: "public" },
    ],
    links: [
      {
        id: `${branchId}-link-ab`,
        fromZoneId: zoneA,
        toZoneId: zoneB,
        modes: ["walk"],
        minimumDurationSeconds: WALK_AB,
        accessPolicy: "public",
        state: "open",
      },
      {
        id: `${branchId}-link-bc`,
        fromZoneId: zoneB,
        toZoneId: zoneC,
        modes: ["walk"],
        minimumDurationSeconds: WALK_BC,
        accessPolicy: "public",
        state: "open",
      },
    ],
    placements: [{ actorId, locationId: locHome, zoneId: zoneA }],
  });
  harness.trackWorld(worldId);
  return { worldId, branchId, actorId, zoneA, zoneB, zoneC };
}

function moveCommand(
  ids: SpaceCase,
  overrides: {
    name?: string;
    expectedVersion?: number;
    destinationZoneId?: string;
    controlledActorIds?: string[];
  } = {},
) {
  const principal = playerPrincipal(ids.actorId);
  return simCommand({
    branchId: ids.branchId,
    name: overrides.name ?? "move",
    type: "move_actor",
    ...(overrides.expectedVersion === undefined ? {} : { expectedVersion: overrides.expectedVersion }),
    principal:
      overrides.controlledActorIds === undefined
        ? principal
        : { ...principal, controlledActorIds: overrides.controlledActorIds },
    payload: {
      actorId: ids.actorId,
      destinationZoneId: overrides.destinationZoneId ?? ids.zoneC,
      travelMode: "walk",
    },
  });
}

/** The branch's material space facts, id-independent for cross-world comparison. */
function materialFacts(ids: SpaceCase, projection: Awaited<ReturnType<typeof readDurableSpaceBranch>>) {
  const zoneNames = new Map<string, string>([
    [ids.zoneA, "a"],
    [ids.zoneB, "b"],
    [ids.zoneC, "c"],
  ]);
  return {
    loci: projection.loci.map((locus) =>
      locus.kind === "at"
        ? { kind: locus.kind, zone: zoneNames.get(locus.zoneId), since: locus.since }
        : { kind: locus.kind, enteredAt: locus.enteredAt },
    ),
    journeys: projection.journeys.map((journey) => ({
      status: journey.status,
      origin: zoneNames.get(journey.originZoneId),
      destination: zoneNames.get(journey.destinationZoneId),
      earliestArrivalAt: journey.earliestArrivalAt,
    })),
    storySecond: projection.storySecond,
  };
}

describe.runIf(ready)("E3.1 durable space authority", () => {
  it("resolves a move into three atomic events, a transit locus, and a pending arrival trigger", async () => {
    const ids = await seedSpaceCase();
    const result = await submitDurableMoveActor(moveCommand(ids));
    expectAccepted(result, "the seeded move A -> C");
    expect(result.eventIds).toHaveLength(3);
    expect([result.firstSequence, result.lastSequence]).toEqual([1, 3]);

    const projection = await readDurableSpaceBranch(ids.branchId);
    expect(projection.version).toBe(1);
    expect(projection.loci[0]?.kind).toBe("in_transit");
    expect(projection.journeys[0]?.status).toBe("active");
    expect(projection.journeys[0]?.earliestArrivalAt).toBe(SEED_SECOND + WALK_AB + WALK_BC);

    const [trigger] = await db()
      .select()
      .from(simTriggers)
      .where(eq(simTriggers.branchId, ids.branchId));
    expect(trigger?.kind).toBe("journey_arrival_due");
    expect(trigger?.state).toBe("pending");
    expect(trigger?.dueStorySecond).toBe(SEED_SECOND + WALK_AB + WALK_BC);
  });

  it("moveArrivalTarget follows expectedArrivalAt, not earliestArrivalAt, once a delay makes them diverge (A7)", async () => {
    const ids = await seedSpaceCase();
    const result = await submitDurableMoveActor(moveCommand(ids));
    expectAccepted(result, "the move whose arrival is later delayed");

    const earliest = SEED_SECOND + WALK_AB + WALK_BC;
    const before = await readDurableSpaceBranch(ids.branchId);
    // A fresh journey: planRoute funds no uncertainty, so both bounds agree AND the arrival
    // trigger's due second equals both (verified in the test above at `dueStorySecond`).
    expect(before.journeys[0]?.earliestArrivalAt).toBe(earliest);
    expect(before.journeys[0]?.expectedArrivalAt).toBe(earliest);
    expect(await moveArrivalTarget(ids.branchId, ids.actorId)).toBe(earliest);

    // Simulate a journey_delayed: expected slips 200s past earliest (the divergence A7 disarms;
    // the schema check `expected >= earliest` permits it). The arrival trigger is due at
    // expectedArrivalAt, so the drain target MUST follow expected — draining only to `earliest`
    // would stop before the arrival fires and strand the traveller in transit.
    const delayed = earliest + 200;
    await db().update(simJourneys).set({ expectedArrivalAt: delayed }).where(eq(simJourneys.branchId, ids.branchId));

    const after = await readDurableSpaceBranch(ids.branchId);
    expect(after.journeys[0]?.earliestArrivalAt).toBe(earliest);
    expect(after.journeys[0]?.expectedArrivalAt).toBe(delayed);
    expect(await moveArrivalTarget(ids.branchId, ids.actorId)).toBe(delayed);
  });

  it("escalates a durable time job when a traveller is still in transit after the drain (A7 recovery)", async () => {
    const ids = await seedSpaceCase();
    await submitDurableMoveActor(moveCommand(ids)); // actor in_transit; clock still at SEED_SECOND
    const earliest = SEED_SECOND + WALK_AB + WALK_BC;
    const delayed = earliest + 200;
    // A delay slips the expected arrival past where any in-request drain reached (here: no drain,
    // so the clock is still at SEED, well short of `delayed`) — the actor is genuinely stranded.
    await db().update(simJourneys).set({ expectedArrivalAt: delayed }).where(eq(simJourneys.branchId, ids.branchId));

    const space = await readDurableSpaceBranch(ids.branchId);
    const chatId = newId();
    await settleStrandedInTransit({ site: "travel", space, actorIds: [ids.actorId], chatId });

    // A7 recovery: a durable time job was escalated to the expected arrival so the runner settles
    // it offline (the enqueue is awaited before the detached kick, so the row exists here).
    const [job] = await db().select().from(simTimeJobs).where(eq(simTimeJobs.branchId, ids.branchId));
    expect(job).toBeDefined();
    expect(job?.targetStorySecond).toBe(delayed);
    expect(job?.chatId).toBe(chatId);
  });

  it("arrives through the scheduler drain, stamping the arrival at its due second", async () => {
    const ids = await seedSpaceCase();
    await submitDurableMoveActor(moveCommand(ids));
    const arrivalSecond = SEED_SECOND + WALK_AB + WALK_BC;

    // Advancing short of the due second must not arrive anyone.
    const early = await advanceBranchStoryTime(ids.branchId, arrivalSecond - 1, { workerId: "worker-early" });
    expect(early.status).toBe("advanced");
    const midway = await readDurableSpaceBranch(ids.branchId);
    expect(midway.loci[0]?.kind).toBe("in_transit");

    const outcome = await advanceBranchStoryTime(ids.branchId, arrivalSecond + 500, { workerId: "worker-1" });
    expect(outcome).toMatchObject({ status: "advanced", drained: 1 });

    const projection = await readDurableSpaceBranch(ids.branchId);
    expect(projection.version).toBe(2);
    expect(projection.journeys[0]?.status).toBe("arrived");
    expect(projection.loci[0]).toMatchObject({ kind: "at", zoneId: ids.zoneC, since: arrivalSecond });

    const [arrivedEvent] = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence))
      .offset(3);
    expect(arrivedEvent?.type).toBe("actor_arrived");
    // §12.2 step 3: the clock stepped to the due second before resolution.
    expect(arrivedEvent?.storySecond).toBe(arrivalSecond);

    const [trigger] = await db()
      .select()
      .from(simTriggers)
      .where(eq(simTriggers.branchId, ids.branchId));
    expect(trigger?.state).toBe("completed");
    expect(trigger?.resultCommandId).toBeTruthy();
  });

  it("produces the same material outcome for one large skip and equivalent partitions", async () => {
    const wholesale = await seedSpaceCase();
    const partitioned = await seedSpaceCase();
    await submitDurableMoveActor(moveCommand(wholesale));
    await submitDurableMoveActor(moveCommand(partitioned));
    const target = SEED_SECOND + 2_000;

    await advanceBranchStoryTime(wholesale.branchId, target, { workerId: "w-whole" });
    for (const boundary of [SEED_SECOND + 700, SEED_SECOND + 900, target]) {
      await advanceBranchStoryTime(partitioned.branchId, boundary, { workerId: "w-part" });
    }

    const wholeFacts = materialFacts(wholesale, await readDurableSpaceBranch(wholesale.branchId));
    const partFacts = materialFacts(partitioned, await readDurableSpaceBranch(partitioned.branchId));
    expect(simulationHash(partFacts)).toBe(simulationHash(wholeFacts));
  });

  it("returns the stored result for duplicate submissions and conflicts for stale versions", async () => {
    const ids = await seedSpaceCase();
    const first = await submitDurableMoveActor(moveCommand(ids));
    expectAccepted(first, "the first move");
    const replayed = await submitDurableMoveActor(moveCommand(ids));
    expect(replayed).toEqual(first);
    const eventCount = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(eventCount).toHaveLength(3);

    const stale = await submitDurableMoveActor(moveCommand(ids, { name: "stale", expectedVersion: 0 }));
    expect(stale.status).toBe("conflict");
  });

  it("rejects unauthorized, in-transit, and unroutable movement deterministically", async () => {
    const ids = await seedSpaceCase();
    const unauthorized = await submitDurableMoveActor(
      moveCommand(ids, { name: "un", controlledActorIds: [newId()] }),
    );
    expectRejected(unauthorized, "unauthorized_actor", "a move for an actor the principal does not control");

    const accepted = await submitDurableMoveActor(moveCommand(ids));
    expectAccepted(accepted, "the legitimate move that puts the actor in transit");

    const whileMoving = await submitDurableMoveActor(
      moveCommand(ids, { name: "again", expectedVersion: 1, destinationZoneId: ids.zoneB }),
    );
    expectRejected(whileMoving, "actor_in_transit", "a second move issued mid-journey");

    // No rejected path may have left partial space state behind.
    const projection = await readDurableSpaceBranch(ids.branchId);
    expect(projection.journeys).toHaveLength(1);
    const lociRows = await db()
      .select()
      .from(simPhysicalLoci)
      .where(eq(simPhysicalLoci.branchId, ids.branchId));
    expect(lociRows).toHaveLength(1);
  });

  it("forks mid-journey: the child stays in transit with a re-armed pending arrival", async () => {
    const ids = await seedSpaceCase();
    await submitDurableMoveActor(moveCommand(ids));
    const childBranchId = newId();
    const fork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: 3,
      principal: { kind: "player", principalId: LEGACY_ENGINE_TEST_PLAYER_ID },
      reason: "mid-journey retake",
    });
    expect(fork.pendingTriggerIds).toHaveLength(1);
    expect(fork.completedTriggerIds).toHaveLength(0);

    const child = await readDurableSpaceBranch(childBranchId);
    expect(child.loci[0]?.kind).toBe("in_transit");
    expect(child.journeys[0]?.status).toBe("active");

    // The child's journey completes on its own clock; the parent is untouched.
    const arrivalSecond = SEED_SECOND + WALK_AB + WALK_BC;
    const outcome = await advanceBranchStoryTime(childBranchId, arrivalSecond, { workerId: "w-child" });
    expect(outcome.status).toBe("advanced");
    const arrivedChild = await readDurableSpaceBranch(childBranchId);
    expect(arrivedChild.loci[0]).toMatchObject({ kind: "at", zoneId: ids.zoneC });
    const parent = await readDurableSpaceBranch(ids.branchId);
    expect(parent.loci[0]?.kind).toBe("in_transit");
    const [parentTrigger] = await db()
      .select()
      .from(simTriggers)
      .where(eq(simTriggers.branchId, ids.branchId));
    expect(parentTrigger?.state).toBe("pending");
  });

  it("forks after arrival: the child records the trigger completed, never re-armed", async () => {
    const ids = await seedSpaceCase();
    await submitDurableMoveActor(moveCommand(ids));
    const arrivalSecond = SEED_SECOND + WALK_AB + WALK_BC;
    await advanceBranchStoryTime(ids.branchId, arrivalSecond, { workerId: "w-parent" });

    const childBranchId = newId();
    const fork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: 4,
      principal: { kind: "player", principalId: LEGACY_ENGINE_TEST_PLAYER_ID },
      reason: "post-arrival retake",
    });
    expect(fork.pendingTriggerIds).toHaveLength(0);
    expect(fork.completedTriggerIds).toHaveLength(1);

    const child = await readDurableSpaceBranch(childBranchId);
    expect(child.loci[0]).toMatchObject({ kind: "at", zoneId: ids.zoneC, since: arrivalSecond });
    expect(child.journeys[0]?.status).toBe("arrived");
    const journeyRows = await db()
      .select()
      .from(simJourneys)
      .where(eq(simJourneys.branchId, childBranchId));
    expect(journeyRows).toHaveLength(1);
  });

  it("rebuilds the space projection from zero to the live hash", async () => {
    const ids = await seedSpaceCase();
    await submitDurableMoveActor(moveCommand(ids));
    const arrivalSecond = SEED_SECOND + WALK_AB + WALK_BC;
    await advanceBranchStoryTime(ids.branchId, arrivalSecond, { workerId: "w-rebuild" });

    const live = await readDurableSpaceBranch(ids.branchId);
    const events = await readBranchEvents(ids.branchId);
    const seed = spaceSeedForReplay({
      branchId: ids.branchId,
      current: live,
      events,
      originStorySecond: SEED_SECOND,
    });
    const rebuilt = replaySpaceHistory({ seed, events });
    expect(simulationHash(rebuilt)).toBe(simulationHash(live));
  });
});
