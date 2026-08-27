import { describe, expect, it } from "vitest";
import {
  ROUTINE_MEAL_WEIGHT_FIXED_POINT,
  ROUTINE_SLEEP_OBLIGATION_PENALTY_FIXED_POINT,
  runRoutinePolicyCommandSchema,
  type RunRoutinePolicyCommand,
} from "../contracts/routine";
import { actorLodReadSchema } from "../contracts/lod";
import {
  bodyDerivationVersion,
  bodyMeterRegistryByVersion,
  bodyMeterStateSchema,
  bodyRhythmRowSchema,
  circadianCurveV1,
  type BodyRhythmRow,
} from "../contracts/bodies";
import {
  simulationMaterialItemSchema,
  type SimulationMaterialItem,
  type SimulationMaterialItemInput,
} from "../contracts/materials";
import type { PrincipalKind } from "../contracts/envelopes";
import { bindSimEnvelopes } from "../test-support/sim-envelopes";
import { storySecondAt } from "./body-reads";
import type { MeterIntegrationView } from "./bodies";
import type { MaterialResolutionView } from "./material-locus";
import type { ConsumptionBodyView } from "./materials";
import {
  mealWindowCovering,
  nextBedtimeSecond,
  nextMinuteOfDayCrossingSecond,
  nextRoutineBoundarySecond,
  nextWakeSecond,
  resolveRunRoutinePolicyFromView,
  selectRoutineMealItem,
  type RunRoutinePolicyResolutionView,
} from "./routine";

const WORLD = "world-1";
const BRANCH = "branch-1";
const MARA = "mara";
const RIVAL = "rival";
const RULESET = "ruleset-v1";

/**
 * This suite carries its own ruleset, so bind the trio once: every view's
 * `branchId` must stay equal to the command's, or the resolver answers
 * `branch_mismatch` instead of the routine law under test.
 */
const env = bindSimEnvelopes({ worldId: WORLD, branchId: BRANCH, rulesetVersion: RULESET });

/** 23:00 → 07:00, the default geometry, authored explicitly. */
const sleepRhythm: BodyRhythmRow = bodyRhythmRowSchema.parse({
  actorId: MARA,
  kind: "sleep",
  startMinuteOfDay: 1_380,
  endMinuteOfDay: 420,
});

/** 12:00 → 13:00 — the authored lunch window. */
const lunchRhythm: BodyRhythmRow = bodyRhythmRowSchema.parse({
  actorId: MARA,
  kind: "meal",
  startMinuteOfDay: 720,
  endMinuteOfDay: 780,
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

function mealItem(overrides: Partial<SimulationMaterialItemInput> = {}): SimulationMaterialItem {
  return simulationMaterialItemSchema.parse({
    id: "item-bread-1",
    name: "a loaf of bread",
    ownerActorId: null,
    conditionTracked: false,
    consumptionEffects: [
      { meterKey: "energy", sourceKind: "meal", operation: { kind: "add", deltaFixedPoint: 1_500 } },
    ],
    locus: { kind: "held", actorId: MARA },
    ...overrides,
  });
}

function materialView(items: readonly SimulationMaterialItem[]): MaterialResolutionView {
  const byId = new Map<string, SimulationMaterialItem>(items.map((item) => [item.id, item]));
  return {
    ...env.meta({ headSequence: 40, storySecond: storySecondAt(1, 720) }),
    version: 7,
    actorById: (actorId) => (actorId === MARA || actorId === RIVAL ? { id: actorId, name: actorId } : undefined),
    actorZoneId: (actorId) => (actorId === MARA ? "zone-home" : null),
    actorLocationId: (actorId) => (actorId === MARA ? "loc-home" : null),
    itemById: (itemId) => byId.get(itemId),
    containerOccupantCount: () => 0,
    reservingActivityId: () => null,
  };
}

function consumptionBodyView(): ConsumptionBodyView {
  const energy = energyView();
  return {
    bodyInitialized: true,
    meterView: (meterKey) => (meterKey === "energy" ? energy : undefined),
    collapseContext: { rhythmRows: [sleepRhythm] },
  };
}

/** Fired exactly at day-1 bedtime (23:00). */
const FIRE_SECOND = storySecondAt(1, 1_380);
/** Fired exactly at day-1 lunch (12:00). */
const LUNCH_SECOND = storySecondAt(1, 720);

function view(overrides: Partial<RunRoutinePolicyResolutionView> = {}): RunRoutinePolicyResolutionView {
  return {
    ...env.meta({ headSequence: 40, storySecond: FIRE_SECOND }),
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

/** The lunch-boundary view with the full meal facts attached. */
function lunchView(
  items: readonly SimulationMaterialItem[],
  overrides: Partial<RunRoutinePolicyResolutionView> = {},
): RunRoutinePolicyResolutionView {
  return view({
    storySecond: LUNCH_SECOND,
    rhythmRows: [sleepRhythm, lunchRhythm],
    materialView: materialView(items),
    materialItemIds: items.map((item) => item.id),
    consumptionBodyView: consumptionBodyView(),
    ...overrides,
  });
}

function command(overrides: Partial<{ principalKind: PrincipalKind }> = {}): RunRoutinePolicyCommand {
  return env.command(runRoutinePolicyCommandSchema, {
    type: "run_routine_policy",
    idSlug: "routine-1",
    // The scheduler fires routines — a principal id no shared shape covers.
    principal: {
      kind: overrides.principalKind ?? "system",
      principalId: "sim-scheduler",
      controlledActorIds: [],
    },
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

  it("takes the earliest of bedtime and meal starts as the next routine boundary", () => {
    const rows = [sleepRhythm, lunchRhythm];
    expect(nextRoutineBoundarySecond(rows, storySecondAt(1, 453))).toBe(LUNCH_SECOND);
    expect(nextRoutineBoundarySecond(rows, LUNCH_SECOND)).toBe(storySecondAt(1, 1_380));
    expect(nextRoutineBoundarySecond(rows, storySecondAt(1, 1_380))).toBe(storySecondAt(2, 720));
    // No meal rows: the boundary law degrades to bedtime alone.
    expect(nextRoutineBoundarySecond([sleepRhythm], storySecondAt(1, 453))).toBe(storySecondAt(1, 1_380));
  });

  it("resolves meal-window membership half-open, wrapping, and deterministically on overlap", () => {
    const rows = [sleepRhythm, lunchRhythm];
    expect(mealWindowCovering(rows, LUNCH_SECOND)).toMatchObject({ startMinuteOfDay: 720 });
    expect(mealWindowCovering(rows, storySecondAt(1, 779))).toMatchObject({ startMinuteOfDay: 720 });
    expect(mealWindowCovering(rows, storySecondAt(1, 780))).toBeUndefined();
    expect(mealWindowCovering(rows, storySecondAt(1, 719))).toBeUndefined();

    const lateSupper = bodyRhythmRowSchema.parse({
      actorId: MARA,
      kind: "meal",
      startMinuteOfDay: 1_420,
      endMinuteOfDay: 20,
    });
    expect(mealWindowCovering([lateSupper], storySecondAt(1, 1_430))).toMatchObject({ startMinuteOfDay: 1_420 });
    expect(mealWindowCovering([lateSupper], storySecondAt(2, 10))).toMatchObject({ startMinuteOfDay: 1_420 });
    expect(mealWindowCovering([lateSupper], storySecondAt(2, 30))).toBeUndefined();

    const wideLunch = bodyRhythmRowSchema.parse({
      actorId: MARA,
      kind: "meal",
      startMinuteOfDay: 700,
      endMinuteOfDay: 790,
    });
    // Overlap resolves to the earliest (start, end) pair.
    expect(mealWindowCovering([lunchRhythm, wideLunch], storySecondAt(1, 730))).toMatchObject({
      startMinuteOfDay: 700,
    });
  });
});

describe("selectRoutineMealItem", () => {
  it("requires a meal-source consumption effect and skips others' property and reserved items", () => {
    const drinkOnly = mealItem({
      id: "item-water-1",
      name: "a canteen of water",
      consumptionEffects: [
        { meterKey: "hygiene", sourceKind: "drink", operation: { kind: "set", valueFixedPoint: 9_500 } },
      ],
    });
    const owned = mealItem({ id: "item-owned-1", ownerActorId: RIVAL });
    const gone = mealItem({ id: "item-gone-1", locus: { kind: "gone", basis: "consumed" } });
    expect(selectRoutineMealItem(materialView([drinkOnly, owned, gone]), [drinkOnly.id, owned.id, gone.id], MARA)).toBeUndefined();

    const bread = mealItem();
    const reservedView = { ...materialView([bread]), reservingActivityId: () => "activity-1" };
    expect(selectRoutineMealItem(reservedView, [bread.id], MARA)).toBeUndefined();
  });

  it("prefers actor-rooted items over zone-rooted ones, breaking ties lexicographically", () => {
    const zoneStew = mealItem({ id: "item-a-stew", locus: { kind: "zone", zoneId: "zone-home" } });
    const heldLoafLate = mealItem({ id: "item-z-loaf" });
    const heldLoafEarly = mealItem({ id: "item-m-loaf" });
    const items = [zoneStew, heldLoafLate, heldLoafEarly];
    const selected = selectRoutineMealItem(materialView(items), items.map((item) => item.id), MARA);
    expect(selected?.id).toBe("item-m-loaf");

    const zoneOnly = selectRoutineMealItem(materialView([zoneStew]), [zoneStew.id], MARA);
    expect(zoneOnly?.id).toBe("item-a-stew");
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
    expect(decision.payload.weightsVersion).toBe("routine-policy-v2");
    expect(decision.payload.candidates).toHaveLength(3);
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
    // v2 moved the obligation weight onto sleep as a penalty: at bedtime the
    // curve reads its 3 500 anchor, so the penalized score goes negative.
    const sleep = decision.payload.candidates.find((candidate) => candidate.id === "begin_sleep");
    expect(sleep?.scoreFixedPoint).toBe(
      circadianCurveV1.bedtimeFixedPoint - ROUTINE_SLEEP_OBLIGATION_PENALTY_FIXED_POINT,
    );
    const hold = decision.payload.candidates.find((candidate) => candidate.id === "hold");
    expect(hold?.scoreFixedPoint).toBe(0);
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

  it("sleeps through an obligation under deep sleep debt (escalation outranks the penalty)", () => {
    // Awake since day-0 wake: ~40h by day-1 bedtime pushes escalation far
    // past the 10 000 penalty — the emergent collapse-adjacent behavior.
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

  it("eats at a meal boundary, committing the consumption train and re-arming bedtime", () => {
    const bread = mealItem();
    const result = resolveRunRoutinePolicyFromView(lunchView([bread]), command());
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.chosenCandidateId).toBe("eat_meal");
    expect(result.consumedItemId).toBe(bread.id);
    expect(result.condition).toBeUndefined();
    expect(result.meterUpdates).toHaveLength(1);
    expect(result.meterUpdates?.[0]).toMatchObject({
      meterKey: "energy",
      lastIntegratedAtStorySecond: LUNCH_SECOND,
    });

    const [decision, consumed, sourceApplied] = result.events;
    if (decision?.type !== "routine_policy_resolved") throw new Error("expected the decision first");
    expect(decision.payload.meal).toEqual({ itemId: bread.id });
    expect(decision.payload.sleep).toBeUndefined();
    const eat = decision.payload.candidates.find((candidate) => candidate.id === "eat_meal");
    expect(eat).toMatchObject({ legal: true, scoreFixedPoint: ROUTINE_MEAL_WEIGHT_FIXED_POINT });
    const sleep = decision.payload.candidates.find((candidate) => candidate.id === "begin_sleep");
    expect(sleep?.legal).toBe(true);
    expect(sleep?.scoreFixedPoint).toBeLessThan(ROUTINE_MEAL_WEIGHT_FIXED_POINT);

    if (consumed?.type !== "item_consumed") throw new Error("expected item_consumed second");
    expect(consumed.causationId).toBe(decision.id);
    expect(consumed.payload).toMatchObject({ actorId: MARA, itemId: bread.id, againstOwnership: false });
    if (sourceApplied?.type !== "body_source_applied") throw new Error("expected the body effect third");
    expect(sourceApplied.causationId).toBe(consumed.id);
    expect(sourceApplied.payload).toMatchObject({ meterKey: "energy", sourceKind: "meal" });

    const rearm = result.events.at(-1);
    if (rearm?.type !== "trigger_scheduled" || rearm.payload.kind !== "routine_policy_due") {
      throw new Error("expected the routine re-arm last");
    }
    // The next boundary after lunch is tonight's bedtime.
    expect(rearm.payload.dueStorySecond).toBe(storySecondAt(1, 1_380));
  });

  it("lets an evening obligation coexist with lunch — the penalty applies to sleep, never the meal", () => {
    // v1 scored the obligation on `hold`, which would have starved lunch out;
    // v2's penalty-on-sleep is exactly this regression's fix.
    const bread = mealItem();
    const result = resolveRunRoutinePolicyFromView(
      lunchView([bread], { openPressureActBySeconds: [storySecondAt(1, 1_200)] }),
      command(),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.chosenCandidateId).toBe("eat_meal");
  });

  it("captures no_eligible_item and holds when the window is open but the pantry is bare", () => {
    const owned = mealItem({ id: "item-owned-1", ownerActorId: RIVAL });
    const result = resolveRunRoutinePolicyFromView(lunchView([owned]), command());
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.chosenCandidateId).toBe("hold");
    expect(result.consumedItemId).toBeUndefined();
    const decision = result.events[0];
    if (decision?.type !== "routine_policy_resolved") throw new Error("expected the decision first");
    expect(decision.payload.candidates.find((candidate) => candidate.id === "eat_meal")).toMatchObject({
      legal: false,
      illegalReason: "no_eligible_item",
    });
    // The skipped meal self-heals at the next boundary: tonight's bedtime.
    const rearm = result.events.at(-1);
    if (rearm?.type !== "trigger_scheduled") throw new Error("expected the re-arm");
    expect(rearm.payload.dueStorySecond).toBe(storySecondAt(1, 1_380));
  });

  it("fails closed to no_eligible_item when the window is open but no material facts were loaded", () => {
    const result = resolveRunRoutinePolicyFromView(
      view({ storySecond: LUNCH_SECOND, rhythmRows: [sleepRhythm, lunchRhythm] }),
      command(),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.chosenCandidateId).toBe("hold");
    const decision = result.events[0];
    if (decision?.type !== "routine_policy_resolved") throw new Error("expected the decision first");
    expect(decision.payload.candidates.find((candidate) => candidate.id === "eat_meal")).toMatchObject({
      legal: false,
      illegalReason: "no_eligible_item",
    });
  });

  it("scores eat_meal at zero outside every meal window", () => {
    const bread = mealItem();
    const result = resolveRunRoutinePolicyFromView(
      lunchView([bread], { storySecond: FIRE_SECOND }),
      command(),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.chosenCandidateId).toBe("begin_sleep");
    const decision = result.events[0];
    if (decision?.type !== "routine_policy_resolved") throw new Error("expected the decision first");
    expect(decision.payload.candidates.find((candidate) => candidate.id === "eat_meal")).toMatchObject({
      legal: true,
      scoreFixedPoint: 0,
    });
  });

  it("never naps outside the sleep window — even under deep debt, lunch is lunch", () => {
    // Awake since day-0 wake and fired at day-2 lunch: sleep is not DUE
    // outside its own window (it scores 0 there), so the routine eats and
    // forced daytime sleep stays the collapse law's job alone.
    const bread = mealItem();
    const result = resolveRunRoutinePolicyFromView(
      lunchView([bread], {
        storySecond: storySecondAt(2, 720),
        lastSleepEndedAtStorySecond: storySecondAt(0, 420),
      }),
      command(),
    );
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.chosenCandidateId).toBe("eat_meal");
    const decision = result.events[0];
    if (decision?.type !== "routine_policy_resolved") throw new Error("expected the decision first");
    expect(decision.payload.candidates.find((candidate) => candidate.id === "begin_sleep")).toMatchObject({
      legal: true,
      scoreFixedPoint: 0,
    });
  });

  it("keeps the busy gates on the meal candidate too", () => {
    const bread = mealItem();
    const result = resolveRunRoutinePolicyFromView(lunchView([bread], { openEngagementCount: 1 }), command());
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.chosenCandidateId).toBe("hold");
    const decision = result.events[0];
    if (decision?.type !== "routine_policy_resolved") throw new Error("expected the decision first");
    expect(decision.payload.candidates.find((candidate) => candidate.id === "eat_meal")).toMatchObject({
      legal: false,
      illegalReason: "in_engagement",
    });
  });
});
