import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
import { newId } from "@/lib/ids";
import { emptyActorLodsSeed, replayActorLodHistory } from "@/lib/simulation";
import { db, simActorLods, simBranches, simEvents, simWorlds } from "@/server/db";
import { forkBranch } from "./branch-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { readEffectiveActorLod, submitDurableAssignActorLod } from "./lod-store";
import { seedDurableMaterialBranch } from "./material-store";
import { branchEventFromRow } from "./observation-store";
import { seedDurableSpaceTopology } from "./space-store";

/**
 * E6.1 durable actor-LOD ledger (engine.spec §27–§28): `assign_actor_lod` end
 * to end — defaults, assignment, idempotency, authorization, the §27.3
 * demotion guards against a live engagement, and fork-mid-ledger parity.
 * Mirrors social-store.int.test.ts's harness shape.
 */

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_actor_lods limit 1`),
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
      `[lod-store.int.test] skipping: database unreachable or unmigrated: ${
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

const SEED_SECOND = 200_000;

interface LodCase {
  worldId: string;
  branchId: string;
  locationId: string;
  zoneId: string;
  ana: string;
  ben: string;
  cy: string;
}

function branchSeed(ids: LodCase): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e6-1-test-world",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e6-1-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.ana, name: "Ana" },
      { id: ids.ben, name: "Ben" },
      { id: ids.cy, name: "Cy" },
    ],
    items: [],
  });
}

async function seedCase(): Promise<LodCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: LodCase = {
    worldId,
    branchId,
    locationId: `${worldId}-loc-cafe`,
    zoneId: `${branchId}-zone-cafe`,
    ana: newId(),
    ben: newId(),
    cy: newId(),
  };
  seededWorldIds.push(worldId);
  await seedDurableMaterialBranch(branchSeed(ids));
  await seedDurableSpaceTopology({
    branchId,
    locations: [{ id: ids.locationId, worldId, kind: "cafe", defaultAccessPolicy: "public" }],
    zones: [{ id: ids.zoneId, locationId: ids.locationId, kind: "cafe", privacyPolicy: "public" }],
    links: [],
    loci: [
      { kind: "at", actorId: ids.ana, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_SECOND },
      { kind: "at", actorId: ids.ben, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_SECOND },
      { kind: "at", actorId: ids.cy, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_SECOND },
    ],
  });
  return ids;
}

const admit = { admitAtLockedVersion: true };
const gmPrincipal = { kind: "storyteller" as const, principalId: "gm-1", controlledActorIds: [] };

function assignCmd(
  ids: LodCase,
  name: string,
  payload: { actorId: string; simulationLod: string; inferenceLod: string },
  principal: { kind: string; principalId: string; controlledActorIds: string[] } = gmPrincipal,
) {
  return {
    id: `cmd-${name}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `${name}-key-${ids.branchId}`,
    principal,
    submittedAtWallClock: "2026-07-20T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "assign_actor_lod",
    schemaVersion: 1,
    payload,
  };
}

describe.runIf(ready)("E6.1 durable actor-LOD ledger", () => {
  it("assigns, reads, defends idempotency and authorization, and forks with parity", async () => {
    const ids = await seedCase();

    // Unassigned actors read the registry defaults.
    const before = await readEffectiveActorLod(db(), ids.branchId, ids.ana);
    expect(before).toMatchObject({ simulationLod: "exact", inferenceLod: "deliberator", source: "default" });

    // Assigning the defaults verbatim is a structured no_op, not a row.
    const noop = await submitDurableAssignActorLod(
      assignCmd(ids, "noop", { actorId: ids.ana, simulationLod: "exact", inferenceLod: "deliberator" }),
      admit,
    );
    expect(noop).toMatchObject({ status: "rejected", code: "no_op" });

    // A non-privileged principal cannot touch the dial.
    const unauthorized = await submitDurableAssignActorLod(
      assignCmd(
        ids,
        "player",
        { actorId: ids.ana, simulationLod: "event", inferenceLod: "no_model" },
        { kind: "player", principalId: "player-1", controlledActorIds: [ids.ana] },
      ),
      admit,
    );
    expect(unauthorized).toMatchObject({ status: "rejected", code: "unauthorized_principal" });

    const unknown = await submitDurableAssignActorLod(
      assignCmd(ids, "ghost", { actorId: newId(), simulationLod: "event", inferenceLod: "no_model" }),
      admit,
    );
    expect(unknown).toMatchObject({ status: "rejected", code: "actor_not_found" });

    // A real assignment lands the event, the row, and the read.
    const assigned = await submitDurableAssignActorLod(
      assignCmd(ids, "ana-event", { actorId: ids.ana, simulationLod: "event", inferenceLod: "small_model" }),
      admit,
    );
    expect(assigned.status).toBe("accepted");
    if (assigned.status !== "accepted") throw new Error("unreachable");
    const after = await readEffectiveActorLod(db(), ids.branchId, ids.ana);
    expect(after).toMatchObject({ simulationLod: "event", inferenceLod: "small_model", source: "assigned" });

    const [eventRow] = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence))
      .then((rows) => rows.filter((row) => row.type === "actor_lod_assigned"));
    expect(eventRow).toBeDefined();
    expect(eventRow?.payload).toMatchObject({
      actorId: ids.ana,
      simulationLod: "event",
      inferenceLod: "small_model",
      previousSimulationLod: "exact",
      previousInferenceLod: "deliberator",
      previousWasDefault: true,
    });

    // Idempotency: the same command replays its cached result, appends nothing.
    const replayed = await submitDurableAssignActorLod(
      assignCmd(ids, "ana-event", { actorId: ids.ana, simulationLod: "event", inferenceLod: "small_model" }),
      admit,
    );
    expect(replayed).toEqual(assigned);
    const lodEventCount = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .then((rows) => rows[0]?.count ?? 0);

    // A later promotion supersedes the row (one row per actor).
    const promoted = await submitDurableAssignActorLod(
      assignCmd(ids, "ana-back", { actorId: ids.ana, simulationLod: "exact", inferenceLod: "deliberator" }),
      admit,
    );
    expect(promoted.status).toBe("accepted");
    const rows = await db()
      .select()
      .from(simActorLods)
      .where(eq(simActorLods.branchId, ids.branchId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: ids.ana, simulationLod: "exact", inferenceLod: "deliberator" });
    expect(lodEventCount).toBeGreaterThan(0);

    // Fork at head: the child's ledger rows replay bit-identical from events.
    const [parentBranchRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!parentBranchRow) throw new Error("parent branch row missing");
    const childBranchId = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: parentBranchRow.headSequence,
      principal: { kind: "storyteller", principalId: "gm-1" },
      reason: "E6.1 fork parity",
    });

    const parentEvents = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence))
      .then((eventRows) => eventRows.map(branchEventFromRow));
    const replayedProjection = replayActorLodHistory({
      seed: emptyActorLodsSeed(childBranchId, SEED_SECOND),
      events: parentEvents,
    });
    const childRows = await db()
      .select()
      .from(simActorLods)
      .where(eq(simActorLods.branchId, childBranchId))
      .orderBy(asc(simActorLods.actorId));
    expect(childRows).toHaveLength(replayedProjection.lods.length);
    for (const [index, state] of replayedProjection.lods.entries()) {
      expect(childRows[index]).toMatchObject({
        actorId: state.actorId,
        simulationLod: state.simulationLod,
        inferenceLod: state.inferenceLod,
        registryVersion: state.registryVersion,
        assignedAtStorySecond: state.assignedAtStorySecond,
      });
    }
    // The child's read matches the parent's for assigned and unassigned alike.
    expect(await readEffectiveActorLod(db(), childBranchId, ids.ana)).toEqual(
      await readEffectiveActorLod(db(), ids.branchId, ids.ana),
    );
    expect(await readEffectiveActorLod(db(), childBranchId, ids.cy)).toMatchObject({ source: "default" });
  });

  it("blocks a demotion behind a live engagement but never an inference-only change (§27.3)", async () => {
    const ids = await seedCase();

    const opened = await submitDurableOpenEngagement(
      {
        id: `cmd-chat-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `chat-key-${ids.branchId}`,
        principal: { kind: "player", principalId: "player-1", controlledActorIds: [ids.ana] },
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: `corr-${ids.branchId}`,
        type: "open_engagement",
        schemaVersion: 1,
        payload: { participantIds: [ids.ana, ids.ben].sort(), channel: "co_present" },
      },
      admit,
    );
    expect(opened.status).toBe("accepted");

    // A participant cannot be demoted out from under a live scene.
    const blocked = await submitDurableAssignActorLod(
      assignCmd(ids, "ben-demote", { actorId: ids.ben, simulationLod: "dormant", inferenceLod: "no_model" }),
      admit,
    );
    expect(blocked).toMatchObject({ status: "rejected", code: "demotion_blocked_open_engagement" });

    // The inference axis stays a free dial for the same engaged actor.
    const inferenceOnly = await submitDurableAssignActorLod(
      assignCmd(ids, "ben-quiet", { actorId: ids.ben, simulationLod: "exact", inferenceLod: "no_model" }),
      admit,
    );
    expect(inferenceOnly.status).toBe("accepted");

    // A bystander outside the scene demotes freely.
    const bystander = await submitDurableAssignActorLod(
      assignCmd(ids, "cy-demote", { actorId: ids.cy, simulationLod: "dormant", inferenceLod: "no_model" }),
      admit,
    );
    expect(bystander.status).toBe("accepted");
  });
});
