import { describe, expect, it } from "vitest";
import { simulationBranchEventSchema, type SimulationBranchEvent } from "@/contracts/simulation/branching";
import { engagementSchema, type Engagement } from "@/contracts/simulation/engagements";
import { spaceProjectionSchema, type SpaceProjection } from "@/contracts/simulation/space";
import { temporalPressureSchema } from "@/contracts/simulation/commitments";
import { compileGate3Cut, decideDepartures } from "./narrative";
import { deriveCommandObservations } from "./perception";

const NOW = 100_000;

function pressure(actorId: string, actBy: number, commitmentId = `commit-${actorId}`) {
  return {
    ...temporalPressureSchema.parse({
      id: `pressure-${commitmentId}`,
      actorId,
      sourceCommitmentId: commitmentId,
      noticeAt: NOW,
      decideBy: actBy,
      actBy,
      severity: "urgent",
    }),
    destinationZoneId: "zone-shop",
  };
}

describe("E3.4 decideDepartures", () => {
  it("departs inside the horizon, defers on a stay request, and spares player actors", () => {
    const base = {
      turnEndSecond: NOW + 400,
      horizonSeconds: 1_000,
      stayRequestedActorIds: [] as string[],
      policyControlledActorIds: ["mara"],
    };
    expect(decideDepartures({ ...base, pressures: [pressure("mara", NOW + 1_200)] })).toHaveLength(1);
    // Asked to stay: only a boundary inside the turn itself forces departure.
    expect(
      decideDepartures({ ...base, stayRequestedActorIds: ["mara"], pressures: [pressure("mara", NOW + 1_200)] }),
    ).toHaveLength(0);
    expect(
      decideDepartures({ ...base, stayRequestedActorIds: ["mara"], pressures: [pressure("mara", NOW + 300)] }),
    ).toHaveLength(1);
    // The player's own actor is never policy-moved.
    expect(
      decideDepartures({ ...base, policyControlledActorIds: [], pressures: [pressure("mara", NOW + 100)] }),
    ).toHaveLength(0);
  });

  it("takes the earliest boundary per actor, deterministically", () => {
    const departures = decideDepartures({
      pressures: [pressure("mara", NOW + 900, "commit-b"), pressure("mara", NOW + 500, "commit-a")],
      turnEndSecond: NOW + 400,
      horizonSeconds: 1_000,
      stayRequestedActorIds: [],
      policyControlledActorIds: ["mara"],
    });
    expect(departures).toHaveLength(1);
    expect(departures[0]?.commitmentId).toBe("commit-a");
  });
});

function fixtureSpace(): SpaceProjection {
  return spaceProjectionSchema.parse({
    worldId: "world-1",
    branchId: "branch-1",
    rulesetVersion: "gate3-test-v1",
    version: 4,
    headSequence: 6,
    storySecond: NOW + 400,
    locations: [{ id: "loc-cafe", worldId: "world-1", kind: "cafe", defaultAccessPolicy: "public" }],
    zones: [
      { id: "zone-cafe", locationId: "loc-cafe", kind: "hall", privacyPolicy: "public" },
      { id: "zone-shop", locationId: "loc-cafe", kind: "shop", privacyPolicy: "public" },
    ],
    links: [
      {
        id: "link-cs",
        fromZoneId: "zone-cafe",
        toZoneId: "zone-shop",
        modes: ["walk"],
        minimumDurationSeconds: 300,
        accessPolicy: "public",
        state: "open",
      },
    ],
    loci: [
      { kind: "at", actorId: "player", locationId: "loc-cafe", zoneId: "zone-cafe", since: NOW },
      {
        kind: "in_transit",
        actorId: "mara",
        journeyId: "journey-1",
        linkId: "link-cs",
        enteredAt: NOW + 300,
        earliestExitAt: NOW + 600,
      },
    ],
    journeys: [],
  });
}

function fixtureEngagement(): Engagement {
  return engagementSchema.parse({
    id: "engagement-1",
    participantIds: ["mara", "player"],
    channel: "co_present",
    locationId: "loc-cafe",
    zoneId: "zone-cafe",
    state: "interrupted",
    openedAt: NOW,
    attentionClaim: { kind: "attention", weight: "full" },
    sourceCommandId: "cmd-open",
  });
}

function departureEvent(sequence: number): SimulationBranchEvent {
  return simulationBranchEventSchema.parse({
    id: `event-departed-${sequence}`,
    worldId: "world-1",
    branchId: "branch-1",
    sequence,
    storySecond: NOW + 300,
    type: "actor_departed",
    schemaVersion: 1,
    rulesetVersion: "gate3-test-v1",
    commandId: "cmd-move",
    correlationId: "corr-1",
    actorIds: ["mara"],
    entityIds: ["journey-1"],
    locationId: "loc-cafe",
    recordedAtWallClock: "2026-07-17T12:00:00.000Z",
    payload: { journeyId: "journey-1", fromZoneId: "zone-cafe", linkId: "link-cs", departedAt: NOW + 300 },
  });
}

function commitmentEvent(sequence: number): SimulationBranchEvent {
  return simulationBranchEventSchema.parse({
    id: `event-missed-${sequence}`,
    worldId: "world-1",
    branchId: "branch-1",
    sequence,
    storySecond: NOW + 350,
    type: "commitment_missed",
    schemaVersion: 1,
    rulesetVersion: "gate3-test-v1",
    commandId: "cmd-deadline",
    correlationId: "corr-1",
    actorIds: ["mara"],
    entityIds: ["commit-mara"],
    recordedAtWallClock: "2026-07-17T12:00:00.000Z",
    payload: {
      commitmentId: "commit-mara",
      actorId: "mara",
      resolvedAt: NOW + 350,
      evaluation: { basis: "absent" },
    },
  });
}

function compile(overrides: Record<string, unknown> = {}) {
  const events = [departureEvent(5), commitmentEvent(6)];
  return compileGate3Cut({
    branchVersion: 4,
    engagement: fixtureEngagement(),
    viewpointActorId: "player",
    events,
    fromSequence: 4,
    throughSequence: 6,
    fromStorySecond: NOW,
    throughStorySecond: NOW + 400,
    space: fixtureSpace(),
    // What the viewpoint perceived comes from the E4.1 rule table, exactly
    // as the live turn seam feeds the compiler from the observation log.
    viewpointObservations: deriveCommandObservations(events, fixtureSpace()),
    viewpointPressures: [],
    proposedArmedEffects: [],
    ...overrides,
  });
}

describe("E3.4 compileGate3Cut", () => {
  it("shows the observable departure and hides the private commitment outcome", () => {
    const cut = compile();
    expect(cut.mustEnact.map((beat) => beat.kind)).toEqual(["actor_departed"]);
    // Privacy by omission: another actor's obligations never appear as facts.
    expect(JSON.stringify(cut)).not.toContain("commit-mara");
    expect(cut.relevantPressures).toEqual([]);
    // Perspective-safe loci: the viewpoint plus co-located actors only.
    expect(cut.currentLoci.map((locus) => locus.actorId)).toEqual(["player"]);
  });

  it("rerenders identically: same inputs, same id, same semantic hash (ruling 8)", () => {
    const first = compile();
    const second = compile();
    expect(second.id).toBe(first.id);
    expect(second.semanticHash).toBe(first.semanticHash);
    expect(second).toEqual(first);
  });

  it("arms only effects whose actors and targets are participants", () => {
    const cut = compile({
      proposedArmedEffects: [
        { effectType: "apology_delivered", actorId: "mara", targetActorIds: ["player"], detail: "sorry for leaving" },
        { effectType: "promise_offered", actorId: "stranger", targetActorIds: ["player"], detail: "never armed" },
        { effectType: "question_asked", actorId: "player", targetActorIds: ["stranger"], detail: "never armed" },
      ],
    });
    expect(cut.armedEffects).toHaveLength(1);
    expect(cut.armedEffects[0]?.effectType).toBe("apology_delivered");
    expect(cut.armedEffects[0]?.cutId).toBe(cut.id);
  });

  it("keeps the viewpoint's own pressures and drops resolved ones", () => {
    const cut = compile({
      viewpointPressures: [
        temporalPressureSchema.parse({
          id: "pressure-own",
          actorId: "player",
          sourceCommitmentId: "commit-player",
          noticeAt: NOW,
          decideBy: NOW + 900,
          actBy: NOW + 900,
          severity: "salient",
        }),
        temporalPressureSchema.parse({
          id: "pressure-done",
          actorId: "player",
          sourceCommitmentId: "commit-done",
          noticeAt: NOW,
          decideBy: NOW + 100,
          actBy: NOW + 100,
          severity: "hard",
          resolvedAt: NOW + 100,
        }),
      ],
    });
    expect(cut.relevantPressures).toEqual([
      { commitmentId: "commit-player", severity: "salient", actBy: NOW + 900 },
    ]);
  });
});
