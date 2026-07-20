import { describe, expect, it } from "vitest";
import { zoneIdSchema } from "@/contracts/simulation/identity";
import {
  actorLodRegistryVersion,
  actorLodStateSchema,
  assignActorLodCommandSchema,
  compareSimulationLods,
  isSimulationLodDemotion,
  type ActorLodState,
  type AssignActorLodCommand,
  type AssignActorLodCommandInput,
} from "@/contracts/simulation/lod";
import { buildMaterialLotInitializedEvent } from "./households";
import {
  applyActorLodEvent,
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

const noGuards: AssignActorLodGuardCounts = {
  claimHoldingActivityCount: 0,
  openPressureCount: 0,
  openEngagementCount: 0,
};

function view(overrides: Partial<AssignActorLodResolutionView> = {}): AssignActorLodResolutionView {
  return {
    worldId: WORLD,
    branchId: BRANCH,
    rulesetVersion: "ruleset-v1",
    headSequence: 7,
    storySecond: 3_600,
    actorExists: true,
    current: undefined,
    guards: noGuards,
    bodyInitialized: false,
    rhythmRows: [],
    ...overrides,
  };
}

function assignCmd(
  payload: AssignActorLodCommandInput["payload"],
  overrides: Partial<Pick<AssignActorLodCommandInput, "branchId" | "principal" | "id">> = {},
): AssignActorLodCommand {
  return assignActorLodCommandSchema.parse({
    id: overrides.id ?? "cmd-lod-1",
    branchId: overrides.branchId ?? BRANCH,
    expectedVersion: 0,
    idempotencyKey: "lod-key-1",
    principal: overrides.principal ?? {
      kind: "storyteller",
      principalId: "storyteller-1",
      controlledActorIds: [],
    },
    submittedAtWallClock: "2026-07-20T12:00:00.000Z",
    correlationId: "corr-1",
    type: "assign_actor_lod",
    schemaVersion: 1,
    payload,
  });
}

const assignedRow: ActorLodState = {
  actorId: MARA,
  simulationLod: "event",
  inferenceLod: "small_model",
  registryVersion: actorLodRegistryVersion,
  assignedAtStorySecond: 1_000,
} as ActorLodState;

describe("simulation LOD vocabulary (E6.1, §27.1)", () => {
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

describe("effectiveActorLod (E6.1, §27–28)", () => {
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
      view({ guards: { claimHoldingActivityCount: 1, openPressureCount: 1, openEngagementCount: 1 } }),
      assignCmd(payload),
    );
    expect(allBlocked).toMatchObject({ ok: false, code: "demotion_blocked_active_claims" });

    const pressureBlocked = resolveAssignActorLodFromView(
      view({ guards: { claimHoldingActivityCount: 0, openPressureCount: 1, openEngagementCount: 1 } }),
      assignCmd(payload),
    );
    expect(pressureBlocked).toMatchObject({ ok: false, code: "demotion_blocked_open_pressure" });

    const engagementBlocked = resolveAssignActorLodFromView(
      view({ guards: { claimHoldingActivityCount: 0, openPressureCount: 0, openEngagementCount: 1 } }),
      assignCmd(payload),
    );
    expect(engagementBlocked).toMatchObject({ ok: false, code: "demotion_blocked_open_engagement" });
  });

  it("never guards an inference-only change, even for an encumbered actor", () => {
    const result = resolveAssignActorLodFromView(
      view({ guards: { claimHoldingActivityCount: 2, openPressureCount: 1, openEngagementCount: 1 } }),
      assignCmd({ actorId: MARA, simulationLod: "exact", inferenceLod: "small_model" }),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("never guards a simulation promotion", () => {
    const result = resolveAssignActorLodFromView(
      view({
        current: assignedRow,
        guards: { claimHoldingActivityCount: 2, openPressureCount: 1, openEngagementCount: 1 },
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
});

describe("actor-LOD replay (E6.1)", () => {
  function acceptedEvent(
    payload: AssignActorLodCommandInput["payload"],
    sequence: number,
    commandId: string,
    current?: ActorLodState,
  ) {
    const resolution = resolveAssignActorLodFromView(
      view({ headSequence: sequence - 1, current }),
      assignCmd(payload, { id: commandId }),
    );
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    const event = resolution.events[0];
    if (event?.type !== "actor_lod_assigned") throw new Error("expected the lod event first");
    return { event, state: resolution.state };
  }

  it("folds assignments into one row per actor, a later assignment superseding", () => {
    const first = acceptedEvent({ actorId: MARA, simulationLod: "event", inferenceLod: "no_model" }, 1, "cmd-a");
    const second = acceptedEvent(
      { actorId: MARA, simulationLod: "exact", inferenceLod: "deliberator" },
      2,
      "cmd-b",
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
      view: { worldId: WORLD, branchId: BRANCH, rulesetVersion: "ruleset-v1", headSequence: 0, storySecond: 60 },
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
    const first = acceptedEvent({ actorId: MARA, simulationLod: "event", inferenceLod: "no_model" }, 2, "cmd-a");
    expect(() =>
      replayActorLodHistory({ seed: emptyActorLodsSeed(BRANCH, 0), events: [first.event] }),
    ).toThrow(/sequence gap/);
  });
});
