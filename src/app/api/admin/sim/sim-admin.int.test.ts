import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, simWorlds, users } from "@/server/db";

// R3 slice 3 (engine.rollout.plan.md) — the authoring + storyteller tool
// routes: declarative provisioning through the real seeders, the status
// read, audited relocation, §27.2 promote-from-cohort, the LOD dial,
// conserved cohort adjustment, and the bounded advance. Zero model calls.

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Sim Admin Int", role: "admin" as "admin" | "user" },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { GET as statusGet } from "./[branchId]/route";
import { POST as toolPost } from "./[branchId]/command/route";
import { POST as worldsPost } from "./worlds/route";

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
  } catch (err) {
    process.stderr.write(
      `[sim-admin.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const WORLD = "sim-admin-test-world";
const BRANCH = "sim-admin-test-branch";
const ORIGIN = 2 * 86_400 + 600 * 60; // day 2, 10:00 — mid presence window
const ctx = (branchId: string) => ({ params: Promise.resolve({ branchId }) });
function jsonReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://t${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  if (!ready) return;
  await db().delete(simWorlds).where(eq(simWorlds.id, WORLD));
  const [user] = await db()
    .insert(users)
    .values({ email: `sim-admin-${Date.now()}@test.local`, name: "Sim Admin", role: "admin" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  authState.user = { ...authState.user, id: user.id, email: user.email };
});

afterAll(async () => {
  if (!ready || !authState.user.id) return;
  await db().delete(simWorlds).where(eq(simWorlds.id, WORLD));
  await db().delete(users).where(eq(users.id, authState.user.id));
});

describe.runIf(ready)("R3 sim admin routes", () => {
  it("provisions a world declaratively, reads status, and drives every storyteller tool", async () => {
    const provisioned = await worldsPost(
      jsonReq("/api/admin/sim/worlds", {
        world: {
          worldId: WORLD,
          worldTypeId: "sim-admin-test",
          worldSeed: "sim-admin-seed",
          branchId: BRANCH,
          rulesetVersion: "sim-admin-v1",
          originStorySecond: ORIGIN,
          actors: [{ id: "sat-actor-iris", name: "Iris" }],
          items: [],
        },
        topology: {
          locations: [{ id: "sat-loc", worldId: WORLD, kind: "town", defaultAccessPolicy: "public" }],
          zones: [
            { id: "sat-zone-square", locationId: "sat-loc", kind: "plaza", privacyPolicy: "public" },
            { id: "sat-zone-inn", locationId: "sat-loc", kind: "home", privacyPolicy: "public" },
          ],
          links: [
            {
              id: "sat-link",
              fromZoneId: "sat-zone-square",
              toZoneId: "sat-zone-inn",
              modes: ["walk"],
              minimumDurationSeconds: 120,
              accessPolicy: "public",
              state: "open",
            },
          ],
          loci: [
            { kind: "at", actorId: "sat-actor-iris", locationId: "sat-loc", zoneId: "sat-zone-square", since: ORIGIN },
          ],
        },
        rhythms: [{ actorId: "sat-actor-iris", kind: "sleep", startMinuteOfDay: 1_380, endMinuteOfDay: 420 }],
        embodyActorIds: ["sat-actor-iris"],
        lods: [{ actorId: "sat-actor-iris", simulationLod: "event", inferenceLod: "no_model" }],
        cohorts: [
          {
            id: "sat-cohort-crowd",
            name: "market crowd",
            population: 40,
            presenceWindows: [
              { zoneId: "sat-zone-square", startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 10_000 },
            ],
            registryVersion: "cohort-v1",
          },
        ],
      }),
      { params: Promise.resolve({}) },
    );
    expect(provisioned.status).toBe(201);
    // Re-provisioning the same world is a 409, never a mutation.
    const dup = await worldsPost(jsonReq("/api/admin/sim/worlds", { world: { worldId: WORLD, branchId: BRANCH }, topology: {} }), {
      params: Promise.resolve({}),
    });
    expect(dup.status).toBe(409);

    const promoteRes = await toolPost(
      jsonReq(`/api/admin/sim/${BRANCH}/command`, {
        kind: "promote",
        cohortId: "sat-cohort-crowd",
        zoneId: "sat-zone-square",
        name: "Odell",
        landing: { simulationLod: "event", inferenceLod: "no_model" },
      }),
      ctx(BRANCH),
    );
    expect(promoteRes.status).toBe(200);

    const relocated = await toolPost(
      jsonReq(`/api/admin/sim/${BRANCH}/command`, {
        kind: "relocate",
        actorId: "sat-actor-iris",
        destinationZoneId: "sat-zone-inn",
        reason: "authoring: staging the scene",
      }),
      ctx(BRANCH),
    );
    expect(relocated.status).toBe(200);

    const dialed = await toolPost(
      jsonReq(`/api/admin/sim/${BRANCH}/command`, { kind: "assign_lod", actorId: "sat-actor-iris", simulationLod: "exact", inferenceLod: "deliberator" }),
      ctx(BRANCH),
    );
    expect(dialed.status).toBe(200);

    const adjusted = await toolPost(
      jsonReq(`/api/admin/sim/${BRANCH}/command`, { kind: "adjust_cohort", cohortId: "sat-cohort-crowd", deltaCount: -5, reason: "attrition" }),
      ctx(BRANCH),
    );
    expect(adjusted.status).toBe(200);
    const overdraw = await toolPost(
      jsonReq(`/api/admin/sim/${BRANCH}/command`, { kind: "adjust_cohort", cohortId: "sat-cohort-crowd", deltaCount: -500, reason: "attrition" }),
      ctx(BRANCH),
    );
    expect(overdraw.status).toBe(409);
    expect(await overdraw.json()).toMatchObject({ status: "rejected", code: "insufficient_population" });

    const advanced = await toolPost(jsonReq(`/api/admin/sim/${BRANCH}/command`, { kind: "advance", days: 1 }), ctx(BRANCH));
    expect(advanced.status).toBe(200);
    expect(await advanced.json()).toMatchObject({ status: "advanced", toStorySecond: ORIGIN + 86_400 });

    const status = await statusGet(new NextRequest(`http://t/api/admin/sim/${BRANCH}`), ctx(BRANCH));
    expect(status.status).toBe(200);
    const snapshot = (await status.json()) as {
      storySecond: number;
      actors: { id: string; name: string; locus: { zoneId: string | null } | null; lod: { simulationLod: string } | null }[];
      cohorts: { cohortId: string; population: number }[];
    };
    expect(snapshot.storySecond).toBe(ORIGIN + 86_400);
    // The promoted actor exists with their landing LOD; the cohort conserved
    // 40 − 1 (promotion) − 5 (attrition) = 34; Iris rests at the inn on the
    // exact/deliberator dial the storyteller set.
    expect(snapshot.cohorts).toEqual([{ cohortId: "sat-cohort-crowd", name: "market crowd", population: 34 }]);
    const iris = snapshot.actors.find((actor) => actor.id === "sat-actor-iris");
    expect(iris?.locus?.zoneId).toBe("sat-zone-inn");
    expect(iris?.lod?.simulationLod).toBe("exact");
    const odell = snapshot.actors.find((actor) => actor.name === "Odell");
    expect(odell?.lod?.simulationLod).toBe("event");
    expect(odell?.locus?.zoneId).toBe("sat-zone-square");
  });

  it("hides the family from non-admins", async () => {
    authState.user = { ...authState.user, role: "user" };
    const denied = await statusGet(new NextRequest(`http://t/api/admin/sim/${BRANCH}`), ctx(BRANCH));
    expect(denied.status).toBe(404);
    authState.user = { ...authState.user, role: "admin" };
  });
});
