import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import { derivedPromotedActorId } from "@vesper/simulation-core/promotion";
import {
  db,
  simActorLods,
  simBranches,
  simCharacters,
  simCohorts,
  simPhysicalLoci,
  simTriggers,
} from "@/server/db";
import {
  ADMIT_AT_LOCKED_VERSION,
  expectAccepted,
  expectRejected,
  forkAtHead,
  legacyEngineTestPlayerPrincipal,
  playerPrincipal,
  readBranchEvents,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
} from "@/server/test-support";
import { submitDurableInitializeActorBody } from "./body-store";
import { forkBranch } from "./branch-store";
import { submitDurableCreateCohort } from "./cohort-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { submitDurableAssignActorLod } from "./lod-store";
import { submitDurablePromoteActorFromCohort } from "./promotion-store";

/**
 * E6.4 durable actor promotion and dependency wake:
 * the five-step promotion end to end — reservation debit, materialization
 * (character + locus + landing LOD in one transaction), presence legality,
 * conservation across the read, idempotency, fork parity on both sides of the
 * promotion — and an engagement waking a dormant participant with catch-up
 * alarms re-solved from law. Probe, legacy-player opt-in, seeded-world teardown
 * and pool close come from the shared `simulationSuiteHarness`.
 */

const harness = await simulationSuiteHarness({
  suite: "promotion-store.int.test",
  table: "sim_cohorts",
});
const ready = harness.ready;

/** Day 2, 10:00 — mid market window (08:00–18:00), so presence legality bites. */
const SEED_SECOND = 2 * 86_400 + 600 * 60;

interface PromotionCase {
  worldId: string;
  branchId: string;
  locationId: string;
  squareZoneId: string;
  tavernZoneId: string;
  ana: string;
  riven: string;
}

async function seedCase(): Promise<PromotionCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: PromotionCase = {
    worldId,
    branchId,
    locationId: `${worldId}-loc-town`,
    squareZoneId: `${branchId}-zone-square`,
    tavernZoneId: `${branchId}-zone-tavern`,
    ana: newId(),
    riven: newId(),
  };
  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: "e6-4-test-world",
    rulesetVersion: "e6-4-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.ana, name: "Ana" },
      { id: ids.riven, name: "Riven" },
    ],
    locations: [{ id: ids.locationId, worldId, kind: "town", defaultAccessPolicy: "public" }],
    zones: [
      { id: ids.squareZoneId, locationId: ids.locationId, kind: "plaza", privacyPolicy: "public" },
      { id: ids.tavernZoneId, locationId: ids.locationId, kind: "tavern", privacyPolicy: "public" },
    ],
    placements: [
      { actorId: ids.ana, locationId: ids.locationId, zoneId: ids.squareZoneId },
      { actorId: ids.riven, locationId: ids.locationId, zoneId: ids.squareZoneId },
    ],
  });
  harness.trackWorld(worldId);
  return ids;
}

const admit = ADMIT_AT_LOCKED_VERSION;

function command(
  ids: PromotionCase,
  name: string,
  type: string,
  payload: Record<string, unknown>,
  principal?: Parameters<typeof simCommand>[0]["principal"],
) {
  return simCommand({
    branchId: ids.branchId,
    name,
    type,
    payload,
    ...(principal === undefined ? {} : { principal }),
  });
}

function cohortPayload(
  ids: PromotionCase,
  cohortId: string,
  population: number,
  shareFixedPoint: number,
) {
  return {
    cohort: {
      id: cohortId,
      name: "market regulars",
      population,
      presenceWindows: [
        { zoneId: ids.squareZoneId, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint },
      ],
      registryVersion: "cohort-v1",
    },
  };
}

/** The branch's current head — the fork boundary a test captures before a step. */
async function branchHeadSequence(branchId: string): Promise<number> {
  const [row] = await db()
    .select({ headSequence: simBranches.headSequence })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!row) throw new Error(`branch row missing: ${branchId}`);
  return row.headSequence;
}

/** The events one command appended, in sequence order. */
async function eventsForCommand(branchId: string, commandId: string) {
  const events = await readBranchEvents(branchId);
  return events.filter((event) => event.commandId === commandId);
}

async function pendingTriggersFor(branchId: string, actorId: string) {
  const rows = await db()
    .select({ kind: simTriggers.kind, uniquenessKey: simTriggers.uniquenessKey })
    .from(simTriggers)
    .where(and(eq(simTriggers.branchId, branchId), eq(simTriggers.state, "pending")));
  return rows.filter((row) => row.uniquenessKey?.includes(actorId));
}

describe.runIf(ready)("E6.4 durable actor promotion (§27.2/§27.7)", () => {
  it("promotes with the reservation debit, presence legality, conservation, and fork parity", async () => {
    const ids = await seedCase();
    const marketId = newId();
    const created = await submitDurableCreateCohort(
      command(ids, "create-market", "create_cohort", cohortPayload(ids, marketId, 50, 10_000)),
      admit,
    );
    expectAccepted(created, "seeding the market cohort");

    const landing = { simulationLod: "event", inferenceLod: "no_model" };

    // Rejections: principal bar, ghost cohort, ghost zone, presence, name.
    const unauthorized = await submitDurablePromoteActorFromCohort(
      command(
        ids,
        "player-promote",
        "promote_actor_from_cohort",
        { cohortId: marketId, zoneId: ids.squareZoneId, name: "Maren", landing },
        playerPrincipal(ids.ana),
      ),
      admit,
    );
    expectRejected(unauthorized, "unauthorized_principal", "a player promoting from a cohort");
    const ghostCohort = await submitDurablePromoteActorFromCohort(
      command(ids, "ghost-cohort", "promote_actor_from_cohort", {
        cohortId: newId(),
        zoneId: ids.squareZoneId,
        name: "Maren",
        landing,
      }),
      admit,
    );
    expectRejected(ghostCohort, "cohort_not_found", "promoting from a cohort that does not exist");
    const ghostZone = await submitDurablePromoteActorFromCohort(
      command(ids, "ghost-zone", "promote_actor_from_cohort", {
        cohortId: marketId,
        zoneId: `${ids.branchId}-zone-nowhere`,
        name: "Maren",
        landing,
      }),
      admit,
    );
    expectRejected(ghostZone, "zone_not_found", "promoting into a zone that does not exist");
    // Mid-window at share 10 000 the whole crowd is at the square — the
    // tavern's read says none of them are there (§27.2 step 5).
    const notPresent = await submitDurablePromoteActorFromCohort(
      command(ids, "not-present", "promote_actor_from_cohort", {
        cohortId: marketId,
        zoneId: ids.tavernZoneId,
        name: "Maren",
        landing,
      }),
      admit,
    );
    expectRejected(notPresent, "cohort_not_present", "promoting in the tavern while the crowd is at the square");
    // No name pool is authored anywhere yet — an omitted name fails closed.
    const unnamed = await submitDurablePromoteActorFromCohort(
      command(ids, "unnamed", "promote_actor_from_cohort", {
        cohortId: marketId,
        zoneId: ids.squareZoneId,
        landing,
      }),
      admit,
    );
    expectRejected(unnamed, "name_required", "promoting without a name and with no name pool authored");

    // The fork boundary BEFORE the promotion, for the parity check below.
    const prePromotionSequence = await branchHeadSequence(ids.branchId);

    const promoted = await submitDurablePromoteActorFromCohort(
      command(ids, "promote-maren", "promote_actor_from_cohort", {
        cohortId: marketId,
        zoneId: ids.squareZoneId,
        name: "Maren",
        landing,
      }),
      admit,
    );
    expectAccepted(promoted, "the five-step promotion of Maren");
    expect(promoted.eventIds).toHaveLength(3);
    expect(promoted.lastSequence - promoted.firstSequence).toBe(2);
    // Idempotency: the same command replays its cached result.
    const replayed = await submitDurablePromoteActorFromCohort(
      command(ids, "promote-maren", "promote_actor_from_cohort", {
        cohortId: marketId,
        zoneId: ids.squareZoneId,
        name: "Maren",
        landing,
      }),
      admit,
    );
    expect(replayed).toEqual(promoted);

    const actorId = derivedPromotedActorId(ids.branchId, `cmd-promote-maren-${ids.branchId}`);

    // The causation-chained train, re-read from rows.
    const eventRows = await eventsForCommand(ids.branchId, `cmd-promote-maren-${ids.branchId}`);
    expect(eventRows.map((event) => event.type)).toEqual([
      "cohort_adjusted",
      "actor_materialized_from_aggregate",
      "actor_lod_assigned",
    ]);
    const [debit, materialized, lodAssigned] = eventRows;
    if (
      debit?.type !== "cohort_adjusted" ||
      materialized?.type !== "actor_materialized_from_aggregate" ||
      lodAssigned?.type !== "actor_lod_assigned"
    ) {
      throw new Error("promotion train shape mismatch");
    }
    expect(debit.payload).toMatchObject({
      cohortId: marketId,
      deltaCount: -1,
      reason: "promotion_reservation",
      populationBefore: 50,
      populationAfter: 49,
    });
    expect(materialized.causationId).toBe(debit.id);
    expect(materialized.payload).toMatchObject({
      actorId,
      name: "Maren",
      cohortId: marketId,
      zoneId: ids.squareZoneId,
      locationId: ids.locationId,
    });
    expect(lodAssigned.causationId).toBe(materialized.id);
    expect(lodAssigned.payload).toMatchObject({
      actorId,
      simulationLod: "event",
      inferenceLod: "no_model",
      previousWasDefault: true,
    });

    // The rows the train materialized, all in one transaction.
    const [characterRow] = await db()
      .select()
      .from(simCharacters)
      .where(and(eq(simCharacters.branchId, ids.branchId), eq(simCharacters.characterId, actorId)));
    expect(characterRow).toMatchObject({ name: "Maren" });
    const [locusRow] = await db()
      .select()
      .from(simPhysicalLoci)
      .where(and(eq(simPhysicalLoci.branchId, ids.branchId), eq(simPhysicalLoci.actorId, actorId)));
    expect(locusRow).toMatchObject({ kind: "at", zoneId: ids.squareZoneId, locationId: ids.locationId });
    const [lodRow] = await db()
      .select()
      .from(simActorLods)
      .where(and(eq(simActorLods.branchId, ids.branchId), eq(simActorLods.actorId, actorId)));
    expect(lodRow).toMatchObject({ simulationLod: "event", inferenceLod: "no_model" });
    const [cohortRow] = await db()
      .select()
      .from(simCohorts)
      .where(and(eq(simCohorts.branchId, ids.branchId), eq(simCohorts.cohortId, marketId)));
    expect(cohortRow).toMatchObject({ population: 49 });

    // Conservation across the read at share 10 000: 49 aggregate + 1 named
    // is exactly the 50 the crowd held before — no one was invented.
    expect((cohortRow?.population ?? 0) + 1).toBe(50);

    // A bodiless promotion arms nothing; embodiment afterwards arms the
    // routine alarm too (§27.7 catch-up: event LOD + tracked body ⇒ exactly
    // one live routine alarm, on every path order).
    expect(await pendingTriggersFor(ids.branchId, actorId)).toHaveLength(0);
    const embodied = await submitDurableInitializeActorBody(
      command(ids, "embody-maren", "initialize_actor_body", {
        actorId,
        registryVersion: "body-v1",
        baselineOverrides: {},
      }),
      admit,
    );
    expectAccepted(embodied, "embodying the freshly promoted Maren");
    const maremAlarms = await pendingTriggersFor(ids.branchId, actorId);
    expect(maremAlarms.map((row) => row.kind)).toContain("routine_policy_due");

    // Fork AT HEAD: the child rebuilds the actor, locus, LOD row, and count
    // from inherited events alone.
    const { childBranchId: childAfter } = await forkAtHead({
      parentBranchId: ids.branchId,
      reason: "E6.4 post-promotion fork parity",
    });
    const [childCharacter] = await db()
      .select()
      .from(simCharacters)
      .where(and(eq(simCharacters.branchId, childAfter), eq(simCharacters.characterId, actorId)));
    expect(childCharacter).toMatchObject({ name: "Maren" });
    const [childLocus] = await db()
      .select()
      .from(simPhysicalLoci)
      .where(and(eq(simPhysicalLoci.branchId, childAfter), eq(simPhysicalLoci.actorId, actorId)));
    expect(childLocus).toMatchObject({ kind: "at", zoneId: ids.squareZoneId });
    const [childLod] = await db()
      .select()
      .from(simActorLods)
      .where(and(eq(simActorLods.branchId, childAfter), eq(simActorLods.actorId, actorId)));
    expect(childLod).toMatchObject({ simulationLod: "event", inferenceLod: "no_model" });
    const [childCohort] = await db()
      .select()
      .from(simCohorts)
      .where(and(eq(simCohorts.branchId, childAfter), eq(simCohorts.cohortId, marketId)));
    expect(childCohort).toMatchObject({ population: 49 });

    // Fork BEFORE the promotion: the child carries neither the actor nor any
    // of their rows, and the crowd is whole — history is not retroactive.
    // Explicitly BELOW the head, so `forkAtHead` cannot serve here.
    const childBefore = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId: childBefore,
      atSequence: prePromotionSequence,
      principal: { kind: "storyteller", principalId: "gm-1" },
      reason: "E6.4 pre-promotion fork parity",
    });
    const beforeCharacters = await db()
      .select()
      .from(simCharacters)
      .where(and(eq(simCharacters.branchId, childBefore), eq(simCharacters.characterId, actorId)));
    expect(beforeCharacters).toHaveLength(0);
    const beforeLoci = await db()
      .select()
      .from(simPhysicalLoci)
      .where(and(eq(simPhysicalLoci.branchId, childBefore), eq(simPhysicalLoci.actorId, actorId)));
    expect(beforeLoci).toHaveLength(0);
    const [beforeCohort] = await db()
      .select()
      .from(simCohorts)
      .where(and(eq(simCohorts.branchId, childBefore), eq(simCohorts.cohortId, marketId)));
    expect(beforeCohort).toMatchObject({ population: 50 });
  });

  it("wakes a dormant participant when an engagement reaches them, and only then", async () => {
    const ids = await seedCase();

    // Riven gains a body (default exact LOD arms body alarms, no routine),
    // then tucks into dormancy — every alarm retires (E6.3).
    const embodied = await submitDurableInitializeActorBody(
      command(ids, "embody-riven", "initialize_actor_body", {
        actorId: ids.riven,
        registryVersion: "body-v1",
        baselineOverrides: {},
      }),
      admit,
    );
    expectAccepted(embodied, "embodying Riven before tucking them dormant");
    const demoted = await submitDurableAssignActorLod(
      command(ids, "tuck-riven", "assign_actor_lod", {
        actorId: ids.riven,
        simulationLod: "dormant",
        inferenceLod: "no_model",
      }),
      admit,
    );
    expectAccepted(demoted, "tucking Riven into dormancy");
    expect(await pendingTriggersFor(ids.branchId, ids.riven)).toHaveLength(0);

    // A rejected open wakes no one: the ghost participant kills the command
    // before any wake event lands.
    const ghostOpen = await submitDurableOpenEngagement(
      command(
        ids,
        "ghost-open",
        "open_engagement",
        { participantIds: [ids.riven, newId()].sort(), channel: "co_present" },
        legacyEngineTestPlayerPrincipal([ids.ana, ids.riven].sort()),
      ),
      admit,
    );
    expectRejected(ghostOpen, "participant_not_found", "opening a scene with a participant who does not exist");
    const [stillDormant] = await db()
      .select()
      .from(simActorLods)
      .where(and(eq(simActorLods.branchId, ids.branchId), eq(simActorLods.actorId, ids.riven)));
    expect(stillDormant).toMatchObject({ simulationLod: "dormant" });
    expect(await pendingTriggersFor(ids.branchId, ids.riven)).toHaveLength(0);

    // Ana opens a co-present scene with dormant Riven: the wake train rides
    // the open command — LOD to event (inference untouched), catch-up alarms
    // re-solved fresh, then the engagement itself.
    const opened = await submitDurableOpenEngagement(
      command(
        ids,
        "open-scene",
        "open_engagement",
        { participantIds: [ids.ana, ids.riven].sort(), channel: "co_present" },
        playerPrincipal(ids.ana),
      ),
      admit,
    );
    expectAccepted(opened, "Ana opening a co-present scene with dormant Riven");
    expect(opened.lastSequence).toBeGreaterThan(opened.firstSequence);

    const [wokenLod] = await db()
      .select()
      .from(simActorLods)
      .where(and(eq(simActorLods.branchId, ids.branchId), eq(simActorLods.actorId, ids.riven)));
    expect(wokenLod).toMatchObject({ simulationLod: "event", inferenceLod: "no_model" });

    const wakeEvents = await eventsForCommand(ids.branchId, `cmd-open-scene-${ids.branchId}`);
    const kinds = wakeEvents.map((event) =>
      event.type === "trigger_scheduled" ? event.payload.kind : event.type,
    );
    // The lod pin leads, catch-up alarms follow, the scene opens last.
    expect(kinds[0]).toBe("actor_lod_assigned");
    expect(kinds[kinds.length - 1]).toBe("engagement_opened");
    expect(kinds).toContain("routine_policy_due");
    const rivenAlarms = await pendingTriggersFor(ids.branchId, ids.riven);
    expect(rivenAlarms.map((row) => row.kind)).toContain("routine_policy_due");

    // Ana was never below event — exactly one wake landed.
    const lodEvents = wakeEvents.filter((event) => event.type === "actor_lod_assigned");
    expect(lodEvents).toHaveLength(1);
    expect(lodEvents[0]?.payload).toMatchObject({
      actorId: ids.riven,
      previousSimulationLod: "dormant",
      simulationLod: "event",
      inferenceLod: "no_model",
    });

    // Fork at head: the woken LOD row and re-armed alarms replay into the
    // child (the wake's events are ordinary inherited history).
    const { childBranchId: child } = await forkAtHead({
      parentBranchId: ids.branchId,
      reason: "E6.4 wake fork parity",
    });
    const [childLod] = await db()
      .select()
      .from(simActorLods)
      .where(and(eq(simActorLods.branchId, child), eq(simActorLods.actorId, ids.riven)));
    expect(childLod).toMatchObject({ simulationLod: "event", inferenceLod: "no_model" });
    const childAlarms = await pendingTriggersFor(child, ids.riven);
    expect(childAlarms.map((row) => row.kind)).toContain("routine_policy_due");
  });
});
