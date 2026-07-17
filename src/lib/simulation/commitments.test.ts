import { describe, expect, it } from "vitest";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import {
  deriveCommitmentTimes,
  derivePressureSeverity,
} from "@/contracts/simulation/commitments";
import { simulationHash } from "./item-transfer";
import {
  applyCommitmentEvent,
  commitmentDeadlineUniquenessKey,
  commitmentNoticeUniquenessKey,
  deriveCommitmentId,
  emptyCommitmentsSeed,
  replayCommitmentsHistory,
  resolveCommitmentDeadline,
  resolveCreateCommitment,
  resolveRaisePressure,
} from "./commitments";
import type { SpaceTopology } from "./space";

const NOW = 30_000;
const SHIFT_AT = 40_000; // latest arrival
const WALK_AB = 600;

function topology(): SpaceTopology {
  return {
    locations: [{ id: "loc-1", worldId: "world-1", kind: "town", defaultAccessPolicy: "public" }],
    zones: [
      { id: "zone-home", locationId: "loc-1", kind: "room", privacyPolicy: "private" },
      { id: "zone-work", locationId: "loc-1", kind: "shop", privacyPolicy: "public" },
    ],
    links: [
      {
        id: "link-hw",
        fromZoneId: "zone-home",
        toZoneId: "zone-work",
        modes: ["walk"],
        minimumDurationSeconds: WALK_AB,
        accessPolicy: "public",
        state: "open",
      },
    ],
  } as unknown as SpaceTopology;
}

function createView(overrides: Record<string, unknown> = {}) {
  return {
    worldId: "world-1",
    branchId: "branch-1",
    rulesetVersion: "gate3-test-v1",
    headSequence: 0,
    storySecond: NOW,
    actorExists: true,
    originZoneId: "zone-home",
    destinationZoneExists: true,
    topology: topology(),
    ...overrides,
  };
}

function createCommand(overrides: Record<string, unknown> = {}, payloadOverrides: Record<string, unknown> = {}) {
  return {
    id: "cmd-commit-1",
    branchId: "branch-1",
    expectedVersion: 0,
    idempotencyKey: "commit-key-1",
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: ["actor-1"] },
    submittedAtWallClock: "2026-07-17T12:00:00.000Z",
    correlationId: "corr-1",
    type: "create_commitment",
    schemaVersion: 1,
    payload: {
      actorId: "actor-1",
      kind: "shift",
      destinationZoneId: "zone-work",
      window: { latestArrival: SHIFT_AT },
      priority: 10,
      flexibility: "firm",
      preparationSeconds: 300,
      reliabilityBufferSeconds: 120,
      noticeLeadSeconds: 3_600,
      knowledgeSource: { kind: "authored" },
      ...payloadOverrides,
    },
    ...overrides,
  };
}

describe("E3.3 derivation math", () => {
  it("derives §15.2 times and clamps a too-tight window at zero", () => {
    const times = deriveCommitmentTimes({
      latestArrival: SHIFT_AT,
      minimumRouteDurationSeconds: WALK_AB,
      preparationSeconds: 300,
      reliabilityBufferSeconds: 120,
      noticeLeadSeconds: 3_600,
    });
    expect(times.latestDeparture).toBe(SHIFT_AT - WALK_AB - 300 - 120);
    expect(times.actBy).toBe(times.latestDeparture);
    expect(times.noticeAt).toBe(times.latestDeparture - 3_600);

    const tight = deriveCommitmentTimes({
      latestArrival: 100,
      minimumRouteDurationSeconds: 500,
      preparationSeconds: 0,
      reliabilityBufferSeconds: 0,
      noticeLeadSeconds: 50,
    });
    expect(tight.latestDeparture).toBe(0);
    expect(tight.noticeAt).toBe(0);
  });

  it("maps flexibility to severity deterministically", () => {
    expect(derivePressureSeverity("hard")).toBe("hard");
    expect(derivePressureSeverity("firm")).toBe("urgent");
    expect(derivePressureSeverity("negotiable")).toBe("salient");
    expect(derivePressureSeverity("soft")).toBe("background");
  });
});

describe("E3.3 resolveCreateCommitment", () => {
  it("creates the commitment with notice and deadline triggers", () => {
    const resolution = resolveCreateCommitment(createView() as never, createCommand() as never);
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    const [created, notice, deadline] = resolution.events;
    expect([created.sequence, notice.sequence, deadline.sequence]).toEqual([1, 2, 3]);
    const commitmentId = deriveCommitmentId("branch-1", "cmd-commit-1");
    expect(created.payload.derived.minimumRouteDurationSeconds).toBe(WALK_AB);
    expect(created.payload.derived.latestDeparture).toBe(SHIFT_AT - WALK_AB - 300 - 120);
    expect(notice.payload.kind).toBe("commitment_notice_due");
    expect(notice.payload.dueStorySecond).toBe(SHIFT_AT - WALK_AB - 300 - 120 - 3_600);
    expect(notice.payload.uniquenessKey).toBe(commitmentNoticeUniquenessKey(commitmentId));
    expect(deadline.payload.kind).toBe("commitment_deadline_due");
    expect(deadline.payload.dueStorySecond).toBe(SHIFT_AT);
    expect(deadline.payload.uniquenessKey).toBe(commitmentDeadlineUniquenessKey(commitmentId));
    expect(resolution.commitment.status).toBe("planned");
  });

  it("clamps an already-due notice to the current second", () => {
    const resolution = resolveCreateCommitment(
      createView() as never,
      createCommand({}, { noticeLeadSeconds: 50_000 }) as never,
    );
    if (!resolution.ok) throw new Error("expected acceptance");
    expect(resolution.events[1].payload.dueStorySecond).toBe(NOW);
  });

  it("lets a director commit an uncontrolled actor but not a player", () => {
    const director = createCommand({
      principal: { kind: "director", principalId: "director-1", controlledActorIds: [] },
    });
    expect(resolveCreateCommitment(createView() as never, director as never).ok).toBe(true);
    const stranger = createCommand({
      principal: { kind: "player", principalId: "p2", controlledActorIds: ["actor-9"] },
    });
    const rejected = resolveCreateCommitment(createView() as never, stranger as never);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("unauthorized_actor");
  });

  it("rejects past windows and unknown destinations", () => {
    const past = resolveCreateCommitment(
      createView() as never,
      createCommand({}, { window: { latestArrival: NOW } }) as never,
    );
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.code).toBe("window_in_past");
    const nowhere = resolveCreateCommitment(
      createView({ destinationZoneExists: false }) as never,
      createCommand() as never,
    );
    expect(nowhere.ok).toBe(false);
    if (!nowhere.ok) expect(nowhere.code).toBe("destination_not_found");
  });
});

function acceptedCreate() {
  const resolution = resolveCreateCommitment(createView() as never, createCommand() as never);
  if (!resolution.ok) throw new Error("fixture create must resolve");
  return resolution;
}

function systemCommand(type: string, id: string, payload: Record<string, unknown>) {
  return {
    id,
    branchId: "branch-1",
    expectedVersion: 1,
    idempotencyKey: `${id}-key`,
    principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] },
    submittedAtWallClock: "2026-07-17T13:00:00.000Z",
    correlationId: "corr-1",
    type,
    schemaVersion: 1,
    payload,
  };
}

describe("E3.3 resolveRaisePressure", () => {
  it("raises pressure once with flexibility-derived severity", () => {
    const commitment = acceptedCreate().commitment;
    const resolution = resolveRaisePressure(
      {
        worldId: "world-1",
        branchId: "branch-1",
        rulesetVersion: "gate3-test-v1",
        headSequence: 3,
        storySecond: NOW + 1_000,
        commitment,
      } as never,
      systemCommand("raise_pressure", "cmd-raise-1", { commitmentId: commitment.id }) as never,
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.event.payload.severity).toBe("urgent");
    expect(resolution.commitment.status).toBe("noticed");

    const again = resolveRaisePressure(
      {
        worldId: "world-1",
        branchId: "branch-1",
        rulesetVersion: "gate3-test-v1",
        headSequence: 4,
        storySecond: NOW + 1_100,
        commitment: resolution.commitment,
      } as never,
      systemCommand("raise_pressure", "cmd-raise-2", { commitmentId: commitment.id }) as never,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("commitment_not_open");
  });
});

describe("E3.3 resolveCommitmentDeadline", () => {
  function deadlineView(overrides: Record<string, unknown> = {}) {
    return {
      worldId: "world-1",
      branchId: "branch-1",
      rulesetVersion: "gate3-test-v1",
      headSequence: 4,
      storySecond: SHIFT_AT,
      commitment: acceptedCreate().commitment,
      actorLocus: { kind: "at", actorId: "actor-1", locationId: "loc-1", zoneId: "zone-home", since: NOW },
      ...overrides,
    };
  }
  const command = () =>
    systemCommand("resolve_commitment_deadline", "cmd-deadline-1", {
      commitmentId: deriveCommitmentId("branch-1", "cmd-commit-1"),
    });

  it("keeps when present, lates when inbound, misses when absent", () => {
    const kept = resolveCommitmentDeadline(
      deadlineView({
        actorLocus: { kind: "at", actorId: "actor-1", locationId: "loc-1", zoneId: "zone-work", since: NOW },
      }) as never,
      command() as never,
    );
    if (!kept.ok) throw new Error("expected kept");
    expect(kept.outcome).toBe("kept");
    expect(kept.event.payload.evaluation).toEqual({ basis: "at_destination" });

    const late = resolveCommitmentDeadline(
      deadlineView({
        actorLocus: {
          kind: "in_transit",
          actorId: "actor-1",
          journeyId: "journey-1",
          linkId: "link-hw",
          enteredAt: SHIFT_AT - 100,
          earliestExitAt: SHIFT_AT + 500,
        },
        actorJourney: {
          id: "journey-1",
          actorIds: ["actor-1"],
          originZoneId: "zone-home",
          destinationZoneId: "zone-work",
          routeLinkIds: ["link-hw"],
          travelMode: "walk",
          departedAt: SHIFT_AT - 100,
          earliestArrivalAt: SHIFT_AT + 500,
          expectedArrivalAt: SHIFT_AT + 500,
          status: "active",
          currentLinkIndex: 0,
          routeDerivationVersion: "gate3-route-v1",
        },
      }) as never,
      command() as never,
    );
    if (!late.ok) throw new Error("expected late");
    expect(late.outcome).toBe("late");
    expect(late.event.payload.evaluation).toMatchObject({ basis: "en_route", journeyId: "journey-1" });

    const missed = resolveCommitmentDeadline(deadlineView() as never, command() as never);
    if (!missed.ok) throw new Error("expected missed");
    expect(missed.outcome).toBe("missed");
    expect(missed.event.payload.evaluation).toEqual({ basis: "absent" });
  });

  it("re-validates at fire time and treats early firing as corruption", () => {
    const resolved = { ...acceptedCreate().commitment, status: "kept" as const };
    const closed = resolveCommitmentDeadline(deadlineView({ commitment: resolved }) as never, command() as never);
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.code).toBe("commitment_not_open");

    expect(() =>
      resolveCommitmentDeadline(deadlineView({ storySecond: SHIFT_AT - 1 }) as never, command() as never),
    ).toThrow(/before its window/u);
  });
});

describe("E3.3 commitments replay", () => {
  function lifecycleEvents(): SimulationBranchEvent[] {
    const create = acceptedCreate();
    const raise = resolveRaisePressure(
      {
        worldId: "world-1",
        branchId: "branch-1",
        rulesetVersion: "gate3-test-v1",
        headSequence: 3,
        storySecond: NOW + 1_000,
        commitment: create.commitment,
      } as never,
      systemCommand("raise_pressure", "cmd-raise-1", { commitmentId: create.commitment.id }) as never,
    );
    if (!raise.ok) throw new Error("fixture raise must resolve");
    const miss = resolveCommitmentDeadline(
      {
        worldId: "world-1",
        branchId: "branch-1",
        rulesetVersion: "gate3-test-v1",
        headSequence: 4,
        storySecond: SHIFT_AT,
        commitment: raise.commitment,
        actorLocus: { kind: "at", actorId: "actor-1", locationId: "loc-1", zoneId: "zone-home", since: NOW },
      } as never,
      systemCommand("resolve_commitment_deadline", "cmd-deadline-1", {
        commitmentId: create.commitment.id,
      }) as never,
    );
    if (!miss.ok) throw new Error("fixture miss must resolve");
    return [...create.events, { ...raise.event, sequence: 4 }, { ...miss.event, sequence: 5 }] as SimulationBranchEvent[];
  }

  it("folds the full stream to the missed commitment with a resolved pressure", () => {
    const replayed = replayCommitmentsHistory({
      seed: emptyCommitmentsSeed("branch-1", NOW),
      events: lifecycleEvents(),
    });
    expect(replayed.headSequence).toBe(5);
    // Three distinct commands: create, raise, deadline.
    expect(replayed.version).toBe(3);
    expect(replayed.commitments[0]?.status).toBe("missed");
    expect(replayed.pressures).toHaveLength(1);
    expect(replayed.pressures[0]?.resolvedAt).toBe(SHIFT_AT);
  });

  it("matches an event-at-a-time fold", () => {
    const events = lifecycleEvents();
    const wholesale = replayCommitmentsHistory({ seed: emptyCommitmentsSeed("branch-1", NOW), events });
    let stepwise = emptyCommitmentsSeed("branch-1", NOW);
    for (const event of events) stepwise = applyCommitmentEvent(stepwise, event);
    expect(simulationHash({ ...wholesale, version: 0 })).toBe(simulationHash({ ...stepwise, version: 0 }));
  });
});
