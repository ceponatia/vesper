import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
import { deriveAssertionId } from "@/contracts/simulation/knowledge";
import { spaceProjectionSchema, type SpaceProjection } from "@/contracts/simulation/space";
import { newId } from "@/lib/ids";
import { replayKnowledgeHistory, replayObservationsHistory } from "@/lib/simulation";
import { db, simAssertions, simBeliefs, simEvents, simWorlds } from "@/server/db";
import { forkBranch } from "./branch-store";
import { readDurableCommitments, submitDurableCreateCommitment } from "./commitment-store";
import { submitDurableMakeDisclosure } from "./knowledge-store";
import { seedDurableMaterialBranch } from "./material-store";
import { branchEventFromRow } from "./observation-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { seedDurableSpaceTopology } from "./space-store";

const SEED_SECOND = 90_000;
const WALK = 600;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_beliefs limit 1`),
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
      `[knowledge-store.int.test] skipping: database unreachable or unmigrated: ${
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

/**
 * Fixture: home has a living room (mara, iris) and a kitchen (noor) — one
 * location, two zones; the shop is its own location with rook behind the
 * counter. Mara's claim about quitting is the knowledge arc under test.
 */
interface KnowledgeCase {
  worldId: string;
  branchId: string;
  mara: string;
  iris: string;
  noor: string;
  rook: string;
  locHome: string;
  locShop: string;
  zoneLiving: string;
  zoneKitchen: string;
  zoneShop: string;
}

function branchSeed(ids: KnowledgeCase): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e4-2-tests",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e4-2-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.mara, name: "Mara" },
      { id: ids.iris, name: "Iris" },
      { id: ids.noor, name: "Noor" },
      { id: ids.rook, name: "Rook" },
    ],
    items: [],
  });
}

function topologySeed(ids: KnowledgeCase) {
  return {
    branchId: ids.branchId,
    locations: [
      { id: ids.locHome, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" as const },
      { id: ids.locShop, worldId: ids.worldId, kind: "shop", defaultAccessPolicy: "public" as const },
    ],
    zones: [
      { id: ids.zoneLiving, locationId: ids.locHome, kind: "room", privacyPolicy: "semi_private" as const },
      { id: ids.zoneKitchen, locationId: ids.locHome, kind: "kitchen", privacyPolicy: "semi_private" as const },
      { id: ids.zoneShop, locationId: ids.locShop, kind: "shop", privacyPolicy: "public" as const },
    ],
    links: [
      {
        id: `${ids.branchId}-link-ls`,
        fromZoneId: ids.zoneLiving,
        toZoneId: ids.zoneShop,
        modes: ["walk" as const],
        minimumDurationSeconds: WALK,
        accessPolicy: "public" as const,
        state: "open" as const,
      },
    ],
    loci: [
      { kind: "at" as const, actorId: ids.mara, locationId: ids.locHome, zoneId: ids.zoneLiving, since: SEED_SECOND },
      { kind: "at" as const, actorId: ids.iris, locationId: ids.locHome, zoneId: ids.zoneLiving, since: SEED_SECOND },
      { kind: "at" as const, actorId: ids.noor, locationId: ids.locHome, zoneId: ids.zoneKitchen, since: SEED_SECOND },
      { kind: "at" as const, actorId: ids.rook, locationId: ids.locShop, zoneId: ids.zoneShop, since: SEED_SECOND },
    ],
  };
}

async function seedKnowledgeCase(): Promise<KnowledgeCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: KnowledgeCase = {
    worldId,
    branchId,
    mara: newId(),
    iris: newId(),
    noor: newId(),
    rook: newId(),
    locHome: `${worldId}-loc-home`,
    locShop: `${worldId}-loc-shop`,
    zoneLiving: `${branchId}-zone-living`,
    zoneKitchen: `${branchId}-zone-kitchen`,
    zoneShop: `${branchId}-zone-shop`,
  };
  await seedDurableMaterialBranch(branchSeed(ids));
  await seedDurableSpaceTopology(topologySeed(ids));
  seededWorldIds.push(worldId);
  return ids;
}

/** The replay seed: the space exactly as seeded, before any event. */
function spaceSeedProjection(ids: KnowledgeCase): SpaceProjection {
  const seed = topologySeed(ids);
  return spaceProjectionSchema.parse({
    worldId: ids.worldId,
    branchId: ids.branchId,
    rulesetVersion: "e4-2-test-v1",
    version: 0,
    headSequence: 0,
    storySecond: SEED_SECOND,
    locations: seed.locations.map(({ id, worldId: world, kind, defaultAccessPolicy }) => ({
      id,
      worldId: world,
      kind,
      defaultAccessPolicy,
    })),
    zones: seed.zones.map(({ id, locationId, kind, privacyPolicy }) => ({ id, locationId, kind, privacyPolicy })),
    links: seed.links,
    loci: seed.loci,
    journeys: [],
  });
}

function principalFor(actorId: string) {
  return { kind: "player", principalId: "principal-1", controlledActorIds: [actorId] };
}

function discloseCommand(
  ids: KnowledgeCase,
  input: {
    tag: string;
    expectedVersion: number;
    speakerActorId: string;
    targetActorIds: string[];
    content: Record<string, unknown>;
  },
) {
  return {
    id: `cmd-${input.tag}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: `${input.tag}-key-${ids.branchId}`,
    principal: principalFor(input.speakerActorId),
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "make_disclosure",
    schemaVersion: 1,
    payload: {
      speakerActorId: input.speakerActorId,
      targetActorIds: [...input.targetActorIds].sort(),
      content: input.content,
    },
  };
}

function quitClaim(ids: KnowledgeCase) {
  return {
    kind: "claim",
    propositionKey: "quitting_job",
    subjectIds: [ids.mara],
    claimedValue: { quitting: true },
  };
}

async function assertionRows(branchId: string) {
  return db()
    .select()
    .from(simAssertions)
    .where(eq(simAssertions.branchId, branchId))
    .orderBy(asc(simAssertions.assertionId));
}

async function beliefRows(branchId: string) {
  return db()
    .select()
    .from(simBeliefs)
    .where(eq(simBeliefs.branchId, branchId))
    .orderBy(asc(simBeliefs.beliefId));
}

async function branchEvents(branchId: string) {
  const rows = await db()
    .select()
    .from(simEvents)
    .where(eq(simEvents.branchId, branchId))
    .orderBy(asc(simEvents.sequence));
  return rows.map(branchEventFromRow);
}

/** Mara confides in Iris at home; returns the claim's assertion id. */
async function speakClaim(ids: KnowledgeCase, expectedVersion = 0): Promise<string> {
  const result = await submitDurableMakeDisclosure(
    discloseCommand(ids, {
      tag: "claim",
      expectedVersion,
      speakerActorId: ids.mara,
      targetActorIds: [ids.iris],
      content: quitClaim(ids),
    }),
  );
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error("expected acceptance");
  const eventId = result.eventIds[0];
  if (!eventId) throw new Error("expected the disclosure event id");
  return deriveAssertionId(eventId);
}

describe.runIf(ready)("E4.2 durable knowledge", () => {
  it("commits a claim's event, observations, assertion, and beliefs atomically", async () => {
    const ids = await seedKnowledgeCase();
    const assertionId = await speakClaim(ids);

    const assertions = await assertionRows(ids.branchId);
    expect(assertions).toHaveLength(1);
    expect(assertions[0]).toMatchObject({
      assertionId,
      propositionKey: "quitting_job",
      status: "active",
      sourceActorId: ids.mara,
      subjectIds: [ids.mara],
      claimedValue: { quitting: true },
      derivationVersion: "knowledge-v1",
    });

    // Iris alone believes: Mara spoke it, Noor heard only talking through
    // the wall, Rook is a location away.
    const beliefs = await beliefRows(ids.branchId);
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]).toMatchObject({
      holderActorId: ids.iris,
      assertionId,
      status: "active",
      confidenceFixedPoint: 9_000,
      learnedFromActorIds: [ids.mara],
    });
    expect(beliefs[0]?.basisObservationIds).toHaveLength(1);
  });

  it("carries gossip with provenance, decays each hop, and retracts only for those in earshot", async () => {
    const ids = await seedKnowledgeCase();
    const assertionId = await speakClaim(ids);

    // Iris relays to Rook across town — a device hop with an explicit event.
    const relay = await submitDurableMakeDisclosure(
      discloseCommand(ids, {
        tag: "relay",
        expectedVersion: 1,
        speakerActorId: ids.iris,
        targetActorIds: [ids.rook],
        content: { kind: "relay", assertionId },
      }),
    );
    expect(relay.status).toBe("accepted");

    const afterRelay = await beliefRows(ids.branchId);
    const rookBelief = afterRelay.find((row) => row.holderActorId === ids.rook);
    expect(rookBelief).toMatchObject({
      assertionId,
      status: "active",
      // min(remote-reported 8 500, teller 9 000 − hop 1 000) = 8 000.
      confidenceFixedPoint: 8_000,
      learnedFromActorIds: [ids.mara, ids.iris],
    });

    // Noor never heard the claim — she cannot relay it.
    const unbelieved = await submitDurableMakeDisclosure(
      discloseCommand(ids, {
        tag: "relay-x",
        expectedVersion: 2,
        speakerActorId: ids.noor,
        targetActorIds: [ids.rook],
        content: { kind: "relay", assertionId },
      }),
    );
    expect(unbelieved).toMatchObject({ status: "rejected", code: "relay_unbelieved" });

    // Mara takes it back — but only Iris is there to hear it.
    const retraction = await submitDurableMakeDisclosure(
      discloseCommand(ids, {
        tag: "retract",
        expectedVersion: 2,
        speakerActorId: ids.mara,
        targetActorIds: [ids.iris],
        content: { kind: "retraction", assertionId },
      }),
    );
    expect(retraction.status).toBe("accepted");

    const assertions = await assertionRows(ids.branchId);
    expect(assertions[0]?.status).toBe("retracted");
    const finalBeliefs = await beliefRows(ids.branchId);
    expect(finalBeliefs.find((row) => row.holderActorId === ids.iris)).toMatchObject({
      status: "rejected",
    });
    // Rook keeps believing the withdrawn claim — nobody told him.
    expect(finalBeliefs.find((row) => row.holderActorId === ids.rook)).toMatchObject({
      status: "active",
    });
  });

  it("replays the knowledge ledgers bit-for-bit from events and observations", async () => {
    const ids = await seedKnowledgeCase();
    const assertionId = await speakClaim(ids);
    await submitDurableMakeDisclosure(
      discloseCommand(ids, {
        tag: "relay",
        expectedVersion: 1,
        speakerActorId: ids.iris,
        targetActorIds: [ids.rook],
        content: { kind: "relay", assertionId },
      }),
    );

    const events = await branchEvents(ids.branchId);
    const replayedObservations = replayObservationsHistory({
      spaceSeed: spaceSeedProjection(ids),
      events,
    });
    const replayed = replayKnowledgeHistory({
      events,
      observations: replayedObservations.observations,
    });

    const liveAssertions = (await assertionRows(ids.branchId)).map((row) => ({
      id: row.assertionId,
      branchId: row.branchId,
      propositionKey: row.propositionKey,
      subjectIds: row.subjectIds,
      claimedValue: row.claimedValue,
      sourceActorId: row.sourceActorId,
      sourceEventId: row.sourceEventId,
      sourceEventSequence: row.sourceEventSequence,
      assertedAt: row.assertedAt,
      status: row.status,
      derivationVersion: row.derivationVersion,
    }));
    expect(liveAssertions).toEqual(
      replayed.assertions.map((assertion) => ({
        id: assertion.id,
        branchId: assertion.branchId,
        propositionKey: assertion.propositionKey,
        subjectIds: assertion.subjectIds,
        claimedValue: assertion.claimedValue,
        sourceActorId: assertion.sourceActorId ?? null,
        sourceEventId: assertion.sourceEventId ?? null,
        sourceEventSequence: assertion.sourceEventSequence ?? null,
        assertedAt: assertion.assertedAt,
        status: assertion.status,
        derivationVersion: assertion.derivationVersion,
      })),
    );

    const liveBeliefs = (await beliefRows(ids.branchId)).map((row) => ({
      id: row.beliefId,
      holderActorId: row.holderActorId,
      assertionId: row.assertionId,
      confidenceFixedPoint: row.confidenceFixedPoint,
      basisObservationIds: row.basisObservationIds,
      learnedFromActorIds: row.learnedFromActorIds,
      believedFrom: row.believedFrom,
      status: row.status,
      sourceEventId: row.sourceEventId,
      sourceEventSequence: row.sourceEventSequence,
    }));
    expect(liveBeliefs).toEqual(
      replayed.beliefs.map((belief) => ({
        id: belief.id,
        holderActorId: belief.holderActorId,
        assertionId: belief.assertionId,
        confidenceFixedPoint: belief.confidenceFixedPoint,
        basisObservationIds: belief.basisObservationIds,
        learnedFromActorIds: belief.learnedFromActorIds,
        believedFrom: belief.believedFrom,
        status: belief.status,
        sourceEventId: belief.sourceEventId,
        sourceEventSequence: belief.sourceEventSequence,
      })),
    );
  });

  it("a fork carries exactly the knowledge its inherited history explains", async () => {
    const ids = await seedKnowledgeCase();
    const assertionId = await speakClaim(ids);
    await submitDurableMakeDisclosure(
      discloseCommand(ids, {
        tag: "relay",
        expectedVersion: 1,
        speakerActorId: ids.iris,
        targetActorIds: [ids.rook],
        content: { kind: "relay", assertionId },
      }),
    );

    // Fork between the claim and the relay: the child knows what Iris heard,
    // never what Rook was told afterwards.
    const midBranchId = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId: midBranchId,
      atSequence: 1,
      principal: { kind: "player", principalId: "principal-1" },
      reason: "before the gossip spread",
    });
    const midBeliefs = await beliefRows(midBranchId);
    expect(midBeliefs.map((row) => row.holderActorId)).toEqual([ids.iris]);
    expect((await assertionRows(midBranchId))[0]).toMatchObject({ assertionId, status: "active" });

    // Fork at the head: identical ledgers, row for row.
    const headBranchId = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId: headBranchId,
      atSequence: 2,
      principal: { kind: "player", principalId: "principal-1" },
      reason: "full retake",
    });
    const strip = (rows: { beliefId: string; holderActorId: string; status: string; confidenceFixedPoint: number }[]) =>
      rows.map(({ beliefId, holderActorId, status, confidenceFixedPoint }) => ({
        beliefId,
        holderActorId,
        status,
        confidenceFixedPoint,
      }));
    expect(strip(await beliefRows(headBranchId))).toEqual(strip(await beliefRows(ids.branchId)));
  });

  it("gates commitment notice on the knowledge ledger: a held belief fires, ignorance fails closed", async () => {
    const ids = await seedKnowledgeCase();
    const assertionId = await speakClaim(ids);

    const latestArrival = SEED_SECOND + 5_000;
    const noticeLead = 500;
    const commitmentPayload = {
      kind: "appointment",
      destinationZoneId: ids.zoneShop,
      window: { latestArrival },
      priority: 10,
      flexibility: "firm",
      preparationSeconds: 100,
      reliabilityBufferSeconds: 0,
      noticeLeadSeconds: noticeLead,
      knowledgeSource: { kind: "asserted", assertionId },
    };
    // Iris holds a live belief in the claim; Rook has never heard it.
    const forIris = await submitDurableCreateCommitment({
      id: `cmd-commit-iris-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: 1,
      idempotencyKey: `commit-iris-key-${ids.branchId}`,
      principal: principalFor(ids.iris),
      submittedAtWallClock: "2026-07-19T12:02:00.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "create_commitment",
      schemaVersion: 1,
      payload: { ...commitmentPayload, actorId: ids.iris },
    });
    expect(forIris.status).toBe("accepted");
    const forRook = await submitDurableCreateCommitment({
      id: `cmd-commit-rook-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: 2,
      idempotencyKey: `commit-rook-key-${ids.branchId}`,
      principal: principalFor(ids.rook),
      submittedAtWallClock: "2026-07-19T12:02:30.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "create_commitment",
      schemaVersion: 1,
      payload: { ...commitmentPayload, actorId: ids.rook },
    });
    expect(forRook.status).toBe("accepted");

    const outcome = await advanceBranchStoryTime(ids.branchId, latestArrival - 200, {
      workerId: "w-notice",
    });
    expect(outcome).toMatchObject({ status: "advanced" });

    const projection = await readDurableCommitments(ids.branchId);
    const iris = projection.commitments.find((commitment) => commitment.actorId === ids.iris);
    const rook = projection.commitments.find((commitment) => commitment.actorId === ids.rook);
    expect(iris?.status).toBe("noticed");
    expect(rook?.status).toBe("planned");
    expect(projection.pressures.map((pressure) => pressure.actorId)).toEqual([ids.iris]);
  });
});
