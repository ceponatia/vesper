import { describe, expect, it } from "vitest";
import {
  applyItemConditionSourceCommandSchema,
  itemConditionInitializedEventSchema,
  itemConditionMeterStateSchema,
  itemConditionRegistryV1,
  itemConditionRegistryVersion,
  itemConditionThresholdCrossedEventSchema,
  resolveItemConditionThresholdCommandSchema,
  type ApplyItemConditionSourceCommand,
  type ResolveItemConditionThresholdCommand,
} from "@/contracts/simulation/material-condition";
import { triggerScheduledEventSchema } from "@/contracts/simulation/scheduler";
import { integrateMeterValue } from "./bodies";
import {
  WORN_WINDOW_CLEANLINESS_RATE_ADD_FIXED_POINT,
  WORN_WINDOW_STACKING_GROUP,
  applyItemConditionEvent,
  buildUseConditionDeltas,
  buildWornWindowTransition,
  emptyItemConditionSeed,
  meterViewOfItem,
  replayItemConditionHistory,
  resolveApplyItemConditionSource,
  resolveItemConditionThreshold,
  sortItemConditionsProjection,
  type ItemConditionView,
} from "./material-condition";
import type { MaterialResolutionView } from "./material-locus";
import {
  itemLocusSchema,
  simulationMaterialItemSchema,
  type ItemLocus,
  type ItemLocusInput,
  type SimulationMaterialItemInput,
} from "@/contracts/simulation/materials";

const WORLD = "world-e5-3-slice3";
const BRANCH = "branch-e5-3-slice3";
const RULESET = "e5-3-slice3-test-v1";
const ZONE_A = "zone-a";
const ITEM = "jacket";
const ACTOR = "mara";

const meta = {
  worldId: WORLD,
  branchId: BRANCH,
  rulesetVersion: RULESET,
  headSequence: 0,
  storySecond: 10_000,
};

const heldBy = (actorId: string): ItemLocus => itemLocusSchema.parse({ kind: "held", actorId });
const wornBy = (actorId: string, slotKey: string): ItemLocus =>
  itemLocusSchema.parse({ kind: "worn", actorId, slotKey });
const atZone = (zoneId: string): ItemLocus => itemLocusSchema.parse({ kind: "zone", zoneId });

function freshCondition(overrides: Partial<ItemConditionView> = {}): ItemConditionView {
  return {
    itemId: ITEM,
    registryVersion: itemConditionRegistryVersion,
    meters: itemConditionRegistryV1.map((definition) =>
      itemConditionMeterStateSchema.parse({
        itemId: ITEM,
        meterKey: definition.key,
        valueFixedPoint: definition.initialFixedPoint,
        baselineFixedPoint: definition.baselineFixedPoint,
        lastIntegratedAtStorySecond: meta.storySecond,
        registryVersion: itemConditionRegistryVersion,
      }),
    ),
    modifiers: [],
    ...overrides,
  };
}

function principal(kind: "player" | "system" = "player") {
  return {
    kind,
    principalId: "principal-1",
    controlledActorIds: kind === "player" ? [ACTOR] : [],
  };
}

function sourceCommand(
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): ApplyItemConditionSourceCommand {
  return applyItemConditionSourceCommandSchema.parse({
    id: "cmd-source",
    branchId: BRANCH,
    expectedVersion: 0,
    idempotencyKey: "idem-source",
    principal: principal("player"),
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    type: "apply_item_condition_source",
    schemaVersion: 1,
    correlationId: "corr-1",
    payload,
    ...overrides,
  });
}

function thresholdCommand(
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): ResolveItemConditionThresholdCommand {
  return resolveItemConditionThresholdCommandSchema.parse({
    id: "cmd-threshold",
    branchId: BRANCH,
    expectedVersion: 0,
    idempotencyKey: "idem-threshold",
    principal: principal("system"),
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    type: "resolve_item_condition_threshold",
    schemaVersion: 1,
    correlationId: "corr-1",
    payload,
    ...overrides,
  });
}

interface TestItem {
  id: string;
  locus: ItemLocusInput;
  materialKindKey?: string;
  conditionTracked?: boolean;
}

function materialView(input: {
  items: TestItem[];
  actorZoneId?: string | null;
  reservedBy?: Record<string, string>;
}): MaterialResolutionView {
  const itemsById = new Map(
    input.items.map((item) => [
      item.id,
      simulationMaterialItemSchema.parse({
        name: item.id,
        ownerActorId: null,
        conditionTracked: item.conditionTracked ?? true,
        ...item,
      } satisfies SimulationMaterialItemInput),
    ]),
  );
  const reservedBy = input.reservedBy ?? {};
  return {
    worldId: WORLD,
    branchId: BRANCH,
    rulesetVersion: RULESET,
    version: 0,
    headSequence: meta.headSequence,
    storySecond: meta.storySecond,
    actorById: (id) => (id === ACTOR || id === "iris" ? { id, name: id } : undefined),
    actorZoneId: (id) => {
      if (id !== ACTOR && id !== "iris") return null;
      return input.actorZoneId === undefined ? ZONE_A : input.actorZoneId;
    },
    actorLocationId: () => "loc-a",
    itemById: (id) => itemsById.get(id),
    containerOccupantCount: () => 0,
    reservingActivityId: (id) => reservedBy[id] ?? null,
  };
}

describe("E5.3 slice 3 — the item-condition registry", () => {
  it("parses the v1 registry with the designed meters and thresholds", () => {
    const cleanliness = itemConditionRegistryV1.find((definition) => definition.key === "cleanliness");
    const wear = itemConditionRegistryV1.find((definition) => definition.key === "wear");
    expect(cleanliness).toMatchObject({
      class: "rate",
      initialFixedPoint: 10_000,
      baselineFixedPoint: 10_000,
      driftLaw: { kind: "linear", ratePerHourFixedPoint: 0 },
    });
    expect(cleanliness?.thresholds).toEqual([
      {
        key: "grimy",
        boundaryFixedPoint: 3_000,
        direction: "falling",
        outcome: { kind: "event_only" },
        noticeable: true,
      },
    ]);
    expect(wear).toMatchObject({
      class: "load",
      initialFixedPoint: 0,
      baselineFixedPoint: 0,
      driftLaw: { kind: "none" },
    });
    expect(wear?.thresholds).toEqual([
      {
        key: "worn_out",
        boundaryFixedPoint: 8_000,
        direction: "rising",
        outcome: { kind: "event_only" },
        noticeable: true,
      },
    ]);
  });
});

describe("E5.3 slice 3 — worn-window arc (§26.7)", () => {
  it("dons: applies the worn-window modifier and solves grimy at the exact hand-math second", () => {
    const condition = freshCondition();
    const don = buildWornWindowTransition({
      view: meta,
      command: { id: "cmd-t1", correlationId: "corr-1", submittedAtWallClock: "2026-07-19T10:00:00.000Z" },
      itemId: ITEM,
      fromLocus: heldBy(ACTOR),
      toLocus: wornBy(ACTOR, "torso"),
      condition,
      causationId: "event-transfer-1",
      startSequence: meta.headSequence + 2,
    });

    expect(don.events).toHaveLength(2);
    const [applied, rearm] = don.events;
    expect(applied?.type).toBe("item_condition_modifier_applied");
    if (applied?.type !== "item_condition_modifier_applied") throw new Error("expected modifier applied");
    expect(applied.payload.modifier).toMatchObject({
      itemId: ITEM,
      meterKey: "cleanliness",
      operation: { kind: "rate_add", ratePerHourFixedPoint: WORN_WINDOW_CLEANLINESS_RATE_ADD_FIXED_POINT },
      stackingGroup: WORN_WINDOW_STACKING_GROUP,
      priority: 0,
      validFromStorySecond: meta.storySecond,
      visibility: "obvious",
    });
    expect(applied.causationId).toBe("event-transfer-1");

    expect(rearm?.type).toBe("trigger_scheduled");
    if (rearm?.type !== "trigger_scheduled") throw new Error("expected rearm trigger");
    if (rearm.payload.kind !== "item_condition_threshold_due") throw new Error("expected item condition trigger");
    // Hand math: (10 000 − 3 000) / 250 per hour = 28 hours = 100 800 seconds.
    expect(rearm.payload.dueStorySecond).toBe(meta.storySecond + 28 * 3_600);
    expect(rearm.payload.command.payload).toMatchObject({
      itemId: ITEM,
      meterKey: "cleanliness",
      thresholdKey: "grimy",
    });

    // Verify against the integration oracle directly: exact at the solved
    // second, not yet crossed one second earlier.
    const wornCondition = freshCondition({ modifiers: [applied.payload.modifier] });
    const meterView = meterViewOfItem(wornCondition, "cleanliness");
    if (!meterView) throw new Error("expected cleanliness meter view");
    expect(integrateMeterValue(meterView, meta.storySecond + 28 * 3_600)).toBe(3_000);
    expect(integrateMeterValue(meterView, meta.storySecond + 28 * 3_600 - 1)).toBe(3_001);
  });

  it("doffs: ends the live worn-window modifier and re-arm reflects the held-steady post-doff value", () => {
    const condition = freshCondition();
    const don = buildWornWindowTransition({
      view: meta,
      command: { id: "cmd-t1", correlationId: "corr-1", submittedAtWallClock: "2026-07-19T10:00:00.000Z" },
      itemId: ITEM,
      fromLocus: heldBy(ACTOR),
      toLocus: wornBy(ACTOR, "torso"),
      condition,
      causationId: "event-transfer-1",
      startSequence: meta.headSequence + 2,
    });
    const [applied] = don.events;
    if (applied?.type !== "item_condition_modifier_applied") throw new Error("expected modifier applied");

    // Doff at +10h, well before grimy (28h out): cleanliness = 10 000 − 250·10 = 7 500.
    const doffSecond = meta.storySecond + 10 * 3_600;
    const wornCondition = freshCondition({ modifiers: [applied.payload.modifier] });
    const doffView = { ...meta, storySecond: doffSecond, headSequence: 20 };
    const doff = buildWornWindowTransition({
      view: doffView,
      command: { id: "cmd-t2", correlationId: "corr-2", submittedAtWallClock: "2026-07-19T20:00:00.000Z" },
      itemId: ITEM,
      fromLocus: wornBy(ACTOR, "torso"),
      toLocus: heldBy(ACTOR),
      condition: wornCondition,
      causationId: "event-transfer-2",
      startSequence: 21,
    });

    // Above grimy and the base rate is zero after doffing: never crosses again → no re-arm.
    expect(doff.events).toHaveLength(1);
    const [ended] = doff.events;
    expect(ended?.type).toBe("item_condition_modifier_ended");
    if (ended?.type !== "item_condition_modifier_ended") throw new Error("expected modifier ended");
    expect(ended.payload).toEqual({ itemId: ITEM, modifierId: applied.payload.modifier.id, basis: "doffed" });
    expect(ended.causationId).toBe("event-transfer-2");

    const endedModifier = { ...applied.payload.modifier, validUntilStorySecond: doffSecond };
    const heldSteadyView = meterViewOfItem(freshCondition({ modifiers: [endedModifier] }), "cleanliness");
    if (!heldSteadyView) throw new Error("expected cleanliness meter view");
    expect(integrateMeterValue(heldSteadyView, doffSecond)).toBe(7_500);
    // Holds steady long after doffing — no at-rest drift.
    expect(integrateMeterValue(heldSteadyView, doffSecond + 1_000_000)).toBe(7_500);
  });

  it("untracked items and worn-ness-preserving moves emit nothing", () => {
    const untracked = buildWornWindowTransition({
      view: meta,
      command: { id: "cmd-t3", correlationId: "corr-3", submittedAtWallClock: "2026-07-19T10:00:00.000Z" },
      itemId: "plain-shirt",
      fromLocus: heldBy(ACTOR),
      toLocus: wornBy(ACTOR, "torso"),
      causationId: "event-transfer-3",
      startSequence: 5,
    });
    expect(untracked.events).toEqual([]);
    expect(untracked.nextSequence).toBe(5);

    const heldToHeld = buildWornWindowTransition({
      view: meta,
      command: { id: "cmd-t4", correlationId: "corr-4", submittedAtWallClock: "2026-07-19T10:00:00.000Z" },
      itemId: ITEM,
      fromLocus: heldBy(ACTOR),
      toLocus: atZone(ZONE_A),
      condition: freshCondition(),
      causationId: "event-transfer-4",
      startSequence: 5,
    });
    expect(heldToHeld.events).toEqual([]);
  });
});

describe("E5.3 slice 3 — use-disposition condition deltas (§26.5 completion path)", () => {
  it("moves wear toward worn_out on each delta and detects the instant crossing (no drift-based re-arm is possible)", () => {
    const condition = freshCondition();
    const first = buildUseConditionDeltas({
      view: meta,
      command: { id: "cmd-complete-1", correlationId: "corr-1", submittedAtWallClock: "2026-07-19T11:00:00.000Z" },
      items: [{ itemId: ITEM, condition, deltas: [{ meterKey: "wear", deltaFixedPoint: 3_000 }] }],
      causationEventId: "event-completed-1",
      startSequence: 2,
    });
    // Below worn_out (8 000): a source_applied event only, no crossing, no re-arm
    // (wear's driftLaw is "none" — nothing can ever be scheduled for it).
    expect(first.events).toHaveLength(1);
    const [sourceEvent] = first.events;
    expect(sourceEvent?.type).toBe("item_condition_source_applied");
    if (sourceEvent?.type !== "item_condition_source_applied") throw new Error("expected source applied");
    expect(sourceEvent.payload).toMatchObject({
      itemId: ITEM,
      meterKey: "wear",
      sourceKind: "use",
      valueAfterFixedPoint: 3_000,
    });
    expect(sourceEvent.causationId).toBe("event-completed-1");
    expect(first.meterUpdates).toEqual([expect.objectContaining({ valueFixedPoint: 3_000 })]);

    // A second delta carries wear from 3 000 to 9 000, instantly crossing worn_out (8 000).
    const wornCondition = freshCondition({
      meters: condition.meters.map((meter) =>
        meter.meterKey === "wear" ? { ...meter, valueFixedPoint: 3_000 } : meter,
      ),
    });
    const second = buildUseConditionDeltas({
      view: { ...meta, storySecond: meta.storySecond + 100 },
      command: { id: "cmd-complete-2", correlationId: "corr-2", submittedAtWallClock: "2026-07-19T12:00:00.000Z" },
      items: [{ itemId: ITEM, condition: wornCondition, deltas: [{ meterKey: "wear", deltaFixedPoint: 6_000 }] }],
      causationEventId: "event-completed-2",
      startSequence: 2,
      coLocatedActorIds: ["witness-1"],
    });
    expect(second.events).toHaveLength(2);
    const [secondSource, crossed] = second.events;
    expect(secondSource?.type).toBe("item_condition_source_applied");
    expect(crossed?.type).toBe("item_condition_threshold_crossed");
    if (crossed?.type !== "item_condition_threshold_crossed") throw new Error("expected threshold crossed");
    expect(crossed.payload).toMatchObject({
      itemId: ITEM,
      meterKey: "wear",
      thresholdKey: "worn_out",
      direction: "rising",
      boundaryFixedPoint: 8_000,
      valueFixedPoint: 9_000,
      observerActorIds: ["witness-1"],
    });
    expect(crossed.causationId).toBe(secondSource?.id);
  });

  it("clean restores cleanliness via a direct set", () => {
    const soiled = freshCondition({
      meters: freshCondition().meters.map((meter) =>
        meter.meterKey === "cleanliness" ? { ...meter, valueFixedPoint: 2_000 } : meter,
      ),
    });
    const view = materialView({ items: [{ id: ITEM, locus: { kind: "held", actorId: ACTOR } }] });
    const resolution = resolveApplyItemConditionSource(
      { ...meta, condition: soiled },
      sourceCommand({
        actorId: ACTOR,
        itemId: ITEM,
        sourceKind: "clean",
        meterKey: "cleanliness",
        operation: { kind: "set", valueFixedPoint: 10_000 },
      }),
      view,
    );
    if (!resolution.ok) throw new Error(`unexpected rejection ${resolution.code}`);
    expect(resolution.meter.valueFixedPoint).toBe(10_000);
    const [event] = resolution.events;
    expect(event.payload).toMatchObject({ sourceKind: "clean", valueAfterFixedPoint: 10_000 });
  });
});

describe("E5.3 slice 3 — resolveItemConditionThreshold (fire-time re-validation)", () => {
  it("emits the crossing with captured witnesses, then rejects a stale re-fire", () => {
    const condition = freshCondition({
      meters: freshCondition().meters.map((meter) =>
        meter.meterKey === "cleanliness"
          ? { ...meter, valueFixedPoint: 2_800, lastIntegratedAtStorySecond: meta.storySecond }
          : meter,
      ),
    });
    const command = thresholdCommand({
      itemId: ITEM,
      meterKey: "cleanliness",
      thresholdKey: "grimy",
      armedAtSequence: 1,
    });
    const resolution = resolveItemConditionThreshold(
      { ...meta, condition, coLocatedActorIds: ["witness-1", "witness-1", "witness-2"] },
      command,
    );
    if (!resolution.ok) throw new Error(`unexpected rejection ${resolution.code}`);
    const [crossed] = resolution.events;
    expect(crossed.payload).toMatchObject({
      itemId: ITEM,
      meterKey: "cleanliness",
      thresholdKey: "grimy",
      direction: "falling",
      boundaryFixedPoint: 3_000,
      valueFixedPoint: 2_800,
    });
    // Deduplicated, sorted.
    expect(crossed.payload.observerActorIds).toEqual(["witness-1", "witness-2"]);

    // Stale: the meter has since recovered above the boundary.
    const recovered = freshCondition({
      meters: freshCondition().meters.map((meter) =>
        meter.meterKey === "cleanliness"
          ? { ...meter, valueFixedPoint: 9_000, lastIntegratedAtStorySecond: meta.storySecond }
          : meter,
      ),
    });
    const stale = resolveItemConditionThreshold({ ...meta, condition: recovered, coLocatedActorIds: [] }, command);
    expect(stale).toMatchObject({ ok: false, code: "threshold_stale" });
  });

  it("rejects every other code: branch mismatch, untracked, unknown meter/threshold, non-system principal", () => {
    const condition = freshCondition();
    const command = thresholdCommand({
      itemId: ITEM,
      meterKey: "cleanliness",
      thresholdKey: "grimy",
      armedAtSequence: 1,
    });

    expect(
      resolveItemConditionThreshold({ ...meta, branchId: "branch-other", condition, coLocatedActorIds: [] }, command),
    ).toMatchObject({ ok: false, code: "branch_mismatch" });

    expect(
      resolveItemConditionThreshold(
        { ...meta, condition, coLocatedActorIds: [] },
        thresholdCommand(command.payload, { principal: principal("player") }),
      ),
    ).toMatchObject({ ok: false, code: "unauthorized_principal" });

    expect(resolveItemConditionThreshold({ ...meta, coLocatedActorIds: [] }, command)).toMatchObject({
      ok: false,
      code: "condition_not_tracked",
    });

    expect(
      resolveItemConditionThreshold(
        { ...meta, condition, coLocatedActorIds: [] },
        thresholdCommand({ ...command.payload, meterKey: "ghost-meter" }),
      ),
    ).toMatchObject({ ok: false, code: "unknown_meter_key" });

    expect(
      resolveItemConditionThreshold(
        { ...meta, condition, coLocatedActorIds: [] },
        thresholdCommand({ ...command.payload, thresholdKey: "ghost-threshold" }),
      ),
    ).toMatchObject({ ok: false, code: "unknown_threshold_key" });
  });
});

describe("E5.3 slice 3 — resolveApplyItemConditionSource rejections (every reachable code)", () => {
  const baseItems: TestItem[] = [{ id: ITEM, locus: { kind: "held", actorId: ACTOR } }];
  const command = () =>
    sourceCommand({
      actorId: ACTOR,
      itemId: ITEM,
      sourceKind: "adjustment",
      meterKey: "cleanliness",
      operation: { kind: "set", valueFixedPoint: 9_000 },
    });

  it("branch_mismatch, actor_not_found, unauthorized_actor, actor_not_embodied", () => {
    const condition = freshCondition();
    const view = materialView({ items: baseItems });

    expect(
      resolveApplyItemConditionSource({ ...meta, condition, branchId: "other" }, command(), view),
    ).toMatchObject({ ok: false, code: "branch_mismatch" });

    expect(
      resolveApplyItemConditionSource(
        { ...meta, condition },
        sourceCommand({ ...command().payload, actorId: "ghost" }),
        view,
      ),
    ).toMatchObject({ ok: false, code: "actor_not_found" });

    expect(
      resolveApplyItemConditionSource(
        { ...meta, condition },
        sourceCommand(command().payload, { principal: { kind: "player", principalId: "p", controlledActorIds: [] } }),
        view,
      ),
    ).toMatchObject({ ok: false, code: "unauthorized_actor" });

    expect(
      resolveApplyItemConditionSource(
        { ...meta, condition },
        command(),
        materialView({ items: baseItems, actorZoneId: null }),
      ),
    ).toMatchObject({ ok: false, code: "actor_not_embodied" });
  });

  it("item_not_found, item_gone, condition_not_tracked, unknown_meter_key", () => {
    const condition = freshCondition();

    expect(
      resolveApplyItemConditionSource(
        { ...meta, condition },
        sourceCommand({ ...command().payload, itemId: "ghost-item" }),
        materialView({ items: baseItems }),
      ),
    ).toMatchObject({ ok: false, code: "item_not_found" });

    expect(
      resolveApplyItemConditionSource(
        { ...meta, condition },
        command(),
        materialView({ items: [{ id: ITEM, locus: { kind: "gone", basis: "lost" } }] }),
      ),
    ).toMatchObject({ ok: false, code: "item_gone" });

    expect(
      resolveApplyItemConditionSource({ ...meta }, command(), materialView({ items: baseItems })),
    ).toMatchObject({ ok: false, code: "condition_not_tracked" });

    expect(
      resolveApplyItemConditionSource(
        { ...meta, condition },
        sourceCommand({ ...command().payload, meterKey: "ghost-meter" }),
        materialView({ items: baseItems }),
      ),
    ).toMatchObject({ ok: false, code: "unknown_meter_key" });
  });

  it("root_not_colocated, held_by_other, worn_by_other, container_access_denied, item_reserved", () => {
    const condition = freshCondition();

    expect(
      resolveApplyItemConditionSource(
        { ...meta, condition },
        command(),
        materialView({ items: [{ id: ITEM, locus: { kind: "zone", zoneId: "zone-far" } }] }),
      ),
    ).toMatchObject({ ok: false, code: "root_not_colocated" });

    expect(
      resolveApplyItemConditionSource(
        { ...meta, condition },
        command(),
        materialView({ items: [{ id: ITEM, locus: { kind: "held", actorId: "iris" } }] }),
      ),
    ).toMatchObject({ ok: false, code: "held_by_other" });

    expect(
      resolveApplyItemConditionSource(
        { ...meta, condition },
        command(),
        materialView({ items: [{ id: ITEM, locus: { kind: "worn", actorId: "iris", slotKey: "head" } }] }),
      ),
    ).toMatchObject({ ok: false, code: "worn_by_other" });

    const closedBagView = materialView({
      items: [
        { id: "bag", locus: { kind: "held", actorId: ACTOR }, conditionTracked: false },
        { id: ITEM, locus: { kind: "container", containerItemId: "bag" } },
      ],
    });
    // The bag has no `container` config in this fixture item, so access resolves closed.
    expect(resolveApplyItemConditionSource({ ...meta, condition }, command(), closedBagView)).toMatchObject({
      ok: false,
      code: "container_access_denied",
    });

    expect(
      resolveApplyItemConditionSource(
        { ...meta, condition },
        command(),
        materialView({ items: baseItems, reservedBy: { [ITEM]: "activity-1" } }),
      ),
    ).toMatchObject({ ok: false, code: "item_reserved" });
  });
});

describe("E5.3 slice 3 — projector, replay, seed parity", () => {
  it("folds the full family (initialized → source → modifier applied → modifier ended → threshold crossed) identically live and replayed", () => {
    const seed = emptyItemConditionSeed(BRANCH, meta.storySecond);
    let sequence = seed.headSequence;
    const nextSeq = () => (sequence += 1);

    const initializedEvent = itemConditionInitializedEventSchema.parse({
      id: "event-init",
      worldId: WORLD,
      branchId: BRANCH,
      sequence: nextSeq(),
      storySecond: meta.storySecond,
      type: "item_condition_initialized",
      schemaVersion: 1,
      rulesetVersion: RULESET,
      correlationId: "corr-1",
      actorIds: [],
      entityIds: [ITEM],
      recordedAtWallClock: "2026-07-19T10:00:00.000Z",
      payload: {
        itemId: ITEM,
        registryVersion: itemConditionRegistryVersion,
        meters: itemConditionRegistryV1.map((definition) => ({
          meterKey: definition.key,
          valueFixedPoint: definition.initialFixedPoint,
          baselineFixedPoint: definition.baselineFixedPoint,
        })),
      },
    });

    let projection = applyItemConditionEvent(seed, initializedEvent);
    const condition: ItemConditionView = {
      itemId: ITEM,
      registryVersion: itemConditionRegistryVersion,
      meters: projection.meters,
      modifiers: [],
    };

    const view = { ...meta, headSequence: initializedEvent.sequence, condition };
    const applySourceResult = resolveApplyItemConditionSource(
      view,
      sourceCommand({
        actorId: ACTOR,
        itemId: ITEM,
        sourceKind: "adjustment",
        meterKey: "cleanliness",
        operation: { kind: "set", valueFixedPoint: 9_000 },
      }),
      materialView({ items: [{ id: ITEM, locus: { kind: "held", actorId: ACTOR } }] }),
    );
    if (!applySourceResult.ok) throw new Error(`unexpected rejection ${applySourceResult.code}`);
    for (const event of applySourceResult.events) {
      projection = applyItemConditionEvent(projection, { ...event, sequence: nextSeq() });
    }

    const wornWindow = buildWornWindowTransition({
      view: { ...meta, headSequence: projection.headSequence, storySecond: meta.storySecond + 100 },
      command: { id: "cmd-t1", correlationId: "corr-2", submittedAtWallClock: "2026-07-19T11:00:00.000Z" },
      itemId: ITEM,
      fromLocus: heldBy(ACTOR),
      toLocus: wornBy(ACTOR, "torso"),
      condition: { ...condition, meters: projection.meters },
      causationId: "event-transfer-1",
      startSequence: projection.headSequence + 1,
    });
    for (const event of wornWindow.events) {
      projection = applyItemConditionEvent(projection, { ...event, sequence: nextSeq() });
    }

    const wornConditionModifier = projection.modifiers.find((m) => m.stackingGroup === WORN_WINDOW_STACKING_GROUP);
    if (!wornConditionModifier) throw new Error("expected the worn-window modifier to be recorded");

    const doffSecond = meta.storySecond + 100 + 3_600;
    const doff = buildWornWindowTransition({
      view: { ...meta, headSequence: projection.headSequence, storySecond: doffSecond },
      command: { id: "cmd-t2", correlationId: "corr-3", submittedAtWallClock: "2026-07-19T12:00:00.000Z" },
      itemId: ITEM,
      fromLocus: wornBy(ACTOR, "torso"),
      toLocus: heldBy(ACTOR),
      condition: { ...condition, meters: projection.meters, modifiers: [wornConditionModifier] },
      causationId: "event-transfer-2",
      startSequence: projection.headSequence + 1,
    });
    for (const event of doff.events) {
      projection = applyItemConditionEvent(projection, { ...event, sequence: nextSeq() });
    }

    const thresholdEvent = itemConditionThresholdCrossedEventSchema.parse({
      id: "event-threshold",
      worldId: WORLD,
      branchId: BRANCH,
      sequence: nextSeq(),
      storySecond: doffSecond,
      type: "item_condition_threshold_crossed",
      schemaVersion: 1,
      rulesetVersion: RULESET,
      correlationId: "corr-4",
      actorIds: [],
      entityIds: [ITEM],
      recordedAtWallClock: "2026-07-19T13:00:00.000Z",
      payload: {
        itemId: ITEM,
        meterKey: "cleanliness",
        thresholdKey: "grimy",
        direction: "falling",
        boundaryFixedPoint: 3_000,
        valueFixedPoint: 3_000,
        observerActorIds: [],
        derived: {
          fromValueFixedPoint: 9_000,
          fromStorySecond: meta.storySecond + 100,
          activeModifierIds: [],
          registryVersion: itemConditionRegistryVersion,
        },
      },
    });
    projection = applyItemConditionEvent(projection, thresholdEvent);

    const allEvents = [
      initializedEvent,
      ...applySourceResult.events,
      ...wornWindow.events,
      ...doff.events,
      thresholdEvent,
    ].map((event, index) => ({ ...event, sequence: index + 1 }));

    const replayed = replayItemConditionHistory({ seed, events: allEvents });
    // Live folding never bumps version (that is replay's/the store's job) —
    // normalize it before comparing state, mirroring materials.test.ts's parity check.
    expect(sortItemConditionsProjection({ ...projection, version: replayed.version })).toEqual(replayed);
    expect(replayed.version).toBe(new Set(allEvents.map((e) => e.commandId).filter(Boolean)).size);
  });

  it("rejects a sequence gap", () => {
    const seed = emptyItemConditionSeed(BRANCH, meta.storySecond);
    const gapEvent = itemConditionInitializedEventSchema.parse({
      id: "event-x",
      worldId: WORLD,
      branchId: BRANCH,
      sequence: 3,
      storySecond: meta.storySecond,
      type: "item_condition_initialized",
      schemaVersion: 1,
      rulesetVersion: RULESET,
      correlationId: "corr-1",
      actorIds: [],
      entityIds: [ITEM],
      recordedAtWallClock: "2026-07-19T10:00:00.000Z",
      payload: {
        itemId: ITEM,
        registryVersion: itemConditionRegistryVersion,
        meters: [{ meterKey: "cleanliness", valueFixedPoint: 10_000, baselineFixedPoint: 10_000 }],
      },
    });
    expect(() => replayItemConditionHistory({ seed, events: [gapEvent] })).toThrow(/sequence gap/u);
  });

  it("passes a non-item-condition event through as a bare boundary advance", () => {
    const seed = emptyItemConditionSeed(BRANCH, meta.storySecond);
    const bump = triggerScheduledEventSchema.parse({
      id: "event-trigger",
      worldId: WORLD,
      branchId: BRANCH,
      sequence: 1,
      storySecond: meta.storySecond + 5,
      type: "trigger_scheduled",
      schemaVersion: 1,
      rulesetVersion: RULESET,
      derivationVersion: "scheduler-v1",
      commandId: "cmd-x",
      correlationId: "corr-1",
      actorIds: [],
      entityIds: [],
      recordedAtWallClock: "2026-07-19T10:00:00.000Z",
      payload: {
        kind: "activity_completion_due",
        triggerSchemaVersion: 1,
        dueStorySecond: meta.storySecond + 10,
        priority: 0,
        uniquenessKey: "key-1",
        command: {
          id: "cmd-complete",
          branchId: BRANCH,
          expectedVersion: 0,
          idempotencyKey: "cmd-complete",
          principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] },
          submittedAtWallClock: "2026-07-19T10:00:00.000Z",
          correlationId: "corr-1",
          type: "complete_activity",
          schemaVersion: 1,
          payload: { activityInstanceId: "activity-1" },
        },
      },
    });
    const next = applyItemConditionEvent(seed, bump);
    expect(next.meters).toEqual([]);
    expect(next.modifiers).toEqual([]);
    expect(next.headSequence).toBe(1);
    expect(next.storySecond).toBe(meta.storySecond + 5);
  });
});
