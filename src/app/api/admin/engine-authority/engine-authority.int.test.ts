import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterChats, characters, db, events, users } from "@/server/db";

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Authority Int", role: "admin" as "admin" | "user" },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { POST as chatsCreate } from "../../chats/route";
import { GET as authorityGet, PATCH as authorityPatch } from "./[chatId]/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from character_chats limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4_000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(
      `[engine-authority.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const collectionCtx = { params: Promise.resolve({}) };
const ctx = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
const authorityPath = (chatId: string) => `/api/admin/self/engine-authority/${chatId}`;
const getReq = (path: string) => new NextRequest(`http://t${path}`);
function patchReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://t${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ids = { chat: "", user: "" };

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `authority-int-${stamp}@test.local`, name: "Authority Int", role: "admin" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.user = user.id;
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Mara", profile: {} })
    .returning();
  if (!character) throw new Error("failed to seed character");
  const res = await chatsCreate(
    new NextRequest("http://t/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterIds: [character.id], memory: "fresh" }),
    }),
    collectionCtx,
  );
  if (res.status !== 201) throw new Error(`chat create failed: ${res.status}`);
  ids.chat = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  if (!ready || !ids.user) return;
  await db().delete(events).where(eq(events.type, "engine_authority_changed"));
  await db().delete(characterChats).where(eq(characterChats.ownerId, ids.user));
  await db().delete(characters).where(eq(characters.ownerId, ids.user));
  await db().delete(users).where(eq(users.id, ids.user));
});

describe.runIf(ready)("R1 engine-authority dial", () => {
  it("reads the legacy default, flips with an audit row, and skips audit on no-ops", async () => {
    const initial = await authorityGet(getReq(authorityPath(ids.chat)), ctx(ids.chat));
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      authority: "legacy_chat",
      ragEligibility: false,
      simBranchId: null,
      simPlayerActorId: null,
      simPrimaryActorId: null,
    });

    const flipped = await authorityPatch(
      patchReq(authorityPath(ids.chat), { authority: "successor_shadow" }),
      ctx(ids.chat),
    );
    expect(flipped.status).toBe(200);
    expect(await flipped.json()).toMatchObject({
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
      ctx(ids.chat),
    );
    expect(noop.status).toBe(200);
    const auditAfterNoop = await db()
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.type, "engine_authority_changed"));
    expect(
      auditAfterNoop.filter((row) => (row.payload as { chatId?: string }).chatId === ids.chat),
    ).toHaveLength(1);

    const empty = await authorityPatch(patchReq(authorityPath(ids.chat), {}), ctx(ids.chat));
    expect(empty.status).toBe(400);
  });

  it("hides itself from non-admins, the old namespace, and unknown chats", async () => {
    authState.user = { ...authState.user, role: "user" };
    const denied = await authorityGet(getReq(authorityPath(ids.chat)), ctx(ids.chat));
    expect(denied.status).toBe(404);
    authState.user = { ...authState.user, role: "admin" };

    const oldNamespace = await authorityGet(
      getReq(`/api/admin/engine-authority/${ids.chat}`),
      ctx(ids.chat),
    );
    expect(oldNamespace.status).toBe(404);

    const missing = await authorityGet(getReq(authorityPath("ghost")), ctx("ghost"));
    expect(missing.status).toBe(404);
  });
});
