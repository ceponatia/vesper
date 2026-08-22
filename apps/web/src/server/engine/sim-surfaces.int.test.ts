import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { METER_FIXED_POINT_ONE } from "@vesper/simulation-core/contracts/bodies";
import { characterChats, db, simBodyMeters, simBranches, users } from "@/server/db";
import {
  ROLLOUT_ACTORS,
  ROLLOUT_BRANCH_ID,
  readSimChatMeters,
  readSimChatOutfit,
  readSimChatPresence,
  readSimChatWorld,
  seedRolloutTestWorld,
} from "@/server/engine";
import { simulationSuiteHarness } from "@/server/test-support";

// sim-read-seam-guards.plan.md slice 2: `readSimChatMeters` must INTEGRATE each
// meter to the branch clock on read (via the shared `buildMeterView` seam),
// not echo the last stored write. Needs Postgres; self-skips without it. The
// slice-1 degradation guards are proven db-free in sim-surfaces.degradation.test.ts.
//
// The probe/pool handling comes from `simulationSuiteHarness`. That is a
// behavioral FIX here: this file's hand-rolled probe had diverged to a plain
// self-skip with no strict/CI rethrow at all, so an unreachable database
// reported a silently green suite even under `pnpm test:int:strict`.
// `legacyPlayerMode: false` is the historical harness option name — the rollout
// seed runs on a system principal and nothing here submits that player fixture,
// so the opt-in flag stays irrelevant to this suite. The fixed rollout world is
// deliberately NOT tracked for teardown: this suite restores the shared clock
// instead of deleting the world, which lets the other rollout-world suites reuse it.

const harness = await simulationSuiteHarness({
  suite: "sim-surfaces.int.test",
  table: "character_chats",
  legacyPlayerMode: false,
});
const ready = harness.ready;

describe.runIf(ready)("readSimChatMeters integrates to the branch clock (slice 2)", () => {
  const ids = { user: "", chat: "" };
  let originalStorySecond = 0;

  beforeAll(async () => {
    await seedRolloutTestWorld();
    const [branch] = await db()
      .select({ storySecond: simBranches.storySecond })
      .from(simBranches)
      .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    if (!branch) throw new Error("rollout branch missing after seed");
    originalStorySecond = branch.storySecond;

    const [user] = await db()
      .insert(users)
      .values({ email: `sim-surfaces-${Date.now()}@test.local`, name: "Sim Surfaces Int" })
      .returning();
    if (!user) throw new Error("failed to create test user");
    ids.user = user.id;

    // A routed chat mapping the player to Mara and the primary to Ana — exactly
    // what `readSimChatMeters`'s authority guard needs, inserted directly (the
    // seam reads only the authority columns, not the audited flip path).
    const [chat] = await db()
      .insert(characterChats)
      .values({
        ownerId: user.id,
        engineAuthority: "successor_narrative_view",
        simBranchId: ROLLOUT_BRANCH_ID,
        simPlayerActorId: ROLLOUT_ACTORS.mara,
        simPrimaryActorId: ROLLOUT_ACTORS.ana,
      })
      .returning();
    if (!chat) throw new Error("failed to create routed chat");
    ids.chat = chat.id;
  });

  afterAll(async () => {
    if (!ready) return;
    // Restore the shared clock so a later int file reusing the rollout world
    // sees it as freshly seeded.
    await db()
      .update(simBranches)
      .set({ storySecond: originalStorySecond })
      .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    if (ids.chat) await db().delete(characterChats).where(eq(characterChats.id, ids.chat));
    if (ids.user) await db().delete(users).where(eq(users.id, ids.user));
  });

  it("reads a drifted meter at its INTEGRATED value, not its stored write", async () => {
    // Ana's hygiene is a linear-drain meter with no wash rhythm, so it drifts
    // purely (no self-care jumps) between writes — the cleanest drift to pin.
    const [row] = await db()
      .select({ value: simBodyMeters.valueFixedPoint, lastAt: simBodyMeters.lastIntegratedAt })
      .from(simBodyMeters)
      .where(
        and(
          eq(simBodyMeters.branchId, ROLLOUT_BRANCH_ID),
          eq(simBodyMeters.actorId, ROLLOUT_ACTORS.ana),
          eq(simBodyMeters.meterKey, "hygiene"),
        ),
      );
    if (!row) throw new Error("ana hygiene meter missing");
    const storedFixed = row.value;
    const writtenAt = row.lastAt;

    // Clock pinned to the write instant → integrate-on-read returns the stored
    // value unchanged (no happy-path regression; parity with the old read).
    await db().update(simBranches).set({ storySecond: writtenAt }).where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    const atWrite = await readSimChatMeters(ids.chat);
    expect(atWrite?.hygiene).toBeCloseTo(storedFixed / METER_FIXED_POINT_ONE, 6);

    // Advance the clock two story-hours with NO material write: the row is now
    // stale, so the OLD (stored) read would still echo `storedFixed`.
    // Integrate-on-read must instead drain hygiene by 150/h · 2h = 300 units.
    const driftedAt = writtenAt + 7_200;
    await db().update(simBranches).set({ storySecond: driftedAt }).where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    const now = await readSimChatMeters(ids.chat);
    const expectedFixed = Math.max(0, storedFixed - 300);
    expect(now?.hygiene).toBeCloseTo(expectedFixed / METER_FIXED_POINT_ONE, 6);
    expect(now?.hygiene).toBeLessThan(atWrite?.hygiene ?? 0);
  });

  it("keeps well-formed routed panels non-null through the slice-1 guard wrap", async () => {
    await db()
      .update(simBranches)
      .set({ storySecond: originalStorySecond })
      .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    // Presence and meters read for a healthy routed chat — the resilience wrap
    // must not turn a good read into a hidden panel.
    expect(await readSimChatPresence(ids.chat)).not.toBeNull();
    expect(await readSimChatMeters(ids.chat)).not.toBeNull();
    // Known-empty is an explicit world-truth phrase, not an empty string that
    // truthy transport can silently collapse into "wardrobe unavailable".
    expect(await readSimChatOutfit(ids.chat)).toBe("no clothing");
    // Cast rows carry stable actor identity for keyed UI rows and future
    // actor-targeted commands; the id is transport data, never display copy.
    const world = await readSimChatWorld(ids.chat);
    expect(world?.cast.find((member) => member.isPrimary)?.actorId).toBe(ROLLOUT_ACTORS.ana);
  });
});