import { describe, expect, it } from "vitest";
import {
  simulationBranchEventSchema,
  type SimulationBranchEvent,
} from "../contracts/branching";
import { GATE3_ROUTE_VERSION } from "../contracts/space";
import { spaceProjectionSchema, type SpaceProjection } from "../contracts/space";
import { bindSimEnvelopes } from "../test-support/sim-envelopes";
import {
  PERCEPTION_DERIVATION_VERSION,
  deriveCommandObservations,
  deriveEventObservations,
  replayObservationsHistory,
} from "./perception";

const NOW = 100_000;

/** This suite carries its own ruleset, so bind the world/branch/ruleset trio once. */
const env = bindSimEnvelopes({ worldId: "world-1", branchId: "branch-1", rulesetVersion: "e4-1-test-v1" });

/**
 * Fixture: the cafe has a hall and a kitchen (one location, two zones); the
 * shop is its own location. Player and Mara stand in the hall, Iris in the
 * kitchen, Rook at the shop, Wren is mid-transit.
 */
function fixtureSpace(overrides: { loci?: unknown[] } = {}): SpaceProjection {
  return spaceProjectionSchema.parse({
    ...env.meta({ headSequence: 10, storySecond: NOW }),
    version: 3,
    locations: [
      { id: "loc-cafe", worldId: "world-1", kind: "cafe", defaultAccessPolicy: "public" },
      { id: "loc-shop", worldId: "world-1", kind: "shop", defaultAccessPolicy: "public" },
    ],
    zones: [
      { id: "zone-hall", locationId: "loc-cafe", kind: "hall", privacyPolicy: "public" },
      { id: "zone-kitchen", locationId: "loc-cafe", kind: "kitchen", privacyPolicy: "semi_private" },
      { id: "zone-shop", locationId: "loc-shop", kind: "shop", privacyPolicy: "public" },
    ],
    links: [
      {
        id: "link-hs",
        fromZoneId: "zone-hall",
        toZoneId: "zone-shop",
        modes: ["walk"],
        minimumDurationSeconds: 300,
        accessPolicy: "public",
        state: "open",
      },
    ],
    loci: overrides.loci ?? [
      { kind: "at", actorId: "player", locationId: "loc-cafe", zoneId: "zone-hall", since: NOW },
      { kind: "at", actorId: "mara", locationId: "loc-cafe", zoneId: "zone-hall", since: NOW },
      { kind: "at", actorId: "iris", locationId: "loc-cafe", zoneId: "zone-kitchen", since: NOW },
      { kind: "at", actorId: "rook", locationId: "loc-shop", zoneId: "zone-shop", since: NOW },
      {
        kind: "in_transit",
        actorId: "wren",
        journeyId: "journey-w",
        linkId: "link-hs",
        enteredAt: NOW - 100,
        earliestExitAt: NOW + 200,
      },
    ],
    journeys: [
      {
        id: "journey-w",
        actorIds: ["wren"],
        originZoneId: "zone-hall",
        destinationZoneId: "zone-shop",
        routeLinkIds: ["link-hs"],
        travelMode: "walk",
        departedAt: NOW - 100,
        earliestArrivalAt: NOW + 200,
        expectedArrivalAt: NOW + 200,
        status: "active",
        currentLinkIndex: 0,
        routeDerivationVersion: GATE3_ROUTE_VERSION,
      },
    ],
  });
}

function event(overrides: Record<string, unknown>): SimulationBranchEvent {
  return env.event(simulationBranchEventSchema, {
    type: String(overrides.type),
    sequence: typeof overrides.sequence === "number" ? overrides.sequence : 11,
    storySecond: NOW,
    commandId: "cmd-1",
    payload: overrides.payload,
    // The caller's record still has the last word on every field.
    overrides,
  });
}

function witnesses(observations: { witnessActorId: string }[]): string[] {
  return observations.map((observation) => observation.witnessActorId);
}

describe("E4.1 deriveEventObservations", () => {
  it("grades a departure: mover embodied, same zone sees, same location hears, elsewhere nothing", () => {
    const departed = event({
      type: "actor_departed",
      actorIds: ["mara"],
      locationId: "loc-cafe",
      payload: { journeyId: "journey-m", fromZoneId: "zone-hall", linkId: "link-hs", departedAt: NOW },
    });
    // Post-command state: Mara is already in transit.
    const space = fixtureSpace({
      loci: [
        { kind: "at", actorId: "player", locationId: "loc-cafe", zoneId: "zone-hall", since: NOW },
        { kind: "at", actorId: "iris", locationId: "loc-cafe", zoneId: "zone-kitchen", since: NOW },
        { kind: "at", actorId: "rook", locationId: "loc-shop", zoneId: "zone-shop", since: NOW },
        {
          kind: "in_transit",
          actorId: "mara",
          journeyId: "journey-w",
          linkId: "link-hs",
          enteredAt: NOW,
          earliestExitAt: NOW + 300,
        },
      ],
    });
    const observations = deriveEventObservations(departed, space);
    expect(witnesses(observations)).toEqual(["iris", "mara", "player"]);
    const byWitness = new Map<string, (typeof observations)[number]>(
      observations.map((observation) => [observation.witnessActorId, observation]),
    );
    expect(byWitness.get("mara")).toMatchObject({ channel: "embodied", evidenceClass: "direct", detailTier: 3 });
    expect(byWitness.get("player")).toMatchObject({ channel: "sight", evidenceClass: "sensory", detailTier: 2 });
    expect(byWitness.get("iris")).toMatchObject({ channel: "sound", evidenceClass: "sensory", detailTier: 1 });
    for (const observation of observations) {
      expect(observation.sourceEventId).toBe(departed.id);
      expect(observation.sourceEventSequence).toBe(departed.sequence);
      expect(observation.derivationVersion).toBe(PERCEPTION_DERIVATION_VERSION);
    }
  });

  it("trusts the captured payload set on activity events — a private activity stays private", () => {
    const shower = event({
      type: "activity_completed",
      actorIds: ["iris"],
      locationId: "loc-cafe",
      payload: {
        activityInstanceId: "activity-1",
        completedAt: NOW,
        observerActorIds: [],
      },
    });
    const observations = deriveEventObservations(shower, fixtureSpace());
    // No blanket co-location: only the participant perceives a private completion.
    expect(witnesses(observations)).toEqual(["iris"]);
    expect(observations[0]).toMatchObject({ channel: "embodied", evidenceClass: "direct" });

    const obvious = event({
      type: "activity_completed",
      actorIds: ["iris"],
      locationId: "loc-cafe",
      payload: {
        activityInstanceId: "activity-1",
        completedAt: NOW,
        observerActorIds: ["iris", "player"],
      },
    });
    const observed = deriveEventObservations(obvious, fixtureSpace());
    expect(witnesses(observed)).toEqual(["iris", "player"]);
    // The participant outranks their own captured-witness entry.
    expect(observed[0]).toMatchObject({ witnessActorId: "iris", evidenceClass: "direct" });
    expect(observed[1]).toMatchObject({ witnessActorId: "player", channel: "sight", detailTier: 2 });
  });

  it("keeps threshold entry to its captured witnesses — no blanket co-location", () => {
    const entered = event({
      type: "zone_entered",
      actorIds: ["rook"],
      locationId: "loc-cafe",
      payload: {
        actorId: "rook",
        linkId: "link-hs",
        fromZoneId: "zone-shop",
        toZoneId: "zone-hall",
        basis: "granted",
        observerActorIds: ["player"],
      },
    });
    const observations = deriveEventObservations(entered, fixtureSpace());
    // Iris shares the location but was not captured at either threshold.
    expect(witnesses(observations)).toEqual(["player", "rook"]);
  });

  it("splits engagement events by channel: co-present is embodied with bystander glimpses, remote is device-only", () => {
    const coPresent = event({
      type: "engagement_interrupted",
      actorIds: ["mara", "player"],
      locationId: "loc-cafe",
      payload: { engagementId: "engagement-1", interruptedAt: NOW, reason: "participant_departed" },
    });
    const seen = deriveEventObservations(coPresent, fixtureSpace());
    expect(witnesses(seen)).toEqual(["iris", "mara", "player"]);
    expect(seen.find((observation) => observation.witnessActorId === "iris")).toMatchObject({
      channel: "sight",
      detailTier: 1,
    });
    expect(seen.find((observation) => observation.witnessActorId === "mara")).toMatchObject({
      channel: "embodied",
      evidenceClass: "direct",
    });

    const remote = event({
      type: "engagement_ended",
      actorIds: ["mara", "rook"],
      payload: { engagementId: "engagement-2", endedAt: NOW, reason: "participant_choice" },
    });
    const heard = deriveEventObservations(remote, fixtureSpace());
    expect(witnesses(heard)).toEqual(["mara", "rook"]);
    for (const observation of heard) {
      expect(observation).toMatchObject({ channel: "device", evidenceClass: "direct", detailTier: 2 });
    }
  });

  it("lets a co-present speech act be overheard at the location, but never a remote one", () => {
    const spoken = event({
      type: "speech_act_delivered",
      actorIds: ["mara"],
      locationId: "loc-cafe",
      payload: {
        cutId: "cut-1",
        engagementId: "engagement-1",
        effectType: "promise_offered",
        actorId: "mara",
        targetActorIds: ["player"],
        detail: "I'll come back before close.",
      },
    });
    const observations = deriveEventObservations(spoken, fixtureSpace());
    expect(witnesses(observations)).toEqual(["iris", "mara", "player"]);
    expect(observations.find((observation) => observation.witnessActorId === "player")).toMatchObject({
      channel: "sound",
      evidenceClass: "direct",
      detailTier: 3,
    });
    expect(observations.find((observation) => observation.witnessActorId === "iris")).toMatchObject({
      channel: "sound",
      evidenceClass: "sensory",
      detailTier: 1,
    });

    const texted = event({
      type: "speech_act_delivered",
      actorIds: ["mara"],
      payload: {
        cutId: "cut-2",
        engagementId: "engagement-2",
        effectType: "question_asked",
        actorId: "mara",
        targetActorIds: ["rook"],
        detail: "Are you still open?",
      },
    });
    const texts = deriveEventObservations(texted, fixtureSpace());
    expect(witnesses(texts)).toEqual(["mara", "rook"]);
    for (const observation of texts) expect(observation.channel).toBe("device");
  });

  it("grades a disclosure: speaker direct, listeners social/reported, location-only overhearing", () => {
    const confided = event({
      type: "disclosure_made",
      actorIds: ["mara", "player"],
      locationId: "loc-cafe",
      derivationVersion: "knowledge-v1",
      payload: {
        speakerActorId: "mara",
        targetActorIds: ["player"],
        content: {
          kind: "claim",
          propositionKey: "quitting_job",
          subjectIds: ["mara"],
          claimedValue: { quitting: true },
        },
        derived: {
          assertionId: "assertion-1",
          sourceConfidenceFixedPoint: 10_000,
          learnedFromActorIds: ["mara"],
        },
      },
    });
    const observations = deriveEventObservations(confided, fixtureSpace());
    expect(witnesses(observations)).toEqual(["iris", "mara", "player"]);
    expect(observations.find((observation) => observation.witnessActorId === "mara")).toMatchObject({
      channel: "embodied",
      evidenceClass: "direct",
    });
    // The named listener holds the CONTENT — the reserved social/reported class.
    expect(observations.find((observation) => observation.witnessActorId === "player")).toMatchObject({
      channel: "social",
      evidenceClass: "reported",
      detailTier: 3,
    });
    // Iris hears talking through the wall, not the claim.
    expect(observations.find((observation) => observation.witnessActorId === "iris")).toMatchObject({
      channel: "sound",
      evidenceClass: "sensory",
      detailTier: 1,
    });

    const texted = event({
      type: "disclosure_made",
      actorIds: ["mara", "rook"],
      derivationVersion: "knowledge-v1",
      payload: {
        speakerActorId: "mara",
        targetActorIds: ["rook"],
        content: { kind: "relay", assertionId: "assertion-1" },
        derived: {
          assertionId: "assertion-1",
          sourceConfidenceFixedPoint: 9_000,
          learnedFromActorIds: ["player", "mara"],
        },
      },
    });
    const texts = deriveEventObservations(texted, fixtureSpace());
    expect(witnesses(texts)).toEqual(["mara", "rook"]);
    expect(texts.find((observation) => observation.witnessActorId === "rook")).toMatchObject({
      channel: "social",
      evidenceClass: "reported",
      detailTier: 2,
    });
  });

  it("gives storyteller relocation destination-zone glimpses only — no mechanism, no cross-zone sound", () => {
    const relocated = event({
      type: "storyteller_relocation",
      actorIds: ["wren"],
      locationId: "loc-cafe",
      payload: {
        actorId: "wren",
        fromZoneId: "zone-shop",
        toZoneId: "zone-hall",
        reason: "scene setup",
      },
    });
    const observations = deriveEventObservations(relocated, fixtureSpace());
    // Hall occupants glimpse the presence; the kitchen hears nothing.
    expect(witnesses(observations)).toEqual(["mara", "player", "wren"]);
    expect(observations.find((observation) => observation.witnessActorId === "player")).toMatchObject({
      channel: "sight",
      detailTier: 1,
    });
  });

  it("derives nothing for bookkeeping events", () => {
    const bookkeeping: SimulationBranchEvent[] = [
      event({
        type: "commitment_created",
        actorIds: ["mara"],
        derivationVersion: GATE3_ROUTE_VERSION,
        payload: {
          commitmentId: "commit-1",
          actorId: "mara",
          kind: "shift",
          destinationZoneId: "zone-shop",
          window: { latestArrival: NOW + 1_000 },
          priority: 100,
          flexibility: "firm",
          preparationSeconds: 0,
          reliabilityBufferSeconds: 0,
          noticeLeadSeconds: 300,
          derived: {
            latestDeparture: NOW + 700,
            noticeAt: NOW,
            decideBy: NOW + 400,
            actBy: NOW + 700,
            minimumRouteDurationSeconds: 300,
          },
          knowledgeSource: { kind: "authored" },
        },
      }),
      event({
        type: "pressure_raised",
        actorIds: ["mara"],
        payload: {
          pressureId: "pressure-1",
          commitmentId: "commit-1",
          actorId: "mara",
          noticeAt: NOW,
          decideBy: NOW + 400,
          actBy: NOW + 700,
          severity: "urgent",
        },
      }),
    ];
    for (const bookkeepingEvent of bookkeeping) {
      expect(deriveEventObservations(bookkeepingEvent, fixtureSpace())).toEqual([]);
    }
  });

  it("is deterministic: identical inputs mint identical rows and ids", () => {
    const departed = event({
      type: "actor_departed",
      actorIds: ["mara"],
      locationId: "loc-cafe",
      payload: { journeyId: "journey-m", fromZoneId: "zone-hall", linkId: "link-hs", departedAt: NOW },
    });
    const first = deriveEventObservations(departed, fixtureSpace());
    const second = deriveEventObservations(departed, fixtureSpace());
    expect(second).toEqual(first);
    expect(new Set(first.map((observation) => observation.id)).size).toBe(first.length);
  });
});

describe("E4.1 replayObservationsHistory", () => {
  it("grades each command against its group-final space and matches per-command derivation", () => {
    const seed = fixtureSpace({
      loci: [
        { kind: "at", actorId: "player", locationId: "loc-cafe", zoneId: "zone-hall", since: NOW },
        { kind: "at", actorId: "mara", locationId: "loc-cafe", zoneId: "zone-hall", since: NOW },
        { kind: "at", actorId: "iris", locationId: "loc-cafe", zoneId: "zone-kitchen", since: NOW },
        { kind: "at", actorId: "rook", locationId: "loc-shop", zoneId: "zone-shop", since: NOW },
      ],
    });
    const seedWithoutJourney = spaceProjectionSchema.parse({ ...seed, journeys: [] });
    const moveEvents = [
      event({
        sequence: 11,
        type: "journey_planned",
        commandId: "cmd-move",
        actorIds: ["mara"],
        payload: {
          journeyId: "journey-m",
          originZoneId: "zone-hall",
          destinationZoneId: "zone-shop",
          routeLinkIds: ["link-hs"],
          travelMode: "walk",
          earliestArrivalAt: NOW + 300,
          expectedArrivalAt: NOW + 300,
          routeDerivationVersion: GATE3_ROUTE_VERSION,
        },
      }),
      event({
        sequence: 12,
        type: "actor_departed",
        commandId: "cmd-move",
        actorIds: ["mara"],
        locationId: "loc-cafe",
        payload: { journeyId: "journey-m", fromZoneId: "zone-hall", linkId: "link-hs", departedAt: NOW },
      }),
    ];
    const arriveEvents = [
      event({
        sequence: 13,
        type: "actor_arrived",
        commandId: "cmd-arrive",
        actorIds: ["mara"],
        locationId: "loc-shop",
        storySecond: NOW + 300,
        payload: { journeyId: "journey-m", destinationZoneId: "zone-shop", arrivedAt: NOW + 300 },
      }),
    ];

    const replayed = replayObservationsHistory({
      spaceSeed: seedWithoutJourney,
      events: [...moveEvents, ...arriveEvents],
    });

    // Departure graded against post-move state: player sees, iris hears,
    // rook (other location) nothing; the planner's plan stays her own.
    const departureWitnesses = replayed.observations
      .filter((observation) => observation.sourceEventSequence === 12)
      .map((observation) => observation.witnessActorId);
    expect(departureWitnesses).toEqual(["iris", "mara", "player"]);
    const planWitnesses = replayed.observations
      .filter((observation) => observation.sourceEventSequence === 11)
      .map((observation) => observation.witnessActorId);
    expect(planWitnesses).toEqual(["mara"]);
    // Arrival graded against post-arrive state: only the shop notices.
    const arrivalWitnesses = replayed.observations
      .filter((observation) => observation.sourceEventSequence === 13)
      .map((observation) => observation.witnessActorId);
    expect(arrivalWitnesses).toEqual(["mara", "rook"]);

    // Replay equals the live rule: derive each command against its own
    // post-command space (what the live hook reads from the locus rows).
    const afterMove = replayObservationsHistory({ spaceSeed: seedWithoutJourney, events: moveEvents });
    const liveMove = deriveCommandObservations(moveEvents, afterMove.space);
    const afterArrive = replayObservationsHistory({ spaceSeed: afterMove.space, events: arriveEvents });
    const liveArrive = deriveCommandObservations(arriveEvents, afterArrive.space);
    expect(replayed.observations).toEqual([...liveMove, ...liveArrive]);
  });
});
