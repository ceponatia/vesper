import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, simActorLods, simEvents, simTriggers, simWorlds } from "@/server/db";
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
 */

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_worlds limit 1`),
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
      `[rollout-world.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();

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
