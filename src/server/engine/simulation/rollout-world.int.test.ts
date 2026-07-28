import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, simActorLods, simEvents, simTriggers, simWorlds } from "@/server/db";
import { simulationSuiteHarness } from "@/server/test-support";
import {
  ROLLOUT_ACTORS,
  ROLLOUT_BRANCH_ID,
  ROLLOUT_ORIGIN_STORY_SECOND,
  ROLLOUT_WORLD_ID,
  advanceRolloutWorld,
  seedRolloutTestWorld,
} from "./rollout-world";

/**
 * R1 (engine.rollout.plan.md) — the standing internal test world: idempotent
 * provisioning under fixed ids, and a drain that runs the E6.2 routine life
 * exactly as the Gate 6 corpus does. This is the local half of R1's exit
 * criterion; the Fly half is the same two `pnpm sim:*` commands over SSH.
 *
 * `simulationSuiteHarness` supplies the probe and the pool close; the world's
 * ids are FIXED so this file keeps its own explicit both-ends teardown rather
 * than tracking the id (tracking it too would delete the same world twice).
 * `legacyPlayerMode: false` because every seed command here is authored by the
 * `rollout-seeder` SYSTEM principal — no legacy player fixture is submitted, so
 * this suite must keep running without the aggregate-run opt-in flag.
 */

const harness = await simulationSuiteHarness({
  suite: "rollout-world.int.test",
  table: "sim_worlds",
  legacyPlayerMode: false,
});
const ready = harness.ready;

/** The world's ids are FIXED, so the suite owns them exclusively: clear both ends. */
async function teardownRolloutWorld(): Promise<void> {
  await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
}

beforeAll(async () => {
  if (!ready) return;
  await teardownRolloutWorld();
});
afterAll(async () => {
  if (!ready) return;
  await teardownRolloutWorld();
});

describe.runIf(ready)("R1 rollout test world", () => {
  it("seeds idempotently under fixed ids, then drains routine life", async () => {
    const seeded = await seedRolloutTestWorld();
    expect(seeded).toMatchObject({
      worldId: ROLLOUT_WORLD_ID,
      branchId: ROLLOUT_BRANCH_ID,
      alreadySeeded: false,
      storySecond: ROLLOUT_ORIGIN_STORY_SECOND,
    });
    // The two event-LOD actors have live routine alarms; the dormant one has
    // nothing pending (the E6.3 no-work law); default-exact Mara keeps her
    // body alarms only.
    expect(seeded.pendingTriggers).toBeGreaterThan(0);
    const rivenTriggers = await db()
      .select({ uniquenessKey: simTriggers.uniquenessKey })
      .from(simTriggers)
      .where(and(eq(simTriggers.branchId, ROLLOUT_BRANCH_ID), eq(simTriggers.state, "pending")));
    expect(rivenTriggers.some((row) => row.uniquenessKey?.includes(ROLLOUT_ACTORS.riven))).toBe(false);
    const [rivenLod] = await db()
      .select({ simulationLod: simActorLods.simulationLod })
      .from(simActorLods)
      .where(and(eq(simActorLods.branchId, ROLLOUT_BRANCH_ID), eq(simActorLods.actorId, ROLLOUT_ACTORS.riven)));
    expect(rivenLod).toEqual({ simulationLod: "dormant" });

    // Re-running finds the world instead of duplicating it.
    const again = await seedRolloutTestWorld();
    expect(again.alreadySeeded).toBe(true);

    // One story-day: Ana eats at noon, Ana and Ben sleep at 23:00, both wake
    // at 07:00 — background life with zero model calls, as the corpus proves.
    const advanced = await advanceRolloutWorld({ days: 1 });
    expect(advanced.toStorySecond).toBe(ROLLOUT_ORIGIN_STORY_SECOND + 86_400);
    expect(advanced.routineDecisions).toBeGreaterThanOrEqual(3);
    const decisions = await db()
      .select({ payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ROLLOUT_BRANCH_ID), eq(simEvents.type, "routine_policy_resolved")))
      .orderBy(asc(simEvents.sequence));
    const chosen = decisions.map((row) => (row.payload as { chosenCandidateId?: string }).chosenCandidateId);
    expect(chosen).toContain("eat_meal");
    expect(chosen).toContain("begin_sleep");
  });
});
