import { describe, expect, it } from "vitest";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import { engagementStateTransitions, pressureAcknowledgedEventSchema } from "@/contracts/simulation/engagements";
import { simulationHash } from "./hash";
import {
  applyEngagementEvent,
  buildDepartureInterruptEvent,
  deriveEngagementId,
  emptyEngagementsSeed,
  engagementClaimsForActor,
  replayEngagementsHistory,
  resolveEndEngagement,
  resolveOpenEngagement,
} from "./engagements";

const NOW = 8_000;

function participant(actorId: string, overrides: Record<string, unknown> = {}) {
  return {
    actorId,
    exists: true,
    locus: { kind: "at", actorId, locationId: "loc-1", zoneId: "zone-a", since: NOW },
    locationId: "loc-1",
    heldClaims: [],
    inOpenCoPresentEngagement: false,
    ...overrides,
  };
}

function openView(overrides: Record<string, unknown> = {}) {
  return {
    worldId: "world-1",
    branchId: "branch-1",
    rulesetVersion: "gate3-test-v1",
    headSequence: 0,
    storySecond: NOW,
    participants: [participant("actor-1"), participant("actor-2")],
    ...overrides,
  };
}

function openCommand(overrides: Record<string, unknown> = {}, payloadOverrides: Record<string, unknown> = {}) {
  return {
    id: "cmd-open-1",
    branchId: "branch-1",
    expectedVersion: 0,
    idempotencyKey: "open-key-1",
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: ["actor-1"] },
    submittedAtWallClock: "2026-07-17T12:00:00.000Z",
    correlationId: "corr-1",
    type: "open_engagement",
    schemaVersion: 1,
    payload: { participantIds: ["actor-1", "actor-2"], channel: "co_present", ...payloadOverrides },
    ...overrides,
  };
}

describe("E3.4 resolveOpenEngagement", () => {
  it("opens a co-present scene with full attention claimed", () => {
    const resolution = resolveOpenEngagement(openView() as never, openCommand() as never);
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.engagement.state).toBe("active");
    expect(resolution.engagement.zoneId).toBe("zone-a");
    expect(resolution.engagement.attentionClaim).toEqual({ kind: "attention", weight: "full" });
    expect(resolution.event.payload.engagementId).toBe(deriveEngagementId("branch-1", "cmd-open-1"));
    expect(
      engagementClaimsForActor([resolution.engagement], "actor-2"),
    ).toEqual([{ kind: "attention", weight: "full" }]);
  });

  it("opens a remote thread with partial attention and no co-location requirement", () => {
    const apart = openView({
      participants: [
        participant("actor-1"),
        participant("actor-2", {
          locus: { kind: "at", actorId: "actor-2", locationId: "loc-2", zoneId: "zone-b", since: NOW },
        }),
      ],
    });
    const resolution = resolveOpenEngagement(apart as never, openCommand({}, { channel: "text" }) as never);
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.engagement.attentionClaim).toEqual({ kind: "attention", weight: "partial" });
    expect(resolution.engagement.zoneId).toBeUndefined();
  });

  it("enforces one body, one physical scene, and presence of mind", () => {
    const cases: [unknown, unknown, string][] = [
      [
        openView({ participants: [participant("actor-1"), participant("actor-2", { exists: false })] }),
        openCommand(),
        "participant_not_found",
      ],
      [
        openView(),
        openCommand({ principal: { kind: "player", principalId: "p2", controlledActorIds: ["actor-9"] } }),
        "unauthorized_actor",
      ],
      [
        openView({
          participants: [
            participant("actor-1"),
            participant("actor-2", {
              locus: { kind: "at", actorId: "actor-2", locationId: "loc-2", zoneId: "zone-b", since: NOW },
            }),
          ],
        }),
        openCommand(),
        "participants_not_co_located",
      ],
      [
        openView({
          participants: [
            participant("actor-1"),
            participant("actor-2", {
              locus: {
                kind: "in_transit",
                actorId: "actor-2",
                journeyId: "journey-1",
                linkId: "link-1",
                enteredAt: NOW,
                earliestExitAt: NOW + 600,
              },
            }),
          ],
        }),
        openCommand(),
        "participant_in_transit",
      ],
      [
        openView({
          participants: [participant("actor-1"), participant("actor-2", { inOpenCoPresentEngagement: true })],
        }),
        openCommand(),
        "participant_already_engaged",
      ],
      [
        openView({
          participants: [
            participant("actor-1"),
            participant("actor-2", { heldClaims: [{ kind: "attention", weight: "full" }] }),
          ],
        }),
        openCommand({}, { channel: "text" }),
        "participant_unavailable",
      ],
    ];
    for (const [view, command, code] of cases) {
      const resolution = resolveOpenEngagement(view as never, command as never);
      expect(resolution.ok, code).toBe(false);
      if (!resolution.ok) expect(resolution.code).toBe(code);
    }
  });
});

function acceptedOpen() {
  const resolution = resolveOpenEngagement(openView() as never, openCommand() as never);
  if (!resolution.ok) throw new Error("fixture open must resolve");
  return resolution;
}

describe("E3.4 resolveEndEngagement and interrupts", () => {
  it("ends for a participant's controller and refuses strangers and rerun-ends", () => {
    const open = acceptedOpen();
    const endCommand = {
      id: "cmd-end-1",
      branchId: "branch-1",
      expectedVersion: 1,
      idempotencyKey: "end-key-1",
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: ["actor-1"] },
      submittedAtWallClock: "2026-07-17T12:10:00.000Z",
      correlationId: "corr-1",
      type: "end_engagement",
      schemaVersion: 1,
      payload: { engagementId: open.engagement.id, reason: "participant_choice" },
    };
    const view = {
      worldId: "world-1",
      branchId: "branch-1",
      rulesetVersion: "gate3-test-v1",
      headSequence: 1,
      storySecond: NOW + 300,
      engagement: open.engagement,
    };
    const ended = resolveEndEngagement(view as never, endCommand as never);
    if (!ended.ok) throw new Error(`expected acceptance, got ${ended.code}`);
    expect(ended.engagement.state).toBe("ended");
    expect(engagementClaimsForActor([ended.engagement], "actor-1")).toEqual([]);

    const stranger = resolveEndEngagement(
      view as never,
      { ...endCommand, principal: { kind: "player", principalId: "p2", controlledActorIds: ["actor-9"] } } as never,
    );
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.code).toBe("unauthorized_actor");

    const rerun = resolveEndEngagement(
      { ...view, engagement: ended.engagement } as never,
      { ...endCommand, id: "cmd-end-2", idempotencyKey: "end-key-2" } as never,
    );
    expect(rerun.ok).toBe(false);
    if (!rerun.ok) expect(rerun.code).toBe("engagement_not_open");
  });

  it("builds a departure interrupt that replays to an interrupted scene", () => {
    const open = acceptedOpen();
    const interrupt = buildDepartureInterruptEvent({
      meta: {
        worldId: "world-1",
        branchId: "branch-1",
        rulesetVersion: "gate3-test-v1",
        headSequence: 1,
        storySecond: NOW + 100,
      },
      command: { id: "cmd-move-1", correlationId: "corr-1", submittedAtWallClock: "2026-07-17T12:02:00.000Z" },
      engagement: open.engagement,
      sequence: 2,
      causationId: open.event.id,
    });
    const replayed = replayEngagementsHistory({
      seed: emptyEngagementsSeed("branch-1", NOW),
      events: [open.event, interrupt] as SimulationBranchEvent[],
    });
    expect(replayed.engagements[0]?.state).toBe("interrupted");
    // Interrupted scenes still hold their claims (§18.2 — only ended releases).
    expect(engagementClaimsForActor(replayed.engagements, "actor-2")).toHaveLength(1);
  });
});

describe("E3.4 engagements replay", () => {
  it("folds open + end and matches the stepwise fold", () => {
    const open = acceptedOpen();
    const end = resolveEndEngagement(
      {
        worldId: "world-1",
        branchId: "branch-1",
        rulesetVersion: "gate3-test-v1",
        headSequence: 1,
        storySecond: NOW + 300,
        engagement: open.engagement,
      } as never,
      {
        id: "cmd-end-1",
        branchId: "branch-1",
        expectedVersion: 1,
        idempotencyKey: "end-key-1",
        principal: { kind: "player", principalId: "principal-1", controlledActorIds: ["actor-1"] },
        submittedAtWallClock: "2026-07-17T12:10:00.000Z",
        correlationId: "corr-1",
        type: "end_engagement",
        schemaVersion: 1,
        payload: { engagementId: open.engagement.id, reason: "participant_choice" },
      } as never,
    );
    if (!end.ok) throw new Error("fixture end must resolve");
    const events = [open.event, { ...end.event, sequence: 2 }] as SimulationBranchEvent[];
    const wholesale = replayEngagementsHistory({ seed: emptyEngagementsSeed("branch-1", NOW), events });
    expect(wholesale.version).toBe(2);
    expect(wholesale.engagements[0]?.state).toBe("ended");
    let stepwise = emptyEngagementsSeed("branch-1", NOW);
    for (const event of events) stepwise = applyEngagementEvent(stepwise, event);
    expect(simulationHash({ ...wholesale, version: 0 })).toBe(simulationHash({ ...stepwise, version: 0 }));
  });

  it("keeps the §18.2 transition table total with ended terminal", () => {
    expect(engagementStateTransitions.ended).toEqual([]);
    expect(engagementStateTransitions.interrupted).toContain("active");
  });
});

describe("E5.5 slice 3 — pressure_acknowledged real fold case", () => {
  function ackEvent(engagementId: string, pressureId: string, sequence: number) {
    return pressureAcknowledgedEventSchema.parse({
      id: `event-ack-${pressureId}-${sequence}`,
      worldId: "world-1",
      branchId: "branch-1",
      sequence,
      storySecond: NOW + 100,
      rulesetVersion: "gate3-test-v1",
      correlationId: "corr-1",
      actorIds: ["actor-1"],
      entityIds: [],
      recordedAtWallClock: "2026-07-17T12:05:00.000Z",
      commandId: "cmd-ack",
      type: "pressure_acknowledged",
      schemaVersion: 1,
      payload: {
        engagementId,
        pressureId,
        actorId: "actor-1",
        acknowledgedAt: NOW + 100,
        acknowledgedSeverity: "salient",
      },
    });
  }

  it("appends the pressure id to Engagement.acknowledgedPressureIds", () => {
    const open = acceptedOpen();
    const folded = applyEngagementEvent(
      applyEngagementEvent(emptyEngagementsSeed("branch-1", NOW), open.event),
      ackEvent(open.engagement.id, "pressure-a", 2) as SimulationBranchEvent,
    );
    expect(folded.engagements[0]?.acknowledgedPressureIds).toEqual(["pressure-a"]);
  });

  it("is idempotent under a duplicate append (sortedUnique never produces a duplicate array entry)", () => {
    const open = acceptedOpen();
    let projection = applyEngagementEvent(emptyEngagementsSeed("branch-1", NOW), open.event);
    projection = applyEngagementEvent(projection, ackEvent(open.engagement.id, "pressure-a", 2) as SimulationBranchEvent);
    projection = applyEngagementEvent(
      projection,
      ackEvent(open.engagement.id, "pressure-a", 3) as SimulationBranchEvent,
    );
    expect(projection.engagements[0]?.acknowledgedPressureIds).toEqual(["pressure-a"]);
  });
});
