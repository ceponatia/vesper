import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { storyThreadSchema, type SessionRuntime } from "@/contracts";
import { db, sessions, users, worlds } from "@/server/db";

// DELETE /api/sessions/:id/threads/:threadId suite (docs/story-threads.md
// §Manual close): the admin-gated route flips a thread to `resolved` in
// sessions.runtime. Handler invoked directly with mocked auth; self-skips when
// the database is unreachable.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Brian", role: "admin" as "admin" | "user" },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { DELETE as closeThreadRoute } from "./[id]/threads/[threadId]/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sessions limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[threads-route.int.test] skipping: database unreachable or unmigrated: ${reason}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
let ownerId = "";
let worldId = "";

function ctx<P>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}
async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
function close(sessionId: string, threadId: string): Promise<Response> {
  const req = new NextRequest(`http://test/api/sessions/${sessionId}/threads/${threadId}`, { method: "DELETE" });
  return closeThreadRoute(req, ctx({ id: sessionId, threadId }));
}

/** Insert a fresh session carrying two open threads; returns its id. */
async function freshSession(): Promise<string> {
  const runtime: Partial<SessionRuntime> = {
    storyThreads: [
      storyThreadSchema.parse({ id: "t1", title: "Investigating Thorne", status: "open" }),
      storyThreadSchema.parse({ id: "t2", title: "Maya's social life", status: "open", kind: "ongoing" }),
    ],
  };
  const [row] = await db()
    .insert(sessions)
    .values({ ownerId, worldId, title: "Threads route", runtime })
    .returning({ id: sessions.id });
  if (!row) throw new Error("session insert failed");
  return row.id;
}

async function threadStatuses(sessionId: string): Promise<Record<string, string>> {
  const [row] = await db().select({ runtime: sessions.runtime }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const threads = (row?.runtime as SessionRuntime).storyThreads;
  return Object.fromEntries(threads.map((t) => [t.id, t.status]));
}

beforeAll(async () => {
  if (!ready) return;
  const [user] = await db()
    .insert(users)
    .values({ email: `threads-route-int-${Date.now()}@test.local`, name: "Brian", role: "admin" })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert failed");
  ownerId = user.id;
  authState.user.id = ownerId;
  authState.user.role = "admin";

  const [world] = await db()
    .insert(worlds)
    .values({ ownerId, name: "Threads World", lore: { synopsis: "A town." } })
    .returning({ id: worlds.id });
  if (!world) throw new Error("world insert failed");
  worldId = world.id;
});

afterAll(async () => {
  if (ready && ownerId) {
    await db().delete(sessions).where(eq(sessions.ownerId, ownerId));
    await db().delete(worlds).where(eq(worlds.ownerId, ownerId));
    await db().delete(users).where(eq(users.id, ownerId));
  }
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
});

describe.skipIf(!ready)("DELETE thread route (admin manual close)", () => {
  it("resolves the named thread and leaves the others open", async () => {
    authState.user.role = "admin";
    const sessionId = await freshSession();

    const res = await close(sessionId, "t1");
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: "t1", status: "resolved" });
    expect(await threadStatuses(sessionId)).toEqual({ t1: "resolved", t2: "open" });
  });

  it("404s an unknown thread id and mutates nothing", async () => {
    authState.user.role = "admin";
    const sessionId = await freshSession();

    const res = await close(sessionId, "t_missing");
    expect(res.status).toBe(404);
    expect(await threadStatuses(sessionId)).toEqual({ t1: "open", t2: "open" });
  });

  it("403s a non-admin and leaves the thread open", async () => {
    const sessionId = await freshSession();
    authState.user.role = "user";

    const res = await close(sessionId, "t1");
    expect(res.status).toBe(403);
    expect((await json(res))["error"]).toMatchObject({ code: "forbidden" });
    expect(await threadStatuses(sessionId)).toEqual({ t1: "open", t2: "open" });

    authState.user.role = "admin";
  });
});
