import { describe, expect, it } from "vitest";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import {
  deriveCommitmentTimes,
  derivePressureSeverity,
} from "@/contracts/simulation/commitments";
import { simulationHash } from "./hash";
import {
  applyCommitmentEvent,
  commitmentDeadlineUniquenessKey,
  commitmentNoticeUniquenessKey,
  deriveCommitmentId,
  emptyCommitmentsSeed,
  replayCommitmentsHistory,
  resolveCommitmentDeadline,
  resolveCreateCommitment,
  resolveFulfillCommitment,
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

  it("E5.5 slice 2: a destinationless commitment succeeds, never checks destination_not_found, derives zero route duration, and its entityIds omit the absent destination", () => {
    const resolution = resolveCreateCommitment(
      createView({ destinationZoneExists: false, promisedToActorExists: true }) as never, // proves destination existence is never consulted
      createCommand({}, { kind: "promise", destinationZoneId: undefined, promisedToActorId: "actor-2" }) as never,
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    const [created] = resolution.events;
    expect(created.payload.derived.minimumRouteDurationSeconds).toBe(0);
    expect("destinationZoneId" in created.payload).toBe(false);
    const commitmentId = deriveCommitmentId("branch-1", "cmd-commit-1");
    expect(created.entityIds).toEqual(["actor-1", commitmentId].sort());
    expect(resolution.commitment.destinationZoneId).toBeUndefined();
  });
});

function acceptedCreate() {
  const resolution = resolveCreateCommitment(createView() as never, createCommand() as never);
  if (!resolution.ok) throw new Error("fixture create must resolve");
  return resolution;
}

/** A destinationless promise fixture (E5.5 slice 2), naming `promisedToActorId: "actor-2"`. */
function acceptedDestinationlessCreate(overrides: {
  commandOverrides?: Record<string, unknown>;
  payloadOverrides?: Record<string, unknown>;
} = {}) {
  const resolution = resolveCreateCommitment(
    createView({ destinationZoneExists: false, promisedToActorExists: true }) as never,
    createCommand(overrides.commandOverrides ?? {}, {
      kind: "promise",
      destinationZoneId: undefined,
      promisedToActorId: "actor-2",
      ...overrides.payloadOverrides,
    }) as never,
  );
  if (!resolution.ok) throw new Error(`fixture destinationless create must resolve, got ${resolution.code}`);
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
  function raiseView(overrides: Record<string, unknown> = {}) {
    return {
      worldId: "world-1",
      branchId: "branch-1",
      rulesetVersion: "gate3-test-v1",
      headSequence: 3,
      storySecond: NOW + 1_000,
      originZoneId: "zone-home",
      topology: topology(),
      ...overrides,
    };
  }

  it("raises pressure once with flexibility-derived severity and §15.2 act-by", () => {
    const commitment = acceptedCreate().commitment;
    const resolution = resolveRaisePressure(
      raiseView({ commitment }) as never,
      systemCommand("raise_pressure", "cmd-raise-1", { commitmentId: commitment.id }) as never,
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.event.payload.severity).toBe("urgent");
    expect(resolution.commitment.status).toBe("noticed");
    // actBy is latestDeparture recomputed from the fire-time route, never the
    // arrival deadline itself.
    expect(resolution.pressure.noticeAt).toBe(NOW + 1_000);
    expect(resolution.pressure.actBy).toBe(SHIFT_AT - WALK_AB - 300 - 120);
    expect(resolution.pressure.decideBy).toBe(resolution.pressure.actBy);

    const again = resolveRaisePressure(
      raiseView({ headSequence: 4, storySecond: NOW + 1_100, commitment: resolution.commitment }) as never,
      systemCommand("raise_pressure", "cmd-raise-2", { commitmentId: commitment.id }) as never,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("commitment_not_open");
  });

  it("fails the E4.2 knowledge gate closed for asserted and believed sources", () => {
    const base = acceptedCreate().commitment;
    for (const knowledgeSource of [
      { kind: "asserted", assertionId: "assertion-1" },
      { kind: "believed", beliefId: "belief-1" },
    ]) {
      const commitment = { ...base, knowledgeSource };
      const blocked = resolveRaisePressure(
        raiseView({ commitment }) as never,
        systemCommand("raise_pressure", "cmd-raise-k1", { commitmentId: base.id }) as never,
      );
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.code).toBe("knowledge_unavailable");

      const held = resolveRaisePressure(
        raiseView({ commitment, knowledgeSourceHeld: true }) as never,
        systemCommand("raise_pressure", "cmd-raise-k2", { commitmentId: base.id }) as never,
      );
      expect(held.ok).toBe(true);
    }
  });

  it("clamps a notice that fires past its own act-by forward, preserving ordering", () => {
    const commitment = acceptedCreate().commitment;
    const lateSecond = SHIFT_AT - 10;
    const resolution = resolveRaisePressure(
      raiseView({ commitment, storySecond: lateSecond }) as never,
      systemCommand("raise_pressure", "cmd-raise-late", { commitmentId: commitment.id }) as never,
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.pressure.noticeAt).toBe(lateSecond);
    expect(resolution.pressure.decideBy).toBe(lateSecond);
    expect(resolution.pressure.actBy).toBe(lateSecond);
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

describe("E5.5 slice 2 — resolveCommitmentDeadline over a destinationless commitment", () => {
  const destinationlessCommand = () =>
    systemCommand("resolve_commitment_deadline", "cmd-deadline-destless", {
      commitmentId: deriveCommitmentId("branch-1", "cmd-commit-1"),
    });

  it("always resolves missed — present, in-transit-with-an-active-journey, and absent all fall through the same way, and entityIds omit the absent destination", () => {
    const commitment = acceptedDestinationlessCreate().commitment;
    const loci: Array<{ actorLocus: Record<string, unknown>; actorJourney?: Record<string, unknown> }> = [
      { actorLocus: { kind: "at", actorId: "actor-1", locationId: "loc-1", zoneId: "zone-home", since: NOW } },
      // "at" a zone that WOULD have been the destination under a spatial commitment — still no destination to match.
      { actorLocus: { kind: "at", actorId: "actor-1", locationId: "loc-1", zoneId: "zone-work", since: NOW } },
      {
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
      },
    ];
    for (const { actorLocus, actorJourney } of loci) {
      const resolution = resolveCommitmentDeadline(
        {
          worldId: "world-1",
          branchId: "branch-1",
          rulesetVersion: "gate3-test-v1",
          headSequence: 4,
          storySecond: SHIFT_AT,
          commitment,
          actorLocus,
          ...(actorJourney ? { actorJourney } : {}),
        } as never,
        destinationlessCommand() as never,
      );
      if (!resolution.ok) throw new Error(`expected resolution, got rejection ${resolution.code}`);
      expect(resolution.outcome).toBe("missed");
      expect(resolution.event.payload.evaluation).toEqual({ basis: "absent" });
      expect(resolution.event.entityIds).toEqual(["actor-1", commitment.id].sort());
    }
  });
});

describe("E5.5 slice 2 — repair chain validation", () => {
  it("end to end: A (promise) misses, then B repairs it with a matching promisedToActorId → accepted and linked", () => {
    const createA = resolveCreateCommitment(
      createView({ destinationZoneExists: false, promisedToActorExists: true }) as never,
      createCommand({ id: "cmd-promise-a", idempotencyKey: "promise-a-key" }, {
        kind: "promise",
        destinationZoneId: undefined,
        promisedToActorId: "actor-2",
      }) as never,
    );
    if (!createA.ok) throw new Error("fixture A create must resolve");
    const missedA = resolveCommitmentDeadline(
      {
        worldId: "world-1",
        branchId: "branch-1",
        rulesetVersion: "gate3-test-v1",
        headSequence: 4,
        storySecond: SHIFT_AT,
        commitment: createA.commitment,
        actorLocus: { kind: "at", actorId: "actor-1", locationId: "loc-1", zoneId: "zone-home", since: NOW },
      } as never,
      systemCommand("resolve_commitment_deadline", "cmd-deadline-a", { commitmentId: createA.commitment.id }) as never,
    );
    if (!missedA.ok) throw new Error("fixture A miss must resolve");
    expect(missedA.outcome).toBe("missed");

    const createB = resolveCreateCommitment(
      createView({
        destinationZoneExists: false,
        repairTarget: { actorId: missedA.commitment.actorId, kind: missedA.commitment.kind, status: missedA.commitment.status },
        promisedToActorExists: true,
      }) as never,
      createCommand({ id: "cmd-promise-b", idempotencyKey: "promise-b-key" }, {
        kind: "promise",
        destinationZoneId: undefined,
        promisedToActorId: "actor-2",
        repairsCommitmentId: missedA.commitment.id,
      }) as never,
    );
    if (!createB.ok) throw new Error(`expected acceptance, got ${createB.code}`);
    expect(createB.commitment.repairsCommitmentId).toBe(missedA.commitment.id);
    expect(createB.events[0].payload.repairsCommitmentId).toBe(missedA.commitment.id);
  });

  it("rejects repair_target_not_found when the view resolves no repair target", () => {
    const resolution = resolveCreateCommitment(
      createView({ destinationZoneExists: false }) as never,
      createCommand({}, {
        kind: "promise",
        destinationZoneId: undefined,
        promisedToActorId: "actor-2",
        repairsCommitmentId: "commitment-does-not-exist",
      }) as never,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("repair_target_not_found");
  });

  it("rejects repair_target_not_repairable for a mismatched actor (someone else's missed commitment)", () => {
    const view = createView({
      destinationZoneExists: false,
      repairTarget: { actorId: "actor-9", kind: "promise", status: "missed" },
    });
    const resolution = resolveCreateCommitment(
      view as never,
      createCommand({}, { kind: "promise", destinationZoneId: undefined, repairsCommitmentId: "commitment-old-1" }) as never,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("repair_target_not_repairable");
  });

  it("rejects repair_target_not_repairable for a mismatched kind", () => {
    const view = createView({
      destinationZoneExists: false,
      repairTarget: { actorId: "actor-1", kind: "shift", status: "missed" },
    });
    const resolution = resolveCreateCommitment(
      view as never,
      createCommand({}, { kind: "promise", destinationZoneId: undefined, repairsCommitmentId: "commitment-old-1" }) as never,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("repair_target_not_repairable");
  });

  it("rejects repair_target_not_repairable for a non-missed status", () => {
    const view = createView({
      destinationZoneExists: false,
      repairTarget: { actorId: "actor-1", kind: "promise", status: "planned" },
    });
    const resolution = resolveCreateCommitment(
      view as never,
      createCommand({}, { kind: "promise", destinationZoneId: undefined, repairsCommitmentId: "commitment-old-1" }) as never,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("repair_target_not_repairable");
  });

  it("rejects promised_to_actor_not_found when promisedToActorId is named but unresolved", () => {
    const view = createView({ destinationZoneExists: false, promisedToActorExists: false });
    const resolution = resolveCreateCommitment(
      view as never,
      createCommand({}, { kind: "promise", destinationZoneId: undefined, promisedToActorId: "actor-ghost" }) as never,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("promised_to_actor_not_found");
  });

  it("rejects promised_to_self as a structured rejection instead of throwing — a self-promise is schema-legal at the command layer but commitmentSchema's refine forbids it", () => {
    // promisedToActorExists: true because the actor's own row obviously exists — the
    // bug this guards against is exactly that "exists" check passing for a self-id.
    const view = createView({ destinationZoneExists: false, promisedToActorExists: true });
    const resolution = resolveCreateCommitment(
      view as never,
      createCommand({}, { kind: "promise", destinationZoneId: undefined, promisedToActorId: "actor-1" }) as never,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("promised_to_self");
  });
});

describe("E5.5 slice 2 — resolveFulfillCommitment", () => {
  function fulfillView(overrides: Record<string, unknown> = {}) {
    return {
      worldId: "world-1",
      branchId: "branch-1",
      rulesetVersion: "gate3-test-v1",
      headSequence: 4,
      storySecond: NOW + 100,
      ...overrides,
    };
  }
  function fulfillCommand(overrides: Record<string, unknown> = {}) {
    return {
      id: "cmd-fulfill-1",
      branchId: "branch-1",
      expectedVersion: 1,
      idempotencyKey: "fulfill-key-1",
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: ["actor-1"] },
      submittedAtWallClock: "2026-07-17T13:00:00.000Z",
      correlationId: "corr-1",
      type: "fulfill_commitment",
      schemaVersion: 1,
      payload: { commitmentId: deriveCommitmentId("branch-1", "cmd-commit-1") },
      ...overrides,
    };
  }

  it("keeps a destinationless open commitment before its deadline, with a self_reported evaluation naming the fulfilling command", () => {
    const commitment = acceptedDestinationlessCreate().commitment;
    const resolution = resolveFulfillCommitment(fulfillView({ commitment }) as never, fulfillCommand() as never);
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.commitment.status).toBe("kept");
    expect(resolution.event.payload.evaluation).toEqual({ basis: "self_reported", sourceCommandId: "cmd-fulfill-1" });
  });

  it("rejects commitment_has_destination for a commitment naming a destinationZoneId", () => {
    const commitment = acceptedCreate().commitment; // spatial: destinationZoneId "zone-work"
    const resolution = resolveFulfillCommitment(fulfillView({ commitment }) as never, fulfillCommand() as never);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("commitment_has_destination");
  });

  it("rejects commitment_not_open for an already-resolved commitment", () => {
    const commitment = { ...acceptedDestinationlessCreate().commitment, status: "kept" as const };
    const resolution = resolveFulfillCommitment(fulfillView({ commitment }) as never, fulfillCommand() as never);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("commitment_not_open");
  });

  it("rejects deadline_passed once the window's latestArrival has elapsed", () => {
    const commitment = acceptedDestinationlessCreate().commitment;
    const resolution = resolveFulfillCommitment(
      fulfillView({ commitment, storySecond: commitment.window.latestArrival + 1 }) as never,
      fulfillCommand() as never,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("deadline_passed");
  });

  it("rejects unauthorized_actor for a player not controlling the committed actor", () => {
    const commitment = acceptedDestinationlessCreate().commitment;
    const resolution = resolveFulfillCommitment(
      fulfillView({ commitment }) as never,
      fulfillCommand({ principal: { kind: "player", principalId: "p2", controlledActorIds: ["actor-9"] } }) as never,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("unauthorized_actor");
  });

  it("rejects commitment_not_found when the view resolves no commitment", () => {
    const resolution = resolveFulfillCommitment(fulfillView() as never, fulfillCommand() as never);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("commitment_not_found");
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
        originZoneId: "zone-home",
        topology: topology(),
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
