import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterChats, db, simWorlds, users } from "@/server/db";

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
const ORIGIN = 2 * 86_400 + 600 * 60;
const ctx = (branchId: string) => ({ params: Promise.resolve({ branchId }) });
const statusPath = (branchId: string) => `/api/admin/self/sim/${branchId}`;
const commandPath = (branchId: string) => `${statusPath(branchId)}/command`;
function jsonReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://t${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ids = { owner: "", foreignAdmin: "", chat: "" };

beforeAll(async () => {
  if (!ready) return;
  await db().delete(characterChats).where(eq(characterChats.simBranchId, BRANCH));
  await db().delete(simWorlds).where(eq(simWorlds.id, WORLD));
  const stamp = Date.now();
  const [owner] = await db()
    .insert(users)
    .values({ email: `sim-admin-${stamp}@test.local`, name: "Sim Admin", role: "admin" })
    .returning();
  const [foreignAdmin] = await db()
    .insert(users)
    .values({ email: `sim-admin-foreign-${stamp}@test.local`, name: "Foreign Admin", role: "admin" })
    .returning();
  if (!owner || !foreignAdmin) throw new Error("failed to create test users");
  authState.user = { ...authState.user, id: owner.id, email: owner.email };
  ids.owner = owner.id;
  ids.foreignAdmin = foreignAdmin.id;
});

afterAll(async () => {
  if (!ready) return;
  await db().delete(characterChats).where(eq(characterChats.simBranchId, BRANCH));
  await db().delete(simWorlds).where(eq(simWorlds.id, WORLD));
  if (ids.owner) await db().delete(users).where(eq(users.id, ids.owner));
  if (ids.foreignAdmin) await db().delete(users).where(eq(users.id, ids.foreignAdmin));
});

describe.runIf(ready)("R3 self-scoped sim admin routes", () => {
  it("provisions a world, links it to an owned chat, and drives every storyteller tool", async () => {
    const provisioned = await worldsPost(
      jsonReq("/api/admin/self/sim/worlds", {
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

    const [chat] = await db()
      .insert(characterChats)
      .values({ ownerId: ids.owner, simBranchId: BRANCH })
      .returning({ id: characterChats.id });
    if (!chat) throw new Error("failed to link branch to owned chat");
    ids.chat = chat.id;

    const duplicate = await worldsPost(
      jsonReq("/api/admin/self/sim/worlds", { world: { worldId: WORLD, branchId: BRANCH }, topology: {} }),
      { params: Promise.resolve({}) },
    );
    expect(duplicate.status).toBe(409);

    const promote = await toolPost(
      jsonReq(commandPath(BRANCH), {
        kind: "promote",
        cohortId: "sat-cohort-crowd",
        zoneId: "sat-zone-square",
        name: "Odell",
        landing: { simulationLod: "event", inferenceLod: "no_model" },
      }),
      ctx(BRANCH),
    );
    expect(promote.status).toBe(200);

    expect(
      (
        await toolPost(
          jsonReq(commandPath(BRANCH), {
            kind: "relocate",
            actorId: "sat-actor-iris",
            destinationZoneId: "sat-zone-inn",
            reason: "authoring: staging the scene",
          }),
          ctx(BRANCH),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await toolPost(
          jsonReq(commandPath(BRANCH), {
            kind: "assign_lod",
            actorId: "sat-actor-iris",
            simulationLod: "exact",
            inferenceLod: "deliberator",
          }),
          ctx(BRANCH),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await toolPost(
          jsonReq(commandPath(BRANCH), {
            kind: "adjust_cohort",
            cohortId: "sat-cohort-crowd",
            deltaCount: -5,
            reason: "attrition",
          }),
          ctx(BRANCH),
        )
      ).status,
    ).toBe(200);

    const overdraw = await toolPost(
      jsonReq(commandPath(BRANCH), {
        kind: "adjust_cohort",
        cohortId: "sat-cohort-crowd",
        deltaCount: -500,
        reason: "attrition",
      }),
      ctx(BRANCH),
    );
    expect(overdraw.status).toBe(409);
    expect(await overdraw.json()).toMatchObject({ status: "rejected", code: "insufficient_population" });

    const advanced = await toolPost(jsonReq(commandPath(BRANCH), { kind: "advance", days: 1 }), ctx(BRANCH));
    expect(advanced.status).toBe(200);
    expect(await advanced.json()).toMatchObject({ status: "advanced", toStorySecond: ORIGIN + 86_400 });

    const status = await statusGet(new NextRequest(`http://t${statusPath(BRANCH)}`), ctx(BRANCH));
    expect(status.status).toBe(200);
    const snapshot = (await status.json()) as {
      storySecond: number;
      actors: { id: string; name: string; locus: { zoneId: string | null } | null; lod: { simulationLod: string } | null }[];
      cohorts: { cohortId: string; population: number }[];
    };
    expect(snapshot.storySecond).toBe(ORIGIN + 86_400);
    expect(snapshot.cohorts).toEqual([{ cohortId: "sat-cohort-crowd", name: "market crowd", population: 34 }]);
    expect(snapshot.actors.find((actor) => actor.id === "sat-actor-iris")?.locus?.zoneId).toBe("sat-zone-inn");
    expect(snapshot.actors.find((actor) => actor.id === "sat-actor-iris")?.lod?.simulationLod).toBe("exact");
    expect(snapshot.actors.find((actor) => actor.name === "Odell")?.lod?.simulationLod).toBe("event");
  });

  it("hides owned branches from other admins, non-admins, and the old namespace", async () => {
    const owner = { ...authState.user };
    authState.user = {
      id: ids.foreignAdmin,
      email: "foreign-admin@test.local",
      name: "Foreign Admin",
      role: "admin",
    };
    const foreign = await statusGet(new NextRequest(`http://t${statusPath(BRANCH)}`), ctx(BRANCH));
    expect(foreign.status).toBe(404);

    authState.user = { ...owner, role: "user" };
    const denied = await statusGet(new NextRequest(`http://t${statusPath(BRANCH)}`), ctx(BRANCH));
    expect(denied.status).toBe(404);

    authState.user = owner;
    const oldNamespace = await statusGet(new NextRequest(`http://t/api/admin/sim/${BRANCH}`), ctx(BRANCH));
    expect(oldNamespace.status).toBe(404);
  });
});
