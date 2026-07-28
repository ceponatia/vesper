import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import { deriveCommitmentId } from "@/lib/simulation";
import { db, simTriggers } from "@/server/db";
import { forkBranch } from "./branch-store";
import {
  readDurableCommitments,
  submitDurableCreateCommitment,
  submitDurableFulfillCommitment,
} from "./commitment-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { readDurableSpaceBranch, submitDurableMoveActor } from "./space-store";
import {
  expectAccepted,
  expectRejected,
  LEGACY_ENGINE_TEST_PLAYER_ID,
  playerPrincipal,
  seedSimBranch,
  seedSimpleBranch,
  simCommand,
  simulationSuiteHarness,
} from "@/server/test-support";

/**
 * E3.3 durable commitments and temporal pressure, plus E5.5 slice 2's
 * destinationless promises, `fulfill_commitment` and repair chains. Runs on the
 * shared `simulationSuiteHarness` scaffold (probe + legacy-player guard + world
 * teardown + pool close).
 */

const harness = await simulationSuiteHarness({ suite: "commitment-store.int.test", table: "sim_commitments" });

const SEED_SECOND = 50_000;
const WALK = 600;
const SHIFT_AT = 52_000;
const NOTICE_LEAD = 500;
const PREPARATION = 100;
// latestDeparture = 52_000 - 600 - 100 = 51_300; noticeAt = 50_800.
const NOTICE_AT = SHIFT_AT - WALK - PREPARATION - NOTICE_LEAD;

interface ShiftCase {
  worldId: string;
  branchId: string;
  actorId: string;
  zoneHome: string;
  zoneWork: string;
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
  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: "e3-3-tests",
    rulesetVersion: "e3-3-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [{ id: ids.actorId, name: "Mara" }],
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
    placements: [{ actorId: ids.actorId, locationId: locTown, zoneId: ids.zoneHome }],
  });
  harness.trackWorld(worldId);
  return ids;
}

function createCommand(ids: ShiftCase) {
  return simCommand({
    branchId: ids.branchId,
    name: "shift",
    type: "create_commitment",
    principal: playerPrincipal(ids.actorId),
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
  });
}

function moveCommand(ids: ShiftCase, expectedVersion: number) {
  return simCommand({
    branchId: ids.branchId,
    name: "depart",
    type: "move_actor",
    expectedVersion,
    principal: playerPrincipal(ids.actorId),
    payload: { actorId: ids.actorId, destinationZoneId: ids.zoneWork, travelMode: "walk" },
  });
}

describe.runIf(harness.ready)("E3.3 durable commitments and temporal pressure", () => {
  it("creates a shift with captured derivation and both triggers pending", async () => {
    const ids = await seedShiftCase();
    const result = await submitDurableCreateCommitment(createCommand(ids));
    expectAccepted(result, "create the shift commitment");
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
    expectAccepted(move, "depart in time for the shift");

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
    expectAccepted(move, "depart too late for the shift");

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
      principal: { kind: "player", principalId: LEGACY_ENGINE_TEST_PLAYER_ID },
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

// ---------------------------------------------------------------------------
// E5.5 slice 2 — destinationless commitments, fulfill_commitment, repair chains
// ---------------------------------------------------------------------------

interface PromiseCase {
  worldId: string;
  branchId: string;
  actorId: string;
  counterpartId: string;
  zoneHome: string;
}

async function seedPromiseCase(): Promise<PromiseCase> {
  const actorId = newId();
  const counterpartId = newId();
  const seeded = await seedSimpleBranch({
    prefix: "e5-5-test",
    actors: [
      { id: actorId, name: "Mara" },
      { id: counterpartId, name: "Ben" },
    ],
    originStorySecond: SEED_SECOND,
    locationSlug: "town",
    locationKind: "town",
    zoneSlug: "home",
    zoneKind: "room",
    privacyPolicy: "private",
  });
  harness.trackWorld(seeded.worldId);
  return {
    worldId: seeded.worldId,
    branchId: seeded.branchId,
    actorId,
    counterpartId,
    zoneHome: seeded.zoneId,
  };
}

function promiseCommand(
  ids: PromiseCase,
  options: { name?: string; expectedVersion?: number } = {},
  payloadOverrides: Record<string, unknown> = {},
) {
  return simCommand({
    branchId: ids.branchId,
    name: options.name ?? "promise",
    type: "create_commitment",
    expectedVersion: options.expectedVersion ?? 0,
    principal: playerPrincipal(ids.actorId),
    payload: {
      actorId: ids.actorId,
      kind: "promise",
      promisedToActorId: ids.counterpartId,
      window: { latestArrival: SEED_SECOND + 2_000 },
      priority: 0,
      flexibility: "soft",
      preparationSeconds: 0,
      reliabilityBufferSeconds: 0,
      noticeLeadSeconds: 0,
      knowledgeSource: { kind: "authored" },
      ...payloadOverrides,
    },
  });
}

function fulfillCommand(ids: PromiseCase, commitmentId: string, expectedVersion: number, suffix = "fulfill") {
  return simCommand({
    branchId: ids.branchId,
    name: suffix,
    type: "fulfill_commitment",
    expectedVersion,
    principal: playerPrincipal(ids.actorId),
    payload: { commitmentId },
  });
}

describe.runIf(harness.ready)("E5.5 slice 2 — destinationless commitments, fulfill_commitment, and repair chains", () => {
  it("creates a destinationless promise (no destinationZoneId) successfully", async () => {
    const ids = await seedPromiseCase();
    const result = await submitDurableCreateCommitment(promiseCommand(ids));
    expectAccepted(result, "create a destinationless promise");

    const projection = await readDurableCommitments(ids.branchId);
    expect(projection.commitments[0]?.destinationZoneId).toBeUndefined();
    expect(projection.commitments[0]?.promisedToActorId).toBe(ids.counterpartId);
  });

  it("fulfill_commitment keeps a destinationless commitment before its deadline", async () => {
    const ids = await seedPromiseCase();
    await submitDurableCreateCommitment(promiseCommand(ids));
    const commitmentId = deriveCommitmentId(ids.branchId, `cmd-promise-${ids.branchId}`);

    const result = await submitDurableFulfillCommitment(fulfillCommand(ids, commitmentId, 1));
    expectAccepted(result, "fulfill the promise before its deadline");

    const projection = await readDurableCommitments(ids.branchId);
    expect(projection.commitments[0]?.status).toBe("kept");
  });

  it("rejects commitment_has_destination when fulfilling a spatial commitment", async () => {
    const ids = await seedShiftCase();
    await submitDurableCreateCommitment(createCommand(ids));
    const commitmentId = deriveCommitmentId(ids.branchId, `cmd-shift-${ids.branchId}`);

    const result = await submitDurableFulfillCommitment(
      simCommand({
        branchId: ids.branchId,
        name: "fulfill-shift",
        type: "fulfill_commitment",
        expectedVersion: 1,
        principal: playerPrincipal(ids.actorId),
        payload: { commitmentId },
      }),
    );
    expectRejected(result, "commitment_has_destination", "fulfilling a commitment that has a destination");
  });

  it("rejects commitment_not_found and commitment_not_open", async () => {
    const ids = await seedPromiseCase();
    const missing = await submitDurableFulfillCommitment(
      fulfillCommand(ids, "commitment-does-not-exist", 0, "fulfill-missing"),
    );
    expectRejected(missing, "commitment_not_found", "fulfilling a commitment that never existed");

    await submitDurableCreateCommitment(promiseCommand(ids));
    const commitmentId = deriveCommitmentId(ids.branchId, `cmd-promise-${ids.branchId}`);
    const firstFulfill = await submitDurableFulfillCommitment(fulfillCommand(ids, commitmentId, 1, "fulfill-first"));
    expectAccepted(firstFulfill, "the first fulfillment");
    const again = await submitDurableFulfillCommitment(fulfillCommand(ids, commitmentId, 2, "fulfill-again"));
    expectRejected(again, "commitment_not_open", "fulfilling an already-kept commitment");
  });

  it("repair chain: A misses, B repairs it with a matching promisedToActorId → accepted and linked to A", async () => {
    const ids = await seedPromiseCase();
    await submitDurableCreateCommitment(
      promiseCommand(ids, {}, { window: { latestArrival: SEED_SECOND + 100 } }),
    );
    const commitmentAId = deriveCommitmentId(ids.branchId, `cmd-promise-${ids.branchId}`);
    await advanceBranchStoryTime(ids.branchId, SEED_SECOND + 200, { workerId: "w-repair-miss" });
    const afterMiss = await readDurableCommitments(ids.branchId);
    expect(afterMiss.commitments[0]?.status).toBe("missed");

    const repairResult = await submitDurableCreateCommitment(
      promiseCommand(
        ids,
        { name: "repair", expectedVersion: afterMiss.version },
        { repairsCommitmentId: commitmentAId },
      ),
    );
    expectAccepted(repairResult, "repair the missed promise");

    const after = await readDurableCommitments(ids.branchId);
    const repaired = after.commitments.find((commitment) => commitment.id !== commitmentAId);
    expect(repaired?.repairsCommitmentId).toBe(commitmentAId);
    expect(repaired?.promisedToActorId).toBe(ids.counterpartId);
  });

  it("rejects repair_target_not_found and promised_to_actor_not_found", async () => {
    const ids = await seedPromiseCase();
    const badRepair = await submitDurableCreateCommitment(
      promiseCommand(ids, {}, { repairsCommitmentId: "commitment-does-not-exist" }),
    );
    expectRejected(badRepair, "repair_target_not_found", "repairing a commitment that never existed");

    const badPromisee = await submitDurableCreateCommitment(
      promiseCommand(ids, { name: "promise2" }, { promisedToActorId: "actor-does-not-exist" }),
    );
    expectRejected(badPromisee, "promised_to_actor_not_found", "a promise to an actor that never existed");
  });

  it("rejects promised_to_self as a structured rejection instead of throwing — a self-promise resolves promisedToActorExists true (the actor's own row) and must not reach the raw commitmentSchema.parse throw", async () => {
    const ids = await seedPromiseCase();
    const selfPromise = await submitDurableCreateCommitment(
      promiseCommand(ids, { name: "promise-self" }, { promisedToActorId: ids.actorId }),
    );
    expectRejected(selfPromise, "promised_to_self", "a promise the actor made to themselves");
  });
});
