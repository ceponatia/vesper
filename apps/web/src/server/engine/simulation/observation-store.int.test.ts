import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { spaceProjectionSchema, type SpaceProjection } from "@/contracts/simulation/space";
import { newId } from "@/lib/ids";
import { replayObservationsHistory } from "@/lib/simulation";
import { db, simEvents, simObservations } from "@/server/db";
import {
  expectAccepted,
  playerPrincipal,
  readBranchEvents,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
  type SimActorPlacement,
} from "@/server/test-support";
import { forkBranch } from "./branch-store";
import { readDurableCommitments, submitDurableCreateCommitment } from "./commitment-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { submitDurableMoveActor, type SpaceTopologySeed } from "./space-store";

const SEED_SECOND = 80_000;
const WALK = 600;

const harness = await simulationSuiteHarness({
  suite: "observation-store.int.test",
  table: "sim_observations",
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

const RULESET_VERSION = "e4-1-test-v1";

interface PerceptionTopology {
  locations: SpaceTopologySeed["locations"];
  zones: SpaceTopologySeed["zones"];
  links: SpaceTopologySeed["links"];
  placements: SimActorPlacement[];
}

/** The seeded space, shared by the seeder and the replay-seed projection below. */
function topology(ids: PerceptionCase): PerceptionTopology {
  return {
    locations: [
      { id: ids.locHome, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" },
      { id: ids.locShop, worldId: ids.worldId, kind: "shop", defaultAccessPolicy: "public" },
    ],
    zones: [
      { id: ids.zoneLiving, locationId: ids.locHome, kind: "room", privacyPolicy: "semi_private" },
      { id: ids.zoneKitchen, locationId: ids.locHome, kind: "kitchen", privacyPolicy: "semi_private" },
      { id: ids.zoneShop, locationId: ids.locShop, kind: "shop", privacyPolicy: "public" },
    ],
    links: [
      {
        id: `${ids.branchId}-link-ls`,
        fromZoneId: ids.zoneLiving,
        toZoneId: ids.zoneShop,
        modes: ["walk"],
        minimumDurationSeconds: WALK,
        accessPolicy: "public",
        state: "open",
      },
    ],
    placements: [
      { actorId: ids.mara, locationId: ids.locHome, zoneId: ids.zoneLiving },
      { actorId: ids.iris, locationId: ids.locHome, zoneId: ids.zoneLiving },
      { actorId: ids.noor, locationId: ids.locHome, zoneId: ids.zoneKitchen },
      { actorId: ids.rook, locationId: ids.locShop, zoneId: ids.zoneShop },
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
  const space = topology(ids);
  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: "e4-1-tests",
    rulesetVersion: RULESET_VERSION,
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.mara, name: "Mara" },
      { id: ids.iris, name: "Iris" },
      { id: ids.noor, name: "Noor" },
      { id: ids.rook, name: "Rook" },
    ],
    locations: space.locations,
    zones: space.zones,
    links: space.links,
    placements: space.placements,
  });
  harness.trackWorld(worldId);
  return ids;
}

/** The replay seed: the space exactly as seeded, before any event. */
function spaceSeedProjection(ids: PerceptionCase): SpaceProjection {
  const space = topology(ids);
  return spaceProjectionSchema.parse({
    worldId: ids.worldId,
    branchId: ids.branchId,
    rulesetVersion: RULESET_VERSION,
    version: 0,
    headSequence: 0,
    storySecond: SEED_SECOND,
    locations: space.locations.map(({ id, worldId: world, kind, defaultAccessPolicy }) => ({
      id,
      worldId: world,
      kind,
      defaultAccessPolicy,
    })),
    zones: space.zones.map(({ id, locationId, kind, privacyPolicy }) => ({ id, locationId, kind, privacyPolicy })),
    links: space.links,
    // `seedSimBranch` places every actor with an `at` locus stamped at the origin second.
    loci: space.placements.map(({ actorId, locationId, zoneId }) => ({
      kind: "at" as const,
      actorId,
      locationId,
      zoneId,
      since: SEED_SECOND,
    })),
    journeys: [],
  });
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

/** Run the shared arc: open the living-room scene, depart Mara, arrive her. */
async function runDepartureArc(ids: PerceptionCase): Promise<void> {
  const open = await submitDurableOpenEngagement(
    simCommand({
      branchId: ids.branchId,
      name: "open",
      type: "open_engagement",
      principal: playerPrincipal(ids.mara),
      payload: { participantIds: [ids.mara, ids.iris].sort(), channel: "co_present" },
    }),
  );
  expectAccepted(open, "scene open");
  const move = await submitDurableMoveActor(
    simCommand({
      branchId: ids.branchId,
      name: "move",
      type: "move_actor",
      expectedVersion: 1,
      principal: playerPrincipal(ids.mara),
      payload: { actorId: ids.mara, destinationZoneId: ids.zoneShop, travelMode: "walk" },
    }),
  );
  expectAccepted(move, "Mara departs");
  const outcome = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + WALK, { workerId: "w-arrive" });
  expect(outcome).toMatchObject({ status: "advanced" });
}

describe.runIf(harness.ready)("E4.1 durable observations", () => {
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
      events: await readBranchEvents(ids.branchId),
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

    // Fork just before the arrival: the child is mid-journey — NOT at head, so this
    // stays a direct `forkBranch` rather than the shared `forkAtHead` helper.
    const childBranchId = newId();
    const { kind, principalId } = playerPrincipal(ids.mara);
    const fork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: arrivalSequence - 1,
      principal: { kind, principalId },
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
    const departedEvent = (await readBranchEvents(ids.branchId)).find(
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
    const forIris = await submitDurableCreateCommitment(
      simCommand({
        branchId: ids.branchId,
        name: "commit-iris",
        type: "create_commitment",
        expectedVersion: 3,
        principal: playerPrincipal(ids.iris),
        payload: { ...commitmentPayload, actorId: ids.iris },
      }),
    );
    expectAccepted(forIris, "Iris commitment");
    const forRook = await submitDurableCreateCommitment(
      simCommand({
        branchId: ids.branchId,
        name: "commit-rook",
        type: "create_commitment",
        expectedVersion: 4,
        principal: playerPrincipal(ids.rook),
        payload: { ...commitmentPayload, actorId: ids.rook },
      }),
    );
    expectAccepted(forRook, "Rook commitment");

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
