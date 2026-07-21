import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
import { newId } from "@/lib/ids";
import { derivedPromotedActorId } from "@/lib/simulation";
import {
  db,
  simActorLods,
  simBranches,
  simCharacters,
  simCohorts,
  simEvents,
  simPhysicalLoci,
  simTriggers,
  simWorlds,
} from "@/server/db";
import { submitDurableInitializeActorBody } from "./body-store";
import { forkBranch } from "./branch-store";
import { submitDurableCreateCohort } from "./cohort-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { submitDurableAssignActorLod } from "./lod-store";
import { seedDurableMaterialBranch } from "./material-store";
import { branchEventFromRow } from "./observation-store";
import { submitDurablePromoteActorFromCohort } from "./promotion-store";
import { seedDurableSpaceTopology } from "./space-store";

/**
 * E6.4 durable actor promotion and dependency wake (engine.spec §27.2, §27.7):
 * the five-step promotion end to end — reservation debit, materialization
 * (character + locus + landing LOD in one transaction), presence legality,
 * conservation across the read, idempotency, fork parity on both sides of the
 * promotion — and an engagement waking a dormant participant with catch-up
 * alarms re-solved from law. Mirrors cohort-store.int.test.ts's harness.
 */

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_cohorts limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4_000);
      }),
    ]);
    return true;
  } catch (error) {
    if (process.env.CI === "true" || process.env.VESPER_REQUIRE_TEST_DB === "1") {
      throw error;
    }
    process.stderr.write(
      `[promotion-store.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const seededWorldIds: string[] = [];

afterAll(async () => {
  if (!ready || seededWorldIds.length === 0) return;
  await db().delete(simWorlds).where(inArray(simWorlds.id, seededWorldIds));
});

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

function branchSeed(ids: PromotionCase): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e6-4-test-world",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e6-4-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.ana, name: "Ana" },
      { id: ids.riven, name: "Riven" },
    ],
    items: [],
  });
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
  seededWorldIds.push(worldId);
  await seedDurableMaterialBranch(branchSeed(ids));
  await seedDurableSpaceTopology({
    branchId,
    locations: [{ id: ids.locationId, worldId, kind: "town", defaultAccessPolicy: "public" }],
    zones: [
      { id: ids.squareZoneId, locationId: ids.locationId, kind: "plaza", privacyPolicy: "public" },
      { id: ids.tavernZoneId, locationId: ids.locationId, kind: "tavern", privacyPolicy: "public" },
    ],
    links: [],
    loci: [
      { kind: "at", actorId: ids.ana, locationId: ids.locationId, zoneId: ids.squareZoneId, since: SEED_SECOND },
      { kind: "at", actorId: ids.riven, locationId: ids.locationId, zoneId: ids.squareZoneId, since: SEED_SECOND },
    ],
  });
  return ids;
}

const admit = { admitAtLockedVersion: true };
const gmPrincipal = { kind: "storyteller" as const, principalId: "gm-1", controlledActorIds: [] };

function command(
  ids: PromotionCase,
  name: string,
  type: string,
  payload: Record<string, unknown>,
  principal: object = gmPrincipal,
) {
  return {
    id: `cmd-${name}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `${name}-key-${ids.branchId}`,
    principal,
    submittedAtWallClock: "2026-07-21T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type,
    schemaVersion: 1,
    payload,
  };
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
    expect(created.status).toBe("accepted");

    const landing = { simulationLod: "event", inferenceLod: "no_model" };

    // Rejections: principal bar, ghost cohort, ghost zone, presence, name.
    const unauthorized = await submitDurablePromoteActorFromCohort(
      command(
        ids,
        "player-promote",
        "promote_actor_from_cohort",
        { cohortId: marketId, zoneId: ids.squareZoneId, name: "Maren", landing },
        { kind: "player", principalId: "player-1", controlledActorIds: [ids.ana] },
      ),
      admit,
    );
    expect(unauthorized).toMatchObject({ status: "rejected", code: "unauthorized_principal" });
    const ghostCohort = await submitDurablePromoteActorFromCohort(
      command(ids, "ghost-cohort", "promote_actor_from_cohort", {
        cohortId: newId(),
        zoneId: ids.squareZoneId,
        name: "Maren",
        landing,
      }),
      admit,
    );
    expect(ghostCohort).toMatchObject({ status: "rejected", code: "cohort_not_found" });
    const ghostZone = await submitDurablePromoteActorFromCohort(
      command(ids, "ghost-zone", "promote_actor_from_cohort", {
        cohortId: marketId,
        zoneId: `${ids.branchId}-zone-nowhere`,
        name: "Maren",
        landing,
      }),
      admit,
    );
    expect(ghostZone).toMatchObject({ status: "rejected", code: "zone_not_found" });
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
    expect(notPresent).toMatchObject({ status: "rejected", code: "cohort_not_present" });
    // No name pool is authored anywhere yet — an omitted name fails closed.
    const unnamed = await submitDurablePromoteActorFromCohort(
      command(ids, "unnamed", "promote_actor_from_cohort", {
        cohortId: marketId,
        zoneId: ids.squareZoneId,
        landing,
      }),
      admit,
    );
    expect(unnamed).toMatchObject({ status: "rejected", code: "name_required" });

    // The fork boundary BEFORE the promotion, for the parity check below.
    const [preRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!preRow) throw new Error("branch row missing");
    const prePromotionSequence = preRow.headSequence;

    const promoted = await submitDurablePromoteActorFromCohort(
      command(ids, "promote-maren", "promote_actor_from_cohort", {
        cohortId: marketId,
        zoneId: ids.squareZoneId,
        name: "Maren",
        landing,
      }),
      admit,
    );
    expect(promoted.status).toBe("accepted");
    if (promoted.status !== "accepted") throw new Error("promotion rejected");
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
    const eventRows = await db()
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.commandId, `cmd-promote-maren-${ids.branchId}`)))
      .orderBy(simEvents.sequence)
      .then((rows) => rows.map(branchEventFromRow));
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
    expect(embodied.status).toBe("accepted");
    const maremAlarms = await pendingTriggersFor(ids.branchId, actorId);
    expect(maremAlarms.map((row) => row.kind)).toContain("routine_policy_due");

    // Fork AT HEAD: the child rebuilds the actor, locus, LOD row, and count
    // from inherited events alone.
    const [headRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!headRow) throw new Error("branch row missing");
    const childAfter = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId: childAfter,
      atSequence: headRow.headSequence,
      principal: { kind: "storyteller", principalId: "gm-1" },
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
    expect(embodied.status).toBe("accepted");
    const demoted = await submitDurableAssignActorLod(
      command(ids, "tuck-riven", "assign_actor_lod", {
        actorId: ids.riven,
        simulationLod: "dormant",
        inferenceLod: "no_model",
      }),
      admit,
    );
    expect(demoted.status).toBe("accepted");
    expect(await pendingTriggersFor(ids.branchId, ids.riven)).toHaveLength(0);

    // A rejected open wakes no one: the ghost participant kills the command
    // before any wake event lands.
    const ghostOpen = await submitDurableOpenEngagement(
      command(
        ids,
        "ghost-open",
        "open_engagement",
        { participantIds: [ids.riven, newId()].sort(), channel: "co_present" },
        { kind: "player", principalId: "player-1", controlledActorIds: [ids.ana, ids.riven].sort() },
      ),
      admit,
    );
    expect(ghostOpen).toMatchObject({ status: "rejected", code: "participant_not_found" });
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
        { kind: "player", principalId: "player-1", controlledActorIds: [ids.ana] },
      ),
      admit,
    );
    expect(opened.status).toBe("accepted");
    if (opened.status !== "accepted") throw new Error("open rejected");
    expect(opened.lastSequence).toBeGreaterThan(opened.firstSequence);

    const [wokenLod] = await db()
      .select()
      .from(simActorLods)
      .where(and(eq(simActorLods.branchId, ids.branchId), eq(simActorLods.actorId, ids.riven)));
    expect(wokenLod).toMatchObject({ simulationLod: "event", inferenceLod: "no_model" });

    const wakeEvents = await db()
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.commandId, `cmd-open-scene-${ids.branchId}`)))
      .orderBy(simEvents.sequence)
      .then((rows) => rows.map(branchEventFromRow));
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
    const [headRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!headRow) throw new Error("branch row missing");
    const child = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId: child,
      atSequence: headRow.headSequence,
      principal: { kind: "storyteller", principalId: "gm-1" },
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
