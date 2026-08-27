import { describe, expect, it } from "vitest";
import {
  adjustCohortCommandSchema,
  cohortPresenceWindowSchema,
  createCohortCommandSchema,
  simulationCohortSchema,
  type AdjustCohortCommand,
  type AdjustCohortCommandInput,
  type CreateCohortCommand,
  type SimulationCohort,
} from "../contracts/cohorts";
import {
  bindSimEnvelopes,
  type CommandEnvelopeSpec,
  type TestPrincipal,
} from "../test-support/sim-envelopes";
import { storySecondAt } from "./body-reads";
import {
  applyCohortEvent,
  cohortCanMaterializeAt,
  cohortPresenceAt,
  cohortWindowCovering,
  emptyCohortsSeed,
  replayCohortHistory,
  resolveAdjustCohortFromView,
  resolveCreateCohortFromView,
  zonePresenceAt,
  type AdjustCohortResolutionView,
  type CreateCohortResolutionView,
} from "./cohorts";

const WORLD = "world-1";
const BRANCH = "branch-1";
const SQUARE = "zone-square";
const TAVERN = "zone-tavern";
const RULESET = "ruleset-v1";

/**
 * This suite carries its own ruleset, so bind the trio once: a view's
 * `branchId` is compared against the command's, and a mismatch would flip
 * every resolver to `branch_mismatch`.
 */
const env = bindSimEnvelopes({ worldId: WORLD, branchId: BRANCH, rulesetVersion: RULESET });

/** Everything a call site may override; `type`/`payload` are pinned per builder. */
type CmdSpec = Omit<CommandEnvelopeSpec, "type" | "payload">;

/** The privileged default carries its own principal id, so it stays explicit. */
const STORYTELLER: TestPrincipal = {
  kind: "storyteller",
  principalId: "storyteller-1",
  controlledActorIds: [],
};

/** Market regulars: 200 people, at the square 08:00–18:00 at 80% strength. */
function marketCohort(overrides: Partial<Parameters<typeof simulationCohortSchema.parse>[0]> & object = {}): SimulationCohort {
  return simulationCohortSchema.parse({
    id: "cohort-market",
    name: "market regulars",
    population: 200,
    presenceWindows: [
      { zoneId: SQUARE, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 8_000 },
    ],
    registryVersion: "cohort-v1",
    ...overrides,
  });
}

function createView(overrides: Partial<CreateCohortResolutionView> = {}): CreateCohortResolutionView {
  return {
    ...env.meta({ headSequence: 7, storySecond: 3_600 }),
    alreadyExists: false,
    zoneExists: (zoneId) => zoneId === SQUARE || zoneId === TAVERN,
    ...overrides,
  };
}

function createCmd(cohort: SimulationCohort, spec: CmdSpec = {}): CreateCohortCommand {
  return env.command(createCohortCommandSchema, {
    type: "create_cohort",
    idSlug: "cohort-1",
    principal: STORYTELLER,
    payload: { cohort },
    ...spec,
  });
}

function adjustCmd(payload: AdjustCohortCommandInput["payload"], spec: CmdSpec = {}): AdjustCohortCommand {
  return env.command(adjustCohortCommandSchema, {
    type: "adjust_cohort",
    idSlug: "adjust-1",
    principal: STORYTELLER,
    payload,
    ...spec,
  });
}

function adjustView(current: SimulationCohort | undefined): AdjustCohortResolutionView {
  return {
    ...env.meta({ headSequence: 8, storySecond: 7_200 }),
    current,
  };
}

describe("analytic presence (E6.3)", () => {
  it("resolves the covering window half-open, wrapping midnight, earliest on overlap", () => {
    const windows = marketCohort().presenceWindows;
    expect(cohortWindowCovering(windows, storySecondAt(1, 480))).toBeDefined();
    expect(cohortWindowCovering(windows, storySecondAt(1, 1_079))).toBeDefined();
    expect(cohortWindowCovering(windows, storySecondAt(1, 1_080))).toBeUndefined();
    expect(cohortWindowCovering(windows, storySecondAt(1, 479))).toBeUndefined();

    const nightWatch = [
      cohortPresenceWindowSchema.parse({
        zoneId: SQUARE,
        startMinuteOfDay: 1_320,
        endMinuteOfDay: 240,
        shareFixedPoint: 10_000,
      }),
    ];
    expect(cohortWindowCovering(nightWatch, storySecondAt(1, 1_380))).toBeDefined();
    expect(cohortWindowCovering(nightWatch, storySecondAt(2, 120))).toBeDefined();
    expect(cohortWindowCovering(nightWatch, storySecondAt(2, 300))).toBeUndefined();

    const overlapping = marketCohort({
      presenceWindows: [
        { zoneId: TAVERN, startMinuteOfDay: 600, endMinuteOfDay: 900, shareFixedPoint: 5_000 },
        { zoneId: SQUARE, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 8_000 },
      ],
    });
    // 11:00 is inside both; the earlier start wins deterministically.
    expect(cohortWindowCovering(overlapping.presenceWindows, storySecondAt(1, 660))).toMatchObject({
      zoneId: SQUARE,
    });
  });

  it("reads presence as floored share of population, zero-count included, dispersed as undefined", () => {
    const cohort = marketCohort();
    expect(cohortPresenceAt(cohort, storySecondAt(1, 600))).toEqual({
      zoneId: SQUARE,
      presentCount: 160,
    });
    expect(cohortPresenceAt(cohort, storySecondAt(1, 200))).toBeUndefined();

    // 33% of 7 floors to 2 — integer people, never fractions.
    const seven = marketCohort({
      population: 7,
      presenceWindows: [{ zoneId: SQUARE, startMinuteOfDay: 0, endMinuteOfDay: 1_439, shareFixedPoint: 3_300 }],
    });
    expect(cohortPresenceAt(seven, storySecondAt(1, 60))?.presentCount).toBe(2);

    // An empty square is a real read, not an absence.
    const nobody = marketCohort({ population: 0 });
    expect(cohortPresenceAt(nobody, storySecondAt(1, 600))).toEqual({ zoneId: SQUARE, presentCount: 0 });
  });

  it("admits materialization only where the presence read admits a person (E6.4)", () => {
    const inWindow = storySecondAt(1, 600);
    // 160 at the square, 40 dispersed — both admit.
    expect(cohortCanMaterializeAt(marketCohort(), SQUARE, inWindow)).toBe(true);
    expect(cohortCanMaterializeAt(marketCohort(), TAVERN, inWindow)).toBe(true);
    // Outside every window: dispersed, anywhere goes.
    expect(cohortCanMaterializeAt(marketCohort(), TAVERN, storySecondAt(1, 200))).toBe(true);
    // Nobody at all: nowhere.
    expect(cohortCanMaterializeAt(marketCohort({ population: 0 }), SQUARE, inWindow)).toBe(false);
    // Fully present (share 10 000): no dispersed remainder to draw elsewhere.
    const allIn = marketCohort({
      presenceWindows: [
        { zoneId: SQUARE, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 10_000 },
      ],
    });
    expect(cohortCanMaterializeAt(allIn, SQUARE, inWindow)).toBe(true);
    expect(cohortCanMaterializeAt(allIn, TAVERN, inWindow)).toBe(false);
    // A floored-to-zero windowed count is a REAL empty read — no one there.
    const loner = marketCohort({
      population: 1,
      presenceWindows: [
        { zoneId: SQUARE, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 5_000 },
      ],
    });
    expect(cohortCanMaterializeAt(loner, SQUARE, inWindow)).toBe(false);
    expect(cohortCanMaterializeAt(loner, TAVERN, inWindow)).toBe(true);
  });

  it("sums zone presence across cohorts", () => {
    const market = marketCohort();
    const drinkers = marketCohort({
      id: "cohort-drinkers",
      name: "tavern regulars",
      population: 40,
      presenceWindows: [
        { zoneId: TAVERN, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 10_000 },
      ],
    });
    const idlers = marketCohort({
      id: "cohort-idlers",
      name: "square idlers",
      population: 25,
      presenceWindows: [
        { zoneId: SQUARE, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 10_000 },
      ],
    });
    const all = [market, drinkers, idlers];
    expect(zonePresenceAt(all, SQUARE, storySecondAt(1, 600))).toBe(185);
    expect(zonePresenceAt(all, TAVERN, storySecondAt(1, 600))).toBe(40);
    expect(zonePresenceAt(all, SQUARE, storySecondAt(1, 200))).toBe(0);
  });
});

describe("resolveCreateCohortFromView (E6.3)", () => {
  it("rejects branch mismatch, non-privileged principals, duplicates, and unknown zones", () => {
    expect(
      resolveCreateCohortFromView(createView(), createCmd(marketCohort(), { branchId: "branch-2" })),
    ).toMatchObject({ ok: false, code: "branch_mismatch" });
    expect(
      resolveCreateCohortFromView(
        createView(),
        createCmd(marketCohort(), {
          principal: { kind: "player", principalId: "player-1", controlledActorIds: [] },
        }),
      ),
    ).toMatchObject({ ok: false, code: "unauthorized_principal" });
    expect(
      resolveCreateCohortFromView(createView({ alreadyExists: true }), createCmd(marketCohort())),
    ).toMatchObject({ ok: false, code: "cohort_already_exists" });
    expect(
      resolveCreateCohortFromView(
        createView({ zoneExists: () => false }),
        createCmd(marketCohort()),
      ),
    ).toMatchObject({ ok: false, code: "zone_not_found" });
  });

  it("accepts a privileged creation, emitting the full-shape event", () => {
    const result = resolveCreateCohortFromView(createView(), createCmd(marketCohort()));
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    expect(result.event).toMatchObject({
      type: "cohort_created",
      sequence: 8,
      actorIds: [],
      entityIds: ["cohort-market"],
      payload: { cohort: { id: "cohort-market", population: 200 } },
    });
  });
});

describe("resolveAdjustCohortFromView (E6.3)", () => {
  it("rejects an unknown cohort and a debit below zero; accepts an exact drain to zero", () => {
    expect(
      resolveAdjustCohortFromView(adjustView(undefined), adjustCmd({ cohortId: "cohort-market", deltaCount: -1, reason: "attrition" })),
    ).toMatchObject({ ok: false, code: "cohort_not_found" });
    expect(
      resolveAdjustCohortFromView(
        adjustView(marketCohort()),
        adjustCmd({ cohortId: "cohort-market", deltaCount: -201, reason: "attrition" }),
      ),
    ).toMatchObject({ ok: false, code: "insufficient_population" });

    const drained = resolveAdjustCohortFromView(
      adjustView(marketCohort()),
      adjustCmd({ cohortId: "cohort-market", deltaCount: -200, reason: "attrition" }),
    );
    if (!drained.ok) throw new Error(`expected acceptance, got ${drained.code}`);
    expect(drained.cohort.population).toBe(0);
    expect(drained.event.payload).toMatchObject({
      deltaCount: -200,
      reason: "attrition",
      populationBefore: 200,
      populationAfter: 0,
    });
  });

  it("captures an influx with both counts on the event", () => {
    const grown = resolveAdjustCohortFromView(
      adjustView(marketCohort()),
      adjustCmd({ cohortId: "cohort-market", deltaCount: 55, reason: "influx" }),
    );
    if (!grown.ok) throw new Error(`expected acceptance, got ${grown.code}`);
    expect(grown.event.payload).toMatchObject({ populationBefore: 200, populationAfter: 255 });
  });
});

describe("cohort replay (E6.3)", () => {
  it("folds creation and adjustments into conserved rows", () => {
    const created = resolveCreateCohortFromView(
      createView({ headSequence: 0 }),
      createCmd(marketCohort()),
    );
    if (!created.ok) throw new Error("create failed");
    const adjusted = resolveAdjustCohortFromView(
      { ...adjustView(created.cohort), headSequence: 1 },
      adjustCmd({ cohortId: "cohort-market", deltaCount: -30, reason: "promotion_reservation" }),
    );
    if (!adjusted.ok) throw new Error("adjust failed");

    const replayed = replayCohortHistory({
      seed: emptyCohortsSeed(BRANCH, 0),
      events: [created.event, adjusted.event],
    });
    expect(replayed.cohorts).toHaveLength(1);
    expect(replayed.cohorts[0]).toMatchObject({ id: "cohort-market", population: 170 });
    expect(replayed.headSequence).toBe(2);
    expect(replayed.version).toBe(2);
  });

  it("advances the boundary without rows for a non-cohort event, and throws on a gap", () => {
    const created = resolveCreateCohortFromView(createView({ headSequence: 1 }), createCmd(marketCohort()));
    if (!created.ok) throw new Error("create failed");
    const folded = applyCohortEvent(emptyCohortsSeed(BRANCH, 0), {
      ...created.event,
      type: "cohort_created",
    });
    expect(folded.cohorts).toHaveLength(1);
    expect(() =>
      replayCohortHistory({ seed: emptyCohortsSeed(BRANCH, 0), events: [created.event] }),
    ).toThrow(/sequence gap/);
  });
});
