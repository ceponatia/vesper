import { describe, expect, it } from "vitest";
import { zoneIdSchema } from "../contracts/identity";
import {
  actorLodRegistryVersion,
  actorLodStateSchema,
  assignActorLodCommandSchema,
  compareSimulationLods,
  isSimulationLodDemotion,
  type ActorLodState,
  type AssignActorLodCommand,
  type AssignActorLodCommandInput,
} from "../contracts/lod";
import {
  bodyDerivationVersion,
  bodyMeterRegistryByVersion,
  bodyMeterStateSchema,
} from "../contracts/bodies";
import {
  bindSimEnvelopes,
  type CommandEnvelopeSpec,
  type TestPrincipal,
} from "../test-support/sim-envelopes";
import { buildMaterialLotInitializedEvent } from "./households";
import {
  applyActorLodEvent,
  buildDependencyWakeTrain,
  effectiveActorLod,
  emptyActorLodsSeed,
  replayActorLodHistory,
  resolveAssignActorLodFromView,
  type AssignActorLodGuardCounts,
  type AssignActorLodResolutionView,
} from "./lod";

const WORLD = "world-1";
const BRANCH = "branch-1";
const MARA = "mara";
const RULESET = "ruleset-v1";

/**
 * This suite carries its own ruleset, so bind the trio once: the view's
 * `branchId` must stay equal to the command's, or every resolver answers
 * `branch_mismatch` instead of the law under test.
 */
const env = bindSimEnvelopes({ worldId: WORLD, branchId: BRANCH, rulesetVersion: RULESET });

/** Everything a call site may override; `type`/`payload` are pinned by the builder. */
type CmdSpec = Omit<CommandEnvelopeSpec, "type" | "payload">;

/** The privileged default carries its own principal id, so it stays explicit. */
const STORYTELLER: TestPrincipal = {
  kind: "storyteller",
  principalId: "storyteller-1",
  controlledActorIds: [],
};

const noGuards: AssignActorLodGuardCounts = {
  claimHoldingActivityCount: 0,
  openPressureCount: 0,
  openEngagementCount: 0,
  activeConditionCount: 0,
};

function energyAlarmViews(): NonNullable<AssignActorLodResolutionView["bodyAlarmViews"]> {
  const definition = bodyMeterRegistryByVersion[bodyDerivationVersion].find(
    (candidate) => candidate.key === "energy",
  );
  if (!definition) throw new Error("energy definition missing");
  return {
    meterViews: [
      {
        definition,
        state: bodyMeterStateSchema.parse({
          actorId: MARA,
          meterKey: "energy",
          valueFixedPoint: 9_000,
          baselineFixedPoint: 0,
          lastIntegratedAtStorySecond: 3_600,
          registryVersion: bodyDerivationVersion,
        }),
        modifiers: [],
        scheduledAdjustments: [],
      },
    ],
    // A real last-wake makes escalation accumulate, so a collapse crossing
    // exists inside the solve horizon (a context without sleep history never
    // collapses — the assume-the-rhythm-was-followed law).
    collapseContext: { rhythmRows: [], lastSleepEndedAtStorySecond: 0 },
  };
}

function view(overrides: Partial<AssignActorLodResolutionView> = {}): AssignActorLodResolutionView {
  return {
    ...env.meta({ headSequence: 7, storySecond: 3_600 }),
    actorExists: true,
    current: undefined,
    guards: noGuards,
    bodyInitialized: false,
    rhythmRows: [],
    ...overrides,
  };
}

function assignCmd(payload: AssignActorLodCommandInput["payload"], spec: CmdSpec = {}): AssignActorLodCommand {
  return env.command(assignActorLodCommandSchema, {
    type: "assign_actor_lod",
    idSlug: "lod-1",
    principal: STORYTELLER,
    payload,
    ...spec,
  });
}

const assignedRow: ActorLodState = {
  actorId: MARA,
  simulationLod: "event",
  inferenceLod: "small_model",
  registryVersion: actorLodRegistryVersion,
  assignedAtStorySecond: 1_000,
} as ActorLodState;

describe("simulation LOD vocabulary (E6.1)", () => {
  it("ranks resolution most-detail-first in declaration order", () => {
    expect(compareSimulationLods("exact", "event")).toBeLessThan(0);
    expect(compareSimulationLods("event", "aggregate")).toBeLessThan(0);
    expect(compareSimulationLods("aggregate", "dormant")).toBeLessThan(0);
    expect(compareSimulationLods("dormant", "dormant")).toBe(0);
  });

  it("classifies only moves toward less resolution as demotions", () => {
    expect(isSimulationLodDemotion("exact", "event")).toBe(true);
    expect(isSimulationLodDemotion("exact", "dormant")).toBe(true);
    expect(isSimulationLodDemotion("event", "exact")).toBe(false);
    expect(isSimulationLodDemotion("event", "event")).toBe(false);
  });
});

describe("effectiveActorLod (E6.1)", () => {
  it("reads the registry defaults for an unassigned actor", () => {
    expect(effectiveActorLod(undefined)).toEqual({
      simulationLod: "exact",
      inferenceLod: "deliberator",
      source: "default",
      registryVersion: actorLodRegistryVersion,
    });
  });

  it("reads the assigned row when one exists", () => {
    expect(effectiveActorLod(assignedRow)).toEqual({
      simulationLod: "event",
      inferenceLod: "small_model",
      source: "assigned",
      registryVersion: actorLodRegistryVersion,
    });
  });
});

describe("resolveAssignActorLodFromView (E6.1)", () => {
  it("rejects a branch mismatch", () => {
    const result = resolveAssignActorLodFromView(
      view(),
      assignCmd({ actorId: MARA, simulationLod: "event", inferenceLod: "no_model" }, { branchId: "branch-2" }),
    );
    expect(result).toMatchObject({ ok: false, code: "branch_mismatch" });
  });

  it("rejects a non-privileged principal", () => {
    const result = resolveAssignActorLodFromView(
      view(),
      assignCmd(
        { actorId: MARA, simulationLod: "event", inferenceLod: "no_model" },
        { principal: { kind: "player", principalId: "player-1", controlledActorIds: [MARA] } },
      ),
    );
    expect(result).toMatchObject({ ok: false, code: "unauthorized_principal" });
  });

  it("rejects an unknown actor", () => {
    const result = resolveAssignActorLodFromView(
      view({ actorExists: false }),
      assignCmd({ actorId: "nobody", simulationLod: "event", inferenceLod: "no_model" }),
    );
    expect(result).toMatchObject({ ok: false, code: "actor_not_found" });
  });

  it("rejects assigning the values already in effect — including the pure defaults", () => {
    const result = resolveAssignActorLodFromView(
      view(),
      assignCmd({ actorId: MARA, simulationLod: "exact", inferenceLod: "deliberator" }),
    );
    expect(result).toMatchObject({ ok: false, code: "no_op" });
  });

  it("accepts a demotion for an unencumbered actor, capturing the replaced defaults", () => {
    const result = resolveAssignActorLodFromView(
      view(),
      assignCmd({ actorId: MARA, simulationLod: "event", inferenceLod: "no_model" }),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.state).toMatchObject({
      actorId: MARA,
      simulationLod: "event",
      inferenceLod: "no_model",
      assignedAtStorySecond: 3_600,
    });
    expect(result.events[0]).toMatchObject({
      type: "actor_lod_assigned",
      sequence: 8,
      actorIds: [MARA],
      payload: {
        previousSimulationLod: "exact",
        previousInferenceLod: "deliberator",
        previousWasDefault: true,
        registryVersion: actorLodRegistryVersion,
      },
    });
    // No tracked body — entering event LOD arms nothing (E6.2).
    expect(result.events).toHaveLength(1);
  });

  it("entering event LOD with a tracked body arms the routine alarm at the next bedtime (E6.2)", () => {
    const result = resolveAssignActorLodFromView(
      view({ bodyInitialized: true }),
      assignCmd({ actorId: MARA, simulationLod: "event", inferenceLod: "no_model" }),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.events).toHaveLength(2);
    const trigger = result.events[1];
    if (trigger?.type !== "trigger_scheduled") throw new Error("expected a trigger arm");
    if (trigger.payload.kind !== "routine_policy_due") throw new Error("expected the routine kind");
    // Default sleep window (no rhythm rows): bedtime 23:00 → second 82 800.
    expect(trigger.payload.dueStorySecond).toBe(23 * 3_600);
    expect(trigger.payload.command.payload).toMatchObject({ actorId: MARA, armedAtSequence: 9 });
  });

  it("leaving event LOD arms nothing", () => {
    const current = actorLodStateSchema.parse({
      actorId: MARA,
      simulationLod: "event",
      inferenceLod: "no_model",
      registryVersion: actorLodRegistryVersion,
      assignedAtStorySecond: 1_000,
    });
    const result = resolveAssignActorLodFromView(
      view({ bodyInitialized: true, current }),
      assignCmd({ actorId: MARA, simulationLod: "exact", inferenceLod: "deliberator" }),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.events).toHaveLength(1);
  });

  it("checks the demotion guards in fixed order: claims, then pressure, then engagement", () => {
    const payload = { actorId: MARA, simulationLod: "dormant", inferenceLod: "no_model" } as const;
    const allBlocked = resolveAssignActorLodFromView(
      view({
        guards: { ...noGuards, claimHoldingActivityCount: 1, openPressureCount: 1, openEngagementCount: 1 },
      }),
      assignCmd(payload),
    );
    expect(allBlocked).toMatchObject({ ok: false, code: "demotion_blocked_active_claims" });

    const pressureBlocked = resolveAssignActorLodFromView(
      view({ guards: { ...noGuards, openPressureCount: 1, openEngagementCount: 1 } }),
      assignCmd(payload),
    );
    expect(pressureBlocked).toMatchObject({ ok: false, code: "demotion_blocked_open_pressure" });

    const engagementBlocked = resolveAssignActorLodFromView(
      view({ guards: { ...noGuards, openEngagementCount: 1 } }),
      assignCmd(payload),
    );
    expect(engagementBlocked).toMatchObject({ ok: false, code: "demotion_blocked_open_engagement" });
  });

  it("never guards an inference-only change, even for an encumbered actor", () => {
    const result = resolveAssignActorLodFromView(
      view({
        guards: { ...noGuards, claimHoldingActivityCount: 2, openPressureCount: 1, openEngagementCount: 1 },
      }),
      assignCmd({ actorId: MARA, simulationLod: "exact", inferenceLod: "small_model" }),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("never guards a simulation promotion", () => {
    const result = resolveAssignActorLodFromView(
      view({
        current: assignedRow,
        guards: { ...noGuards, claimHoldingActivityCount: 2, openPressureCount: 1, openEngagementCount: 1 },
      }),
      assignCmd({ actorId: MARA, simulationLod: "exact", inferenceLod: "small_model" }),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.events[0]).toMatchObject({
      type: "actor_lod_assigned",
      payload: {
        previousSimulationLod: "event",
        previousInferenceLod: "small_model",
        previousWasDefault: false,
      },
    });
  });

  it("blocks landing below event with an active body condition, but never event or exact (E6.3)", () => {
    const asleepGuards = { ...noGuards, activeConditionCount: 1 };
    const dormantBlocked = resolveAssignActorLodFromView(
      view({ guards: asleepGuards, bodyInitialized: true }),
      assignCmd({ actorId: MARA, simulationLod: "dormant", inferenceLod: "no_model" }),
    );
    expect(dormantBlocked).toMatchObject({ ok: false, code: "demotion_blocked_active_condition" });

    const aggregateBlocked = resolveAssignActorLodFromView(
      view({ guards: asleepGuards, bodyInitialized: true }),
      assignCmd({ actorId: MARA, simulationLod: "aggregate", inferenceLod: "no_model" }),
    );
    expect(aggregateBlocked).toMatchObject({ ok: false, code: "demotion_blocked_active_condition" });

    // A sleeping actor may still move between exact and event freely.
    const eventAllowed = resolveAssignActorLodFromView(
      view({ guards: asleepGuards, bodyInitialized: true }),
      assignCmd({ actorId: MARA, simulationLod: "event", inferenceLod: "no_model" }),
    );
    expect(eventAllowed).toMatchObject({ ok: true });
  });

  it("re-arms the body alarms when the simulation axis moves and lands at event (E6.3)", () => {
    const result = resolveAssignActorLodFromView(
      view({ bodyInitialized: true, bodyAlarmViews: energyAlarmViews() }),
      assignCmd({ actorId: MARA, simulationLod: "event", inferenceLod: "no_model" }),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    const kinds = result.events.map((event) =>
      event.type === "trigger_scheduled" ? event.payload.kind : event.type,
    );
    // exact → event: lod event, threshold re-solve, collapse re-solve, routine arm.
    expect(kinds).toEqual([
      "actor_lod_assigned",
      "body_threshold_due",
      "body_collapse_due",
      "routine_policy_due",
    ]);
    // Sequences run contiguously from the lod event.
    expect(result.events.map((event) => event.sequence)).toEqual([8, 9, 10, 11]);
  });

  it("landing below event emits only the lod event — nothing arms (E6.3)", () => {
    const result = resolveAssignActorLodFromView(
      view({ bodyInitialized: true, bodyAlarmViews: energyAlarmViews() }),
      assignCmd({ actorId: MARA, simulationLod: "dormant", inferenceLod: "no_model" }),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe("actor_lod_assigned");
  });

  it("an inference-only change never touches body alarms (E6.3)", () => {
    const current = actorLodStateSchema.parse({
      actorId: MARA,
      simulationLod: "event",
      inferenceLod: "no_model",
      registryVersion: actorLodRegistryVersion,
      assignedAtStorySecond: 1_000,
    });
    const result = resolveAssignActorLodFromView(
      view({ current, bodyInitialized: true, bodyAlarmViews: energyAlarmViews() }),
      assignCmd({ actorId: MARA, simulationLod: "event", inferenceLod: "small_model" }),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    const kinds = result.events.map((event) =>
      event.type === "trigger_scheduled" ? event.payload.kind : event.type,
    );
    // Staying at event re-arms the routine alarm only.
    expect(kinds).toEqual(["actor_lod_assigned", "routine_policy_due"]);
  });
});

describe("buildDependencyWakeTrain (E6.4)", () => {
  const dormantRow = actorLodStateSchema.parse({
    actorId: MARA,
    simulationLod: "dormant",
    inferenceLod: "no_model",
    registryVersion: actorLodRegistryVersion,
    assignedAtStorySecond: 1_000,
  });
  const wakeCommand = {
    id: "cmd-open-1",
    correlationId: "corr-1",
    submittedAtWallClock: "2026-07-21T12:00:00.000Z",
  };

  it("wakes nobody who is not below event — no row (defaults), event, or exact", () => {
    expect(
      buildDependencyWakeTrain({ view: view(), current: undefined, command: wakeCommand, actorId: MARA, startSequence: 8 }),
    ).toBeUndefined();
    expect(
      buildDependencyWakeTrain({
        view: view(),
        current: actorLodStateSchema.parse({ ...dormantRow, simulationLod: "event" }),
        command: wakeCommand,
        actorId: MARA,
        startSequence: 8,
      }),
    ).toBeUndefined();
  });

  it("promotes a dormant actor to event, preserving the inference axis, with the full re-arm train", () => {
    const train = buildDependencyWakeTrain({
      view: view({ bodyInitialized: true, bodyAlarmViews: energyAlarmViews() }),
      current: dormantRow,
      command: wakeCommand,
      actorId: MARA,
      startSequence: 8,
    });
    if (!train) throw new Error("expected a wake train");
    const kinds = train.events.map((event) =>
      event.type === "trigger_scheduled" ? event.payload.kind : event.type,
    );
    expect(kinds).toEqual([
      "actor_lod_assigned",
      "body_threshold_due",
      "body_collapse_due",
      "routine_policy_due",
    ]);
    expect(train.events.map((event) => event.sequence)).toEqual([8, 9, 10, 11]);
    expect(train.events[0]).toMatchObject({
      payload: {
        simulationLod: "event",
        inferenceLod: "no_model",
        previousSimulationLod: "dormant",
        previousWasDefault: false,
      },
    });
    expect(train.state).toMatchObject({ simulationLod: "event", inferenceLod: "no_model" });
  });

  it("wakes a bodiless actor with the single lod event, and ids stay unique per actor", () => {
    const bare = buildDependencyWakeTrain({
      view: view(),
      current: dormantRow,
      command: wakeCommand,
      actorId: MARA,
      startSequence: 8,
    });
    if (!bare) throw new Error("expected a wake train");
    expect(bare.events).toHaveLength(1);

    const other = buildDependencyWakeTrain({
      view: view(),
      current: actorLodStateSchema.parse({ ...dormantRow, actorId: "riven" }),
      command: wakeCommand,
      actorId: "riven",
      startSequence: 9,
    });
    if (!other) throw new Error("expected a second wake train");
    // One command can wake many actors — the per-actor suffix keeps ids apart.
    expect(other.events[0]?.id).not.toBe(bare.events[0]?.id);
  });
});

describe("actor-LOD replay (E6.1)", () => {
  function acceptedEvent(
    payload: AssignActorLodCommandInput["payload"],
    sequence: number,
    idSlug: string,
    current?: ActorLodState,
  ) {
    const resolution = resolveAssignActorLodFromView(
      view({ headSequence: sequence - 1, current }),
      assignCmd(payload, { idSlug }),
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    const event = resolution.events[0];
    if (event?.type !== "actor_lod_assigned") throw new Error("expected the lod event first");
    return { event, state: resolution.state };
  }

  it("folds assignments into one row per actor, a later assignment superseding", () => {
    const first = acceptedEvent({ actorId: MARA, simulationLod: "event", inferenceLod: "no_model" }, 1, "a");
    const second = acceptedEvent(
      { actorId: MARA, simulationLod: "exact", inferenceLod: "deliberator" },
      2,
      "b",
      first.state,
    );
    const replayed = replayActorLodHistory({
      seed: emptyActorLodsSeed(BRANCH, 0),
      events: [first.event, second.event],
    });
    expect(replayed.lods).toHaveLength(1);
    expect(replayed.lods[0]).toMatchObject({
      actorId: MARA,
      simulationLod: "exact",
      inferenceLod: "deliberator",
    });
    expect(replayed.headSequence).toBe(2);
    expect(replayed.version).toBe(2);
  });

  it("advances the boundary without rows for a non-LOD event", () => {
    const other = buildMaterialLotInitializedEvent({
      view: env.meta({ headSequence: 0, storySecond: 60 }),
      command: { id: "cmd-lot", correlationId: "corr-1", submittedAtWallClock: "2026-07-20T12:00:00.000Z" },
      locus: { kind: "zone", zoneId: zoneIdSchema.parse("zone-a") },
      materialKindKey: "food",
      quantityKind: "count",
      sequence: 1,
    });
    const folded = applyActorLodEvent(emptyActorLodsSeed(BRANCH, 0), other);
    expect(folded.lods).toHaveLength(0);
    expect(folded.headSequence).toBe(1);
  });

  it("throws on a sequence gap", () => {
    const first = acceptedEvent({ actorId: MARA, simulationLod: "event", inferenceLod: "no_model" }, 2, "a");
    expect(() =>
      replayActorLodHistory({ seed: emptyActorLodsSeed(BRANCH, 0), events: [first.event] }),
    ).toThrow(/sequence gap/);
  });
});
