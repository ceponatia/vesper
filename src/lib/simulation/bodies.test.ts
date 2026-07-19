import { describe, expect, it } from "vitest";
import { activityInstanceSchema } from "@/contracts/simulation/activities";
import { engagementSchema } from "@/contracts/simulation/engagements";
import type { TriggerScheduledEvent } from "@/contracts/simulation/scheduler";
import {
  applyBodyConditionCommandSchema,
  applyBodyModifierCommandSchema,
  applyBodySourceCommandSchema,
  bodyMeterDefinitionSchema,
  bodyMeterStateSchema,
  bodyModifierSchema,
  bodyMeterRegistryV1,
  endBodyConditionCommandSchema,
  initializeActorBodyCommandSchema,
  resolveBodyCollapseCommandSchema,
  resolveBodyThresholdCommandSchema,
  type BodyMeterDefinition,
  type BodyMeterState,
  type BodyModifier,
} from "@/contracts/simulation/bodies";
import {
  applyBodyEvent,
  emptyBodiesSeed,
  exp2NegativeFixedPoint,
  integrateMeterValue,
  replayBodiesHistory,
  resolveApplyBodyCondition,
  resolveApplyBodyModifier,
  resolveApplyBodySource,
  resolveBodyCollapse,
  resolveBodyThreshold,
  resolveEndBodyCondition,
  resolveInitializeActorBody,
  solveNextThresholdCrossing,
  sortBodiesProjection,
  type MeterIntegrationView,
} from "./bodies";

const BRANCH = "branch-e5-1";
const WORLD = "world-e5-1";
const ACTOR = "actor-mara";

const meta = {
  worldId: WORLD,
  branchId: BRANCH,
  rulesetVersion: "e5-1-test-v1",
  headSequence: 0,
  storySecond: 10_000,
};

function principal(kind: "player" | "system" | "storyteller" = "storyteller") {
  return {
    kind,
    principalId: "principal-1",
    controlledActorIds: kind === "player" ? [ACTOR] : [],
  };
}

function envelope(type: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: `cmd-${type}`,
    branchId: BRANCH,
    expectedVersion: 0,
    idempotencyKey: `key-${type}`,
    principal: principal(),
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    correlationId: "corr-1",
    type,
    schemaVersion: 1,
    payload,
    ...overrides,
  };
}

function reserveDefinition(overrides: Partial<BodyMeterDefinition> = {}): BodyMeterDefinition {
  return bodyMeterDefinitionSchema.parse({
    key: "energy",
    class: "reserve",
    driftLaw: {
      kind: "proportional_decay",
      halfLifeSeconds: 3_600,
      target: { kind: "fixed", valueFixedPoint: 0 },
    },
    initialFixedPoint: 8_000,
    baselineFixedPoint: 0,
    thresholds: [],
    ...overrides,
  });
}

function linearDefinition(overrides: Partial<BodyMeterDefinition> = {}): BodyMeterDefinition {
  return bodyMeterDefinitionSchema.parse({
    key: "hygiene",
    class: "rate",
    driftLaw: {
      kind: "linear",
      ratePerHourFixedPoint: 150,
      target: { kind: "fixed", valueFixedPoint: 0 },
    },
    initialFixedPoint: 9_000,
    baselineFixedPoint: 0,
    thresholds: [
      {
        key: "grimy",
        boundaryFixedPoint: 2_500,
        direction: "falling",
        outcome: { kind: "event_only" },
        noticeable: false,
      },
    ],
    ...overrides,
  });
}

function meterState(
  definition: BodyMeterDefinition,
  overrides: Partial<BodyMeterState> = {},
): BodyMeterState {
  return bodyMeterStateSchema.parse({
    actorId: ACTOR,
    meterKey: definition.key,
    valueFixedPoint: definition.initialFixedPoint,
    baselineFixedPoint: definition.baselineFixedPoint,
    lastIntegratedAtStorySecond: 0,
    registryVersion: "body-v1",
    ...overrides,
  });
}

function modifier(overrides: Record<string, unknown> & { id: string; meterKey: string }): BodyModifier {
  return bodyModifierSchema.parse({
    actorId: ACTOR,
    operation: { kind: "suspend" },
    stackingGroup: "test",
    priority: 0,
    validFromStorySecond: 0,
    visibility: "private",
    sourceEventId: "event-source",
    ...overrides,
  });
}

describe("E5.1 fixed-point exponentials", () => {
  it("is exact at whole half-lives and identity at zero", () => {
    expect(exp2NegativeFixedPoint(0, 3_600)).toBe(1_000_000);
    expect(exp2NegativeFixedPoint(3_600, 3_600)).toBe(500_000);
    expect(exp2NegativeFixedPoint(7_200, 3_600)).toBe(250_000);
  });

  it("underflows to zero far past the horizon and rejects bad inputs", () => {
    expect(exp2NegativeFixedPoint(3_600 * 60, 3_600)).toBe(0);
    expect(() => exp2NegativeFixedPoint(-1, 10)).toThrow(RangeError);
    expect(() => exp2NegativeFixedPoint(10, 0)).toThrow(RangeError);
  });

  it("approximates fractional half-lives within one fixed-point unit", () => {
    // 2^-0.5 = 0.7071067…; the bit-walk composes the same constant.
    const half = exp2NegativeFixedPoint(1_800, 3_600);
    expect(Math.abs(half - 707_107)).toBeLessThanOrEqual(2);
  });
});

describe("E5.1 analytic integration", () => {
  it("decays a reserve proportionally and a rate meter linearly", () => {
    const reserve = reserveDefinition();
    const linear = linearDefinition();
    const reserveView: MeterIntegrationView = {
      definition: reserve,
      state: meterState(reserve),
      modifiers: [],
    };
    const linearView: MeterIntegrationView = {
      definition: linear,
      state: meterState(linear),
      modifiers: [],
    };
    expect(integrateMeterValue(reserveView, 3_600)).toBe(4_000);
    expect(integrateMeterValue(reserveView, 7_200)).toBe(2_000);
    expect(integrateMeterValue(linearView, 3_600)).toBe(8_850);
    expect(integrateMeterValue(linearView, 60)).toBe(8_998);
  });

  it("never persists: queries at any intermediate second do not change later reads", () => {
    const definition = reserveDefinition();
    const view: MeterIntegrationView = { definition, state: meterState(definition), modifiers: [] };
    const direct = integrateMeterValue(view, 10_000);
    for (const probe of [1, 617, 3_600, 9_999]) {
      integrateMeterValue(view, probe);
    }
    expect(integrateMeterValue(view, 10_000)).toBe(direct);
  });

  it("integrates piecewise across modifier boundaries equal to manual composition", () => {
    const definition = linearDefinition();
    const suspend = modifier({
      id: "mod-suspend",
      meterKey: definition.key,
      operation: { kind: "suspend" },
      validFromStorySecond: 1_000,
      validUntilStorySecond: 2_000,
    });
    const view: MeterIntegrationView = {
      definition,
      state: meterState(definition),
      modifiers: [suspend],
    };
    // Piece 1 (0→1000) drains, piece 2 (1000→2000) suspended, piece 3 drains.
    const pieceOne = integrateMeterValue({ ...view, modifiers: [] }, 1_000);
    const manual =
      pieceOne -
      Math.floor((definition.driftLaw.kind === "linear" ? definition.driftLaw.ratePerHourFixedPoint : 0) * 1_000 / 3_600);
    expect(integrateMeterValue(view, 2_000)).toBe(pieceOne);
    expect(integrateMeterValue(view, 3_000)).toBe(manual);
  });

  it("stacks by group priority and composes across groups", () => {
    const definition = linearDefinition();
    const weak = modifier({
      id: "mod-weak",
      meterKey: definition.key,
      operation: { kind: "rate_multiplier", multiplierFixedPoint: 20_000 },
      stackingGroup: "sweat",
      priority: 1,
    });
    const strong = modifier({
      id: "mod-strong",
      meterKey: definition.key,
      operation: { kind: "rate_multiplier", multiplierFixedPoint: 40_000 },
      stackingGroup: "sweat",
      priority: 5,
    });
    const add = modifier({
      id: "mod-add",
      meterKey: definition.key,
      operation: { kind: "rate_add", ratePerHourFixedPoint: 150 },
      stackingGroup: "heat",
      priority: 0,
    });
    const view: MeterIntegrationView = {
      definition,
      state: meterState(definition),
      modifiers: [weak, strong, add],
    };
    // Same group: priority 5 wins (×4 = 600/h); other group adds 150/h → 750/h.
    expect(integrateMeterValue(view, 3_600)).toBe(9_000 - 750);
  });

  it("scales a decay law's half-life with a multiplier", () => {
    const definition = reserveDefinition();
    const doubled = modifier({
      id: "mod-fast",
      meterKey: definition.key,
      operation: { kind: "rate_multiplier", multiplierFixedPoint: 20_000 },
    });
    const view: MeterIntegrationView = {
      definition,
      state: meterState(definition),
      modifiers: [doubled],
    };
    // Twice the speed halves the half-life: one hour costs two half-lives.
    expect(integrateMeterValue(view, 3_600)).toBe(2_000);
  });
});

describe("E5.1 threshold solving", () => {
  it("solves the first second on the crossed side, exactly", () => {
    const definition = linearDefinition();
    const view: MeterIntegrationView = { definition, state: meterState(definition), modifiers: [] };
    const crossing = solveNextThresholdCrossing(view, 0);
    expect(crossing).toBeDefined();
    // (9000 − 2500) · 3600 / 150 = 156 000 exactly.
    expect(crossing?.crossesAtStorySecond).toBe(156_000);
    expect(crossing?.valueAtCrossingFixedPoint).toBe(2_500);
    expect(integrateMeterValue(view, 155_999)).toBeGreaterThan(2_500);
  });

  it("accounts for future modifier boundaries when solving", () => {
    const definition = linearDefinition();
    const suspend = modifier({
      id: "mod-suspend",
      meterKey: definition.key,
      operation: { kind: "suspend" },
      validFromStorySecond: 1_000,
      validUntilStorySecond: 11_000,
    });
    const view: MeterIntegrationView = {
      definition,
      state: meterState(definition),
      modifiers: [suspend],
    };
    const crossing = solveNextThresholdCrossing(view, 0);
    // Value at the 1 000s boundary is 9 000 − ⌊150·1000/3600⌋ = 8 959; after
    // 10 000 suspended seconds the remaining 6 459 units cost 6 459·24 =
    // 155 016s — the solver's answer is exact against its own integration.
    expect(crossing?.crossesAtStorySecond).toBe(166_016);
    expect(crossing?.valueAtCrossingFixedPoint).toBe(2_500);
  });

  it("returns nothing when already crossed or out of horizon", () => {
    const definition = linearDefinition();
    const crossed: MeterIntegrationView = {
      definition,
      state: meterState(definition, { valueFixedPoint: 2_000 }),
      modifiers: [],
    };
    expect(solveNextThresholdCrossing(crossed, 0)).toBeUndefined();
    const suspended: MeterIntegrationView = {
      definition,
      state: meterState(definition),
      modifiers: [modifier({ id: "mod-freeze", meterKey: definition.key, operation: { kind: "suspend" } })],
    };
    expect(solveNextThresholdCrossing(suspended, 0)).toBeUndefined();
  });
});

describe("E5.1 resolvers and replay parity", () => {
  it("seeds the registry, arms initial alarms, and replays bit-identically", () => {
    const command = envelope("initialize_actor_body", {
      actorId: ACTOR,
      registryVersion: "body-v1",
      baselineOverrides: { arousal: 1_500 },
    });
    const resolution = resolveInitializeActorBody(
      { ...meta, actorExists: true, alreadyInitialized: false },
      // Envelope schemas validate inside the resolver's callers; parse here.
      parseInitialize(command),
    );
    if (!resolution.ok) throw new Error(`unexpected rejection ${resolution.code}`);
    expect(resolution.meters).toHaveLength(bodyMeterRegistryV1.length);
    expect(resolution.meters.find((m) => m.meterKey === "arousal")?.baselineFixedPoint).toBe(1_500);
    // energy and hygiene both carry falling thresholds → two alarms armed.
    const triggers = resolution.events.filter((event) => event.type === "trigger_scheduled");
    expect(triggers).toHaveLength(2);

    const replayed = replayBodiesHistory({
      seed: emptyBodiesSeed(BRANCH, meta.storySecond),
      events: resolution.events,
    });
    expect(replayed.meters).toEqual(sortBodiesProjection({
      ...emptyBodiesSeed(BRANCH, meta.storySecond),
      meters: resolution.meters,
    }).meters);
  });

  it("rejects player-principal seeding and double initialization", () => {
    const command = parseInitialize(
      envelope(
        "initialize_actor_body",
        { actorId: ACTOR, registryVersion: "body-v1", baselineOverrides: {} },
        { principal: principal("player") },
      ),
    );
    const rejected = resolveInitializeActorBody(
      { ...meta, actorExists: true, alreadyInitialized: false },
      command,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("unauthorized_principal");
    const doubled = resolveInitializeActorBody(
      { ...meta, actorExists: true, alreadyInitialized: true },
      parseInitialize(envelope("initialize_actor_body", { actorId: ACTOR, registryVersion: "body-v1", baselineOverrides: {} })),
    );
    expect(doubled.ok).toBe(false);
    if (!doubled.ok) expect(doubled.code).toBe("body_already_initialized");
  });

  it("applies a source at the integrated value and re-arms the meter's alarm", () => {
    const definition = linearDefinition();
    const state = meterState(definition, { lastIntegratedAtStorySecond: 0 });
    const command = parseSource(
      envelope("apply_body_source", {
        actorId: ACTOR,
        meterKey: definition.key,
        sourceKind: "wash",
        operation: { kind: "set", valueFixedPoint: 9_500 },
      }),
    );
    const resolution = resolveApplyBodySource(
      { ...meta, bodyInitialized: true, meter: state, definition, modifiers: [] },
      command,
    );
    if (!resolution.ok) throw new Error(`unexpected rejection ${resolution.code}`);
    expect(resolution.meter.valueFixedPoint).toBe(9_500);
    expect(resolution.meter.lastIntegratedAtStorySecond).toBe(meta.storySecond);
    const [sourceEvent] = resolution.events;
    expect(sourceEvent.payload.derived.fromValueFixedPoint).toBe(9_000);
    const rearm = resolution.events.find(
      (event): event is TriggerScheduledEvent => event.type === "trigger_scheduled",
    );
    // 9 500 → 2 500 at 150/h = 168 000s after the write.
    expect(rearm?.payload.dueStorySecond).toBe(meta.storySecond + 168_000);
    expect(rearm?.payload.uniquenessKey).toContain(String(sourceEvent.sequence));
  });

  it("clamps additive sources into the meter range", () => {
    const definition = linearDefinition();
    const command = parseSource(
      envelope("apply_body_source", {
        actorId: ACTOR,
        meterKey: definition.key,
        sourceKind: "exertion",
        operation: { kind: "add", deltaFixedPoint: 5_000 },
      }),
    );
    const resolution = resolveApplyBodySource(
      { ...meta, bodyInitialized: true, meter: meterState(definition), definition, modifiers: [] },
      command,
    );
    if (!resolution.ok) throw new Error(`unexpected rejection ${resolution.code}`);
    expect(resolution.meter.valueFixedPoint).toBe(10_000);
  });

  it("refuses a rate_add on a decay-law meter", () => {
    const definition = reserveDefinition();
    const command = parseModifier(
      envelope("apply_body_modifier", {
        actorId: ACTOR,
        modifier: {
          meterKey: definition.key,
          operation: { kind: "rate_add", ratePerHourFixedPoint: 100 },
          stackingGroup: "test",
        },
      }),
    );
    const resolution = resolveApplyBodyModifier(
      { ...meta, bodyInitialized: true, meter: meterState(definition), definition, modifiers: [] },
      command,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.code).toBe("rate_add_on_nonlinear_law");
  });

  it("runs a condition's full life: onset with owned modifiers, expiry alarm, ending", () => {
    const definition = reserveDefinition();
    const state = meterState(definition, { lastIntegratedAtStorySecond: meta.storySecond });
    const meterViews = new Map<string, MeterIntegrationView>([
      [definition.key, { definition, state, modifiers: [] }],
    ]);
    const applied = resolveApplyBodyCondition(
      { ...meta, bodyInitialized: true, activeSameKey: false, meterViews },
      parseCondition(
        envelope("apply_body_condition", {
          actorId: ACTOR,
          conditionKey: "asleep",
          durationSeconds: 5_400,
          modifiers: [
            { meterKey: definition.key, operation: { kind: "suspend" }, stackingGroup: "sleep" },
          ],
          observerActorIds: [],
        }),
      ),
    );
    if (!applied.ok) throw new Error(`unexpected rejection ${applied.code}`);
    expect(applied.condition.expiresAtStorySecond).toBe(meta.storySecond + 5_400);
    expect(applied.modifiers[0]?.validUntilStorySecond).toBe(meta.storySecond + 5_400);
    const expiry = applied.events.find(
      (event): event is TriggerScheduledEvent =>
        event.type === "trigger_scheduled" && event.payload.kind === "body_condition_expiry_due",
    );
    expect(expiry?.payload.dueStorySecond).toBe(meta.storySecond + 5_400);

    // Too-early expiry rejects; due expiry ends the condition and retires.
    const endMeta = { ...meta, storySecond: meta.storySecond + 5_400, headSequence: 10 };
    const early = resolveEndBodyCondition(
      {
        ...meta,
        headSequence: 10,
        condition: applied.condition,
        ownedModifiers: applied.modifiers,
        meterViews,
      },
      parseEnd(
        envelope(
          "end_body_condition",
          { actorId: ACTOR, conditionId: applied.condition.id, basis: "expired" },
          { principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] } },
        ),
      ),
    );
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.code).toBe("expiry_not_due");

    const ended = resolveEndBodyCondition(
      {
        ...endMeta,
        condition: applied.condition,
        ownedModifiers: applied.modifiers,
        meterViews,
      },
      parseEnd(
        envelope(
          "end_body_condition",
          { actorId: ACTOR, conditionId: applied.condition.id, basis: "expired" },
          { principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] } },
        ),
      ),
    );
    if (!ended.ok) throw new Error(`unexpected rejection ${ended.code}`);
    expect(ended.condition.status).toBe("ended");
    expect(ended.events[0].payload.retiredModifiers).toEqual([
      { modifierId: applied.modifiers[0]?.id, meterKey: definition.key },
    ]);
  });

  it("re-validates a due threshold, captures witnesses, and emits the crossing", () => {
    const definition = linearDefinition({
      thresholds: [
        {
          key: "grimy",
          boundaryFixedPoint: 2_500,
          direction: "falling",
          outcome: { kind: "condition_onset", conditionKey: "ill", durationSeconds: 600 },
          noticeable: true,
        },
      ],
    });
    const state = meterState(definition, { lastIntegratedAtStorySecond: 0 });
    const dueMeta = { ...meta, storySecond: 156_000 };
    const command = parseThreshold(
      envelope(
        "resolve_body_threshold",
        { actorId: ACTOR, meterKey: definition.key, thresholdKey: "grimy", armedAtSequence: 1 },
        { principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] } },
      ),
    );
    const resolution = resolveBodyThreshold(
      {
        ...dueMeta,
        meter: state,
        definition,
        modifiers: [],
        activeOutcomeConditionKey: false,
        coLocatedActorIds: ["actor-witness"],
      },
      command,
    );
    if (!resolution.ok) throw new Error(`unexpected rejection ${resolution.code}`);
    const [crossed, conditionEvent, expiryTrigger] = resolution.events;
    expect(crossed.payload.valueAtCrossingFixedPoint).toBe(2_500);
    expect(crossed.payload.observerActorIds).toEqual(["actor-witness"]);
    expect(conditionEvent?.type).toBe("body_condition_applied");
    expect(expiryTrigger?.type).toBe("trigger_scheduled");
    expect(resolution.condition?.key).toBe("ill");

    // Fire-time staleness: a fresher write moved the trajectory → reject.
    const stale = resolveBodyThreshold(
      {
        ...dueMeta,
        meter: meterState(definition, { valueFixedPoint: 9_000, lastIntegratedAtStorySecond: 150_000 }),
        definition,
        modifiers: [],
        coLocatedActorIds: [],
      },
      command,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("threshold_stale");
  });

  it("replays a full material history onto the same projection the resolvers produced", () => {
    const initialize = resolveInitializeActorBody(
      { ...meta, actorExists: true, alreadyInitialized: false },
      parseInitialize(envelope("initialize_actor_body", { actorId: ACTOR, registryVersion: "body-v1", baselineOverrides: {} })),
    );
    if (!initialize.ok) throw new Error("initialize rejected");
    const afterInit = replayBodiesHistory({
      seed: emptyBodiesSeed(BRANCH, meta.storySecond),
      events: initialize.events,
    });

    const hygiene = afterInit.meters.find((m) => m.meterKey === "hygiene");
    const definition = bodyMeterRegistryV1.find((d) => d.key === "hygiene");
    if (!hygiene || !definition) throw new Error("hygiene missing");
    const lastInit = initialize.events[initialize.events.length - 1];
    const source = resolveApplyBodySource(
      {
        ...meta,
        headSequence: lastInit?.sequence ?? 0,
        storySecond: meta.storySecond + 7_200,
        bodyInitialized: true,
        meter: hygiene,
        definition,
        modifiers: [],
      },
      parseSource(
        envelope(
          "apply_body_source",
          {
            actorId: ACTOR,
            meterKey: "hygiene",
            sourceKind: "wash",
            operation: { kind: "set", valueFixedPoint: 9_500 },
          },
          { id: "cmd-source-2", idempotencyKey: "key-source-2" },
        ),
      ),
    );
    if (!source.ok) throw new Error("source rejected");

    const replayed = replayBodiesHistory({
      seed: emptyBodiesSeed(BRANCH, meta.storySecond),
      events: [...initialize.events, ...source.events],
    });
    const replayedHygiene = replayed.meters.find((m) => m.meterKey === "hygiene");
    expect(replayedHygiene).toEqual(source.meter);
    // Two accepted commands → version 2; queries between never persisted.
    expect(replayed.version).toBe(2);

    // A partitioned fold (event-by-event applyBodyEvent) lands bit-identically.
    let folded = sortBodiesProjection(emptyBodiesSeed(BRANCH, meta.storySecond));
    for (const event of [...initialize.events, ...source.events]) {
      folded = applyBodyEvent(folded, event);
    }
    expect(folded.meters).toEqual(replayed.meters);
    expect(folded.conditions).toEqual(replayed.conditions);
    expect(folded.modifiers).toEqual(replayed.modifiers);
  });
});

describe("E5.2 climax and exertion couplings (§25.4)", () => {
  function arousalDefinition(): BodyMeterDefinition {
    return bodyMeterDefinitionSchema.parse({
      key: "arousal",
      class: "load",
      driftLaw: { kind: "linear", ratePerHourFixedPoint: 2_000, target: { kind: "baseline" } },
      initialFixedPoint: 0,
      baselineFixedPoint: 0,
      thresholds: [],
    });
  }

  it("resets arousal to its per-actor baseline and installs afterglow", () => {
    const definition = arousalDefinition();
    const state = meterState(definition, {
      valueFixedPoint: 8_000,
      baselineFixedPoint: 1_500,
      lastIntegratedAtStorySecond: meta.storySecond,
    });
    const command = parseSource(
      envelope("apply_body_source", {
        actorId: ACTOR,
        meterKey: "arousal",
        sourceKind: "climax",
        operation: { kind: "reset_to_baseline" },
      }),
    );
    const resolution = resolveApplyBodySource(
      {
        ...meta,
        bodyInitialized: true,
        meter: state,
        definition,
        modifiers: [],
        activeAfterglow: false,
      },
      command,
    );
    if (!resolution.ok) throw new Error(`unexpected rejection ${resolution.code}`);
    expect(resolution.meter.valueFixedPoint).toBe(1_500);
    expect(resolution.condition).toMatchObject({
      key: "afterglow",
      status: "active",
      expiresAtStorySecond: meta.storySecond + 1_800,
    });
    expect(resolution.events.map((event) => event.type)).toEqual([
      "body_source_applied",
      "body_condition_applied",
      "trigger_scheduled",
    ]);

    // A live afterglow suppresses a duplicate onset; the reset still lands.
    const again = resolveApplyBodySource(
      {
        ...meta,
        bodyInitialized: true,
        meter: state,
        definition,
        modifiers: [],
        activeAfterglow: true,
      },
      command,
    );
    if (!again.ok) throw new Error(`unexpected rejection ${again.code}`);
    expect(again.condition).toBeUndefined();
    expect(again.events.map((event) => event.type)).toEqual(["body_source_applied"]);
  });

  it("drains hygiene at half the energy cost of exertion, one causal record each", () => {
    const energy = reserveDefinition();
    const hygiene = linearDefinition();
    const command = parseSource(
      envelope("apply_body_source", {
        actorId: ACTOR,
        meterKey: "energy",
        sourceKind: "exertion",
        operation: { kind: "add", deltaFixedPoint: -1_000 },
      }),
    );
    const resolution = resolveApplyBodySource(
      {
        ...meta,
        bodyInitialized: true,
        meter: meterState(energy, { lastIntegratedAtStorySecond: meta.storySecond }),
        definition: energy,
        modifiers: [],
        coupledHygiene: {
          definition: hygiene,
          state: meterState(hygiene, { lastIntegratedAtStorySecond: meta.storySecond }),
          modifiers: [],
        },
      },
      command,
    );
    if (!resolution.ok) throw new Error(`unexpected rejection ${resolution.code}`);
    expect(resolution.meter.valueFixedPoint).toBe(7_000);
    expect(resolution.coupledMeter?.valueFixedPoint).toBe(8_500);
    const hygieneEvent = resolution.events.find(
      (event) => event.type === "body_source_applied" && event.payload.meterKey === "hygiene",
    );
    expect(hygieneEvent?.payload).toMatchObject({
      sourceKind: "exertion",
      operation: { kind: "add", deltaFixedPoint: -500 },
      valueAfterFixedPoint: 8_500,
    });
    // The coupled meter's alarm re-solves against its post-drain trajectory.
    const rearm = resolution.events.find(
      (event): event is TriggerScheduledEvent =>
        event.type === "trigger_scheduled" && event.payload.uniquenessKey.includes("grimy"),
    );
    expect(rearm).toBeDefined();
  });
});

describe("E5.2 slice 2b — collapse resolves into forced sleep and interruption", () => {
  const registryEnergy = ((): BodyMeterDefinition => {
    const definition = bodyMeterRegistryV1.find((candidate) => candidate.key === "energy");
    if (!definition) throw new Error("registry energy missing");
    return definition;
  })();

  function collapseView(overrides: Record<string, unknown> = {}) {
    return {
      ...meta,
      storySecond: 187_200,
      meter: meterState(registryEnergy, {
        valueFixedPoint: 800,
        lastIntegratedAtStorySecond: 187_200,
      }),
      definition: registryEnergy,
      modifiers: [],
      collapseContext: {
        rhythmRows: [],
        lastSleepEndedAtStorySecond: 187_200 - 40 * 3_600,
      },
      activeAsleep: false,
      interruptibleActivities: [],
      openEngagements: [],
      coLocatedActorIds: ["actor-witness"],
      ...overrides,
    };
  }

  function collapseCommand() {
    return parseCollapse(
      envelope(
        "resolve_body_collapse",
        { actorId: ACTOR, armedAtSequence: 5 },
        { principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] } },
      ),
    );
  }

  it("emits the collapse, interrupts held work, and forces the denied sleep", () => {
    const activity = activityInstanceSchema.parse({
      id: "activity-cooking",
      actionDefinitionId: "action-cook",
      actionVersion: 1,
      actorIds: [ACTOR],
      zoneId: "zone-kitchen",
      phase: "active",
      startedAt: 187_200 - 600,
      expectedCompleteAt: 187_200 + 600,
      progressFixedPoint: 0,
      claims: [{ kind: "body" }],
      sourceCommandId: "cmd-cook",
    });
    const engagement = engagementSchema.parse({
      id: "engagement-chat",
      participantIds: [ACTOR, "actor-witness"],
      channel: "co_present",
      locationId: "loc-home",
      zoneId: "zone-kitchen",
      state: "active",
      openedAt: 186_000,
      attentionClaim: { kind: "attention", weight: "full" },
      sourceCommandId: "cmd-chat",
    });
    const resolution = resolveBodyCollapse(
      collapseView({ interruptibleActivities: [activity], openEngagements: [engagement] }),
      collapseCommand(),
    );
    if (!resolution.ok) throw new Error(`unexpected rejection ${resolution.code}`);
    expect(resolution.events.map((event) => event.type)).toEqual([
      "body_collapsed",
      "activity_interrupted",
      "engagement_interrupted",
      "body_condition_applied",
      "body_modifier_applied",
      "trigger_scheduled",
    ]);
    const [collapsed, interrupted, sceneBreak, conditionEvent] = resolution.events;
    expect(collapsed?.type === "body_collapsed" && collapsed.payload.observerActorIds).toEqual([
      "actor-witness",
    ]);
    expect(
      interrupted?.type === "activity_interrupted" && interrupted.payload,
    ).toMatchObject({ reason: "collapse", progressFixedPoint: 500_000 });
    expect(sceneBreak?.type === "engagement_interrupted" && sceneBreak.payload).toMatchObject({
      reason: "participant_collapsed",
    });
    expect(
      conditionEvent?.type === "body_condition_applied" && conditionEvent.payload,
    ).toMatchObject({ conditionKey: "asleep", expiresAtStorySecond: 187_200 + 28_800 });
    expect(resolution.condition.key).toBe("asleep");
    expect(resolution.modifiers[0]?.operation).toEqual({ kind: "suspend" });
    expect(resolution.interruptedActivityIds).toEqual(["activity-cooking"]);
    expect(resolution.interruptedEngagementIds).toEqual(["engagement-chat"]);

    // Replay parity over the body slice of the stream.
    const folded = resolution.events
      .filter((event) => event.type !== "trigger_scheduled")
      .reduce(
        (projection, event) => applyBodyEvent(projection, event),
        sortBodiesProjection({
          ...emptyBodiesSeed(BRANCH, meta.storySecond),
          meters: [meterState(registryEnergy, { valueFixedPoint: 800, lastIntegratedAtStorySecond: 187_200 })],
          headSequence: meta.headSequence,
        }),
      );
    expect(folded.meters[0]?.valueFixedPoint).toBe(resolution.meter.valueFixedPoint);
    expect(folded.conditions[0]?.key).toBe("asleep");
    expect(folded.modifiers[0]?.operation).toEqual({ kind: "suspend" });
  });

  it("rejects stale collapses: already asleep, or the trajectory recovered", () => {
    const asleep = resolveBodyCollapse(collapseView({ activeAsleep: true }), collapseCommand());
    expect(asleep.ok).toBe(false);
    if (!asleep.ok) expect(asleep.code).toBe("collapse_stale");
    const recovered = resolveBodyCollapse(
      collapseView({
        meter: meterState(registryEnergy, {
          valueFixedPoint: 9_000,
          lastIntegratedAtStorySecond: 187_200,
        }),
      }),
      collapseCommand(),
    );
    expect(recovered.ok).toBe(false);
    if (!recovered.ok) expect(recovered.code).toBe("collapse_stale");
  });
});

// --- Command parsing helpers (the stores parse at their trust boundary) ------

function parseInitialize(raw: unknown) {
  return initializeActorBodyCommandSchema.parse(raw);
}
function parseSource(raw: unknown) {
  return applyBodySourceCommandSchema.parse(raw);
}
function parseModifier(raw: unknown) {
  return applyBodyModifierCommandSchema.parse(raw);
}
function parseCondition(raw: unknown) {
  return applyBodyConditionCommandSchema.parse(raw);
}
function parseEnd(raw: unknown) {
  return endBodyConditionCommandSchema.parse(raw);
}
function parseThreshold(raw: unknown) {
  return resolveBodyThresholdCommandSchema.parse(raw);
}
function parseCollapse(raw: unknown) {
  return resolveBodyCollapseCommandSchema.parse(raw);
}
