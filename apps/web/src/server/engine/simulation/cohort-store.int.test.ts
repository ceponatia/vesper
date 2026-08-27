import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import {
  cohortPresenceAt,
  emptyCohortsSeed,
  replayCohortHistory,
  zonePresenceAt,
} from "@vesper/simulation-core/cohorts";
import { db, simCohorts, simMeansBands, simTriggers } from "@/server/db";
import { loadBranchCohorts, submitDurableAdjustCohort, submitDurableCreateCohort } from "./cohort-store";
import { submitDurableSetMeansBand } from "./household-store";
import {
  ADMIT_AT_LOCKED_VERSION,
  expectAccepted,
  expectRejected,
  forkAtHead,
  readBranchEvents,
  seedSimpleBranch,
  simCommand,
  simulationSuiteHarness,
  type SimTestPrincipal,
} from "@/server/test-support";

/**
 * E6.3 durable cohort authority: create/adjust end to
 * end — zone validation, conservation, idempotency, authorization, the
 * cohort means band, fork parity, and the aggregate no-work guarantee (a
 * cohort never arms a trigger). Runs on the shared `simulationSuiteHarness`
 * scaffold (probe + legacy-player guard + world teardown + pool close).
 */

const harness = await simulationSuiteHarness({ suite: "cohort-store.int.test", table: "sim_cohorts" });

/** Day 2, 07:33. The market window (08:00–18:00) opens 27 minutes later. */
const SEED_SECOND = 200_000;
const MARKET_OPEN_SECOND = 2 * 86_400 + 600 * 60; // day 2, 10:00 — mid-window

interface CohortCase {
  worldId: string;
  branchId: string;
  locationId: string;
  squareZoneId: string;
  ana: string;
}

async function seedCase(): Promise<CohortCase> {
  const ana = newId();
  const seeded = await seedSimpleBranch({
    prefix: "e6-3-test",
    actors: [{ id: ana, name: "Ana" }],
    originStorySecond: SEED_SECOND,
    locationSlug: "town",
    locationKind: "town",
    zoneSlug: "square",
    zoneKind: "plaza",
  });
  harness.trackWorld(seeded.worldId);
  return {
    worldId: seeded.worldId,
    branchId: seeded.branchId,
    locationId: seeded.locationId,
    squareZoneId: seeded.zoneId,
    ana,
  };
}

function command(
  ids: CohortCase,
  name: string,
  type: string,
  payload: Record<string, unknown>,
  principal?: SimTestPrincipal,
) {
  return simCommand({
    branchId: ids.branchId,
    name,
    type,
    payload,
    ...(principal === undefined ? {} : { principal }),
  });
}

function marketPayload(ids: CohortCase, cohortId: string, population = 200) {
  return {
    cohort: {
      id: cohortId,
      name: "market regulars",
      population,
      presenceWindows: [
        { zoneId: ids.squareZoneId, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 8_000 },
      ],
      registryVersion: "cohort-v1",
    },
  };
}

describe.runIf(harness.ready)("E6.3 durable cohort authority", () => {
  it("creates, adjusts conservatively, wears a means band, and forks with parity", async () => {
    const ids = await seedCase();
    const cohortId = newId();

    // A cohort cannot gather somewhere that does not exist.
    const ghostZone = await submitDurableCreateCohort(
      command(ids, "ghost-zone", "create_cohort", {
        cohort: {
          ...marketPayload(ids, cohortId).cohort,
          presenceWindows: [
            { zoneId: `${ids.branchId}-zone-nowhere`, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 8_000 },
          ],
        },
      }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectRejected(ghostZone, "zone_not_found", "a cohort gathering in a zone that does not exist");

    // A player principal cannot people the background.
    const unauthorized = await submitDurableCreateCohort(
      command(ids, "player-create", "create_cohort", marketPayload(ids, cohortId), {
        kind: "player",
        principalId: "player-1",
        controlledActorIds: [ids.ana],
      }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectRejected(unauthorized, "unauthorized_principal", "a player peopling the background");

    const created = await submitDurableCreateCohort(
      command(ids, "create-market", "create_cohort", marketPayload(ids, cohortId)),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectAccepted(created, "create the market cohort");
    const duplicated = await submitDurableCreateCohort(
      command(ids, "create-market-again", "create_cohort", marketPayload(ids, cohortId)),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectRejected(duplicated, "cohort_already_exists", "a second cohort under the same id");
    // Idempotency: the same command replays its cached result.
    const replayedCreate = await submitDurableCreateCohort(
      command(ids, "create-market", "create_cohort", marketPayload(ids, cohortId)),
      ADMIT_AT_LOCKED_VERSION,
    );
    expect(replayedCreate).toEqual(created);

    // The analytic presence read: mid-window, 80% of 200 at the square —
    // and the read wrote nothing.
    const cohorts = await loadBranchCohorts(db(), ids.branchId);
    expect(cohorts).toHaveLength(1);
    const presentCohort = cohorts[0];
    if (!presentCohort) throw new Error("cohort row missing");
    expect(cohortPresenceAt(presentCohort, MARKET_OPEN_SECOND)).toEqual({
      zoneId: ids.squareZoneId,
      presentCount: 160,
    });
    expect(zonePresenceAt(cohorts, ids.squareZoneId, SEED_SECOND)).toBe(0);

    // Conserved adjustment: a promotion-style debit lands both counts on the
    // event; draining below zero is a structured rejection.
    const debited = await submitDurableAdjustCohort(
      command(ids, "reserve-one", "adjust_cohort", {
        cohortId,
        deltaCount: -1,
        reason: "promotion_reservation",
      }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectAccepted(debited, "debit one of the market regulars");
    const overdrawn = await submitDurableAdjustCohort(
      command(ids, "overdraw", "adjust_cohort", { cohortId, deltaCount: -500, reason: "attrition" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectRejected(overdrawn, "insufficient_population", "draining the cohort below zero");
    const [adjustedRow] = await db()
      .select()
      .from(simCohorts)
      .where(and(eq(simCohorts.branchId, ids.branchId), eq(simCohorts.cohortId, cohortId)));
    expect(adjustedRow).toMatchObject({ population: 199 });
    const adjustEvents = await readBranchEvents(ids.branchId, { types: ["cohort_adjusted"] });
    expect(adjustEvents).toHaveLength(1);
    expect(adjustEvents[0]?.payload).toMatchObject({
      cohortId,
      deltaCount: -1,
      reason: "promotion_reservation",
      populationBefore: 200,
      populationAfter: 199,
    });

    // Means-band extension: a cohort wears a means band; a ghost cohort cannot.
    const banded = await submitDurableSetMeansBand(
      command(ids, "band-market", "set_means_band", {
        subject: { kind: "cohort", cohortId },
        bandKey: "modest",
      }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectAccepted(banded, "band the market cohort");
    const ghostBand = await submitDurableSetMeansBand(
      command(ids, "band-ghost", "set_means_band", {
        subject: { kind: "cohort", cohortId: newId() },
        bandKey: "modest",
      }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectRejected(ghostBand, "subject_not_found", "banding a cohort that never existed");
    const bandRows = await db()
      .select({ subjectKind: simMeansBands.subjectKind, cohortId: simMeansBands.cohortId, bandKey: simMeansBands.bandKey })
      .from(simMeansBands)
      .where(eq(simMeansBands.branchId, ids.branchId));
    expect(bandRows).toContainEqual({ subjectKind: "cohort", cohortId, bandKey: "modest" });

    // The aggregate lane arms nothing, ever.
    const pendingTriggers = await db()
      .select({ id: simTriggers.id })
      .from(simTriggers)
      .where(and(eq(simTriggers.branchId, ids.branchId), eq(simTriggers.state, "pending")));
    expect(pendingTriggers).toHaveLength(0);

    // Fork at head: the child's cohort rows replay bit-identical from events
    // and the child's presence read matches the parent's.
    const { childBranchId, parentEvents } = await forkAtHead({
      parentBranchId: ids.branchId,
      reason: "E6.3 cohort fork parity",
    });
    const replayedProjection = replayCohortHistory({
      seed: emptyCohortsSeed(childBranchId, SEED_SECOND),
      events: parentEvents,
    });
    const childCohorts = await loadBranchCohorts(db(), childBranchId);
    expect(childCohorts).toEqual(replayedProjection.cohorts);
    const childCohort = childCohorts[0];
    if (!childCohort) throw new Error("child cohort row missing");
    expect(cohortPresenceAt(childCohort, MARKET_OPEN_SECOND)).toEqual({
      zoneId: ids.squareZoneId,
      presentCount: Math.floor((199 * 8_000) / 10_000),
    });
  });
});
