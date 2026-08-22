import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import {
  characterChats,
  characters,
  chatParticipants,
  db,
  simBranches,
  simWorlds,
} from "@/server/db";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Engine Comparison Int", role: "admin" as const },
}));
vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  COMPARISON_WORLD_TYPE_ID,
  readChatEngineAuthority,
  readDurableBodies,
  readDurableSpaceBranch,
} from "@/server/engine";
import {
  apiRequest,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
} from "@/server/test-support";
import { DELETE, GET, POST } from "./[chatId]/route";

const ready = await probeIntegrationDb("engine-comparison.int.test", "sim_worlds");
const ids = { owner: "", chat: "", groupChat: "" };

const req = (chatId: string, method: "GET" | "POST" | "DELETE"): NextRequest =>
  apiRequest(`/api/admin/self/engine-comparison/${chatId}`, { method });
const ctx = (chatId: string) => routeCtx({ chatId });

beforeAll(async () => {
  if (!ready) return;
  const owner = await seedTestUser("engine-comparison-int", { name: "Comparison Owner", role: "admin" });
  ids.owner = owner.id;
  authState.user = { id: owner.id, email: owner.email, name: "Comparison Owner", role: "admin" };

  const [primary, secondary] = await db()
    .insert(characters)
    .values([
      { ownerId: owner.id, name: "Ana", profile: {} },
      { ownerId: owner.id, name: "Ben", profile: {} },
    ])
    .returning({ id: characters.id });
  if (!primary || !secondary) throw new Error("comparison characters were not seeded");

  const [chat, groupChat] = await db()
    .insert(characterChats)
    .values([{ ownerId: owner.id }, { ownerId: owner.id }])
    .returning({ id: characterChats.id });
  if (!chat || !groupChat) throw new Error("comparison chats were not seeded");
  ids.chat = chat.id;
  ids.groupChat = groupChat.id;
  await db().insert(chatParticipants).values([
    { chatId: chat.id, characterId: primary.id, memoryGroupId: newId(), sort: 0 },
    { chatId: groupChat.id, characterId: primary.id, memoryGroupId: newId(), sort: 0 },
    { chatId: groupChat.id, characterId: secondary.id, memoryGroupId: newId(), sort: 1 },
  ]);
});

afterAll(async () => {
  if (!ready) return;
  // A failed assertion before DELETE can leave an unowned comparison world after
  // the chat cascade. Reclaim any world this suite minted before the owner purge.
  const worlds = await db()
    .select({ id: simWorlds.id })
    .from(simWorlds)
    .where(eq(simWorlds.worldTypeId, COMPARISON_WORLD_TYPE_ID));
  for (const world of worlds) {
    const anchored = await db()
      .select({ id: characterChats.id })
      .from(characterChats)
      .innerJoin(simBranches, eq(characterChats.simBranchId, simBranches.id))
      .where(eq(simBranches.worldId, world.id));
    if (anchored.some((row) => row.id === ids.chat)) await db().delete(simWorlds).where(eq(simWorlds.id, world.id));
  }
  await purgeOwnerRows([ids.owner]);
});

describe.runIf(ready)("Engine Comparison session provisioning", () => {
  it("starts from a one-on-one legacy chat, mints a neutral mirror, and stops cleanly", async () => {
    const before = await expectJson<{ active: boolean; canStart: boolean; rows: number }>(
      await GET(req(ids.chat, "GET"), ctx(ids.chat)),
      200,
    );
    expect(before.active).toBe(false);
    expect(before.canStart).toBe(true);
    expect(before.rows).toBe(0);

    const started = await expectJson<{ active: boolean; canStart: boolean }>(
      await POST(req(ids.chat, "POST"), ctx(ids.chat)),
      200,
    );
    expect(started.active).toBe(true);
    expect(started.canStart).toBe(false);

    const authority = await readChatEngineAuthority(ids.chat);
    expect(authority?.authority).toBe("successor_shadow");
    expect(authority?.simBranchId).toBeTruthy();
    expect(authority?.simPlayerActorId).toBeTruthy();
    expect(authority?.simPrimaryActorId).toBeTruthy();
    const branchId = authority?.simBranchId ?? "";

    const [world] = await db()
      .select({ id: simWorlds.id, worldTypeId: simWorlds.worldTypeId, calendarStart: simWorlds.calendarStart })
      .from(simBranches)
      .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
      .where(eq(simBranches.id, branchId));
    expect(world?.worldTypeId).toBe(COMPARISON_WORLD_TYPE_ID);
    expect(world?.calendarStart).toEqual({ year: 2024, month: 6, day: 1 });

    const space = await readDurableSpaceBranch(branchId);
    expect(space.locations).toHaveLength(1);
    expect(space.zones).toHaveLength(2);
    expect(space.loci).toHaveLength(2);
    expect(space.loci.every((locus) => locus.kind === "at" && locus.zoneId === space.zones[0]?.id)).toBe(false);
    const playerLocus = space.loci.find((locus) => locus.actorId === authority?.simPlayerActorId);
    const primaryLocus = space.loci.find((locus) => locus.actorId === authority?.simPrimaryActorId);
    expect(playerLocus?.kind).toBe("at");
    expect(primaryLocus?.kind).toBe("at");
    if (playerLocus?.kind === "at" && primaryLocus?.kind === "at") expect(primaryLocus.zoneId).toBe(playerLocus.zoneId);

    const bodies = await readDurableBodies(branchId);
    expect(bodies.storySecond).toBe(8 * 60 * 60);
    expect(bodies.meters.filter((meter) => meter.actorId === authority?.simPrimaryActorId).length).toBeGreaterThan(0);

    const worldId = world?.id ?? "";
    const stopped = await expectJson<{ active: boolean; canStart: boolean }>(
      await DELETE(req(ids.chat, "DELETE"), ctx(ids.chat)),
      200,
    );
    expect(stopped.active).toBe(false);
    expect(stopped.canStart).toBe(true);
    const after = await readChatEngineAuthority(ids.chat);
    expect(after?.authority).toBe("legacy_chat");
    expect(after?.simBranchId).toBeNull();
    expect(await db().select().from(simWorlds).where(eq(simWorlds.id, worldId))).toHaveLength(0);
  });

  it("refuses group chats instead of collecting pair-only evidence", async () => {
    const status = await expectJson<{ active: boolean; canStart: boolean; reason: string | null }>(
      await GET(req(ids.groupChat, "GET"), ctx(ids.groupChat)),
      200,
    );
    expect(status.active).toBe(false);
    expect(status.canStart).toBe(false);
    expect(status.reason).toContain("one-on-one");
    expect((await POST(req(ids.groupChat, "POST"), ctx(ids.groupChat))).status).toBe(409);
  });
});
