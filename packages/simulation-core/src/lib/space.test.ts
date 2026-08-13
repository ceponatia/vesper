import { describe, expect, it } from "vitest";
import type { SimulationBranchEvent } from "../contracts/branching";
import {
  arriveJourneyCommandSchema,
  moveActorCommandSchema,
  spaceProjectionSchema,
  type SpaceProjection,
} from "../contracts/space";
import { walkTopology } from "../test-support/sim-space-fixtures";
import {
  commandEnvelope,
  simMeta,
  testPrincipal,
  TEST_BRANCH_ID,
  TEST_RULESET_VERSION,
  TEST_WORLD_ID,
  type CommandEnvelopeSpec,
} from "../test-support/sim-envelopes";
import { simulationHash } from "./hash";
import {
  applySpaceEvent,
  deriveJourneyId,
  journeyArrivalUniquenessKey,
  planRoute,
  replaySpaceHistory,
  resolveJourneyArrival,
  resolveMoveActor,
  spaceSeedForReplay,
  type SpaceTopology,
} from "./space";

const SEED_SECOND = 100;

/** The shared walk topology widened to four zones and four links this suite routes over. */
function topology(): SpaceTopology {
  return walkTopology({
    locations: [
      { id: "loc-home", worldId: TEST_WORLD_ID, kind: "home", defaultAccessPolicy: "private" },
      { id: "loc-cafe", worldId: TEST_WORLD_ID, kind: "cafe", defaultAccessPolicy: "public" },
    ],
    zones: [
      { id: "zone-a", locationId: "loc-home", kind: "room", privacyPolicy: "private" },
      { id: "zone-b", locationId: "loc-cafe", kind: "hall", privacyPolicy: "public" },
      { id: "zone-c", locationId: "loc-cafe", kind: "terrace", privacyPolicy: "public" },
      { id: "zone-island", locationId: "loc-cafe", kind: "cellar", privacyPolicy: "private" },
    ],
    links: [
      {
        id: "link-ab",
        fromZoneId: "zone-a",
        toZoneId: "zone-b",
        modes: ["drive", "walk"],
        minimumDurationSeconds: 600,
        accessPolicy: "public",
        state: "open",
      },
      {
        id: "link-bc",
        fromZoneId: "zone-b",
        toZoneId: "zone-c",
        modes: ["walk"],
        minimumDurationSeconds: 300,
        accessPolicy: "public",
        state: "open",
      },
      {
        id: "link-ac-private",
        fromZoneId: "zone-a",
        toZoneId: "zone-c",
        modes: ["walk"],
        minimumDurationSeconds: 500,
        accessPolicy: "private",
        state: "open",
      },
      {
        id: "link-ac-drive",
        fromZoneId: "zone-a",
        toZoneId: "zone-c",
        modes: ["drive"],
        minimumDurationSeconds: 2_000,
        accessPolicy: "public",
        state: "open",
      },
    ],
  });
}

function seedProjection(): SpaceProjection {
  const shape = topology();
  return spaceProjectionSchema.parse({
    worldId: TEST_WORLD_ID,
    branchId: TEST_BRANCH_ID,
    rulesetVersion: TEST_RULESET_VERSION,
    version: 0,
    headSequence: 0,
    storySecond: SEED_SECOND,
    locations: shape.locations,
    zones: shape.zones,
    links: shape.links,
    loci: [
      { kind: "at", actorId: "actor-1", locationId: "loc-home", zoneId: "zone-a", since: SEED_SECOND },
    ],
    journeys: [],
  });
}

function moveView(overrides: Record<string, unknown> = {}) {
  const projection = seedProjection();
  return {
    ...simMeta({ storySecond: SEED_SECOND }),
    version: projection.version,
    topology: { locations: projection.locations, zones: projection.zones, links: projection.links },
    actorExists: true,
    locus: projection.loci[0],
    ...overrides,
  };
}

function moveCommand(payloadOverrides: Record<string, unknown> = {}, spec: Partial<CommandEnvelopeSpec> = {}) {
  return commandEnvelope(moveActorCommandSchema, {
    type: "move_actor",
    idSlug: "move-1",
    principal: testPrincipal("player", ["actor-1"]),
    payload: { actorId: "actor-1", destinationZoneId: "zone-c", travelMode: "walk", ...payloadOverrides },
    ...spec,
  });
}

describe("E3.1 planRoute", () => {
  it("prefers the lowest total duration, not the fewest hops", () => {
    const plan = planRoute(topology(), { originZoneId: "zone-a", destinationZoneId: "zone-c", travelMode: "walk" });
    if (!plan.ok) throw new Error("expected a route");
    // The one-hop private link (500) is inaccessible; two public hops win.
    expect(plan.route.linkIds).toEqual(["link-ab", "link-bc"]);
    expect(plan.route.minimumDurationSeconds).toBe(900);
    expect(plan.route.expectedDurationSeconds).toBe(900);
  });

  it("traverses links in either direction", () => {
    const plan = planRoute(topology(), { originZoneId: "zone-c", destinationZoneId: "zone-a", travelMode: "walk" });
    if (!plan.ok) throw new Error("expected a route");
    expect(plan.route.linkIds).toEqual(["link-bc", "link-ab"]);
  });

  it("breaks equal-duration ties by lexicographic link path", () => {
    const shape = topology();
    const withTwin: SpaceTopology = {
      ...shape,
      links: [
        ...shape.links,
        {
          ...shape.links[0],
          id: "link-aa-twin",
        } as SpaceTopology["links"][number],
      ],
    };
    const plan = planRoute(withTwin, { originZoneId: "zone-a", destinationZoneId: "zone-b", travelMode: "walk" });
    if (!plan.ok) throw new Error("expected a route");
    expect(plan.route.linkIds).toEqual(["link-aa-twin"]);
  });

  it("names the binding restriction when no legal route exists", () => {
    expect(
      planRoute(topology(), { originZoneId: "zone-a", destinationZoneId: "zone-island", travelMode: "walk" }),
    ).toEqual({ ok: false, reason: "no_route" });
    expect(
      planRoute(topology(), { originZoneId: "zone-a", destinationZoneId: "zone-c", travelMode: "cycle" }),
    ).toEqual({ ok: false, reason: "travel_mode_unavailable" });
    const shape = topology();
    const privateOnly: SpaceTopology = {
      ...shape,
      links: shape.links.filter((link) => link.id === "link-ac-private"),
    };
    expect(
      planRoute(privateOnly, { originZoneId: "zone-a", destinationZoneId: "zone-c", travelMode: "walk" }),
    ).toEqual({ ok: false, reason: "route_access_denied" });
  });

  it("treats a non-open link as impassable in every diagnosis pass", () => {
    const shape = topology();
    const blockedOnly: SpaceTopology = {
      ...shape,
      links: shape.links
        .filter((link) => link.id === "link-bc")
        .map((link) => ({ ...link, state: "blocked" as const })),
    };
    // State is never relaxed — a blocked link is not an access problem.
    expect(
      planRoute(blockedOnly, { originZoneId: "zone-b", destinationZoneId: "zone-c", travelMode: "walk" }),
    ).toEqual({ ok: false, reason: "no_route" });
  });
});

describe("E3.1 resolveMoveActor", () => {
  it("resolves a legal move into planned + departed + arrival-trigger events", () => {
    const resolution = resolveMoveActor(moveView() as never, moveCommand() as never);
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    const [planned, departed, trigger] = resolution.events;
    expect([planned.sequence, departed.sequence, trigger.sequence]).toEqual([1, 2, 3]);
    expect(departed.causationId).toBe(planned.id);
    expect(trigger.causationId).toBe(departed.id);
    expect(planned.payload.routeLinkIds).toEqual(["link-ab", "link-bc"]);
    expect(planned.payload.earliestArrivalAt).toBe(SEED_SECOND + 900);
    expect(trigger.payload.kind).toBe("journey_arrival_due");
    expect(trigger.payload.dueStorySecond).toBe(SEED_SECOND + 900);
    const journeyId = deriveJourneyId(TEST_BRANCH_ID, "cmd-move-1");
    expect(resolution.journey.id).toBe(journeyId);
    expect(trigger.payload.uniquenessKey).toBe(journeyArrivalUniquenessKey(journeyId));
    expect(trigger.payload.command.type).toBe("arrive_journey");
    expect(resolution.journey.status).toBe("active");
    expect(resolution.locus.kind).toBe("in_transit");
    if (resolution.locus.kind === "in_transit") {
      expect(resolution.locus.linkId).toBe("link-ab");
      expect(resolution.locus.earliestExitAt).toBe(SEED_SECOND + 600);
    }
  });

  it("is deterministic: identical inputs produce identical events", () => {
    const first = resolveMoveActor(moveView() as never, moveCommand() as never);
    const second = resolveMoveActor(moveView() as never, moveCommand() as never);
    expect(simulationHash(first)).toBe(simulationHash(second));
  });

  it("rejects the movement failure taxonomy", () => {
    const uncontrolled = moveCommand({}, { principal: testPrincipal("player", ["actor-2"]) });
    const cases: [unknown, unknown, string][] = [
      [moveView({ actorExists: false }), moveCommand(), "actor_not_found"],
      [moveView(), uncontrolled, "unauthorized_actor"],
      [moveView(), moveCommand({ destinationZoneId: "zone-nowhere" }), "destination_not_found"],
      [moveView(), moveCommand({ destinationZoneId: "zone-a" }), "already_at_destination"],
      [moveView(), moveCommand({ destinationZoneId: "zone-island" }), "no_route"],
      [moveView(), moveCommand({ travelMode: "cycle" }), "travel_mode_unavailable"],
    ];
    for (const [view, command, code] of cases) {
      const resolution = resolveMoveActor(view as never, command as never);
      expect(resolution.ok, code).toBe(false);
      if (!resolution.ok) expect(resolution.code).toBe(code);
    }
  });

  it("rejects a second move while in transit", () => {
    const transitLocus = {
      kind: "in_transit",
      actorId: "actor-1",
      journeyId: deriveJourneyId(TEST_BRANCH_ID, "cmd-earlier"),
      linkId: "link-ab",
      enteredAt: SEED_SECOND,
      earliestExitAt: SEED_SECOND + 600,
    };
    const resolution = resolveMoveActor(moveView({ locus: transitLocus }) as never, moveCommand() as never);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("actor_in_transit");
  });
});

function acceptedMove() {
  const resolution = resolveMoveActor(moveView() as never, moveCommand() as never);
  if (!resolution.ok) throw new Error("fixture move must resolve");
  return resolution;
}

function arriveCommand(spec: Partial<CommandEnvelopeSpec> = {}) {
  return commandEnvelope(arriveJourneyCommandSchema, {
    type: "arrive_journey",
    idSlug: "arrive-1",
    expectedVersion: 1,
    // The scheduler fires the arrival — a system principal, deliberately not the
    // suite default (an arrival submitted by a player is the rejection below).
    principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] },
    payload: { journeyId: deriveJourneyId(TEST_BRANCH_ID, "cmd-move-1") },
    ...spec,
  });
}

function arrivalView(overrides: Record<string, unknown> = {}) {
  const move = acceptedMove();
  const projection = seedProjection();
  return {
    ...simMeta({ headSequence: 3, storySecond: SEED_SECOND + 900 }),
    version: 1,
    topology: { locations: projection.locations, zones: projection.zones, links: projection.links },
    journey: move.journey,
    ...overrides,
  };
}

describe("E3.1 resolveJourneyArrival", () => {
  it("arrives an active journey and flips every traveller to the destination", () => {
    const resolution = resolveJourneyArrival(arrivalView() as never, arriveCommand() as never);
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.event.payload.arrivedAt).toBe(SEED_SECOND + 900);
    expect(resolution.event.locationId).toBe("loc-cafe");
    expect(resolution.journey.status).toBe("arrived");
    expect(resolution.loci).toEqual([
      { kind: "at", actorId: "actor-1", locationId: "loc-cafe", zoneId: "zone-c", since: SEED_SECOND + 900 },
    ]);
  });

  it("re-validates at fire time instead of trusting the schedule", () => {
    const arrived = { ...acceptedMove().journey, status: "arrived" as const, currentLinkIndex: 1 };
    const stale = resolveJourneyArrival(arrivalView({ journey: arrived }) as never, arriveCommand() as never);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("journey_not_active");

    const missing = resolveJourneyArrival(arrivalView({ journey: undefined }) as never, arriveCommand() as never);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("journey_not_found");

    const player = resolveJourneyArrival(
      arrivalView() as never,
      arriveCommand({ principal: testPrincipal("player", ["actor-1"]) }) as never,
    );
    expect(player.ok).toBe(false);
    if (!player.ok) expect(player.code).toBe("unauthorized_principal");
  });

  it("treats firing before the lower-bound arrival as corruption", () => {
    expect(() =>
      resolveJourneyArrival(arrivalView({ storySecond: SEED_SECOND + 899 }) as never, arriveCommand() as never),
    ).toThrow(/lower bound/u);
  });
});

describe("E3.1 space replay", () => {
  function journeyEvents(): SimulationBranchEvent[] {
    const move = acceptedMove();
    const arrival = resolveJourneyArrival(arrivalView() as never, arriveCommand() as never);
    if (!arrival.ok) throw new Error("fixture arrival must resolve");
    const arrivedEvent = { ...arrival.event, sequence: 4 };
    return [...move.events, arrivedEvent] as SimulationBranchEvent[];
  }

  it("folds the full stream back to the live outcome", () => {
    const replayed = replaySpaceHistory({ seed: seedProjection(), events: journeyEvents() });
    expect(replayed.headSequence).toBe(4);
    // Two distinct accepted commands: the move and the arrival.
    expect(replayed.version).toBe(2);
    expect(replayed.journeys).toHaveLength(1);
    expect(replayed.journeys[0]?.status).toBe("arrived");
    expect(replayed.loci).toEqual([
      { kind: "at", actorId: "actor-1", locationId: "loc-cafe", zoneId: "zone-c", since: SEED_SECOND + 900 },
    ]);
  });

  it("matches an event-at-a-time fold (partition invariance of application)", () => {
    const events = journeyEvents();
    const wholesale = replaySpaceHistory({ seed: seedProjection(), events });
    let stepwise = seedProjection();
    for (const event of events) stepwise = applySpaceEvent(stepwise, event);
    expect(simulationHash({ ...wholesale, version: 0 })).toBe(simulationHash({ ...stepwise, version: 0 }));
  });

  it("rejects a sequence gap", () => {
    const events = journeyEvents().filter((event) => event.sequence !== 2);
    expect(() => replaySpaceHistory({ seed: seedProjection(), events })).toThrow(/sequence gap/u);
  });

  it("reverse-derives the origin seed from current state and history", () => {
    const events = journeyEvents();
    const current = replaySpaceHistory({ seed: seedProjection(), events });
    const seed = spaceSeedForReplay({
      branchId: TEST_BRANCH_ID,
      current,
      events,
      originStorySecond: SEED_SECOND,
    });
    expect(seed.journeys).toEqual([]);
    expect(seed.loci).toEqual([
      { kind: "at", actorId: "actor-1", locationId: "loc-home", zoneId: "zone-a", since: SEED_SECOND },
    ]);
    expect(simulationHash(replaySpaceHistory({ seed, events }))).toBe(simulationHash(current));
  });
});
