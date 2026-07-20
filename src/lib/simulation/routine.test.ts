import { describe, expect, it } from "vitest";
import {
  ROUTINE_HOLD_COMMITMENT_WEIGHT_FIXED_POINT,
  runRoutinePolicyCommandSchema,
  type RunRoutinePolicyCommand,
} from "@/contracts/simulation/routine";
import { actorLodReadSchema } from "@/contracts/simulation/lod";
import {
  bodyDerivationVersion,
  bodyMeterRegistryByVersion,
  bodyMeterStateSchema,
  bodyRhythmRowSchema,
  type BodyRhythmRow,
} from "@/contracts/simulation/bodies";
import { storySecondAt } from "./body-reads";
import type { MeterIntegrationView } from "./bodies";
import {
  nextBedtimeSecond,
  nextMinuteOfDayCrossingSecond,
  nextWakeSecond,
  resolveRunRoutinePolicyFromView,
  type RunRoutinePolicyResolutionView,
} from "./routine";

const WORLD = "world-1";
const BRANCH = "branch-1";
const MARA = "mara";

/** 23:00 → 07:00, the default geometry, authored explicitly. */
const sleepRhythm: BodyRhythmRow = bodyRhythmRowSchema.parse({
  actorId: MARA,
  kind: "sleep",
  startMinuteOfDay: 1_380,
  endMinuteOfDay: 420,
});

function energyView(): MeterIntegrationView {
  const definition = bodyMeterRegistryByVersion[bodyDerivationVersion].find(
    (candidate) => candidate.key === "energy",
  );
  if (!definition) throw new Error("energy definition missing");
  return {
    definition,
    state: bodyMeterStateSchema.parse({
      actorId: MARA,
      meterKey: "energy",
      valueFixedPoint: 7_000,
      baselineFixedPoint: 0,
      lastIntegratedAtStorySecond: storySecondAt(1, 420),
      registryVersion: bodyDerivationVersion,
    }),
    modifiers: [],
    scheduledAdjustments: [],
  };
}

/** Fired exactly at day-1 bedtime (23:00). */
const FIRE_SECOND = storySecondAt(1, 1_380);

function view(overrides: Partial<RunRoutinePolicyResolutionView> = {}): RunRoutinePolicyResolutionView {
  return {
    worldId: WORLD,
    branchId: BRANCH,
    rulesetVersion: "ruleset-v1",
    headSequence: 40,
    storySecond: FIRE_SECOND,
    actorExists: true,
    lod: actorLodReadSchema.parse({
      simulationLod: "event",
      inferenceLod: "no_model",
      source: "assigned",
      registryVersion: "actor-lod-v1",
    }),
    rhythmRows: [sleepRhythm],
    energyView: energyView(),
    activeAsleep: false,
    claimHoldingActivityCount: 0,
    openEngagementCount: 0,
    openPressureActBySeconds: [],
    coLocatedActorIds: [],
    ...overrides,
  };
}

function command(overrides: Partial<{ principalKind: string; branchId: string }> = {}): RunRoutinePolicyCommand {
  return runRoutinePolicyCommandSchema.parse({
    id: "cmd-routine-1",
    branchId: overrides.branchId ?? BRANCH,
    expectedVersion: 0,
    idempotencyKey: "routine-key-1",
    principal: {
      kind: overrides.principalKind ?? "system",
      principalId: "sim-scheduler",
      controlledActorIds: [],
    },
    submittedAtWallClock: "2026-07-20T12:00:00.000Z",
    correlationId: "corr-1",
    type: "run_routine_policy",
    schemaVersion: 1,
    payload: { actorId: MARA, armedAtSequence: 12 },
  });
}

describe("rhythm boundary math (E6.2)", () => {
  it("finds the next crossing strictly after the given second, wrapping midnight", () => {
    expect(nextMinuteOfDayCrossingSecond(storySecondAt(1, 1_380), 1_380)).toBe(storySecondAt(2, 1_380));
    expect(nextMinuteOfDayCrossingSecond(storySecondAt(1, 1_379), 1_380)).toBe(storySecondAt(1, 1_380));
    expect(nextMinuteOfDayCrossingSecond(storySecondAt(1, 1_380), 420)).toBe(storySecondAt(2, 420));
  });

  it("derives bedtime and wake from the window", () => {
    const window = { startMinuteOfDay: 1_380, endMinuteOfDay: 420 };
    expect(nextBedtimeSecond(window, storySecondAt(1, 600))).toBe(storySecondAt(1, 1_380));
    expect(nextWakeSecond(window, storySecondAt(1, 1_380))).toBe(storySecondAt(2, 420));
  });
});

describe("resolveRunRoutinePolicyFromView (E6.2)", () => {
  it("rejects a non-system principal", () => {
    const result = resolveRunRoutinePolicyFromView(view(), command({ principalKind: "storyteller" }));
    expect(result).toMatchObject({ ok: false, code: "unauthorized_principal" });
  });

  it("rejects when the actor is no longer event-LOD", () => {
    const result = resolveRunRoutinePolicyFromView(
      view({
        lod: actorLodReadSchema.parse({
          simulationLod: "exact",
          inferenceLod: "deliberator",
          source: "default",
          registryVersion: "actor-lod-v1",
        }),
      }),
      command(),
    );
    expect(result).toMatchObject({ ok: false, code: "routine_stale" });
  });

  it("rejects an untracked body and an already-sleeping actor as stale", () => {
    const untracked = { ...view() };
    delete untracked.energyView;
    expect(resolveRunRoutinePolicyFromView(untracked, command())).toMatchObject({
      ok: false,
      code: "routine_stale",
    });
    expect(resolveRunRoutinePolicyFromView(view({ activeAsleep: true }), command())).toMatchObject({
      ok: false,
      code: "routine_stale",
    });
  });

  it("chooses sleep at bedtime for an unencumbered actor and commits the ordinary train", () => {
    const result = resolveRunRoutinePolicyFromView(view(), command());
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.chosenCandidateId).toBe("begin_sleep");
    expect(result.condition).toMatchObject({
      key: "asleep",
      onsetAtStorySecond: FIRE_SECOND,
      expiresAtStorySecond: storySecondAt(2, 420),
    });
    expect(result.suspendModifier).toMatchObject({ meterKey: "energy", operation: { kind: "suspend" } });
    const types = result.events.map((event) => event.type);
    expect(types).toEqual([
      "routine_policy_resolved",
      "body_condition_applied",
      "body_modifier_applied",
      "trigger_scheduled", // condition expiry (wake)
      "trigger_scheduled", // next routine boundary
    ]);
    const decision = result.events[0];
    if (decision?.type !== "routine_policy_resolved") throw new Error("expected the decision first");
    expect(decision.payload.sleep).toMatchObject({ expiresAtStorySecond: storySecondAt(2, 420) });
    expect(decision.payload.candidates).toHaveLength(2);
    const rearm = result.events[4];
    if (rearm?.type !== "trigger_scheduled" || rearm.payload.kind !== "routine_policy_due") {
      throw new Error("expected the routine re-arm last");
    }
    // Next bedtime strictly after the wake: day-2 23:00.
    expect(rearm.payload.dueStorySecond).toBe(storySecondAt(2, 1_380));
  });

  it("holds for an obligation falling inside the would-be sleep, re-arming the next bedtime", () => {
    const result = resolveRunRoutinePolicyFromView(
      view({ openPressureActBySeconds: [storySecondAt(2, 60)] }),
      command(),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.chosenCandidateId).toBe("hold");
    expect(result.condition).toBeUndefined();
    const types = result.events.map((event) => event.type);
    expect(types).toEqual(["routine_policy_resolved", "trigger_scheduled"]);
    const decision = result.events[0];
    if (decision?.type !== "routine_policy_resolved") throw new Error("expected the decision first");
    const hold = decision.payload.candidates.find((candidate) => candidate.id === "hold");
    expect(hold?.scoreFixedPoint).toBe(ROUTINE_HOLD_COMMITMENT_WEIGHT_FIXED_POINT);
    const rearm = result.events[1];
    if (rearm?.type !== "trigger_scheduled") throw new Error("expected the re-arm");
    expect(rearm.payload.dueStorySecond).toBe(storySecondAt(2, 1_380));
  });

  it("ignores obligations already resolved by wake or before now", () => {
    const result = resolveRunRoutinePolicyFromView(
      view({ openPressureActBySeconds: [FIRE_SECOND - 60, storySecondAt(3, 600)] }),
      command(),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.chosenCandidateId).toBe("begin_sleep");
  });

  it("holds with the legality reason captured when the actor is busy", () => {
    const engaged = resolveRunRoutinePolicyFromView(view({ openEngagementCount: 1 }), command());
    if (!engaged.ok) throw new Error(`expected acceptance, got ${engaged.code}`);
    expect(engaged.chosenCandidateId).toBe("hold");
    const decision = engaged.events[0];
    if (decision?.type !== "routine_policy_resolved") throw new Error("expected the decision first");
    expect(decision.payload.candidates.find((candidate) => candidate.id === "begin_sleep")).toMatchObject({
      legal: false,
      illegalReason: "in_engagement",
    });

    const claimed = resolveRunRoutinePolicyFromView(view({ claimHoldingActivityCount: 1 }), command());
    if (!claimed.ok) throw new Error(`expected acceptance, got ${claimed.code}`);
    const claimedDecision = claimed.events[0];
    if (claimedDecision?.type !== "routine_policy_resolved") throw new Error("expected the decision first");
    expect(
      claimedDecision.payload.candidates.find((candidate) => candidate.id === "begin_sleep"),
    ).toMatchObject({ legal: false, illegalReason: "holding_claims" });
  });

  it("sleeps through an obligation under deep sleep debt (escalation outranks the hold weight)", () => {
    // Awake since day-0 wake: ~40h by day-1 bedtime pushes escalation far
    // past the 10 000 hold weight — the emergent collapse-adjacent behavior.
    const result = resolveRunRoutinePolicyFromView(
      view({
        lastSleepEndedAtStorySecond: storySecondAt(0, 420),
        openPressureActBySeconds: [storySecondAt(2, 60)],
      }),
      command(),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.chosenCandidateId).toBe("begin_sleep");
  });
});
