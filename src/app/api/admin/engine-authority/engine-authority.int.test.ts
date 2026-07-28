import { and, desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterChats, characters, db, events } from "@/server/db";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Authority Int", role: "admin" as const },
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
import { POST as chatsCreate } from "../../chats/route";
import { GET as authorityGet, PATCH as authorityPatch } from "./[chatId]/route";

const ready = await probeIntegrationDb("engine-authority.int.test", "character_chats");

const authorityPath = (chatId: string) => `/api/admin/self/engine-authority/${chatId}`;
const getReq = (path: string): NextRequest => apiRequest(path);
const patchReq = (path: string, body: unknown): NextRequest => apiRequest(path, { method: "PATCH", body });

const ids = { chat: "", user: "" };

beforeAll(async () => {
  if (!ready) return;
  const user = await seedTestUser("authority-int", { name: "Authority Int", role: "admin" });
  bindAuthUser(authState, user);
  ids.user = user.id;
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Mara", profile: {} })
    .returning();
  if (!character) throw new Error("failed to seed character");
  const res = await chatsCreate(
    apiRequest("/api/chats", { body: { characterIds: [character.id], memory: "fresh" } }),
    routeCtx(),
  );
  ids.chat = (await expectJson<{ id: string }>(res, 201)).id;
});

afterAll(async () => {
  if (!ready || !ids.user) return;
  await db().delete(events).where(eq(events.type, "engine_authority_changed"));
  await purgeOwnerRows([ids.user]);
  await endTestPool();
});

describe.runIf(ready)("R1 engine-authority dial", () => {
  it("reads the legacy default, flips with an audit row, and skips audit on no-ops", async () => {
    const initial = await authorityGet(getReq(authorityPath(ids.chat)), routeCtx({ chatId: ids.chat }));
    expect(await expectJson(initial, 200)).toEqual({
      authority: "legacy_chat",
      ragEligibility: false,
      simBranchId: null,
      simPlayerActorId: null,
      simPrimaryActorId: null,
    });

    const flipped = await authorityPatch(
      patchReq(authorityPath(ids.chat), { authority: "successor_shadow" }),
      routeCtx({ chatId: ids.chat }),
    );
    expect(await expectJson(flipped, 200)).toMatchObject({
      before: { authority: "legacy_chat" },
      after: { authority: "successor_shadow", ragEligibility: false },
    });
    const [chatRow] = await db()
      .select({ engineAuthority: characterChats.engineAuthority })
      .from(characterChats)
      .where(eq(characterChats.id, ids.chat));
    expect(chatRow).toEqual({ engineAuthority: "successor_shadow" });

    const auditRows = await db()
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.type, "engine_authority_changed")))
      .orderBy(desc(events.createdAt));
    const mine = auditRows.filter((row) => (row.payload as { chatId?: string }).chatId === ids.chat);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.payload).toMatchObject({
      byUserId: ids.user,
      before: { authority: "legacy_chat" },
      after: { authority: "successor_shadow" },
    });

    const noop = await authorityPatch(
      patchReq(authorityPath(ids.chat), { authority: "successor_shadow" }),
      routeCtx({ chatId: ids.chat }),
    );
    expect(noop.status).toBe(200);
    const auditAfterNoop = await db()
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.type, "engine_authority_changed"));
    expect(
      auditAfterNoop.filter((row) => (row.payload as { chatId?: string }).chatId === ids.chat),
    ).toHaveLength(1);

    const empty = await authorityPatch(patchReq(authorityPath(ids.chat), {}), routeCtx({ chatId: ids.chat }));
    expect(empty.status).toBe(400);
  });

  it("hides itself from non-admins, the old namespace, and unknown chats", async () => {
    await withAuthUser(authState, { role: "user" }, async () => {
      const denied = await authorityGet(getReq(authorityPath(ids.chat)), routeCtx({ chatId: ids.chat }));
      expect(denied.status).toBe(404);
    });

    const oldNamespace = await authorityGet(
      getReq(`/api/admin/engine-authority/${ids.chat}`),
      routeCtx({ chatId: ids.chat }),
    );
    expect(oldNamespace.status).toBe(404);

    const missing = await authorityGet(getReq(authorityPath("ghost")), routeCtx({ chatId: "ghost" }));
    expect(missing.status).toBe(404);
  });
});
