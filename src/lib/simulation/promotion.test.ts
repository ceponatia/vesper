import { describe, expect, it } from "vitest";
import {
  promoteActorFromCohortCommandSchema,
  simulationCohortSchema,
  type PromoteActorFromCohortCommand,
  type PromoteActorFromCohortCommandInput,
  type SimulationCohort,
} from "@/contracts/simulation";
import { storySecondAt } from "./body-reads";
import {
  derivedPromotedActorId,
  resolvePromoteActorFromCohortFromView,
  type PromoteActorFromCohortResolutionView,
} from "./promotion";

const WORLD = "world-1";
const BRANCH = "branch-1";
const SQUARE = "zone-square";
const TAVERN = "zone-tavern";
const LOCATION = "location-town";

/** Market regulars: 200 people, at the square 08:00–18:00 at 80% strength. */
function marketCohort(
  overrides: Partial<Parameters<typeof simulationCohortSchema.parse>[0]> & object = {},
): SimulationCohort {
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

function view(
  overrides: Partial<PromoteActorFromCohortResolutionView> = {},
): PromoteActorFromCohortResolutionView {
  return {
    worldId: WORLD,
    branchId: BRANCH,
    rulesetVersion: "ruleset-v1",
    headSequence: 10,
    // 10:00 on day 1 — inside the market window.
    storySecond: storySecondAt(1, 600),
    worldSeed: "seed-1",
    cohort: marketCohort(),
    zoneLocationId: LOCATION,
    actorExists: false,
    namePool: () => [],
    ...overrides,
  };
}

function cmd(
  payload: Partial<PromoteActorFromCohortCommandInput["payload"]> = {},
  overrides: Partial<Pick<PromoteActorFromCohortCommandInput, "branchId" | "principal" | "id">> = {},
): PromoteActorFromCohortCommand {
  return promoteActorFromCohortCommandSchema.parse({
    id: overrides.id ?? "cmd-promote-1",
    branchId: overrides.branchId ?? BRANCH,
    expectedVersion: 0,
    idempotencyKey: "promote-key-1",
    principal: overrides.principal ?? {
      kind: "storyteller",
      principalId: "storyteller-1",
      controlledActorIds: [],
    },
    submittedAtWallClock: "2026-07-21T12:00:00.000Z",
    correlationId: "corr-1",
    type: "promote_actor_from_cohort",
    schemaVersion: 1,
    payload: {
      cohortId: "cohort-market",
      zoneId: SQUARE,
      name: "Maren",
      landing: { simulationLod: "event", inferenceLod: "no_model" },
      ...payload,
    },
  });
}

describe("resolvePromoteActorFromCohortFromView (E6.4, §27.2/§27.7)", () => {
  it("rejects branch mismatch, non-privileged principals, unknown cohorts and zones", () => {
    expect(
      resolvePromoteActorFromCohortFromView(view(), cmd({}, { branchId: "branch-2" })),
    ).toMatchObject({ ok: false, code: "branch_mismatch" });
    expect(
      resolvePromoteActorFromCohortFromView(
        view(),
        cmd({}, { principal: { kind: "player", principalId: "player-1", controlledActorIds: [] } }),
      ),
    ).toMatchObject({ ok: false, code: "unauthorized_principal" });
    expect(
      resolvePromoteActorFromCohortFromView(view({ cohort: undefined }), cmd()),
    ).toMatchObject({ ok: false, code: "cohort_not_found" });
    expect(
      resolvePromoteActorFromCohortFromView(view({ zoneLocationId: undefined }), cmd()),
    ).toMatchObject({ ok: false, code: "zone_not_found" });
  });

  it("rejects an empty cohort before presence, and a collision on the derived id", () => {
    expect(
      resolvePromoteActorFromCohortFromView(view({ cohort: marketCohort({ population: 0 }) }), cmd()),
    ).toMatchObject({ ok: false, code: "insufficient_population" });
    expect(
      resolvePromoteActorFromCohortFromView(view({ actorExists: true }), cmd()),
    ).toMatchObject({ ok: false, code: "actor_already_exists" });
  });

  it("enforces §27.2 step 5 as the presence read: an empty windowed zone yields no one", () => {
    // Inside the window, someone can step out of the square crowd (160 there)
    // or out of the dispersed remainder (40 elsewhere).
    expect(resolvePromoteActorFromCohortFromView(view(), cmd({ zoneId: SQUARE }))).toMatchObject({
      ok: true,
    });
    expect(resolvePromoteActorFromCohortFromView(view(), cmd({ zoneId: TAVERN }))).toMatchObject({
      ok: true,
    });

    // population 1 at 50% share floors to 0 present — the read says the
    // square is empty, so no one can materialize THERE...
    const loner = marketCohort({
      population: 1,
      presenceWindows: [
        { zoneId: SQUARE, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 5_000 },
      ],
    });
    expect(
      resolvePromoteActorFromCohortFromView(view({ cohort: loner }), cmd({ zoneId: SQUARE })),
    ).toMatchObject({ ok: false, code: "cohort_not_present" });
    // ...but the dispersed remainder of 1 admits them anywhere else.
    expect(
      resolvePromoteActorFromCohortFromView(view({ cohort: loner }), cmd({ zoneId: TAVERN })),
    ).toMatchObject({ ok: true });

    // A fully-present crowd (share 10 000) has no dispersed remainder — away
    // zones reject while the windowed zone accepts.
    const allIn = marketCohort({
      presenceWindows: [
        { zoneId: SQUARE, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 10_000 },
      ],
    });
    expect(
      resolvePromoteActorFromCohortFromView(view({ cohort: allIn }), cmd({ zoneId: TAVERN })),
    ).toMatchObject({ ok: false, code: "cohort_not_present" });

    // Outside every window the cohort is dispersed — anywhere is legal.
    const nightView = view({ storySecond: storySecondAt(1, 200) });
    expect(resolvePromoteActorFromCohortFromView(nightView, cmd({ zoneId: TAVERN }))).toMatchObject({
      ok: true,
    });
  });

  it("emits the causation-chained three-event train with the reservation debit first", () => {
    const result = resolvePromoteActorFromCohortFromView(view(), cmd());
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);
    const [debit, materialized, lodAssigned] = result.events;

    expect(debit).toMatchObject({
      type: "cohort_adjusted",
      sequence: 11,
      payload: {
        cohortId: "cohort-market",
        deltaCount: -1,
        reason: "promotion_reservation",
        populationBefore: 200,
        populationAfter: 199,
      },
    });
    expect(materialized).toMatchObject({
      type: "actor_materialized_from_aggregate",
      sequence: 12,
      causationId: debit.id,
      payload: {
        actorId: derivedPromotedActorId(BRANCH, "cmd-promote-1"),
        name: "Maren",
        cohortId: "cohort-market",
        zoneId: SQUARE,
        locationId: LOCATION,
      },
    });
    expect(materialized.payload.sampledDetail).toBeUndefined();
    expect(lodAssigned).toMatchObject({
      type: "actor_lod_assigned",
      sequence: 13,
      causationId: materialized.id,
      payload: {
        simulationLod: "event",
        inferenceLod: "no_model",
        previousSimulationLod: "exact",
        previousInferenceLod: "deliberator",
        previousWasDefault: true,
      },
    });

    expect(result.cohortAfter.population).toBe(199);
    expect(result.actor).toEqual({
      id: derivedPromotedActorId(BRANCH, "cmd-promote-1"),
      name: "Maren",
    });
    expect(result.locus).toMatchObject({
      kind: "at",
      actorId: result.actor.id,
      locationId: LOCATION,
      zoneId: SQUARE,
      since: storySecondAt(1, 600),
    });
    expect(result.lodState).toMatchObject({ simulationLod: "event", inferenceLod: "no_model" });
  });

  it("samples an omitted name deterministically with the draw captured; rejects when no pool exists", () => {
    expect(resolvePromoteActorFromCohortFromView(view(), cmd({ name: undefined }))).toMatchObject({
      ok: false,
      code: "name_required",
    });

    const pool = ["Ash", "Bram", "Cole", "Dara"];
    const first = resolvePromoteActorFromCohortFromView(
      view({ namePool: () => pool }),
      cmd({ name: undefined }),
    );
    const second = resolvePromoteActorFromCohortFromView(
      view({ namePool: () => pool }),
      cmd({ name: undefined }),
    );
    if (!first.ok || !second.ok) throw new Error("expected sampled acceptances");
    // Same command id + stream + seed → the identical draw, replay-stable.
    expect(first.actor.name).toBe(second.actor.name);
    expect(pool).toContain(first.actor.name);
    const detail = first.events[1].payload.sampledDetail;
    expect(detail).toMatchObject({ drawIndex: 0, sampledName: first.actor.name });
    expect(detail?.stream).toContain("promotion-detail");
  });

  it("schema-rejects a below-event landing — materializing into no-scheduled-work is a contradiction", () => {
    expect(() =>
      promoteActorFromCohortCommandSchema.parse({
        ...cmd(),
        payload: {
          cohortId: "cohort-market",
          zoneId: SQUARE,
          name: "Maren",
          landing: { simulationLod: "dormant", inferenceLod: "no_model" },
        },
      }),
    ).toThrow();
  });
});
