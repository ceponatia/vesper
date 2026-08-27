import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { characterChats, db, simBranches, simProvisioningRequests, simWorlds } from "@/server/db";

// The orphan sweeper: a world no chat can ever reach again is hard-deleted, and
// a world that is routed, in flight, or merely young is not. Self-skips without
// a database.
//
// Blast radius, deliberately: the sweep is GLOBAL — it has no owner to scope to,
// because an orphan by definition has no chat left to prove ownership through.
// So every real sweep below runs at the DEFAULT one-hour grace and reaches its
// target by BACKDATING that world's `created_at`. Anything another suite seeded
// during this run is minutes old and therefore protected; only genuinely stale
// leftovers are collected, which is exactly what the sweeper is for.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Sweep Admin", role: "admin" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { resetRateLimits } from "@/server/api";
import { DEFAULT_ORPHAN_GRACE_MS, sweepOrphanSimWorlds } from "@/server/engine";
import {
  apiRequest,
  bindAuthUser,
  endTestPool,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
  withAuthUser,
} from "@/server/test-support";
import { POST as sweepPost } from "./sweep-orphan-worlds/route";

const ready = await probeIntegrationDb("orphan-sweep.int.test", "sim_worlds");

/** Comfortably past the default grace, so app/database clock skew is irrelevant. */
const WELL_PAST_GRACE_MS = 2 * DEFAULT_ORPHAN_GRACE_MS;

const SWEEP_PATH = "/api/admin/self/sim/sweep-orphan-worlds";

const sweepReq = (body: unknown, path = SWEEP_PATH): NextRequest => apiRequest(path, { body });

const ids = { owner: "" };
/** Every world this suite seeded — the afterAll safety net for a mid-test failure. */
const seededWorlds: string[] = [];
let serial = 0;

interface SeedOptions {
  /** Push `created_at` this far into the past so the default grace no longer protects it. */
  ageMs?: number;
}

/** A world plus its root branch, named uniquely per call. */
async function seedWorld(label: string, options: SeedOptions = {}): Promise<{ worldId: string; branchId: string }> {
  serial += 1;
  const worldId = `orphan-sweep-${label}-${Date.now()}-${serial}`;
  const branchId = `${worldId}-branch`;
  await db()
    .insert(simWorlds)
    .values({ id: worldId, worldTypeId: "orphan-sweep-test", seed: "orphan-sweep", rulesetVersion: "sweep-v1" });
  await db().insert(simBranches).values({ id: branchId, worldId });
  seededWorlds.push(worldId);
  if (options.ageMs !== undefined) {
    await db()
      .update(simWorlds)
      .set({ createdAt: new Date(Date.now() - options.ageMs) })
      .where(eq(simWorlds.id, worldId));
  }
  return { worldId, branchId };
}

const worldCount = async (worldId: string) =>
  (await db().select({ id: simWorlds.id }).from(simWorlds).where(eq(simWorlds.id, worldId))).length;
const branchCount = async (worldId: string) =>
  (await db().select({ id: simBranches.id }).from(simBranches).where(eq(simBranches.worldId, worldId))).length;

beforeEach(() => resetRateLimits());

beforeAll(async () => {
  if (!ready) return;
  const owner = await seedTestUser("orphan-sweep", { name: "Sweep Admin", role: "admin" });
  bindAuthUser(authState, owner);
  ids.owner = owner.id;
});

afterAll(async () => {
  if (!ready || !ids.owner) return;
  for (const worldId of seededWorlds) await db().delete(simWorlds).where(eq(simWorlds.id, worldId));
  await purgeOwnerRows([ids.owner]);
  await endTestPool();
});

describe.runIf(ready)("orphan sim-world sweep (E20-2)", () => {
  it("deletes a world no chat references, with its branch", async () => {
    const orphan = await seedWorld("orphan", { ageMs: WELL_PAST_GRACE_MS });
    expect(await worldCount(orphan.worldId)).toBe(1);

    const result = await sweepOrphanSimWorlds();

    expect(result.candidateWorldIds).toContain(orphan.worldId);
    expect(result.deletedWorldIds).toContain(orphan.worldId);
    expect(result.failures).toEqual([]);
    // The whole graph goes with the world row — the cascade E20-1 relies on.
    expect(await worldCount(orphan.worldId)).toBe(0);
    expect(await branchCount(orphan.worldId)).toBe(0);
  });

  it("spares a world whose branch a chat still references", async () => {
    const routed = await seedWorld("routed", { ageMs: WELL_PAST_GRACE_MS });
    await db().insert(characterChats).values({ ownerId: ids.owner, simBranchId: routed.branchId });

    const result = await sweepOrphanSimWorlds();

    // `character_chats.sim_branch_id` is the successor lane's only ownership
    // anchor: a world it points into is reachable, therefore never an orphan.
    expect(result.candidateWorldIds).not.toContain(routed.worldId);
    expect(result.deletedWorldIds).not.toContain(routed.worldId);
    expect(await worldCount(routed.worldId)).toBe(1);
    expect(await branchCount(routed.worldId)).toBe(1);
  });

  it("spares a world a non-terminal provisioning record still claims", async () => {
    const inFlight = await seedWorld("in-flight", { ageMs: WELL_PAST_GRACE_MS });
    await db().insert(simProvisioningRequests).values({
      ownerId: ids.owner,
      requestId: `sweep-in-flight-${Date.now()}`,
      payloadHash: "sweep-test-hash",
      state: "world_created",
      worldId: inFlight.worldId,
      branchId: inFlight.branchId,
    });

    const result = await sweepOrphanSimWorlds();

    // A half-built world is unrouted by construction until the authority flip;
    // its record is what says a retry still means to finish it.
    expect(result.candidateWorldIds).not.toContain(inFlight.worldId);
    expect(await worldCount(inFlight.worldId)).toBe(1);
  });

  it("spares a world still inside the grace window", async () => {
    const young = await seedWorld("young");

    const swept = await sweepOrphanSimWorlds();
    expect(swept.candidateWorldIds).not.toContain(young.worldId);
    expect(await worldCount(young.worldId)).toBe(1);

    // Age is the only thing protecting it: with the window closed it qualifies.
    const withoutGrace = await sweepOrphanSimWorlds({ dryRun: true, graceMs: 0 });
    expect(withoutGrace.graceMs).toBe(0);
    expect(withoutGrace.candidateWorldIds).toContain(young.worldId);
  });

  it("reports candidates and deletes nothing on a dry run", async () => {
    const orphan = await seedWorld("dry-run", { ageMs: WELL_PAST_GRACE_MS });

    const result = await sweepOrphanSimWorlds({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.candidateWorldIds).toContain(orphan.worldId);
    expect(result.deletedWorldIds).toEqual([]);
    expect(await worldCount(orphan.worldId)).toBe(1);
    expect(await branchCount(orphan.worldId)).toBe(1);
  });
});

describe.runIf(ready)("POST /api/admin/self/sim/sweep-orphan-worlds", () => {
  it("runs the sweep for an admin and answers the structured result", async () => {
    const orphan = await seedWorld("route", { ageMs: WELL_PAST_GRACE_MS });

    const dry = await sweepPost(sweepReq({ dryRun: true }), routeCtx());
    const preview = await expectJson<{ candidateWorldIds: string[]; deletedWorldIds: string[]; dryRun: boolean }>(dry, 200);
    expect(preview.dryRun).toBe(true);
    expect(preview.candidateWorldIds).toContain(orphan.worldId);
    expect(preview.deletedWorldIds).toEqual([]);
    expect(await worldCount(orphan.worldId)).toBe(1);

    const live = await sweepPost(sweepReq({}), routeCtx());
    expect((await expectJson<{ deletedWorldIds: string[] }>(live, 200)).deletedWorldIds).toContain(orphan.worldId);
    expect(await worldCount(orphan.worldId)).toBe(0);
  });

  it("rejects an unknown field in the body", async () => {
    const res = await sweepPost(sweepReq({ dryRun: true, graceMs: 0 }), routeCtx());
    expect(res.status).toBe(400);
  });

  it("hides the sweep from non-admins and from the old ambiguous namespace", async () => {
    const survivor = await seedWorld("gated", { ageMs: WELL_PAST_GRACE_MS });

    await withAuthUser(authState, { role: "user" }, async () => {
      const denied = await sweepPost(sweepReq({}), routeCtx());
      expect(denied.status).toBe(404);
    });

    const oldNamespace = await sweepPost(sweepReq({}, "/api/admin/sim/sweep-orphan-worlds"), routeCtx());
    expect(oldNamespace.status).toBe(404);

    // Neither refusal ran the sweep.
    expect(await worldCount(survivor.worldId)).toBe(1);
  });
});
