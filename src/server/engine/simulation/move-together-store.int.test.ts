import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
import { newId } from "@/lib/ids";
import { db, simEngagements, simTriggers, simWorlds } from "@/server/db";
import type { SpaceTopologySeed } from "./space-store";
import { readDurableSpaceBranch, seedDurableSpaceTopology } from "./space-store";
import { submitDurableMoveTogether } from "./move-together-store";
import { seedDurableMaterialBranch } from "./material-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { advanceBranchStoryTime } from "./scheduler-store";

/**
 * command-integrity A4 — the atomic walk-with-me. The old three-transaction
 * choreography (scene-end, player move, primary move) could crash between the two
 * moves and strand the pair (one in transit, one at origin, no recovery). The new
 * `move_together` command commits all of it — scene-end + ONE shared journey
 * carrying BOTH actors + one arrival — in a single branch-locked transaction, so
 * that window is GONE: a failure rolls the whole batch back (both-or-neither), and
 * a success always leaves both on the SAME journey. Draining lands both together.
 */

const SEED_SECOND = 10_000;
const WALK_AB = 600;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_physical_loci limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4_000);
      }),
    ]);
    return true;
  } catch (error) {
    if (process.env.CI === "true" || process.env.VESPER_REQUIRE_TEST_DB === "1") throw error;
    process.stderr.write(
      `[move-together-store.int.test] skipping: database unreachable or unmigrated: ${
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

interface TogetherCase {
  worldId: string;
  branchId: string;
  playerId: string;
  primaryId: string;
  zoneA: string;
  zoneB: string;
  zoneD: string;
}

function branchSeed(ids: TogetherCase): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "a4-tests",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "a4-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.playerId, name: "You" },
      { id: ids.primaryId, name: "Nora" },
    ],
    items: [],
  });
}

function topologySeed(ids: TogetherCase): SpaceTopologySeed {
  const locHome = `${ids.worldId}-loc-home`;
  const locCafe = `${ids.worldId}-loc-cafe`;
  const locIsle = `${ids.worldId}-loc-isle`;
  return {
    branchId: ids.branchId,
    locations: [
      { id: locHome, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" },
      { id: locCafe, worldId: ids.worldId, kind: "cafe", defaultAccessPolicy: "public" },
      { id: locIsle, worldId: ids.worldId, kind: "isle", defaultAccessPolicy: "public" },
    ],
    zones: [
      { id: ids.zoneA, locationId: locHome, kind: "room", privacyPolicy: "private" },
      { id: ids.zoneB, locationId: locCafe, kind: "hall", privacyPolicy: "public" },
      // Disconnected — no link reaches it, so a move there is `no_route`.
      { id: ids.zoneD, locationId: locIsle, kind: "cellar", privacyPolicy: "public" },
    ],
    links: [
      {
        id: `${ids.branchId}-link-ab`,
        fromZoneId: ids.zoneA,
        toZoneId: ids.zoneB,
        modes: ["walk"],
        minimumDurationSeconds: WALK_AB,
        accessPolicy: "public",
        state: "open",
      },
    ],
    // Both co-present at zone-a.
    loci: [
      { kind: "at", actorId: ids.playerId, locationId: locHome, zoneId: ids.zoneA, since: SEED_SECOND },
      { kind: "at", actorId: ids.primaryId, locationId: locHome, zoneId: ids.zoneA, since: SEED_SECOND },
    ],
  };
}

async function seedTogetherCase(): Promise<TogetherCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: TogetherCase = {
    worldId,
    branchId,
    playerId: newId(),
    primaryId: newId(),
    zoneA: `${branchId}-zone-a`,
    zoneB: `${branchId}-zone-b`,
    zoneD: `${branchId}-zone-d`,
  };
  await seedDurableMaterialBranch(branchSeed(ids));
  await seedDurableSpaceTopology(topologySeed(ids));
  seededWorldIds.push(worldId);
  return ids;
}

async function openScene(ids: TogetherCase): Promise<void> {
  const result = await submitDurableOpenEngagement(
    {
      id: `cmd-open-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion: 0,
      idempotencyKey: `open-key-${ids.branchId}`,
      principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.playerId] },
      submittedAtWallClock: "2026-07-24T12:00:00.000Z",
      correlationId: `corr-${ids.branchId}`,
      type: "open_engagement",
      schemaVersion: 1,
      payload: { participantIds: [ids.playerId, ids.primaryId].sort(), channel: "co_present" },
    },
    { admitAtLockedVersion: true },
  );
  if (result.status !== "accepted") throw new Error(`scene open failed: ${result.status}`);
}

function togetherCommand(ids: TogetherCase, destinationZoneId: string, overrides: { id?: string } = {}) {
  return {
    id: overrides.id ?? `cmd-together-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: overrides.id ?? `together-key-${ids.branchId}`,
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: [ids.playerId] },
    submittedAtWallClock: "2026-07-24T12:05:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "move_together",
    schemaVersion: 1,
    payload: { actorId: ids.playerId, coTravelerActorId: ids.primaryId, destinationZoneId, travelMode: "walk" },
  };
}

describe.runIf(ready)("command-integrity A4 — atomic move_together", () => {
  it("walk-with-me: one shared journey carries BOTH, and a drain lands both together", async () => {
    const ids = await seedTogetherCase();
    await openScene(ids);

    const result = await submitDurableMoveTogether(togetherCommand(ids, ids.zoneB), { admitAtLockedVersion: true });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    // engagement_ended + journey_planned + actor_departed + trigger_scheduled — ONE batch.
    expect(result.eventIds).toHaveLength(4);

    const afterDepart = await readDurableSpaceBranch(ids.branchId);
    // Exactly ONE journey — not two (the old flow created one per move) — carrying BOTH actors.
    expect(afterDepart.journeys).toHaveLength(1);
    expect(afterDepart.journeys[0]?.actorIds).toEqual([ids.playerId, ids.primaryId].sort());
    // Both travellers in transit on that SAME journey (never one moved, one stranded).
    const journeyId = afterDepart.journeys[0]?.id;
    expect(afterDepart.loci).toHaveLength(2);
    for (const locus of afterDepart.loci) {
      expect(locus.kind).toBe("in_transit");
      if (locus.kind === "in_transit") expect(locus.journeyId).toBe(journeyId);
    }
    // The standing scene was ended as a choice (grace), not left dangling.
    const [engagement] = await db()
      .select()
      .from(simEngagements)
      .where(eq(simEngagements.branchId, ids.branchId));
    expect(engagement?.state).toBe("ended");
    // ONE arrival trigger for the shared journey.
    const triggers = await db().select().from(simTriggers).where(eq(simTriggers.branchId, ids.branchId));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.dueStorySecond).toBe(SEED_SECOND + WALK_AB);

    // Drain to the arrival: both land at the destination — co-presence restored.
    await advanceBranchStoryTime(ids.branchId, SEED_SECOND + WALK_AB, { workerId: `test-drain-${newId()}` });
    const arrived = await readDurableSpaceBranch(ids.branchId);
    expect(arrived.journeys[0]?.status).toBe("arrived");
    expect(arrived.loci).toHaveLength(2);
    for (const locus of arrived.loci) {
      expect(locus.kind).toBe("at");
      if (locus.kind === "at") expect(locus.zoneId).toBe(ids.zoneB);
    }
  });

  it("atomicity closes the crash window: a rejected batch strands NOBODY (both-or-neither)", async () => {
    const ids = await seedTogetherCase();
    await openScene(ids);

    // An unroutable destination is refused. In the old two-move flow a crash after
    // the player's move left the player in transit + the primary at origin; here the
    // WHOLE batch is one transaction, so a failure commits nothing at all.
    const result = await submitDurableMoveTogether(togetherCommand(ids, ids.zoneD), { admitAtLockedVersion: true });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.code).toBe("no_route");

    const after = await readDurableSpaceBranch(ids.branchId);
    // Nobody moved: both still AT zone-a, no journey exists.
    expect(after.journeys).toHaveLength(0);
    expect(after.loci).toHaveLength(2);
    for (const locus of after.loci) {
      expect(locus.kind).toBe("at");
      if (locus.kind === "at") expect(locus.zoneId).toBe(ids.zoneA);
    }
    // And the scene was NOT half-ended — it still stands.
    const [engagement] = await db().select().from(simEngagements).where(eq(simEngagements.branchId, ids.branchId));
    expect(engagement?.state).toBe("active");
  });

  it("re-running the same command id replays the stored result (branch-level idempotency)", async () => {
    const ids = await seedTogetherCase();
    await openScene(ids);
    const first = await submitDurableMoveTogether(togetherCommand(ids, ids.zoneB), { admitAtLockedVersion: true });
    expect(first.status).toBe("accepted");
    const replay = await submitDurableMoveTogether(togetherCommand(ids, ids.zoneB), { admitAtLockedVersion: true });
    expect(replay).toEqual(first);
    // Still exactly one journey — the replay did not depart the pair a second time.
    const after = await readDurableSpaceBranch(ids.branchId);
    expect(after.journeys).toHaveLength(1);
  });
});
