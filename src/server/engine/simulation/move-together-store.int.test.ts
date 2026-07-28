import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import { db, simEngagements, simTriggers } from "@/server/db";
import {
  ADMIT_AT_LOCKED_VERSION,
  expectAccepted,
  expectRejected,
  playerPrincipal,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
  type SimCommandEnvelope,
} from "@/server/test-support";
import { readDurableSpaceBranch } from "./space-store";
import { submitDurableMoveTogether } from "./move-together-store";
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

const harness = await simulationSuiteHarness({
  suite: "move-together-store.int.test",
  table: "sim_physical_loci",
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

async function seedTogetherCase(): Promise<TogetherCase> {
  const worldId = newId();
  const branchId = newId();
  const playerId = newId();
  const primaryId = newId();
  const locHome = `${worldId}-loc-home`;
  const locCafe = `${worldId}-loc-cafe`;
  const locIsle = `${worldId}-loc-isle`;
  const zoneA = `${branchId}-zone-a`;
  const zoneB = `${branchId}-zone-b`;
  const zoneD = `${branchId}-zone-d`;

  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: "a4-tests",
    rulesetVersion: "a4-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: playerId, name: "You" },
      { id: primaryId, name: "Nora" },
    ],
    locations: [
      { id: locHome, worldId, kind: "home", defaultAccessPolicy: "private" },
      { id: locCafe, worldId, kind: "cafe", defaultAccessPolicy: "public" },
      { id: locIsle, worldId, kind: "isle", defaultAccessPolicy: "public" },
    ],
    zones: [
      { id: zoneA, locationId: locHome, kind: "room", privacyPolicy: "private" },
      { id: zoneB, locationId: locCafe, kind: "hall", privacyPolicy: "public" },
      // Disconnected — no link reaches it, so a move there is `no_route`.
      { id: zoneD, locationId: locIsle, kind: "cellar", privacyPolicy: "public" },
    ],
    links: [
      {
        id: `${branchId}-link-ab`,
        fromZoneId: zoneA,
        toZoneId: zoneB,
        modes: ["walk"],
        minimumDurationSeconds: WALK_AB,
        accessPolicy: "public",
        state: "open",
      },
    ],
    // Both co-present at zone-a.
    placements: [
      { actorId: playerId, locationId: locHome, zoneId: zoneA },
      { actorId: primaryId, locationId: locHome, zoneId: zoneA },
    ],
  });
  harness.trackWorld(worldId);
  return { worldId, branchId, playerId, primaryId, zoneA, zoneB, zoneD };
}

async function openScene(ids: TogetherCase): Promise<void> {
  const result = await submitDurableOpenEngagement(
    simCommand({
      branchId: ids.branchId,
      name: "open",
      type: "open_engagement",
      principal: playerPrincipal(ids.playerId),
      payload: { participantIds: [ids.playerId, ids.primaryId].sort(), channel: "co_present" },
    }),
    ADMIT_AT_LOCKED_VERSION,
  );
  expectAccepted(result, "scene open");
}

function togetherCommand(ids: TogetherCase, destinationZoneId: string): SimCommandEnvelope {
  return simCommand({
    branchId: ids.branchId,
    name: "together",
    type: "move_together",
    principal: playerPrincipal(ids.playerId),
    payload: { actorId: ids.playerId, coTravelerActorId: ids.primaryId, destinationZoneId, travelMode: "walk" },
  });
}

describe.runIf(harness.ready)("command-integrity A4 — atomic move_together", () => {
  it("walk-with-me: one shared journey carries BOTH, and a drain lands both together", async () => {
    const ids = await seedTogetherCase();
    await openScene(ids);

    const result = await submitDurableMoveTogether(togetherCommand(ids, ids.zoneB), ADMIT_AT_LOCKED_VERSION);
    expectAccepted(result, "walk-with-me");
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
    const result = await submitDurableMoveTogether(togetherCommand(ids, ids.zoneD), ADMIT_AT_LOCKED_VERSION);
    expectRejected(result, "no_route", "unroutable walk-together");

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
    const first = await submitDurableMoveTogether(togetherCommand(ids, ids.zoneB), ADMIT_AT_LOCKED_VERSION);
    expectAccepted(first, "first walk-together");
    const replay = await submitDurableMoveTogether(togetherCommand(ids, ids.zoneB), ADMIT_AT_LOCKED_VERSION);
    expect(replay).toEqual(first);
    // Still exactly one journey — the replay did not depart the pair a second time.
    const after = await readDurableSpaceBranch(ids.branchId);
    expect(after.journeys).toHaveLength(1);
  });
});
