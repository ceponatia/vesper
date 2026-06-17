import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterChatMessages, characters, db, users } from "@/server/db";

// Character-chat route integration suite (docs/developer-notes/character-chat.plan.md):
// the GET/POST/DELETE handlers invoked directly with mocked auth against
// DATABASE_URL. AI_FAKE forces demo mode, so the streamed reply is the
// deterministic placeholder — no provider key or network. Self-skips when the
// database is unreachable.

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Chat Int", role: "admin" as const },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { DELETE as chatDelete, GET as chatGet, POST as chatPost } from "./[id]/chat/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from character_chat_messages limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(`[chat.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function postReq(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/characters/${id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const getReq = () => new NextRequest("http://t/api/characters/x/chat");

const ids = { character: "", otherUser: "", otherCharacter: "" };

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db().insert(users).values({ email: `chat-int-${stamp}@test.local`, name: "Chat Int", role: "admin" }).returning();
  const [other] = await db().insert(users).values({ email: `chat-int-other-${stamp}@test.local`, name: "Other" }).returning();
  if (!user || !other) throw new Error("failed to create test users");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.otherUser = other.id;

  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Mara", profile: {} }).returning();
  const [otherCharacter] = await db().insert(characters).values({ ownerId: other.id, name: "NotYours", profile: {} }).returning();
  if (!character || !otherCharacter) throw new Error("failed to seed characters");
  ids.character = character.id;
  ids.otherCharacter = otherCharacter.id;
});

afterAll(async () => {
  if (!ready) return;
  await db().delete(characters).where(eq(characters.ownerId, authState.user.id));
  await db().delete(characters).where(eq(characters.ownerId, ids.otherUser));
  await db().delete(users).where(eq(users.id, authState.user.id));
  await db().delete(users).where(eq(users.id, ids.otherUser));
  await globalThis.__vesperPool?.end();
});

async function rows(characterId: string) {
  return db()
    .select({ role: characterChatMessages.role, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.ownerId, authState.user.id), eq(characterChatMessages.characterId, characterId)))
    .orderBy(characterChatMessages.createdAt);
}

describe("POST /api/characters/:id/chat", () => {
  it("streams a demo reply and persists both the user line and the reply", async (t) => {
    if (!ready) return t.skip();
    const res = await chatPost(postReq(ids.character, { content: "Hello there" }), ctx(ids.character));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const text = await res.text();
    expect(text).toContain("[Mara]");
    expect(text).toContain("Demo mode");

    // The stream settles only after the reply is persisted, so it's queryable now.
    const persisted = await rows(ids.character);
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(persisted[0]?.content).toBe("Hello there");
    expect(persisted[1]?.content).toContain("[Mara]");
  });

  it("404s for a character the user does not own", async (t) => {
    if (!ready) return t.skip();
    const res = await chatPost(postReq(ids.otherCharacter, { content: "hi" }), ctx(ids.otherCharacter));
    expect(res.status).toBe(404);
  });

  it("400s on an empty message", async (t) => {
    if (!ready) return t.skip();
    const res = await chatPost(postReq(ids.character, { content: "   " }), ctx(ids.character));
    expect(res.status).toBe(400);
  });
});

describe("GET + DELETE /api/characters/:id/chat", () => {
  it("returns the transcript oldest-first, then clears it", async (t) => {
    if (!ready) return t.skip();
    const got = (await (await chatGet(getReq(), ctx(ids.character))).json()) as { messages: { role: string; content: string }[] };
    expect(got.messages.length).toBeGreaterThanOrEqual(2);
    expect(got.messages[0]?.role).toBe("user");

    const del = await chatDelete(getReq(), ctx(ids.character));
    expect(del.status).toBe(200);
    expect(await rows(ids.character)).toEqual([]);
  });
});
