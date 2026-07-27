import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
import { spaceProjectionSchema, type SpaceProjection } from "@/contracts/simulation/space";
import { newId } from "@/lib/ids";
import { replayObservationsHistory } from "@/lib/simulation";
import { db, simEvents, simObservations, simWorlds } from "@/server/db";
import { forkBranch } from "./branch-store";
import { readDurableCommitments, submitDurableCreateCommitment } from "./commitment-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { seedDurableMaterialBranch } from "./material-store";
import { branchEventFromRow } from "./observation-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { seedDurableSpaceTopology, submitDurableMoveActor } from "./space-store";
import { requireLegacyUnanchoredEngineTestMode } from "@/server/test-support";

const SEED_SECOND = 80_000;
const WALK = 600;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_observations limit 1`),
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
      `[observation-store.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
if (ready) requireLegacyUnanchoredEngineTestMode("observation-store.int.test");
const seededWorldIds: string[] = [];

afterAll(async () => {
  if (!ready || seededWorldIds.length === 0) return;
  await db().delete(simWorlds).where(inArray(simWorlds.id, seededWorldIds));
});

/**
 * Fixture: home has a living room (mara, iris) and a kitchen (noor) — one
 * location, two zones; the shop is its own location with rook behind the
 * counter. Mara's walk to the shop is the perceptible arc under test.
 */
interface PerceptionCase {
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

function branchSeed(ids: PerceptionCase): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e4-1-tests",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e4-1-test-v1",
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

function topologySeed(ids: PerceptionCase) {
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

async function seedPerceptionCase(): Promise<PerceptionCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: PerceptionCase = {
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
function spaceSeedProjection(ids: PerceptionCase): SpaceProjection {
  const seed = topologySeed(ids);
  return spaceProjectionSchema.parse({
    worldId: ids.worldId,
    branchId: ids.branchId,
    rulesetVersion: "e4-1-test-v1",
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

function openCommand(ids: PerceptionCase) {
  return {
    id: `cmd-open-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `open-key-${ids.branchId}`,
    principal: principalFor(ids.mara),
    submittedAtWallClock: "2026-07-18T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "open_engagement",
    schemaVersion: 1,
    payload: { participantIds: [ids.mara, ids.iris].sort(), channel: "co_present" },
  };
}

function moveCommand(ids: PerceptionCase, expectedVersion: number) {
  return {
    id: `cmd-move-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion,
    idempotencyKey: `move-key-${ids.branchId}`,
    principal: principalFor(ids.mara),
    submittedAtWallClock: "2026-07-18T12:01:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "move_actor",
    schemaVersion: 1,
    payload: { actorId: ids.mara, destinationZoneId: ids.zoneShop, travelMode: "walk" },
  };
}

interface ObservationFact {
  sequence: number;
  type: string;
  witness: string;
  channel: string;
  evidenceClass: string;
  detailTier: number;
}

async function liveObservationFacts(branchId: string): Promise<ObservationFact[]> {
  const eventTypes = new Map(
    (
      await db()
        .select({ id: simEvents.id, type: simEvents.type })
        .from(simEvents)
        .where(eq(simEvents.branchId, branchId))
    ).map((row) => [row.id, row.type]),
  );
  const rows = await db()
    .select()
    .from(simObservations)
    .where(eq(simObservations.branchId, branchId))
    .orderBy(asc(simObservations.sourceEventSequence), asc(simObservations.witnessActorId));
  return rows.map((row) => ({
    sequence: row.sourceEventSequence,
    type: eventTypes.get(row.sourceEventId) ?? "unknown-event",
    witness: row.witnessActorId,
    channel: row.channel,
    evidenceClass: row.evidenceClass,
    detailTier: row.detailTier,
  }));
}

async function branchEvents(branchId: string) {
  const rows = await db()
    .select()
    .from(simEvents)
    .where(eq(simEvents.branchId, branchId))
    .orderBy(asc(simEvents.sequence));
  return rows.map(branchEventFromRow);
}

/** Run the shared arc: open the living-room scene, depart Mara, arrive her. */
async function runDepartureArc(ids: PerceptionCase): Promise<void> {
  const open = await submitDurableOpenEngagement(openCommand(ids));
  expect(open.status).toBe("accepted");
  const move = await submitDurableMoveActor(moveCommand(ids, 1));
  expect(move.status).toBe("accepted");
  const outcome = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + WALK, { workerId: "w-arrive" });
  expect(outcome).toMatchObject({ status: "advanced" });
}

describe.runIf(ready)("E4.1 durable observations", () => {
  it("commits typed observations atomically with each command's events", async () => {
    const ids = await seedPerceptionCase();
    await runDepartureArc(ids);
    const facts = await liveObservationFacts(ids.branchId);
    const byType = (type: string) => facts.filter((fact) => fact.type === type);

    // The scene opening: participants are direct; the kitchen glimpses a
    // conversation starting nearby; the shop perceives nothing.
    expect(byType("engagement_opened").map((fact) => [fact.witness, fact.channel])).toEqual(
      [
        [ids.iris, "embodied"],
        [ids.mara, "embodied"],
        [ids.noor, "sight"],
      ].sort(([leftWitness], [rightWitness]) => (String(leftWitness) < String(rightWitness) ? -1 : 1)),
    );

    // Her own plan stays her own.
    expect(byType("journey_planned").map((fact) => fact.witness)).toEqual([ids.mara]);

    // The departure: mover embodied, same zone sees, kitchen only hears.
    const departed = byType("actor_departed");
    expect(departed.map((fact) => fact.witness)).toEqual([ids.iris, ids.mara, ids.noor].sort());
    expect(departed.find((fact) => fact.witness === ids.iris)).toMatchObject({
      channel: "sight",
      evidenceClass: "sensory",
      detailTier: 2,
    });
    expect(departed.find((fact) => fact.witness === ids.noor)).toMatchObject({
      channel: "sound",
      detailTier: 1,
    });
    expect(departed.some((fact) => fact.witness === ids.rook)).toBe(false);

    // The interrupt reaches both participants and the kitchen's glimpse.
    expect(byType("engagement_interrupted").map((fact) => fact.witness)).toEqual(
      [ids.iris, ids.mara, ids.noor].sort(),
    );

    // The arrival is a shop event now: only the shop (and Mara) perceive it.
    expect(byType("actor_arrived").map((fact) => [fact.witness, fact.channel])).toEqual(
      [
        [ids.mara, "embodied"],
        [ids.rook, "sight"],
      ].sort(([leftWitness], [rightWitness]) => (String(leftWitness) < String(rightWitness) ? -1 : 1)),
    );

    // Bookkeeping derived nothing.
    expect(byType("trigger_scheduled")).toEqual([]);
  });

  it("replays the observation log bit-for-bit from the event stream", async () => {
    const ids = await seedPerceptionCase();
    await runDepartureArc(ids);

    const replayed = replayObservationsHistory({
      spaceSeed: spaceSeedProjection(ids),
      events: await branchEvents(ids.branchId),
    });
    const rows = await db()
      .select()
      .from(simObservations)
      .where(eq(simObservations.branchId, ids.branchId));
    const normalize = (observations: { id: string }[]) =>
      [...observations].sort((left, right) => (left.id < right.id ? -1 : 1));
    expect(
      normalize(
        rows.map((row) => ({
          id: row.observationId,
          branchId: row.branchId,
          sourceEventId: row.sourceEventId,
          sourceEventSequence: row.sourceEventSequence,
          witnessActorId: row.witnessActorId,
          storySecond: row.storySecond,
          channel: row.channel,
          evidenceClass: row.evidenceClass,
          confidenceFixedPoint: row.confidenceFixedPoint,
          detailTier: row.detailTier,
          derivationVersion: row.derivationVersion,
        })),
      ),
    ).toEqual(normalize(replayed.observations));
  });

  it("a fork carries exactly the observations its inherited history explains", async () => {
    const ids = await seedPerceptionCase();
    await runDepartureArc(ids);
    const parentFacts = await liveObservationFacts(ids.branchId);
    const arrivalSequence = Math.max(
      ...parentFacts.filter((fact) => fact.type === "actor_arrived").map((fact) => fact.sequence),
    );

    // Fork just before the arrival: the child is mid-journey.
    const childBranchId = newId();
    const fork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: arrivalSequence - 1,
      principal: { kind: "player", principalId: "principal-1" },
      reason: "mid-journey retake",
    });
    expect(fork.inheritedEventCount).toBe(arrivalSequence - 1);

    const childFacts = await liveObservationFacts(childBranchId);
    // Wait: child observations reference ancestor events; resolve types via the parent's log.
    const parentBeforeArrival = parentFacts.filter((fact) => fact.sequence < arrivalSequence);
    expect(
      childFacts.map(({ sequence, witness, channel, evidenceClass, detailTier }) => ({
        sequence,
        witness,
        channel,
        evidenceClass,
        detailTier,
      })),
    ).toEqual(
      parentBeforeArrival.map(({ sequence, witness, channel, evidenceClass, detailTier }) => ({
        sequence,
        witness,
        channel,
        evidenceClass,
        detailTier,
      })),
    );
    expect(childFacts.some((fact) => fact.sequence >= arrivalSequence)).toBe(false);
  });

  it("gates commitment notice on real perception: observed knowledge fires, unobserved fails closed", async () => {
    const ids = await seedPerceptionCase();
    await runDepartureArc(ids);
    const departedEvent = (await branchEvents(ids.branchId)).find(
      (candidate) => candidate.type === "actor_departed",
    );
    if (!departedEvent) throw new Error("Departure event missing");

    const latestArrival = SEED_SECOND + 5_000;
    const noticeLead = 500;
    // actBy = latest − walk − prep; iris and rook share the same window.
    const noticeAt = latestArrival - WALK - 100 - noticeLead;
    const commitmentPayload = {
      kind: "appointment",
      destinationZoneId: ids.zoneShop,
      window: { latestArrival },
      priority: 10,
      flexibility: "firm",
      preparationSeconds: 100,
      reliabilityBufferSeconds: 0,
      noticeLeadSeconds: noticeLead,
      knowledgeSource: { kind: "observed", sourceEventId: departedEvent.id },
    };
    // Iris watched Mara leave; Rook was a location away and never saw it.
    const forIris = await submitDurableCreateCommitment({
      id: `cmd-commit-iris-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: 3,
      idempotencyKey: `commit-iris-key-${ids.branchId}`,
      principal: principalFor(ids.iris),
      submittedAtWallClock: "2026-07-18T12:02:00.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "create_commitment",
      schemaVersion: 1,
      payload: { ...commitmentPayload, actorId: ids.iris },
    });
    expect(forIris.status).toBe("accepted");
    const forRook = await submitDurableCreateCommitment({
      id: `cmd-commit-rook-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: 4,
      idempotencyKey: `commit-rook-key-${ids.branchId}`,
      principal: principalFor(ids.rook),
      submittedAtWallClock: "2026-07-18T12:02:30.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "create_commitment",
      schemaVersion: 1,
      payload: { ...commitmentPayload, actorId: ids.rook },
    });
    expect(forRook.status).toBe("accepted");

    const outcome = await advanceBranchStoryTime(ids.branchId, noticeAt + 10, { workerId: "w-notice" });
    expect(outcome).toMatchObject({ status: "advanced" });

    const projection = await readDurableCommitments(ids.branchId);
    const iris = projection.commitments.find((commitment) => commitment.actorId === ids.iris);
    const rook = projection.commitments.find((commitment) => commitment.actorId === ids.rook);
    // Iris can know — her pressure raised. Rook cannot — fails closed, no
    // pressure, commitment still awaiting a legal notice.
    expect(iris?.status).toBe("noticed");
    expect(rook?.status).toBe("planned");
    expect(projection.pressures.map((pressure) => pressure.actorId)).toEqual([ids.iris]);
  });
});
