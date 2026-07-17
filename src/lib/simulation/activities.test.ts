import { describe, expect, it } from "vitest";
import {
  activityClaimsConflict,
  activityPhaseTransitions,
  simulationActionDefinitionSchema,
  type SimulationActionDefinition,
} from "@/contracts/simulation/activities";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import { simulationHash } from "./item-transfer";
import {
  activityCompletionUniquenessKey,
  applyActivityEvent,
  deriveActivityId,
  emptyActivitiesSeed,
  heldClaimsForActor,
  replayActivitiesHistory,
  resolveCancelActivity,
  resolveCompleteActivity,
  resolveStartActivity,
} from "./activities";

const SEED_SECOND = 5_000;

function definition(overrides: Partial<SimulationActionDefinition> = {}): SimulationActionDefinition {
  return simulationActionDefinitionSchema.parse({
    id: "action-nap",
    version: 1,
    controllerKinds: ["player", "npc_policy"],
    duration: { kind: "fixed", seconds: 1_800 },
    preconditions: [{ kind: "at_zone_kind", zoneKind: "room" }],
    requiredClaims: [{ kind: "body" }, { kind: "attention", weight: "full" }],
    interruptibility: "pausable",
    noticeability: "obvious",
    ...overrides,
  });
}

function startView(overrides: Record<string, unknown> = {}) {
  return {
    worldId: "world-1",
    branchId: "branch-1",
    rulesetVersion: "gate3-test-v1",
    headSequence: 0,
    storySecond: SEED_SECOND,
    actorExists: true,
    locus: { kind: "at", actorId: "actor-1", locationId: "loc-home", zoneId: "zone-a", since: SEED_SECOND },
    actorZone: { id: "zone-a", kind: "room", locationId: "loc-home" },
    definition: definition(),
    heldClaims: [],
    coLocatedActorIds: ["actor-2"],
    ...overrides,
  };
}

function startCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmd-start-1",
    branchId: "branch-1",
    expectedVersion: 0,
    idempotencyKey: "start-key-1",
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: ["actor-1"] },
    submittedAtWallClock: "2026-07-17T12:00:00.000Z",
    correlationId: "corr-1",
    type: "start_activity",
    schemaVersion: 1,
    payload: { actionDefinitionId: "action-nap", actorId: "actor-1" },
    ...overrides,
  };
}

describe("E3.2 claim arithmetic", () => {
  it("conflicts body-with-body and full-with-full attention only", () => {
    expect(activityClaimsConflict([{ kind: "body" }], [{ kind: "body" }])).toBe(true);
    expect(
      activityClaimsConflict(
        [{ kind: "attention", weight: "full" }],
        [{ kind: "attention", weight: "full" }],
      ),
    ).toBe(true);
    expect(
      activityClaimsConflict(
        [{ kind: "attention", weight: "partial" }],
        [{ kind: "attention", weight: "full" }],
      ),
    ).toBe(false);
    expect(activityClaimsConflict([{ kind: "body" }], [{ kind: "attention", weight: "full" }])).toBe(false);
    expect(activityClaimsConflict([], [{ kind: "body" }])).toBe(false);
  });

  it("derives held claims only from claim-holding phases", () => {
    const base = {
      actionDefinitionId: "action-nap",
      actionVersion: 1,
      actorIds: ["actor-1"],
      zoneId: "zone-a",
      progressFixedPoint: 0,
      claims: [{ kind: "body" as const }],
      sourceCommandId: "cmd-x",
    };
    const activities = [
      { ...base, id: "act-live", phase: "active" as const },
      { ...base, id: "act-done", phase: "completed" as const },
    ];
    expect(heldClaimsForActor(activities as never, "actor-1")).toEqual([{ kind: "body" }]);
    expect(heldClaimsForActor(activities as never, "actor-9")).toEqual([]);
  });
});

describe("E3.2 resolveStartActivity", () => {
  it("starts a legal activity with a completion trigger and captured witnesses", () => {
    const resolution = resolveStartActivity(startView() as never, startCommand() as never);
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    const [started, trigger] = resolution.events;
    expect([started.sequence, trigger.sequence]).toEqual([1, 2]);
    expect(trigger.causationId).toBe(started.id);
    const activityId = deriveActivityId("branch-1", "cmd-start-1");
    expect(started.payload.activityInstanceId).toBe(activityId);
    expect(started.payload.expectedCompleteAt).toBe(SEED_SECOND + 1_800);
    expect(started.payload.observerActorIds).toEqual(["actor-1", "actor-2"]);
    expect(trigger.payload.kind).toBe("activity_completion_due");
    expect(trigger.payload.dueStorySecond).toBe(SEED_SECOND + 1_800);
    expect(trigger.payload.uniquenessKey).toBe(activityCompletionUniquenessKey(activityId));
    expect(resolution.activity.phase).toBe("active");
    expect(resolution.activity.claims).toEqual([
      { kind: "body" },
      { kind: "attention", weight: "full" },
    ]);
  });

  it("keeps a private activity's witnesses to its participants", () => {
    const view = startView({ definition: definition({ noticeability: "private" }) });
    const resolution = resolveStartActivity(view as never, startCommand() as never);
    if (!resolution.ok) throw new Error("expected acceptance");
    expect(resolution.events[0].payload.observerActorIds).toEqual(["actor-1"]);
  });

  it("rejects the start failure taxonomy", () => {
    const transitLocus = {
      kind: "in_transit",
      actorId: "actor-1",
      journeyId: "journey-1",
      linkId: "link-1",
      enteredAt: SEED_SECOND,
      earliestExitAt: SEED_SECOND + 600,
    };
    const cases: [unknown, unknown, string][] = [
      [startView({ actorExists: false }), startCommand(), "actor_not_found"],
      [
        startView(),
        startCommand({ principal: { kind: "player", principalId: "p", controlledActorIds: ["actor-9"] } }),
        "unauthorized_actor",
      ],
      [startView({ definition: undefined }), startCommand(), "action_not_found"],
      [
        startView({ definition: definition({ controllerKinds: ["npc_policy"] }) }),
        startCommand(),
        "unauthorized_controller",
      ],
      [startView({ locus: transitLocus }), startCommand(), "actor_in_transit"],
      [
        startView({ actorZone: { id: "zone-a", kind: "kitchen", locationId: "loc-home" } }),
        startCommand(),
        "precondition_failed",
      ],
      [startView({ heldClaims: [{ kind: "body" }] }), startCommand(), "claim_conflict"],
    ];
    for (const [view, command, code] of cases) {
      const resolution = resolveStartActivity(view as never, command as never);
      expect(resolution.ok, code).toBe(false);
      if (!resolution.ok) expect(resolution.code).toBe(code);
    }
  });
});

function acceptedStart() {
  const resolution = resolveStartActivity(startView() as never, startCommand() as never);
  if (!resolution.ok) throw new Error("fixture start must resolve");
  return resolution;
}

function completeCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmd-complete-1",
    branchId: "branch-1",
    expectedVersion: 1,
    idempotencyKey: "complete-key-1",
    principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] },
    submittedAtWallClock: "2026-07-17T12:30:00.000Z",
    correlationId: "corr-1",
    type: "complete_activity",
    schemaVersion: 1,
    payload: { activityInstanceId: deriveActivityId("branch-1", "cmd-start-1") },
    ...overrides,
  };
}

function completeView(overrides: Record<string, unknown> = {}) {
  return {
    worldId: "world-1",
    branchId: "branch-1",
    rulesetVersion: "gate3-test-v1",
    headSequence: 2,
    storySecond: SEED_SECOND + 1_800,
    activity: acceptedStart().activity,
    zoneLocationId: "loc-home",
    noticeability: "obvious",
    coLocatedActorIds: ["actor-2"],
    ...overrides,
  };
}

describe("E3.2 resolveCompleteActivity", () => {
  it("completes an active activity at its due second", () => {
    const resolution = resolveCompleteActivity(completeView() as never, completeCommand() as never);
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.event.payload.completedAt).toBe(SEED_SECOND + 1_800);
    expect(resolution.event.payload.observerActorIds).toEqual(["actor-1", "actor-2"]);
    expect(resolution.activity.phase).toBe("completed");
    expect(resolution.activity.progressFixedPoint).toBe(1_000_000);
  });

  it("re-validates at fire time and treats early firing as corruption", () => {
    const cancelled = { ...acceptedStart().activity, phase: "cancelled" as const };
    const stale = resolveCompleteActivity(completeView({ activity: cancelled }) as never, completeCommand() as never);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("activity_not_active");

    const player = resolveCompleteActivity(
      completeView() as never,
      completeCommand({ principal: { kind: "player", principalId: "p", controlledActorIds: [] } }) as never,
    );
    expect(player.ok).toBe(false);
    if (!player.ok) expect(player.code).toBe("unauthorized_principal");

    expect(() =>
      resolveCompleteActivity(completeView({ storySecond: SEED_SECOND + 1_799 }) as never, completeCommand() as never),
    ).toThrow(/before its due/u);
  });
});

describe("E3.2 resolveCancelActivity", () => {
  function cancelCommand(overrides: Record<string, unknown> = {}) {
    return {
      id: "cmd-cancel-1",
      branchId: "branch-1",
      expectedVersion: 1,
      idempotencyKey: "cancel-key-1",
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: ["actor-1"] },
      submittedAtWallClock: "2026-07-17T12:10:00.000Z",
      correlationId: "corr-1",
      type: "cancel_activity",
      schemaVersion: 1,
      payload: { activityInstanceId: deriveActivityId("branch-1", "cmd-start-1"), reason: "actor_choice" },
      ...overrides,
    };
  }

  it("cancels a running activity for a controlling principal", () => {
    const resolution = resolveCancelActivity(
      completeView({ storySecond: SEED_SECOND + 600, interruptibility: "pausable" }) as never,
      cancelCommand() as never,
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.activity.phase).toBe("cancelled");
    expect(resolution.event.payload.reason).toBe("actor_choice");
  });

  it("refuses locked actions, strangers, and terminal phases", () => {
    const locked = resolveCancelActivity(
      completeView({ interruptibility: "locked" }) as never,
      cancelCommand() as never,
    );
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.code).toBe("activity_not_cancellable");

    const stranger = resolveCancelActivity(
      completeView() as never,
      cancelCommand({ principal: { kind: "player", principalId: "p2", controlledActorIds: ["actor-9"] } }) as never,
    );
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.code).toBe("unauthorized_actor");

    const done = resolveCancelActivity(
      completeView({ activity: { ...acceptedStart().activity, phase: "completed" as const } }) as never,
      cancelCommand() as never,
    );
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.code).toBe("activity_not_cancellable");
  });
});

describe("E3.2 activities replay", () => {
  function lifecycleEvents(): SimulationBranchEvent[] {
    const start = acceptedStart();
    const complete = resolveCompleteActivity(completeView() as never, completeCommand() as never);
    if (!complete.ok) throw new Error("fixture completion must resolve");
    return [...start.events, { ...complete.event, sequence: 3 }] as SimulationBranchEvent[];
  }

  it("folds the full stream back to the completed activity", () => {
    const replayed = replayActivitiesHistory({
      seed: emptyActivitiesSeed("branch-1", SEED_SECOND),
      events: lifecycleEvents(),
    });
    expect(replayed.headSequence).toBe(3);
    expect(replayed.version).toBe(2);
    expect(replayed.activities).toHaveLength(1);
    expect(replayed.activities[0]?.phase).toBe("completed");
    expect(replayed.activities[0]?.progressFixedPoint).toBe(1_000_000);
  });

  it("matches an event-at-a-time fold", () => {
    const events = lifecycleEvents();
    const wholesale = replayActivitiesHistory({ seed: emptyActivitiesSeed("branch-1", SEED_SECOND), events });
    let stepwise = emptyActivitiesSeed("branch-1", SEED_SECOND);
    for (const event of events) stepwise = applyActivityEvent(stepwise, event);
    expect(simulationHash({ ...wholesale, version: 0 })).toBe(simulationHash({ ...stepwise, version: 0 }));
  });

  it("rejects an illegal phase transition", () => {
    const events = lifecycleEvents();
    const completedTwice = [...events, { ...events[2], sequence: 4 }] as SimulationBranchEvent[];
    expect(() =>
      replayActivitiesHistory({ seed: emptyActivitiesSeed("branch-1", SEED_SECOND), events: completedTwice }),
    ).toThrow(/Illegal activity transition/u);
  });

  it("keeps the transition table total over all phases", () => {
    for (const [phase, nexts] of Object.entries(activityPhaseTransitions)) {
      expect(Array.isArray(nexts), phase).toBe(true);
    }
    expect(activityPhaseTransitions.completed).toEqual([]);
    expect(activityPhaseTransitions.failed).toEqual([]);
    expect(activityPhaseTransitions.cancelled).toEqual([]);
  });
});
