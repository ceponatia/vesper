import { describe, expect, it } from "vitest";
import {
  activityClaimsConflict,
  activityPhases,
  activityPhaseTransitions,
  claimHoldingActivityPhases,
  simulationActionDefinitionSchema,
  type ActionResourceCost,
  type ActivityPhase,
  type SimulationActionDefinition,
} from "@/contracts/simulation/activities";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import {
  itemLocusSchema,
  simulationMaterialItemSchema,
  type ItemLocus,
  type SimulationMaterialItem,
  type SimulationMaterialItemInput,
} from "@/contracts/simulation/materials";
import {
  bodyMeterDefinitionSchema,
  bodyMeterStateSchema,
  type BodyMeterDefinition,
} from "@/contracts/simulation/bodies";
import {
  itemConditionMeterStateSchema,
  itemConditionRegistryV1,
  itemConditionRegistryVersion,
} from "@/contracts/simulation/material-condition";
import { simulationHash } from "./hash";
import { applyBodyEvent, emptyBodiesSeed } from "./bodies";
import type { ItemConditionView } from "./material-condition";
import {
  applyMaterialEvent,
  materialsSeedProjection,
  resolveTransferItemFromView,
  type ConsumptionBodyView,
  type MaterialResolutionView,
} from "./materials";
import {
  activityCompletionUniquenessKey,
  applyActivityEvent,
  deriveActivityId,
  emptyActivitiesSeed,
  heldClaimsForActor,
  replayActivitiesHistory,
  resolveCancelActivity,
  resolveCompleteActivity,
  resolveResumeActivity,
  resolveStartActivity,
  sortActivitiesProjection,
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

// ---------------------------------------------------------------------------
// E5.3 slice 2 fixtures — material items and bodies (§26.5–26.6)
// ---------------------------------------------------------------------------

const heldBy = (actorId: string): ItemLocus => itemLocusSchema.parse({ kind: "held", actorId });
const atZone = (zoneId: string): ItemLocus => itemLocusSchema.parse({ kind: "zone", zoneId });

function materialItem(input: Partial<SimulationMaterialItemInput> & { id: string }): SimulationMaterialItem {
  return simulationMaterialItemSchema.parse({
    name: input.id,
    materialKindKey: "herb",
    locus: heldBy("actor-1"),
    ...input,
  });
}

/** A minimal §26.5 material view over a fixed item set, with optional reservations. */
function materialLookup(
  items: readonly SimulationMaterialItem[],
  reservedBy: Record<string, string> = {},
): {
  materialItemIds: string[];
  materialItemById: (itemId: string) => SimulationMaterialItem | undefined;
  reservingActivityId: (itemId: string) => string | null;
} {
  const byId = new Map(items.map((item) => [item.id, item]));
  return {
    materialItemIds: items.map((item) => item.id),
    materialItemById: (itemId) => byId.get(itemId as never),
    reservingActivityId: (itemId) => reservedBy[itemId] ?? null,
  };
}

function cost(overrides: Partial<ActionResourceCost> = {}): ActionResourceCost {
  return { materialKindKey: "herb", quantity: 1, disposition: "consume", useConditionDeltas: [], ...overrides };
}

function hungerDefinition(overrides: Partial<BodyMeterDefinition> = {}): BodyMeterDefinition {
  return bodyMeterDefinitionSchema.parse({
    key: "hunger",
    class: "rate",
    driftLaw: {
      kind: "linear",
      ratePerHourFixedPoint: 150,
      target: { kind: "fixed", valueFixedPoint: 0 },
    },
    initialFixedPoint: 9_000,
    baselineFixedPoint: 0,
    thresholds: [],
    ...overrides,
  });
}

function hungerBodyView(
  definition: BodyMeterDefinition,
  actorId: string,
  storySecond: number,
): ConsumptionBodyView {
  const state = bodyMeterStateSchema.parse({
    actorId,
    meterKey: definition.key,
    valueFixedPoint: definition.initialFixedPoint,
    baselineFixedPoint: definition.baselineFixedPoint,
    lastIntegratedAtStorySecond: storySecond,
    registryVersion: "body-v1",
  });
  return {
    bodyInitialized: true,
    meterView: (meterKey) => (meterKey === definition.key ? { definition, state, modifiers: [] } : undefined),
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

/** A fixture start whose definition carries §26.5 resource costs over a fixed item set. */
function acceptedStartWithCost(resourceCosts: ActionResourceCost[], items: readonly SimulationMaterialItem[]) {
  const resolution = resolveStartActivity(
    startView({
      definition: definition({ resourceCosts }),
      ...materialLookup(items),
    }) as never,
    startCommand() as never,
  );
  if (!resolution.ok) throw new Error(`fixture start-with-cost must resolve, got ${resolution.code}`);
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
    expect(resolution.events).toHaveLength(1);
    const [completedEvent] = resolution.events;
    expect(completedEvent.payload.completedAt).toBe(SEED_SECOND + 1_800);
    expect(completedEvent.payload.observerActorIds).toEqual(["actor-1", "actor-2"]);
    expect(completedEvent.payload.consumedItemIds).toEqual([]);
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

describe("E5.2 resolveResumeActivity — the attempt-versioned re-arm", () => {
  function interruptedActivity() {
    // Started at SEED, due at SEED+1800, interrupted halfway (progress 50%).
    return {
      ...acceptedStart().activity,
      phase: "interrupted" as const,
      progressFixedPoint: 500_000,
    };
  }

  function resumeCommand(overrides: Record<string, unknown> = {}) {
    return {
      id: "cmd-resume-1",
      branchId: "branch-1",
      expectedVersion: 3,
      idempotencyKey: "resume-key-1",
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: ["actor-1"] },
      submittedAtWallClock: "2026-07-19T12:00:00.000Z",
      correlationId: "corr-1",
      type: "resume_activity",
      schemaVersion: 1,
      payload: { activityInstanceId: deriveActivityId("branch-1", "cmd-start-1") },
      ...overrides,
    };
  }

  it("resumes with remaining time, a rebased window, and a versioned alarm key", () => {
    const resumedAt = SEED_SECOND + 4_000;
    const resolution = resolveResumeActivity(
      completeView({ storySecond: resumedAt, activity: interruptedActivity(), headSequence: 4 }) as never,
      resumeCommand() as never,
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    // Half of the 1 800s total remained.
    expect(resolution.activity.expectedCompleteAt).toBe(resumedAt + 900);
    // The window rebases so a second interruption's progress math holds.
    expect(resolution.activity.startedAt).toBe(resumedAt + 900 - 1_800);
    expect(resolution.activity.phase).toBe("active");
    const [resumedEvent, trigger] = resolution.events;
    expect(resumedEvent.payload.newExpectedCompleteAt).toBe(resumedAt + 900);
    // The E3.4 note landed: the re-armed key versions by attempt, and the
    // original un-versioned key is a strict prefix of it.
    expect(trigger.payload.uniquenessKey).toContain(String(resumedEvent.sequence));
    expect(
      trigger.payload.uniquenessKey.startsWith(
        activityCompletionUniquenessKey(resolution.activity.id),
      ),
    ).toBe(true);
    expect(trigger.payload.dueStorySecond).toBe(resumedAt + 900);

    // The applier lands on the same rebased window (replay parity).
    const projection = applyActivityEvent(
      sortActivitiesProjection({
        branchId: "branch-1",
        headSequence: resumedEvent.sequence - 1,
        version: 0,
        storySecond: resumedAt,
        activities: [interruptedActivity()],
      }),
      resumedEvent,
    );
    expect(projection.activities[0]).toMatchObject({
      phase: "active",
      startedAt: resolution.activity.startedAt,
      expectedCompleteAt: resolution.activity.expectedCompleteAt,
    });
  });

  it("rejects non-interrupted activities and non-participants", () => {
    const active = resolveResumeActivity(
      completeView({ storySecond: SEED_SECOND + 4_000 }) as never,
      resumeCommand() as never,
    );
    expect(active.ok).toBe(false);
    if (!active.ok) expect(active.code).toBe("activity_not_interrupted");

    const stranger = resolveResumeActivity(
      completeView({ storySecond: SEED_SECOND + 4_000, activity: interruptedActivity() }) as never,
      resumeCommand({
        principal: { kind: "player", principalId: "p", controlledActorIds: ["actor-9"] },
      }) as never,
    );
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.code).toBe("unauthorized_actor");
  });
});

describe("E3.2 activities replay", () => {
  function lifecycleEvents(): SimulationBranchEvent[] {
    const start = acceptedStart();
    const complete = resolveCompleteActivity(completeView() as never, completeCommand() as never);
    if (!complete.ok) throw new Error("fixture completion must resolve");
    return [...start.events, { ...complete.events[0], sequence: 3 }] as SimulationBranchEvent[];
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

describe("E5.3 slice 2 — resolveStartActivity resource reservation (§26.5)", () => {
  it("selects deterministically: actor-held items first, lexicographic tie-break, spanning into zone-rooted items", () => {
    const items = [
      materialItem({ id: "herb-y", locus: heldBy("actor-1") }),
      materialItem({ id: "herb-z", locus: heldBy("actor-1") }),
      materialItem({ id: "herb-a", locus: atZone("zone-a") }),
      materialItem({ id: "herb-b", locus: atZone("zone-a") }),
    ];
    const view = startView({
      definition: definition({ resourceCosts: [cost({ quantity: 3 })] }),
      ...materialLookup(items),
    });
    const resolution = resolveStartActivity(view as never, startCommand() as never);
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    const [started] = resolution.events;
    // A naive whole-set lexicographic sort would pick herb-a, herb-b, herb-y
    // (the three smallest ids). Actor-rooted items win regardless of raw id
    // order, so herb-y and herb-z (held) are picked before herb-b (zone) —
    // only herb-a (the lexicographically first zone item) fills the gap.
    expect(started.payload.reservedItemIds).toEqual(["herb-a", "herb-y", "herb-z"]);
    expect(resolution.activity.reservedItemIds).toEqual(["herb-a", "herb-y", "herb-z"]);
  });

  it("rejects with material_unavailable, naming the material kind, on shortfall", () => {
    const items = [materialItem({ id: "herb-a", locus: heldBy("actor-1") })];
    const view = startView({
      definition: definition({ resourceCosts: [cost({ quantity: 2, materialKindKey: "herb" })] }),
      ...materialLookup(items),
    });
    const resolution = resolveStartActivity(view as never, startCommand() as never);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.code).toBe("material_unavailable");
      expect(resolution.publicReason).toContain("herb");
    }
  });

  it("excludes items already reserved by a live activity, of the wrong kind, or gone", () => {
    const items = [
      materialItem({ id: "herb-a", locus: heldBy("actor-1") }),
      materialItem({ id: "herb-b", locus: heldBy("actor-1"), materialKindKey: "spice" }),
      materialItem({ id: "herb-c", locus: { kind: "gone", basis: "lost" } }),
      materialItem({ id: "herb-d", locus: heldBy("actor-1") }),
    ];
    const view = startView({
      definition: definition({ resourceCosts: [cost({ quantity: 1 })] }),
      ...materialLookup(items, { "herb-a": "activity-other" }),
    });
    const resolution = resolveStartActivity(view as never, startCommand() as never);
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.activity.reservedItemIds).toEqual(["herb-d"]);
  });

  it("defaults to no reservation when the definition has no resource costs", () => {
    const resolution = resolveStartActivity(startView() as never, startCommand() as never);
    if (!resolution.ok) throw new Error("expected acceptance");
    expect(resolution.activity.reservedItemIds).toEqual([]);
    expect(resolution.events[0].payload.reservedItemIds).toEqual([]);
  });
});

describe("E5.3 slice 2 — resolveCompleteActivity consumption (§26.6)", () => {
  it("re-validates fire-time and throws corruption errors rather than rejecting", () => {
    const items = [materialItem({ id: "herb-a", locus: heldBy("actor-1") })];
    const started = acceptedStartWithCost([cost({ quantity: 1 })], items);

    expect(() =>
      resolveCompleteActivity(
        completeView({
          activity: started.activity,
          resourceCosts: [cost({ quantity: 1 })],
          materialItemById: () => undefined,
        }) as never,
        completeCommand() as never,
      ),
    ).toThrow(/missing or gone/u);

    const goneItem = materialItem({ id: "herb-a", locus: { kind: "gone", basis: "lost" } });
    expect(() =>
      resolveCompleteActivity(
        completeView({
          activity: started.activity,
          resourceCosts: [cost({ quantity: 1 })],
          materialItemById: () => goneItem,
        }) as never,
        completeCommand() as never,
      ),
    ).toThrow(/missing or gone/u);

    const movedItem = materialItem({ id: "herb-a", locus: heldBy("actor-9") });
    expect(() =>
      resolveCompleteActivity(
        completeView({
          activity: started.activity,
          resourceCosts: [cost({ quantity: 1 })],
          materialItemById: () => movedItem,
        }) as never,
        completeCommand() as never,
      ),
    ).toThrow(/no longer root-locates/u);
  });

  it("throws when reserved items don't cover a cost's quantity (definition/reservation mismatch)", () => {
    const items = [materialItem({ id: "herb-a", locus: heldBy("actor-1") })];
    const started = acceptedStartWithCost([cost({ quantity: 1 })], items);
    expect(() =>
      resolveCompleteActivity(
        completeView({
          activity: started.activity,
          resourceCosts: [cost({ quantity: 2 })],
          materialItemById: materialLookup(items).materialItemById,
        }) as never,
        completeCommand() as never,
      ),
    ).toThrow(/without enough reserved/u);
  });

  it("consumes: consumedItemIds captured, item_consumed chained to activity_completed, body effects chained to their own item_consumed", () => {
    const bodyDefinition = hungerDefinition();
    const consumable = materialItem({
      id: "herb-a",
      locus: heldBy("actor-1"),
      consumptionEffects: [
        { meterKey: "hunger", sourceKind: "meal", operation: { kind: "set", valueFixedPoint: 9_500 } },
      ],
    });
    const started = acceptedStartWithCost([cost({ quantity: 1 })], [consumable]);
    const completedAt = SEED_SECOND + 1_800;

    const resolution = resolveCompleteActivity(
      completeView({
        activity: started.activity,
        resourceCosts: [cost({ quantity: 1 })],
        materialItemById: () => consumable,
        bodyView: hungerBodyView(bodyDefinition, "actor-1", completedAt),
      }) as never,
      completeCommand() as never,
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);

    const [completedEvent, itemConsumedEvent, sourceEvent, ...rest] = resolution.events;
    expect(completedEvent.payload.consumedItemIds).toEqual(["herb-a"]);
    expect(itemConsumedEvent?.type).toBe("item_consumed");
    expect(itemConsumedEvent?.causationId).toBe(completedEvent.id);
    if (itemConsumedEvent?.type !== "item_consumed") throw new Error("expected item_consumed");
    expect(itemConsumedEvent.payload).toMatchObject({ actorId: "actor-1", itemId: "herb-a" });

    expect(sourceEvent?.type).toBe("body_source_applied");
    expect(sourceEvent?.causationId).toBe(itemConsumedEvent.id);
    if (sourceEvent?.type !== "body_source_applied") throw new Error("expected body_source_applied");
    expect(sourceEvent.payload).toMatchObject({ meterKey: "hunger", valueAfterFixedPoint: 9_500 });

    // This fixture's hunger meter carries no threshold, so no re-arm trails.
    expect(rest).toEqual([]);
    expect(resolution.meterUpdates).toHaveLength(1);
    expect(resolution.meterUpdates[0]?.valueFixedPoint).toBe(9_500);

    const sequences = resolution.events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("emits no body events when the actor has no initialized body — worlds without bodies still eat", () => {
    const consumable = materialItem({
      id: "herb-a",
      locus: heldBy("actor-1"),
      consumptionEffects: [
        { meterKey: "hunger", sourceKind: "meal", operation: { kind: "set", valueFixedPoint: 9_500 } },
      ],
    });
    const started = acceptedStartWithCost([cost({ quantity: 1 })], [consumable]);
    const resolution = resolveCompleteActivity(
      completeView({
        activity: started.activity,
        resourceCosts: [cost({ quantity: 1 })],
        materialItemById: () => consumable,
      }) as never,
      completeCommand() as never,
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.events).toHaveLength(2); // activity_completed + item_consumed only
    expect(resolution.meterUpdates).toEqual([]);
  });

  it("releases use-disposition items without consuming them", () => {
    const usable = materialItem({ id: "tool-a", materialKindKey: "tool", locus: heldBy("actor-1") });
    const usedCost = cost({ materialKindKey: "tool", quantity: 1, disposition: "use" });
    const started = acceptedStartWithCost([usedCost], [usable]);
    expect(started.activity.reservedItemIds).toEqual(["tool-a"]);

    const resolution = resolveCompleteActivity(
      completeView({
        activity: started.activity,
        resourceCosts: [usedCost],
        materialItemById: () => usable,
      }) as never,
      completeCommand() as never,
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.events).toHaveLength(1);
    expect(resolution.events[0].payload.consumedItemIds).toEqual([]);
    expect(claimHoldingActivityPhases.includes(resolution.activity.phase)).toBe(false);
  });

  it("replay parity: the full start→complete→consume arc folds through each family's projector to matching state", () => {
    const bodyDefinition = hungerDefinition();
    const consumable = materialItem({
      id: "herb-a",
      locus: heldBy("actor-1"),
      consumptionEffects: [
        { meterKey: "hunger", sourceKind: "meal", operation: { kind: "set", valueFixedPoint: 9_500 } },
      ],
    });
    const started = acceptedStartWithCost([cost({ quantity: 1 })], [consumable]);
    const completedAt = SEED_SECOND + 1_800;
    const completion = resolveCompleteActivity(
      completeView({
        activity: started.activity,
        resourceCosts: [cost({ quantity: 1 })],
        materialItemById: () => consumable,
        bodyView: hungerBodyView(bodyDefinition, "actor-1", completedAt),
      }) as never,
      completeCommand() as never,
    );
    if (!completion.ok) throw new Error(`expected acceptance, got ${completion.code}`);

    // The full branch-ordered stream every projector folds — each family
    // handles its own events and passes every other event through as a bare
    // boundary advance, exactly like the live branch's one ordered stream.
    const fullStream = [...started.events, ...completion.events] as SimulationBranchEvent[];

    let activities = emptyActivitiesSeed("branch-1", SEED_SECOND);
    for (const event of fullStream) activities = applyActivityEvent(activities, event);
    expect(activities.activities[0]?.phase).toBe("completed");
    expect(activities.activities[0]?.reservedItemIds).toEqual(["herb-a"]);

    const materialSeed = materialsSeedProjection({
      worldId: "world-1",
      worldTypeId: "world-type-1",
      worldSeed: "seed-activity-consume",
      branchId: "branch-1",
      rulesetVersion: "gate3-test-v1",
      originStorySecond: SEED_SECOND,
      actors: [{ id: "actor-1", name: "Actor One" }],
      items: [consumable],
    });
    let materials = materialSeed;
    for (const event of fullStream) materials = applyMaterialEvent(materials, event);
    expect(materials.items.find((item) => item.id === "herb-a")?.locus).toEqual({
      kind: "gone",
      basis: "consumed",
    });

    const initialMeterState = bodyMeterStateSchema.parse({
      actorId: "actor-1",
      meterKey: "hunger",
      valueFixedPoint: bodyDefinition.initialFixedPoint,
      baselineFixedPoint: bodyDefinition.baselineFixedPoint,
      lastIntegratedAtStorySecond: completedAt,
      registryVersion: "body-v1",
    });
    let bodies = { ...emptyBodiesSeed("branch-1", SEED_SECOND), meters: [initialMeterState] };
    for (const event of fullStream) bodies = applyBodyEvent(bodies, event);
    expect(bodies.meters.find((meter) => meter.meterKey === "hunger")?.valueFixedPoint).toBe(9_500);
  });
});

describe("E5.3 slice 3 — resolveCompleteActivity use-condition deltas (§26.7)", () => {
  function conditionView(itemId: string, wearValue = 0): ItemConditionView {
    return {
      itemId,
      registryVersion: itemConditionRegistryVersion,
      meters: itemConditionRegistryV1.map((meterDefinition) =>
        itemConditionMeterStateSchema.parse({
          itemId,
          meterKey: meterDefinition.key,
          valueFixedPoint: meterDefinition.key === "wear" ? wearValue : meterDefinition.initialFixedPoint,
          baselineFixedPoint: meterDefinition.baselineFixedPoint,
          lastIntegratedAtStorySecond: SEED_SECOND,
          registryVersion: itemConditionRegistryVersion,
        }),
      ),
      modifiers: [],
    };
  }

  it("applies use-condition deltas to a tracked use-disposition item, joining the train after consumption events", () => {
    const consumable = materialItem({
      id: "herb-a",
      locus: heldBy("actor-1"),
      consumptionEffects: [
        { meterKey: "hunger", sourceKind: "meal", operation: { kind: "set", valueFixedPoint: 9_500 } },
      ],
    });
    const tool = materialItem({
      id: "tool-a",
      materialKindKey: "tool",
      conditionTracked: true,
      locus: heldBy("actor-1"),
    });
    const consumeCost = cost({ quantity: 1 });
    const useCost = cost({
      materialKindKey: "tool",
      quantity: 1,
      disposition: "use",
      useConditionDeltas: [{ meterKey: "wear", deltaFixedPoint: 500 }],
    });
    const started = acceptedStartWithCost([consumeCost, useCost], [consumable, tool]);
    const bodyDefinition = hungerDefinition();
    const completedAt = SEED_SECOND + 1_800;

    const resolution = resolveCompleteActivity(
      completeView({
        activity: started.activity,
        resourceCosts: [consumeCost, useCost],
        materialItemById: (itemId: string) =>
          itemId === "herb-a" ? consumable : itemId === "tool-a" ? tool : undefined,
        bodyView: hungerBodyView(bodyDefinition, "actor-1", completedAt),
        itemConditionViewByItemId: (itemId: string) => (itemId === "tool-a" ? conditionView("tool-a") : undefined),
      }) as never,
      completeCommand() as never,
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    const [completedEvent, itemConsumedEvent, hungerSource, useSource, ...rest] = resolution.events;
    expect(completedEvent.payload.consumedItemIds).toEqual(["herb-a"]);
    expect(itemConsumedEvent?.type).toBe("item_consumed");
    expect(hungerSource?.type).toBe("body_source_applied");
    expect(useSource?.type).toBe("item_condition_source_applied");
    if (useSource?.type !== "item_condition_source_applied") {
      throw new Error("expected item_condition_source_applied");
    }
    expect(useSource.payload).toMatchObject({
      itemId: "tool-a",
      meterKey: "wear",
      sourceKind: "use",
      valueAfterFixedPoint: 500,
    });
    expect(useSource.causationId).toBe(completedEvent.id);
    expect(rest).toEqual([]);
    expect(resolution.meterUpdates).toHaveLength(1);

    const sequences = resolution.events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("skips untracked use-disposition items entirely", () => {
    const plain = materialItem({ id: "tool-b", materialKindKey: "tool", locus: heldBy("actor-1") });
    const useCost = cost({
      materialKindKey: "tool",
      quantity: 1,
      disposition: "use",
      useConditionDeltas: [{ meterKey: "wear", deltaFixedPoint: 500 }],
    });
    const started = acceptedStartWithCost([useCost], [plain]);
    const resolution = resolveCompleteActivity(
      completeView({
        activity: started.activity,
        resourceCosts: [useCost],
        materialItemById: () => plain,
        itemConditionViewByItemId: () => conditionView("tool-b"),
      }) as never,
      completeCommand() as never,
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    // `plain` never set conditionTracked (defaults false) — no use-delta events.
    expect(resolution.events).toHaveLength(1);
  });

  it("a delta that instantly crosses worn_out emits the threshold-crossed event, causation-chained to the source write", () => {
    const wornTool = materialItem({
      id: "tool-c",
      materialKindKey: "tool",
      conditionTracked: true,
      locus: heldBy("actor-1"),
    });
    const useCost = cost({
      materialKindKey: "tool",
      quantity: 1,
      disposition: "use",
      useConditionDeltas: [{ meterKey: "wear", deltaFixedPoint: 6_000 }],
    });
    const started = acceptedStartWithCost([useCost], [wornTool]);
    const resolution = resolveCompleteActivity(
      completeView({
        activity: started.activity,
        resourceCosts: [useCost],
        materialItemById: () => wornTool,
        itemConditionViewByItemId: () => conditionView("tool-c", 3_000),
        coLocatedActorIds: ["actor-2"],
      }) as never,
      completeCommand() as never,
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    const [, useSource, crossed] = resolution.events;
    expect(useSource?.type).toBe("item_condition_source_applied");
    expect(crossed?.type).toBe("item_condition_threshold_crossed");
    if (crossed?.type !== "item_condition_threshold_crossed") throw new Error("expected threshold crossed");
    expect(crossed.payload).toMatchObject({
      itemId: "tool-c",
      meterKey: "wear",
      thresholdKey: "worn_out",
      valueFixedPoint: 9_000,
    });
    expect(crossed.causationId).toBe(useSource?.id);
  });
});

describe("E5.3 slice 2 — reservation lives across claim-holding phases, releases terminally (§26.5)", () => {
  function reservationBlocked(activity: {
    id: string;
    phase: ActivityPhase;
    reservedItemIds: readonly string[];
  }): (itemId: string) => string | null {
    return (itemId) =>
      claimHoldingActivityPhases.includes(activity.phase) && activity.reservedItemIds.includes(itemId as never)
        ? activity.id
        : null;
  }

  function transferView(
    item: SimulationMaterialItem,
    reservingActivityId: (itemId: string) => string | null,
  ): MaterialResolutionView {
    return {
      worldId: "world-1",
      branchId: "branch-1",
      rulesetVersion: "gate3-test-v1",
      version: 0,
      headSequence: 0,
      storySecond: SEED_SECOND,
      actorById: (id) => (id === "actor-1" || id === "actor-2" ? { id, name: id } : undefined),
      actorZoneId: () => "zone-a",
      actorLocationId: () => "loc-home",
      itemById: (id) => (id === item.id ? item : undefined),
      containerOccupantCount: () => 0,
      reservingActivityId,
    };
  }

  function tryTransfer(item: SimulationMaterialItem, reservingActivityId: (itemId: string) => string | null) {
    return resolveTransferItemFromView(transferView(item, reservingActivityId), {
      id: "cmd-t",
      branchId: "branch-1",
      expectedVersion: 0,
      idempotencyKey: "idem-t",
      principal: { kind: "player", principalId: "p", controlledActorIds: ["actor-1"] },
      submittedAtWallClock: "2026-07-19T12:00:00.000Z",
      type: "transfer_item",
      schemaVersion: 2,
      correlationId: "corr-1",
      payload: {
        actorId: "actor-1",
        itemId: item.id,
        fromLocus: heldBy("actor-1"),
        toLocus: heldBy("actor-2"),
      },
    } as never);
  }

  it("blocks transfer through every claim-holding phase and releases at every terminal one", () => {
    const item = materialItem({ id: "herb-a", locus: heldBy("actor-1") });
    for (const phase of activityPhases) {
      const activity = { id: "activity-cooking", phase, reservedItemIds: ["herb-a"] };
      const result = tryTransfer(item, reservationBlocked(activity));
      if (claimHoldingActivityPhases.includes(phase)) {
        expect(result, phase).toMatchObject({ ok: false, code: "item_reserved" });
      } else {
        expect(result, phase).toMatchObject({ ok: true });
      }
    }
  });

  it("a real start→cancel arc: blocked while active, released once cancelled — transfer then succeeds", () => {
    const item = materialItem({ id: "herb-a", locus: heldBy("actor-1") });
    const started = acceptedStartWithCost([cost({ quantity: 1 })], [item]);
    expect(started.activity.reservedItemIds).toEqual(["herb-a"]);
    expect(tryTransfer(item, reservationBlocked(started.activity))).toMatchObject({
      ok: false,
      code: "item_reserved",
    });

    const cancelled = resolveCancelActivity(
      completeView({ activity: started.activity, storySecond: SEED_SECOND + 10 }) as never,
      {
        id: "cmd-cancel-1",
        branchId: "branch-1",
        expectedVersion: 1,
        idempotencyKey: "cancel-key-1",
        principal: { kind: "player", principalId: "principal-1", controlledActorIds: ["actor-1"] },
        submittedAtWallClock: "2026-07-19T12:10:00.000Z",
        correlationId: "corr-1",
        type: "cancel_activity",
        schemaVersion: 1,
        payload: { activityInstanceId: started.activity.id, reason: "actor_choice" },
      } as never,
    );
    if (!cancelled.ok) throw new Error(`expected acceptance, got ${cancelled.code}`);
    expect(tryTransfer(item, reservationBlocked(cancelled.activity))).toMatchObject({ ok: true });
  });

  it("interruption keeps the reservation (interrupted is claim-holding)", () => {
    const item = materialItem({ id: "herb-a", locus: heldBy("actor-1") });
    const started = acceptedStartWithCost([cost({ quantity: 1 })], [item]);
    const interrupted = { ...started.activity, phase: "interrupted" as const, progressFixedPoint: 500_000 };
    expect(tryTransfer(item, reservationBlocked(interrupted))).toMatchObject({
      ok: false,
      code: "item_reserved",
    });
  });
});
