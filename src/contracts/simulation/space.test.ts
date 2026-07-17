import { describe, expect, it } from "vitest";
import {
  actorArrivedEventSchema,
  journeyDelayedEventSchema,
  journeySchema,
  linkSchema,
  moveActorCommandSchema,
  physicalLocusSchema,
  routeResultSchema,
  spaceProjectionSchema,
  zoneSchema,
  GATE3_ROUTE_VERSION,
} from "./space";

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: "link_1",
    fromZoneId: "zone_a",
    toZoneId: "zone_b",
    modes: ["drive", "walk"],
    minimumDurationSeconds: 600,
    accessPolicy: "public",
    state: "open",
    ...overrides,
  };
}

function route(overrides: Record<string, unknown> = {}) {
  return {
    originZoneId: "zone_a",
    destinationZoneId: "zone_b",
    linkIds: ["link_1", "link_2"],
    travelMode: "walk",
    minimumDurationSeconds: 600,
    expectedDurationSeconds: 780,
    uncertaintySeconds: 120,
    derivationVersion: GATE3_ROUTE_VERSION,
    ...overrides,
  };
}

function journey(overrides: Record<string, unknown> = {}) {
  return {
    id: "journey_1",
    actorIds: ["actor_1"],
    originZoneId: "zone_a",
    destinationZoneId: "zone_b",
    routeLinkIds: ["link_1", "link_2"],
    travelMode: "walk",
    earliestArrivalAt: 1_200,
    expectedArrivalAt: 1_380,
    status: "active",
    currentLinkIndex: 0,
    routeDerivationVersion: GATE3_ROUTE_VERSION,
    ...overrides,
  };
}

function moveActorCommand(payloadOverrides: Record<string, unknown> = {}) {
  return {
    id: "command_1",
    branchId: "branch_1",
    expectedVersion: 0,
    idempotencyKey: "move_key_1",
    principal: { kind: "player", principalId: "principal_1", controlledActorIds: ["actor_1"] },
    submittedAtWallClock: "2026-07-17T12:00:00.000Z",
    correlationId: "correlation_1",
    type: "move_actor",
    schemaVersion: 1,
    payload: { actorId: "actor_1", destinationZoneId: "zone_b", travelMode: "walk", ...payloadOverrides },
  };
}

describe("E3.1 topology contracts", () => {
  it("accepts a well-formed link and enforces sorted-unique modes", () => {
    expect(linkSchema.parse(link()).modes).toEqual(["drive", "walk"]);
    expect(() => linkSchema.parse(link({ modes: ["walk", "drive"] }))).toThrow(/sorted/u);
    expect(() => linkSchema.parse(link({ modes: ["walk", "walk"] }))).toThrow(/unique/u);
  });

  it("rejects a link that connects a zone to itself", () => {
    expect(() => linkSchema.parse(link({ toZoneId: "zone_a" }))).toThrow(/itself/u);
  });

  it("rejects a link with a non-positive minimum duration", () => {
    expect(() => linkSchema.parse(link({ minimumDurationSeconds: 0 }))).toThrow();
  });

  it("rejects a zone that is its own parent", () => {
    const base = { id: "zone_a", locationId: "loc_1", kind: "room", privacyPolicy: "private" };
    expect(zoneSchema.parse(base).privacyPolicy).toBe("private");
    expect(() => zoneSchema.parse({ ...base, parentZoneId: "zone_a" })).toThrow(/own parent/u);
  });
});

describe("E3.1 physical locus", () => {
  it("accepts an at-locus and a transit-locus", () => {
    const at = physicalLocusSchema.parse({
      kind: "at",
      actorId: "actor_1",
      locationId: "loc_1",
      zoneId: "zone_a",
      since: 100,
    });
    expect(at.kind).toBe("at");
    const transit = physicalLocusSchema.parse({
      kind: "in_transit",
      actorId: "actor_1",
      journeyId: "journey_1",
      linkId: "link_1",
      enteredAt: 100,
      earliestExitAt: 700,
    });
    expect(transit.kind).toBe("in_transit");
  });

  it("rejects a transit locus that exits before it is entered", () => {
    expect(() =>
      physicalLocusSchema.parse({
        kind: "in_transit",
        actorId: "actor_1",
        journeyId: "journey_1",
        linkId: "link_1",
        enteredAt: 700,
        earliestExitAt: 100,
      }),
    ).toThrow(/exit before/u);
  });
});

describe("E3.1 route planning", () => {
  it("accepts a route with expected >= minimum duration", () => {
    expect(routeResultSchema.parse(route()).linkIds).toEqual(["link_1", "link_2"]);
  });

  it("preserves route link order rather than sorting it", () => {
    expect(routeResultSchema.parse(route({ linkIds: ["link_2", "link_1"] })).linkIds).toEqual([
      "link_2",
      "link_1",
    ]);
  });

  it("rejects a route whose expected duration precedes the lower bound", () => {
    expect(() => routeResultSchema.parse(route({ expectedDurationSeconds: 300 }))).toThrow(
      /lower-bound/u,
    );
  });

  it("rejects a route between identical zones and duplicate links", () => {
    expect(() => routeResultSchema.parse(route({ destinationZoneId: "zone_a" }))).toThrow(
      /distinct zones/u,
    );
    expect(() => routeResultSchema.parse(route({ linkIds: ["link_1", "link_1"] }))).toThrow(
      /unique/u,
    );
  });
});

describe("E3.1 journey", () => {
  it("accepts an active journey and keeps currentLinkIndex inside the route", () => {
    expect(journeySchema.parse(journey()).status).toBe("active");
    expect(() => journeySchema.parse(journey({ currentLinkIndex: 2 }))).toThrow(/inside the route/u);
  });

  it("rejects expected arrival before the earliest arrival", () => {
    expect(() => journeySchema.parse(journey({ expectedArrivalAt: 1_000 }))).toThrow(
      /lower-bound/u,
    );
  });
});

describe("E3.1 movement commands and events", () => {
  it("validates a MoveActor command envelope", () => {
    const parsed = moveActorCommandSchema.parse(moveActorCommand());
    expect(parsed.type).toBe("move_actor");
    expect(parsed.payload.destinationZoneId).toBe("zone_b");
  });

  it("rejects an unknown travel mode on a MoveActor command", () => {
    expect(() => moveActorCommandSchema.parse(moveActorCommand({ travelMode: "teleport" }))).toThrow();
  });

  it("requires a delay to push the expected arrival later", () => {
    const base = {
      id: "event_1",
      worldId: "world_1",
      branchId: "branch_1",
      sequence: 5,
      storySecond: 1_300,
      rulesetVersion: "ruleset_1",
      correlationId: "correlation_1",
      actorIds: ["actor_1"],
      entityIds: ["journey_1"],
      recordedAtWallClock: "2026-07-17T12:00:00.000Z",
      type: "journey_delayed",
      schemaVersion: 1,
    };
    expect(
      journeyDelayedEventSchema.parse({
        ...base,
        payload: {
          journeyId: "journey_1",
          previousExpectedArrivalAt: 1_380,
          newExpectedArrivalAt: 1_620,
          reason: "hazard",
        },
      }).payload.reason,
    ).toBe("hazard");
    expect(() =>
      journeyDelayedEventSchema.parse({
        ...base,
        payload: {
          journeyId: "journey_1",
          previousExpectedArrivalAt: 1_380,
          newExpectedArrivalAt: 1_200,
          reason: "hazard",
        },
      }),
    ).toThrow(/later/u);
  });

  it("validates an actor-arrived event", () => {
    const parsed = actorArrivedEventSchema.parse({
      id: "event_2",
      worldId: "world_1",
      branchId: "branch_1",
      sequence: 6,
      storySecond: 1_400,
      rulesetVersion: "ruleset_1",
      correlationId: "correlation_1",
      actorIds: ["actor_1"],
      entityIds: ["journey_1"],
      recordedAtWallClock: "2026-07-17T12:00:00.000Z",
      type: "actor_arrived",
      schemaVersion: 1,
      payload: { journeyId: "journey_1", destinationZoneId: "zone_b", arrivedAt: 1_400 },
    });
    expect(parsed.payload.destinationZoneId).toBe("zone_b");
  });
});

describe("E3.1 space projection", () => {
  it("validates a minimal populated projection", () => {
    const projection = spaceProjectionSchema.parse({
      worldId: "world_1",
      branchId: "branch_1",
      rulesetVersion: "ruleset_1",
      version: 3,
      headSequence: 6,
      storySecond: 1_400,
      locations: [{ id: "loc_1", worldId: "world_1", kind: "home", defaultAccessPolicy: "private" }],
      zones: [
        { id: "zone_a", locationId: "loc_1", kind: "room", privacyPolicy: "private" },
        { id: "zone_b", locationId: "loc_1", kind: "kitchen", privacyPolicy: "semi_private" },
      ],
      links: [link()],
      loci: [{ kind: "at", actorId: "actor_1", locationId: "loc_1", zoneId: "zone_a", since: 100 }],
      journeys: [],
    });
    expect(projection.zones).toHaveLength(2);
  });
});
