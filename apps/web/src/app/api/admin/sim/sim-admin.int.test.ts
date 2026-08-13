import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterChats, db, simWorlds } from "@/server/db";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Sim Admin Int", role: "admin" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

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
import { GET as statusGet } from "./[branchId]/route";
import { POST as toolPost } from "./[branchId]/command/route";
import { POST as worldsPost } from "./worlds/route";

const ready = await probeIntegrationDb("sim-admin.int.test", "sim_worlds");

const WORLD = "sim-admin-test-world";
const BRANCH = "sim-admin-test-branch";
const ORIGIN = 2 * 86_400 + 600 * 60;
const statusPath = (branchId: string) => `/api/admin/self/sim/${branchId}`;
const commandPath = (branchId: string) => `${statusPath(branchId)}/command`;
const jsonReq = (path: string, body: unknown): NextRequest => apiRequest(path, { body });

const ids = { owner: "", foreignAdmin: "", chat: "" };

beforeAll(async () => {
  if (!ready) return;
  await db().delete(characterChats).where(eq(characterChats.simBranchId, BRANCH));
  await db().delete(simWorlds).where(eq(simWorlds.id, WORLD));
  const owner = await seedTestUser("sim-admin", { name: "Sim Admin", role: "admin" });
  const foreignAdmin = await seedTestUser("sim-admin-foreign", { name: "Foreign Admin", role: "admin" });
  bindAuthUser(authState, owner);
  ids.owner = owner.id;
  ids.foreignAdmin = foreignAdmin.id;
});

afterAll(async () => {
  if (!ready) return;
  await db().delete(simWorlds).where(eq(simWorlds.id, WORLD));
  await purgeOwnerRows([ids.owner, ids.foreignAdmin]);
  await endTestPool();
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
      routeCtx(),
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
      routeCtx(),
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
      routeCtx({ branchId: BRANCH }),
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
          routeCtx({ branchId: BRANCH }),
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
          routeCtx({ branchId: BRANCH }),
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
          routeCtx({ branchId: BRANCH }),
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
      routeCtx({ branchId: BRANCH }),
    );
    expect(await expectJson(overdraw, 409)).toMatchObject({ status: "rejected", code: "insufficient_population" });

    const advanced = await toolPost(jsonReq(commandPath(BRANCH), { kind: "advance", days: 1 }), routeCtx({ branchId: BRANCH }));
    expect(await expectJson(advanced, 200)).toMatchObject({ status: "advanced", toStorySecond: ORIGIN + 86_400 });

    const status = await statusGet(apiRequest(statusPath(BRANCH)), routeCtx({ branchId: BRANCH }));
    const snapshot = await expectJson<{
      storySecond: number;
      actors: { id: string; name: string; locus: { zoneId: string | null } | null; lod: { simulationLod: string } | null }[];
      cohorts: { cohortId: string; population: number }[];
    }>(status, 200);
    expect(snapshot.storySecond).toBe(ORIGIN + 86_400);
    expect(snapshot.cohorts).toEqual([{ cohortId: "sat-cohort-crowd", name: "market crowd", population: 34 }]);
    expect(snapshot.actors.find((actor) => actor.id === "sat-actor-iris")?.locus?.zoneId).toBe("sat-zone-inn");
    expect(snapshot.actors.find((actor) => actor.id === "sat-actor-iris")?.lod?.simulationLod).toBe("exact");
    expect(snapshot.actors.find((actor) => actor.name === "Odell")?.lod?.simulationLod).toBe("event");
  });

  it("hides owned branches from other admins, non-admins, and the old namespace", async () => {
    await withAuthUser(
      authState,
      { id: ids.foreignAdmin, email: "foreign-admin@test.local", name: "Foreign Admin", role: "admin" },
      async () => {
        const foreign = await statusGet(apiRequest(statusPath(BRANCH)), routeCtx({ branchId: BRANCH }));
        expect(foreign.status).toBe(404);
      },
    );

    await withAuthUser(authState, { role: "user" }, async () => {
      const denied = await statusGet(apiRequest(statusPath(BRANCH)), routeCtx({ branchId: BRANCH }));
      expect(denied.status).toBe(404);
    });

    const oldNamespace = await statusGet(apiRequest(`/api/admin/sim/${BRANCH}`), routeCtx({ branchId: BRANCH }));
    expect(oldNamespace.status).toBe(404);
  });
});
